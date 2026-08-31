import { createHash, randomUUID } from "node:crypto";
import { APIError, SpritesClient } from "@fly/sprites";
import { ComputerError } from "@frockbot/computer-core";

const DESKTOP_SERVICE = "frockbot-viewer-gateway";
/**
 * The durable-root sync's on-Sprite half (ADR 0013), declared as a service so
 * the Sprite runtime brings it back after a cold pause: "Only
 * Computer-provider-declared services may be reattached; other processes are
 * assumed dead after a cold pause." It holds no credential and makes no
 * network call — it watches the durable roots and bumps a change signal, and
 * the sync agent that reads object storage runs in the backend.
 */
export const WORKSPACE_SYNC_SERVICE = "frockbot-workspace-sync";
const HOME_ROOT = "/home/box";
const DATA_ROOT = `${HOME_ROOT}/agent-data`;
const RUNTIME_ROOT = `${HOME_ROOT}/.frockbot`;
const BOTS_ROOT = `${RUNTIME_ROOT}/bots`;
const WORKSPACES_ROOT = "/workspaces";
const CONTROL_SCRIPT = `${RUNTIME_ROOT}/control.sh`;
const ENSURE_AGENT_SCRIPT = `${RUNTIME_ROOT}/ensure-agent.sh`;
const MAX_OUTPUT = 30_000;
const MAX_STORAGE_OUTPUT = 500_000;
const EXEC_EXIT_MARKER = "__FROCKBOT_EXIT__";
const LEASE_MAX_AGE_SECONDS = 90;
/**
 * How long a tenant's slot is held after the provider last opened or ran
 * anything for it.
 *
 * A slot is a display number — an Xvfb, VNC, and CDP port triple — and there
 * are a hundred of them, so they are allocated on demand and reclaimed rather
 * than owned for ever. What makes a tenant live is this provider having opened
 * or executed for it recently, or a human holding its takeover lease; nothing
 * on the Computer is evidence, because the desktop script deletes its own X
 * lock when it restarts and an exec-only tenant never holds one at all. The
 * threshold is declared here so a reclaim is a stated policy rather than a
 * guess about who is still using a screen.
 */
export const SLOT_IDLE_SECONDS = 900;
/** Exit code the ensure script uses when every slot belongs to a live tenant. */
const NO_SLOTS_EXIT = 75;
/** The same refusal, on stdout, for a transport that swallows the exit code. */
const NO_SLOTS_MARKER = "__FROCKBOT_NO_SLOTS__";

export interface ComputerBotIdentity {
  id: string;
  name?: string;
  description?: string;
}

interface AgentLayout {
  identity: ComputerBotIdentity;
  key: string;
  runtimeDir: string;
  workspaceDir: string;
  profileJson: string;
}

const startDesktopScript = `#!/usr/bin/env bash
set -eu
KEY="$1"
ROOT=${RUNTIME_ROOT}
BOT="$ROOT/bots/$KEY"
SLOT=$(cat "$BOT/slot")
DISPLAY_NUMBER=$((100 + SLOT))
VNC_PORT=$((5900 + SLOT))
CDP_PORT=$((9222 + SLOT))
export DISPLAY=:$DISPLAY_NUMBER
cleanup() {
  jobs -pr | xargs -r kill >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
rm -f "/tmp/.X$DISPLAY_NUMBER-lock" "/tmp/.X11-unix/X$DISPLAY_NUMBER"
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp &
for _ in $(seq 1 100); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done
fluxbox >"$BOT/fluxbox.log" 2>&1 &
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --user-data-dir="${HOME_ROOT}/chrome-profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" --start-maximized about:blank >"$BOT/chromium.log" 2>&1 &
x11vnc -display "$DISPLAY" -forever -shared -rfbport "$VNC_PORT" -passwd "$(cat "$BOT/vnc-password")" >"$BOT/x11vnc.log" 2>&1 &
VNC_PID=$!
wait "$VNC_PID"
`;

const ensureAgentScript = `#!/usr/bin/env bash
set -eu
KEY="$1"
PROFILE_BASE64="$2"
ROOT=${RUNTIME_ROOT}
BOT="$ROOT/bots/$KEY"
DATA=${DATA_ROOT}
AGENT_DATA="$DATA/agents/$KEY"
WORKSPACE=${WORKSPACES_ROOT}/$KEY
case "$KEY" in (*[!a-z0-9-]*|'') echo "invalid agent key" >&2; exit 64;; esac
mkdir -p "$BOT" "$AGENT_DATA" "$AGENT_DATA/memory" "$AGENT_DATA/skills" "$DATA/user-memory" "$DATA/user-packages" "$WORKSPACE" "${HOME_ROOT}/bin" "${HOME_ROOT}/reference" "${HOME_ROOT}/chrome-profile"
PROFILE_TMP=$(mktemp "$AGENT_DATA/profile.json.XXXXXX")
printf '%s' "$PROFILE_BASE64" | base64 -d > "$PROFILE_TMP"
chmod 600 "$PROFILE_TMP"
mv "$PROFILE_TMP" "$AGENT_DATA/profile.json"
exec 9>"$ROOT/registry.lock"
flock -x 9
if [ ! -s "$BOT/slot" ]; then
  # Every slot in use, read once. The registry lock is held, so the answer
  # cannot change under this scan, and one read beats one per slot per tenant
  # when a Computer is close to full.
  USED=" $(cat "$ROOT"/bots/*/slot 2>/dev/null | tr '\n' ' ') "
  SLOT=0
  while [ "$SLOT" -lt 100 ]; do
    case "$USED" in (*" $SLOT "*) ;; (*) break ;; esac
    SLOT=$((SLOT + 1))
  done
  if [ "$SLOT" -ge 100 ]; then
    # A slot is a display number, not durable state: it is the Xvfb, VNC, and
    # CDP port triple a tenant's desktop uses while it has one. A tenant that
    # never comes back would otherwise hold one for ever, and the hundred and
    # first Bot of a User could never open a desktop, so the allocation is
    # bounded rather than permanent.
    #
    # Liveness is decided by the provider's own registry, never by the
    # Computer's state: "last-seen" is written by the backend every time it
    # opens or runs anything for a tenant, and "human-control" is the takeover
    # lease. An X lock proves nothing — the desktop script deletes its own on
    # restart, and a tenant that only ever execs never holds one — so a slot is
    # reclaimed only when its tenant has been idle past the declared threshold
    # AND no viewer lease is fresh. Its viewer token goes with the slot, or
    # that token would address another Bot's screen. When every slot belongs to
    # a live tenant the new tenant is refused: sharing a display would put two
    # Bots on one screen, which is worse than an unavailable desktop.
    NOW=$(date +%s)
    VICTIM=""
    for FILE in $(ls -1tr "$ROOT"/bots/*/slot 2>/dev/null); do
      CANDIDATE_BOT=$(dirname "$FILE")
      SEEN=0
      if [ -f "$CANDIDATE_BOT/last-seen" ]; then SEEN=$(stat -c %Y "$CANDIDATE_BOT/last-seen"); fi
      if [ $((NOW - SEEN)) -le ${SLOT_IDLE_SECONDS} ]; then continue; fi
      if [ -f "$CANDIDATE_BOT/human-control" ]; then
        LEASED=$(stat -c %Y "$CANDIDATE_BOT/human-control")
        if [ $((NOW - LEASED)) -le ${LEASE_MAX_AGE_SECONDS} ]; then continue; fi
      fi
      VICTIM="$FILE"
      SLOT=$(cat "$FILE")
      break
    done
    if [ -z "$VICTIM" ]; then
      # Said on both channels: the exit code is for a caller that gets one, and
      # the marker is for a transport that hands back output instead.
      echo ${NO_SLOTS_MARKER}
      echo "no desktop slots available" >&2
      exit ${NO_SLOTS_EXIT}
    fi
    VICTIM_BOT=$(dirname "$VICTIM")
    if [ -s "$VICTIM_BOT/viewer-token" ]; then
      VICTIM_TOKEN=$(cat "$VICTIM_BOT/viewer-token")
      VTMP=$(mktemp "$ROOT/tokens.XXXXXX")
      grep -v "^$VICTIM_TOKEN:" "$ROOT/tokens" > "$VTMP" || true
      chmod 600 "$VTMP"
      mv "$VTMP" "$ROOT/tokens"
    fi
    rm -f "$VICTIM" "$VICTIM_BOT/cdp-port"
  fi
  printf '%s\n' "$SLOT" > "$BOT/slot"
fi
# Marks this tenant as the most recent holder of its slot, which is the order
# the reclaim above walks, and records that the provider has just opened it —
# the registry entry the reclaim reads to decide whether a tenant is live.
touch "$BOT/slot" "$BOT/last-seen"
SLOT=$(cat "$BOT/slot")
printf '%s\n' "$((9222 + SLOT))" > "$BOT/cdp-port"
if [ ! -s "$BOT/vnc-password" ]; then
  umask 077
  head -c 32 /dev/urandom | base64 | tr -d '\n=+/' > "$BOT/vnc-password"
fi
if [ ! -s "$BOT/viewer-token" ]; then
  umask 077
  head -c 36 /dev/urandom | base64 | tr -d '\n=+/' > "$BOT/viewer-token"
fi
TOKEN=$(cat "$BOT/viewer-token")
TMP=$(mktemp "$ROOT/tokens.XXXXXX")
grep -v "^$TOKEN:" "$ROOT/tokens" > "$TMP" || true
printf '%s: 127.0.0.1:%s\n' "$TOKEN" "$((5900 + SLOT))" >> "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$ROOT/tokens"
`;

const controlScript = `#!/usr/bin/env bash
set -eu
if [ "$1" != "--locked" ]; then
  KEY="$2"
  BOT=${BOTS_ROOT}/$KEY
  mkdir -p "$BOT"
  exec flock -x "$BOT/control.lock" "$0" --locked "$@"
fi
shift
ACTION="$1"
KEY="$2"
OWNER="$3"
MAX_AGE="$4"
BOT=${BOTS_ROOT}/$KEY
LEASE="$BOT/human-control"
current_owner() { sed -n '1p' "$LEASE" 2>/dev/null || true; }
is_fresh() {
  [ -e "$LEASE" ] || return 1
  NOW=$(date +%s)
  CHANGED=$(stat -c %Y "$LEASE")
  [ $((NOW - CHANGED)) -le "$MAX_AGE" ]
}
case "$ACTION" in
  assert-agent)
    EXISTING=$(current_owner)
    if [ -n "$EXISTING" ] && [ "$EXISTING" != "$OWNER" ]; then
      if is_fresh; then echo "The user is controlling this agent's computer" >&2; exit 73; fi
      rm -f "$LEASE"
    fi
    ;;
  acquire)
    EXISTING=$(current_owner)
    if [ "$EXISTING" = "$OWNER" ]; then touch "$LEASE"; exit 0; fi
    if [ -n "$EXISTING" ] && is_fresh; then echo "This agent's computer is already under human control" >&2; exit 73; fi
    TMP=$(mktemp "$BOT/human-control.XXXXXX")
    printf '%s\n' "$OWNER" > "$TMP"
    chmod 600 "$TMP"
    mv "$TMP" "$LEASE"
    ;;
  renew)
    [ "$(current_owner)" = "$OWNER" ] || { echo "Human control lease owner changed" >&2; exit 73; }
    touch "$LEASE"
    ;;
  release)
    if [ "$(current_owner)" = "$OWNER" ]; then rm -f "$LEASE"; fi
    ;;
  *) echo "unknown control action" >&2; exit 64;;
esac
`;

const browserHelper = `import { chromium } from "playwright-core";
const port = Number(process.argv[2]);
const action = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
const browser = await chromium.connectOverCDP(\`http://127.0.0.1:\${port}\`);
const context = browser.contexts()[0];
const pages = context.pages();
const page = pages.at(-1) ?? await context.newPage();
if (action.action === "navigate") await page.goto(action.url, { waitUntil: "domcontentloaded" });
if (action.action === "click") await page.getByRole(action.role, { name: action.name, exact: action.exact ?? false }).click();
if (action.action === "fill") await page.getByLabel(action.label, { exact: action.exact ?? false }).fill(action.text);
if (action.action === "press") await page.keyboard.press(action.key);
if (action.action === "wait") await page.waitForTimeout(action.milliseconds ?? 1000);
const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10000 });
console.log(JSON.stringify({ url: page.url(), title: await page.title(), snapshot }));
await browser.close();
`;

const syncWatchScript = `#!/usr/bin/env bash
set -eu
DATA=${DATA_ROOT}
STATE=${RUNTIME_ROOT}/sync
mkdir -p "$STATE"
SIGNAL="$STATE/signal"
STAMP="$STATE/.stamp"
[ -f "$SIGNAL" ] || printf '0\n' > "$SIGNAL"
[ -f "$STAMP" ] || touch "$STAMP"
while true; do
  CHANGED=$(find "$DATA" -type f -newer "$STAMP" ! -path "*/.frockbot-sync/*" ! -path "*/.frockbot-locks/*" -print -quit 2>/dev/null || true)
  if [ -n "$CHANGED" ]; then
    touch "$STAMP"
    printf '%s\n' "$(( $(cat "$SIGNAL" 2>/dev/null || echo 0) + 1 ))" > "$SIGNAL"
  fi
  sleep 5
done
`;

const gatewayScript = `#!/usr/bin/env bash
set -eu
exec websockify --web=/usr/share/novnc --token-plugin TokenFile --token-source=${RUNTIME_ROOT}/tokens 6080
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function base64(value: string): string {
  return Buffer.from(value).toString("base64");
}

function installFile(path: string, content: string): string {
  return `printf %s ${shellQuote(base64(content))} | base64 -d > ${path}`;
}

const provisionScript = `set -eu
mkdir -p ${RUNTIME_ROOT} ${RUNTIME_ROOT}/sync ${BOTS_ROOT} ${DATA_ROOT}/agents ${DATA_ROOT}/user-memory ${DATA_ROOT}/user-packages ${HOME_ROOT}/bin ${HOME_ROOT}/reference ${HOME_ROOT}/chrome-profile ${WORKSPACES_ROOT}
if ! command -v Xvfb >/dev/null || ! command -v chromium >/dev/null || ! command -v websockify >/dev/null; then
  if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo"; fi
  $SUDO apt-get update >/tmp/frockbot-provision.log 2>&1
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y chromium xvfb fluxbox x11vnc novnc websockify x11-utils ca-certificates util-linux >>/tmp/frockbot-provision.log 2>&1
fi
touch ${RUNTIME_ROOT}/tokens
chmod 700 ${RUNTIME_ROOT}
chmod 600 ${RUNTIME_ROOT}/tokens
${installFile(`${RUNTIME_ROOT}/start-desktop.sh`, startDesktopScript)}
${installFile(ENSURE_AGENT_SCRIPT, ensureAgentScript)}
${installFile(CONTROL_SCRIPT, controlScript)}
${installFile(`${RUNTIME_ROOT}/browser.mjs`, browserHelper)}
${installFile(`${RUNTIME_ROOT}/start-gateway.sh`, gatewayScript)}
${installFile(`${RUNTIME_ROOT}/watch-workspace.sh`, syncWatchScript)}
chmod 700 ${RUNTIME_ROOT}/start-desktop.sh ${ENSURE_AGENT_SCRIPT} ${CONTROL_SCRIPT} ${RUNTIME_ROOT}/browser.mjs ${RUNTIME_ROOT}/start-gateway.sh ${RUNTIME_ROOT}/watch-workspace.sh
if [ ! -d ${RUNTIME_ROOT}/node_modules/playwright-core ]; then
  npm install --prefix ${RUNTIME_ROOT} --no-audit --no-fund playwright-core@1.55.0 >>/tmp/frockbot-provision.log 2>&1
fi
cat > ${HOME_ROOT}/reference/README.md <<'EOF'
# FrockBot computer

/home/box/agent-data is durable application data. /workspaces contains Bot-private workspaces.
One Computer serves all of a User's Bots. Each Bot has its own directories
and desktop; the browser profile at /home/box/chrome-profile is shared by all of them.
Automations are stored but are not executed unless an automation runtime is installed.
EOF
`;

export interface SpriteExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

export interface SpriteAgentExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface SpriteServiceStream extends AsyncIterable<unknown> {}

export interface SpriteHandle {
  name: string;
  url?: string;
  execFileHTTP(
    file: string,
    args?: string[],
    options?: { signal?: AbortSignal; timeout?: number; maxBuffer?: number },
  ): Promise<SpriteExecResult>;
  createService(
    name: string,
    config: {
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
      dir?: string;
      httpPort?: number;
    },
    duration?: string,
  ): Promise<SpriteServiceStream>;
  updateURLSettings(settings: { auth: string }): Promise<void>;
}

export interface SpritesClientHandle {
  listAllSprites(prefix?: string): Promise<SpriteHandle[]>;
  createSprite(name: string): Promise<SpriteHandle>;
  getSprite(name: string): Promise<SpriteHandle>;
}

export interface FlySpriteComputerOptions {
  token?: string;
  spriteName?: string;
  client?: SpritesClientHandle;
  respectHumanControl?: boolean;
}

export interface BrowserAction {
  action: "snapshot" | "navigate" | "click" | "fill" | "press" | "wait";
  url?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  key?: string;
  exact?: boolean;
  milliseconds?: number;
}

export interface ComputerConnection {
  botId: string;
  botKey: string;
  spriteName: string;
  viewerUrl: string;
  /** The tenant's X display on the shared Computer, e.g. `:100`. */
  display: string;
  /** The tenant's durable directory, relative to the Workspace home. */
  directory: string;
}

function configuredToken(): string | undefined {
  return process.env.SPRITES_TOKEN?.trim() || process.env.SPRITE_TOKEN?.trim();
}

function configuredName(): string {
  const name = process.env.FROCKBOT_SPRITE_NAME?.trim() || "frockbot-barebones";
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(name)) {
    throw new Error(
      "FROCKBOT_SPRITE_NAME must be 3-63 lowercase letters, numbers, or hyphens",
    );
  }
  return name;
}

export function flySpriteNameForBot(
  botId: string,
  baseName = configuredName(),
): string {
  const normalizedBase = baseName.trim();
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(normalizedBase)) {
    throw new Error(
      "Fly Sprite base name must be 3-63 lowercase letters, numbers, or hyphens",
    );
  }
  const suffix = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  const prefix = normalizedBase.slice(0, 49).replace(/-+$/g, "");
  return `${prefix}-${suffix}`;
}

function normalizedIdentity(
  input: string | ComputerBotIdentity,
): ComputerBotIdentity {
  const identity = typeof input === "string" ? { id: input } : input;
  const id = identity.id.trim();
  if (!id || id.length > 200) {
    throw new Error("Computer Bot id must contain 1-200 characters");
  }
  return {
    id,
    name: identity.name?.trim() || undefined,
    description: identity.description?.trim() || undefined,
  };
}

export function computerBotKey(botId: string): string {
  const id = normalizedIdentity(botId).id;
  const slug = id
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
  return `${slug || "bot"}-${digest}`;
}

function layoutFor(input: string | ComputerBotIdentity): AgentLayout {
  const identity = normalizedIdentity(input);
  const key = computerBotKey(identity.id);
  const name = identity.name ?? identity.id;
  const profileJson = JSON.stringify(
    {
      id: identity.id,
      name,
      description: identity.description ?? "FrockBot Bot",
      computer: { botKey: key, sharedHome: HOME_ROOT },
    },
    null,
    2,
  );
  return {
    identity,
    key,
    runtimeDir: `${BOTS_ROOT}/${key}`,
    workspaceDir: `${WORKSPACES_ROOT}/${key}`,
    profileJson,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputText(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString();
}

function clipped(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… output truncated`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === 404;
}

async function settleService(
  stream: SpriteServiceStream,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  for await (const event of stream) {
    signal?.throwIfAborted();
    if (typeof event !== "object" || event === null) continue;
    const serviceEvent = event as {
      type?: unknown;
      data?: unknown;
      exitCode?: unknown;
    };
    if (serviceEvent.type === "error") {
      throw new Error(
        `${label} failed: ${String(serviceEvent.data ?? "unknown error")}`,
      );
    }
    if (
      serviceEvent.type === "exit" &&
      typeof serviceEvent.exitCode === "number" &&
      serviceEvent.exitCode !== 0
    ) {
      throw new Error(`${label} exited with code ${serviceEvent.exitCode}`);
    }
  }
}

export class FlySpriteAgentComputer {
  readonly botId: string;
  readonly botKey: string;
  private readonly computer: FlySpriteComputer;
  private readonly layout: AgentLayout;

  constructor(computer: FlySpriteComputer, layout: AgentLayout) {
    this.computer = computer;
    this.layout = layout;
    this.botId = layout.identity.id;
    this.botKey = layout.key;
  }

  /** The tenant's allocated X display, once its desktop has been ensured. */
  get display(): string | undefined {
    return this.computer.displayForTenant(this.layout.key);
  }

  /** The tenant's durable directory, relative to the Workspace home. */
  get directory(): string {
    return `agent-data/agents/${this.layout.key}`;
  }

  ensure(signal?: AbortSignal): Promise<ComputerConnection> {
    return this.computer.ensureAgent(this.layout, signal);
  }

  run(command: string, signal: AbortSignal): Promise<string> {
    return this.computer.runForAgent(this.layout, command, signal);
  }

  exec(
    command: string,
    signal: AbortSignal,
    limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<SpriteAgentExecResult> {
    return this.computer.execForAgent(this.layout, command, signal, limits);
  }

  runStorage(command: string, signal: AbortSignal): Promise<string> {
    return this.computer.runStorageForAgent(this.layout, command, signal);
  }

  browser(action: BrowserAction, signal: AbortSignal): Promise<string> {
    return this.computer.browserForAgent(this.layout, action, signal);
  }

  takeControl(signal?: AbortSignal): Promise<void> {
    return this.computer.control(this.layout, "acquire", signal);
  }

  refreshControl(signal?: AbortSignal): Promise<void> {
    return this.computer.control(this.layout, "renew", signal);
  }

  releaseControl(signal?: AbortSignal): Promise<void> {
    return this.computer.releaseForAgent(this.layout, signal);
  }
}

export class FlySpriteComputer {
  readonly spriteName: string;
  readonly configured: boolean;
  private readonly client?: SpritesClientHandle;
  private readonly ownerId = randomUUID();
  private readonly respectHumanControl: boolean;
  private runtimePromise?: Promise<SpriteHandle>;
  private readonly agentPromises = new Map<
    string,
    Promise<ComputerConnection>
  >();
  private readonly storagePromises = new Map<string, Promise<SpriteHandle>>();
  private readonly displays = new Map<string, string>();

  constructor(options: FlySpriteComputerOptions = {}) {
    const token = options.token?.trim() || configuredToken();
    this.spriteName = options.spriteName ?? configuredName();
    this.client =
      options.client ?? (token ? new SpritesClient(token) : undefined);
    this.configured = Boolean(this.client);
    this.respectHumanControl = options.respectHumanControl ?? true;
  }

  bot(identity: string | ComputerBotIdentity): FlySpriteAgentComputer {
    return new FlySpriteAgentComputer(this, layoutFor(identity));
  }

  /**
   * The X display this Computer allocated to one tenant, once its desktop has
   * been ensured. Slots are allocated on demand, exactly as GrokBot allocates
   * displays on demand rather than one per agent, so this is `undefined` until
   * the tenant's desktop has started.
   */
  displayForTenant(botKey: string): string | undefined {
    return this.displays.get(botKey);
  }

  async ensureAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<ComputerConnection> {
    if (!this.client) {
      throw new Error("Set SPRITES_TOKEN to attach a Fly Sprite computer");
    }
    let promise = this.agentPromises.get(layout.key);
    if (!promise) {
      promise = this.provisionAgent(layout, signal).catch((error) => {
        this.agentPromises.delete(layout.key);
        throw error;
      });
      this.agentPromises.set(layout.key, promise);
    }
    return promise;
  }

  async runForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
  ): Promise<string> {
    const sprite = await this.readySprite(layout, signal);
    const guarded = [
      this.agentControlGuard(layout),
      `export HOME=${HOME_ROOT}`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
      `cd ${shellQuote(layout.workspaceDir)}`,
      command,
    ].join("\n");
    try {
      const result = await sprite.execFileHTTP("bash", ["-c", guarded], {
        signal,
        timeout: 120_000,
        maxBuffer: MAX_OUTPUT * 2,
      });
      return clipped(
        [outputText(result.stdout), outputText(result.stderr)]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (error) {
      throw new Error(`Sprite command failed: ${errorText(error)}`);
    }
  }

  async execForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
    limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<SpriteAgentExecResult> {
    const sprite = await this.readySprite(layout, signal);
    const guarded = [
      this.agentControlGuard(layout),
      `export HOME=${HOME_ROOT}`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
      `cd ${shellQuote(layout.workspaceDir)}`,
      `bash -c ${shellQuote(command)}`,
      `printf '\\n%s%s\\n' ${shellQuote(EXEC_EXIT_MARKER)} "$?"`,
    ].join("\n");
    const maxOutput = Math.max(
      1,
      Math.min(limits.maxOutputBytes ?? MAX_OUTPUT, MAX_OUTPUT),
    );
    let result: SpriteExecResult;
    try {
      result = await sprite.execFileHTTP("bash", ["-c", guarded], {
        signal,
        timeout: Math.max(1, Math.min(limits.timeoutMs ?? 120_000, 120_000)),
        maxBuffer: MAX_OUTPUT * 2,
      });
    } catch (error) {
      throw new Error(`Sprite command failed: ${errorText(error)}`);
    }
    const raw = outputText(result.stdout);
    const match = new RegExp(`\\n?${EXEC_EXIT_MARKER}(\\d+)\\n?$`).exec(raw);
    const stdout = match ? raw.slice(0, match.index) : raw;
    const stderr = outputText(result.stderr);
    return {
      exitCode: match ? Number(match[1]) : null,
      stdout: stdout.slice(0, maxOutput),
      stderr: stderr.slice(0, maxOutput),
      outputTruncated:
        !match || stdout.length > maxOutput || stderr.length > maxOutput,
    };
  }

  async runStorageForAgent(
    layout: AgentLayout,
    command: string,
    signal: AbortSignal,
  ): Promise<string> {
    const sprite = await this.readyStorageSprite(layout, signal);
    const storageCommand = [
      `export HOME=${HOME_ROOT}`,
      `export FROCKBOT_BOT_ID=${shellQuote(layout.identity.id)}`,
      `export FROCKBOT_BOT_KEY=${shellQuote(layout.key)}`,
      `cd ${shellQuote(layout.workspaceDir)}`,
      command,
    ].join("\n");
    let result: SpriteExecResult;
    try {
      result = await sprite.execFileHTTP("bash", ["-c", storageCommand], {
        signal,
        timeout: 120_000,
        maxBuffer: MAX_STORAGE_OUTPUT * 2,
      });
    } catch (error) {
      throw new Error(`Sprite storage operation failed: ${errorText(error)}`);
    }
    const stdout = outputText(result.stdout);
    if (stdout.length > MAX_STORAGE_OUTPUT) {
      throw new ComputerError(
        "limit-exceeded",
        "Sprite storage output exceeded the maximum size",
      );
    }
    return stdout;
  }

  async browserForAgent(
    layout: AgentLayout,
    action: BrowserAction,
    signal: AbortSignal,
  ): Promise<string> {
    const sprite = await this.readySprite(layout, signal);
    const encoded = Buffer.from(JSON.stringify(action)).toString("base64url");
    const command = [
      this.agentControlGuard(layout),
      `PORT=$(cat ${layout.runtimeDir}/cdp-port)`,
      `node ${RUNTIME_ROOT}/browser.mjs "$PORT" ${shellQuote(encoded)}`,
    ].join("\n");
    try {
      const result = await sprite.execFileHTTP("bash", ["-c", command], {
        signal,
        timeout: 45_000,
        maxBuffer: MAX_OUTPUT * 2,
      });
      return clipped(
        outputText(result.stdout).trim() || outputText(result.stderr).trim(),
      );
    } catch (error) {
      throw new Error(`Sprite browser action failed: ${errorText(error)}`);
    }
  }

  async control(
    layout: AgentLayout,
    action: "acquire" | "renew",
    signal?: AbortSignal,
  ): Promise<void> {
    const sprite = await this.readySprite(layout, signal);
    await sprite.execFileHTTP(
      CONTROL_SCRIPT,
      [action, layout.key, this.ownerId, String(LEASE_MAX_AGE_SECONDS)],
      { signal, timeout: 15_000 },
    );
  }

  async releaseForAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.client) return;
    let sprite: SpriteHandle;
    try {
      sprite = await this.client.getSprite(this.spriteName);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    await sprite.execFileHTTP(
      CONTROL_SCRIPT,
      ["release", layout.key, this.ownerId, String(LEASE_MAX_AGE_SECONDS)],
      { signal, timeout: 15_000 },
    );
  }

  private async provisionRuntime(signal?: AbortSignal): Promise<SpriteHandle> {
    signal?.throwIfAborted();
    const sprite = await this.findOrCreate();
    await sprite.execFileHTTP("bash", ["-lc", provisionScript], {
      signal,
      timeout: 10 * 60_000,
      maxBuffer: MAX_OUTPUT * 2,
    });
    const stream = await sprite.createService(
      DESKTOP_SERVICE,
      { cmd: `${RUNTIME_ROOT}/start-gateway.sh`, httpPort: 6080 },
      "30s",
    );
    await settleService(stream, "Desktop gateway", signal);
    // The durable-root sync's watcher is a declared service, so a cold pause
    // ends with it running again rather than with a silently stopped process.
    const sync = await sprite.createService(WORKSPACE_SYNC_SERVICE, {
      cmd: `${RUNTIME_ROOT}/watch-workspace.sh`,
    });
    await settleService(sync, "Workspace sync watcher", signal);
    await sprite.updateURLSettings({ auth: "public" });
    return sprite;
  }

  private async provisionAgent(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<ComputerConnection> {
    const sprite = await this.runtime(signal);
    if (this.respectHumanControl)
      await this.assertAgentControl(sprite, layout, signal);
    // Every display belonging to a tenant this provider still has open is a
    // declared outcome, not a crash: the alternative would be two Bots sharing
    // one screen, and Bots are separated on a Computer exactly so that does
    // not happen silently.
    const refused = (cause: unknown) =>
      new ComputerError(
        "capability-unavailable",
        `Every desktop on this Computer is in use; Bot "${layout.identity.id}" has no display until one is idle`,
        true,
        { cause },
      );
    let ensured: SpriteExecResult;
    try {
      ensured = await sprite.execFileHTTP(
        ENSURE_AGENT_SCRIPT,
        [layout.key, base64(layout.profileJson)],
        { signal, timeout: 60_000, maxBuffer: MAX_OUTPUT * 2 },
      );
    } catch (error) {
      if (
        errorText(error).includes(NO_SLOTS_MARKER) ||
        errorText(error).includes("no desktop slots available")
      ) {
        throw refused(error);
      }
      throw error;
    }
    if (outputText(ensured.stdout).includes(NO_SLOTS_MARKER)) {
      throw refused(undefined);
    }
    if (this.respectHumanControl) {
      await this.assertAgentControl(sprite, layout, signal);
    }
    const desktop = await sprite.createService(
      `frockbot-desktop-${layout.key}`,
      { cmd: `${RUNTIME_ROOT}/start-desktop.sh`, args: [layout.key] },
      "30s",
    );
    await settleService(desktop, `Desktop for ${layout.identity.id}`, signal);
    const current = await this.client?.getSprite(this.spriteName);
    const url = current?.url ?? sprite.url;
    if (!url) throw new Error("Sprites API did not return a computer URL");
    const [password, token, slot] = await Promise.all([
      sprite.execFileHTTP("cat", [`${layout.runtimeDir}/vnc-password`], {
        signal,
        timeout: 15_000,
      }),
      sprite.execFileHTTP("cat", [`${layout.runtimeDir}/viewer-token`], {
        signal,
        timeout: 15_000,
      }),
      sprite.execFileHTTP("cat", [`${layout.runtimeDir}/slot`], {
        signal,
        timeout: 15_000,
      }),
    ]);
    const display = `:${100 + Number(outputText(slot.stdout).trim() || 0)}`;
    this.displays.set(layout.key, display);
    const viewer = new URL("vnc.html", url.endsWith("/") ? url : `${url}/`);
    viewer.hash = new URLSearchParams({
      autoconnect: "1",
      reconnect: "1",
      resize: "scale",
      path: `websockify?token=${outputText(token.stdout).trim()}`,
      password: outputText(password.stdout).trim(),
    }).toString();
    return {
      botId: layout.identity.id,
      botKey: layout.key,
      spriteName: this.spriteName,
      viewerUrl: viewer.toString(),
      display,
      directory: `agent-data/agents/${layout.key}`,
    };
  }

  private runtime(signal?: AbortSignal): Promise<SpriteHandle> {
    if (!this.client) {
      return Promise.reject(
        new Error("Set SPRITES_TOKEN to attach a Fly Sprite computer"),
      );
    }
    if (!this.runtimePromise) {
      this.runtimePromise = this.provisionRuntime(signal).catch((error) => {
        this.runtimePromise = undefined;
        throw error;
      });
    }
    return this.runtimePromise;
  }

  private async readySprite(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteHandle> {
    await this.ensureAgent(layout, signal);
    if (!this.client) throw new Error("Sprites client is unavailable");
    return this.client.getSprite(this.spriteName);
  }

  private readyStorageSprite(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteHandle> {
    signal?.throwIfAborted();
    let promise = this.storagePromises.get(layout.key);
    if (!promise) {
      promise = this.provisionStorage(layout, signal).catch((error) => {
        this.storagePromises.delete(layout.key);
        throw error;
      });
      this.storagePromises.set(layout.key, promise);
    }
    return promise;
  }

  private async provisionStorage(
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteHandle> {
    const sprite = await this.findOrCreate();
    await sprite.execFileHTTP(
      "mkdir",
      [
        "-p",
        layout.workspaceDir,
        `${DATA_ROOT}/agents/${layout.key}/memory`,
        `${DATA_ROOT}/agents/${layout.key}/skills`,
        `${DATA_ROOT}/user-memory`,
        `${DATA_ROOT}/user-packages`,
        `${RUNTIME_ROOT}/sync`,
      ],
      { signal, timeout: 15_000, maxBuffer: MAX_OUTPUT },
    );
    return sprite;
  }

  private assertAgentControl(
    sprite: SpriteHandle,
    layout: AgentLayout,
    signal?: AbortSignal,
  ): Promise<SpriteExecResult> {
    return sprite.execFileHTTP(
      CONTROL_SCRIPT,
      ["assert-agent", layout.key, this.ownerId, String(LEASE_MAX_AGE_SECONDS)],
      { signal, timeout: 15_000 },
    );
  }

  /**
   * Prefixes every command this provider runs for a tenant: the human-control
   * assertion, and the registry's `last-seen` stamp.
   *
   * The stamp is what keeps an exec-only tenant's desktop slot: it never opens
   * a viewer and never holds an X lock, so without it the slot reclaim would
   * be free to hand its display to another Bot mid-run.
   */
  private agentControlGuard(layout: AgentLayout): string {
    const bot = shellQuote(`${BOTS_ROOT}/${layout.key}`);
    return [
      `${CONTROL_SCRIPT} assert-agent ${shellQuote(layout.key)} ${shellQuote(this.ownerId)} ${LEASE_MAX_AGE_SECONDS} || exit $?`,
      `mkdir -p ${bot} && touch ${bot}/last-seen`,
    ].join("\n");
  }

  private async findOrCreate(): Promise<SpriteHandle> {
    if (!this.client) throw new Error("Sprites client is unavailable");
    const existing = (await this.client.listAllSprites(this.spriteName)).find(
      (sprite) => sprite.name === this.spriteName,
    );
    if (existing) return existing;
    try {
      return await this.client.createSprite(this.spriteName);
    } catch (error) {
      try {
        return await this.client.getSprite(this.spriteName);
      } catch {
        throw error;
      }
    }
  }
}

import { createHash, randomUUID } from "node:crypto";
import { APIError, SpritesClient } from "@fly/sprites";
import { ComputerError } from "@frockbot/computer-core";

const DESKTOP_SERVICE = "frockbot-viewer-gateway";
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
  SLOT=0
  while [ "$SLOT" -lt 100 ]; do
    USED=false
    for FILE in "$ROOT"/bots/*/slot; do
      [ -e "$FILE" ] || continue
      if [ "$(cat "$FILE")" = "$SLOT" ]; then USED=true; break; fi
    done
    [ "$USED" = false ] && break
    SLOT=$((SLOT + 1))
  done
  [ "$SLOT" -lt 100 ] || { echo "no desktop slots available" >&2; exit 75; }
  printf '%s\n' "$SLOT" > "$BOT/slot"
fi
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
mkdir -p ${RUNTIME_ROOT} ${BOTS_ROOT} ${DATA_ROOT}/agents ${DATA_ROOT}/user-memory ${DATA_ROOT}/user-packages ${HOME_ROOT}/bin ${HOME_ROOT}/reference ${HOME_ROOT}/chrome-profile ${WORKSPACES_ROOT}
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
chmod 700 ${RUNTIME_ROOT}/start-desktop.sh ${ENSURE_AGENT_SCRIPT} ${CONTROL_SCRIPT} ${RUNTIME_ROOT}/browser.mjs ${RUNTIME_ROOT}/start-gateway.sh
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
    await sprite.execFileHTTP(
      ENSURE_AGENT_SCRIPT,
      [layout.key, base64(layout.profileJson)],
      { signal, timeout: 60_000, maxBuffer: MAX_OUTPUT * 2 },
    );
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

  private agentControlGuard(layout: AgentLayout): string {
    return `${CONTROL_SCRIPT} assert-agent ${shellQuote(layout.key)} ${shellQuote(this.ownerId)} ${LEASE_MAX_AGE_SECONDS} || exit $?`;
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

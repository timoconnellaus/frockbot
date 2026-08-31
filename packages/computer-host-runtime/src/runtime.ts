/**
 * The Computer runtime as it exists *on the Sprite*: the paths a User's
 * Computer is laid out under, the shell scripts that provision it and run its
 * declared services, and the browser helper the provider drives over CDP.
 *
 * These constants used to live inside `@frockbot/plugin-fly-sprite`, where the
 * only way to reach the Sprite was `execFileHTTP` and every script travelled
 * base64-encoded on the command's argv. Fly answers a ~2.5 KB argv with HTTP
 * 431 (ADR 0004), so the provisioning script could never run from any runtime
 * as written. The scripts move here so the shared Computer host of ADR 0004
 * can deliver them the way they must be delivered — on a command's **stdin** —
 * while the provider Package keeps generating exactly the same text.
 *
 * There is one copy. `plugin-fly-sprite` imports this module rather than
 * holding its own, so a change to the Computer's layout cannot mean two
 * Computers.
 */
export const DESKTOP_SERVICE = "frockbot-viewer-gateway";
/**
 * The durable-root sync's on-Sprite half (ADR 0013), declared as a service so
 * the Sprite runtime brings it back after a cold pause: "Only
 * Computer-provider-declared services may be reattached; other processes are
 * assumed dead after a cold pause." It holds no credential and makes no
 * network call — it watches the durable roots and bumps a change signal, and
 * the sync agent that reads object storage runs in the backend.
 */
export const WORKSPACE_SYNC_SERVICE = "frockbot-workspace-sync";
export const HOME_ROOT = "/home/box";
export const DATA_ROOT = `${HOME_ROOT}/agent-data`;
export const RUNTIME_ROOT = `${HOME_ROOT}/.frockbot`;
export const BOTS_ROOT = `${RUNTIME_ROOT}/bots`;
export const WORKSPACES_ROOT = "/workspaces";
export const CONTROL_SCRIPT = `${RUNTIME_ROOT}/control.sh`;
export const ENSURE_AGENT_SCRIPT = `${RUNTIME_ROOT}/ensure-agent.sh`;
export const LEASE_MAX_AGE_SECONDS = 90;
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
export const NO_SLOTS_EXIT = 75;
/** The same refusal, on stdout, for a transport that swallows the exit code. */
export const NO_SLOTS_MARKER = "__FROCKBOT_NO_SLOTS__";

export const startDesktopScript = `#!/usr/bin/env bash
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

export const ensureAgentScript = `#!/usr/bin/env bash
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

export const controlScript = `#!/usr/bin/env bash
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

export const browserHelper = `import { chromium } from "playwright-core";
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

export const syncWatchScript = `#!/usr/bin/env bash
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

export const gatewayScript = `#!/usr/bin/env bash
set -eu
exec websockify --web=/usr/share/novnc --token-plugin TokenFile --token-source=${RUNTIME_ROOT}/tokens 6080
`;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function base64(value: string): string {
  return Buffer.from(value).toString("base64");
}

export function installFile(path: string, content: string): string {
  return `printf %s ${shellQuote(base64(content))} | base64 -d > ${path}`;
}

export const provisionScript = `set -eu
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

/**
 * Every file `provisionScript` installs under the runtime root, with the mode
 * it installs them under.
 *
 * The provisioning script still writes them itself, because it is one bash
 * document that must run to completion on a Sprite that may have just cold
 * started. This list is how a caller that has the Sprites filesystem API can
 * put the same bytes in the same places without shelling out at all — the
 * migration path decision 3 of the plan defers, and the inventory a test can
 * assert against so a new runtime file cannot be added in one place only.
 */
export const COMPUTER_RUNTIME_FILES: readonly {
  path: string;
  content: string;
  mode: number;
}[] = [
  {
    path: `${RUNTIME_ROOT}/start-desktop.sh`,
    content: startDesktopScript,
    mode: 0o700,
  },
  { path: ENSURE_AGENT_SCRIPT, content: ensureAgentScript, mode: 0o700 },
  { path: CONTROL_SCRIPT, content: controlScript, mode: 0o700 },
  { path: `${RUNTIME_ROOT}/browser.mjs`, content: browserHelper, mode: 0o700 },
  {
    path: `${RUNTIME_ROOT}/start-gateway.sh`,
    content: gatewayScript,
    mode: 0o700,
  },
  {
    path: `${RUNTIME_ROOT}/watch-workspace.sh`,
    content: syncWatchScript,
    mode: 0o700,
  },
];

/** The Sprite name pattern a Computer may take: 3-63 lowercase DNS characters. */
export const COMPUTER_SPRITE_NAME = /^[a-z][a-z0-9-]{2,62}$/;

/**
 * The Sprite backing one User's Computer.
 *
 * "One Computer per User, shared by all Bots" (ADR 0012), so the name is
 * derived from the User and from nothing else. The digest is taken over a
 * JSON-encoded `["user", userId]` rather than the bare id, so a future
 * `["project", …]` key cannot collide with a User id that happens to spell the
 * same string.
 *
 * `digest` is supplied by the caller because the two runtimes that need this
 * name hash differently: Node has `node:crypto`, workerd has WebCrypto. The
 * derivation itself lives here once.
 */
export function computerSpriteNameV1(
  userId: string,
  digestHex: string,
  baseName: string,
): string {
  const base = baseName.trim();
  if (!COMPUTER_SPRITE_NAME.test(base)) {
    throw new Error(
      "Computer Sprite base name must be 3-63 lowercase letters, numbers, or hyphens",
    );
  }
  if (!userId.trim()) {
    throw new Error("Computer Sprite name requires a non-empty userId");
  }
  const prefix = base.slice(0, 49).replace(/-+$/g, "");
  return `${prefix}-${digestHex.slice(0, 12)}`;
}

/** What `computerSpriteNameV1` expects a digest of. */
export function computerSpriteNameSourceV1(userId: string): string {
  return JSON.stringify(["user", userId]);
}

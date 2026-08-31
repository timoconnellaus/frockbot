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
export const BOUNDED_LOG_SCRIPT = `${RUNTIME_ROOT}/bounded-log.sh`;
/** Bytes kept from the head of a background process's log. */
export const BOUNDED_LOG_HEAD_BYTES = 131_072;
/** Bytes kept from its tail. Together, GrokBot's 256 KiB cap. */
export const BOUNDED_LOG_TAIL_BYTES = 131_072;
export const ENSURE_AGENT_SCRIPT = `${RUNTIME_ROOT}/ensure-agent.sh`;
/** Where Playwright keeps the browser builds it downloads for this Computer. */
export const BROWSERS_ROOT = `${RUNTIME_ROOT}/browsers`;
/**
 * The one path that runs the Computer's browser.
 *
 * It is a symlink rather than a package because Ubuntu's `chromium` is a snap
 * transitional package (ADR 0004): installing it drags in `snapd` and
 * `systemd` and never finished inside the ten-minute bound. The browser is
 * Playwright's own Chromium build instead — a self-contained tarball from
 * Playwright's CDN, no package manager involved — and this symlink is what
 * keeps `start-desktop.sh` free of the version in its directory name.
 */
export const CHROMIUM_PATH = `${HOME_ROOT}/bin/chromium`;
/** Pinned with `playwright-core`, because the driver and the build must agree. */
export const PLAYWRIGHT_VERSION = "1.55.0";
/**
 * The Playwright build the Computer downloads, named for a release Playwright
 * knows rather than the one the Sprite actually runs.
 *
 * Playwright resolves a browser build from the host distribution and refuses
 * anything it has no build for: on the Sprite base image it answers "Playwright
 * does not support chromium on ubuntu26.04-x64" and installs nothing. This is
 * the newest release it does have a build for, and that build was verified
 * running headful under Xvfb on a real Sprite with CDP answering.
 */
export const PLAYWRIGHT_PLATFORM = "ubuntu24.04-x64";

/**
 * Everything the Computer's desktop needs from the distribution, and nothing
 * that merely recommends itself.
 *
 * `chromium` is deliberately absent. On the Sprite base image (Ubuntu 25.10)
 * it is a snap transitional package: installing it pulls `snapd` and
 * `systemd` and, measured on 2026-09-01, had not finished after 25 minutes.
 * The browser arrives in the `browser` phase instead, as Playwright's own
 * self-contained Chromium build. What is left here is the display (`xvfb`),
 * the window manager (`fluxbox`), the VNC server (`x11vnc`), the viewer's
 * static assets and proxy (`novnc`, `websockify`), `xdpyinfo` (`x11-utils`)
 * for the desktop script's readiness wait, `scrot` for `computer_screenshot`,
 * and the shared libraries that
 * Chromium build links against — those are named explicitly because
 * `--no-install-recommends` is what keeps `python3-numpy`, `liblapack3`,
 * `poppler-data`, and a font collection out of a cold Computer.
 */
export const DESKTOP_PACKAGES = [
  "xvfb",
  "fluxbox",
  "x11vnc",
  "novnc",
  "websockify",
  "x11-utils",
  "xauth",
  "scrot",
  "ca-certificates",
  "util-linux",
  "libnss3",
  "libnspr4",
  "libatk1.0-0t64",
  "libatk-bridge2.0-0t64",
  "libcups2t64",
  "libdrm2",
  "libxkbcommon0",
  "libxcomposite1",
  "libxdamage1",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libpango-1.0-0",
  "libcairo2",
  "libasound2t64",
  "libatspi2.0-0",
] as const;
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
${CHROMIUM_PATH} --no-sandbox --disable-dev-shm-usage --disable-gpu --user-data-dir="${HOME_ROOT}/chrome-profile" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" --start-maximized about:blank >"$BOT/chromium.log" 2>&1 &
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

/**
 * A background process's log, capped at 256 KiB — the head and the tail, with
 * the middle dropped.
 *
 * GrokBot's `box-bounded-log.mjs` keeps both ends for the same reason: a job
 * that runs for an hour says what it set out to do at the start and what went
 * wrong at the end, and the middle is the part nobody reads. A cap is not
 * optional here — a process outlives its Turn, and an uncapped log on a
 * Computer is an unbounded write to a disk the User pays for.
 *
 * The two halves are separate files. Composing them at read time is what makes
 * the tail trimmable without ever rewriting the head, so a long-running
 * process costs one bounded trim per 128 KiB rather than a rewrite per line.
 */
export const boundedLogScript = `#!/usr/bin/env bash
set -eu
OUT="$1"
HEAD_BYTES=\${2:-${BOUNDED_LOG_HEAD_BYTES}}
TAIL_BYTES=\${3:-${BOUNDED_LOG_TAIL_BYTES}}
: > "$OUT.head"
: > "$OUT.tail"
HEAD_WRITTEN=0
TAIL_WRITTEN=0
while IFS= read -r LINE || [ -n "$LINE" ]; do
  SIZE=$((\${#LINE} + 1))
  if [ "$HEAD_WRITTEN" -lt "$HEAD_BYTES" ]; then
    printf '%s\\n' "$LINE" >> "$OUT.head"
    HEAD_WRITTEN=$((HEAD_WRITTEN + SIZE))
  else
    printf '%s\\n' "$LINE" >> "$OUT.tail"
    TAIL_WRITTEN=$((TAIL_WRITTEN + SIZE))
    # Counted in the shell rather than measured with stat: a subprocess per
    # line would make the logger cost more than the job it is logging.
    # Trimming at twice the cap keeps the work amortized — one trim per
    # TAIL_BYTES written, never one per line.
    if [ "$TAIL_WRITTEN" -gt $((TAIL_BYTES * 2)) ]; then
      tail -c "$TAIL_BYTES" "$OUT.tail" > "$OUT.tail.tmp"
      mv "$OUT.tail.tmp" "$OUT.tail"
      TAIL_WRITTEN="$TAIL_BYTES"
    fi
  fi
done
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

/**
 * Where the detached provisioner keeps everything about one provisioning run.
 *
 * A Computer is provisioned by a process that outlives the connection that
 * started it (ADR 0004): `@fly/sprites@0.1.0` declares a WebSocket dead after
 * `WS_PONG_WAIT` (45 s) without an inbound message and never sends a ping of
 * its own, so no exec may be quiet for that long. `apt-get` is quiet for
 * minutes. The provisioner therefore runs under `setsid nohup` behind a
 * `flock`, and the host learns about it from these files through short exec
 * calls that answer immediately.
 */
export const PROVISION_ROOT = `${RUNTIME_ROOT}/provision`;
/** The provisioning document itself, installed by the launcher. */
export const PROVISION_SCRIPT = `${PROVISION_ROOT}/provision.sh`;
/** One JSON line: which phase the provisioner is on, and how it is going. */
export const PROVISION_STATE = `${PROVISION_ROOT}/state.json`;
/** Everything the provisioner and its `apt-get` wrote, for a failure report. */
export const PROVISION_LOG = `${PROVISION_ROOT}/provision.log`;
/** Held for the life of a run, so "is it still going?" is not a pid guess. */
export const PROVISION_LOCK = `${PROVISION_ROOT}/provision.lock`;
/**
 * One file per completed phase.
 *
 * This is the marker that makes a half-provisioned Computer resumable: a run
 * that starts again skips every phase whose marker is already there, so a
 * container restart or a dropped connection costs the remaining phases and
 * never the whole install.
 */
export const PROVISION_MARKERS = `${PROVISION_ROOT}/phases`;

/** Prefix the report tail uses to say whether a provisioner is still alive. */
export const PROVISION_RUNNER_PREFIX = "frockbot-provision-runner:";

/**
 * The Sprite's own management socket, and the task that holds it awake.
 *
 * A detached provisioner does not keep its Sprite running. Sprites define
 * activity as "a command running, a session producing output, an open TCP
 * connection to its URL, a service handling traffic" — a `setsid nohup`
 * background process is none of those, so the platform is free to pause the
 * VM while `apt-get` is mid-download and resume it when the host's next poll
 * arrives. Measured on 2026-09-01 against a disposable Sprite: with nothing
 * holding it up, the Sprite's own clock advanced ~4 minutes while ~25 minutes
 * of wall time passed, so provisioning ran at roughly a seventh of its speed
 * and no package list could have fitted inside the ten-minute bound.
 *
 * The documented hold is the Tasks API on `/.sprite/api.sock`: "Register a
 * task; the Sprite stays up. Delete it (or let it expire); the Sprite is free
 * to pause again." The task is registered with a short expiry and refreshed
 * from a child process, so a provisioner that dies without cleaning up stops
 * paying for the Sprite within the expiry rather than pinning it awake.
 *
 * @see https://docs.sprites.dev/keeping-sprites-running/
 */
export const SPRITE_API_SOCKET = "/.sprite/api.sock";
/** The name the provisioner's keepalive task holds. */
export const PROVISION_TASK = "frockbot-provision";
/** Short enough that a crashed provisioner releases the Sprite on its own. */
export const PROVISION_TASK_EXPIRY = "5m";
/** Four refreshes inside one expiry, the interval the Sprites docs recommend. */
export const PROVISION_TASK_REFRESH_SECONDS = 60;

/**
 * PATH repair, run before anything in the provisioning document shells out.
 *
 * `/.sprite/bin/node` (and `npm`, and `npx`) is not the binary: it is a bash
 * shim that sources `nvm.sh`, activates the default toolchain, and re-execs.
 * Its last resort for locating the real binary is `command -v node`, which in
 * a non-login shell resolves to the shim itself — so it re-execs itself for
 * ever. Measured on a real Sprite: a detached `node --version` forked
 * endlessly and never returned, which would have hung the browser phase the
 * way `apt-get` hung the packages phase.
 *
 * The real toolchain directories are declared, one per line, in
 * `/etc/profile.d/languages_paths`. Putting them on PATH first means every
 * `node` and `npm` in this document is a binary rather than a shim, and the
 * document keeps working unchanged if the file is ever absent.
 */
export const provisionPathPreamble = `if [ -r /etc/profile.d/languages_paths ]; then
  PATH="$(tr '\\n' ':' < /etc/profile.d/languages_paths)$PATH"
  export PATH
fi`;

/**
 * The phases of provisioning a Computer, in order.
 *
 * They are declared rather than inlined because they are three things at
 * once: the body of the provisioning script, the resume markers that let a
 * half-provisioned Computer be completed, and the progress a client reports
 * ("installing the desktop packages (2/5)") while a cold Computer opens.
 */
export const PROVISION_PHASES: readonly {
  name: string;
  label: string;
  body: string;
}[] = [
  {
    name: "layout",
    label: "preparing the Computer layout",
    body: `mkdir -p ${RUNTIME_ROOT} ${RUNTIME_ROOT}/sync ${BOTS_ROOT} ${DATA_ROOT}/agents ${DATA_ROOT}/user-memory ${DATA_ROOT}/user-packages ${HOME_ROOT}/bin ${HOME_ROOT}/reference ${HOME_ROOT}/chrome-profile ${WORKSPACES_ROOT}
touch ${RUNTIME_ROOT}/tokens
chmod 700 ${RUNTIME_ROOT}
chmod 600 ${RUNTIME_ROOT}/tokens`,
  },
  {
    name: "packages",
    label: "installing the desktop packages",
    body: `if ! command -v Xvfb >/dev/null || ! command -v x11vnc >/dev/null || ! command -v websockify >/dev/null || ! command -v scrot >/dev/null; then
  if [ "$(id -u)" = 0 ]; then SUDO=""; else SUDO="sudo"; fi
  # The base image ships a populated /var/lib/apt/lists, but a stale one: on
  # 2026-09-01 installing straight from it failed with 404s on superseded
  # libheif .debs that security.ubuntu.com no longer carries. The refresh is
  # not the expense it looked like — measured at 6 s once the Sprite is held
  # awake, against the 262 s recorded in ADR 0004 for the same command on a
  # Sprite the platform kept pausing underneath it.
  $SUDO apt-get update
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${DESKTOP_PACKAGES.join(" ")}
fi`,
  },
  {
    name: "runtime",
    label: "installing the Computer runtime",
    body: `${installFile(`${RUNTIME_ROOT}/start-desktop.sh`, startDesktopScript)}
${installFile(ENSURE_AGENT_SCRIPT, ensureAgentScript)}
${installFile(CONTROL_SCRIPT, controlScript)}
${installFile(BOUNDED_LOG_SCRIPT, boundedLogScript)}
${installFile(`${RUNTIME_ROOT}/browser.mjs`, browserHelper)}
${installFile(`${RUNTIME_ROOT}/start-gateway.sh`, gatewayScript)}
${installFile(`${RUNTIME_ROOT}/watch-workspace.sh`, syncWatchScript)}
chmod 700 ${RUNTIME_ROOT}/start-desktop.sh ${ENSURE_AGENT_SCRIPT} ${CONTROL_SCRIPT} ${BOUNDED_LOG_SCRIPT} ${RUNTIME_ROOT}/browser.mjs ${RUNTIME_ROOT}/start-gateway.sh ${RUNTIME_ROOT}/watch-workspace.sh`,
  },
  {
    name: "browser",
    label: "installing the browser",
    body: `if [ ! -d ${RUNTIME_ROOT}/node_modules/playwright-core ]; then
  npm install --prefix ${RUNTIME_ROOT} --no-audit --no-fund playwright-core@${PLAYWRIGHT_VERSION}
fi
if [ ! -x ${CHROMIUM_PATH} ]; then
  # Playwright's own build, from Playwright's CDN, unpacked into the runtime
  # root: a real ELF binary with its libraries beside it, no package manager
  # and no snap involved. The driver that talks to it over CDP is the
  # \`playwright-core\` above, so the two are pinned to the same version.
  # PLAYWRIGHT_HOST_PLATFORM_OVERRIDE, because Playwright ${PLAYWRIGHT_VERSION} refuses
  # the Sprite base image outright: "Playwright does not support chromium on
  # ubuntu26.04-x64". It has no build named for that release and will not
  # guess. The build named for the newest release it does know runs on it —
  # proved on a real Sprite, headful under Xvfb with CDP answering — so this
  # names that build rather than leaving the phase to fail.
  PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_ROOT} PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=${PLAYWRIGHT_PLATFORM} node ${RUNTIME_ROOT}/node_modules/playwright-core/cli.js install chromium
  CHROMIUM_BUILD=$(ls -d ${BROWSERS_ROOT}/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)
  if [ -z "$CHROMIUM_BUILD" ]; then
    echo "playwright installed no chromium build under ${BROWSERS_ROOT}" >&2
    exit 1
  fi
  # A symlink, so the version in the build's directory name stays out of
  # start-desktop.sh and an upgrade is one relink rather than a script change.
  ln -sfn "$CHROMIUM_BUILD" ${CHROMIUM_PATH}
fi`,
  },
  {
    name: "reference",
    label: "writing the Computer reference",
    body: `cat > ${HOME_ROOT}/reference/README.md <<'FROCKBOT_REFERENCE_EOF'
# FrockBot computer

/home/box/agent-data is durable application data. /workspaces contains Bot-private workspaces.
One Computer serves all of a User's Bots. Each Bot has its own directories
and desktop; the browser profile at /home/box/chrome-profile is shared by all of them.
Automations are stored but are not executed unless an automation runtime is installed.
FROCKBOT_REFERENCE_EOF`,
  },
];

/** The phase a run reports before it has entered the first real one. */
export const PROVISION_STARTING_PHASE = {
  name: "starting",
  label: "starting the Computer provisioner",
} as const;

function provisionStateLine(
  index: number,
  name: string,
  label: string,
  status: string,
): string {
  return JSON.stringify({
    version: 1,
    index,
    total: PROVISION_PHASES.length,
    phase: name,
    label,
    status,
  });
}

/**
 * The provisioning document, run detached and resumable.
 *
 * Every phase is guarded by its marker, so running this again on a
 * half-provisioned Computer completes it rather than starting over, and every
 * phase records where it has got to before it begins. `set -E` is what makes
 * the `ERR` trap fire from inside a function or a subshell, so a failure is
 * recorded rather than merely exiting.
 *
 * Before any of that it does the two things that make a detached run on a
 * Sprite possible at all: it holds the Sprite awake with a Tasks-API task
 * (see `SPRITE_API_SOCKET` — without it the platform pauses the VM under a
 * background `apt-get`), and it puts the real toolchain on PATH (see
 * `provisionPathPreamble` — without it `node` is a shim that re-execs itself
 * for ever). Both releases are on an `EXIT` trap, so a provisioner that fails
 * hands the Sprite back rather than pinning it awake.
 */
export const provisionScript = `#!/usr/bin/env bash
set -eEu
${provisionPathPreamble}
sprite_task() {
  curl -sS --max-time 10 --unix-socket ${SPRITE_API_SOCKET} "$@" >/dev/null 2>&1 || true
}
sprite_task -H 'Content-Type: application/json' -X POST http://sprite/v1/tasks -d '{"name":"${PROVISION_TASK}","expire":"${PROVISION_TASK_EXPIRY}"}'
while sleep ${PROVISION_TASK_REFRESH_SECONDS}; do
  curl -sS --max-time 10 --unix-socket ${SPRITE_API_SOCKET} -H 'Content-Type: application/json' -X PUT http://sprite/v1/tasks/${PROVISION_TASK} -d '{"expire":"${PROVISION_TASK_EXPIRY}"}' >/dev/null 2>&1 || exit 0
done &
KEEPALIVE=$!
release() {
  kill "$KEEPALIVE" 2>/dev/null || true
  sprite_task -X DELETE http://sprite/v1/tasks/${PROVISION_TASK}
}
trap release EXIT
MARKERS=${PROVISION_MARKERS}
STATE=${PROVISION_STATE}
mkdir -p "$MARKERS"
INDEX=0
NAME=${PROVISION_STARTING_PHASE.name}
LABEL='${PROVISION_STARTING_PHASE.label}'
state() {
  TMP=$(mktemp "$STATE.XXXXXX")
  printf '{"version":1,"index":%s,"total":${PROVISION_PHASES.length},"phase":"%s","label":"%s","status":"%s"}\\n' "$INDEX" "$NAME" "$LABEL" "$1" > "$TMP"
  mv "$TMP" "$STATE"
}
trap 'state failed' ERR
${PROVISION_PHASES.map(
  (phase, position) => `INDEX=${position + 1}
NAME=${phase.name}
LABEL=${shellQuote(phase.label)}
state running
if [ ! -f "$MARKERS/${phase.name}" ]; then
${phase.body}
  touch "$MARKERS/${phase.name}"
fi`,
).join("\n")}
INDEX=${PROVISION_PHASES.length}
NAME=ready
LABEL='the Computer is ready'
state complete
`;

/**
 * How long a provisioner waits for the run lock before giving up.
 *
 * It waits rather than refusing because the lock is probed, and a probe holds
 * it for microseconds. A provisioner that used `flock -n` would lose that race
 * every so often and die without a word — measured, and the reason this is a
 * wait and not a `-n`.
 */
const PROVISION_LOCK_WAIT_SECONDS = 30;

/**
 * Installs the provisioning document and starts it detached, then reports.
 *
 * The document travels on this command's **stdin** and is installed with a
 * rename, so a provisioner that is already running keeps reading the inode it
 * opened and a second launcher cannot corrupt it. The launch itself is
 * guarded twice: `setsid nohup` so the run survives this exec session ending,
 * and `flock -n` so two launchers cannot produce two `apt-get` runs on one
 * Computer.
 */
export const provisionLaunchScript = `set -eu
mkdir -p ${PROVISION_ROOT} ${PROVISION_MARKERS}
touch ${PROVISION_LOCK}
# Probed once, before anything is started. A second probe after the launch
# would contend with the provisioner it had just started.
RUNNER=running
if flock -n ${PROVISION_LOCK} true 2>/dev/null; then RUNNER=stopped; fi
if [ "$RUNNER" = stopped ]; then
  ${installFile(`${PROVISION_SCRIPT}.tmp`, provisionScript)}
  chmod 700 ${PROVISION_SCRIPT}.tmp
  mv ${PROVISION_SCRIPT}.tmp ${PROVISION_SCRIPT}
  if ! grep -q '"status":"complete"' ${PROVISION_STATE} 2>/dev/null; then
    # Only when there is nothing to keep. A relaunch resumes an install that
    # already reached a phase, and reporting it as "starting" again would make
    # a resume look like a restart to whoever is watching.
    [ -s ${PROVISION_STATE} ] || printf '%s\\n' ${shellQuote(
      provisionStateLine(
        0,
        PROVISION_STARTING_PHASE.name,
        PROVISION_STARTING_PHASE.label,
        "running",
      ),
    )} > ${PROVISION_STATE}
    setsid nohup flock -w ${PROVISION_LOCK_WAIT_SECONDS} ${PROVISION_LOCK} bash ${PROVISION_SCRIPT} >>${PROVISION_LOG} 2>&1 </dev/null &
    RUNNER=running
  fi
fi
printf '${PROVISION_RUNNER_PREFIX}%s\\n' "$RUNNER"
cat ${PROVISION_STATE} 2>/dev/null || true
`;

/**
 * One poll: it starts nothing and answers immediately.
 *
 * This is the command that replaces the minutes-long silent exec. It is what
 * keeps every connection to the Sprite far inside the SDK's 45-second window.
 */
export const provisionPollScript = `set -eu
touch ${PROVISION_LOCK} 2>/dev/null || true
if flock -n ${PROVISION_LOCK} true 2>/dev/null; then
  printf '${PROVISION_RUNNER_PREFIX}stopped\\n'
else
  printf '${PROVISION_RUNNER_PREFIX}running\\n'
fi
cat ${PROVISION_STATE} 2>/dev/null || true
`;

/** The tail of the provisioner's own log, for a failure report. */
export const provisionLogTailScript = `tail -c 2000 ${PROVISION_LOG} 2>/dev/null || true
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
  { path: BOUNDED_LOG_SCRIPT, content: boundedLogScript, mode: 0o700 },
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

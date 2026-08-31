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
/**
 * The shared scratch every Bot of one User can reach, and the one directory on
 * the Computer that is deliberately **not** durable.
 *
 * GrokBot's fourteen agents share `/workspace` and make it their default cwd.
 * FrockBot keeps the per-Bot workspace private (`/workspaces/<botKey>`) and
 * adds this beside it, because a hand-off between two of a User's Bots needs
 * somewhere to put a file that is not either Bot's private directory.
 *
 * It is absent from the Computer provider's Workspace layout on purpose. "The
 * Workspace is durable User and Bot state ... everything else on the Computer
 * may be lost": nothing here reaches object storage, so it survives a
 * hibernation and a cold start on the Sprite's own disk and is lost on an
 * image rebuild, a Computer reset, or a host migration. Said once here, once
 * in `layout.md`, once in the `computer_exec` description, and reported by
 * box-doctor as the first thing to prune under disk pressure.
 */
export const SCRATCH_ROOT = "/workspace";
/** The environment variable a tenant finds the shared scratch under. */
export const SCRATCH_ENV = "FROCKBOT_SCRATCH";
/** Where the launcher and the sanctioned-surface shims are installed. */
export const BIN_ROOT = `${HOME_ROOT}/bin`;
/**
 * Where the sanctioned-surface shims live.
 *
 * A directory of their own rather than `bin`, because `bin` holds real
 * binaries — the browser launcher, and the browser itself — and a refusal
 * named `chromium` sitting where the browser is expected would be a Computer
 * that cannot start its own desktop. This directory leads a tenant's `PATH`;
 * `bin` follows it.
 */
export const SHIMS_ROOT = `${RUNTIME_ROOT}/shims`;
/** The shipped reference documents a Bot reads to debug its own Computer. */
export const REFERENCE_ROOT = `${HOME_ROOT}/reference`;
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

/**
 * The one variable that separates a sanctioned GUI call from a shell-driven
 * one.
 *
 * The shims below refuse unless it is set, and the Computer's own scripts —
 * the desktop starter, the launcher, the screenshot exec — set it. It is
 * emphatically not a security control: a Bot's shell can export it in one
 * word, and the Computer is the User's trust boundary anyway. It exists so
 * the sanctioned path stays open while the accidental one closes with an
 * explanation.
 */
export const SANCTIONED_SURFACE_ENV = "FROCKBOT_SANCTIONED_SURFACE";

/**
 * The commands a Bot never runs itself, because a sanctioned tool does the
 * same job better.
 *
 * GrokBot's box ships `box-chrome` and has no `xdotool` at all: "the GUI is
 * never driven from the shell". FrockBot states the same policy in two
 * layers — a refusal at the `computer_exec` seam and a PATH shim on the
 * Computer — and calls it policy rather than a boundary in both places.
 */
export const COMPUTER_GUI_SHELL_COMMANDS = [
  "chromium",
  "chromium-browser",
  "chrome",
  "google-chrome",
  "xdotool",
  "wmctrl",
  "xdpyinfo",
  "scrot",
  "import",
  "x11vnc",
  "Xvfb",
] as const;

/** The refusal both layers print, naming the surface that does the job. */
export function computerGuiRefusalV1(command: string): string {
  return [
    `"${command}" is not run directly on this Computer: its GUI is never driven from the shell.`,
    "Use computer_browser to drive the browser, computer_screenshot to see the screen,",
    `and ${CHROME_LAUNCHER} to launch a browser with the Computer's own flags.`,
  ].join(" ");
}

/**
 * The command a shell string invokes, when that command is one of the GUI
 * commands above.
 *
 * A regex over a shell string, and honestly labelled as one: it reads command
 * positions — the start of the string, and whatever follows `;`, `&&`, `||`,
 * `|`, a newline, or a subshell — past any leading environment assignments,
 * `sudo`, or `env`. It is defeatable by anyone who wants to defeat it, which
 * is why the policy is stated in the refusal rather than relied upon.
 */
export function shellGuiCommandV1(command: string): string | undefined {
  const names = COMPUTER_GUI_SHELL_COMMANDS.join("|");
  const pattern = new RegExp(
    String.raw`(?:^|[;&|(\n]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;|&]*\s+)*(?:sudo\s+|env\s+)?(?:[^\s;|&'"]*/)?(${names})(?=$|[\s;|&)'"])`,
  );
  const match = pattern.exec(command);
  return match?.[1];
}

/** The browser flags the Computer runs chromium under, in one place. */
export const CHROMIUM_FLAGS: readonly string[] = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  `--user-data-dir=${HOME_ROOT}/chrome-profile`,
  "--remote-debugging-address=127.0.0.1",
  "--start-maximized",
];

export const CHROME_LAUNCHER = `${BIN_ROOT}/frockbot-chrome`;

/**
 * The single place the Computer's chromium flags live (parity row 33).
 *
 * It takes a Bot key, reads that tenant's slot, and derives the display and
 * the CDP port from it — the same arithmetic the desktop starter does, done
 * once. `start-desktop.sh` calls it, and so may a human debugging the box;
 * nothing else needs to know the flag set exists.
 */
export const chromeLauncherScript = `#!/usr/bin/env bash
set -eu
KEY="\${1:-\${FROCKBOT_BOT_KEY:-}}"
if [ -z "$KEY" ]; then
  echo "frockbot-chrome needs a Bot key: frockbot-chrome <botKey> [chromium args…]" >&2
  exit 64
fi
shift || true
SLOT=$(cat ${BOTS_ROOT}/"$KEY"/slot 2>/dev/null || echo "")
if [ -z "$SLOT" ]; then
  echo "Bot \\"$KEY\\" has no desktop slot on this Computer" >&2
  exit 69
fi
export DISPLAY=":$((100 + SLOT))"
export ${SANCTIONED_SURFACE_ENV}=1
if [ ! -x ${CHROMIUM_PATH} ]; then
  echo "no browser is installed at ${CHROMIUM_PATH}; the Computer installs one when it is provisioned" >&2
  exit 69
fi
# By absolute path, not by name: the browser is Playwright's own build behind a
# stable symlink, and reaching it through PATH would go past the shim that
# covers the name chromium.
exec ${CHROMIUM_PATH} ${CHROMIUM_FLAGS.join(" ")} --remote-debugging-port="$((9222 + SLOT))" "$@"
`;

/**
 * One PATH shim: the same refusal the tool seam gives, on the Computer.
 *
 * With the sanctioned variable set it steps out of the way — it drops its own
 * directory from `PATH` and execs the real binary — so the Computer's own
 * scripts keep working while a shell that reached for `xdotool` by hand is
 * told what to use instead. Exit 64 is `EX_USAGE`: the command was wrong, not
 * the Computer.
 */
export function guiShimScript(command: string): string {
  return `#!/usr/bin/env bash
if [ "\${${SANCTIONED_SURFACE_ENV}:-}" = 1 ]; then
  NEXT=""
  IFS=: read -ra PARTS <<< "$PATH"
  for PART in "\${PARTS[@]}"; do
    [ "$PART" = ${SHIMS_ROOT} ] && continue
    NEXT="\${NEXT:+$NEXT:}$PART"
  done
  export PATH="$NEXT"
  exec ${command} "$@"
fi
echo ${shellQuote(computerGuiRefusalV1(command))} >&2
exit 64
`;
}

export const startDesktopScript = `#!/usr/bin/env bash
set -eu
KEY="$1"
ROOT=${RUNTIME_ROOT}
BOT="$ROOT/bots/$KEY"
SLOT=$(cat "$BOT/slot")
DISPLAY_NUMBER=$((100 + SLOT))
VNC_PORT=$((5900 + SLOT))
export DISPLAY=:$DISPLAY_NUMBER
# The desktop stack *is* the sanctioned surface, so the shims step aside for
# it. Everything a Bot's own shell runs arrives without this set.
export ${SANCTIONED_SURFACE_ENV}=1
cleanup() {
  jobs -pr | xargs -r kill >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
rm -f "/tmp/.X$DISPLAY_NUMBER-lock" "/tmp/.X11-unix/X$DISPLAY_NUMBER"
Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp &
for _ in $(seq 1 100); do xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break; sleep 0.1; done
fluxbox >"$BOT/fluxbox.log" 2>&1 &
${CHROME_LAUNCHER} "$KEY" about:blank >"$BOT/chromium.log" 2>&1 &
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

/** The port the noVNC gateway serves on, and the port box-doctor probes. */
export const DESKTOP_GATEWAY_PORT = 6080;

export const gatewayScript = `#!/usr/bin/env bash
set -eu
exec websockify --web=/usr/share/novnc --token-plugin TokenFile --token-source=${RUNTIME_ROOT}/tokens ${DESKTOP_GATEWAY_PORT}
`;

/** Where box-doctor is installed, and the log a human reads it back from. */
export const DOCTOR_SCRIPT = `${RUNTIME_ROOT}/box-doctor.sh`;
/** GrokBot's path, kept: `/tmp/box-doctor.log` (`grokbot-computer.md:396`). */
export const DOCTOR_LOG = "/tmp/box-doctor.log";
/** Prefixes the one line of the run that is the machine-readable report. */
export const DOCTOR_MARKER = "__FROCKBOT_DOCTOR__";
/** The report schema box-doctor prints. Bumped, never migrated. */
export const DOCTOR_REPORT_SCHEMA_VERSION = 1;
/** Log lines kept in `/tmp/box-doctor.log` before the oldest are dropped. */
export const DOCTOR_LOG_MAX_LINES = 500;
/**
 * The earliest wall clock a healthy Computer can report: 2026-09-01.
 *
 * A container whose clock has reset reads as some point in 1970, and every
 * lease, every generation timestamp, and every `capturedAt` on it is then
 * wrong in a way nothing downstream can detect. There is nothing on the box to
 * check a clock against, so the check is a floor rather than a comparison.
 */
export const CLOCK_FLOOR_EPOCH = 1_756_684_800;

/**
 * The version of the shipped reference set (parity row 27).
 *
 * It exists because provisioning short-circuits: a Computer that has been
 * provisioned is adopted, and the provisioning document never runs on it
 * again, so a here-doc README written at provisioning time could never be
 * corrected. The version is compared on every adoption instead, and the whole
 * set is rewritten when it moves. Bump it whenever a document below changes.
 */
export const REFERENCE_DOCS_VERSION = "2026-09-01.1";

/**
 * What a Bot reads to debug its own Computer.
 *
 * GrokBot ships `reference/{debugging-the-box.md, app-ui.md}` for exactly this
 * (`grokbot-computer.md:65`): documents the harness wrote, not the agent, that
 * answer "where does this live" and "what do I run" without a round trip
 * through a human. These four cover the layout, the browser, and the box's own
 * self-check.
 */
export const REFERENCE_DOCS: readonly { name: string; content: string }[] = [
  {
    name: "README.md",
    content: `# Your FrockBot Computer

One Computer serves all of your User's Bots. You have your own directories and
your own desktop on it; the browser profile is shared, so a login one Bot makes
is a login all of them have.

- \`layout.md\` — what is durable, what is scratch, and what is lost when.
- \`browser.md\` — how the browser is launched and driven, and what never is.
- \`debugging-the-box.md\` — the self-check, the logs, and background processes.

Separation between Bots here is organizational, not a security boundary: the
Computer is your User's trust boundary, and Bots of one User can read each
other's files. Nothing on this Computer holds a credential except the browser
profile.

This reference is version ${REFERENCE_DOCS_VERSION}. It is written by the
Computer runtime and rewritten whenever that version moves, so do not edit it —
your edits will be replaced.
`,
  },
  {
    name: "layout.md",
    content: `# Where things live

## Durable roots — survive everything

These synchronize with object storage in both directions. They survive
hibernation, cold start, host migration, and an image rebuild.

| Path | What |
|---|---|
| \`${DATA_ROOT}/agents/<botKey>/skills\` | your instruction root, writable by you |
| \`${DATA_ROOT}/agents/<botKey>/memory\` | your Memory, read-only here — change it through the Memory tools |
| \`${DATA_ROOT}/user-memory\` | your User's Memory, read-only here |
| \`${DATA_ROOT}/user-packages/<package>/<root>\` | roots a Package declared, e.g. screenshots and self-check reports |

Every write to a durable root records its writer. A file you leave here with a
shell command still reaches object storage, but as \`unattributed\` — it is
data, never provenance and never an instruction. Writes made through a tool
record you, your Session, and your Turn.

## Your own workspace — durable only if it is a declared root

\`${WORKSPACES_ROOT}/<botKey>\` is your working directory. It is private to you
by convention, not by permission.

## Shared scratch — never durable

\`${SCRATCH_ROOT}\` is shared by every Bot of your User and is the place to
hand a file to another one of them. It is exported as \`\$${SCRATCH_ENV}\`.

It is **not** a durable root. Nothing in it reaches object storage. It survives
hibernation and a cold start, because it is on this Computer's disk; it is lost
on an image rebuild, a Computer reset, and a host migration. Put working files
here, never the only copy of anything.

\`/tmp\` is the same story with a shorter life: assume a restart empties it.
`,
  },
  {
    name: "browser.md",
    content: `# The browser

One profile — \`${HOME_ROOT}/chrome-profile\` — shared by every Bot of your
User. A cookie one Bot earns is a cookie all of them have, which is why the
profile is treated as a User-scoped secret and why a human takeover exists for
a login you should not watch.

## Driving it

Use \`computer_browser\`. It performs one action and hands back an
accessibility snapshot, which is what you should read a page from.
\`computer_screenshot\` captures your own desktop as an image and files it in
your durable screenshots root.

## Launching it

\`${CHROME_LAUNCHER} <botKey>\` is the only sanctioned launcher. It derives
your display and your CDP port from your desktop slot and holds the flag set;
the desktop starter calls it, and nothing else needs to know the flags exist.

## What is never run from the shell

${COMPUTER_GUI_SHELL_COMMANDS.map((name) => `\`${name}\``).join(", ")}.

A \`computer_exec\` naming one of them is refused, and each has a shim in
\`${SHIMS_ROOT}\` — which leads your \`PATH\` — that prints the same refusal
and exits 64. Neither is a
security boundary — a shell can defeat both in one line, and this Computer is
your User's trust boundary anyway. They exist so the sanctioned path is the
easy one: a GUI driven from a shell leaves no record of who did what, and the
tools do.
`,
  },
  {
    name: "debugging-the-box.md",
    content: `# Debugging this Computer

## The self-check

\`computer_doctor\` runs \`${DOCTOR_SCRIPT}\` and hands back a report: disk on
\`/\` and \`${HOME_ROOT}\`, the size of \`${SCRATCH_ROOT}\`, the viewer
gateway, the durable-root watcher, your display and CDP port, the browser and
its profile, the sync signal and any conflicting generations, this reference
set's version, the launcher and its shims, the clock, DNS, and whether a
provisioning hold is still keeping this Computer awake.

Every run also appends to \`${DOCTOR_LOG}\`:

    [box-doctor] PASS <name>: <detail>
    [box-doctor] FAIL <name>: <detail>
    [box-doctor] SUMMARY <n> checks, <n> passed, <n> failed

The log keeps the last ${DOCTOR_LOG_MAX_LINES} lines, so it is a history of the
Computer rather than of one run.

## When a check fails

- **disk** — prune \`${SCRATCH_ROOT}\` first: nothing in it is durable.
- **sync-signal with conflicts** — a write landed on a generation its writer
  had not seen. The conflicting generation is preserved, never merged; say so
  rather than resolving it silently.
- **tenant-display** — your desktop is gone. Ask for it again; slots are
  allocated on demand and a Computer with all hundred in use will say so.
- **reference-docs** — this set is stale and refreshes when the Computer is
  next opened. Nothing you can do on the box fixes it.
- **browser** — the browser build is missing. It is installed by provisioning,
  not by a package manager, so there is nothing to apt-get; say so.
- **sprite-hold** — a provisioning hold is still registered, so this Computer
  cannot pause and is being paid for while idle. Worth reporting.

## Background work

\`computer_exec{background:true}\` returns a \`processId\` and keeps running
after your Turn ends. Check it with \`computer_process_check\`, read it with
\`computer_process_logs\`, end it with \`computer_process_stop\`. Do not poll
it in a loop.

Nothing keeps this Computer awake for a background process. If it hibernates
first, the process is gone and its outcome is reported as \`unknown\` — never
as running. Its log keeps its first and last 128 KiB; the middle of a long run
is dropped.

## Logs on the box

\`${DOCTOR_LOG}\`, and per-Bot under \`${BOTS_ROOT}/<botKey>\`:
\`chromium.log\`, \`fluxbox.log\`, \`x11vnc.log\`, and \`processes/<id>/log.*\`.
Provisioning's own log is \`${RUNTIME_ROOT}/provision/provision.log\`.
`,
  },
];

/**
 * Rewrites the shipped reference set when its version has moved.
 *
 * Guarded by the version file and by nothing else, so it is safe to run on
 * every adoption: an up-to-date Computer costs one `cat`. The write is a
 * rename, so a Bot reading a document never sees half of one.
 */
export const referenceInstallScript = `mkdir -p ${REFERENCE_ROOT}
if [ "$(cat ${REFERENCE_ROOT}/.version 2>/dev/null || true)" != ${shellQuote(REFERENCE_DOCS_VERSION)} ]; then
${REFERENCE_DOCS.map(
  (document) =>
    `  ${installFileAtomic(`${REFERENCE_ROOT}/${document.name}`, document.content)}`,
).join("\n")}
  printf '%s\\n' ${shellQuote(REFERENCE_DOCS_VERSION)} > ${REFERENCE_ROOT}/.version
fi`;

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
 * The same install, through a rename.
 *
 * `>` truncates in place, which is fine during provisioning — nothing is
 * reading these files yet — and wrong on a live Computer, where a script being
 * refreshed may be the script a running process is reading. A rename swaps the
 * name and leaves the old inode to whoever holds it.
 */
export function installFileAtomic(path: string, content: string): string {
  return `${installFile(`${path}.tmp`, content)} && mv ${path}.tmp ${path}`;
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
 * The Computer's self-check (parity row 27).
 *
 * GrokBot runs `box-doctor` at startup and on demand and leaves
 * `[box-doctor] PASS|FAIL <name>: <detail>` lines plus a `SUMMARY` in
 * `/tmp/box-doctor.log`; both are kept here, because the log is what a human
 * reads over a Computer's life and the JSON is what a tool returns for one
 * run. It is a provisioned script rather than a host `service`: a service
 * answers `running|unavailable` and is reattached after a pause, and neither
 * is what a report is.
 *
 * It is read-only by construction — every check reads, none repairs — which is
 * why `computer_doctor` is exempt from recording durable intent.
 *
 * Arguments: the tenant's Bot key, and the Computer's provisioning generation
 * as the host last reported it. Both are optional; a report with generation 0
 * is a report nobody told which Computer it was on.
 */
export const boxDoctorScript = `#!/usr/bin/env bash
set -u
KEY="\${1:-\${FROCKBOT_BOT_KEY:-}}"
GENERATION="\${2:-0}"
case "$GENERATION" in (''|*[!0-9]*) GENERATION=0;; esac
LOG=${DOCTOR_LOG}
NOW=$(date -u +%s)
CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CHECKS=""
PASSED=0
FAILED=0
touch "$LOG" 2>/dev/null || true
# The log outlives every run on it, so it is trimmed at the start of one
# rather than left to grow for the life of the Computer.
if [ -s "$LOG" ]; then
  KEPT=$(tail -n ${DOCTOR_LOG_MAX_LINES} "$LOG" 2>/dev/null || true)
  printf '%s\\n' "$KEPT" > "$LOG" 2>/dev/null || true
fi
record() {
  NAME="$1"
  STATUS="$2"
  DETAIL=$(printf '%s' "$3" | tr -d '"\\\\' | tr '\\n\\t' '  ')
  if [ "$STATUS" = pass ]; then
    PASSED=$((PASSED + 1))
    LABEL=PASS
  else
    FAILED=$((FAILED + 1))
    LABEL=FAIL
  fi
  printf '[box-doctor] %s %s: %s\\n' "$LABEL" "$NAME" "$DETAIL" >> "$LOG" 2>/dev/null || true
  CHECKS="\${CHECKS:+$CHECKS,}$(printf '{"name":"%s","status":"%s","detail":"%s"}' "$NAME" "$STATUS" "$DETAIL")"
}
disk() {
  LINE=$(df -P "$2" 2>/dev/null | tail -n 1 | tr -s ' ')
  if [ -z "$LINE" ]; then
    record "$1" fail "no filesystem is mounted at $2"
    return
  fi
  USED=$(printf '%s' "$LINE" | cut -d' ' -f5 | tr -d '%')
  FREE=$(printf '%s' "$LINE" | cut -d' ' -f4)
  case "$USED" in (''|*[!0-9]*) record "$1" fail "df reported \\"$LINE\\" for $2"; return;; esac
  if [ "$USED" -ge 95 ]; then
    record "$1" fail "$2 is $USED% full, $FREE KiB free"
  else
    record "$1" pass "$2 is $USED% full, $FREE KiB free"
  fi
}
disk disk-root /
disk disk-home ${HOME_ROOT}
# The shared scratch, and the first thing to prune when a disk check fails:
# nothing in it is durable, so nothing in it is lost that was not already
# expendable.
if [ ! -d ${SCRATCH_ROOT} ]; then
  record scratch fail "${SCRATCH_ROOT} is missing; the shared scratch is created at provisioning"
elif [ ! -w ${SCRATCH_ROOT} ]; then
  record scratch fail "${SCRATCH_ROOT} is not writable by $(id -un)"
else
  record scratch pass "${SCRATCH_ROOT} holds $(du -sxm ${SCRATCH_ROOT} 2>/dev/null | cut -f1) MiB of shared scratch, none of it durable"
fi
if (exec 3<>/dev/tcp/127.0.0.1/${DESKTOP_GATEWAY_PORT}) 2>/dev/null; then
  record desktop-gateway pass "the viewer gateway is listening on ${DESKTOP_GATEWAY_PORT}"
else
  record desktop-gateway fail "nothing is listening on ${DESKTOP_GATEWAY_PORT}; no desktop can be viewed"
fi
STAMP=${RUNTIME_ROOT}/sync/.stamp
if pgrep -f watch-workspace.sh >/dev/null 2>&1; then
  if [ -f "$STAMP" ]; then
    record sync-watcher pass "the durable-root watcher is running; its stamp is $((NOW - $(stat -c %Y "$STAMP"))) s old"
  else
    record sync-watcher fail "the durable-root watcher is running but has written no stamp at $STAMP"
  fi
else
  record sync-watcher fail "no durable-root watcher is running; on-Computer writes will not signal a sync"
fi
SLOT=""
if [ -n "$KEY" ] && [ -s ${BOTS_ROOT}/"$KEY"/slot ]; then SLOT=$(cat ${BOTS_ROOT}/"$KEY"/slot); fi
if [ -z "$KEY" ]; then
  record tenant-display pass "no Bot key was named, so no desktop was checked"
elif [ -z "$SLOT" ]; then
  record tenant-display pass "Bot \\"$KEY\\" holds no desktop slot; its exec and file surfaces need no screen"
elif [ ! -e "/tmp/.X$((100 + SLOT))-lock" ]; then
  record tenant-display fail "Bot \\"$KEY\\" holds slot $SLOT but no X server owns display :$((100 + SLOT))"
elif (exec 3<>/dev/tcp/127.0.0.1/$((9222 + SLOT))) 2>/dev/null; then
  record tenant-display pass "Bot \\"$KEY\\" is on display :$((100 + SLOT)) with CDP on $((9222 + SLOT))"
else
  record tenant-display fail "Bot \\"$KEY\\" is on display :$((100 + SLOT)) but nothing answers CDP on $((9222 + SLOT))"
fi
if [ -x ${CHROMIUM_PATH} ]; then
  record browser pass "the browser is installed at ${CHROMIUM_PATH} ($(readlink -f ${CHROMIUM_PATH} 2>/dev/null || echo unresolved))"
else
  record browser fail "no browser at ${CHROMIUM_PATH}; provisioning installs one, and no desktop can start without it"
fi
PROFILE=${HOME_ROOT}/chrome-profile
if [ -d "$PROFILE" ] && [ -w "$PROFILE" ]; then
  record browser-profile pass "the shared browser profile at $PROFILE is writable"
else
  record browser-profile fail "the shared browser profile at $PROFILE is missing or not writable"
fi
SIGNAL=${RUNTIME_ROOT}/sync/signal
CONFLICTS=$(find ${DATA_ROOT} -path '*/.frockbot-sync/conflicts/*' -type f 2>/dev/null | wc -l | tr -d ' ')
if [ ! -f "$SIGNAL" ]; then
  record sync-signal fail "no change signal at $SIGNAL; $CONFLICTS conflicting generation(s) held"
elif [ "$CONFLICTS" -gt 0 ]; then
  record sync-signal fail "$CONFLICTS conflicting generation(s) are held under .frockbot-sync/conflicts and need a human"
else
  record sync-signal pass "signal $(cat "$SIGNAL" 2>/dev/null), last moved $((NOW - $(stat -c %Y "$SIGNAL"))) s ago, no conflicts"
fi
INSTALLED=$(cat ${REFERENCE_ROOT}/.version 2>/dev/null || echo none)
if [ "$INSTALLED" = "${REFERENCE_DOCS_VERSION}" ]; then
  record reference-docs pass "${REFERENCE_ROOT} holds version ${REFERENCE_DOCS_VERSION}"
else
  record reference-docs fail "${REFERENCE_ROOT} holds version $INSTALLED, not ${REFERENCE_DOCS_VERSION}; it refreshes when the Computer is next opened"
fi
MISSING=""
for TOOL in ${CHROME_LAUNCHER} ${COMPUTER_GUI_SHELL_COMMANDS.map((name) => `${SHIMS_ROOT}/${name}`).join(" ")}; do
  [ -x "$TOOL" ] || MISSING="\${MISSING:+$MISSING }$TOOL"
done
if [ -z "$MISSING" ]; then
  record launcher pass "the launcher is installed in ${BIN_ROOT} and ${COMPUTER_GUI_SHELL_COMMANDS.length} shims in ${SHIMS_ROOT}"
else
  record launcher fail "not executable: $MISSING"
fi
if [ "$NOW" -ge ${CLOCK_FLOOR_EPOCH} ]; then
  record clock pass "the clock reads $CAPTURED_AT"
else
  record clock fail "the clock reads $CAPTURED_AT, before this Computer runtime was written"
fi
if getent hosts api.fly.io >/dev/null 2>&1; then
  record dns pass "api.fly.io resolves"
else
  record dns fail "api.fly.io does not resolve; nothing on this Computer can reach the network by name"
fi
# The provisioner holds this Sprite awake with a Tasks-API task, because the
# platform is otherwise free to pause a VM under a detached \`apt-get\`. The
# hold is released on the provisioner's EXIT; one still registered afterwards
# is a Sprite that cannot pause and is billed awake for nothing.
if [ ! -S ${SPRITE_API_SOCKET} ]; then
  record sprite-hold pass "this Computer exposes no Sprite task API, so it holds nothing awake"
elif curl -sS --max-time 5 --unix-socket ${SPRITE_API_SOCKET} http://sprite/v1/tasks 2>/dev/null | grep -q ${PROVISION_TASK}; then
  record sprite-hold fail "the ${PROVISION_TASK} hold is still registered; this Sprite cannot pause"
else
  record sprite-hold pass "no provisioning hold is registered; this Computer is free to pause"
fi
SUMMARY="$((PASSED + FAILED)) checks, $PASSED passed, $FAILED failed"
printf '[box-doctor] SUMMARY %s\\n' "$SUMMARY" >> "$LOG" 2>/dev/null || true
printf '${DOCTOR_MARKER}{"schemaVersion":${DOCTOR_REPORT_SCHEMA_VERSION},"generation":%s,"capturedAt":"%s","checks":[%s],"summary":"%s"}\\n' "$GENERATION" "$CAPTURED_AT" "$CHECKS" "$SUMMARY"
`;

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
  /**
   * Runs every time, marker or no marker.
   *
   * For a phase that is idempotent *and* carries its own reason to run again —
   * the versioned reference set. A phase without this is done once and skipped
   * for ever, which is what makes a half-provisioned Computer resumable.
   */
  always?: boolean;
}[] = [
  {
    name: "layout",
    label: "preparing the Computer layout",
    body: `mkdir -p ${RUNTIME_ROOT} ${RUNTIME_ROOT}/sync ${BOTS_ROOT} ${DATA_ROOT}/agents ${DATA_ROOT}/user-memory ${DATA_ROOT}/user-packages ${BIN_ROOT} ${SHIMS_ROOT} ${REFERENCE_ROOT} ${HOME_ROOT}/chrome-profile ${WORKSPACES_ROOT} ${SCRATCH_ROOT}
touch ${RUNTIME_ROOT}/tokens
chmod 700 ${RUNTIME_ROOT}
chmod 600 ${RUNTIME_ROOT}/tokens
# The shared scratch: group-writable and owned by the Computer's user, because
# every Bot of this User writes here and none of it is durable.
chmod 0775 ${SCRATCH_ROOT}
chown box:box ${SCRATCH_ROOT} 2>/dev/null || true`,
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
${installFile(DOCTOR_SCRIPT, boxDoctorScript)}
${installFile(CHROME_LAUNCHER, chromeLauncherScript)}
${COMPUTER_GUI_SHELL_COMMANDS.map((name) =>
  installFile(`${SHIMS_ROOT}/${name}`, guiShimScript(name)),
).join("\n")}
chmod 700 ${RUNTIME_ROOT}/start-desktop.sh ${ENSURE_AGENT_SCRIPT} ${CONTROL_SCRIPT} ${BOUNDED_LOG_SCRIPT} ${RUNTIME_ROOT}/browser.mjs ${RUNTIME_ROOT}/start-gateway.sh ${RUNTIME_ROOT}/watch-workspace.sh
chmod 755 ${DOCTOR_SCRIPT} ${CHROME_LAUNCHER} ${COMPUTER_GUI_SHELL_COMMANDS.map(
      (name) => `${BIN_ROOT}/${name}`,
    ).join(" ")}`,
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
    // Version-guarded rather than marker-guarded: a marker would make this
    // phase run exactly once in a Computer's life, and the whole point of a
    // versioned reference set is that a later build can correct it.
    always: true,
    body: referenceInstallScript,
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
${
  phase.always
    ? phase.body
    : `if [ ! -f "$MARKERS/${phase.name}" ]; then
${phase.body}
  touch "$MARKERS/${phase.name}"
fi`
}`,
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
  // Read by a Bot's own shell as well as by the provider, so 755 rather than
  // 700: the runtime root is 700 and the tenant runs as the same user, but
  // these are the two files a human debugging the box reaches for.
  { path: DOCTOR_SCRIPT, content: boxDoctorScript, mode: 0o755 },
  { path: CHROME_LAUNCHER, content: chromeLauncherScript, mode: 0o755 },
  ...COMPUTER_GUI_SHELL_COMMANDS.map((name) => ({
    path: `${SHIMS_ROOT}/${name}`,
    content: guiShimScript(name),
    mode: 0o755,
  })),
];

/**
 * The directories an adopted Computer may be missing.
 *
 * They are created with the filesystem API, which takes no mode, so a Computer
 * that gains its shared scratch this way gets the API's default ownership
 * rather than the `0775 box` a fresh provisioning gives it. That is an
 * observable failure state rather than a hidden one: box-doctor's `scratch`
 * check reports a scratch its tenant cannot write, and a reprovisioning fixes
 * it.
 */
export const COMPUTER_REFRESH_DIRECTORIES: readonly string[] = [
  BIN_ROOT,
  SHIMS_ROOT,
  REFERENCE_ROOT,
  SCRATCH_ROOT,
];

/**
 * Everything a Computer provisioned by an earlier build is missing, and that
 * can be installed onto a *running* Computer without disturbing it.
 *
 * Adoption is the short-circuit that makes a container restart a non-event: a
 * Sprite with a state file is adopted and its provisioning document never runs
 * on it again. Without this list, a Computer provisioned last week would never
 * gain this week's self-check, launcher, shims, or reference documents.
 *
 * It is deliberately **not** every runtime file. `start-desktop.sh`,
 * `control.sh`, and the rest may be open in a running process, and the
 * filesystem API writes in place — rewriting a script bash is part-way through
 * reading is how a Computer breaks in a way nobody can reproduce. Those
 * change with a reprovisioning, as they always have. Everything here is a file
 * no running process holds.
 */
export const COMPUTER_REFRESH_FILES: readonly {
  path: string;
  content: string;
  mode: number;
}[] = [
  { path: DOCTOR_SCRIPT, content: boxDoctorScript, mode: 0o755 },
  { path: CHROME_LAUNCHER, content: chromeLauncherScript, mode: 0o755 },
  ...COMPUTER_GUI_SHELL_COMMANDS.map((name) => ({
    path: `${SHIMS_ROOT}/${name}`,
    content: guiShimScript(name),
    mode: 0o755,
  })),
  ...REFERENCE_DOCS.map((document) => ({
    path: `${REFERENCE_ROOT}/${document.name}`,
    content: document.content,
    mode: 0o644,
  })),
  {
    path: `${REFERENCE_ROOT}/.version`,
    content: `${REFERENCE_DOCS_VERSION}\n`,
    mode: 0o644,
  },
];

/** Where a Computer records which refresh it last took. */
export const COMPUTER_REFRESH_STAMP = `${RUNTIME_ROOT}/refresh.version`;

/**
 * A fingerprint of everything above, so the refresh is a single file read on a
 * Computer that is already current.
 *
 * FNV-1a, and a cache key rather than a security primitive: the only question
 * it answers is "are the bytes on that Computer the bytes this build ships",
 * and a caller that guesses wrong reinstalls files it did not need to.
 * Derived rather than declared, so a runtime file cannot be changed without
 * the Computers already out there noticing.
 */
export const COMPUTER_REFRESH_FINGERPRINT = fnv1aHexV1(
  COMPUTER_REFRESH_FILES.map(
    (file) => `${file.path}:${file.mode}:${file.content}`,
  ).join("\u0000"),
);

function fnv1aHexV1(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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

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
/** FrockBot-owned noVNC shell; only noVNC's transport/core is linked into it. */
export const VIEWER_ROOT = `${RUNTIME_ROOT}/viewer`;
export const VIEWER_PAGE = `${VIEWER_ROOT}/index.html`;

/**
 * The lease key a User-wide `desktop-gui` lease is held under.
 *
 * It sits beside the tenant directories rather than inside one, because the
 * desktop it serializes is the box's, not a tenant's: one Computer serves all
 * of a User's Bots and there is one screen on it. The `.` makes it unreachable
 * from `computerBotKeyV1`, whose keys are `[a-z0-9-]+` followed by a hex
 * digest, so no tenant can ever be handed this directory by accident.
 */
export const DESKTOP_GUI_LEASE_KEY = "desktop-gui.lease";
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
/** Gives one Bot its window on the Computer's one screen, and pins it there. */
export const ENSURE_WINDOW_SCRIPT = `${RUNTIME_ROOT}/ensure-window.sh`;
/** Raises one Bot's window, for a human taking the Computer over. */
export const FOCUS_WINDOW_SCRIPT = `${RUNTIME_ROOT}/focus-window.sh`;
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
 * keeps the browser launcher free of the version in its directory name.
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
 * Where the Applets SDK and its runtime are installed (ADR 0022 decision 7).
 *
 * A prefix of its own rather than the runtime root's `node_modules`, because
 * the browser's `playwright-core` and the SDK's `miniflare` are two unrelated
 * dependency trees on two unrelated release cadences, and one `npm install`
 * resolving both would let an Applets upgrade move the browser driver.
 */
export const APPLETS_ROOT = `${RUNTIME_ROOT}/applets`;
/**
 * The `applet` shim on a tenant's PATH.
 *
 * In `bin` rather than `shims`: `shims` holds refusals — the sanctioned-surface
 * shims that decline a GUI command — and this is the opposite, a real command
 * a Bot is meant to run. `bin` leads a tenant's PATH after `shims`
 * (`plugin-fly-sprite/src/computer.ts`, `tenantEnvironment`), so `applet` is
 * reachable by name from the working directory the Bot already has.
 */
export const APPLET_SHIM_PATH = `${BIN_ROOT}/applet`;
/**
 * Written when the SDK install failed, and read by the doctor.
 *
 * `@frockbot/applet-sdk` is not on npm yet. Its install is therefore guarded:
 * a Computer whose SDK could not be fetched is a Computer that still browses,
 * execs, and syncs, so the phase leaves this file and succeeds rather than
 * failing provisioning over a Package that has not shipped. The doctor turns
 * the file into a named check, which is where an unshipped SDK belongs — a
 * reported fact, not a Computer nobody can open.
 */
export const APPLETS_SDK_FAILURE_PATH = `${APPLETS_ROOT}/.sdk-unavailable`;
/**
 * The Applets SDK the Computer authors and previews an Applet with.
 *
 * A dist-tag, not a number: the release workflow stamps every published
 * Package with the tag's version (v0.3.12 published `@frockbot/applet-sdk`
 * as 0.3.12), and this document has no way to learn that version at
 * provisioning time. A pinned "0.1.0" here never existed on npm, so every
 * Computer provisioned before this line was written reported the SDK as
 * unavailable. `latest` follows each release; a Computer installs it once
 * and keeps that tree until it is provisioned again.
 */
export const APPLET_SDK_VERSION = "latest";
/** Pinned with the SDK: `applet dev` embeds this Miniflare, never wrangler. */
export const MINIFLARE_VERSION = "5.20260828.0-alpha";

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
 * A slot is a *region of the one screen* (ADR 0031): an x offset on the
 * Computer's single Xvfb, one browser window pinned over it, and one VNC port
 * clipped to it. There are `DESKTOP_SLOTS` of them, so they are allocated on
 * demand and reclaimed rather than owned for ever. What makes a tenant live is
 * this provider having opened or executed for it recently, or a human holding
 * its takeover lease; nothing on the Computer is evidence, because an
 * exec-only tenant never opens a window at all. The threshold is declared here
 * so a reclaim is a stated policy rather than a guess about who is still using
 * a screen.
 */
export const SLOT_IDLE_SECONDS = 900;
/** Exit code the ensure script uses when every slot belongs to a live tenant. */
export const NO_SLOTS_EXIT = 75;
/** The same refusal, on stdout, for a transport that swallows the exit code. */
export const NO_SLOTS_MARKER = "__FROCKBOT_NO_SLOTS__";

/** The loopback VNC port of slot 0; a slot's port is this plus its number. */
export const VNC_PORT_BASE = 5900;

/**
 * How many Bots of one User can hold a screen region at once (ADR 0031).
 *
 * The Computer runs **one** Xvfb whose width is this many slots, so the number
 * is a real resource bound rather than a policy: a 1280×720 slot costs about
 * 3.5 MiB of framebuffer, and a hundred of them would be a 128 000-pixel-wide
 * root window nobody asked for. Four is the agreed figure; a Computer whose
 * every slot belongs to a live tenant refuses the next one rather than putting
 * two Bots on one screen.
 */
export const DESKTOP_SLOTS = 4;
/** One slot's width in pixels; a slot's x offset is this times its number. */
export const SLOT_WIDTH = 1280;
/** One slot's height. The screen is exactly this tall. */
export const SLOT_HEIGHT = 720;
/** The width of the Computer's single root window. */
export const SCREEN_WIDTH = SLOT_WIDTH * DESKTOP_SLOTS;
/** The one X display on a Computer. Every Bot's window lives on it. */
export const COMPUTER_DISPLAY_NUMBER = 100;
export const COMPUTER_DISPLAY = `:${COMPUTER_DISPLAY_NUMBER}`;
/**
 * The one CDP port on a Computer.
 *
 * There is one browser process, because there is one profile: Chromium's
 * singleton lock is per `--user-data-dir`, so a second launch against
 * `${HOME_ROOT}/chrome-profile` never becomes a second browser — it prints
 * "Opening in existing browser session" and exits, leaving its CDP port dead
 * and its Bot's screen black. That is the defect ADR 0031 records; the model
 * that replaces it is one browser, one port, one window per Bot.
 */
export const COMPUTER_CDP_PORT = 9222;

/** The Computer's single Xvfb and window manager. */
export const SCREEN_SERVICE = "frockbot-screen";
/** The Computer's single Chromium, supervised so a crash comes back. */
export const BROWSER_SERVICE = "frockbot-browser";

/**
 * The prefix of a tenant's own **viewer** service: one `x11vnc`, clipped to
 * that tenant's slot of the shared screen.
 *
 * One service per tenant rather than one for the Computer, because a viewer
 * session is per Bot: the token the gateway resolves addresses this port, and
 * this port shows this slot and nothing else. The prefix is declared because
 * two call sites need the same answer — the host starts these, and the
 * `service` op reattaches them after a cold pause, which it may only do for a
 * Computer-provider-declared name.
 */
export const VIEW_TENANT_SERVICE_PREFIX = "frockbot-view-";

/** The tenant viewer service that `start-view.sh` runs under. */
export function viewServiceNameV1(botKey: string): string {
  return `${VIEW_TENANT_SERVICE_PREFIX}${botKey}`;
}

/**
 * The prefix of the **superseded** per-slot desktop service (ADR 0031).
 *
 * Each of these was an Xvfb, a window manager, a browser launch, and an
 * `x11vnc` for one tenant. Only the first ever got a browser — the rest lost
 * the profile's singleton lock — so the layout is gone. The name stays
 * declared because an existing Computer still has these services registered
 * and the migration has to stop and delete them by name.
 */
export const DESKTOP_TENANT_SERVICE_PREFIX = "frockbot-desktop-";

/** The superseded per-tenant desktop service name. Migration only. */
export function desktopServiceNameV1(botKey: string): string {
  return `${DESKTOP_TENANT_SERVICE_PREFIX}${botKey}`;
}

/**
 * Printed by the attach probe when the tenant's own VNC port already answers.
 *
 * The probe is the whole reason attaching a tenant does not restart anything
 * on every Turn: `createService` is a create-*or-update*, so calling it
 * unconditionally would tear down a running `x11vnc` each time the Computer
 * was opened. A listening VNC port is the one piece of evidence that the
 * viewer behind it is real, which is more than the slot file can say: the slot
 * is an allocation, not a running process.
 */
export const DESKTOP_LIVE_MARKER = "__FROCKBOT_DESKTOP_LIVE__";
/** Printed by the same probe when the Computer's one CDP port answers. */
export const BROWSER_LIVE_MARKER = "__FROCKBOT_BROWSER_LIVE__";
/** Printed by the same probe when this tenant already has a window recorded. */
export const WINDOW_LIVE_MARKER = "__FROCKBOT_WINDOW_LIVE__";
/** Prefix carrying the slot the attach exec already read back to the host. */
export const DESKTOP_SLOT_PREFIX = "__FROCKBOT_DESKTOP_SLOT__";

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
  const match = pattern.exec(shellCommandPositionsV1(command));
  return match?.[1];
}

/**
 * The shell string with its data removed, so only command positions remain.
 *
 * A here-document body and a quoted string are data the shell hands to a
 * program, never a command the shell runs; a TypeScript file written with
 * `cat > ui.tsx <<'EOF'` starts every line with `import`, and a Bot writing
 * one was refused as if it had reached for ImageMagick's `import`. Heredoc
 * bodies and single-quoted strings go entirely; a double-quoted string keeps
 * only its `$(…)` substitutions, which the shell does run.
 */
export function shellCommandPositionsV1(command: string): string {
  // Heredocs: from the operator to the line that is exactly the terminator.
  // The first line stays (the command that owns the heredoc); the body goes.
  const heredoc =
    /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))[^\n]*\n([\s\S]*?)\n[ \t]*\1\2\3[ \t]*(?=\n|$)/g;
  let out = command.replace(heredoc, (_all, a, b, c, _body) => {
    const word = (a ?? b ?? c) as string;
    return `<<${word}\n${word}`;
  });
  // Single quotes: literal data.
  out = out.replace(/'[^']*'/g, "''");
  // Double quotes: data, except a command substitution inside them.
  out = out.replace(/"((?:\\.|[^"\\])*)"/g, (_all, inner: string) => {
    const substitutions = inner.match(/\$\([^)]*\)/g) ?? [];
    return `"${substitutions.join(" ")}"`;
  });
  return out;
}

/** The one browser profile every Bot of one User shares (ADR 0012). */
export const CHROME_PROFILE = `${HOME_ROOT}/chrome-profile`;

/** Maximum Chromium renderer processes on one shared 8 GiB Computer. */
export const CHROMIUM_RENDERER_PROCESS_LIMIT = 8;
/** V8 old-space ceiling in each renderer; native allocations remain possible. */
export const CHROMIUM_MAX_OLD_SPACE_MIB = 1024;
/**
 * Features disabled for a shared unattended desktop.
 *
 * Native window occlusion is meaningless under Xvfb and can stop painting a
 * window that is visible only through VNC. Background timer throttling stays
 * enabled: an unattended preview tab must not earn more CPU merely because a
 * Bot left it open.
 */
export const CHROMIUM_DISABLED_FEATURES = [
  "CalculateNativeWinOcclusion",
] as const;

/** The browser flags the Computer runs chromium under, in one place. */
export const CHROMIUM_FLAGS: readonly string[] = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  `--user-data-dir=${CHROME_PROFILE}`,
  "--remote-debugging-address=127.0.0.1",
  // Not `--start-maximized`: a window belongs to one Bot's slot, and the slot
  // is a region of a screen `DESKTOP_SLOTS` windows wide. Every window is
  // placed by `Browser.setWindowBounds` once it exists; this is only the size
  // the first one opens at.
  `--window-size=${SLOT_WIDTH},${SLOT_HEIGHT}`,
  "--window-position=0,0",
  "--no-first-run",
  "--no-default-browser-check",
  `--renderer-process-limit=${CHROMIUM_RENDERER_PROCESS_LIMIT}`,
  `--js-flags=--max-old-space-size=${CHROMIUM_MAX_OLD_SPACE_MIB}`,
  `--disable-features=${CHROMIUM_DISABLED_FEATURES.join(",")}`,
];

export const CHROME_LAUNCHER = `${BIN_ROOT}/frockbot-chrome`;

/**
 * The single place the Computer's chromium flags live (parity row 33).
 *
 * It takes no Bot key any more (ADR 0031). There is one browser on a Computer
 * because there is one profile, so there is one display and one CDP port to
 * derive: the arithmetic that used to turn a slot into a port is gone, and a
 * slot now only says *where on the screen* a Bot's window sits. `start-browser.sh`
 * calls this, and so may a human debugging the box; nothing else needs to know
 * the flag set exists.
 */
export const chromeLauncherScript = `#!/usr/bin/env bash
set -eu
export DISPLAY=${COMPUTER_DISPLAY}
export ${SANCTIONED_SURFACE_ENV}=1
if [ ! -x ${CHROMIUM_PATH} ]; then
  echo "no browser is installed at ${CHROMIUM_PATH}; the Computer installs one when it is provisioned" >&2
  exit 69
fi
# The singleton files, and never the profile. Chromium's lock is per
# user-data-dir and is left behind by a browser the platform killed rather than
# stopped; a stale one makes the next launch print "Opening in existing browser
# session" and exit. Removed only when no browser is actually running, because
# two Chromiums on one profile is the one thing worse than none.
if ! pgrep -f -- "--remote-debugging-port=${COMPUTER_CDP_PORT}" >/dev/null 2>&1; then
  rm -f ${CHROME_PROFILE}/SingletonLock ${CHROME_PROFILE}/SingletonSocket ${CHROME_PROFILE}/SingletonCookie
fi
# By absolute path, not by name: the browser is Playwright's own build behind a
# stable symlink, and reaching it through PATH would go past the shim that
# covers the name chromium.
exec ${CHROMIUM_PATH} ${CHROMIUM_FLAGS.join(" ")} --remote-debugging-port=${COMPUTER_CDP_PORT} "$@"
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

/** Where fluxbox is told what it may and may not do, on this Computer. */
export const FLUXBOX_ROOT = `${HOME_ROOT}/.fluxbox`;

/**
 * fluxbox's configuration, declared rather than generated.
 *
 * With no `~/.fluxbox` at all, fluxbox writes its own defaults and then
 * applies the default style's background by calling `fbsetbg` — which is not
 * installed, and whose failure is an `xmessage` dialog reading "fbsetbg: I
 * can't find an app to set the wallpaper with" sitting on top of every Bot's
 * screen. `background: none` in the style overlay is the documented way to
 * tell fluxbox not to set a background at all, which is what a screen made
 * entirely of browser windows wants.
 *
 * The toolbar goes for the same reason: the viewer shows a Bot's 1280×720 slot
 * and nothing else, and a window-list bar across the bottom of it is fluxbox's
 * chrome in FrockBot's frame.
 */
export const fluxboxInit = `session.screen0.toolbar.visible: false
session.screen0.slit.autoHide: true
session.screen0.workspaces: 1
session.screen0.workspacewarping: false
session.screen0.defaultDeco: NONE
session.screen0.focusModel: ClickToFocus
session.screen0.tabs.usePixmap: false
session.screen0.fullMaximization: false
session.styleOverlay: ${FLUXBOX_ROOT}/overlay
session.configVersion: 13
`;

/** The style overlay whose one job is to stop fluxbox reaching for fbsetbg. */
export const fluxboxOverlay = `background: none
`;

/**
 * The Computer's one screen: a single Xvfb `DESKTOP_SLOTS` slots wide, and a
 * window manager over it (ADR 0031).
 *
 * One Xvfb per Computer rather than one per slot, because there is one browser
 * per Computer — Chromium's singleton lock is per profile and the profile is
 * the User's — and a browser can only put its windows on the display it was
 * launched under. Each Bot gets a *region* of this screen instead of a display
 * of its own: window pinned by CDP, VNC clipped to the same rectangle.
 */
export const startScreenScript = `#!/usr/bin/env bash
set -eu
# The desktop stack *is* the sanctioned surface, so the shims step aside for
# it. Everything a Bot's own shell runs arrives without this set.
export ${SANCTIONED_SURFACE_ENV}=1
export DISPLAY=${COMPUTER_DISPLAY}
export HOME=${HOME_ROOT}
cleanup() {
  jobs -pr | xargs -r kill >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
rm -f "/tmp/.X${COMPUTER_DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${COMPUTER_DISPLAY_NUMBER}"
Xvfb ${COMPUTER_DISPLAY} -screen 0 ${SCREEN_WIDTH}x${SLOT_HEIGHT}x24 -nolisten tcp &
XVFB_PID=$!
for _ in $(seq 1 100); do xdpyinfo -display ${COMPUTER_DISPLAY} >/dev/null 2>&1 && break; sleep 0.1; done
mkdir -p ${FLUXBOX_ROOT}
fluxbox -rc ${FLUXBOX_ROOT}/init >${RUNTIME_ROOT}/fluxbox.log 2>&1 &
wait "$XVFB_PID"
`;

/**
 * The Computer's one browser, supervised (ADR 0031).
 *
 * Its own service rather than a background job of the screen's, so a Chromium
 * that crashes is restarted by the platform without taking the screen — and
 * every Bot's window — down with it. Each Bot re-creates its window on its
 * next action, which is what `ensure-window.sh` is for.
 */
export const startBrowserScript = `#!/usr/bin/env bash
set -eu
export ${SANCTIONED_SURFACE_ENV}=1
export DISPLAY=${COMPUTER_DISPLAY}
# The screen is a separate service, so this one may start first. Wait for the
# display rather than failing: a service that exits is a service the platform
# restarts, and a browser started before its X server never draws anything.
for _ in $(seq 1 300); do xdpyinfo -display ${COMPUTER_DISPLAY} >/dev/null 2>&1 && break; sleep 0.2; done
if ! xdpyinfo -display ${COMPUTER_DISPLAY} >/dev/null 2>&1; then
  echo "no X server on ${COMPUTER_DISPLAY} after 60s; the ${SCREEN_SERVICE} service is what starts one" >&2
  exit 69
fi
exec ${CHROME_LAUNCHER} about:blank
`;

/** The renderer watchdog, supervised independently of Chromium. */
export const WATCHDOG_SERVICE = "frockbot-browser-watchdog";
/** The installed watchdog executable. */
export const WATCHDOG_SCRIPT = `${RUNTIME_ROOT}/browser-watchdog.sh`;
/** Its bounded, durable-on-the-Computer action log. */
export const WATCHDOG_LOG = `${RUNTIME_ROOT}/watchdog.log`;
/** 1.5 GiB RSS: one renderer may not consume a material fraction of the box. */
export const WATCHDOG_RENDERER_RSS_LIMIT_KIB = 1_572_864;
/** Keep 512 MiB available for the Agent transport and ordinary commands. */
export const WATCHDOG_MEM_AVAILABLE_FLOOR_KIB = 524_288;
/** How often the supervised watchdog samples `/proc`. */
export const WATCHDOG_INTERVAL_SECONDS = 30;
/** Bound the durable diagnostic log without requiring logrotate. */
export const WATCHDOG_LOG_MAX_LINES = 200;

/**
 * Kills only Chromium renderer processes, never the shared browser process.
 *
 * Every renderer over the individual ceiling is killed. Under box-wide
 * pressure, the largest remaining renderers are killed until their reclaimed
 * RSS would restore the available-memory floor. Chromium owns renderer crash
 * recovery, so the browser, profile, and other Bots' windows remain resident.
 */
export const browserWatchdogScript = `#!/usr/bin/env bash
set -u
PROC_ROOT="\${FROCKBOT_WATCHDOG_PROC_ROOT:-/proc}"
LOG="\${FROCKBOT_WATCHDOG_LOG:-${WATCHDOG_LOG}}"
mkdir -p "$(dirname "$LOG")"
touch "$LOG"

trim_log() {
  LINES=$(wc -l < "$LOG" 2>/dev/null || echo 0)
  if [ "$LINES" -gt ${WATCHDOG_LOG_MAX_LINES} ]; then
    tail -n ${WATCHDOG_LOG_MAX_LINES} "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

while true; do
  MEM_AVAILABLE=$(awk '/^MemAvailable:/ { print $2; exit }' "$PROC_ROOT/meminfo" 2>/dev/null || true)
  # If the kernel did not provide a reading, keep enforcing the per-renderer
  # bound but do not infer box-wide pressure and kill otherwise healthy tabs.
  case "$MEM_AVAILABLE" in (''|*[!0-9]*) MEM_AVAILABLE=${WATCHDOG_MEM_AVAILABLE_FLOOR_KIB};; esac
  CANDIDATES=$(
    for STATUS in "$PROC_ROOT"/[0-9]*/status; do
      [ -f "$STATUS" ] || continue
      PID=$(basename "$(dirname "$STATUS")")
      CMDLINE=$(tr '\\000' ' ' < "$(dirname "$STATUS")/cmdline" 2>/dev/null || true)
      printf '%s' "$CMDLINE" | grep -q -- '--type=renderer' || continue
      RSS=$(awk '/^VmRSS:/ { print $2; exit }' "$STATUS" 2>/dev/null || true)
      case "$RSS" in (''|*[!0-9]*) continue;; esac
      printf '%s %s\\n' "$RSS" "$PID"
    done | sort -rn
  )
  PROJECTED_AVAILABLE=$MEM_AVAILABLE
  while read -r RSS PID; do
    [ -n "\${PID:-}" ] || continue
    REASON=""
    if [ "$RSS" -gt ${WATCHDOG_RENDERER_RSS_LIMIT_KIB} ]; then
      REASON=renderer-rss
    elif [ "$PROJECTED_AVAILABLE" -lt ${WATCHDOG_MEM_AVAILABLE_FLOOR_KIB} ]; then
      REASON=low-mem-available
    else
      break
    fi
    if kill -9 "$PID" 2>/dev/null; then
      PROJECTED_AVAILABLE=$((PROJECTED_AVAILABLE + RSS))
      printf '%s action=closed-renderer pid=%s rssMiB=%s memAvailableMiB=%s reason=%s\\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PID" "$((RSS / 1024))" "$((MEM_AVAILABLE / 1024))" "$REASON" >> "$LOG"
    fi
  done <<EOF
$CANDIDATES
EOF
  trim_log
  [ "\${FROCKBOT_WATCHDOG_ONCE:-}" = 1 ] && exit 0
  sleep ${WATCHDOG_INTERVAL_SECONDS}
done
`;

/**
 * One Bot's viewer: an `x11vnc` clipped to that Bot's slot of the one screen.
 *
 * `-clip`, not `-id`: a window id changes every time the Bot's window is
 * re-created, and a VNC server bound to a dead window shows nothing. The
 * rectangle is stable for as long as the Bot holds the slot.
 */
export const startViewScript = `#!/usr/bin/env bash
set -eu
KEY="$1"
ROOT=${RUNTIME_ROOT}
BOT="$ROOT/bots/$KEY"
SLOT=$(cat "$BOT/slot")
VNC_PORT=$((${VNC_PORT_BASE} + SLOT))
CLIP=${SLOT_WIDTH}x${SLOT_HEIGHT}+$((SLOT * ${SLOT_WIDTH}))+0
export ${SANCTIONED_SURFACE_ENV}=1
export DISPLAY=${COMPUTER_DISPLAY}
for _ in $(seq 1 300); do xdpyinfo -display ${COMPUTER_DISPLAY} >/dev/null 2>&1 && break; sleep 0.2; done
if ! xdpyinfo -display ${COMPUTER_DISPLAY} >/dev/null 2>&1; then
  echo "no X server on ${COMPUTER_DISPLAY} after 60s; the ${SCREEN_SERVICE} service is what starts one" >&2
  exit 69
fi
exec x11vnc -display ${COMPUTER_DISPLAY} -clip "$CLIP" -forever -shared -rfbport "$VNC_PORT" -passwd "$(cat "$BOT/vnc-password")"
`;

/** What `ensure-window.sh` asks `browser.mjs`, base64url as it takes it. */
export const BROWSER_ENSURE_ACTION = "eyJhY3Rpb24iOiJlbnN1cmUifQ";
/** What `focus-window.sh` asks it, when a human takes this Computer over. */
export const BROWSER_FOCUS_ACTION = "eyJhY3Rpb24iOiJmb2N1cyJ9";
/** What box-doctor asks it, to report every tenant's window at once. */
export const BROWSER_SURVEY_ACTION = "eyJhY3Rpb24iOiJzdXJ2ZXkifQ";

/** Where the Bot's own browser window is recorded, under its Bot directory. */
export const TARGET_ID_FILE = "target-id";

/**
 * Gives one Bot its window on the shared screen, and pins it to its slot.
 *
 * Idempotent by construction: it re-uses the recorded target when that target
 * is still a live page and creates a new window when it is not, so a browser
 * that crashed and came back costs one window per Bot on their next action and
 * nothing else.
 */
export const ensureWindowScript = `#!/usr/bin/env bash
set -eu
KEY="$1"
export ${SANCTIONED_SURFACE_ENV}=1
exec timeout 30 node ${RUNTIME_ROOT}/browser.mjs ${COMPUTER_CDP_PORT} ${BROWSER_ENSURE_ACTION} "$KEY"
`;

/**
 * Brings one Bot's window to the front, for a human taking the Computer over.
 *
 * Best effort and non-fatal: a takeover whose window could not be raised is a
 * takeover of a screen showing the wrong Bot, which is worth reporting and is
 * not worth refusing the lease over.
 */
export const focusWindowScript = `#!/usr/bin/env bash
set -eu
KEY="$1"
export ${SANCTIONED_SURFACE_ENV}=1
exec timeout 20 node ${RUNTIME_ROOT}/browser.mjs ${COMPUTER_CDP_PORT} ${BROWSER_FOCUS_ACTION} "$KEY"
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
# Slots allocated under the superseded hundred-display layout (ADR 0031) cannot
# be shown on the one screen: it has ${DESKTOP_SLOTS} rectangles on it, and a
# window pinned past the last of them is a window nobody can see behind a clip
# x11vnc refuses. Pruned under the same lock that allocates, so a migrated
# Computer re-allocates in range on the tenant's next open. Only the
# provider-owned registry files go; nothing durable, and never the profile.
for SLOT_FILE in "$ROOT"/bots/*/slot; do
  [ -s "$SLOT_FILE" ] || continue
  SLOT_VALUE=$(cat "$SLOT_FILE")
  SLOT_BOT=$(dirname "$SLOT_FILE")
  case "$SLOT_VALUE" in
    (''|*[!0-9]*) rm -f "$SLOT_FILE" "$SLOT_BOT/${TARGET_ID_FILE}" "$SLOT_BOT/cdp-port"; continue;;
  esac
  if [ "$SLOT_VALUE" -ge ${DESKTOP_SLOTS} ]; then
    rm -f "$SLOT_FILE" "$SLOT_BOT/${TARGET_ID_FILE}" "$SLOT_BOT/cdp-port"
  fi
done
if [ ! -s "$BOT/slot" ]; then
  # Every slot in use, read once. The registry lock is held, so the answer
  # cannot change under this scan, and one read beats one per slot per tenant
  # when a Computer is close to full.
  USED=" $(cat "$ROOT"/bots/*/slot 2>/dev/null | tr '\n' ' ') "
  SLOT=0
  while [ "$SLOT" -lt ${DESKTOP_SLOTS} ]; do
    case "$USED" in (*" $SLOT "*) ;; (*) break ;; esac
    SLOT=$((SLOT + 1))
  done
  if [ "$SLOT" -ge ${DESKTOP_SLOTS} ]; then
    # A slot is a region of the one screen, not durable state: it is the x
    # offset a tenant's browser window is pinned at and the VNC port clipped to
    # it. A tenant that never comes back would otherwise hold one for ever, so
    # the allocation is bounded rather than permanent.
    #
    # Liveness is decided by the provider's own registry, never by the
    # Computer's state: "last-seen" is written by the backend every time it
    # opens or runs anything for a tenant, and "human-control" is the takeover
    # lease. A window proves nothing — the browser is restarted under every
    # tenant at once, and a tenant that only ever execs never opens one — so a
    # slot is reclaimed only when its tenant has been idle past the threshold
    # AND no viewer lease is fresh. Its viewer token goes with the slot, or
    # that token would address another Bot's screen. When every slot belongs to
    # a live tenant the new tenant is refused: sharing a display would put two
    # Bots on one screen, which is worse than an unavailable desktop.
    NOW=$(date +%s)
    DESKTOP_LEASE="$ROOT/bots/${DESKTOP_GUI_LEASE_KEY}/human-control"
    DESKTOP_LEASE_FRESH=0
    if [ -f "$DESKTOP_LEASE" ]; then
      DESKTOP_LEASED=$(stat -c %Y "$DESKTOP_LEASE")
      if [ $((NOW - DESKTOP_LEASED)) -le ${LEASE_MAX_AGE_SECONDS} ]; then
        DESKTOP_LEASE_FRESH=1
      fi
    fi
    VICTIM=""
    # Human takeover and computerUse hold the User-wide screen. Reclaiming
    # any tenant's display while that lease is fresh would replace the screen
    # underneath its holder, even when another Bot owned the slot. Avoid the
    # whole per-tenant scan in that case: no candidate can be eligible.
    if [ "$DESKTOP_LEASE_FRESH" -ne 1 ]; then
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
    fi
    if [ -z "$VICTIM" ]; then
      # Said both ways: the exit code is for a caller that gets one, and
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
    # The window goes with the slot: the next holder of this rectangle must
    # not inherit a target id addressing the previous tenant's window.
    rm -f "$VICTIM" "$VICTIM_BOT/cdp-port" "$VICTIM_BOT/${TARGET_ID_FILE}"
  fi
  printf '%s\n' "$SLOT" > "$BOT/slot"
fi
# Marks this tenant as the most recent holder of its slot, which is the order
# the reclaim above walks, and records that the provider has just opened it —
# the registry entry the reclaim reads to decide whether a tenant is live.
touch "$BOT/slot" "$BOT/last-seen"
SLOT=$(cat "$BOT/slot")
# One browser on this Computer, so one port for every tenant. The file stays
# because callers read it rather than deriving a port of their own.
printf '%s\n' "${COMPUTER_CDP_PORT}" > "$BOT/cdp-port"
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
printf '%s: 127.0.0.1:%s\n' "$TOKEN" "$((${VNC_PORT_BASE} + SLOT))" >> "$TMP"
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
  ACTION="$1"
  KEY="$2"
  BOT=${BOTS_ROOT}/$KEY
  mkdir -p "$BOT"
  if [ "$ACTION" = "assert-agent" ]; then
    DESKTOP_KEY="$3"
    DESKTOP=${BOTS_ROOT}/$DESKTOP_KEY
    mkdir -p "$DESKTOP"
    # Every guarded command reads two independently writable leases. Taking
    # the shared lock first keeps their check in one fixed order and prevents
    # an acquire from changing the desktop lease midway through the snapshot.
    exec flock -x "$DESKTOP/control.lock" flock -x "$BOT/control.lock" "$0" --locked "$@"
  fi
  exec flock -x "$BOT/control.lock" "$0" --locked "$@"
fi
shift
ACTION="$1"
KEY="$2"
BOT=${BOTS_ROOT}/$KEY
LEASE="$BOT/human-control"
if [ "$ACTION" = "assert-agent" ]; then
  DESKTOP_KEY="$3"
  OWNER="$4"
  MAX_AGE="$5"
else
  OWNER="$3"
  MAX_AGE="$4"
fi
current_owner() { sed -n '1p' "$1" 2>/dev/null || true; }
is_fresh() {
  CANDIDATE="$1"
  [ -e "$CANDIDATE" ] || return 1
  NOW=$(date +%s)
  CHANGED=$(stat -c %Y "$CANDIDATE")
  [ $((NOW - CHANGED)) -le "$MAX_AGE" ]
}
assert_available() {
  CANDIDATE="$1"
  EXISTING=$(current_owner "$CANDIDATE")
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "$OWNER" ]; then
    if is_fresh "$CANDIDATE"; then echo "This Computer's control lease is held by $EXISTING" >&2; exit 73; fi
    rm -f "$CANDIDATE"
  fi
}
case "$ACTION" in
  assert-agent)
    assert_available "$LEASE"
    assert_available "${BOTS_ROOT}/$DESKTOP_KEY/human-control"
    ;;
  acquire)
    EXISTING=$(current_owner "$LEASE")
    if [ "$EXISTING" = "$OWNER" ]; then touch "$LEASE"; exit 0; fi
    # The refusal names the holder: "busy" is not something a caller can act on
    # and "held by <owner>" is — the owner is the task id a computerUse
    # dispatch leased the desktop under.
    if [ -n "$EXISTING" ] && is_fresh "$LEASE"; then echo "This Computer's control lease is held by $EXISTING" >&2; exit 73; fi
    TMP=$(mktemp "$BOT/human-control.XXXXXX")
    printf '%s\n' "$OWNER" > "$TMP"
    chmod 600 "$TMP"
    mv "$TMP" "$LEASE"
    ;;
  renew)
    [ "$(current_owner "$LEASE")" = "$OWNER" ] || { echo "Human control lease owner changed" >&2; exit 73; }
    touch "$LEASE"
    ;;
  release)
    if [ "$(current_owner "$LEASE")" = "$OWNER" ]; then rm -f "$LEASE"; fi
    ;;
  *) echo "unknown control action" >&2; exit 64;;
esac
`;

/**
 * The one program that drives this Computer's browser (ADR 0031).
 *
 * There is one Chromium and one CDP port, and each Bot owns one *window* on
 * it. The window is recorded at `<bot>/target-id` and re-created when it is
 * gone, so a browser that crashed costs each Bot one new window and nothing
 * else. A Bot may open as many tabs inside its own window as it likes; this
 * program never touches a target belonging to another Bot's window.
 *
 * Isolation between two Bots of one User is therefore weaker than it looks:
 * one profile, one CDP port, one process. That is the trade ADR 0031 records —
 * the requirement is that a login one Bot makes is a login all of them have —
 * and the sanctioned-surface shims remain the line of defence.
 */
export const browserHelper = `import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const BOTS_ROOT = "${BOTS_ROOT}";
const TARGET_ID_FILE = "${TARGET_ID_FILE}";
const SLOT_WIDTH = ${SLOT_WIDTH};
const SLOT_HEIGHT = ${SLOT_HEIGHT};

const port = Number(process.argv[2]);
const action = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
const botKey = process.argv[4] ?? "";

const botDir = (key) => \`\${BOTS_ROOT}/\${key}\`;
const targetPath = (key) => \`\${botDir(key)}/\${TARGET_ID_FILE}\`;

function slotOf(key) {
  const raw = readFileSync(\`\${botDir(key)}/slot\`, "utf8").trim();
  if (!/^\\d+$/.test(raw)) throw new Error(\`Bot "\${key}" holds no desktop slot\`);
  return Number(raw);
}

function recordedTarget(key) {
  try {
    return readFileSync(targetPath(key), "utf8").trim();
  } catch {
    return "";
  }
}

function boundsFor(slot) {
  return { left: slot * SLOT_WIDTH, top: 0, width: SLOT_WIDTH, height: SLOT_HEIGHT, windowState: "normal" };
}

function placed(bounds, slot) {
  const want = boundsFor(slot);
  return Boolean(bounds) && bounds.left === want.left && bounds.top === want.top && bounds.width === want.width && bounds.height === want.height;
}

const browser = await chromium.connectOverCDP(\`http://127.0.0.1:\${port}\`);
const cdp = await browser.newBrowserCDPSession();

async function pageTargets() {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.filter((info) => info.type === "page");
}

/** The Bot's own window: the recorded one when it is alive, a new one when not. */
async function ensureWindow(key) {
  const slot = slotOf(key);
  let targetId = recordedTarget(key);
  if (!targetId || !(await pageTargets()).some((info) => info.targetId === targetId)) {
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true }));
    mkdirSync(botDir(key), { recursive: true });
    writeFileSync(targetPath(key), \`\${targetId}\\n\`, { mode: 0o600 });
  }
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: boundsFor(slot) });
  return { targetId, windowId, slot };
}

/** The Playwright page for one target id, waited for: CDP creates it, Playwright discovers it. */
async function pageFor(targetId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        if ((await targetIdOf(context, candidate)) === targetId) return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function targetIdOf(context, page) {
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach().catch(() => {});
  return targetInfo.targetId;
}

/** Every page in the Bot's own window. Tabs it opened there are its own. */
async function pagesInWindow(windowId) {
  const own = [];
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      const targetId = await targetIdOf(context, candidate);
      const window = await cdp
        .send("Browser.getWindowForTarget", { targetId })
        .catch(() => undefined);
      if (window && window.windowId === windowId) own.push(candidate);
    }
  }
  return own;
}

async function done(value) {
  if (value !== undefined) console.log(JSON.stringify(value));
  await browser.close();
  process.exit(0);
}

// box-doctor's whole-Computer view (ADR 0031): every tenant that holds a slot,
// whether its window exists, and whether it sits over its own slot. One CDP
// connection for the Computer rather than one probe per Bot.
if (action.action === "survey") {
  const infos = await pageTargets();
  const rows = [];
  for (const entry of readdirSync(BOTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let slot;
    try {
      slot = slotOf(entry.name);
    } catch {
      continue;
    }
    const targetId = recordedTarget(entry.name);
    const alive = Boolean(targetId) && infos.some((info) => info.targetId === targetId);
    let bounds;
    if (alive) {
      const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
      ({ bounds } = await cdp.send("Browser.getWindowBounds", { windowId }));
    }
    rows.push({ key: entry.name, slot, targetId, alive, placed: alive && placed(bounds, slot) });
  }
  await done({ tenants: rows.sort((left, right) => left.slot - right.slot) });
}

// The Bot's window, created and pinned, and nothing else. What an open runs.
if (action.action === "ensure") {
  await done(await ensureWindow(botKey));
}

const anchor = botKey ? await ensureWindow(botKey) : undefined;

// A human is taking this Computer over: raise the Bot's window so the screen
// they are handed is the Bot's, not whichever window Chromium last focused.
if (action.action === "focus") {
  const focusPage = anchor ? await pageFor(anchor.targetId) : undefined;
  if (focusPage) await focusPage.bringToFront();
  await done({ focused: Boolean(focusPage), ...(anchor ? { targetId: anchor.targetId } : {}) });
}

// Lifecycle cleanup from the Computer Package. Origins come from a preview
// process's own bounded log and the action is already scoped to this Bot, but
// enforce the window boundary again here: a shared browser profile never
// makes another Bot's tab ours to close. If the recorded anchor was one of the
// closed pages, adopt a surviving tab in the same window; only create a blank
// replacement when the window has no page left.
if (action.action === "close-origins") {
  const origins = new Set(action.origins);
  const candidates = anchor ? await pagesInWindow(anchor.windowId) : [];
  let closed = 0;
  for (const candidate of candidates) {
    let origin = "";
    try {
      origin = new URL(candidate.url()).origin;
    } catch {}
    if (!origins.has(origin)) continue;
    await candidate.close();
    closed += 1;
  }
  const remaining = anchor ? await pagesInWindow(anchor.windowId) : [];
  if (remaining.length > 0) {
    const targetId = await targetIdOf(remaining.at(-1));
    writeFileSync(targetPath(botKey), \`\${targetId}\\n\`, { mode: 0o600 });
  } else if (anchor) {
    await ensureWindow(botKey);
  }
  await done({ closed, origins: [...origins], snapshot: "" });
}

const own = anchor ? await pagesInWindow(anchor.windowId) : [];
const page =
  own.at(-1) ??
  (anchor ? await pageFor(anchor.targetId) : undefined) ??
  browser.contexts()[0]?.pages().at(-1);
if (!page) {
  console.error("this Computer's browser has no page for this Bot");
  await browser.close();
  process.exit(69);
}
// box-doctor's browser-identity measurement (parity row 34b). It answers
// before any navigation and before the snapshot, so the check reads what the
// browser presents without moving the page a human or a Bot left open.
if (action.action === "identity") {
  const identity = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver === true,
    brands: (navigator.userAgentData?.brands ?? []).map((brand) => \`\${brand.brand}/\${brand.version}\`),
  }));
  await done(identity);
}
if (action.action === "navigate") await page.goto(action.url, { waitUntil: "domcontentloaded" });
if (action.action === "click") await page.getByRole(action.role, { name: action.name, exact: action.exact ?? false }).click();
if (action.action === "fill") await page.getByLabel(action.label, { exact: action.exact ?? false }).fill(action.text);
if (action.action === "press") await page.keyboard.press(action.key);
if (action.action === "wait") await page.waitForTimeout(action.milliseconds ?? 1000);
const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10000 });
await done({ url: page.url(), title: await page.title(), snapshot });
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

/**
 * The hosted Computer viewer, without stock noVNC application chrome.
 *
 * The Sprite image's Ubuntu 25.10 package installs noVNC 1.6.0 under
 * `/usr/share/novnc`. Its `ui.js`
 * reads `view_only` while constructing RFB and only reapplies it from its own
 * settings control; changing an iframe's fragment therefore left the existing
 * connection view-only. This page owns the presentation, imports only RFB,
 * and treats the fragment as live state so P2's second-click takeover keeps
 * one socket and one secret-bearing URL.
 */
export const viewerPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>FrockBot Computer</title>
    <style>
      :root { color-scheme: dark; background: #0a0d12; }
      * { box-sizing: border-box; }
      html, body, #screen { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      body { background: #0a0d12; }
      #screen, #screen * { touch-action: none; }
      #screen.view-only { pointer-events: none; }
      #screen.view-only, #screen.view-only * { cursor: none !important; }
      #status {
        position: fixed;
        z-index: 2;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        color: #dce5f2;
        background: #0a0d12;
        font: 500 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: center;
      }
      #status[data-state="connected"] { display: none; }
      #status[data-state="error"] { color: #ffb4b4; }
    </style>
  </head>
  <body>
    <div id="screen" class="view-only" aria-label="Computer desktop, view only"></div>
    <div id="status" role="status" aria-live="polite">Connecting to desktop…</div>
    <script type="module">
      import RFB from "./core/rfb.js";

      const screen = document.getElementById("screen");
      const status = document.getElementById("status");
      let rfb;
      let reconnectTimer;

      function parameters() {
        return new URLSearchParams(window.location.hash.slice(1));
      }

      function enabled(name, fallback) {
        const value = parameters().get(name);
        if (value === null) return fallback;
        return value === "1" || value === "true";
      }

      function publish(state, message) {
        status.dataset.state = state;
        status.textContent = message;
        window.parent.postMessage(
          { type: "frockbot-viewer", state: state, message: message },
          "*",
        );
      }

      function applyMode() {
        const viewOnly = enabled("view_only", true);
        screen.classList.toggle("view-only", viewOnly);
        screen.setAttribute(
          "aria-label",
          viewOnly ? "Computer desktop, view only" : "Computer desktop, control enabled",
        );
        if (!rfb) return;
        rfb.viewOnly = viewOnly;
        rfb.showDotCursor = false;
      }

      function socketUrl(path) {
        const url = new URL(path, window.location.href);
        url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        url.hash = "";
        return url.href;
      }

      function connect() {
        window.clearTimeout(reconnectTimer);
        publish("connecting", "Connecting to desktop…");
        const config = parameters();
        try {
          rfb = new RFB(
            screen,
            socketUrl(config.get("path") || "websockify"),
            {
              credentials: { password: config.get("password") || "" },
              shared: true,
            },
          );
          rfb.scaleViewport = config.get("resize") === "scale";
          rfb.resizeSession = config.get("resize") === "remote";
          rfb.showDotCursor = false;
          applyMode();
          rfb.addEventListener("connect", () => {
            publish("connected", "Desktop connected");
          });
          rfb.addEventListener("disconnect", (event) => {
            rfb = undefined;
            if (enabled("reconnect", true)) {
              publish("reconnecting", "Reconnecting…");
              reconnectTimer = window.setTimeout(connect, 1000);
              return;
            }
            publish(
              "error",
              event.detail && event.detail.clean
                ? "Desktop disconnected"
                : "Desktop connection failed",
            );
          });
          rfb.addEventListener("securityfailure", () => {
            publish("error", "Desktop authentication failed");
          });
        } catch {
          rfb = undefined;
          publish("error", "Desktop connection failed");
        }
      }

      window.addEventListener("hashchange", applyMode);
      connect();
    </script>
  </body>
</html>
`;

/** The port the noVNC gateway serves on, and the port box-doctor probes. */
export const DESKTOP_GATEWAY_PORT = 6080;

export const gatewayScript = `#!/usr/bin/env bash
set -eu
exec websockify --web=${VIEWER_ROOT} --token-plugin TokenFile --token-source=${RUNTIME_ROOT}/tokens ${DESKTOP_GATEWAY_PORT}
`;

/** Where box-doctor is installed, and the log a human reads it back from. */
export const DOCTOR_SCRIPT = `${RUNTIME_ROOT}/box-doctor.sh`;
/** GrokBot's path, kept: `/tmp/box-doctor.log` (`grokbot-computer.md:396`). */
export const DOCTOR_LOG = "/tmp/box-doctor.log";
/** Prefixes the one line of the run that is the machine-readable report. */
export const DOCTOR_MARKER = "__FROCKBOT_DOCTOR__";
/**
 * The report schema box-doctor prints. Bumped, never migrated.
 *
 * 2 adds `browserIdentity` (parity row 34b). A Computer provisioned before
 * this bump prints 1, which the decoder refuses — deliberately: the script is
 * reinstalled on the next open, and a half-read report is worse than a
 * Computer that says it has nothing to say yet.
 */
export const DOCTOR_REPORT_SCHEMA_VERSION = 2;

/**
 * What box-doctor asks the browser, base64url as `browser.mjs` takes it.
 *
 * A literal rather than an encode at module load: this module builds shell
 * documents in a Worker, where `Buffer` is not a given, and the encoding is
 * asserted against the decode in `runtime.test.ts`.
 */
export const DOCTOR_BROWSER_IDENTITY_ACTION = "eyJhY3Rpb24iOiJpZGVudGl0eSJ9";
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
export const REFERENCE_DOCS_VERSION = "2026-09-05.1";

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
your own window on its one screen; the browser and its profile are shared, so a
login one Bot makes is a login all of them have.

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

## Applets — written here, run somewhere else

Applet source is a durable root like any other:
\`${DATA_ROOT}/user-packages/applets/source/<appletId>/\`. Write it with the
ordinary file tools, then use \`applet\` — it is on your PATH:

| Command | What |
|---|---|
| \`applet check\` | type-check and lint one Applet |
| \`applet build\` | write \`<appletId>/dist/\` — this is what a publish reads |
| \`applet dev\` | run it locally on this Computer and print a URL to open in the browser |

The SDK and its runtime live under \`${APPLETS_ROOT}\`, installed when this
Computer was provisioned and repaired by a runtime update when missing. Applet
projects have no durable \`node_modules\`: dependency, cache, VCS, and ordinary
build directories are excluded from Workspace sync, and the SDK resolves
imports from this shared installation. The three files a publish explicitly
requests from \`dist/\` are the only build-output exception. An Applet **never
runs for real here**: \`applet dev\` is a preview, and publishing hands the
built artifact to the kernel, which runs it. If \`applet\` says the SDK is not
installed, run the self-check and read the \`applets-sdk\` line.
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

## One browser, one window each

There is exactly one browser process on this Computer, because there is one
profile: Chromium's lock is per profile, and a second launch against it is not
a second browser. Each Bot gets one **window** on that browser, pinned over its
own slot of the one screen.

- Tabs you open inside your own window are yours; use as many as you like.
- A login one Bot makes is a login every Bot has, the instant it is made — the
  cookie jar is the profile, and the profile is shared.
- Other Bots' windows are not yours to drive, read, or close. Nothing stops
  you at the CDP layer; this is a rule, not a wall.
- If your window is gone — the browser crashed and came back — the next
  \`computer_browser\` action opens you a new one.

## Launching it

\`${CHROME_LAUNCHER}\` is the only sanctioned launcher. It takes no Bot key any
more: it holds the flag set and starts the Computer's one browser on the one
display and the one CDP port. The \`${BROWSER_SERVICE}\` service calls it, and
nothing else needs to know the flags exist.

The launcher limits Chromium to ${CHROMIUM_RENDERER_PROCESS_LIMIT} renderer
processes and caps each renderer's V8 old space at
${CHROMIUM_MAX_OLD_SPACE_MIB} MiB. It disables only
\`${CHROMIUM_DISABLED_FEATURES.join(",")}\`; background-tab timer throttling
remains enabled. Native allocations can still exceed V8's heap ceiling, so
the separately supervised \`${WATCHDOG_SERVICE}\` samples memory every
${WATCHDOG_INTERVAL_SECONDS} seconds. It closes a renderer above 1.5 GiB RSS,
or the largest renderer when the Computer has less than 512 MiB available,
and records the action in \`${WATCHDOG_LOG}\`.

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
gateway, the durable-root watcher, the shared screen, the one browser process
and its CDP port, the renderer watchdog's recent actions, the top memory
consumers, every Bot's window and whether it sits over that Bot's own
slot, the browser build and its profile, the sync signal and any conflicting
generations, this reference
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
- **tenant-display-<botKey>** — that Bot has no window on the screen, or its
  window is not over its own slot. A window comes back on that Bot's next
  browser action. Slots are allocated on demand, and a Computer with all of
  them in use will say so.
- **browser-process** — none, or more than one. One is the whole design: the
  profile's lock admits exactly one browser, and a second one is a Bot with a
  black screen.
- **watchdog** — the renderer memory guard is not running. Its last actions
  remain in \`${WATCHDOG_LOG}\`; opening the Computer repairs its supervised
  service.
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

\`${DOCTOR_LOG}\`, \`${WATCHDOG_LOG}\`, and per-Bot under \`${BOTS_ROOT}/<botKey>\`:
\`chromium.log\`, \`fluxbox.log\`, \`x11vnc.log\`, and \`processes/<id>/log.*\`.
Provisioning's own log is \`${RUNTIME_ROOT}/provision/provision.log\`.
`,
  },
];

/** Files the reference phase owns, in the order it installs them. */
export const REFERENCE_RUNTIME_FILES: readonly {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}[] = [
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

const referenceFilesInstallScript = `mkdir -p ${REFERENCE_ROOT}
${installDeclaredFiles(REFERENCE_RUNTIME_FILES)}`;

/**
 * Rewrites the shipped reference set when its version has moved.
 *
 * Guarded by the version file and by nothing else, so it is safe to run on
 * every adoption: an up-to-date Computer costs one `cat`. The write is a
 * rename, so a Bot reading a document never sees half of one.
 */
export const referenceInstallScript = `mkdir -p ${REFERENCE_ROOT}
if [ "$(cat ${REFERENCE_ROOT}/.version 2>/dev/null || true)" != ${shellQuote(REFERENCE_DOCS_VERSION)} ]; then
${referenceFilesInstallScript
  .split("\n")
  .slice(1)
  .map((line) => `  ${line}`)
  .join("\n")}
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
/** The sha-256 of the runtime document this Computer last completed. */
export const PROVISION_DIGEST = `${PROVISION_ROOT}/digest`;
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
 * `applet` on a tenant's PATH (ADR 0022 decision 7).
 *
 * A shim rather than a symlink, for the same reason every other node entry
 * point here is: `/.sprite/bin/node` is a bash re-exec shim whose last resort
 * is `command -v node`, which in a non-login shell finds the shim again and
 * loops for ever. The preamble puts the real toolchain on PATH first, so the
 * SDK's own `#!/usr/bin/env node` resolves to a binary.
 *
 * A missing SDK is a sentence, not a stack trace: the install is guarded (see
 * {@link APPLETS_SDK_FAILURE_PATH}), so this is the state a Bot will meet
 * until `@frockbot/applet-sdk` is published, and it says where to look.
 */
export const appletShimScript = `#!/usr/bin/env bash
set -u
${provisionPathPreamble}
APPLET=${APPLETS_ROOT}/node_modules/.bin/applet
if [ ! -x "$APPLET" ]; then
  echo "the Applets SDK is not installed at ${APPLETS_ROOT}; run computer_doctor and read the applets-sdk check" >&2
  exit 127
fi
exec "$APPLET" "$@"
`;

/**
 * Installs the Applets SDK when it is absent and verifies its shared imports.
 *
 * Guarded, and deliberately not fatal: a Computer that cannot fetch the SDK
 * is still a Computer — it browses, execs, and syncs — so the failure is
 * recorded as a file the doctor reports under `applets-sdk` rather than as a
 * phase that fails and leaves the whole run resumable-but-unfinished.
 *
 * The React fallback repairs SDK releases published before those build-time
 * dependencies moved from development/peer metadata into dependencies. It is
 * idempotent and runs only when Node cannot resolve `react-dom/client` from
 * the shared prefix. The final probe covers React, React DOM, and the SDK's
 * client entry; its concise failure is durable input to box-doctor.
 *
 * Changing this script changes the runtime document digest, which is the
 * version marker that causes every existing Computer to run UPDATE_PHASES on
 * its next open.
 */
export const appletSdkInstallScript = `if [ ! -d ${APPLETS_ROOT}/node_modules/@frockbot/applet-sdk ]; then
  if npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund @frockbot/applet-sdk@${APPLET_SDK_VERSION}; then
    rm -f ${APPLETS_SDK_FAILURE_PATH}
  else
    printf '%s\\n' "npm could not install @frockbot/applet-sdk@${APPLET_SDK_VERSION}" > ${APPLETS_SDK_FAILURE_PATH}
  fi
fi
if [ -d ${APPLETS_ROOT}/node_modules/@frockbot/applet-sdk ]; then
  if ! (cd ${APPLETS_ROOT} && node -e "require.resolve('react-dom/client')") >/dev/null 2>&1; then
    npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund react@19.2.8 react-dom@19.2.8 @types/react@19.2.18 @types/react-dom@19.2.4 || true
  fi
  if SDK_RESOLUTION_ERROR=$(cd ${APPLETS_ROOT} && node -e "for (const id of ['react-dom/client', 'react', '@frockbot/applet-sdk/client']) { try { require.resolve(id) } catch { console.error('could not resolve ' + id); process.exitCode = 1 } }" 2>&1); then
    rm -f ${APPLETS_SDK_FAILURE_PATH}
  else
    printf '%s\\n' "Applets SDK dependency resolution failed: $SDK_RESOLUTION_ERROR" > ${APPLETS_SDK_FAILURE_PATH}
  fi
fi`;

/** The files the `applets` phase installs, with their modes. */
export const APPLETS_RUNTIME_FILES: readonly {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}[] = [{ path: APPLET_SHIM_PATH, content: appletShimScript, mode: 0o755 }];

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
WATCHDOG_ACTIONS=$(tail -n 5 ${WATCHDOG_LOG} 2>/dev/null | tr '\n' ';' || true)
if pgrep -f -- ${WATCHDOG_SCRIPT} >/dev/null 2>&1; then
  record watchdog pass "the renderer watchdog is running; recent actions: \${WATCHDOG_ACTIONS:-none}"
else
  record watchdog fail "the renderer watchdog is not running; recent actions: \${WATCHDOG_ACTIONS:-none}"
fi
TOP_MEMORY=$(ps -eo pid=,rss=,comm= --sort=-rss 2>/dev/null | head -n 5 | tr '\n' ';' || true)
record memory-top pass "top resident-memory consumers (pid rssKiB command): \${TOP_MEMORY:-unavailable}"
SLOT=""
if [ -n "$KEY" ] && [ -s ${BOTS_ROOT}/"$KEY"/slot ]; then SLOT=$(cat ${BOTS_ROOT}/"$KEY"/slot); fi
# One browser, one CDP port (ADR 0031). A second main process would mean a
# second browser holding — or failing to hold — the one shared profile, which
# is the defect this layout replaced: the loser prints "Opening in existing
# browser session", exits, and leaves its Bot a black screen.
BROWSERS=$(pgrep -af -- "--user-data-dir=${CHROME_PROFILE.replace("/", "[/]")}" 2>/dev/null | awk -v self="$$" -v parent="$PPID" '$1 != self && $1 != parent && $0 ~ /(^|\\/)chrom(e|ium)( |$)/ && $0 !~ /(^|[[:space:]])--type=/ { count++ } END { print count + 0 }')
if [ "$BROWSERS" = 1 ]; then
  record browser-process pass "exactly one browser process holds ${CHROME_PROFILE}"
elif [ "$BROWSERS" = 0 ]; then
  record browser-process fail "no browser process is running; the ${BROWSER_SERVICE} service is what starts one"
else
  record browser-process fail "$BROWSERS browser processes hold ${CHROME_PROFILE}; only the first of them can own the profile"
fi
if (exec 3<>/dev/tcp/127.0.0.1/${COMPUTER_CDP_PORT}) 2>/dev/null; then
  record browser-cdp pass "CDP answers on ${COMPUTER_CDP_PORT}"
else
  record browser-cdp fail "nothing answers CDP on ${COMPUTER_CDP_PORT}; no Bot can be given a window"
fi
if xdpyinfo -display ${COMPUTER_DISPLAY} >/dev/null 2>&1; then
  record screen pass "the shared screen is up on ${COMPUTER_DISPLAY}, ${SCREEN_WIDTH}x${SLOT_HEIGHT} for ${DESKTOP_SLOTS} slots"
else
  record screen fail "no X server on ${COMPUTER_DISPLAY}; the ${SCREEN_SERVICE} service is what starts one"
fi
# Every tenant, not just the one that asked (ADR 0031). One Bot's report used
# to be the only evidence there was, which is exactly how three Bots sat on
# black screens while the first one browsed.
SURVEY=""
if (exec 3<>/dev/tcp/127.0.0.1/${COMPUTER_CDP_PORT}) 2>/dev/null; then
  SURVEY=$(timeout 20 node ${RUNTIME_ROOT}/browser.mjs ${COMPUTER_CDP_PORT} ${BROWSER_SURVEY_ACTION} 2>/dev/null | tail -n 1)
fi
case "$SURVEY" in (*'"tenants"'*) ;; (*) SURVEY="";; esac
TENANTS=0
for SLOT_FILE in ${BOTS_ROOT}/*/slot; do
  [ -s "$SLOT_FILE" ] || continue
  TENANT=$(basename "$(dirname "$SLOT_FILE")")
  TENANT_SLOT=$(cat "$SLOT_FILE")
  TENANTS=$((TENANTS + 1))
  if [ -z "$SURVEY" ]; then
    record "tenant-display-$TENANT" fail "Bot \\"$TENANT\\" holds slot $TENANT_SLOT and no browser could be asked about its window"
    continue
  fi
  ROW=$(printf '%s' "$SURVEY" | tr '{' '\\n' | grep "\\"key\\":\\"$TENANT\\"" | head -n 1)
  if [ -z "$ROW" ]; then
    record "tenant-display-$TENANT" fail "Bot \\"$TENANT\\" holds slot $TENANT_SLOT but the browser reported no window for it"
  elif ! printf '%s' "$ROW" | grep -q '"alive":true'; then
    record "tenant-display-$TENANT" fail "Bot \\"$TENANT\\" holds slot $TENANT_SLOT with no live window; it opens one on its next action"
  elif ! printf '%s' "$ROW" | grep -q '"placed":true'; then
    record "tenant-display-$TENANT" fail "Bot \\"$TENANT\\" has a window that is not over slot $TENANT_SLOT; its viewer shows another Bot's rectangle"
  else
    record "tenant-display-$TENANT" pass "Bot \\"$TENANT\\" has a live window pinned over slot $TENANT_SLOT of ${COMPUTER_DISPLAY}"
  fi
done
if [ "$TENANTS" = 0 ]; then
  record tenant-display pass "no Bot holds a slot on this Computer; the exec and file surfaces need no screen"
fi
if [ -x ${CHROMIUM_PATH} ]; then
  record browser pass "the browser is installed at ${CHROMIUM_PATH} ($(readlink -f ${CHROMIUM_PATH} 2>/dev/null || echo unresolved))"
else
  record browser fail "no browser at ${CHROMIUM_PATH}; provisioning installs one, and no desktop can start without it"
fi
PROFILE=${CHROME_PROFILE}
if [ -d "$PROFILE" ] && [ -w "$PROFILE" ]; then
  record browser-profile pass "the shared browser profile at $PROFILE is writable"
else
  record browser-profile fail "the shared browser profile at $PROFILE is missing or not writable"
fi
# What the browser announces itself as (parity row 34b).
#
# Measured, not governed: the register declines UA pinning and per-site
# fingerprint profiles, and keeps this, because "does our browser announce
# itself as a robot" was an assumption nobody had checked and it costs one
# CDP round trip to make it a recorded fact. A FAIL means a tell was found —
# a HeadlessChrome token or navigator.webdriver — and the fix is one entry in
# the flag list the launcher already holds.
#
# A browser that is not running is not a failure. There is nothing to ask, so
# the check passes and the report carries no measurement, which is a
# different fact from a browser that presented no tells.
IDENTITY=null
if [ ! -x ${CHROMIUM_PATH} ]; then
  record browser-identity fail "no browser at ${CHROMIUM_PATH}, so nothing could be asked what it announces itself as"
elif ! (exec 3<>/dev/tcp/127.0.0.1/${COMPUTER_CDP_PORT}) 2>/dev/null; then
  record browser-identity pass "no browser answers CDP for this report, so nothing was asked what it announces itself as"
else
  MEASURED=$(timeout 15 node ${RUNTIME_ROOT}/browser.mjs ${COMPUTER_CDP_PORT} ${DOCTOR_BROWSER_IDENTITY_ACTION} "$KEY" 2>/dev/null | tail -n 1)
  case "$MEASURED" in (*'"userAgent"'*) ;; (*) MEASURED="";; esac
  if [ -z "$MEASURED" ]; then
    record browser-identity fail "a browser answers CDP on ${COMPUTER_CDP_PORT} but did not say what it presents"
  else
    IDENTITY="$MEASURED"
    UA=$(printf '%s' "$MEASURED" | sed -n 's/.*"userAgent":"\\([^"]*\\)".*/\\1/p')
    BRANDS=$(printf '%s' "$MEASURED" | sed -n 's/.*"brands":\\[\\(.*\\)\\].*/\\1/p')
    TELLS=""
    case "$UA" in (*HeadlessChrome*) TELLS="a HeadlessChrome token in its user agent";; esac
    case "$MEASURED" in (*'"webdriver":true'*) TELLS="\${TELLS:+$TELLS and }navigator.webdriver true";; esac
    if [ -n "$TELLS" ]; then
      record browser-identity fail "the browser presents $TELLS; user agent $UA, brands [$BRANDS]"
    else
      record browser-identity pass "the browser presents no automation tell; user agent $UA, brands [$BRANDS]"
    fi
  fi
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
if [ -x ${APPLET_SHIM_PATH} ] && [ -d ${APPLETS_ROOT}/node_modules/miniflare ]; then
  record applets pass "the Applets runtime is installed under ${APPLETS_ROOT} and \\"applet\\" is on your PATH"
elif [ -x ${APPLET_SHIM_PATH} ]; then
  record applets fail "\\"applet\\" is on your PATH but no miniflare is installed under ${APPLETS_ROOT}; \\"applet dev\\" cannot run an Applet"
else
  record applets fail "no ${APPLET_SHIM_PATH}; provisioning installs it, and no Applet can be checked, built, or previewed without it"
fi
# Named and non-fatal on purpose: an install or dependency-resolution failure
# leaves this file rather than failing the whole Computer run.
if [ -f ${APPLETS_SDK_FAILURE_PATH} ]; then
  record applets-sdk fail "$(head -n 1 ${APPLETS_SDK_FAILURE_PATH} 2>/dev/null); everything else on this Computer is unaffected"
elif [ -d ${APPLETS_ROOT}/node_modules/@frockbot/applet-sdk ]; then
  record applets-sdk pass "the Applets SDK and its shared imports resolve under ${APPLETS_ROOT}"
else
  record applets-sdk fail "no Applets SDK under ${APPLETS_ROOT} and no record of an attempt; it installs when this Computer is next provisioned"
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
printf '${DOCTOR_MARKER}{"schemaVersion":${DOCTOR_REPORT_SCHEMA_VERSION},"generation":%s,"capturedAt":"%s","checks":[%s],"browserIdentity":%s,"summary":"%s"}\\n' "$GENERATION" "$CAPTURED_AT" "$CHECKS" "$IDENTITY" "$SUMMARY"
`;

/** Every declared file installed by the runtime phase, in install order. */
export const COMPUTER_RUNTIME_FILES: readonly {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}[] = [
  {
    path: `${RUNTIME_ROOT}/start-screen.sh`,
    content: startScreenScript,
    mode: 0o700,
  },
  {
    path: `${RUNTIME_ROOT}/start-browser.sh`,
    content: startBrowserScript,
    mode: 0o700,
  },
  { path: WATCHDOG_SCRIPT, content: browserWatchdogScript, mode: 0o700 },
  {
    path: `${RUNTIME_ROOT}/start-view.sh`,
    content: startViewScript,
    mode: 0o700,
  },
  { path: ENSURE_WINDOW_SCRIPT, content: ensureWindowScript, mode: 0o700 },
  { path: FOCUS_WINDOW_SCRIPT, content: focusWindowScript, mode: 0o700 },
  { path: `${FLUXBOX_ROOT}/init`, content: fluxboxInit, mode: 0o644 },
  { path: `${FLUXBOX_ROOT}/overlay`, content: fluxboxOverlay, mode: 0o644 },
  { path: ENSURE_AGENT_SCRIPT, content: ensureAgentScript, mode: 0o700 },
  { path: CONTROL_SCRIPT, content: controlScript, mode: 0o700 },
  { path: BOUNDED_LOG_SCRIPT, content: boundedLogScript, mode: 0o700 },
  { path: `${RUNTIME_ROOT}/browser.mjs`, content: browserHelper, mode: 0o700 },
  {
    path: `${RUNTIME_ROOT}/start-gateway.sh`,
    content: gatewayScript,
    mode: 0o700,
  },
  { path: VIEWER_PAGE, content: viewerPage, mode: 0o644 },
  {
    path: `${RUNTIME_ROOT}/watch-workspace.sh`,
    content: syncWatchScript,
    mode: 0o700,
  },
  { path: DOCTOR_SCRIPT, content: boxDoctorScript, mode: 0o755 },
  { path: CHROME_LAUNCHER, content: chromeLauncherScript, mode: 0o755 },
  ...COMPUTER_GUI_SHELL_COMMANDS.map((name) => ({
    path: `${SHIMS_ROOT}/${name}`,
    content: guiShimScript(name),
    mode: 0o755,
  })),
];

function installDeclaredFiles(
  files: readonly {
    readonly path: string;
    readonly content: string;
    readonly mode: number;
  }[],
): string {
  return files
    .map(
      (file) => `${installFile(`${file.path}.tmp`, file.content)}
chmod ${file.mode.toString(8)} ${file.path}.tmp
mv ${file.path}.tmp ${file.path}`,
    )
    .join("\n");
}

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
    body: `mkdir -p ${VIEWER_ROOT} ${FLUXBOX_ROOT}
${installDeclaredFiles(COMPUTER_RUNTIME_FILES)}
# noVNC's ES modules in core/ import one another and ../vendor/pako. The links
# keep that package-owned graph intact while FrockBot owns every rendered element.
ln -sfn /usr/share/novnc/core ${VIEWER_ROOT}/core
ln -sfn /usr/share/novnc/vendor ${VIEWER_ROOT}/vendor`,
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
  # the launcher and an upgrade is one relink rather than a script change.
  ln -sfn "$CHROMIUM_BUILD" ${CHROMIUM_PATH}
fi`,
  },
  {
    name: "applets",
    label: "installing the Applets SDK",
    // Version-guarded by its own `[ ! -d ]` tests rather than by a marker, for
    // the same reason the reference phase is: a marker would make this run
    // exactly once in a Computer's life, and `@frockbot/applet-sdk` is not on
    // npm yet — the first run on a Computer provisioned today is expected to
    // fail its guarded step. Once both trees are present this phase is two
    // directory tests and a file install, so running it again costs nothing.
    always: true,
    // ADR 0022 decision 7: an Applet is authored on the Computer and run in
    // the loader, so this installs what authoring needs and nothing that runs
    // an Applet for real. Everything is `npm install --prefix` into a prefix
    // of this phase's own: no `apt`, no distribution package, no daemon, and
    // nothing that outlives the command.
    body: `mkdir -p ${APPLETS_ROOT}
if [ ! -d ${APPLETS_ROOT}/node_modules/miniflare ]; then
  npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund miniflare@${MINIFLARE_VERSION}
fi
${appletSdkInstallScript}
${installDeclaredFiles(APPLETS_RUNTIME_FILES)}`,
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

/**
 * The only phases an in-place runtime update may run.
 *
 * These atomically replace files owned by the provisioner. They never run
 * `apt`, install a browser, replace the instance, or touch `/home/box` User
 * content, the shared browser profile, or any durable root. A running Turn
 * keeps the old inode while each name is swapped, so it is not interrupted.
 * That is the Computer and Workspace rule made executable: an automatic
 * update loses nothing and cannot become an undeclared durability mechanism.
 */
export const UPDATE_PHASES: readonly {
  readonly name: string;
  readonly label: string;
  readonly body: string;
}[] = [
  {
    name: "runtime",
    label: "Updating the Computer runtime",
    body: PROVISION_PHASES.find((phase) => phase.name === "runtime")!.body,
  },
  {
    name: "applets",
    label: "Updating the Applets command",
    // The shim, plus the SDK only if this Computer has none. The provisioning
    // phase beside it also installs Miniflare, a network fetch into a
    // dependency tree an `applet dev` may be running out of right now; an
    // in-place update replaces files atomically and must not do that. The SDK
    // install is different: it runs only while the SDK is absent, and nothing
    // runs out of that tree until the SDK is there (see
    // `appletSdkInstallScript`). This is how a Computer provisioned while the
    // SDK was unpublished gets it without being provisioned again. A newer
    // SDK still waits for the next provisioning adoption.
    body: `mkdir -p ${APPLETS_ROOT}
${appletSdkInstallScript}
${installDeclaredFiles(APPLETS_RUNTIME_FILES)}`,
  },
  {
    name: "reference",
    label: "Updating the Computer reference",
    // The document digest, not the hand-maintained reference version, is the
    // update trigger. Always rewrite these files so a one-byte source change
    // cannot be acknowledged without reaching an existing Computer.
    body: referenceFilesInstallScript,
  },
];

/** The first progress report for an in-place update. */
export const UPDATE_STARTING_PHASE = {
  name: "starting",
  label: "Updating the Computer runtime document",
} as const;

/** The phase a run reports before it has entered the first real one. */
export const PROVISION_STARTING_PHASE = {
  name: "starting",
  label: "starting the Computer provisioner",
} as const;

function provisionStateLine(
  kind: "provision" | "update",
  digest: string,
  index: number,
  total: number,
  name: string,
  label: string,
  status: string,
): string {
  return JSON.stringify({
    version: 1,
    kind,
    documentDigest: digest,
    index,
    total,
    phase: name,
    label,
    status,
  });
}

/**
 * The provisioning document, run detached and resumable.
 *
 * Provisioning guards every phase with its marker, so running this again on a
 * half-provisioned Computer completes it rather than starting over. Update
 * mode runs only `UPDATE_PHASES`, with no markers: they are idempotent atomic
 * file installs and must run again whenever the document digest moves. Every
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
KIND="\${1:-provision}"
DIGEST="\${2:-}"
case "$KIND:$DIGEST" in
  provision:[0-9a-f][0-9a-f]*|update:[0-9a-f][0-9a-f]*) ;;
  *) echo "provisioner needs provision|update and a runtime digest" >&2; exit 64;;
esac
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
if [ "$KIND" = update ]; then
  TOTAL=${UPDATE_PHASES.length}
  NAME=${UPDATE_STARTING_PHASE.name}
  LABEL=${shellQuote(UPDATE_STARTING_PHASE.label)}
else
  TOTAL=${PROVISION_PHASES.length}
  NAME=${PROVISION_STARTING_PHASE.name}
  LABEL=${shellQuote(PROVISION_STARTING_PHASE.label)}
fi
state() {
  TMP=$(mktemp "$STATE.XXXXXX")
  printf '{"version":1,"kind":"%s","documentDigest":"%s","index":%s,"total":%s,"phase":"%s","label":"%s","status":"%s"}\\n' "$KIND" "$DIGEST" "$INDEX" "$TOTAL" "$NAME" "$LABEL" "$1" > "$TMP"
  mv "$TMP" "$STATE"
}
trap 'state failed' ERR
if [ "$KIND" = update ]; then
${UPDATE_PHASES.map(
  (phase, position) => `  INDEX=${position + 1}
  NAME=${phase.name}
  LABEL=${shellQuote(phase.label)}
  state running
${phase.body}`,
).join("\n")}
else
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
fi
INDEX=$TOTAL
NAME=ready
if [ "$KIND" = update ]; then
  LABEL='the Computer update is complete'
else
  LABEL='the Computer is ready'
fi
state complete
DIGEST_TMP=$(mktemp ${PROVISION_DIGEST}.XXXXXX)
printf '%s\\n' "$DIGEST" > "$DIGEST_TMP"
mv "$DIGEST_TMP" ${PROVISION_DIGEST}
`;

/**
 * Every declared file in the runtime document, in digest order.
 *
 * The phase bodies install from `COMPUTER_RUNTIME_FILES` and
 * `REFERENCE_RUNTIME_FILES`, and the launcher installs `provisionScript`
 * itself. The digest consumes those same sources so adding a provisioned file
 * necessarily adds it here rather than creating a second hand-kept inventory.
 */
export const RUNTIME_DOCUMENT_FILES: readonly {
  readonly path: string;
  readonly content: string;
}[] = [
  { path: PROVISION_SCRIPT, content: provisionScript },
  ...COMPUTER_RUNTIME_FILES,
  ...APPLETS_RUNTIME_FILES,
  ...REFERENCE_RUNTIME_FILES,
];

/** sha-256 in plain TypeScript, so the Worker and Node container agree. */
function sha256HexV1(value: string): string {
  const source = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((source.byteLength + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.byteLength] = 0x80;
  const bits = source.byteLength * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bits >>> 0);

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ] as const;
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotate = (word: number, count: number) =>
    (word >>> count) | (word << (32 - count));

  for (let offset = 0; offset < bytes.byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const before = words[index - 15]!;
      const recent = words[index - 2]!;
      const s0 = rotate(before, 7) ^ rotate(before, 18) ^ (before >>> 3);
      const s1 = rotate(recent, 17) ^ rotate(recent, 19) ^ (recent >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const first =
        (h! + sum1 + choose + constants[index]! + words[index]!) >>> 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const second = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * sha-256 over every installed runtime-document file's content, framed in a
 * fixed order so a boundary move cannot preserve the answer accidentally.
 */
export function runtimeDocumentDigestV1(): string {
  return sha256HexV1(
    RUNTIME_DOCUMENT_FILES.map((file) => {
      const length = new TextEncoder().encode(file.content).byteLength;
      return `${length}\0${file.content}`;
    }).join(""),
  );
}

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
function launchScript(kind: "provision" | "update"): string {
  const digest = runtimeDocumentDigestV1();
  const starting =
    kind === "update" ? UPDATE_STARTING_PHASE : PROVISION_STARTING_PHASE;
  const total =
    kind === "update" ? UPDATE_PHASES.length : PROVISION_PHASES.length;
  const startingState = provisionStateLine(
    kind,
    digest,
    0,
    total,
    starting.name,
    starting.label,
    "running",
  );
  const completeState = provisionStateLine(
    kind,
    digest,
    total,
    total,
    "ready",
    kind === "update"
      ? "the Computer update is complete"
      : "the Computer is ready",
    "complete",
  );
  const shouldRun =
    kind === "update"
      ? `[ "$(cat ${PROVISION_DIGEST} 2>/dev/null || true)" != ${digest} ]`
      : `! grep -q '"status":"complete"' ${PROVISION_STATE} 2>/dev/null`;
  const initializeState =
    kind === "update"
      ? `if ! grep -q '"kind":"update".*"status":"running"' ${PROVISION_STATE} 2>/dev/null; then
      printf '%s\\n' ${shellQuote(startingState)} > ${PROVISION_STATE}
    fi`
      : `[ -s ${PROVISION_STATE} ] || printf '%s\\n' ${shellQuote(startingState)} > ${PROVISION_STATE}`;
  return `set -eu
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
  if ${shouldRun}; then
    # Only when there is nothing to keep. A relaunch resumes an install that
    # already reached a phase, and reporting it as "starting" again would make
    # a resume look like a restart to whoever is watching.
    ${initializeState}
    setsid nohup flock -w ${PROVISION_LOCK_WAIT_SECONDS} ${PROVISION_LOCK} bash ${PROVISION_SCRIPT} ${kind} ${digest} >>${PROVISION_LOG} 2>&1 </dev/null &
    RUNNER=running
  elif [ ${shellQuote(kind)} = update ]; then
    printf '%s\\n' ${shellQuote(completeState)} > ${PROVISION_STATE}
  fi
fi
printf '${PROVISION_RUNNER_PREFIX}%s\\n' "$RUNNER"
cat ${PROVISION_STATE} 2>/dev/null || true
`;
}

export const provisionLaunchScript = launchScript("provision");
export const updateLaunchScript = launchScript("update");

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

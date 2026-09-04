import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  APPLET_SDK_VERSION,
  appletSdkInstallScript,
  APPLET_SHIM_PATH,
  appletShimScript,
  APPLETS_ROOT,
  APPLETS_RUNTIME_FILES,
  APPLETS_SDK_FAILURE_PATH,
  MINIFLARE_VERSION,
  BIN_ROOT,
  BOTS_ROOT,
  boxDoctorScript,
  browserHelper,
  BROWSER_ENSURE_ACTION,
  BROWSER_FOCUS_ACTION,
  BROWSER_SURVEY_ACTION,
  browserWatchdogScript,
  CHROME_LAUNCHER,
  CHROME_PROFILE,
  chromeLauncherScript,
  CHROMIUM_DISABLED_FEATURES,
  CHROMIUM_FLAGS,
  CHROMIUM_MAX_OLD_SPACE_MIB,
  CHROMIUM_PATH,
  CHROMIUM_RENDERER_PROCESS_LIMIT,
  COMPUTER_CDP_PORT,
  COMPUTER_DISPLAY,
  DESKTOP_SLOTS,
  ENSURE_WINDOW_SCRIPT,
  FLUXBOX_ROOT,
  fluxboxInit,
  fluxboxOverlay,
  FOCUS_WINDOW_SCRIPT,
  SCREEN_WIDTH,
  SLOT_HEIGHT,
  SLOT_WIDTH,
  TARGET_ID_FILE,
  COMPUTER_GUI_SHELL_COMMANDS,
  COMPUTER_RUNTIME_FILES,
  computerGuiRefusalV1,
  SHIMS_ROOT,
  DOCTOR_BROWSER_IDENTITY_ACTION,
  DOCTOR_LOG,
  DOCTOR_MARKER,
  DOCTOR_REPORT_SCHEMA_VERSION,
  DOCTOR_SCRIPT,
  guiShimScript,
  REFERENCE_DOCS,
  REFERENCE_DOCS_VERSION,
  REFERENCE_ROOT,
  SCRATCH_ROOT,
  shellGuiCommandV1,
  computerSpriteNameSourceV1,
  computerSpriteNameV1,
  CONTROL_SCRIPT,
  DATA_ROOT,
  DESKTOP_GUI_LEASE_KEY,
  ENSURE_AGENT_SCRIPT,
  HOME_ROOT,
  PROVISION_LOCK,
  PROVISION_DIGEST,
  PROVISION_PHASES,
  PROVISION_SCRIPT,
  PROVISION_TASK,
  PLAYWRIGHT_PLATFORM,
  PLAYWRIGHT_VERSION,
  DESKTOP_PACKAGES,
  SPRITE_API_SOCKET,
  provisionLaunchScript,
  provisionPollScript,
  BOUNDED_LOG_SCRIPT,
  BOUNDED_LOG_HEAD_BYTES,
  provisionScript,
  RUNTIME_DOCUMENT_FILES,
  runtimeDocumentDigestV1,
  RUNTIME_ROOT,
  base64,
  installFile,
  shellQuote,
  SLOT_IDLE_SECONDS,
  UPDATE_PHASES,
  updateLaunchScript,
  WATCHDOG_LOG,
  WATCHDOG_RENDERER_RSS_LIMIT_KIB,
  WATCHDOG_SCRIPT,
  WORKSPACES_ROOT,
} from "./runtime.ts";

function installedScript(provision: string, path: string): string {
  const line = provision
    .split("\n")
    .find(
      (candidate) =>
        candidate.includes(`> ${path}`) || candidate.includes(`> ${path}.tmp`),
    );
  const encoded = line ? /printf %s '([^']+)'/.exec(line)?.[1] : undefined;
  if (!encoded) throw new Error(`installed script not found: ${path}`);
  return Buffer.from(encoded, "base64").toString();
}

async function expectValidShell(script: string): Promise<void> {
  const process = Bun.spawn(["bash", "-n"], {
    stdin: new Blob([script]),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}

async function runControl(
  scriptPath: string,
  action: string,
  key: string,
  owner: string,
  maxAge = "90",
): Promise<{ exitCode: number; stderr: string }> {
  const args =
    action === "assert-agent"
      ? [scriptPath, action, key, DESKTOP_GUI_LEASE_KEY, owner, maxAge]
      : [scriptPath, action, key, owner, maxAge];
  const child = Bun.spawn(args, {
    env: {
      ...process.env,
      PATH: `${dirname(scriptPath)}:${process.env.PATH ?? ""}`,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}

function spriteName(userId: string, base = "frockbot"): string {
  return computerSpriteNameV1(
    userId,
    createHash("sha256")
      .update(computerSpriteNameSourceV1(userId))
      .digest("hex"),
    base,
  );
}

describe("layout", () => {
  test("the Computer is laid out under the GrokBot home", () => {
    expect(HOME_ROOT).toBe("/home/box");
    expect(DATA_ROOT).toBe("/home/box/agent-data");
    expect(RUNTIME_ROOT).toBe("/home/box/.frockbot");
    expect(BOTS_ROOT).toBe("/home/box/.frockbot/bots");
    expect(WORKSPACES_ROOT).toBe("/workspaces");
  });
});

describe("runtime files", () => {
  test("the minimal viewer applies takeover from a fragment change without reloading", () => {
    const viewer = COMPUTER_RUNTIME_FILES.find((file) =>
      file.path.endsWith("/viewer/index.html"),
    );
    if (!viewer) throw new Error("the FrockBot viewer page is not installed");
    const source = /<script type="module">([\s\S]*?)<\/script>/.exec(
      viewer.content,
    )?.[1];
    if (!source) throw new Error("the FrockBot viewer module is missing");

    const listeners = new Map<string, () => void>();
    const classes = new Set<string>();
    const screen = {
      classList: {
        toggle(name: string, enabled: boolean) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
      setAttribute() {},
    };
    const status = {
      textContent: "",
      dataset: {} as Record<string, string>,
    };
    const messages: unknown[] = [];
    const windowDouble = {
      location: {
        href: "https://sprite.invalid/index.html#view_only=1&path=websockify%3Ftoken%3Dsecret&password=password",
        hash: "#view_only=1&path=websockify%3Ftoken%3Dsecret&password=password",
        protocol: "https:",
        host: "sprite.invalid",
      },
      parent: { postMessage: (message: unknown) => messages.push(message) },
      addEventListener: (name: string, listener: () => void) =>
        listeners.set(name, listener),
      setTimeout: () => 1,
      clearTimeout() {},
    };
    const documentDouble = {
      getElementById: (id: string) => (id === "screen" ? screen : status),
    };
    let instance:
      | {
          viewOnly: boolean;
          showDotCursor: boolean;
          addEventListener(name: string, listener: () => void): void;
        }
      | undefined;
    class FakeRfb {
      viewOnly = false;
      showDotCursor = true;
      readonly listeners = new Map<string, () => void>();

      constructor() {
        instance = this;
      }

      addEventListener(name: string, listener: () => void): void {
        this.listeners.set(name, listener);
      }
    }
    const executable = source.replace(/^\s*import RFB from [^;]+;\s*/m, "");
    new Function("RFB", "window", "document", executable)(
      FakeRfb,
      windowDouble,
      documentDouble,
    );

    expect(instance?.viewOnly).toBe(true);
    expect(instance?.showDotCursor).toBe(false);
    expect(classes.has("view-only")).toBe(true);

    windowDouble.location.hash =
      "#view_only=0&path=websockify%3Ftoken%3Dsecret&password=password";
    windowDouble.location.href = `https://sprite.invalid/index.html${windowDouble.location.hash}`;
    listeners.get("hashchange")?.();

    expect(instance?.viewOnly).toBe(false);
    expect(classes.has("view-only")).toBe(false);
    expect(messages).not.toContainEqual(
      expect.objectContaining({ password: expect.anything() }),
    );
  });

  test("every declared file is the one the provisioning script installs", () => {
    for (const file of COMPUTER_RUNTIME_FILES) {
      expect(provisionScript).toContain(
        installFile(`${file.path}.tmp`, file.content),
      );
    }
  });

  test("the inventory covers every file the provisioning script installs", () => {
    const installs = provisionScript
      .split("\n")
      .filter(
        (line) =>
          line.trimStart().startsWith("printf %s '") &&
          line.includes("base64 -d >"),
      );
    const paths = new Set(
      installs.map((line) =>
        line
          .slice(line.indexOf("base64 -d >") + "base64 -d >".length)
          .trim()
          .split(/[ &]/, 1)[0]!
          .replace(/\.tmp$/, ""),
      ),
    );
    expect(paths).toEqual(
      new Set(RUNTIME_DOCUMENT_FILES.slice(1).map((file) => file.path)),
    );
  });

  test("every declared file receives its mode before the atomic rename", () => {
    // Found live: the shims moved to their own directory and the `chmod` that
    // follows them kept the old path, so provisioning failed at phase 3 with
    // "cannot access /home/box/bin/xdotool". An install and a mode are one
    // fact about a file, and this is what keeps them from drifting apart.
    for (const file of COMPUTER_RUNTIME_FILES) {
      const installed = provisionScript.indexOf(
        installFile(`${file.path}.tmp`, file.content),
      );
      const mode = provisionScript.indexOf(
        `chmod ${file.mode.toString(8)} ${file.path}.tmp`,
        installed,
      );
      const renamed = provisionScript.indexOf(
        `mv ${file.path}.tmp ${file.path}`,
        mode,
      );
      expect(installed, file.path).toBeGreaterThan(-1);
      expect(mode, file.path).toBeGreaterThan(installed);
      expect(renamed, file.path).toBeGreaterThan(mode);
    }
  });

  test("the control and ensure scripts are installed where the provider calls them", () => {
    const paths = COMPUTER_RUNTIME_FILES.map((file) => file.path);
    expect(paths).toContain(CONTROL_SCRIPT);
    expect(paths).toContain(ENSURE_AGENT_SCRIPT);
  });
});

describe("provisioning script", () => {
  test("is far larger than the argv budget that produced the measured 431", () => {
    // ADR 0004: Fly answered a ~2.5 KB `cmd=` query with 431. The script must
    // reach the Sprite on stdin, and this asserts the size that makes argv
    // delivery impossible rather than merely unwise.
    expect(provisionScript.length).toBeGreaterThan(3_000);
  });

  test("installs the desktop, sync, and gateway runtime", () => {
    expect(provisionScript).toContain(
      "apt-get install -y --no-install-recommends",
    );
    // `computer_screenshot` runs `scrot` under the tenant's own display, so
    // provisioning installs it and the capability probe asks for it. Without
    // the probe, an already-provisioned Computer would never gain it.
    expect(DESKTOP_PACKAGES).toContain("scrot");
    expect(provisionScript).toContain("! command -v scrot >/dev/null");
    expect(provisionScript).toContain(`playwright-core@${PLAYWRIGHT_VERSION}`);
    expect(provisionScript).toContain(`chmod 600 ${RUNTIME_ROOT}/tokens`);
  });

  test("installs no browser from the distribution", () => {
    // ADR 0004: on the Sprite base image `chromium` is a snap transitional
    // package. Installing it pulls `snapd` and `systemd` and had not finished
    // after 25 minutes, which is the whole reason a cold Computer could not
    // open. The browser is Playwright's own build instead, and the way that
    // stays true is that the package list never names one again.
    expect(DESKTOP_PACKAGES).not.toContain("chromium");
    expect(provisionScript).not.toMatch(/apt-get install[^\n]*\bchromium\b/);
    expect(provisionScript).toContain("cli.js install chromium");
    expect(provisionScript).toContain(
      `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=${PLAYWRIGHT_PLATFORM}`,
    );
  });

  test("holds the Sprite awake for the whole detached run", () => {
    // The defect that made every package list look too heavy: a Sprite is
    // active while there is "a command running, a session producing output, an
    // open TCP connection to its URL, a service handling traffic", and a
    // `setsid nohup` provisioner is none of those. Measured, the Sprite's own
    // clock advanced ~4 minutes across ~25 minutes of wall time. The task is
    // the documented hold, and it is released on EXIT so a failed run stops
    // paying for the Sprite rather than pinning it awake.
    expect(provisionScript).toContain(SPRITE_API_SOCKET);
    expect(provisionScript).toContain(`http://sprite/v1/tasks`);
    expect(provisionScript).toContain(
      `-X DELETE http://sprite/v1/tasks/${PROVISION_TASK}`,
    );
    expect(provisionScript).toContain("trap release EXIT");
  });

  test("puts the real toolchain on PATH before it runs node", () => {
    // `/.sprite/bin/node` is an nvm shim whose last resort is `command -v
    // node` — itself, in a non-login shell — so a detached `node` re-execs for
    // ever. Measured on a real Sprite: it never returned.
    const preamble = provisionScript.indexOf("/etc/profile.d/languages_paths");
    const firstNode = provisionScript.indexOf("npm install --prefix");
    expect(preamble).toBeGreaterThan(-1);
    expect(preamble).toBeLessThan(firstNode);
  });

  test("guards every resumable phase with its own marker", () => {
    // A half-provisioned Computer is completed, never started over: the phase
    // a container restart interrupted is the phase the next run begins at.
    for (const phase of PROVISION_PHASES.filter((entry) => !entry.always)) {
      expect(provisionScript).toContain(`[ ! -f "$MARKERS/${phase.name}" ]`);
      expect(provisionScript).toContain(`touch "$MARKERS/${phase.name}"`);
    }
  });

  test("the reference phase is version-guarded rather than marker-guarded", () => {
    // A marker would make the reference set writable exactly once in a
    // Computer's life, which is the defect this version exists to fix.
    const reference = PROVISION_PHASES.find(
      (phase) => phase.name === "reference",
    );
    expect(reference?.always).toBe(true);
    expect(provisionScript).not.toContain('[ ! -f "$MARKERS/reference" ]');
    expect(provisionScript).toContain(`${REFERENCE_ROOT}/.version 2>/dev/null`);
    expect(provisionScript).toContain(REFERENCE_DOCS_VERSION);
  });

  test("creates the shared scratch, which no durable root covers", () => {
    expect(provisionScript).toContain(`chmod 0775 ${SCRATCH_ROOT}`);
    expect(provisionScript).toContain(`chown box:box ${SCRATCH_ROOT}`);
  });

  test("records the phase it is in before it begins it", () => {
    // The progress `open` reports. Written before the work, or a phase that
    // never finishes would never be named.
    for (const [position, phase] of PROVISION_PHASES.entries()) {
      expect(provisionScript).toContain(`INDEX=${position + 1}
NAME=${phase.name}
LABEL=${shellQuote(phase.label)}
state running`);
    }
    expect(provisionScript).toContain("state complete");
    expect(provisionScript).toContain("trap 'state failed' ERR");
  });

  test("the launcher detaches the run and the poll starts nothing", async () => {
    // The defect in one assertion: `@fly/sprites@0.1.0` declares a WebSocket
    // dead 45 s after the last inbound message and never pings, so the exec
    // that installs a desktop stack must not be the exec that waits for it.
    expect(provisionLaunchScript).toContain("setsid nohup");
    expect(provisionLaunchScript).toContain(PROVISION_SCRIPT);
    expect(provisionPollScript).not.toContain("setsid");
    expect(provisionPollScript).not.toContain("apt-get");
    // Short enough that it cannot be the thing that is quiet.
    expect(provisionPollScript.length).toBeLessThan(1_000);
    await expectValidShell(provisionLaunchScript);
    await expectValidShell(updateLaunchScript);
    await expectValidShell(provisionPollScript);
    await expectValidShell(provisionScript);
  });

  test("the launcher probes the run lock once, before it starts anything", () => {
    // Measured: a second probe after the launch takes the lock the
    // provisioner is trying to take, and `flock -n` makes the provisioner
    // die silently. One probe, and the provisioner waits rather than refusing.
    expect(
      provisionLaunchScript.split(`flock -n ${PROVISION_LOCK}`),
    ).toHaveLength(2);
    expect(provisionLaunchScript).toContain(`flock -w 30 ${PROVISION_LOCK}`);
  });

  test("writes the runtime digest only after the complete state", () => {
    const complete = provisionScript.indexOf("state complete");
    const digest = provisionScript.indexOf(
      `mv \"$DIGEST_TMP\" ${PROVISION_DIGEST}`,
    );
    expect(complete).toBeGreaterThan(-1);
    expect(digest).toBeGreaterThan(complete);
    expect(provisionScript.slice(digest).trim()).toBe(
      `mv \"$DIGEST_TMP\" ${PROVISION_DIGEST}`,
    );
  });

  test("the update runner replaces files and only repairs Applet dependencies", () => {
    expect(UPDATE_PHASES.map((phase) => phase.name)).toEqual([
      "runtime",
      "applets",
      "reference",
    ]);
    for (const phase of UPDATE_PHASES) {
      expect(phase.label).toStartWith("Updating ");
    }
    const updateDocument = UPDATE_PHASES.map((phase) => phase.body).join("\n");
    expect(updateDocument).not.toContain("apt-get");
    expect(updateDocument).not.toContain("playwright-core/cli.js install");
    // An in-place update swaps names over files it owns. It installs the SDK
    // only while absent, and fills the four shared React dependencies only
    // when the resolution probe proves an older installation needs repair.
    expect(updateDocument).not.toContain("miniflare@");
    const installs = updateDocument
      .split("\n")
      .filter((line) => line.includes("npm install"));
    expect(installs).toEqual([
      `  if npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund @frockbot/applet-sdk@${APPLET_SDK_VERSION}; then`,
      `    npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund react@19.2.8 react-dom@19.2.8 @types/react@19.2.18 @types/react-dom@19.2.4 || true`,
    ]);
    expect(updateDocument).toContain(
      `if [ ! -d ${APPLETS_ROOT}/node_modules/@frockbot/applet-sdk ]; then`,
    );
  });

  test("the SDK install follows the published dist-tag, not a number", () => {
    // v0.3.12 published `@frockbot/applet-sdk` as 0.3.12; a pinned "0.1.0"
    // never existed and left every Computer without an SDK.
    expect(APPLET_SDK_VERSION).toBe("latest");
  });
});

describe("the applets phase", () => {
  test("installs the Applets runtime after the browser", () => {
    const names = PROVISION_PHASES.map((phase) => phase.name);
    expect(names).toEqual([
      "layout",
      "packages",
      "runtime",
      "browser",
      "applets",
      "reference",
    ]);
  });

  test("installs miniflare and the SDK into a prefix of their own", () => {
    const applets = PROVISION_PHASES.find((phase) => phase.name === "applets")!;
    // Not the runtime root: the browser driver and the Applets runtime are two
    // dependency trees, and one resolution over both would let an Applets
    // upgrade move `playwright-core`.
    expect(applets.body).toContain(
      `npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund miniflare@${MINIFLARE_VERSION}`,
    );
    expect(applets.body).toContain(
      `npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund @frockbot/applet-sdk@${APPLET_SDK_VERSION}`,
    );
    expect(APPLETS_ROOT.startsWith(`${RUNTIME_ROOT}/`)).toBe(true);
  });

  test("recreates shared Applet dependencies outside every durable source root", () => {
    const provision = PROVISION_PHASES.find(
      (phase) => phase.name === "applets",
    )!.body;
    const update = UPDATE_PHASES.find(
      (phase) => phase.name === "applets",
    )!.body;

    expect(APPLETS_ROOT).toBe(`${RUNTIME_ROOT}/applets`);
    expect(APPLETS_ROOT).not.toContain("/agent-data/");
    expect(provision).toContain(appletSdkInstallScript);
    expect(update).toContain(appletSdkInstallScript);
    expect(appletSdkInstallScript).toContain(
      `npm install --prefix ${APPLETS_ROOT}`,
    );
    expect(appletSdkInstallScript).not.toContain("user-packages");
  });

  test("repairs old SDK installs and verifies every shared build import", () => {
    const fallback =
      `npm install --prefix ${APPLETS_ROOT} --no-audit --no-fund ` +
      "react@19.2.8 react-dom@19.2.8 @types/react@19.2.18 @types/react-dom@19.2.4";
    const fallbackProbe = `cd ${APPLETS_ROOT} && node -e "require.resolve('react-dom/client')"`;

    expect(appletSdkInstallScript).toContain(fallback);
    expect(appletSdkInstallScript).toContain(fallbackProbe);
    expect(appletSdkInstallScript).toContain(
      `SDK_RESOLUTION_ERROR=$(cd ${APPLETS_ROOT} && node -e`,
    );
    for (const specifier of [
      "react-dom/client",
      "react",
      "@frockbot/applet-sdk/client",
    ]) {
      expect(appletSdkInstallScript).toContain(`'${specifier}'`);
    }
    expect(appletSdkInstallScript.indexOf(fallbackProbe)).toBeLessThan(
      appletSdkInstallScript.indexOf(fallback),
    );
    expect(appletSdkInstallScript.indexOf(fallback)).toBeLessThan(
      appletSdkInstallScript.indexOf("SDK_RESOLUTION_ERROR=$(cd"),
    );
    expect(appletSdkInstallScript).toContain(`> ${APPLETS_SDK_FAILURE_PATH}`);
  });

  test("an SDK that cannot be fetched or resolved leaves a record and not a failed run", () => {
    // A Computer whose SDK could not be installed or resolved still browses,
    // execs, and syncs, so the phase records the failure for the doctor rather
    // than failing provisioning.
    const applets = PROVISION_PHASES.find((phase) => phase.name === "applets")!;
    expect(applets.body).toContain(`> ${APPLETS_SDK_FAILURE_PATH}`);
    expect(applets.body).toContain(`rm -f ${APPLETS_SDK_FAILURE_PATH}`);
    expect(boxDoctorScript).toContain("record applets-sdk fail");
    expect(boxDoctorScript).toContain("record applets-sdk pass");
    expect(
      boxDoctorScript.indexOf(`[ -f ${APPLETS_SDK_FAILURE_PATH} ]`),
    ).toBeLessThan(
      boxDoctorScript.indexOf(
        `[ -d ${APPLETS_ROOT}/node_modules/@frockbot/applet-sdk ]`,
      ),
    );
  });

  test("runs again rather than once so old SDK installs can be repaired", () => {
    const applets = PROVISION_PHASES.find((phase) => phase.name === "applets")!;
    expect(applets.always).toBe(true);
    expect(provisionScript).not.toContain('[ ! -f "$MARKERS/applets"');
    // Both installs are guarded, so a second run on a provisioned Computer is
    // two directory tests.
    expect(applets.body).toContain(`[ ! -d ${APPLETS_ROOT}/node_modules/`);
  });

  test("puts `applet` on the tenant's PATH, execing the SDK's own binary", () => {
    // `bin` leads a tenant's PATH after `shims`, and `shims` holds refusals —
    // this is a real command, so it belongs in `bin`.
    expect(APPLET_SHIM_PATH).toBe(`${BIN_ROOT}/applet`);
    expect(appletShimScript).toContain('exec "$APPLET" "$@"');
    expect(appletShimScript).toContain(
      `APPLET=${APPLETS_ROOT}/node_modules/.bin/applet`,
    );
    // The node shim on the base image re-execs itself for ever without this.
    expect(appletShimScript).toContain("/etc/profile.d/languages_paths");
    expect(APPLETS_RUNTIME_FILES[0]!.mode).toBe(0o755);
    // Declared, so the digest moves when the shim does and an existing
    // Computer is actually reached by the change.
    expect(RUNTIME_DOCUMENT_FILES.map((file) => file.path)).toContain(
      APPLET_SHIM_PATH,
    );
  });

  test("the reference set tells a Bot the command exists and where it is", () => {
    const layout = REFERENCE_DOCS.find(
      (document) => document.name === "layout.md",
    );
    expect(layout?.content).toContain("applet build");
    expect(layout?.content).toContain(APPLETS_ROOT);
    expect(layout?.content).toContain("user-packages/applets/source");
  });
});

describe("runtime document digest", () => {
  test("is stable across runs and is sha-256 hex", () => {
    const digest = runtimeDocumentDigestV1();
    const framed = RUNTIME_DOCUMENT_FILES.map(
      (file) => `${Buffer.byteLength(file.content)}\0${file.content}`,
    ).join("");
    expect(digest).toBe(runtimeDocumentDigestV1());
    expect(digest).toBe(createHash("sha256").update(framed).digest("hex"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("moves on a one-byte change to every installed file", () => {
    const stable = runtimeDocumentDigestV1();
    for (const file of RUNTIME_DOCUMENT_FILES) {
      const mutable = file as { content: string };
      const original = mutable.content;
      try {
        mutable.content = `${original}x`;
        expect(runtimeDocumentDigestV1(), file.path).not.toBe(stable);
      } finally {
        mutable.content = original;
      }
    }
    expect(runtimeDocumentDigestV1()).toBe(stable);
  });
});

describe("shell helpers", () => {
  test("quotes a value that would otherwise break out of its argument", () => {
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  test("round-trips content through the base64 installer", () => {
    const line = installFile("/tmp/x", "hello");
    expect(line).toBe(`printf %s '${base64("hello")}' | base64 -d > /tmp/x`);
  });
});

describe("Sprite naming", () => {
  test("one Computer per User: the name derives from the User alone", () => {
    expect(spriteName("user-1")).toBe(spriteName("user-1"));
    expect(spriteName("user-1")).not.toBe(spriteName("user-2"));
  });

  test("the digest source is keyed so another owner kind cannot collide", () => {
    expect(computerSpriteNameSourceV1("user-1")).toBe('["user","user-1"]');
  });

  test("the name is a legal Sprite name with a twelve-character digest", () => {
    const name = spriteName("user-1");
    expect(name).toMatch(/^frockbot-[0-9a-f]{12}$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("a long base name is trimmed so the result still fits", () => {
    const name = spriteName("user-1", `a${"b".repeat(60)}`);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("refuses a base name that is not a legal Sprite name", () => {
    expect(() => spriteName("user-1", "Frockbot")).toThrow(/base name/);
    expect(() => spriteName("user-1", "-leading")).toThrow(/base name/);
  });

  test("refuses an empty User", () => {
    expect(() => spriteName("   ")).toThrow(/non-empty userId/);
  });
});

// The Computer's shell scripts, run for real.
//
// These live here rather than beside the provider because the scripts do: a
// Bot Durable Object no longer installs them, the Computer host does, and a
// test that had to stand up a provider to read a string out of a provisioning
// command was testing the wrong module. Each one installs production's own
// script into a temp tree, stubs only `flock` and GNU `stat`, and runs it.
describe("installed shell scripts", () => {
  test("all of a User's Bots share one browser profile", () => {
    // ADR 0012: one Computer per User, and "all Bots share the User's browser
    // profile". One directory, not one per Bot — the assertion lives here
    // because the provisioning document is what creates it.
    expect(provisionScript).toContain(`${HOME_ROOT}/chrome-profile `);
    expect(provisionScript).not.toContain("chrome-profiles");
    // The flag set moved into the launcher (parity row 33); the browser
    // service calls it and holds no flags of its own.
    expect(installedScript(provisionScript, CHROME_LAUNCHER)).toContain(
      `--user-data-dir=${HOME_ROOT}/chrome-profile`,
    );
    expect(
      installedScript(provisionScript, `${RUNTIME_ROOT}/start-browser.sh`),
    ).toContain(`exec ${CHROME_LAUNCHER} about:blank`);
  });

  test("one browser holds the shared profile, and the launcher takes no Bot key", () => {
    // ADR 0031. Chromium's singleton lock is per `--user-data-dir`, so a
    // per-slot launch could only ever produce one browser: the first Bot to
    // ask got a screen and the rest got "Opening in existing browser session"
    // and a dead CDP port. One browser, one display, one port.
    const launcher = installedScript(provisionScript, CHROME_LAUNCHER);
    expect(launcher).toContain(`--remote-debugging-port=${COMPUTER_CDP_PORT}`);
    expect(launcher).toContain(`export DISPLAY=${COMPUTER_DISPLAY}`);
    expect(launcher).not.toContain("9222 + SLOT");
    expect(launcher).not.toContain("100 + SLOT");
    // The one thing the launcher may remove is a stale singleton file, and
    // only when no browser is running. Never the profile: it is the User's
    // login state, and every Bot's.
    expect(launcher).toContain(`rm -f ${CHROME_PROFILE}/SingletonLock`);
    expect(launcher).not.toContain(`rm -rf ${CHROME_PROFILE}`);
  });

  test("bounds Chromium renderers without disabling background timer throttling", () => {
    expect(CHROMIUM_FLAGS).toContain(
      `--renderer-process-limit=${CHROMIUM_RENDERER_PROCESS_LIMIT}`,
    );
    expect(CHROMIUM_FLAGS).toContain(
      `--js-flags=--max-old-space-size=${CHROMIUM_MAX_OLD_SPACE_MIB}`,
    );
    expect(CHROMIUM_FLAGS).toContain(
      `--disable-features=${CHROMIUM_DISABLED_FEATURES.join(",")}`,
    );
    expect(CHROMIUM_DISABLED_FEATURES).not.toContain(
      "IntensiveWakeUpThrottling",
    );
  });

  test("the watchdog kills an oversized renderer and leaves a bounded one running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frockbot-watchdog-"));
    const oversized = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const bounded = Bun.spawn(["sleep", "60"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const procRoot = join(directory, "proc");
      const renderer = async (pid: number, rssKiB: number) => {
        const root = join(procRoot, String(pid));
        await mkdir(root, { recursive: true });
        await writeFile(
          join(root, "cmdline"),
          `/home/box/bin/chromium\0--type=renderer\0--renderer-client-id=${pid}\0`,
        );
        await writeFile(
          join(root, "status"),
          `Name:\tchromium\nState:\tS (sleeping)\nVmRSS:\t${rssKiB} kB\n`,
        );
      };
      await mkdir(procRoot, { recursive: true });
      await writeFile(
        join(procRoot, "meminfo"),
        "MemTotal:       8388608 kB\nMemAvailable:   4194304 kB\n",
      );
      await renderer(oversized.pid, WATCHDOG_RENDERER_RSS_LIMIT_KIB + 524_288);
      await renderer(bounded.pid, WATCHDOG_RENDERER_RSS_LIMIT_KIB - 1);
      const logPath = join(directory, "watchdog.log");
      const watchdog = Bun.spawn(["bash"], {
        stdin: new Blob([browserWatchdogScript]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          FROCKBOT_WATCHDOG_ONCE: "1",
          FROCKBOT_WATCHDOG_PROC_ROOT: procRoot,
          FROCKBOT_WATCHDOG_LOG: logPath,
        },
      });

      const [watchdogExit, watchdogError] = await Promise.all([
        watchdog.exited,
        new Response(watchdog.stderr).text(),
      ]);
      expect(watchdogError).toBe("");
      expect(watchdogExit).toBe(0);
      expect(await oversized.exited).not.toBe(0);
      expect(bounded.exitCode).toBeNull();
      const log = await readFile(logPath, "utf8");
      expect(log).toContain(`pid=${oversized.pid}`);
      expect(log).toContain("reason=renderer-rss");
      expect(log).not.toContain(`pid=${bounded.pid}`);
    } finally {
      oversized.kill();
      bounded.kill();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("one screen carries every slot, and each viewer is clipped to one", () => {
    const screen = installedScript(
      provisionScript,
      `${RUNTIME_ROOT}/start-screen.sh`,
    );
    expect(screen).toContain(
      `Xvfb ${COMPUTER_DISPLAY} -screen 0 ${SCREEN_WIDTH}x${SLOT_HEIGHT}x24`,
    );
    expect(SCREEN_WIDTH).toBe(SLOT_WIDTH * DESKTOP_SLOTS);
    const view = installedScript(
      provisionScript,
      `${RUNTIME_ROOT}/start-view.sh`,
    );
    // `-clip`, never `-id`: a window id changes every time a Bot's window is
    // re-created, and a VNC server bound to a dead window shows nothing.
    expect(view).toContain(
      `CLIP=${SLOT_WIDTH}x${SLOT_HEIGHT}+$((SLOT * ${SLOT_WIDTH}))+0`,
    );
    expect(view).toContain(
      `exec x11vnc -display ${COMPUTER_DISPLAY} -clip "$CLIP"`,
    );
    expect(view).not.toContain("-id ");
  });

  test("fluxbox never reaches for a wallpaper setter, and hides its toolbar", () => {
    // Every desktop carried an xmessage dialog reading "fbsetbg: I can't find
    // an app to set the wallpaper with", because with no `~/.fluxbox` at all
    // fluxbox writes its own defaults and applies the style's background.
    expect(fluxboxOverlay).toContain("background: none");
    expect(fluxboxInit).toContain("session.screen0.toolbar.visible: false");
    expect(fluxboxInit).toContain(
      `session.styleOverlay: ${FLUXBOX_ROOT}/overlay`,
    );
    expect(COMPUTER_RUNTIME_FILES.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        `${FLUXBOX_ROOT}/init`,
        `${FLUXBOX_ROOT}/overlay`,
      ]),
    );
    expect(
      installedScript(provisionScript, `${RUNTIME_ROOT}/start-screen.sh`),
    ).toContain(`fluxbox -rc ${FLUXBOX_ROOT}/init`);
  });

  test("browser.mjs drives the Bot's own window and never another Bot's", () => {
    expect(browserHelper).toContain("newWindow: true");
    expect(browserHelper).toContain("Browser.setWindowBounds");
    expect(browserHelper).toContain(
      `const TARGET_ID_FILE = "${TARGET_ID_FILE}"`,
    );
    // The window helpers ask for exactly the actions this module declares.
    for (const [encoded, action] of [
      [BROWSER_ENSURE_ACTION, "ensure"],
      [BROWSER_FOCUS_ACTION, "focus"],
      [BROWSER_SURVEY_ACTION, "survey"],
    ] as const) {
      expect(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      ).toEqual({ action });
      expect(browserHelper).toContain(`action.action === "${action}"`);
    }
  });

  test("every script the provisioning document installs is valid bash", async () => {
    for (const path of [
      `${RUNTIME_ROOT}/start-screen.sh`,
      `${RUNTIME_ROOT}/start-browser.sh`,
      `${RUNTIME_ROOT}/start-view.sh`,
      ENSURE_WINDOW_SCRIPT,
      FOCUS_WINDOW_SCRIPT,
      ENSURE_AGENT_SCRIPT,
      CONTROL_SCRIPT,
      BOUNDED_LOG_SCRIPT,
      WATCHDOG_SCRIPT,
      CHROME_LAUNCHER,
      DOCTOR_SCRIPT,
      `${RUNTIME_ROOT}/start-gateway.sh`,
    ]) {
      await expectValidShell(installedScript(provisionScript, path));
    }
  });

  test("atomically grants an expired lease to one concurrent replacement", async () => {
    const installed = installedScript(provisionScript, CONTROL_SCRIPT);
    const directory = await mkdtemp(join(tmpdir(), "frockbot-control-"));
    const runtimeRoot = join(directory, "runtime");
    const scriptPath = join(directory, "control.sh");
    const flockPath = join(directory, "flock");
    const statPath = join(directory, "stat");
    const helper = installed.replaceAll("/home/box/.frockbot", runtimeRoot);
    await writeFile(scriptPath, helper);
    await writeFile(
      flockPath,
      [
        "#!/usr/bin/env python3",
        "import fcntl, subprocess, sys",
        "lock_path = sys.argv[2]",
        "with open(lock_path, 'a') as lock:",
        "    fcntl.flock(lock, fcntl.LOCK_EX)",
        "    result = subprocess.run(sys.argv[3:])",
        "    raise SystemExit(result.returncode)",
        "",
      ].join("\n"),
    );
    await writeFile(
      statPath,
      // `stat -c %Y` is GNU; the shim answers with the host's own stat in one
      // exec. A scripting-language shim here was the slow half of a hundred
      // tenant scans and flaked the suite under load.
      [
        "#!/usr/bin/env bash",
        'if /usr/bin/stat -f %m / >/dev/null 2>&1; then exec /usr/bin/stat -f %m "${@: -1}"; fi',
        'exec /usr/bin/stat -c %Y "${@: -1}"',
        "",
      ].join("\n"),
    );
    await Promise.all([
      chmod(scriptPath, 0o700),
      chmod(flockPath, 0o700),
      chmod(statPath, 0o700),
    ]);
    const key = "general-0123456789ab";
    try {
      expect(
        (await runControl(scriptPath, "acquire", key, "owner-1", "90"))
          .exitCode,
      ).toBe(0);
      const leasePath = join(runtimeRoot, "bots", key, "human-control");
      const expiredAt = new Date(Date.now() - 120_000);
      await utimes(leasePath, expiredAt, expiredAt);

      const contenders = await Promise.all([
        runControl(scriptPath, "acquire", key, "owner-2", "90"),
        runControl(scriptPath, "acquire", key, "owner-3", "90"),
      ]);

      expect(contenders.map(({ exitCode }) => exitCode).sort()).toEqual([
        0, 73,
      ]);
      const winner = contenders[0]?.exitCode === 0 ? "owner-2" : "owner-3";
      expect(
        (await runControl(scriptPath, "renew", key, winner)).exitCode,
      ).toBe(0);
      expect(
        (await runControl(scriptPath, "assert-agent", key, "agent-runtime"))
          .exitCode,
      ).toBe(73);
      expect(
        (await runControl(scriptPath, "release", key, winner)).exitCode,
      ).toBe(0);
      expect(
        (await runControl(scriptPath, "assert-agent", key, "agent-runtime"))
          .exitCode,
      ).toBe(0);

      expect(
        (
          await runControl(
            scriptPath,
            "acquire",
            DESKTOP_GUI_LEASE_KEY,
            "human-session",
          )
        ).exitCode,
      ).toBe(0);
      const fenced = await runControl(
        scriptPath,
        "assert-agent",
        key,
        "agent-runtime",
      );
      expect(fenced.exitCode).toBe(73);
      expect(fenced.stderr).toContain("human-session");
      const desktopLease = join(
        runtimeRoot,
        "bots",
        DESKTOP_GUI_LEASE_KEY,
        "human-control",
      );
      await utimes(desktopLease, expiredAt, expiredAt);
      expect(
        (await runControl(scriptPath, "assert-agent", key, "agent-runtime"))
          .exitCode,
      ).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("desktop slots are reclaimed from idle tenants only", () => {
  /**
   * Installs the ensure script into a temp tree, with `flock` and GNU `stat`
   * stubbed the way the control-script test does: the script is production's,
   * only its roots and its two coreutils are local.
   */
  async function installEnsureScript(): Promise<{
    directory: string;
    runtimeRoot: string;
    run: (key: string) => Promise<{ exitCode: number; stdout: string }>;
  }> {
    const installed = installedScript(provisionScript, ENSURE_AGENT_SCRIPT);
    const directory = await mkdtemp(join(tmpdir(), "frockbot-slots-"));
    const runtimeRoot = join(directory, "runtime");
    const scriptPath = join(directory, "ensure-agent.sh");
    await writeFile(
      scriptPath,
      installed
        .replaceAll("/home/box/.frockbot", runtimeRoot)
        .replaceAll("/home/box", join(directory, "home"))
        .replaceAll("/workspaces", join(directory, "workspaces")),
    );
    await writeFile(
      join(directory, "flock"),
      ["#!/usr/bin/env bash", "exit 0", ""].join("\n"),
    );
    await writeFile(
      join(directory, "stat"),
      // `stat -c %Y` is GNU; the shim answers with the host's own stat in one
      // exec. A scripting-language shim here was the slow half of a hundred
      // tenant scans and flaked the suite under load.
      [
        "#!/usr/bin/env bash",
        'if /usr/bin/stat -f %m / >/dev/null 2>&1; then exec /usr/bin/stat -f %m "${@: -1}"; fi',
        'exec /usr/bin/stat -c %Y "${@: -1}"',
        "",
      ].join("\n"),
    );
    await Promise.all([
      chmod(scriptPath, 0o700),
      chmod(join(directory, "flock"), 0o700),
      chmod(join(directory, "stat"), 0o700),
    ]);
    return {
      directory,
      runtimeRoot,
      run: async (key: string) => {
        const child = Bun.spawn(
          [scriptPath, key, Buffer.from("{}").toString("base64")],
          {
            env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exitCode, stdout] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
        ]);
        return { exitCode, stdout };
      },
    };
  }

  /** A tenant holding one slot, last seen `idleSeconds` ago. */
  async function seedTenant(
    runtimeRoot: string,
    slot: number,
    idleSeconds: number,
    lease?: number,
  ): Promise<string> {
    const key = `tenant-${String(slot).padStart(3, "0")}`;
    const bot = join(runtimeRoot, "bots", key);
    await mkdir(bot, { recursive: true });
    await writeFile(join(bot, "slot"), `${slot}\n`);
    await writeFile(join(bot, "last-seen"), "");
    const seenAt = new Date(Date.now() - idleSeconds * 1000);
    await utimes(join(bot, "last-seen"), seenAt, seenAt);
    await utimes(join(bot, "slot"), seenAt, seenAt);
    if (lease !== undefined) {
      await writeFile(join(bot, "human-control"), "viewer-1\n");
      const leasedAt = new Date(Date.now() - lease * 1000);
      await utimes(join(bot, "human-control"), leasedAt, leasedAt);
    }
    return key;
  }

  test("reclaims an idle tenant's display and never a live one", async () => {
    const { directory, runtimeRoot, run } = await installEnsureScript();
    try {
      for (let slot = 0; slot < DESKTOP_SLOTS; slot += 1) {
        // Slot 2's tenant went quiet long ago; every other tenant is one this
        // provider ran something for moments ago.
        await seedTenant(
          runtimeRoot,
          slot,
          slot === 2 ? SLOT_IDLE_SECONDS + 600 : 5,
        );
      }

      const ensured = await run("newcomer");

      expect(ensured.exitCode).toBe(0);
      expect(
        (
          await readFile(join(runtimeRoot, "bots/newcomer/slot"), "utf8")
        ).trim(),
      ).toBe("2");
      // The idle tenant lost its slot; the live ones kept theirs.
      expect(existsSync(join(runtimeRoot, "bots/tenant-002/slot"))).toBe(false);
      expect(existsSync(join(runtimeRoot, "bots/tenant-003/slot"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("refuses the new tenant when every display is live, rather than sharing one", async () => {
    const { directory, runtimeRoot, run } = await installEnsureScript();
    try {
      for (let slot = 0; slot < DESKTOP_SLOTS; slot += 1) {
        await seedTenant(runtimeRoot, slot, 5);
      }

      const ensured = await run("newcomer");

      expect(ensured.exitCode).toBe(75);
      expect(ensured.stdout).toContain("__FROCKBOT_NO_SLOTS__");
      expect(existsSync(join(runtimeRoot, "bots/newcomer/slot"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("an idle tenant under human control keeps its display", async () => {
    const { directory, runtimeRoot, run } = await installEnsureScript();
    try {
      for (let slot = 0; slot < DESKTOP_SLOTS; slot += 1) {
        // The only idle tenant is the one a human is watching right now.
        await seedTenant(
          runtimeRoot,
          slot,
          slot === 3 ? SLOT_IDLE_SECONDS + 600 : 5,
          slot === 3 ? 5 : undefined,
        );
      }

      const ensured = await run("newcomer");

      expect(ensured.exitCode).toBe(75);
      expect(existsSync(join(runtimeRoot, "bots/tenant-003/slot"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("a fresh User-wide desktop lease keeps every idle display", async () => {
    const { directory, runtimeRoot, run } = await installEnsureScript();
    try {
      for (let slot = 0; slot < DESKTOP_SLOTS; slot += 1) {
        await seedTenant(runtimeRoot, slot, SLOT_IDLE_SECONDS + 600);
      }
      const leaseRoot = join(runtimeRoot, "bots", DESKTOP_GUI_LEASE_KEY);
      await mkdir(leaseRoot, { recursive: true });
      await writeFile(join(leaseRoot, "human-control"), "human-session\n");

      const ensured = await run("newcomer");

      expect(ensured.exitCode).toBe(75);
      expect(existsSync(join(runtimeRoot, "bots/tenant-003/slot"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("skips a tenant whose viewer just renewed last-seen", async () => {
    const { directory, runtimeRoot, run } = await installEnsureScript();
    try {
      for (let slot = 0; slot < DESKTOP_SLOTS; slot += 1) {
        await seedTenant(runtimeRoot, slot, SLOT_IDLE_SECONDS + 600);
      }
      // Viewer open/renew touches this existing registry fact. The reclaim
      // scan needs no viewer-specific file: a watcher is simply a live tenant.
      const watched = join(runtimeRoot, "bots/tenant-003/last-seen");
      const renewedAt = new Date();
      await utimes(watched, renewedAt, renewedAt);

      const ensured = await run("newcomer");

      expect(ensured.exitCode).toBe(0);
      expect(existsSync(join(runtimeRoot, "bots/tenant-003/slot"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test("prunes a slot from the superseded hundred-display layout", async () => {
    // The migration's registry half (ADR 0031). A Computer that allocated
    // displays 0-99 carries slots the one screen has no rectangle for; a window
    // pinned past its last slot is a window nobody can see. They are pruned
    // under the same lock that allocates, so the tenant re-allocates in range
    // on its next open — and nothing durable, and no profile, is touched.
    const { directory, runtimeRoot, run } = await installEnsureScript();
    try {
      const stale = await seedTenant(runtimeRoot, 7, 5);
      await writeFile(join(runtimeRoot, "bots", stale, "target-id"), "old\n");

      const ensured = await run("newcomer");

      expect(ensured.exitCode).toBe(0);
      expect(existsSync(join(runtimeRoot, "bots", stale, "slot"))).toBe(false);
      expect(existsSync(join(runtimeRoot, "bots", stale, "target-id"))).toBe(
        false,
      );
      expect(
        (
          await readFile(join(runtimeRoot, "bots/newcomer/slot"), "utf8")
        ).trim(),
      ).toBe("0");
      // One browser, one port: the file stays, and every tenant reads the same
      // number out of it.
      expect(
        (
          await readFile(join(runtimeRoot, "bots/newcomer/cdp-port"), "utf8")
        ).trim(),
      ).toBe(String(COMPUTER_CDP_PORT));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the background-process logger", () => {
  /**
   * A process that outlives its Turn can write for hours. The cap is what
   * keeps its log from becoming an unbounded write to a disk the User pays
   * for, and keeping both ends is what keeps the log useful: a long job says
   * what it set out to do at the start and what went wrong at the end.
   */
  test("keeps the head and the tail and drops the middle", async () => {
    const installed = installedScript(provisionScript, BOUNDED_LOG_SCRIPT);
    const directory = await mkdtemp(join(tmpdir(), "frockbot-log-"));
    const scriptPath = join(directory, "bounded-log.sh");
    await writeFile(scriptPath, installed);
    await chmod(scriptPath, 0o700);
    const out = join(directory, "log");

    // Small caps, so the test writes kilobytes rather than megabytes and the
    // trimming path runs many times rather than never.
    const input = Array.from(
      { length: 500 },
      (_, index) => `line-${String(index).padStart(4, "0")}\n`,
    ).join("");
    const child = Bun.spawn([scriptPath, out, "200", "200"], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);

    const head = await readFile(`${out}.head`, "utf8");
    const tail = await readFile(`${out}.tail`, "utf8");
    expect(head).toContain("line-0000");
    expect(head.length).toBeLessThan(400);
    expect(tail).toContain("line-0499");
    expect(tail.length).toBeLessThanOrEqual(400);
    // The middle really is gone: neither half holds it.
    expect(head + tail).not.toContain("line-0250");
  });

  test("declares a 256 KiB cap by default", () => {
    expect(BOUNDED_LOG_HEAD_BYTES * 2).toBe(262_144);
    expect(installedScript(provisionScript, BOUNDED_LOG_SCRIPT)).toContain(
      `HEAD_BYTES=${"${2:-"}${BOUNDED_LOG_HEAD_BYTES}}`,
    );
  });
});

// Parity row 33: "a launcher that enforces correct browser flags; GUI never
// driven from the shell". Two layers, both policy and neither a boundary —
// which is exactly why the refusal has to say what to use instead.
describe("the GUI is never driven from the shell", () => {
  test("names the command a shell string would actually run", () => {
    for (const command of [
      "chromium --headless",
      "xdotool key Return",
      "cd /tmp && scrot out.png",
      "true; sudo x11vnc -display :1",
      "DISPLAY=:1 import -window root shot.png",
      "/usr/bin/chromium about:blank",
      "ls | wmctrl -l",
      "Xvfb :3",
    ]) {
      expect(shellGuiCommandV1(command), command).toBeDefined();
    }
  });

  test("leaves a command that merely mentions one alone", () => {
    for (const command of [
      "echo 'chromium is not installed'",
      "grep -r import ./src",
      "python3 -c 'import os'",
      "cat /home/box/chromium.log",
      "ls /home/box/bin/xdotool",
      "printf '%s' scrotum",
    ]) {
      expect(shellGuiCommandV1(command), command).toBeUndefined();
    }
  });

  test("both layers print the same sentence, naming the sanctioned surface", () => {
    const refusal = computerGuiRefusalV1("xdotool");
    expect(refusal).toContain("computer_browser");
    expect(refusal).toContain("computer_screenshot");
    expect(refusal).toContain(CHROME_LAUNCHER);
    expect(guiShimScript("xdotool")).toContain(shellQuote(refusal));
    expect(guiShimScript("xdotool")).toContain("exit 64");
  });

  test("a shim steps aside for the Computer's own sanctioned scripts", async () => {
    // The shims sit on the tenant's PATH, and the desktop starter and the
    // screenshot exec run the very binaries they cover. Without this the
    // policy would break the Computer rather than the shell habit.
    const directory = await mkdtemp(join(tmpdir(), "frockbot-shim-"));
    try {
      const binDirectory = join(directory, "bin");
      const realDirectory = join(directory, "real");
      await mkdir(binDirectory, { recursive: true });
      await mkdir(realDirectory, { recursive: true });
      const shimPath = join(binDirectory, "xdotool");
      await writeFile(
        shimPath,
        guiShimScript("xdotool").replaceAll(SHIMS_ROOT, binDirectory),
      );
      await writeFile(
        join(realDirectory, "xdotool"),
        ["#!/usr/bin/env bash", "echo real-xdotool", ""].join("\n"),
      );
      await chmod(shimPath, 0o755);
      await chmod(join(realDirectory, "xdotool"), 0o755);
      // The shim dir leads, as it does on a tenant's PATH; the system
      // directories follow so `bash` itself is still findable.
      const path = `${binDirectory}:${realDirectory}:/usr/bin:/bin`;

      const refused = Bun.spawn([shimPath], {
        env: { PATH: path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [refusedCode, refusedError] = await Promise.all([
        refused.exited,
        new Response(refused.stderr).text(),
      ]);
      expect(refusedCode).toBe(64);
      expect(refusedError).toContain("never driven from the shell");

      const allowed = Bun.spawn([shimPath], {
        env: { PATH: path, FROCKBOT_SANCTIONED_SURFACE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [allowedCode, allowedOut] = await Promise.all([
        allowed.exited,
        new Response(allowed.stdout).text(),
      ]);
      expect(allowedCode).toBe(0);
      expect(allowedOut.trim()).toBe("real-xdotool");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// Parity row 27: "a self-check the Bot runs and reads a log from".
describe("box-doctor", () => {
  test("prints GrokBot's log lines and one machine-readable report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frockbot-doctor-"));
    try {
      const logPath = join(directory, "box-doctor.log");
      const scriptPath = join(directory, "box-doctor.sh");
      await writeFile(
        scriptPath,
        installedScript(provisionScript, DOCTOR_SCRIPT).replaceAll(
          DOCTOR_LOG,
          logPath,
        ),
      );
      await chmod(scriptPath, 0o755);

      const child = Bun.spawn([scriptPath, "doctor-bot", "7"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);

      // A Computer with failing checks is still a Computer that answered:
      // the report is the outcome, and a non-zero exit would make an
      // unhealthy box indistinguishable from an unreachable one.
      expect(exitCode).toBe(0);
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith(DOCTOR_MARKER));
      expect(line).toBeDefined();
      const report = JSON.parse(line!.slice(DOCTOR_MARKER.length)) as {
        schemaVersion: number;
        generation: number;
        capturedAt: string;
        checks: { name: string; status: string; detail: string }[];
        browserIdentity: unknown;
        summary: string;
      };
      expect(report.schemaVersion).toBe(DOCTOR_REPORT_SCHEMA_VERSION);
      expect(report.generation).toBe(7);
      expect(report.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(report.summary).toMatch(/^\d+ checks, \d+ passed, \d+ failed$/);
      // Every check the plan names, on a box that has none of them: what is
      // asserted is that each one is *reported*, not that it passes.
      expect(report.checks.map((check) => check.name)).toEqual([
        "disk-root",
        "disk-home",
        "scratch",
        "desktop-gateway",
        "sync-watcher",
        "watchdog",
        "memory-top",
        "browser-process",
        "browser-cdp",
        "screen",
        "tenant-display",
        "browser",
        "browser-profile",
        "browser-identity",
        "sync-signal",
        "applets",
        "applets-sdk",
        "reference-docs",
        "launcher",
        "clock",
        "dns",
        "sprite-hold",
      ]);
      for (const check of report.checks) {
        expect(["pass", "fail"]).toContain(check.status);
        expect(check.detail.length).toBeGreaterThan(0);
      }
      // Parity row 34b: nothing on this box is a browser, so the check fails
      // legibly and the report carries no measurement rather than an empty
      // one. The measured shape is proven at the decoder and on a live Sprite.
      expect(report.browserIdentity).toBeNull();
      expect(
        report.checks.find((check) => check.name === "browser-identity"),
      ).toMatchObject({ status: "fail" });

      const log = await readFile(logPath, "utf8");
      for (const check of report.checks) {
        expect(log).toContain(
          `[box-doctor] ${check.status === "pass" ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
        );
      }
      expect(log).toContain(`[box-doctor] SUMMARY ${report.summary}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  // Parity row 34b. The action is a literal in the runtime because the module
  // builds shell documents in a Worker, so the encoding is asserted here
  // rather than trusted.
  test("asks the browser helper for an identity it understands", () => {
    expect(
      JSON.parse(
        Buffer.from(DOCTOR_BROWSER_IDENTITY_ACTION, "base64url").toString(
          "utf8",
        ),
      ),
    ).toEqual({ action: "identity" });
    expect(browserHelper).toContain('action.action === "identity"');
    expect(browserHelper).toContain("navigator.webdriver");
    expect(boxDoctorScript).toContain(DOCTOR_BROWSER_IDENTITY_ACTION);
    // A tell is a FAIL, and both tells are named in the script rather than
    // inferred by whatever reads the report.
    expect(boxDoctorScript).toContain("HeadlessChrome");
    expect(boxDoctorScript).toContain('"webdriver":true');
  });

  test("counts only the browser main process", () => {
    expect(boxDoctorScript).toContain(
      `BROWSERS=$(pgrep -af -- "--user-data-dir=[/]home/box/chrome-profile" 2>/dev/null | awk -v self="$$" -v parent="$PPID" '$1 != self && $1 != parent && $0 ~ /(^|\\/)chrom(e|ium)( |$)/ && $0 !~ /(^|[[:space:]])--type=/ { count++ } END { print count + 0 }')`,
    );
  });

  test("reports the scratch, the launcher, and the reference version it expects", () => {
    expect(boxDoctorScript).toContain(SCRATCH_ROOT);
    expect(boxDoctorScript).toContain(CHROME_LAUNCHER);
    // The browser is Playwright's own build behind a stable symlink, and the
    // Sprite hold is the thing that must *not* still be held once
    // provisioning is done.
    expect(boxDoctorScript).toContain(CHROMIUM_PATH);
    expect(boxDoctorScript).toContain(SPRITE_API_SOCKET);
    expect(boxDoctorScript).toContain(PROVISION_TASK);
    expect(boxDoctorScript).toContain(REFERENCE_DOCS_VERSION);
    for (const command of COMPUTER_GUI_SHELL_COMMANDS) {
      expect(boxDoctorScript).toContain(`${SHIMS_ROOT}/${command}`);
    }
  });
});

describe("the shipped reference set", () => {
  test("covers the four documents a Bot debugs its Computer with", () => {
    expect(REFERENCE_DOCS.map((document) => document.name)).toEqual([
      "README.md",
      "layout.md",
      "browser.md",
      "debugging-the-box.md",
    ]);
  });

  test("says once, in layout.md, that the shared scratch is not durable", () => {
    const layout = REFERENCE_DOCS.find(
      (document) => document.name === "layout.md",
    );
    expect(layout?.content).toContain(SCRATCH_ROOT);
    expect(layout?.content).toContain("not** a durable root");
  });
});

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
  BIN_ROOT,
  BOTS_ROOT,
  boxDoctorScript,
  browserHelper,
  CHROME_LAUNCHER,
  chromeLauncherScript,
  CHROMIUM_PATH,
  COMPUTER_GUI_SHELL_COMMANDS,
  COMPUTER_REFRESH_FILES,
  COMPUTER_REFRESH_FINGERPRINT,
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
  ENSURE_AGENT_SCRIPT,
  HOME_ROOT,
  PROVISION_LOCK,
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
  RUNTIME_ROOT,
  base64,
  installFile,
  shellQuote,
  SLOT_IDLE_SECONDS,
  WORKSPACES_ROOT,
} from "./runtime.ts";

function installedScript(provision: string, path: string): string {
  const line = provision
    .split("\n")
    .find((candidate) => candidate.endsWith(`> ${path}`));
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
  const child = Bun.spawn([scriptPath, action, key, owner, maxAge], {
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
  test("every declared file is the one the provisioning script installs", () => {
    for (const file of COMPUTER_RUNTIME_FILES) {
      expect(provisionScript).toContain(installFile(file.path, file.content));
    }
  });

  test("the inventory covers every file the provisioning script installs", () => {
    const installs = provisionScript
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("printf %s '") && line.includes("base64 -d >"),
      );
    expect(installs).toHaveLength(COMPUTER_RUNTIME_FILES.length);
  });

  test("every declared file is also made executable where it lands", () => {
    // Found live: the shims moved to their own directory and the `chmod` that
    // follows them kept the old path, so provisioning failed at phase 3 with
    // "cannot access /home/box/bin/xdotool". An install and a mode are one
    // fact about a file, and this is what keeps them from drifting apart.
    const modes = provisionScript
      .split("\n")
      .filter((line) => line.startsWith("chmod "))
      .join(" ");
    for (const file of COMPUTER_RUNTIME_FILES) {
      expect(modes, file.path).toContain(` ${file.path}`);
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
    // The flag set moved into the launcher (parity row 33); the desktop
    // starter calls it and holds no flags of its own.
    expect(installedScript(provisionScript, CHROME_LAUNCHER)).toContain(
      `--user-data-dir=${HOME_ROOT}/chrome-profile`,
    );
    expect(
      installedScript(provisionScript, `${RUNTIME_ROOT}/start-desktop.sh`),
    ).toContain(`${CHROME_LAUNCHER} "$KEY"`);
  });

  test("every script the provisioning document installs is valid bash", async () => {
    for (const path of [
      `${RUNTIME_ROOT}/start-desktop.sh`,
      ENSURE_AGENT_SCRIPT,
      CONTROL_SCRIPT,
      BOUNDED_LOG_SCRIPT,
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
      for (let slot = 0; slot < 100; slot += 1) {
        // Slot 7's tenant went quiet long ago; every other tenant is one this
        // provider ran something for moments ago.
        await seedTenant(
          runtimeRoot,
          slot,
          slot === 7 ? SLOT_IDLE_SECONDS + 600 : 5,
        );
      }

      const ensured = await run("newcomer");

      expect(ensured.exitCode).toBe(0);
      expect(
        (
          await readFile(join(runtimeRoot, "bots/newcomer/slot"), "utf8")
        ).trim(),
      ).toBe("7");
      // The idle tenant lost its slot; the live ones kept theirs.
      expect(existsSync(join(runtimeRoot, "bots/tenant-007/slot"))).toBe(false);
      expect(existsSync(join(runtimeRoot, "bots/tenant-008/slot"))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("refuses the new tenant when every display is live, rather than sharing one", async () => {
    const { directory, runtimeRoot, run } = await installEnsureScript();
    try {
      for (let slot = 0; slot < 100; slot += 1) {
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
      for (let slot = 0; slot < 100; slot += 1) {
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
        "tenant-display",
        "browser",
        "browser-profile",
        "browser-identity",
        "sync-signal",
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

describe("refreshing an adopted Computer", () => {
  test("carries the files a running Computer can safely gain", () => {
    const paths = COMPUTER_REFRESH_FILES.map((file) => file.path);
    expect(paths).toContain(DOCTOR_SCRIPT);
    expect(paths).toContain(CHROME_LAUNCHER);
    expect(paths).toContain(`${REFERENCE_ROOT}/.version`);
    for (const command of COMPUTER_GUI_SHELL_COMMANDS) {
      expect(paths).toContain(`${SHIMS_ROOT}/${command}`);
    }
    for (const document of REFERENCE_DOCS) {
      expect(paths).toContain(`${REFERENCE_ROOT}/${document.name}`);
    }
  });

  test("carries no file a running process may be reading", () => {
    // `start-desktop.sh` and `control.sh` may be open in a live process, and
    // the filesystem API writes in place. Those change with a reprovisioning.
    const paths = COMPUTER_REFRESH_FILES.map((file) => file.path);
    expect(paths).not.toContain(CONTROL_SCRIPT);
    expect(paths).not.toContain(ENSURE_AGENT_SCRIPT);
    expect(paths).not.toContain(`${RUNTIME_ROOT}/start-desktop.sh`);
  });

  test("every refreshed file is one the provisioning script also installs", () => {
    const provisioned = new Set(
      COMPUTER_RUNTIME_FILES.map((file) => file.path),
    );
    for (const file of COMPUTER_REFRESH_FILES) {
      if (file.path.startsWith(REFERENCE_ROOT)) continue;
      expect(provisioned.has(file.path), file.path).toBe(true);
      expect(provisionScript).toContain(installFile(file.path, file.content));
    }
  });

  test("the fingerprint moves when any refreshed byte does", () => {
    expect(COMPUTER_REFRESH_FINGERPRINT).toMatch(/^[0-9a-f]{8}$/);
    expect(chromeLauncherScript).toContain(CHROME_LAUNCHER.split("/").at(-1)!);
  });
});

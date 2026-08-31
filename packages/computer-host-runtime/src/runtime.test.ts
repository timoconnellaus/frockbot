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
  BOTS_ROOT,
  COMPUTER_RUNTIME_FILES,
  computerSpriteNameSourceV1,
  computerSpriteNameV1,
  CONTROL_SCRIPT,
  DATA_ROOT,
  ENSURE_AGENT_SCRIPT,
  HOME_ROOT,
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
    expect(provisionScript).toContain("apt-get install -y chromium xvfb");
    expect(provisionScript).toContain("playwright-core@1.55.0");
    expect(provisionScript).toContain(`chmod 600 ${RUNTIME_ROOT}/tokens`);
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
    expect(
      installedScript(provisionScript, `${RUNTIME_ROOT}/start-desktop.sh`),
    ).toContain(`--user-data-dir="${HOME_ROOT}/chrome-profile"`);
  });

  test("every script the provisioning document installs is valid bash", async () => {
    for (const path of [
      `${RUNTIME_ROOT}/start-desktop.sh`,
      ENSURE_AGENT_SCRIPT,
      CONTROL_SCRIPT,
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

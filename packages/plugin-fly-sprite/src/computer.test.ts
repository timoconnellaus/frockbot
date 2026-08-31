/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
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
import { verifyPluginPackage } from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import {
  computerBotKey,
  FlySpriteComputer,
  flySpriteNameForBot,
  SLOT_IDLE_SECONDS,
  type SpriteHandle,
  type SpriteServiceStream,
  type SpritesClientHandle,
} from "./computer.ts";
import { configuredFlyBotId } from "./host.ts";
import {
  FlySpriteComputerProvider,
  flySpriteNameForComputer,
} from "./provider.ts";

class FakeStream implements SpriteServiceStream {
  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    yield { type: "started" };
  }
}

interface FakeLease {
  owner: string;
  fresh: boolean;
}

class FakeSprite implements SpriteHandle {
  name = "frockbot-test";
  url = "https://frockbot-test-123.sprites.app/";
  commands: Array<{ file: string; args: string[] }> = [];
  services: Array<{ name: string; httpPort?: number }> = [];
  auth?: string;
  readonly leases = new Map<string, FakeLease>();

  execFileHTTP(
    file: string,
    args: string[] = [],
  ): Promise<{ stdout: string; stderr: string }> {
    this.commands.push({ file, args });
    if (file.endsWith("/control.sh")) return this.control(args);
    if (file === "cat") {
      const path = args[0] ?? "";
      if (path.endsWith("/vnc-password")) {
        return Promise.resolve({ stdout: "secret-pass\n", stderr: "" });
      }
      if (path.endsWith("/viewer-token")) {
        return Promise.resolve({ stdout: "secret-token\n", stderr: "" });
      }
    }
    const shell = args.at(-1) ?? "";
    const guardedKey = /control\.sh assert-agent '([^']+)'/.exec(shell)?.[1];
    if (guardedKey) {
      const lease = this.leases.get(guardedKey);
      if (lease?.fresh && shell.includes("|| exit $?")) {
        return Promise.reject(
          new Error("The user is controlling this agent's computer"),
        );
      }
      this.leases.delete(guardedKey);
    }
    if (shell.includes("__FROCKBOT_EXIT__")) {
      const stdout = shell.includes("exit 7")
        ? "boom\n__FROCKBOT_EXIT__7\n"
        : "\n__FROCKBOT_EXIT__0\n";
      return Promise.resolve({ stdout, stderr: "warning noise\n" });
    }
    if (shell.includes("echo tool-output")) {
      return Promise.resolve({ stdout: "tool-output\n", stderr: "" });
    }
    if (shell.includes("missing.md")) {
      return Promise.resolve({ stdout: "__MISSING__\n", stderr: "" });
    }
    if (shell.includes('rm -f "$TARGET"')) {
      return Promise.resolve({
        stdout: "__DELETED__\n",
        stderr: "bash: /etc/profile: noise\n",
      });
    }
    if (shell.includes('find "$ROOT"')) {
      const offset = Number(/OFFSET=(\d+)/.exec(shell)?.[1] ?? 0);
      const limit = Number(/LIMIT=(\d+)/.exec(shell)?.[1] ?? 100);
      const lines = Array.from({ length: 205 }, (_, index) =>
        [
          Buffer.from(`memory-${String(index).padStart(3, "0")}.md`).toString(
            "base64",
          ),
          `version-${index}`,
          "7",
          "1700000000",
        ].join("\t"),
      );
      return Promise.resolve({
        stdout: `${lines.slice(offset, offset + limit + 1).join("\n")}\n`,
        stderr: "",
      });
    }
    if (shell.includes('mv "$TMP" "$TARGET"')) {
      return Promise.resolve({ stdout: "__WRITTEN__\n", stderr: "" });
    }
    if (shell.includes('base64 -w0 "$TARGET"')) {
      // meta, content hash, size, mtime, bytes — the Workspace file shape.
      return Promise.resolve({
        stdout: [
          "",
          "0".repeat(64),
          "8",
          "1700000000",
          Buffer.from("remember").toString("base64"),
          "",
        ].join("\n"),
        stderr: "",
      });
    }
    if (shell.includes("browser.mjs")) {
      return Promise.resolve({
        stdout: JSON.stringify({
          url: "https://example.com",
          snapshot: "- heading",
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }

  createService(
    name: string,
    config: { httpPort?: number },
  ): Promise<SpriteServiceStream> {
    this.services.push({ name, httpPort: config.httpPort });
    return Promise.resolve(new FakeStream());
  }

  updateURLSettings(settings: { auth: string }): Promise<void> {
    this.auth = settings.auth;
    return Promise.resolve();
  }

  private control(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const [action, key, owner] = args;
    if (!action || !key || !owner) {
      return Promise.reject(new Error("invalid control invocation"));
    }
    const lease = this.leases.get(key);
    if (action === "assert-agent") {
      if (lease?.fresh && lease.owner !== owner) {
        return Promise.reject(
          new Error("The user is controlling this agent's computer"),
        );
      }
      if (lease && !lease.fresh) this.leases.delete(key);
    } else if (action === "acquire") {
      if (lease?.fresh && lease.owner !== owner) {
        return Promise.reject(new Error("human control is active"));
      }
      this.leases.set(key, { owner, fresh: true });
    } else if (action === "renew") {
      if (lease?.owner !== owner) {
        return Promise.reject(new Error("lease owner changed"));
      }
      lease.fresh = true;
    } else if (action === "release" && lease?.owner === owner) {
      this.leases.delete(key);
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }
}

class FakeClient implements SpritesClientHandle {
  readonly sprite = new FakeSprite();

  listAllSprites(): Promise<SpriteHandle[]> {
    return Promise.resolve([this.sprite]);
  }

  createSprite(): Promise<SpriteHandle> {
    throw new Error("existing Sprite should be reused");
  }

  getSprite(): Promise<SpriteHandle> {
    return Promise.resolve(this.sprite);
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

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

describe("Fly Sprite computer", () => {
  test("derives stable traversal-safe keys for Bot directories and Sprites", () => {
    expect(computerBotKey("General")).toMatch(/^general-[a-f0-9]{12}$/);
    expect(computerBotKey("../../Health 🩺")).toMatch(/^health-[a-f0-9]{12}$/);
    expect(computerBotKey("General")).not.toBe(computerBotKey("general"));
    expect(() => computerBotKey("   ")).toThrow("1-200 characters");
    expect(flySpriteNameForBot("general", "frockbot")).toMatch(
      /^frockbot-[a-f0-9]{12}$/,
    );
    expect(flySpriteNameForBot("general", "frockbot")).not.toBe(
      flySpriteNameForBot("health", "frockbot"),
    );
    expect(
      flySpriteNameForBot("general", `f${"x".repeat(62)}`).length,
    ).toBeLessThanOrEqual(63);
    // ADR 0012: the Sprite name is derived from the User and nothing else, so
    // every Bot the User owns lands on the same Computer.
    expect(flySpriteNameForComputer({ userId: "owner" })).toBe(
      flySpriteNameForComputer({ userId: " owner " }),
    );
    expect(flySpriteNameForComputer({ userId: "owner" })).not.toBe(
      flySpriteNameForComputer({ userId: "owner-2" }),
    );
    expect(configuredFlyBotId({ FROCKBOT_BOT_ID: "  bot-7  " })).toBe("bot-7");
    expect(configuredFlyBotId({})).toBe("barebones");
  });

  test("provisions Bot workspaces and one token-routed noVNC gateway", async () => {
    const client = new FakeClient();
    const computer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });

    const general = await computer
      .bot({ id: "general", name: "General" })
      .ensure();
    const health = await computer.bot("health").ensure();

    expect(client.sprite.services[0]).toEqual({
      name: "frockbot-viewer-gateway",
      httpPort: 6080,
    });
    // The durable-root sync's watcher is declared beside the gateway, because
    // "Only Computer-provider-declared services may be reattached."
    expect(client.sprite.services[1]?.name).toBe("frockbot-workspace-sync");
    expect(client.sprite.services).toHaveLength(4);
    expect(client.sprite.services[2]?.name).toStartWith("frockbot-desktop-");
    expect(client.sprite.services[3]?.name).toStartWith("frockbot-desktop-");
    expect(client.sprite.services[2]?.name).not.toBe(
      client.sprite.services[3]?.name,
    );
    expect(client.sprite.services[2]?.name.length).toBeLessThanOrEqual(63);
    expect(client.sprite.services[3]?.name.length).toBeLessThanOrEqual(63);
    expect(client.sprite.auth).toBe("public");
    expect(general.botKey).not.toBe(health.botKey);
    expect(general.viewerUrl).toContain("/vnc.html#");
    expect(general.viewerUrl).toContain("password=secret-pass");
    expect(general.viewerUrl).toContain("websockify%3Ftoken%3Dsecret-token");
    const provision = client.sprite.commands[0]?.args.join(" ") ?? "";
    expect(provision).toContain("/home/box/agent-data");
    expect(provision).toContain("/workspaces");
    for (const path of [
      "/home/box/.frockbot/start-desktop.sh",
      "/home/box/.frockbot/ensure-agent.sh",
      "/home/box/.frockbot/control.sh",
      "/home/box/.frockbot/start-gateway.sh",
    ]) {
      await expectValidShell(installedScript(provision, path));
    }
  });

  test("runs shells from a Bot-private workspace with explicit identity", async () => {
    const client = new FakeClient();
    const agent = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    }).bot("General");

    expect(await agent.run("echo tool-output", signal())).toContain(
      "tool-output",
    );
    const command = client.sprite.commands.find(({ args }) =>
      args.at(-1)?.includes("echo tool-output"),
    );
    expect(command?.args.at(-1)).toContain("export HOME=/home/box");
    expect(command?.args.at(-1)).toContain("export FROCKBOT_BOT_ID='General'");
    expect(command?.args.at(-1)).toContain(
      `cd '/workspaces/${computerBotKey("General")}'`,
    );
  });

  test("blocks only the agent desktop that is under human control", async () => {
    const client = new FakeClient();
    const hostComputer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    const generalHost = hostComputer.bot("general");
    await generalHost.ensure();
    await generalHost.takeControl();

    const agentComputer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    const generalAgent = agentComputer.bot("general");
    await expect(
      generalAgent.run("echo tool-output", signal()),
    ).rejects.toThrow("user is controlling");
    const providerComputer = await new FlySpriteComputerProvider(
      agentComputer,
    ).open(
      { userId: "owner" },
      { botId: "general" },
      { providerId: "fly-sprite", generation: 1 },
    );
    await expect(
      providerComputer.workspace?.write({
        path: {
          root: {
            kind: "bot-instructions",
            userId: "owner",
            botId: "general",
          },
          path: "profile.md",
        },
        bytes: new TextEncoder().encode("remember"),
        // The handle is open for a Bot, so the Bot is the only writer it may
        // record.
        writer: {
          kind: "bot",
          botId: "general",
          sessionId: "session-1",
          turnId: "turn-1",
          runId: "run-1",
        },
        expectedGenerationId: null,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(
      await agentComputer.bot("health").run("echo tool-output", signal()),
    ).toContain("tool-output");

    await generalHost.releaseControl();
    expect(await generalAgent.run("echo tool-output", signal())).toContain(
      "tool-output",
    );
  });

  test("atomically grants an expired lease to one concurrent replacement", async () => {
    const client = new FakeClient();
    await new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    })
      .bot("general")
      .ensure();
    const provision = client.sprite.commands[0]?.args.at(-1) ?? "";
    const installed = installedScript(
      provision,
      "/home/box/.frockbot/control.sh",
    );
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
    const key = computerBotKey("general");
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

  test("opens durable files without provisioning a browser or public viewer", async () => {
    const client = new FakeClient();
    const provider = new FlySpriteComputerProvider(
      new FlySpriteComputer({ client, spriteName: "frockbot-test" }),
    );
    const computer = await provider.open(
      { userId: "owner" },
      { botId: "health" },
      { providerId: "fly-sprite", generation: 1 },
    );

    await computer.workspace?.write({
      path: {
        root: { kind: "bot-instructions", userId: "owner", botId: "health" },
        path: "profile.md",
      },
      bytes: new TextEncoder().encode("remember"),
      writer: { kind: "user", userId: "owner" },
      expectedGenerationId: null,
    });

    expect(client.sprite.services).toEqual([]);
    expect(client.sprite.auth).toBeUndefined();
  });

  // ADR 0012: one Sprite per User, every Bot a tenant on it. Two Bots resolve
  // to one provider Computer, one Sprite name, and one browser profile; only
  // their directories and desktops differ.
  test("puts two Bots of one User on one Sprite with one browser profile", async () => {
    const client = new FakeClient();
    const provider = new FlySpriteComputerProvider(undefined, "token");

    const first = provider.computerFor({ userId: "owner" });
    const second = provider.computerFor({ userId: "owner" });
    const other = provider.computerFor({ userId: "owner-2" });

    expect(first).toBe(second);
    expect(first.spriteName).toBe(
      flySpriteNameForComputer({ userId: "owner" }),
    );
    expect(other.spriteName).not.toBe(first.spriteName);

    const shared = new FlySpriteComputerProvider(
      new FlySpriteComputer({ client, spriteName: "frockbot-test" }),
    );
    const assignment = { providerId: "fly-sprite", generation: 1 };
    const health = await shared.open(
      { userId: "owner" },
      { botId: "health" },
      assignment,
    );
    const general = await shared.open(
      { userId: "owner" },
      { botId: "general" },
      assignment,
    );

    expect(health.identity).toEqual(general.identity);
    expect(health.assignment).toBe(general.assignment);
    expect(health.tenant.directory).not.toBe(general.tenant.directory);
    expect(health.tenant.directory).toBe(
      `agent-data/agents/${computerBotKey("health")}`,
    );

    await new FlySpriteComputer({ client, spriteName: "frockbot-test" })
      .bot("health")
      .ensure();
    const provision = client.sprite.commands[0]?.args.join(" ") ?? "";
    expect(provision).toContain("/home/box/chrome-profile ");
    expect(provision).not.toContain("chrome-profiles");
    const desktop = installedScript(
      provision,
      "/home/box/.frockbot/start-desktop.sh",
    );
    expect(desktop).toContain('--user-data-dir="/home/box/chrome-profile"');
  });

  test("adapts Fly execution through the provider-neutral Computer interface", async () => {
    const client = new FakeClient();
    const provider = new FlySpriteComputerProvider(
      new FlySpriteComputer({ client, spriteName: "frockbot-test" }),
    );
    const assignment = { providerId: "fly-sprite", generation: 1 };
    const computer = await provider.open(
      { userId: "owner" },
      { botId: "health" },
      assignment,
    );

    const result = await computer.exec?.execute(
      { executable: "/bin/bash", args: ["-lc", "pwd"] },
      { signal: signal() },
    );

    expect(result?.exitCode).toBe(0);
    expect(new TextDecoder().decode(result?.stdout)).toBe("");
    expect(new TextDecoder().decode(result?.stderr)).toBe("warning noise\n");
    expect(result?.outputTruncated).toBe(false);
    expect(
      client.sprite.commands.some(({ args }) =>
        args.at(-1)?.includes("bash -c 'pwd'"),
      ),
    ).toBe(true);

    const failed = await computer.exec?.execute(
      { executable: "/bin/bash", args: ["-lc", "echo boom; exit 7"] },
      { signal: signal() },
    );
    expect(failed?.exitCode).toBe(7);
    expect(new TextDecoder().decode(failed?.stdout)).toBe("boom");

    await expect(
      computer.exec?.execute(
        { executable: "env", cwd: "/tmp" },
        { signal: signal() },
      ),
    ).rejects.toThrow("does not support cwd");
    await expect(
      computer.browser?.perform({ type: "snapshot" }, { signal: signal() }),
    ).resolves.toMatchObject({
      url: "https://example.com",
      accessibilitySnapshot: "- heading",
    });

    const skills = {
      kind: "bot-instructions",
      userId: "owner",
      botId: "health",
    } as const;
    const written = await computer.workspace?.write({
      path: { root: skills, path: "profile.md" },
      bytes: new TextEncoder().encode("remember"),
      // The handle is open for a Bot, so the Bot is the only writer it may
      // record.
      writer: {
        kind: "bot",
        botId: "health",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
      },
      expectedGenerationId: null,
    });
    const stored = await computer.workspace?.read({
      root: skills,
      path: "profile.md",
    });

    expect(written).toMatchObject({ status: "ok" });
    expect(stored).toMatchObject({ status: "ok" });
    expect(
      await computer.workspace?.read({ root: skills, path: "missing.md" }),
    ).toMatchObject({ status: "not-found" });
    // The mount path comes from the declared layout and matches the GrokBot
    // parity layout: durable per-Bot state under agent-data/agents/<key>.
    expect(
      client.sprite.commands.some(({ args }) =>
        args
          .at(-1)
          ?.includes(
            `ROOT='/home/box/agent-data/agents/${computerBotKey("health")}/skills'`,
          ),
      ),
    ).toBe(true);
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-fly-sprite",
      contributionKinds: ["runtime", "desktop"],
    });
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
    const client = new FakeClient();
    await new FlySpriteComputer({ client, spriteName: "frockbot-test" })
      .bot("general")
      .ensure();
    const provision = client.sprite.commands[0]?.args.at(-1) ?? "";
    const installed = installedScript(
      provision,
      "/home/box/.frockbot/ensure-agent.sh",
    );
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

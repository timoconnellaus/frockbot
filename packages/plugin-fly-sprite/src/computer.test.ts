/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SystemPromptRegistry, ToolRegistry } from "@frockbot/agent-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { createFlySpriteAgentPlugin } from "./agent.ts";
import {
  computerAgentKey,
  FlySpriteComputer,
  type SpriteHandle,
  type SpriteServiceStream,
  type SpritesClientHandle,
} from "./computer.ts";

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
      if (lease?.fresh) {
        return Promise.reject(
          new Error("The user is controlling this agent's computer"),
        );
      }
      this.leases.delete(guardedKey);
    }
    if (shell.includes("echo tool-output")) {
      return Promise.resolve({ stdout: "tool-output\n", stderr: "" });
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
    if (shell.includes("## Agent standing memory")) {
      return Promise.resolve({
        stdout:
          "## Agent standing memory\nUser likes concise answers.\n## Shared user memory\nTimezone: Australia/Sydney.\n",
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
  test("derives stable traversal-safe keys for agent directories", () => {
    expect(computerAgentKey("General")).toMatch(/^general-[a-f0-9]{12}$/);
    expect(computerAgentKey("../../Health 🩺")).toMatch(
      /^health-[a-f0-9]{12}$/,
    );
    expect(computerAgentKey("General")).not.toBe(computerAgentKey("general"));
    expect(() => computerAgentKey("   ")).toThrow("1-200 characters");
  });

  test("provisions shared data roots and one token-routed noVNC gateway", async () => {
    const client = new FakeClient();
    const computer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });

    const general = await computer
      .agent({ id: "general", name: "General" })
      .ensure();
    const health = await computer.agent("health").ensure();

    expect(client.sprite.services[0]).toEqual({
      name: "frockbot-viewer-gateway",
      httpPort: 6080,
    });
    expect(client.sprite.services).toHaveLength(3);
    expect(client.sprite.services[1]?.name).toStartWith("frockbot-desktop-");
    expect(client.sprite.services[2]?.name).toStartWith("frockbot-desktop-");
    expect(client.sprite.services[1]?.name).not.toBe(
      client.sprite.services[2]?.name,
    );
    expect(client.sprite.services[1]?.name.length).toBeLessThanOrEqual(63);
    expect(client.sprite.services[2]?.name.length).toBeLessThanOrEqual(63);
    expect(client.sprite.auth).toBe("public");
    expect(general.agentKey).not.toBe(health.agentKey);
    expect(general.viewerUrl).toContain("/vnc.html#");
    expect(general.viewerUrl).toContain("password=secret-pass");
    expect(general.viewerUrl).toContain("websockify%3Ftoken%3Dsecret-token");
    const provision = client.sprite.commands[0]?.args.join(" ") ?? "";
    expect(provision).toContain("/home/box/agent-data");
    expect(provision).toContain("/workspace");
    for (const path of [
      "/home/box/.frockbot/start-desktop.sh",
      "/home/box/.frockbot/ensure-agent.sh",
      "/home/box/.frockbot/control.sh",
      "/home/box/.frockbot/start-gateway.sh",
    ]) {
      await expectValidShell(installedScript(provision, path));
    }
  });

  test("runs shells from shared scratch with explicit bot identity", async () => {
    const client = new FakeClient();
    const agent = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    }).agent("General");

    expect(await agent.run("echo tool-output", signal())).toContain(
      "tool-output",
    );
    const command = client.sprite.commands.find(({ args }) =>
      args.at(-1)?.includes("echo tool-output"),
    );
    expect(command?.args.at(-1)).toContain("export HOME=/home/box");
    expect(command?.args.at(-1)).toContain(
      "export FROCKBOT_AGENT_ID='General'",
    );
    expect(command?.args.at(-1)).toContain("cd /workspace");
  });

  test("blocks only the agent desktop that is under human control", async () => {
    const client = new FakeClient();
    const hostComputer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    const generalHost = hostComputer.agent("general");
    await generalHost.ensure();
    await generalHost.takeControl();

    const agentComputer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    const generalAgent = agentComputer.agent("general");
    await expect(
      generalAgent.run("echo tool-output", signal()),
    ).rejects.toThrow("user is controlling");
    await expect(generalAgent.readStandingMemory()).rejects.toThrow(
      "user is controlling",
    );
    await expect(generalAgent.writeTranscript([])).rejects.toThrow(
      "user is controlling",
    );
    expect(
      await agentComputer.agent("health").run("echo tool-output", signal()),
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
      .agent("general")
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
      [
        "#!/usr/bin/env python3",
        "import os, sys",
        "print(int(os.stat(sys.argv[-1]).st_mtime))",
        "",
      ].join("\n"),
    );
    await Promise.all([
      chmod(scriptPath, 0o700),
      chmod(flockPath, 0o700),
      chmod(statPath, 0o700),
    ]);
    const key = computerAgentKey("general");
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

  test("materializes profiles, recalls standing memory, and mirrors transcripts", async () => {
    const client = new FakeClient();
    const agent = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    }).agent({
      id: "General",
      name: "General assistant",
      description: "Handles everyday requests",
    });

    await agent.ensure();
    expect(await agent.readStandingMemory()).toContain(
      "User likes concise answers.",
    );
    await agent.writeTranscript([
      { seq: 0, type: "session/created" },
      { seq: 1, type: "user/message", text: "hello" },
    ]);

    const ensure = client.sprite.commands.find(({ file }) =>
      file.endsWith("/ensure-agent.sh"),
    );
    const profile = JSON.parse(
      Buffer.from(ensure?.args[1] ?? "", "base64").toString(),
    ) as {
      id?: string;
      name?: string;
      description?: string;
      computer?: { agentKey?: string; sharedHome?: string };
    };
    expect(profile).toEqual({
      id: "General",
      name: "General assistant",
      description: "Handles everyday requests",
      computer: {
        agentKey: computerAgentKey("General"),
        sharedHome: "/home/box",
      },
    });
    const transcript = client.sprite.commands.find(
      ({ args }) =>
        args.at(-1)?.includes("/agent-transcripts/") &&
        args.at(-1)?.includes("latest.json"),
    );
    const encoded = /printf %s '([^']+)'/.exec(
      transcript?.args.at(-1) ?? "",
    )?.[1];
    expect(JSON.parse(Buffer.from(encoded ?? "", "base64").toString())).toEqual(
      [
        { seq: 0, type: "session/created" },
        { seq: 1, type: "user/message", text: "hello" },
      ],
    );
  });

  test("routes executable computer tools through the explicit agent id", async () => {
    const client = new FakeClient();
    const computer = new FlySpriteComputer({
      client,
      spriteName: "frockbot-test",
    });
    const harness = await createPluginHarness([
      ToolRegistry,
      SystemPromptRegistry,
    ]);
    await harness.mount(createFlySpriteAgentPlugin(computer));

    const context = {
      agentId: "Health",
      sessionId: "owner:health:conversation-1",
      signal: signal(),
    };
    const exec = await harness.root.tools.prepare(
      { id: "exec", name: "computer_exec", input: { command: "pwd" } },
      context,
    );
    expect(exec.kind).toBe("ready");
    if (exec.kind === "ready") {
      expect(
        await harness.root.tools.executePrepared(exec, context),
      ).toMatchObject({ isError: false });
    }
    const shell = client.sprite.commands.find(({ args }) =>
      args.at(-1)?.includes("\npwd"),
    );
    expect(shell?.args.at(-1)).toContain("FROCKBOT_AGENT_ID='Health'");
    const prompt = await harness.root.systemPrompt.assemble({
      sessionId: context.sessionId,
      provider: "fixture",
      model: "fixture",
    });
    expect(prompt.text).toContain("Never invent a directory listing");
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-fly-sprite",
      contributionKinds: ["runtime", "client", "desktop"],
    });
  });
});

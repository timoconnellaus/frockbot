/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { verifyPluginPackage } from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import {
  computerBotKey,
  FlySpriteComputer,
  flySpriteNameForBot,
  type ComputerHostFactoryV1,
} from "./computer.ts";
import { FakeComputerHost, type FakeComputerRunV1 } from "./host-double.ts";
import { configuredFlyBotId } from "./host.ts";
import {
  FlySpriteComputerProvider,
  flySpriteNameForComputer,
} from "./provider.ts";

// The Computer's own shell scripts — the provisioning document, `control.sh`'s
// `flock` lease, and `ensure-agent.sh`'s slot reclaim — are run for real in
// `@frockbot/computer-host-runtime`'s suite. They moved there with the scripts
// themselves (ADR 0004): a Bot Durable Object no longer installs them, so a
// test that stood up a provider to read one out of a provisioning command was
// testing the wrong module. What is left here is this Package's own subject:
// what a Bot tenant means on a Computer, and what the provider-neutral
// Computer interface answers.

/** The interpreter every suite fixture shares, over the script it was sent. */
function computerRunner(script: string): FakeComputerRunV1 {
  if (script.includes("__FROCKBOT_EXIT__")) {
    return {
      stdout: script.includes("exit 7")
        ? "boom\n__FROCKBOT_EXIT__7\n"
        : "\n__FROCKBOT_EXIT__0\n",
      stderr: "warning noise\n",
    };
  }
  if (script.includes("echo tool-output")) return { stdout: "tool-output\n" };
  if (script.includes("missing.md")) return { stdout: "__MISSING__\n" };
  if (script.includes('rm -f "$TARGET"')) {
    return { stdout: "__DELETED__\n", stderr: "bash: /etc/profile: noise\n" };
  }
  if (script.includes('find "$ROOT"')) {
    const offset = Number(/OFFSET=(\d+)/.exec(script)?.[1] ?? 0);
    const limit = Number(/LIMIT=(\d+)/.exec(script)?.[1] ?? 100);
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
    return {
      stdout: `${lines.slice(offset, offset + limit + 1).join("\n")}\n`,
    };
  }
  if (script.includes('mv "$TMP" "$TARGET"'))
    return { stdout: "__WRITTEN__\n" };
  if (script.includes('base64 -w0 "$TARGET"')) {
    // meta, content hash, size, mtime, bytes — the Workspace file shape.
    return {
      stdout: [
        "",
        "0".repeat(64),
        "8",
        "1700000000",
        Buffer.from("remember").toString("base64"),
        "",
      ].join("\n"),
    };
  }
  if (script.includes("browser.mjs")) {
    return {
      stdout: JSON.stringify({
        url: "https://example.com",
        snapshot: "- heading",
      }),
    };
  }
  return {};
}

function fakeHost(): FakeComputerHost {
  return new FakeComputerHost(computerRunner);
}

function attach(host: FakeComputerHost): FlySpriteComputer {
  return new FlySpriteComputer({
    identity: { userId: "owner" },
    host: host.factory,
    spriteName: "frockbot-test",
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** A host that refuses to provision anything, to prove nothing asked it to. */
function storageOnlyHost(host: FakeComputerHost): ComputerHostFactoryV1 {
  return (identity, tenant) => {
    const surface = host.surface(tenant.botId);
    void identity;
    return {
      ...surface,
      open: () =>
        Promise.reject(new Error("Workspace access must not open a desktop")),
      viewer: () =>
        Promise.reject(new Error("Workspace access must not publish a viewer")),
    };
  };
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

  test("attaches each Bot as its own tenant with its own viewer", async () => {
    const host = fakeHost();
    const computer = attach(host);

    const general = await computer
      .bot({ id: "general", name: "General" })
      .ensure();
    const health = await computer.bot("health").ensure();

    expect(general.botKey).not.toBe(health.botKey);
    expect(general.spriteName).toBe("frockbot-test");
    expect(general.directory).toBe(
      `agent-data/agents/${computerBotKey("general")}`,
    );
    expect(general.display).toBe(":100");
    expect(general.viewerUrl).toContain("/vnc.html#");
    expect(general.viewerUrl).toContain("password=secret-pass");
    // A viewer per tenant, opened on the host — the token and the VNC password
    // never leave the Computer except inside this URL.
    expect(host.viewerSessions.map(({ action }) => action)).toEqual([
      "open",
      "open",
    ]);
    expect(computer.displayForTenant(computerBotKey("general"))).toBe(":100");
  });

  test("an unconfigured Computer refuses rather than pretending", async () => {
    const computer = new FlySpriteComputer({ spriteName: "frockbot-test" });
    expect(computer.configured).toBe(false);
    await expect(computer.bot("general").ensure()).rejects.toThrow(
      "Set SPRITES_TOKEN",
    );
  });

  test("runs shells from a Bot-private workspace with explicit identity", async () => {
    const host = fakeHost();
    const agent = attach(host).bot("General");

    expect(await agent.run("echo tool-output", signal())).toContain(
      "tool-output",
    );
    const script = host.scripts.find((candidate) =>
      candidate.includes("echo tool-output"),
    );
    expect(script).toContain("export HOME=/home/box");
    expect(script).toContain("export FROCKBOT_BOT_ID='General'");
    expect(script).toContain(`cd '/workspaces/${computerBotKey("General")}'`);
    // The script is the request body, not an argv. That is the whole point of
    // the host seam: a ~2 KB argv is what answered HTTP 431 (ADR 0004).
    expect(host.commands.at(-1)?.script).toBe(script);
  });

  test("blocks only the agent desktop that is under human control", async () => {
    // One Computer, two clients of it — a human's and a Bot's — exactly as one
    // Sprite's `flock` is shared across everything that reaches it.
    const host = fakeHost();
    const hostComputer = attach(host);
    const generalHost = hostComputer.bot("general");
    await generalHost.ensure();
    await generalHost.takeControl();

    const agentComputer = attach(host);
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

  test("opens durable files without provisioning a browser or public viewer", async () => {
    const host = fakeHost();
    const provider = new FlySpriteComputerProvider(
      new FlySpriteComputer({
        identity: { userId: "owner" },
        host: storageOnlyHost(host),
        spriteName: "frockbot-test",
      }),
    );
    const computer = await provider.open(
      { userId: "owner" },
      { botId: "health" },
      { providerId: "fly-sprite", generation: 1 },
    );

    // The host would throw if this reached `open` or `viewer`: "The Agent
    // loop, Memory, Skills, Package composition, and Routines function
    // correctly while the Computer is hibernated and do not wake it."
    await expect(
      computer.workspace?.write({
        path: {
          root: { kind: "bot-instructions", userId: "owner", botId: "health" },
          path: "profile.md",
        },
        bytes: new TextEncoder().encode("remember"),
        writer: {
          kind: "bot",
          botId: "health",
          sessionId: "session-1",
          turnId: "turn-1",
          runId: "run-1",
        },
        expectedGenerationId: null,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(host.viewerSessions).toEqual([]);
  });

  // ADR 0012: one Sprite per User, every Bot a tenant on it. Two Bots resolve
  // to one provider Computer, one Sprite name, and one browser profile; only
  // their directories and desktops differ.
  test("puts two Bots of one User on one Sprite", async () => {
    const host = fakeHost();
    const provider = new FlySpriteComputerProvider(undefined, host.factory);

    const first = provider.computerFor({ userId: "owner" });
    const second = provider.computerFor({ userId: "owner" });
    const other = provider.computerFor({ userId: "owner-2" });

    expect(first).toBe(second);
    expect(first.spriteName).toBe(
      flySpriteNameForComputer({ userId: "owner" }),
    );
    expect(other.spriteName).not.toBe(first.spriteName);

    const shared = new FlySpriteComputerProvider(attach(host));
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
  });

  test("adapts Fly execution through the provider-neutral Computer interface", async () => {
    const host = fakeHost();
    const provider = new FlySpriteComputerProvider(attach(host));
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
      host.scripts.some((script) => script.includes("bash -c 'pwd'")),
    ).toBe(true);

    const failed = await computer.exec?.execute(
      { executable: "/bin/bash", args: ["-lc", "echo boom; exit 7"] },
      { signal: signal() },
    );
    expect(failed?.exitCode).toBe(7);
    expect(new TextDecoder().decode(failed?.stdout)).toBe("boom");

    // `cwd`, `env`, and `stdin` were refused while every one of them had to
    // travel in a request URL. The host compiles them into the script it
    // delivers on the command's stdin, so they are ordinary now.
    await computer.exec?.execute(
      {
        executable: "env",
        cwd: "/tmp",
        env: { FROCKBOT_PROBE: "yes" },
        stdin: new TextEncoder().encode("piped\n"),
      },
      { signal: signal() },
    );
    // The composed document reaches the tenant's shell inside `bash -c`, so
    // its own quoting is escaped once here. What matters is that all three
    // travel in the script and none of them in an argument list.
    const composed = host.scripts.at(-1) ?? "";
    expect(composed).toContain("export FROCKBOT_PROBE=");
    expect(composed).toContain("yes");
    expect(composed).toContain("/tmp");
    expect(composed).toContain("piped\n");
    expect(composed).toMatch(/FROCKBOT_STDIN_[0-9A-F]{16}/);

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
      host.scripts.some((script) =>
        script.includes(
          `ROOT='/home/box/agent-data/agents/${computerBotKey("health")}/skills'`,
        ),
      ),
    ).toBe(true);
  });

  test("a viewer and a control lease are reachable from the Durable Object", async () => {
    const host = fakeHost();
    const provider = new FlySpriteComputerProvider(attach(host));
    const computer = await provider.open(
      { userId: "owner" },
      { botId: "health" },
      { providerId: "fly-sprite", generation: 1 },
    );

    // Neither was reachable before: both need the Sprite's URL and its
    // `flock`, and neither was reachable from workerd (ADR 0004).
    const session = await computer.viewer?.open({ signal: signal() });
    expect(session?.url).toContain("/vnc.html#");

    const lease = await computer.control?.acquire({ signal: signal() });
    expect(lease?.id).toBeTruthy();
    expect(Date.parse(lease?.expiresAt ?? "")).toBeGreaterThan(Date.now());
    const renewed = await computer.control?.renew(lease!, { signal: signal() });
    expect(renewed?.id).toBe(lease?.id);
    await computer.control?.release(lease!, { signal: signal() });
    expect(host.leases.size).toBe(0);
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-fly-sprite",
      contributionKinds: ["runtime", "desktop"],
    });
  });
});

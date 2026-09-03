import { describe, expect, test } from "bun:test";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import {
  ComputerError,
  ComputerRegistry,
  type ComputerProvider,
} from "@frockbot/computer-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import { SessionStore } from "@frockbot/kernel-contracts";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import {
  createComputerAgentPlugin,
  HUMAN_CONTROL_PROMPT_LINE,
} from "./agent.js";
import { COMPUTER_CONTROL_RECORD_KEY } from "./control-record.js";

async function execute(
  harness: Awaited<ReturnType<typeof createPluginHarness>>,
  name: string,
  input: unknown,
) {
  const context = {
    botId: "bot-1",
    agentId: "run-9",
    compositionGenerationId: "bootstrap",
    turnType: "chat" as const,
    sessionId: "session-1",
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
  };
  const prepared = await harness.root.tools.prepare(
    { id: crypto.randomUUID(), name, input },
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.root.tools.executePrepared(prepared, context);
}

describe("computer agent contribution", () => {
  test("routes generic tools through the Bot's selected Computer provider", async () => {
    const calls: string[] = [];
    const provider: ComputerProvider = {
      id: "fixture",
      open: async (identity, tenant, assignment) => {
        calls.push(`open:${identity.userId}:${tenant.botId}`);
        return {
          assignment,
          identity,
          tenant,
          exec: {
            execute: async (request) => {
              calls.push(
                `exec:${request.executable}:${request.args?.join(" ")}`,
              );
              return {
                exitCode: 0,
                stdout: new TextEncoder().encode("/workspace/bot-1"),
                stderr: new Uint8Array(),
                outputTruncated: false,
              };
            },
          },
          browser: {
            perform: async (action) => {
              calls.push(`browser:${action.type}`);
              return { accessibilitySnapshot: "button: Continue" };
            },
          },
          close: () => Promise.resolve(),
        };
      },
    };
    const harness = await createPluginHarness([
      ComputerRegistry,
      ToolRegistry,
      SystemPromptRegistry,
      SessionStore,
    ]);
    harness.root.computers.register(provider);
    await harness.mount(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    const exec = await execute(harness, "computer_exec", { command: "pwd" });
    const browser = await execute(harness, "computer_browser", {
      action: "snapshot",
    });

    expect(exec).toMatchObject({ content: "/workspace/bot-1", isError: false });
    expect(browser).toMatchObject({
      content: "button: Continue",
      isError: false,
    });
    expect(calls).toEqual([
      "open:user-1:bot-1",
      "exec:/bin/bash:-lc pwd",
      "open:user-1:bot-1",
      "browser:snapshot",
    ]);
    await harness.dispose();
  });

  test("computer_exec during an update returns an actionable tool failure", async () => {
    const provider: ComputerProvider = {
      id: "fixture",
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        exec: {
          execute: async () => {
            throw new ComputerError(
              "updating",
              "Updating the Computer runtime",
              true,
            );
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = await createPluginHarness([
      ComputerRegistry,
      ToolRegistry,
      SystemPromptRegistry,
      SessionStore,
    ]);
    harness.root.computers.register(provider);
    await harness.mount(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    const result = await execute(harness, "computer_exec", { command: "pwd" });

    expect(result).toEqual({
      content:
        "The Computer is updating (Updating the Computer runtime); try again shortly",
      isError: true,
    });
    await harness.dispose();
  });

  test("injects and records the human-control line only while the durable lease is fresh", async () => {
    const records = new Map<string, unknown>([
      [
        COMPUTER_CONTROL_RECORD_KEY,
        {
          version: 1,
          ownerId: "human:session-1",
          acquiredAt: "2026-09-02T00:00:00.000Z",
          expiresAt: "2026-09-02T00:01:30.000Z",
        },
      ],
    ]);
    let now = new Date("2026-09-02T00:00:30.000Z");
    const harness = await createPluginHarness([
      ComputerRegistry,
      ToolRegistry,
      SystemPromptRegistry,
      SessionStore,
    ]);
    await harness.mount(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "fixture",
        controlRecords: {
          get: <T>(key: string) =>
            Promise.resolve(records.get(key) as T | undefined),
          now: () => now,
        },
      }),
    );
    const session = harness.root.sessions.create("session-1");
    const preStep = (turn: number) =>
      harness.root.waterfall(
        "agent/pre-step",
        { session } as never,
        [],
        turn,
        1,
        () => Promise.resolve({ kind: "enter" as const, inputs: [] }),
      );
    const assemble = () =>
      harness.root.systemPrompt.assemble({
        sessionId: "session-1",
        provider: "fixture",
        model: "fixture",
        turnType: "chat",
      });

    await preStep(1);
    expect((await assemble()).text).toContain(HUMAN_CONTROL_PROMPT_LINE);
    now = new Date("2026-09-02T00:02:00.000Z");
    await preStep(2);
    expect((await assemble()).text).not.toContain(HUMAN_CONTROL_PROMPT_LINE);

    const injected = session.events.filter(
      (event) => event.type === "computer/injected",
    );
    expect(injected).toMatchObject([
      {
        type: "computer/injected",
        turn: 1,
        text: HUMAN_CONTROL_PROMPT_LINE,
        ownerId: "human:session-1",
        expiresAt: "2026-09-02T00:01:30.000Z",
      },
      { type: "computer/injected", turn: 2, text: "" },
    ]);
    await harness.dispose();
  });

  test("human-control-active is a non-throwing actionable tool result", async () => {
    const provider: ComputerProvider = {
      id: "fixture",
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        exec: {
          execute: async () => {
            throw new ComputerError(
              "human-control-active",
              "held by human:session-1",
            );
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = await createPluginHarness([
      ComputerRegistry,
      ToolRegistry,
      SystemPromptRegistry,
      SessionStore,
    ]);
    harness.root.computers.register(provider);
    await harness.mount(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    await expect(
      execute(harness, "computer_exec", { command: "pwd" }),
    ).resolves.toEqual({
      content: "held by human:session-1; do not retry this Turn",
      isError: true,
    });
    await harness.dispose();
  });

  test("an unconfigured deployment offers no Computer tool and no Computer prompt", async () => {
    const harness = await createPluginHarness([
      ComputerRegistry,
      ToolRegistry,
      SystemPromptRegistry,
      SessionStore,
    ]);
    await harness.mount(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "fixture",
        configured: false,
      }),
    );

    const registered = harness.root.tools.registeredNames?.() ?? [];
    expect(registered.filter((name) => name.startsWith("computer_"))).toEqual(
      [],
    );
    const prompt = await harness.root.systemPrompt.assemble({
      sessionId: "session-1",
      provider: "fixture",
      model: "fixture",
      turnType: "chat",
    });
    expect(prompt.text).not.toContain("Persistent Computer");
    expect(prompt.text).not.toContain("computer_exec");
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-computer",
      contributionKinds: ["backend", "runtime", "client"],
    });
  });
});

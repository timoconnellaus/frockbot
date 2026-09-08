import { describe, expect, test } from "bun:test";
import { ComputerError } from "@frockbot/computer/core";
import {
  type ComputerHostV1,
  type ComputerHostCapabilitiesV1,
} from "@frockbot/computer/core/host";
import {
  type AgentRuntimeHarness,
  createAgentRuntimeHarness,
} from "@frockbot/app/testkit";
import {
  COMPUTER_OVERLOADED_TOOL_MESSAGE_V1,
  createComputerAgentFeature,
  HUMAN_CONTROL_PROMPT_LINE,
} from "./agent.js";
import { COMPUTER_CONTROL_RECORD_KEY } from "./control-record.js";

/** A host that offers nothing beyond the operations under test. */
const TEST_HOST_CAPABILITIES: ComputerHostCapabilitiesV1 = {
  viewerFrameOrigins: [],
};

async function execute(
  harness: AgentRuntimeHarness,
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
  const prepared = await harness.tools.prepare(
    { id: crypto.randomUUID(), name, input },
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.tools.executePrepared(prepared, context);
}

describe("computer agent contribution", () => {
  test("routes generic tools through the Bot's selected Computer provider", async () => {
    const calls: string[] = [];
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => {
        calls.push(`open:${identity.userId}:${tenant.botId}`);
        return {
          assignment,
          identity,
          tenant,
          capabilities: TEST_HOST_CAPABILITIES,
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
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
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

  test("computer_browser says which field a click is missing and takes label as name", async () => {
    const calls: string[] = [];
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        exec: {
          execute: async () => ({
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            outputTruncated: false,
          }),
        },
        browser: {
          perform: async (action) => {
            calls.push(JSON.stringify(action));
            return { accessibilitySnapshot: 'checkbox "Mark done"' };
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    // Bob's first three attempts on production, in order.
    const onlyName = await execute(harness, "computer_browser", {
      action: "click",
      name: "Add",
    });
    expect(onlyName.isError).toBe(true);
    expect(onlyName.content).toContain("role and name are both required");
    expect(onlyName.content).toContain('"role":"button"');

    const onlyLabel = await execute(harness, "computer_browser", {
      action: "click",
      label: "Add",
    });
    expect(onlyLabel.isError).toBe(true);

    const labelWithRole = await execute(harness, "computer_browser", {
      action: "click",
      label: "Mark done",
      role: "checkbox",
    });
    expect(labelWithRole.isError).toBe(false);
    expect(calls).toEqual([
      JSON.stringify({ type: "click", role: "checkbox", name: "Mark done" }),
    ]);

    const unknown = await execute(harness, "computer_browser", {
      action: "hover",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('"action" must be one of');
    await harness.dispose();
  });

  // Production, 2026-09-04: the model sent a `cwd` the tool did not have, the
  // key was dropped without a word, and `cat server.ts` ran in the home
  // directory. Four steps went into working that out. The directory is carried
  // now, and an argument the tool does not know is refused by name.
  test("computer_exec runs in the cwd it is given and names an argument it does not know", async () => {
    const requests: Array<{ cwd?: string; command?: string }> = [];
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        exec: {
          execute: async (request) => {
            requests.push({
              ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
              ...(request.args?.[1] === undefined
                ? {}
                : { command: request.args[1] }),
            });
            return {
              exitCode: 0,
              stdout: new TextEncoder().encode("server.ts ui.tsx"),
              stderr: new Uint8Array(),
              outputTruncated: false,
            };
          },
        },
        close: () => Promise.resolve(),
      }),
    };
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    const listed = await execute(harness, "computer_exec", {
      command: "ls",
      cwd: "/home/box/agent-data/source/todo",
    });
    expect(listed).toMatchObject({
      content: "server.ts ui.tsx",
      isError: false,
    });
    expect(requests).toEqual([
      { cwd: "/home/box/agent-data/source/todo", command: "ls" },
    ]);

    const relative = await execute(harness, "computer_exec", {
      command: "ls",
      cwd: "todo",
    });
    expect(relative.isError).toBe(true);
    expect(relative.content).toContain('"cwd" must be an absolute path');

    const misspelled = await execute(harness, "computer_exec", {
      command: "ls",
      directory: "/home/box",
    });
    expect(misspelled.isError).toBe(true);
    expect(misspelled.content).toContain('"directory"');
    expect(misspelled.content).toContain('It takes "command"');
    // Refused, never run with the argument quietly dropped.
    expect(requests).toHaveLength(1);
    await harness.dispose();
  });

  test("computer_exec during an update returns an actionable tool failure", async () => {
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
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
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
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

  test("computer_exec maps overloaded transport failures to one bounded plain reason", async () => {
    for (const message of [
      "Computer command failed: WebSocket keepalive timeout after 45000ms",
      "The Computer effect was cancelled",
    ]) {
      const provider: ComputerHostV1 = {
        id: "fixture",
        capabilities: TEST_HOST_CAPABILITIES,
        open: async (identity, tenant, assignment) => ({
          assignment,
          identity,
          tenant,
          capabilities: TEST_HOST_CAPABILITIES,
          exec: {
            execute: () => Promise.reject(new Error(message)),
          },
          close: () => Promise.resolve(),
        }),
      };
      const harness = createAgentRuntimeHarness();
      harness.computers.register(provider);
      await harness.mount(
        createComputerAgentFeature({
          userId: "user-1",
          defaultProviderId: "fixture",
        }),
      );

      await expect(
        execute(harness, "computer_exec", { command: "pwd" }),
      ).resolves.toEqual({
        content: COMPUTER_OVERLOADED_TOOL_MESSAGE_V1,
        isError: true,
      });
      expect(COMPUTER_OVERLOADED_TOOL_MESSAGE_V1.length).toBeLessThanOrEqual(
        160,
      );
      await harness.dispose();
    }
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
    const harness = createAgentRuntimeHarness();
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
        controlRecords: {
          get: <T>(key: string) =>
            Promise.resolve(records.get(key) as T | undefined),
          now: () => now,
        },
      }),
    );
    const session = harness.sessions.create("session-1");
    const preStep = (turn: number) =>
      harness.hooks.preStep({ session } as never, [], turn, 1, () =>
        Promise.resolve({ kind: "enter" as const, inputs: [] }),
      );
    const assemble = () =>
      harness.systemPrompt.assemble({
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
    const provider: ComputerHostV1 = {
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
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
    const harness = createAgentRuntimeHarness();
    harness.computers.register(provider);
    await harness.mount(
      createComputerAgentFeature({
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
    const harness = createAgentRuntimeHarness();
    await harness.mount(
      createComputerAgentFeature({
        userId: "user-1",
        defaultProviderId: "fixture",
        configured: false,
      }),
    );

    const registered = harness.tools.registeredNames?.() ?? [];
    expect(registered.filter((name) => name.startsWith("computer_"))).toEqual(
      [],
    );
    const prompt = await harness.systemPrompt.assemble({
      sessionId: "session-1",
      provider: "fixture",
      model: "fixture",
      turnType: "chat",
    });
    expect(prompt.text).not.toContain("Persistent Computer");
    expect(prompt.text).not.toContain("computer_exec");
    await harness.dispose();
  });
});

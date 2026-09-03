import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeSessionEvent,
  LlmEffectNotStartedError,
  type LlmReconciliationOutcome,
  type LlmProvider,
  type NormalizedModelRequest,
  type LlmStreamEvent,
  type PersistSessionEvents,
  type SessionEvent,
  SessionStore,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { AgentRegistry, type AgentOptions } from "./agent.js";
import { Context, type Plugin } from "cordis";
import { AgentLoop } from "./index.js";

const roots: Context[] = [];
const allowEffect = () => Promise.resolve(true);
const allowEffectOptions = { admitEffect: allowEffect };

type RecoverableToolDefinition = ToolDefinition & {
  reconcile(
    input: unknown,
    context: ToolExecutionContext & { effectId: string },
  ): Promise<
    | { status: "recovered"; result: { content: string; isError: boolean } }
    | { status: "unavailable"; reason: string }
  >;
};

function recovered(
  ...events: LlmStreamEvent[]
): Promise<LlmReconciliationOutcome> {
  return Promise.resolve({
    status: "recovered",
    events,
  });
}

const TEST_COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

async function mountRuntime(
  provider: LlmProvider,
  tool?: ToolDefinition | ToolDefinition[],
  persistEvents?: PersistSessionEvents,
  initialSessions?: Record<string, SessionEvent[]>,
): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(SessionStore, { persistEvents, initialSessions });
  await root.plugin(SystemPromptRegistry);
  await root.plugin(LlmRegistry);
  await root.plugin(ToolRegistry);
  await root.plugin(AgentRegistry);

  const promptPlugin: Plugin.Function = (ctx) =>
    ctx.systemPrompt.register({
      id: "identity",
      render: () => "You are the FrockBot test agent.",
    });
  promptPlugin.inject = ["systemPrompt"];
  const providerPlugin: Plugin.Function = (ctx) => ctx.llm.register(provider);
  providerPlugin.inject = ["llm"];
  await root.plugin(promptPlugin);
  await root.plugin(providerPlugin);

  if (tool) {
    const tools = Array.isArray(tool) ? tool : [tool];
    const toolPlugin: Plugin.Function = (ctx) => {
      for (const definition of tools) ctx.tools.register(definition);
    };
    toolPlugin.inject = ["tools"];
    await root.plugin(toolPlugin);
  }
  await root.plugin(AgentLoop, {
    maxSteps: 4,
    composition: TEST_COMPOSITION,
  });
  return root;
}

function openToolSessionEvents(
  provider: string,
  toolName: string,
): SessionEvent[] {
  const timestamp = "2026-08-30T00:00:00.000Z";
  return [
    { type: "session/created", createdAt: timestamp },
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "model/request",
      turn: 1,
      step: 1,
      request: {
        requestId: "tool-model-request",
        provider,
        model: "test-model",
        system: "",
        messages: [],
        tools: [],
      },
    },
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "tool-model-request",
      text: "",
      toolCalls: [{ id: "provider-call", name: toolName, input: {} }],
    },
    {
      type: "tool/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: toolName,
      input: {},
    },
  ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
}

async function eventually(
  assertion: () => void,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latestError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw latestError;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("AgentLoop", () => {
  test("records exactly the hook-shaped request received by the provider", async () => {
    let received: NormalizedModelRequest | undefined;
    const provider: LlmProvider = {
      id: "hook-shaped-request",
      async *stream(request) {
        received = structuredClone(request);
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider, {
      name: "original_tool",
      description: "The initially exposed tool.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "ok", isError: false }),
    });
    root.on("system-prompt/assemble", async (_context, next) => {
      const assembly = await next();
      return {
        text: `${assembly.text}\nHook-shaped system context.`,
        sections: [
          ...assembly.sections,
          { id: "hook", text: "Hook-shaped system context." },
        ],
      };
    });
    root.on(
      "agent/message-window",
      async (_agent, messages, _turn, _step, _signal, next) => [
        ...(await next()),
        { role: "user" as const, content: `window:${messages.length}` },
      ],
    );
    root.on(
      "agent/tool-exposure",
      async (_agent, _tools, _turn, _step, _signal, next) => {
        await next();
        return [
          {
            name: "hook_visible",
            description: "Visible only in this shaped request.",
            inputSchema: { type: "object" },
          },
        ];
      },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-hook-request",
      sessionId: "hook-shaped-request",
      provider: provider.id,
      model: "model-1",
    });

    handle.agent.send("shape the request");
    await handle.agent.whenIdle();

    const recorded = handle.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    if (recorded?.type !== "model/request" || !received) {
      throw new Error("model request was not recorded and received");
    }
    expect(recorded.request).toEqual(received);
    expect(recorded.request.system).toContain("Hook-shaped system context.");
    expect(recorded.request.messages.at(-1)).toEqual({
      role: "user",
      content: "window:1",
    });
    expect(recorded.request.tools.map((tool) => tool.name)).toEqual([
      "hook_visible",
    ]);
  });

  test("fences a model after durable intent without invoking its provider", async () => {
    let streams = 0;
    const provider: LlmProvider = {
      id: "fenced-model",
      async *stream() {
        streams += 1;
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    const admissions: Array<{ kind: "model" | "tool"; effectId: string }> = [];
    let intentWasDurable = false;
    const fenceOptions = {
      admitEffect: (effect: { kind: "model" | "tool"; effectId: string }) => {
        admissions.push(effect);
        intentWasDurable =
          root.sessions
            .get("fenced-model")
            ?.events.some(
              (event) =>
                event.type === "model/request" &&
                event.request.requestId === effect.effectId,
            ) ?? false;
        return Promise.resolve(false);
      },
    };
    const handle = await root.agents.create({
      ...fenceOptions,
      botId: "bot-1",
      sessionId: "fenced-model",
      provider: "fenced-model",
      model: "model-1",
    });

    handle.agent.send("stop before dispatch");
    await handle.agent.whenIdle();

    const request = handle.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    if (request?.type !== "model/request") throw new Error("request missing");
    expect(intentWasDurable).toBe(true);
    expect(admissions).toEqual([
      { kind: "model", effectId: request.request.requestId },
    ]);
    expect(streams).toBe(0);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "model/effect-not-started",
        requestId: request.request.requestId,
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
  });

  test("fences a tool after durable intent without execution or another model", async () => {
    let streams = 0;
    let executions = 0;
    const provider: LlmProvider = {
      id: "fenced-tool",
      async *stream() {
        streams += 1;
        yield {
          type: "tool-call",
          call: { id: "provider-call", name: "effect", input: {} },
        };
        yield { type: "finish", reason: "completed" };
      },
    };
    const tool: ToolDefinition = {
      name: "effect",
      description: "Must be fenced.",
      inputSchema: { type: "object" },
      execute() {
        executions += 1;
        return Promise.resolve({ content: "executed", isError: false });
      },
    };
    const root = await mountRuntime(provider, tool);
    const admissions: Array<{ kind: "model" | "tool"; effectId: string }> = [];
    let toolIntentWasDurable = false;
    const fenceOptions = {
      admitEffect: (effect: { kind: "model" | "tool"; effectId: string }) => {
        admissions.push(effect);
        if (effect.kind === "tool") {
          toolIntentWasDurable =
            root.sessions
              .get("fenced-tool")
              ?.events.some(
                (event) =>
                  event.type === "tool/call" &&
                  event.occurrenceId === effect.effectId,
              ) ?? false;
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      },
    };
    const handle = await root.agents.create({
      ...fenceOptions,
      botId: "bot-1",
      sessionId: "fenced-tool",
      provider: "fenced-tool",
      model: "model-1",
    });

    handle.agent.send("stop before the tool");
    await handle.agent.whenIdle();

    const request = handle.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    const call = handle.agent.session.events.find(
      (event) => event.type === "tool/call",
    );
    if (request?.type !== "model/request") throw new Error("request missing");
    if (call?.type !== "tool/call") throw new Error("tool call missing");
    expect(toolIntentWasDurable).toBe(true);
    expect(admissions).toEqual([
      { kind: "model", effectId: request.request.requestId },
      { kind: "tool", effectId: call.occurrenceId },
    ]);
    expect(streams).toBe(1);
    expect(executions).toBe(0);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: call.occurrenceId,
        status: "interrupted",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
  });

  test("announces model settlement only after the outcome is durable", async () => {
    let durableEvents: readonly SessionEvent[] = [];
    const committed: Array<{ requestId: string; durable: boolean }> = [];
    const provider: LlmProvider = {
      id: "settlement-order",
      async *stream() {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(
      provider,
      undefined,
      (_sessionId, events) => {
        durableEvents = [...events];
        return Promise.resolve();
      },
    );
    root.on("agent/model-outcome-committed", async (_agent, requestId) => {
      committed.push({
        requestId,
        durable: durableEvents.some(
          (event) =>
            event.type === "assistant/message" && event.requestId === requestId,
        ),
      });
    });
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "session-1",
      provider: provider.id,
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Run once");
    await handle.agent.whenIdle();

    expect(committed).toHaveLength(1);
    expect(committed[0]?.durable).toBe(true);
  });

  test("pins the Composition generation at turn start", async () => {
    const provider: LlmProvider = {
      id: "pinned",
      async *stream() {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const durableTypes: string[] = [];
    const root = await mountRuntime(
      provider,
      undefined,
      (_sessionId, events) => {
        durableTypes.push(...events.map((event) => event.type));
        return Promise.resolve();
      },
    );
    const handle = await root.agents.create({
      botId: "bot-pinned",
      sessionId: "pinned-session",
      provider: provider.id,
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Run once");
    await handle.agent.whenIdle();
    handle.agent.send("Run again");
    await handle.agent.whenIdle();

    const pins = handle.agent.session.events.filter(
      (event) => event.type === "composition/pinned",
    );
    expect(pins).toEqual([
      expect.objectContaining({
        type: "composition/pinned",
        turn: 1,
        generationId: TEST_COMPOSITION.generationId,
        artifactSetHash: TEST_COMPOSITION.artifactSetHash,
      }),
      expect.objectContaining({ type: "composition/pinned", turn: 2 }),
    ]);
    const types = handle.agent.session.events.map((event) => event.type);
    expect(types.indexOf("composition/pinned")).toBe(
      types.indexOf("turn/start") + 1,
    );
    expect(durableTypes).toContain("composition/pinned");
    expect(() => decodeSessionEvent(structuredClone(pins[0]))).not.toThrow();
  });

  test("records the admitted turn type and trims the catalog it requests", async () => {
    const provider: LlmProvider = {
      id: "admission-catalog",
      async *stream() {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const work: ToolDefinition = {
      name: "work",
      description: "A work tool.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "worked", isError: false }),
    };
    const chatOnly: ToolDefinition = {
      name: "send_to_user",
      description: "The voice to the User.",
      inputSchema: { type: "object" },
      admission: { turnTypes: ["chat"] },
      execute: () => Promise.resolve({ content: "sent", isError: false }),
    };
    const root = await mountRuntime(provider, [work, chatOnly]);
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "admission-catalog",
      provider: provider.id,
      model: "model-1",
      turnType: "automation",
      admitEffect: allowEffect,
    });

    handle.agent.send("Run the automation");
    await handle.agent.whenIdle();

    const types = handle.agent.session.events.map((event) => event.type);
    expect(types.indexOf("turn/admission")).toBe(
      types.indexOf("composition/pinned") + 1,
    );
    const admission = handle.agent.session.events.find(
      (event) => event.type === "turn/admission",
    );
    expect(admission).toMatchObject({
      type: "turn/admission",
      turn: 1,
      turnType: "automation",
    });
    expect(() => decodeSessionEvent(structuredClone(admission))).not.toThrow();

    // The recorded request *is* the trimmed catalog, so the Turn stays
    // reconstructable from the log alone.
    const request = handle.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    if (request?.type !== "model/request") throw new Error("request missing");
    expect(request.request.tools.map((schema) => schema.name)).toEqual([
      "work",
      "get_dynamic_tools",
      "call_dynamic_tool",
    ]);
  });

  test("replays a Turn with no admission event as a chat turn", async () => {
    const provider: LlmProvider = {
      id: "admission-default",
      async *stream() {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const chatOnly: ToolDefinition = {
      name: "send_to_user",
      description: "The voice to the User.",
      inputSchema: { type: "object" },
      admission: { turnTypes: ["chat"] },
      execute: () => Promise.resolve({ content: "sent", isError: false }),
    };
    const timestamp = "2026-08-30T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const root = await mountRuntime(provider, chatOnly, undefined, {
      "admission-default": initial,
    });
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "admission-default",
      provider: provider.id,
      model: "model-1",
      admitEffect: allowEffect,
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    const request = handle.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    if (request?.type !== "model/request") throw new Error("request missing");
    expect(request.request.tools.map((schema) => schema.name)).toEqual([
      "send_to_user",
      "get_dynamic_tools",
      "call_dynamic_tool",
    ]);
    expect(
      handle.agent.session.events.some(
        (event) => event.type === "turn/admission",
      ),
    ).toBe(false);
  });

  test("denies an out-of-admission call instead of executing it", async () => {
    let executions = 0;
    const provider: LlmProvider = {
      id: "admission-denial",
      async *stream() {
        yield {
          type: "tool-call",
          call: { id: "provider-call", name: "send_to_user", input: {} },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
    };
    const chatOnly: ToolDefinition = {
      name: "send_to_user",
      description: "The voice to the User.",
      inputSchema: { type: "object" },
      admission: { turnTypes: ["chat"] },
      execute: () => {
        executions += 1;
        return Promise.resolve({ content: "sent", isError: false });
      },
    };
    const root = await mountRuntime(provider, chatOnly);
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "admission-denial",
      provider: provider.id,
      model: "model-1",
      turnType: "automation",
      admitEffect: allowEffect,
    });

    handle.agent.send("Try the chat tool");
    await handle.agent.whenIdle();

    expect(executions).toBe(0);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        name: "send_to_user",
        isError: true,
      }),
    );
  });

  test("ends the Turn on a result that declares it, with no further request", async () => {
    let streams = 0;
    const provider: LlmProvider = {
      id: "ends-turn",
      async *stream() {
        streams += 1;
        yield {
          type: "tool-call",
          call: { id: "provider-call", name: "hand_off", input: {} },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
    };
    const handOff: ToolDefinition = {
      name: "hand_off",
      description: "Hands the Turn back.",
      inputSchema: { type: "object" },
      execute: () =>
        Promise.resolve({
          content: "handed off",
          isError: false,
          endsTurn: true,
        }),
    };
    const root = await mountRuntime(provider, handOff);
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "ends-turn",
      provider: provider.id,
      model: "model-1",
      admitEffect: allowEffect,
    });

    handle.agent.send("Hand off");
    await handle.agent.whenIdle();

    expect(streams).toBe(1);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/request",
      ),
    ).toHaveLength(1);
    const types = handle.agent.session.events.map((event) => event.type);
    expect(types.at(-1)).toBe("turn/end");
    expect(types.at(-2)).toBe("step/end");
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
    expect(handle.agent.session.events.at(-2)).toMatchObject({
      type: "step/end",
      step: 1,
      outcome: "completed",
    });
  });

  test("honours a turn-ending result on the resume path", async () => {
    let streams = 0;
    const provider: LlmProvider = {
      id: "ends-turn-resume",
      async *stream() {
        streams += 1;
        yield { type: "text-delta", text: "unreachable" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const handOff: ToolDefinition = {
      name: "hand_off",
      description: "Hands the Turn back.",
      inputSchema: { type: "object" },
      execute: () =>
        Promise.resolve({
          content: "handed off",
          isError: false,
          endsTurn: true,
        }),
    };
    const timestamp = "2026-08-30T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "turn/admission", turn: 1, turnType: "automation" },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "hand-off-request",
          provider: provider.id,
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "hand-off-request",
        text: "",
        toolCalls: [{ id: "provider-call", name: "hand_off", input: {} }],
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const root = await mountRuntime(provider, handOff, undefined, {
      "ends-turn-resume": initial,
    });
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "ends-turn-resume",
      provider: provider.id,
      model: "model-1",
      admitEffect: allowEffect,
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(streams).toBe(0);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/request",
      ),
    ).toHaveLength(1);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("keeps a durable settlement failure resumable", async () => {
    let attempts = 0;
    const provider: LlmProvider = {
      id: "settlement-retry",
      async *stream() {
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    root.on("agent/model-outcome-committed", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("settlement unavailable");
    });
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "settlement-retry",
      provider: provider.id,
      model: "model-1",
      admitEffect: allowEffect,
    });

    handle.agent.send("Run once");
    await handle.agent.whenIdle();

    expect(attempts).toBe(1);
    expect(
      handle.agent.session.events.some((event) => event.type === "turn/end"),
    ).toBe(false);

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(attempts).toBe(2);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("reannounces a durable assistant outcome during recovery", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "durable-assistant-request",
          provider: "recovered-provider",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "durable-assistant-request",
        text: "Durable response",
        toolCalls: [],
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const committed: string[] = [];
    const provider: LlmProvider = {
      id: "recovered-provider",
      async *stream() {
        throw new Error("stream must not run");
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      "durable-assistant": initial,
    });
    root.on("agent/model-outcome-committed", async (_agent, requestId) => {
      committed.push(requestId);
    });
    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "durable-assistant",
      provider: provider.id,
      model: "model-1",
      admitEffect: allowEffect,
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(committed).toEqual(["durable-assistant-request"]);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("reconciles an admitted model request by its durable id", async () => {
    let streams = 0;
    const reconciled: string[] = [];
    const provider: LlmProvider = {
      id: "recoverable",
      async *stream() {
        streams += 1;
        yield { type: "finish", reason: "completed" };
      },
      reconciliation: {
        retrieve(effect) {
          reconciled.push(effect.providerEffectId);
          return recovered(
            { type: "text-delta", text: "Recovered response" },
            { type: "finish", reason: "completed" },
          );
        },
      },
    };
    const initial = [
      {
        type: "session/created" as const,
        createdAt: "2026-08-28T00:00:00.000Z",
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
      },
      {
        type: "turn/start" as const,
        turn: 1,
        seq: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "step/start" as const,
        turn: 1,
        step: 1,
        seq: 2,
        timestamp: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "model/request" as const,
        turn: 1,
        step: 1,
        request: {
          requestId: "durable-request-1",
          provider: "recoverable",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
      },
    ] satisfies SessionEvent[];
    const root = await mountRuntime(provider, undefined, undefined, {
      recovering: initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-1",
      sessionId: "recovering",
      provider: "recoverable",
      model: "model-1",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(streams).toBe(0);
    expect(reconciled).toEqual(["durable-request-1"]);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "assistant/message",
        requestId: "durable-request-1",
        text: "Recovered response",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("reconciles a mixed stream and journals only its unseen text suffix", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "partial-request",
          provider: "partial-provider",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/chunk",
        turn: 1,
        step: 1,
        requestId: "partial-request",
        text: "A",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    let streamedFollowUp = 0;
    let toolExecutions = 0;
    const provider: LlmProvider = {
      id: "partial-provider",
      async *stream() {
        streamedFollowUp += 1;
        yield { type: "text-delta", text: "Finished." };
        yield { type: "finish", reason: "completed" };
      },
      reconciliation: {
        retrieve: () =>
          recovered(
            { type: "text-delta", text: "A" },
            {
              type: "tool-call",
              call: {
                id: "recovered-call",
                name: "echo",
                input: { value: "mixed" },
              },
            },
            { type: "text-delta", text: "B" },
            { type: "finish", reason: "tool-calls" },
          ),
      },
    };
    const tool: ToolDefinition = {
      name: "echo",
      description: "Return a supplied value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      validate: (input) =>
        typeof input === "object" &&
        input !== null &&
        typeof (input as { value?: unknown }).value === "string",
      execute(input) {
        toolExecutions += 1;
        return Promise.resolve({
          content: (input as { value: string }).value,
          isError: false,
        });
      },
    };
    const root = await mountRuntime(provider, tool, undefined, {
      partial: initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "partial-bot",
      sessionId: "partial",
      provider: "partial-provider",
      model: "model-1",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.flatMap((event) =>
        event.type === "assistant/chunk" &&
        event.requestId === "partial-request"
          ? [event.text]
          : [],
      ),
    ).toEqual(["A", "B"]);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "assistant/message",
        requestId: "partial-request",
        text: "AB",
        toolCalls: [
          {
            id: "recovered-call",
            name: "echo",
            input: { value: "mixed" },
          },
        ],
      }),
    );
    expect(toolExecutions).toBe(1);
    expect(streamedFollowUp).toBe(1);
    expect(
      handle.agent.session.events.filter(
        (event) =>
          event.type === "tool/call" &&
          event.occurrenceId === "tool:1:1:0" &&
          event.name === "echo",
      ),
    ).toHaveLength(1);
    expect(
      handle.agent.session.events.filter(
        (event) =>
          event.type === "tool/result" &&
          event.occurrenceId === "tool:1:1:0" &&
          event.content === "mixed",
      ),
    ).toHaveLength(1);
  });

  test("fails closed when retrieval diverges from a durable partial stream", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "divergent-request",
          provider: "divergent-provider",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/chunk",
        turn: 1,
        step: 1,
        requestId: "divergent-request",
        text: "A",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const provider: LlmProvider = {
      id: "divergent-provider",
      async *stream() {
        throw new Error("recovery must not dispatch another request");
      },
      reconciliation: {
        retrieve: () =>
          recovered(
            { type: "text-delta", text: "X" },
            { type: "text-delta", text: "B" },
            { type: "finish", reason: "completed" },
          ),
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      divergent: initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "divergent-bot",
      sessionId: "divergent",
      provider: "divergent-provider",
      model: "model-1",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.flatMap((event) =>
        event.type === "assistant/chunk" ? [event.text] : [],
      ),
    ).toEqual(["A"]);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "model/reconciliation-required",
        requestId: "divergent-request",
        reason:
          'Provider-bound retrieval diverged from durable response prefix for request "divergent-request"',
      }),
    );
    expect(
      handle.agent.session.events.some(
        (event) =>
          event.type === "assistant/message" || event.type === "turn/end",
      ),
    ).toBe(false);
  });

  test("fails closed when a mixed recovered stream continues after finish", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "structural-request",
          provider: "structural-provider",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/chunk",
        turn: 1,
        step: 1,
        requestId: "structural-request",
        text: "A",
      },
      {
        type: "assistant/chunk",
        turn: 1,
        step: 1,
        requestId: "structural-request",
        text: "B",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const provider: LlmProvider = {
      id: "structural-provider",
      async *stream() {
        throw new Error("recovery must not dispatch another request");
      },
      reconciliation: {
        retrieve: () =>
          recovered(
            { type: "text-delta", text: "A" },
            {
              type: "tool-call",
              call: {
                id: "invalid-call",
                name: "echo",
                input: { value: "mixed" },
              },
            },
            { type: "finish", reason: "tool-calls" },
            { type: "text-delta", text: "B" },
          ),
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      structural: initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "structural-bot",
      sessionId: "structural",
      provider: "structural-provider",
      model: "model-1",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.flatMap((event) =>
        event.type === "assistant/chunk" ? [event.text] : [],
      ),
    ).toEqual(["A", "B"]);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "model/reconciliation-required",
        requestId: "structural-request",
        reason:
          'Provider-bound retrieval returned an invalid event structure for request "structural-request"',
      }),
    );
    expect(
      handle.agent.session.events.some(
        (event) =>
          event.type === "assistant/message" || event.type === "tool/call",
      ),
    ).toBe(false);
  });

  test("keeps an unretrievable provider effect open without repeating it", async () => {
    let streams = 0;
    const provider: LlmProvider = {
      id: "unretrievable",
      async *stream() {
        streams += 1;
        yield { type: "finish", reason: "completed" };
      },
    };
    const initial = [
      {
        type: "session/created" as const,
        createdAt: "2026-08-28T00:00:00.000Z",
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
      },
      {
        type: "turn/start" as const,
        turn: 1,
        seq: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "step/start" as const,
        turn: 1,
        step: 1,
        seq: 2,
        timestamp: "2026-08-28T00:00:01.000Z",
      },
      {
        type: "model/request" as const,
        turn: 1,
        step: 1,
        request: {
          requestId: "unretrievable-effect-1",
          provider: "unretrievable",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
      },
    ] satisfies SessionEvent[];
    const root = await mountRuntime(provider, undefined, undefined, {
      unretrievable: initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-1",
      sessionId: "unretrievable",
      provider: "unretrievable",
      model: "model-1",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();
    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(streams).toBe(0);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/reconciliation-required",
      ),
    ).toEqual([
      expect.objectContaining({
        requestId: "unretrievable-effect-1",
        reason:
          'LLM provider "unretrievable" does not support provider-bound retrieval',
      }),
    ]);
    expect(
      handle.agent.session.events.some(
        (event) => event.type === "step/end" || event.type === "turn/end",
      ),
    ).toBe(false);
  });

  test("keeps an ambiguous dispatched effect open for provider reconciliation", async () => {
    let streams = 0;
    const retrieved: string[] = [];
    const durableEventTypes: string[] = [];
    let dispatchSawDurableIntent = false;
    const provider: LlmProvider = {
      id: "lost-response",
      async *stream() {
        streams += 1;
        dispatchSawDurableIntent = durableEventTypes.at(-1) === "model/request";
        throw new Error("response lost after dispatch");
      },
      reconciliation: {
        retrieve(effect) {
          retrieved.push(effect.providerEffectId);
          return Promise.resolve({
            status: "unavailable",
            reason: "provider result is not retrievable yet",
          });
        },
      },
    };
    const root = await mountRuntime(
      provider,
      undefined,
      (_sessionId, events) => {
        durableEventTypes.push(...events.map((event) => event.type));
        return Promise.resolve();
      },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-lost-response",
      sessionId: "lost-response",
      provider: "lost-response",
      model: "test-model",
    });

    handle.agent.send("Dispatch once.");
    await handle.agent.whenIdle();
    const request = handle.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    if (request?.type !== "model/request") {
      throw new Error("model request was not recorded");
    }
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "model/reconciliation-required",
        requestId: request.request.requestId,
        reason:
          "Model response outcome is uncertain: response lost after dispatch",
      }),
    );
    expect(
      handle.agent.session.events.some(
        (event) => event.type === "step/end" || event.type === "turn/end",
      ),
    ).toBe(false);

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(streams).toBe(1);
    expect(dispatchSawDurableIntent).toBe(true);
    expect(durableEventTypes).toContain("model/reconciliation-required");
    expect(durableEventTypes).not.toContain("turn/end");
    expect(retrieved).toEqual([request.request.requestId]);
    expect(
      handle.agent.session.events.some(
        (event) => event.type === "step/end" || event.type === "turn/end",
      ),
    ).toBe(false);
  });

  test("terminally fails only an explicitly unstarted model effect", async () => {
    const durableEventTypes: string[] = [];
    let retryPolicySawDurableNoEffect = false;
    const provider: LlmProvider = {
      id: "pre-effect-failure",
      async *stream() {
        throw new LlmEffectNotStartedError(
          "provider rejected before effect creation",
        );
      },
    };
    const root = await mountRuntime(
      provider,
      undefined,
      (_sessionId, events) => {
        durableEventTypes.push(...events.map((event) => event.type));
        return Promise.resolve();
      },
    );
    root.on("agent/request-error", async (_agent, _error, _signal, next) => {
      retryPolicySawDurableNoEffect = durableEventTypes.includes(
        "model/effect-not-started",
      );
      return next();
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-pre-effect-failure",
      sessionId: "pre-effect-failure",
      provider: "pre-effect-failure",
      model: "test-model",
    });

    handle.agent.send("Fail safely.");
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.some(
        (event) => event.type === "model/reconciliation-required",
      ),
    ).toBe(false);
    expect(durableEventTypes.indexOf("model/request")).toBeLessThan(
      durableEventTypes.indexOf("model/effect-not-started"),
    );
    expect(durableEventTypes.indexOf("model/effect-not-started")).toBeLessThan(
      durableEventTypes.indexOf("turn/end"),
    );
    expect(retryPolicySawDurableNoEffect).toBe(true);
    expect(handle.agent.session.events.at(-2)).toMatchObject({
      type: "step/end",
      outcome: "model-error",
    });
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
    });
  });

  test("recovers a durable no-effect outcome without provider reconciliation", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "no-effect-request",
          provider: "no-effect-provider",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "model/effect-not-started",
        turn: 1,
        step: 1,
        requestId: "no-effect-request",
        reason: "provider rejected before dispatch",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    let streams = 0;
    let retrievals = 0;
    const provider: LlmProvider = {
      id: "no-effect-provider",
      async *stream() {
        streams += 1;
        yield { type: "finish", reason: "completed" };
      },
      reconciliation: {
        retrieve: () => {
          retrievals += 1;
          return recovered({ type: "finish", reason: "completed" });
        },
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      "no-effect": initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "no-effect-bot",
      sessionId: "no-effect",
      provider: "no-effect-provider",
      model: "model-1",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(streams).toBe(0);
    expect(retrievals).toBe(0);
    expect(handle.agent.session.events.at(-2)).toMatchObject({
      type: "step/end",
      outcome: "model-error",
    });
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
    });
  });

  test("streams, journals a tool before execution, and repeats the model step", async () => {
    const requests: string[] = [];
    let toolWasJournaled = false;
    let modelIntentWasDurable = false;
    let toolIntentWasDurable = false;
    const durableEventTypes: string[] = [];
    let turnStoppingSawCompletedJournal = false;
    let observedPromptSessionId: string | undefined;
    let observedToolIdentity:
      | {
          botId: string;
          agentId: string;
          sessionId: string;
          compositionGenerationId: string;
        }
      | undefined;
    let root: Context;
    const provider: LlmProvider = {
      id: "scripted",
      async *stream(request) {
        modelIntentWasDurable = durableEventTypes.at(-1) === "model/request";
        requests.push(request.requestId);
        if (requests.length === 1) {
          yield { type: "text-delta", text: "Checking. " };
          yield {
            type: "tool-call",
            call: { id: "call-1", name: "echo", input: { value: "hello" } },
          };
          yield {
            type: "tool-call",
            call: {
              id: "call-1",
              name: "echo",
              input: { value: "goodbye" },
            },
          };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        expect(
          request.messages.flatMap((message) =>
            message.role === "tool"
              ? [{ callId: message.callId, content: message.content }]
              : [],
          ),
        ).toEqual([
          { callId: "call-1", content: "hello" },
          { callId: "call-1", content: "goodbye" },
        ]);
        const result = request.messages.findLast(
          (message) => message.role === "tool",
        );
        yield {
          type: "text-delta",
          text: `Tool returned ${result?.role === "tool" ? result.content : "nothing"}.`,
        };
        yield { type: "finish", reason: "completed" };
      },
    };
    const tool: ToolDefinition = {
      name: "echo",
      description: "Return a supplied value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      validate: (input) =>
        typeof input === "object" &&
        input !== null &&
        typeof (input as { value?: unknown }).value === "string",
      async execute(input, context) {
        const session = root.agents.get("general")?.session;
        toolWasJournaled = session?.events.at(-1)?.type === "tool/call";
        toolIntentWasDurable = durableEventTypes.at(-1) === "tool/call";
        const identifiedContext = context as typeof context & {
          agentId: string;
        };
        observedToolIdentity = {
          botId: context.botId,
          agentId: identifiedContext.agentId,
          sessionId: context.sessionId,
          compositionGenerationId: context.compositionGenerationId,
        };
        return {
          content: (input as { value: string }).value,
          isError: false,
        };
      },
    };

    root = await mountRuntime(provider, tool, (_sessionId, events) => {
      durableEventTypes.push(...events.map((event) => event.type));
      return Promise.resolve();
    });
    root.systemPrompt.register({
      id: "session-observer",
      render: (context) => {
        observedPromptSessionId = context.sessionId;
        return "";
      },
    });
    root.on("agent/turn-stopping", (agent) => {
      turnStoppingSawCompletedJournal =
        agent.session.events.at(-1)?.type === "turn/end";
      return Promise.resolve();
    });
    const agentOptions: AgentOptions & { agentId: string } = {
      botId: "general-bot",
      agentId: "general",
      sessionId: "owner:general:conversation-1",
      provider: "scripted",
      model: "test-model",
      ...allowEffectOptions,
    };
    const handle = await root.agents.create(agentOptions);
    handle.agent.send("Use the echo tool.");
    await handle.agent.whenIdle();

    const events = handle.agent.session.events;
    expect(requests).toHaveLength(2);
    expect(toolWasJournaled).toBe(true);
    expect(modelIntentWasDurable).toBe(true);
    expect(toolIntentWasDurable).toBe(true);
    expect(turnStoppingSawCompletedJournal).toBe(true);
    expect(handle.agent.id).toBe("general");
    expect(handle.agent.botId).toBe("general-bot");
    expect(handle.agent.session.id).toBe("owner:general:conversation-1");
    expect(observedPromptSessionId).toBe("owner:general:conversation-1");
    expect(observedToolIdentity).toEqual({
      botId: "general-bot",
      agentId: "general",
      sessionId: "owner:general:conversation-1",
      compositionGenerationId: TEST_COMPOSITION.generationId,
    });
    expect(events.filter((event) => event.type === "step/start")).toHaveLength(
      2,
    );
    expect(events.filter((event) => event.type === "step/end")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn/start")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === "turn/end")).toHaveLength(1);
    expect(
      events.flatMap((event) =>
        event.type === "tool/call" || event.type === "tool/result"
          ? [event.occurrenceId]
          : [],
      ),
    ).toEqual(["tool:1:1:0", "tool:1:1:0", "tool:1:1:1", "tool:1:1:1"]);
    expect(
      JSON.stringify(
        events.filter(
          (event) => event.type === "tool/call" || event.type === "tool/result",
        ),
      ),
    ).not.toContain("call-1");
    expect(
      events.find((event) => event.type === "model/request"),
    ).toMatchObject({
      request: {
        provider: "scripted",
        model: "test-model",
        system: "You are the FrockBot test agent.",
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "echo" }),
          expect.objectContaining({ name: "get_dynamic_tools" }),
          expect.objectContaining({ name: "call_dynamic_tool" }),
        ]),
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
    expect(handle.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "Tool returned goodbye.",
    });

    const session = handle.agent.session;
    await handle.dispose();
    expect(root.agents.list()).toEqual([]);
    expect(session.events.at(-1)?.type).toBe("session/disposed");
  });

  test("keeps an aborted durable model request open for reconciliation", async () => {
    const provider: LlmProvider = {
      id: "blocking",
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-2",
      sessionId: "agent-2",
      provider: "blocking",
      model: "test-model",
    });

    handle.agent.send("Wait forever.");
    await eventually(() =>
      expect(
        handle.agent.session.events.some(
          (event) => event.type === "model/request",
        ),
      ).toBe(true),
    );
    handle.agent.cancel();
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.some(
        (event) => event.type === "step/end" || event.type === "turn/end",
      ),
    ).toBe(false);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "model/reconciliation-required",
        reason: expect.stringContaining("uncertain after cancellation"),
      }),
    );
  });

  test("cancels after a recovered assistant response is durably flushed", async () => {
    const timestamp = "2026-08-30T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "flush-request",
          provider: "flush-cancellation",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const provider: LlmProvider = {
      id: "flush-cancellation",
      async *stream() {
        throw new Error("recovery must not dispatch another model request");
      },
      reconciliation: {
        retrieve: () =>
          recovered(
            { type: "text-delta", text: "Recovered answer" },
            { type: "finish", reason: "completed" },
          ),
      },
    };
    let cancel = () => {};
    const root = await mountRuntime(
      provider,
      undefined,
      (_sessionId, events) => {
        if (events.some((event) => event.type === "assistant/message"))
          cancel();
        return Promise.resolve();
      },
      { "agent-flush-cancel": initial },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-flush-cancel",
      sessionId: "agent-flush-cancel",
      provider: "flush-cancellation",
      model: "test-model",
    });
    cancel = () => handle.agent.cancel();

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "assistant/message",
        text: "Recovered answer",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "turn/end" && event.outcome === "completed",
      ),
    ).toEqual([]);
  });

  test("keeps a cancelled non-idempotent tool effect open", async () => {
    const provider: LlmProvider = {
      id: "tool-cancellation",
      async *stream() {
        yield {
          type: "tool-call",
          call: { id: "external", name: "external", input: {} },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
    };
    let effectId: string | undefined;
    let executions = 0;
    const reconciliations: string[] = [];
    const tool: RecoverableToolDefinition = {
      name: "external",
      description: "Potentially non-idempotent external effect.",
      inputSchema: { type: "object" },
      execute(_input, context) {
        executions += 1;
        effectId = context.effectId;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(context.signal.reason),
            { once: true },
          );
        });
      },
      reconcile(_input, context) {
        reconciliations.push(context.effectId);
        return Promise.resolve({
          status: "unavailable",
          reason: "provider result is not retrievable yet",
        });
      },
    };
    const root = await mountRuntime(provider, tool);
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-tool-cancel",
      sessionId: "agent-tool-cancel",
      provider: "tool-cancellation",
      model: "test-model",
    });

    handle.agent.send("Start an external effect.");
    await eventually(() =>
      expect(
        handle.agent.session.events.some((event) => event.type === "tool/call"),
      ).toBe(true),
    );
    handle.agent.cancel();
    await handle.agent.whenIdle();

    expect(effectId).toBe("tool:1:1:0");
    expect(
      handle.agent.session.events.some(
        (event) => event.type === "tool/result" || event.type === "turn/end",
      ),
    ).toBe(false);

    handle.agent.resume();
    await handle.agent.whenIdle();
    expect(executions).toBe(1);
    expect(reconciliations).toEqual(["tool:1:1:0"]);
    expect(
      handle.agent.session.events.some(
        (event) => event.type === "tool/result" || event.type === "turn/end",
      ),
    ).toBe(false);
  });

  test("recovers a non-idempotent open tool without executing it again", async () => {
    let modelRequests = 0;
    let executions = 0;
    const reconciled: string[] = [];
    const provider: LlmProvider = {
      id: "non-idempotent-tool-recovery",
      async *stream() {
        modelRequests += 1;
        yield { type: "text-delta", text: "Recovered safely." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const tool: RecoverableToolDefinition = {
      name: "external",
      description: "Recoverable non-idempotent effect.",
      inputSchema: { type: "object" },
      execute() {
        executions += 1;
        return Promise.resolve({ content: "duplicated", isError: false });
      },
      reconcile(_input, context) {
        reconciled.push(context.effectId);
        return Promise.resolve({
          status: "recovered",
          result: { content: "original result", isError: false },
        });
      },
    };
    const root = await mountRuntime(provider, tool, undefined, {
      "recovered-tool-session": openToolSessionEvents(provider.id, tool.name),
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "recovered-tool-bot",
      sessionId: "recovered-tool-session",
      provider: provider.id,
      model: "test-model",
    });

    expect(handle.agent.session.reconcileForResume()).toEqual([]);
    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(executions).toBe(0);
    expect(reconciled).toEqual(["tool:1:1:0"]);
    expect(modelRequests).toBe(1);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        content: "original result",
        status: "completed",
      }),
    );
  });

  test("reconciles an open idempotent tool with its durable effect id", async () => {
    const timestamp = "2026-08-30T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "tool-model-request",
          provider: "idempotent-tool-recovery",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "tool-model-request",
        text: "",
        toolCalls: [{ id: "provider-call", name: "safe", input: {} }],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "safe",
        input: {},
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const effects: (string | undefined)[] = [];
    const provider: LlmProvider = {
      id: "idempotent-tool-recovery",
      async *stream() {
        yield { type: "text-delta", text: "Recovered safely." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const tool: ToolDefinition = {
      name: "safe",
      description: "Idempotent effect.",
      inputSchema: { type: "object" },
      idempotent: true,
      execute(_input, context) {
        effects.push(
          (context as typeof context & { effectId?: string }).effectId,
        );
        return Promise.resolve({ content: "settled", isError: false });
      },
    };
    const root = await mountRuntime(provider, tool, undefined, {
      "idempotent-session": initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "idempotent-bot",
      sessionId: "idempotent-session",
      provider: "idempotent-tool-recovery",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(effects).toEqual(["tool:1:1:0"]);
    expect(
      handle.agent.session.events.filter(
        (event) =>
          event.type === "tool/call" && event.occurrenceId === "tool:1:1:0",
      ),
    ).toHaveLength(1);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        status: "completed",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("settles remaining tool occurrences before closing a cancelled turn", async () => {
    let requests = 0;
    const provider: LlmProvider = {
      id: "multi-tool-cancellation",
      async *stream() {
        requests += 1;
        if (requests === 1) {
          yield {
            type: "tool-call",
            call: { id: "first", name: "echo", input: { value: "first" } },
          };
          yield {
            type: "tool-call",
            call: {
              id: "second",
              name: "echo",
              input: { value: "second" },
            },
          };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        yield { type: "text-delta", text: "Next Turn completed." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const executions: string[] = [];
    let cancel: () => void = () => {
      throw new Error("agent is not ready");
    };
    const tool: ToolDefinition = {
      name: "echo",
      description: "Return a supplied value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      execute(input) {
        const value = (input as { value: string }).value;
        executions.push(value);
        cancel();
        return Promise.resolve({ content: value, isError: false });
      },
    };
    const root = await mountRuntime(provider, tool);
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-cancel-tools",
      sessionId: "agent-cancel-tools",
      provider: "multi-tool-cancellation",
      model: "test-model",
    });
    cancel = () => handle.agent.cancel();

    handle.agent.send("Run two tools.");
    await handle.agent.whenIdle();

    expect(executions).toEqual(["first"]);
    expect(
      handle.agent.session.events.flatMap((event) =>
        (event.type === "tool/call" || event.type === "tool/result") &&
        event.turn === 1
          ? [
              {
                type: event.type,
                occurrenceId: event.occurrenceId,
                ...(event.type === "tool/result"
                  ? { status: event.status }
                  : {}),
              },
            ]
          : [],
      ),
    ).toEqual([
      { type: "tool/call", occurrenceId: "tool:1:1:0" },
      {
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        status: "completed",
      },
      { type: "tool/call", occurrenceId: "tool:1:1:1" },
      {
        type: "tool/result",
        occurrenceId: "tool:1:1:1",
        status: "interrupted",
      },
    ]);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "turn/end",
        turn: 1,
        outcome: "cancelled",
      }),
    );

    handle.agent.send("Continue with another Turn.");
    await handle.agent.whenIdle();

    expect(requests).toBe(2);
    expect(executions).toEqual(["first"]);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      turn: 2,
      outcome: "completed",
    });
  });

  test("journals a failed prepared tool result before completing the turn", async () => {
    let requests = 0;
    const durableTypes: string[] = [];
    const provider: LlmProvider = {
      id: "tool-failure",
      async *stream(request) {
        requests += 1;
        if (requests === 1) {
          yield {
            type: "tool-call",
            call: { id: "call-failed", name: "fails", input: {} },
          };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        const result = request.messages.findLast(
          (message) => message.role === "tool",
        );
        yield {
          type: "text-delta",
          text:
            result?.role === "tool" && result.isError
              ? "Recovered."
              : "Missing error.",
        };
        yield { type: "finish", reason: "completed" };
      },
    };
    const tool: ToolDefinition = {
      name: "fails",
      description: "Always fails.",
      inputSchema: { type: "object" },
      idempotent: true,
      validate: () => true,
      execute: () => Promise.reject(new Error("provider revoked")),
    };
    const root = await mountRuntime(provider, tool, (_sessionId, events) => {
      durableTypes.push(...events.map((event) => event.type));
      return Promise.resolve();
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-failure",
      sessionId: "agent-failure",
      provider: "tool-failure",
      model: "test-model",
    });
    handle.agent.send("Use the failing tool.");
    await handle.agent.whenIdle();

    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        content: "provider revoked",
        isError: true,
      }),
    );
    expect(durableTypes.indexOf("tool/result")).toBeLessThan(
      durableTypes.lastIndexOf("turn/end"),
    );
    expect(handle.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "Recovered.",
    });
  });

  test("resumes an explicitly reconciled turn without admitting input twice", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "input/queued", messageId: "message-1", text: "Continue once." },
      { type: "turn/start", turn: 1 },
      { type: "input/admitted", messageId: "message-1", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "user/message",
        turn: 1,
        step: 1,
        messageId: "message-1",
        text: "Continue once.",
      },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "uncertain-request",
          provider: "resume-provider",
          model: "test-model",
          system: "",
          messages: [{ role: "user", content: "Continue once." }],
          tools: [],
        },
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const provider: LlmProvider = {
      id: "resume-provider",
      async *stream() {
        throw new Error("resume must not create a new model request");
      },
      reconciliation: {
        retrieve(effect) {
          expect(effect.providerEffectId).toBe("uncertain-request");
          return recovered(
            { type: "text-delta", text: "Resumed safely." },
            { type: "finish", reason: "completed" },
          );
        },
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      "resume-session": initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "resume-session",
      provider: "resume-provider",
      model: "test-model",
    });
    handle.agent.session.reconcileForResume();
    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "input/admitted",
      ),
    ).toHaveLength(1);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/request",
      ),
    ).toHaveLength(1);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "assistant/message",
        requestId: "uncertain-request",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("resumes durable assistant tool calls that were not journaled", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const call = {
      id: "durable-call",
      name: "echo",
      input: { value: "resumed" },
    };
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "completed-request",
          provider: "resume-tools",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "completed-request",
        text: "",
        toolCalls: [call],
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    let toolExecutions = 0;
    let modelRequests = 0;
    const provider: LlmProvider = {
      id: "resume-tools",
      async *stream(request) {
        modelRequests += 1;
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          callId: "durable-call",
          content: "resumed",
        });
        yield { type: "text-delta", text: "Finished after recovery." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(
      provider,
      {
        name: "echo",
        description: "Echo a value.",
        inputSchema: { type: "object" },
        execute: (input) => {
          toolExecutions += 1;
          return Promise.resolve({
            content: (input as { value: string }).value,
            isError: false,
          });
        },
      },
      undefined,
      { "resume-tools": initial },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "resume-tools",
      provider: "resume-tools",
      model: "test-model",
    });

    expect(handle.agent.session.reconcileForResume()).toEqual([]);
    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(toolExecutions).toBe(1);
    expect(modelRequests).toBe(1);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/call",
        occurrenceId: "tool:1:1:0",
        name: call.name,
        input: call.input,
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("recovers duplicate provider call ids by durable occurrence", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const first = {
      id: "duplicate-provider-id",
      name: "echo",
      input: { value: "first" },
    };
    const second = {
      id: "duplicate-provider-id",
      name: "echo",
      input: { value: "second" },
    };
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "duplicate-request",
          provider: "duplicate-tools",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "duplicate-request",
        text: "",
        toolCalls: [first, second],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: first.name,
        input: first.input,
      },
      {
        type: "tool/result",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: first.name,
        content: "first",
        isError: false,
        status: "completed",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const executions: string[] = [];
    let followUpRequests = 0;
    const provider: LlmProvider = {
      id: "duplicate-tools",
      async *stream(request) {
        followUpRequests += 1;
        expect(
          request.messages.flatMap((message) =>
            message.role === "tool"
              ? [{ callId: message.callId, content: message.content }]
              : [],
          ),
        ).toEqual([
          { callId: "duplicate-provider-id", content: "first" },
          { callId: "duplicate-provider-id", content: "second" },
        ]);
        yield { type: "text-delta", text: "Both completed." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(
      provider,
      {
        name: "echo",
        description: "Echo a value.",
        inputSchema: { type: "object" },
        execute(input) {
          const value = (input as { value: string }).value;
          executions.push(value);
          return Promise.resolve({ content: value, isError: false });
        },
      },
      undefined,
      { "duplicate-tools": initial },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "duplicate-tools",
      provider: "duplicate-tools",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(executions).toEqual(["second"]);
    expect(followUpRequests).toBe(1);
    const journal = handle.agent.session.events.filter(
      (event) => event.type === "tool/call" || event.type === "tool/result",
    );
    expect(journal.map((event) => event.occurrenceId)).toEqual([
      "tool:1:1:0",
      "tool:1:1:0",
      "tool:1:1:1",
      "tool:1:1:1",
    ]);
    expect(JSON.stringify(journal)).not.toContain("duplicate-provider-id");
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("fails closed on a mismatched durable tool occurrence", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const call = {
      id: "provider-call",
      name: "echo",
      input: { value: "unsafe" },
    };
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "mismatched-request",
          provider: "mismatched-tools",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "mismatched-request",
        text: "",
        toolCalls: [call],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:1",
        name: call.name,
        input: call.input,
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    let executions = 0;
    const provider: LlmProvider = {
      id: "mismatched-tools",
      async *stream() {
        throw new Error("structural mismatch must not request the model");
      },
    };
    const root = await mountRuntime(
      provider,
      {
        name: "echo",
        description: "Echo a value.",
        inputSchema: { type: "object" },
        execute() {
          executions += 1;
          return Promise.resolve({ content: "unsafe", isError: false });
        },
      },
      undefined,
      { "mismatched-tools": initial },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "mismatched-tools",
      provider: "mismatched-tools",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(executions).toBe(0);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
    });
  });

  test("does not request another model after tool events cross step closure", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const call = {
      id: "provider-call",
      name: "echo",
      input: { value: "unsafe" },
    };
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "malformed-request",
          provider: "malformed-tools",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "malformed-request",
        text: "",
        toolCalls: [call],
      },
      {
        type: "step/end",
        turn: 1,
        step: 1,
        outcome: "completed",
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: call.name,
        input: call.input,
      },
      {
        type: "tool/result",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: call.name,
        content: "unsafe",
        isError: false,
        status: "completed",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    let modelRequests = 0;
    let toolExecutions = 0;
    const root = await mountRuntime(
      {
        id: "malformed-tools",
        async *stream() {
          modelRequests += 1;
          yield { type: "finish", reason: "completed" };
        },
      },
      {
        name: "echo",
        description: "Echo a value.",
        inputSchema: { type: "object" },
        execute() {
          toolExecutions += 1;
          return Promise.resolve({ content: "unsafe", isError: false });
        },
      },
      undefined,
      { "malformed-tools": initial },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "malformed-tools",
      provider: "malformed-tools",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(modelRequests).toBe(0);
    expect(toolExecutions).toBe(0);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
    });
  });

  test("finishes a durable text response without another model request", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "completed-text-request",
          provider: "resume-text",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "completed-text-request",
        text: "Already durable.",
        toolCalls: [],
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const provider: LlmProvider = {
      id: "resume-text",
      async *stream() {
        throw new Error("resume must not create another model request");
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      "resume-text": initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "resume-text",
      provider: "resume-text",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/request",
      ),
    ).toHaveLength(1);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("finishes a turn without duplicating its durable step end", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "ended-text-request",
          provider: "resume-ended-text",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "ended-text-request",
        text: "Already durable.",
        toolCalls: [],
      },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const provider: LlmProvider = {
      id: "resume-ended-text",
      async *stream() {
        throw new Error("resume must not create another model request");
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      "resume-ended-text": initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "resume-ended-text",
      provider: "resume-ended-text",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.filter(
        (event) =>
          event.type === "step/end" && event.turn === 1 && event.step === 1,
      ),
    ).toHaveLength(1);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "turn/end" && event.turn === 1,
      ),
    ).toEqual([expect.objectContaining({ outcome: "completed" })]);
  });

  test("resumes inside a durable step start awaiting its model request", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const call = {
      id: "completed-call",
      name: "echo",
      input: { value: "completed" },
    };
    const initial = [
      { type: "session/created", createdAt: timestamp },
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: "first-request",
          provider: "resume-open-step",
          model: "test-model",
          system: "",
          messages: [],
          tools: [],
        },
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "first-request",
        text: "",
        toolCalls: [call],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: call.name,
        input: call.input,
      },
      {
        type: "tool/result",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: call.name,
        content: "completed",
        isError: false,
        status: "completed",
      },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
      { type: "step/start", turn: 1, step: 2 },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    let modelRequests = 0;
    const provider: LlmProvider = {
      id: "resume-open-step",
      async *stream(request) {
        modelRequests += 1;
        expect(request.requestId).toBeTruthy();
        yield { type: "text-delta", text: "Finished after recovery." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider, undefined, undefined, {
      "resume-open-step": initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "resume-bot",
      sessionId: "resume-open-step",
      provider: "resume-open-step",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(modelRequests).toBe(1);
    expect(
      handle.agent.session.events.filter(
        (event) =>
          event.type === "step/start" && event.turn === 1 && event.step === 2,
      ),
    ).toHaveLength(1);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({ type: "model/request", turn: 1, step: 2 }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });
  test("carries the provider failure reason on a model-error turn/end", async () => {
    const provider: LlmProvider = {
      id: "provider-rejects",
      async *stream() {
        throw new LlmEffectNotStartedError(
          "Ollama Cloud responded 401: invalid api key",
        );
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      botId: "reason-bot",
      sessionId: "provider-rejects",
      provider: "provider-rejects",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Say hello.");
    await handle.agent.whenIdle();

    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      turn: 1,
      outcome: "model-error",
      reason: "Ollama Cloud responded 401: invalid api key",
    });
  });

  test("bounds a turn/end reason to what the session event contract accepts", async () => {
    const provider: LlmProvider = {
      id: "provider-verbose-failure",
      async *stream() {
        throw new LlmEffectNotStartedError("x".repeat(900));
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      botId: "reason-bot",
      sessionId: "provider-verbose-failure",
      provider: "provider-verbose-failure",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Say hello.");
    await handle.agent.whenIdle();

    const end = handle.agent.session.events.at(-1);
    expect(end?.type).toBe("turn/end");
    expect(end?.type === "turn/end" ? end.reason : undefined).toBe(
      "x".repeat(500),
    );
    expect(() => decodeSessionEvent(end)).not.toThrow();
  });

  test("omits a reason from a completed turn/end", async () => {
    const provider: LlmProvider = {
      id: "provider-completes",
      async *stream() {
        yield { type: "text-delta", text: "Hello." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      botId: "reason-bot",
      sessionId: "provider-completes",
      provider: "provider-completes",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Say hello.");
    await handle.agent.whenIdle();

    const end = handle.agent.session.events.at(-1);
    expect(end).toMatchObject({ type: "turn/end", outcome: "completed" });
    expect(end && Object.hasOwn(end, "reason")).toBe(false);
  });
});

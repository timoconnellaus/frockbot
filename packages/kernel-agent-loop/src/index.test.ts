import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeSessionEvent,
  LlmEffectNotStartedError,
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
import { AgentLoop, STEP_LIMIT_REASON_V1 } from "./index.js";

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
  test("journals one reported usage event for a model request", async () => {
    const provider: LlmProvider = {
      id: "reported-usage",
      async *stream() {
        yield { type: "text-delta", text: "done" };
        yield {
          type: "usage",
          usage: {
            inputTokens: 41,
            outputTokens: 9,
            cachedInputTokens: 7,
            reasoningTokens: 3,
          },
        };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-usage",
      sessionId: "reported-usage",
      provider: provider.id,
      model: "priced-model",
    });

    handle.agent.send("count this");
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/usage",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "model/usage",
        provider: "reported-usage",
        model: "priced-model",
        inputTokens: 41,
        outputTokens: 9,
        cachedInputTokens: 7,
        reasoningTokens: 3,
        estimated: false,
      }),
    ]);
  });

  test("estimates and marks usage when a provider reports no counts", async () => {
    const provider: LlmProvider = {
      id: "estimated-usage",
      async *stream() {
        yield { type: "text-delta", text: "an answer" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-usage",
      sessionId: "estimated-usage",
      provider: provider.id,
      model: "unmetered-model",
    });

    handle.agent.send("count approximately");
    await handle.agent.whenIdle();

    const usage = handle.agent.session.events.filter(
      (event) => event.type === "model/usage",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      type: "model/usage",
      provider: "estimated-usage",
      model: "unmetered-model",
      estimated: true,
    });
    if (usage[0]?.type !== "model/usage") throw new Error("usage missing");
    expect(usage[0].inputTokens).toBeGreaterThan(0);
    expect(usage[0].outputTokens).toBeGreaterThan(0);
  });

  test("journals a structured-output downgrade and typed validation failure", async () => {
    const provider: LlmProvider = {
      id: "structured-failure",
      supports: { structuredOutput: "none" },
      async *stream() {
        yield {
          type: "response-format-note",
          note: {
            code: "structured-output-downgraded",
            requested: "json_schema",
            effective: "prompt",
            message: "Fake provider used prompt guidance",
          },
        };
        yield { type: "text-delta", text: '{"answer":4}' };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    root.on("agent/request", async (_agent, _request, _signal, next) => ({
      ...(await next()),
      responseFormat: {
        type: "json_schema",
        name: "answer",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    }));
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-structured-failure",
      sessionId: "structured-failure",
      provider: provider.id,
      model: "fake",
    });

    handle.agent.send("answer as an object");
    await handle.agent.whenIdle();

    expect(
      handle.agent.session.events.find(
        (event) => event.type === "model/response-format-note",
      ),
    ).toMatchObject({
      type: "model/response-format-note",
      note: { effective: "prompt" },
    });
    expect(
      handle.agent.session.events.find(
        (event) => event.type === "model/response-failed",
      ),
    ).toMatchObject({
      type: "model/response-failed",
      failure: { code: "schema-mismatch" },
    });
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/usage",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "model/usage",
        provider: "structured-failure",
        estimated: true,
      }),
    ]);
    expect(
      handle.agent.session.events.findLast(
        (event) => event.type === "turn/end",
      ),
    ).toMatchObject({ type: "turn/end", outcome: "model-error" });
  });

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

  test("re-issues an unresolved model request under the same key", async () => {
    const dispatched: string[] = [];
    const provider: LlmProvider = {
      id: "keyed",
      async *stream(request) {
        dispatched.push(request.requestId);
        yield { type: "text-delta", text: "Answered once" };
        yield { type: "finish", reason: "completed" };
      },
    };
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
          requestId: "durable-request-1",
          provider: "keyed",
          model: "model-1",
          system: "",
          messages: [],
          tools: [],
        },
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const root = await mountRuntime(provider, undefined, undefined, {
      recovering: initial,
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-1",
      sessionId: "recovering",
      provider: "keyed",
      model: "model-1",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    // The exact request the log carries, sent again under its own id: at most
    // once for a provider that honours the key, and never investigated.
    expect(dispatched).toEqual(["durable-request-1"]);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "assistant/message",
        requestId: "durable-request-1",
        text: "Answered once",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("marks each dispatch of one key with its own model/request", async () => {
    const provider: LlmProvider = {
      id: "partial-provider",
      async *stream() {
        yield { type: "text-delta", text: "Finished." };
        yield { type: "finish", reason: "completed" };
      },
    };
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
    const root = await mountRuntime(provider, undefined, undefined, {
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

    // Two sends of one key. The second `model/request` is what tells every
    // reader of the answer so far that the words before it were abandoned.
    const timeline = handle.agent.session.events.flatMap((event) =>
      (event.type === "model/request" &&
        event.request.requestId === "partial-request") ||
      (event.type === "assistant/chunk" &&
        event.requestId === "partial-request")
        ? [event.type === "model/request" ? "sent" : event.text]
        : [],
    );
    expect(timeline).toEqual(["sent", "A", "sent", "Finished."]);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "assistant/message",
        requestId: "partial-request",
        text: "Finished.",
      }),
    );
  });

  test("retries a lost response under the same key, not a new one", async () => {
    const dispatched: string[] = [];
    const provider: LlmProvider = {
      id: "lost-response",
      async *stream(request) {
        dispatched.push(request.requestId);
        if (dispatched.length === 1) {
          throw new Error("response lost after dispatch");
        }
        yield { type: "text-delta", text: "Second time" };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-lost",
      sessionId: "agent-lost",
      provider: "lost-response",
      model: "model-1",
    });

    handle.agent.send("Ask once.");
    await handle.agent.whenIdle();

    // An uncertain failure is retried now that the key makes the retry safe,
    // and the retry is the same call rather than a second one.
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toBe(dispatched[1]);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/request",
      ),
    ).toHaveLength(2);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("settles a cancelled Turn rather than holding it open", async () => {
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

    // The request stays in the log with no answer — it is keyed, so a resume
    // could send it again — and the Turn is closed either way rather than
    // parked on a question nobody can answer.
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
    expect(
      handle.agent.session.events.some(
        (event) => event.type === "assistant/message",
      ),
    ).toBe(false);
  });

  test("fails a Turn whose provider says the request never started", async () => {
    const provider: LlmProvider = {
      id: "pre-effect-failure",
      async *stream() {
        throw new LlmEffectNotStartedError(
          "provider rejected before effect creation",
        );
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-no-effect",
      sessionId: "agent-no-effect",
      provider: "pre-effect-failure",
      model: "model-1",
    });

    handle.agent.send("Try once.");
    await handle.agent.whenIdle();

    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
      reason: expect.stringContaining("provider rejected before effect"),
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

  test("cancels after a re-issued assistant response is durably flushed", async () => {
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
      async *stream(request) {
        expect(request.requestId).toBe("flush-request");
        yield { type: "text-delta", text: "Recovered answer" };
        yield { type: "finish", reason: "completed" };
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

  test("settles a cancelled tool occurrence instead of holding it open", async () => {
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
    const tool: ToolDefinition = {
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

    // The call carried its key, so nothing has to be worked out afterwards:
    // the occurrence closes as interrupted and the Turn ends.
    expect(effectId).toBe("tool:1:1:0");
    expect(executions).toBe(1);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        status: "interrupted",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
  });
  test("re-issues an open tool occurrence under the same effect id", async () => {
    let modelRequests = 0;
    const executed: string[] = [];
    const provider: LlmProvider = {
      id: "open-tool-recovery",
      async *stream() {
        modelRequests += 1;
        yield { type: "text-delta", text: "Recovered safely." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const tool: ToolDefinition = {
      name: "external",
      description: "An effect keyed by its occurrence.",
      inputSchema: { type: "object" },
      execute(_input, context) {
        executed.push(context.effectId);
        return Promise.resolve({ content: "settled once", isError: false });
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

    // The occurrence id is the key. The tool is asked again under it — a tool
    // that honours the key runs its effect once — rather than the loop trying
    // to find out what the interrupted call did.
    expect(executed).toEqual(["tool:1:1:0"]);
    expect(modelRequests).toBe(1);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        content: "settled once",
        status: "completed",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });
  test("re-runs an open idempotent tool under its durable effect id", async () => {
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

  test("resumes an interrupted turn without admitting its input twice", async () => {
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
      async *stream(request) {
        // The same key the log carries: a resume sends the call again, it does
        // not compose a new one.
        expect(request.requestId).toBe("uncertain-request");
        yield { type: "text-delta", text: "Resumed safely." };
        yield { type: "finish", reason: "completed" };
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
    // Two sends of one key, and exactly one answer.
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/request",
      ),
    ).toHaveLength(2);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "assistant/message",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "assistant/message",
        requestId: "uncertain-request",
      }),
    ]);
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

  test("reaching the step limit is reported as stopping, not as a model error", async () => {
    const provider: LlmProvider = {
      id: "never-stops",
      async *stream() {
        yield {
          type: "tool-call",
          call: {
            id: `call-${crypto.randomUUID()}`,
            name: "loop_tool",
            input: {},
          },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
    };
    const errors: unknown[] = [];
    const root = await mountRuntime(provider, {
      name: "loop_tool",
      description: "Never ends the Turn.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "again", isError: false }),
    });
    root.on("agent/error", (_agent, error) => {
      errors.push(error);
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "step-limit-bot",
      sessionId: "step-limit",
      provider: "never-stops",
      model: "test-model",
    });

    handle.agent.send("keep going");
    await handle.agent.whenIdle();

    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "interrupted",
      reason: STEP_LIMIT_REASON_V1,
    });
    // Nothing about the model failed, so nothing is reported as if it had.
    expect(errors).toEqual([]);
  });

  test("a Turn whose first flush fails ends once instead of spinning", async () => {
    let streams = 0;
    const provider: LlmProvider = {
      id: "persist-fails",
      async *stream() {
        streams += 1;
        yield { type: "finish", reason: "completed" };
      },
    };
    let writes = 0;
    const root = await mountRuntime(
      provider,
      undefined,
      // Storage that is simply gone: every durable write rejects.
      () => {
        writes += 1;
        return Promise.reject(new Error("durable storage is unavailable"));
      },
    );
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "persist-bot",
      sessionId: "persist-fails",
      provider: "persist-fails",
      model: "test-model",
    });

    handle.agent.send("say something");
    // The failure reaches the caller, exactly once: the input was claimed
    // before the flush, so nothing hands it back to be started again.
    await expect(handle.agent.whenIdle()).rejects.toThrow(
      "durable storage is unavailable",
    );
    const attempts = writes;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writes).toBe(attempts);
    expect(streams).toBe(0);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "turn/start",
      ),
    ).toHaveLength(1);
  });

  // A model that writes an acknowledgement and then calls tools has said
  // something to the person, and the Package that owns the Bot's voice has to
  // hear about it *before* the work it was announcing produces results.
  test("raises assistant text ahead of the tools the same step called", async () => {
    const provider: LlmProvider = {
      id: "acknowledging-model",
      async *stream() {
        yield { type: "text-delta", text: "On it — building it now." };
        yield {
          type: "tool-call",
          call: { id: "call-1", name: "build", input: {} },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
    };
    const order: string[] = [];
    const root = await mountRuntime(provider, {
      name: "build",
      description: "Does the work the acknowledgement announced.",
      inputSchema: { type: "object" },
      execute: () => {
        order.push("tool");
        return Promise.resolve({ content: "built", isError: true });
      },
    });
    const seen: string[] = [];
    root.on("agent/assistant-text", async (_agent, text, position) => {
      order.push("assistant-text");
      seen.push(`${position.turn}:${position.step}:${text}`);
      seen.push(`tools:${(position.toolNames ?? []).join(",")}`);
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-ack",
      sessionId: "acknowledging-model",
      provider: provider.id,
      model: "model-1",
    });

    handle.agent.send("build me a countdown");
    await handle.agent.whenIdle();

    expect(seen[0]).toBe("1:1:On it — building it now.");
    expect(seen[1]).toBe("tools:build");
    expect(order[0]).toBe("assistant-text");
    expect(order).toContain("tool");
  });

  // A step with nothing to say, or one that says everything it has and stops,
  // raises nothing: the first has no text, and the second's text is the reply.
  test("raises nothing for a step with no text or no tools", async () => {
    const provider: LlmProvider = {
      id: "quiet-model",
      async *stream() {
        yield { type: "text-delta", text: "Here is your answer." };
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    let raised = 0;
    root.on("agent/assistant-text", async () => {
      raised += 1;
    });
    const handle = await root.agents.create({
      ...allowEffectOptions,
      botId: "bot-quiet",
      sessionId: "quiet-model",
      provider: provider.id,
      model: "model-1",
    });

    handle.agent.send("answer me");
    await handle.agent.whenIdle();

    expect(raised).toBe(0);
  });
});

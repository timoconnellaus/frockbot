import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentRegistry,
  type AgentOptions,
  LlmEffectNotStartedError,
  type LlmReconciliationOutcome,
  LlmRegistry,
  type LlmProvider,
  type LlmStreamEvent,
  type PersistSessionEvents,
  type SessionEvent,
  SessionStore,
  SystemPromptRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "@frockbot/agent-core";
import { Context, type Plugin } from "cordis";
import { AgentLoop } from "./index.js";

const roots: Context[] = [];

function recovered(
  ...events: LlmStreamEvent[]
): Promise<LlmReconciliationOutcome> {
  return Promise.resolve({
    status: "recovered",
    events,
  });
}

async function mountRuntime(
  provider: LlmProvider,
  tool?: ToolDefinition,
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
    const toolPlugin: Plugin.Function = (ctx) => ctx.tools.register(tool);
    toolPlugin.inject = ["tools"];
    await root.plugin(toolPlugin);
  }
  await root.plugin(AgentLoop, { maxSteps: 4 });
  return root;
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
          event.type === "tool/call" && event.call.id === "recovered-call",
      ),
    ).toHaveLength(1);
    expect(
      handle.agent.session.events.filter(
        (event) =>
          event.type === "tool/result" &&
          event.callId === "recovered-call" &&
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
      { botId: string; agentId: string; sessionId: string } | undefined;
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
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
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
      events.find((event) => event.type === "model/request"),
    ).toMatchObject({
      request: {
        provider: "scripted",
        model: "test-model",
        system: "You are the FrockBot test agent.",
        tools: [{ name: "echo" }],
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
    expect(handle.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "Tool returned hello.",
    });

    const session = handle.agent.session;
    await handle.dispose();
    expect(root.agents.list()).toEqual([]);
    expect(session.events.at(-1)?.type).toBe("session/disposed");
  });

  test("cancels an active stream and closes its step and turn", async () => {
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

    const stepEnds = handle.agent.session.events.filter(
      (event) => event.type === "step/end",
    );
    const turnEnds = handle.agent.session.events.filter(
      (event) => event.type === "turn/end",
    );
    expect(stepEnds).toHaveLength(1);
    expect(turnEnds).toHaveLength(1);
    expect(stepEnds[0]).toMatchObject({ outcome: "cancelled" });
    expect(turnEnds[0]).toMatchObject({ outcome: "cancelled" });
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
      validate: () => true,
      execute: () => Promise.reject(new Error("provider revoked")),
    };
    const root = await mountRuntime(provider, tool, (_sessionId, events) => {
      durableTypes.push(...events.map((event) => event.type));
      return Promise.resolve();
    });
    const handle = await root.agents.create({
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
        callId: "call-failed",
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
      expect.objectContaining({ type: "tool/call", call }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
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
});

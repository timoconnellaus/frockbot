import { afterEach, describe, expect, test } from "bun:test";
import {
  type LlmProvider,
  LoopHookListV1,
  type SessionEvent,
  SessionStore,
  type ToolDefinition,
} from "@frockbot/core/contracts";
import { LlmRegistry } from "@frockbot/core/models";
import { SystemPromptRegistry } from "@frockbot/core/prompt";
import { ToolRegistry } from "@frockbot/core/tools";
import type { AgentEffectAdmission } from "./agent.js";
import { type AgentLoop, createAgentLoop } from "./index.js";

// A call whose callee honours no key is sent at most once: its admission is
// the durable record that it left, and a resume that finds one settles the
// call as uncertain instead of sending it again. A keyed call is sent again
// under its occurrence id, which the callee recognises.

const loops: AgentLoop[] = [];
afterEach(async () => {
  await Promise.all(loops.splice(0).map((loop) => loop.dispose()));
});

const timestamp = "2026-09-28T00:00:00.000Z";

/** The run's admission record, as the Bot Durable Object keeps it. */
class Admissions {
  readonly records = new Map<string, AgentEffectAdmission>();

  admit = (effect: AgentEffectAdmission): Promise<boolean> => {
    if (!this.records.has(effect.effectId)) {
      this.records.set(effect.effectId, effect);
    }
    return Promise.resolve(true);
  };

  sentOnce = (effectId: string): Promise<boolean> => {
    const record = this.records.get(effectId);
    return Promise.resolve(record?.kind === "tool" && record.once);
  };
}

function mount(
  sessionId: string,
  tool: ToolDefinition,
  initial?: SessionEvent[],
): { loop: AgentLoop; persisted: SessionEvent[]; hooks: LoopHookListV1 } {
  const persisted: SessionEvent[] = [...(initial ?? [])];
  const hooks = new LoopHookListV1();
  const sessions = new SessionStore({
    persistEvents: (_, events) => {
      persisted.push(...structuredClone(events));
      return Promise.resolve();
    },
    ...(initial ? { initialSessions: { [sessionId]: initial } } : {}),
  });
  const systemPrompt = new SystemPromptRegistry(hooks);
  const llm = new LlmRegistry(hooks);
  const tools = new ToolRegistry(hooks, "FrockBot", systemPrompt);
  systemPrompt.register({ id: "identity", render: () => "Test agent." });
  const provider: LlmProvider = {
    id: "once",
    async *stream(request) {
      if (request.messages.at(-1)?.role === "tool") {
        yield { type: "text-delta", text: "Done." };
      } else {
        yield {
          type: "tool-call",
          call: { id: "call-1", name: tool.name, input: { to: "a@b.c" } },
        };
      }
      yield { type: "finish", reason: "completed" };
    },
  };
  llm.register(provider);
  tools.register(tool);
  const loop = createAgentLoop(
    { sessions, systemPrompt, llm, tools, hooks },
    {
      maxSteps: 4,
      composition: {
        generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
        artifactSetHash: "a".repeat(64),
      },
    },
  );
  loops.push(loop);
  return { loop, persisted, hooks };
}

/** A log that stopped after the call's intent: the isolate was evicted. */
function evictedAfterIntent(toolName: string): SessionEvent[] {
  return [
    { type: "session/created", createdAt: timestamp },
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "model/request",
      turn: 1,
      step: 1,
      request: {
        requestId: "request-1",
        provider: "once",
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
      requestId: "request-1",
      text: "",
      toolCalls: [{ id: "call-1", name: toolName, input: { to: "a@b.c" } }],
    },
    {
      type: "tool/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: toolName,
      input: { to: "a@b.c" },
    },
  ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
}

function sendTool(
  sent: string[],
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: "send_email",
    description: "Send an email.",
    inputSchema: { type: "object" },
    execute: (_input, context) => {
      sent.push(context.effectId);
      return Promise.resolve({ content: "sent", isError: false });
    },
    ...overrides,
  };
}

describe("at-most-once on resume", () => {
  test("an unkeyed call's admission records it as sent before it is dispatched", async () => {
    const admissions = new Admissions();
    let durableAtDispatch: AgentEffectAdmission | undefined;
    let intentAtDispatch = false;
    const { loop, persisted } = mount(
      "first-run",
      sendTool([], {
        unkeyed: true,
        execute: (_input, context) => {
          durableAtDispatch = admissions.records.get(context.effectId);
          intentAtDispatch = persisted.some(
            (event) =>
              event.type === "tool/call" &&
              event.occurrenceId === context.effectId,
          );
          return Promise.resolve({ content: "sent", isError: false });
        },
      }),
    );
    const handle = await loop.create({
      admitEffect: admissions.admit,
      sentOnce: admissions.sentOnce,
      botId: "bot-1",
      sessionId: "first-run",
      provider: "once",
      model: "test-model",
    });

    handle.agent.send("email them");
    await handle.agent.whenIdle();

    expect(intentAtDispatch).toBe(true);
    expect(durableAtDispatch).toEqual({
      kind: "tool",
      effectId: "tool:1:1:0",
      once: true,
    });
  });

  test("an unkeyed call dispatched before an eviction settles as uncertain and is not sent again", async () => {
    const admissions = new Admissions();
    await admissions.admit({
      kind: "tool",
      effectId: "tool:1:1:0",
      once: true,
    });
    const sent: string[] = [];
    let reviewed = 0;
    const { loop, hooks } = mount(
      "evicted",
      sendTool(sent, { unkeyed: true }),
      evictedAfterIntent("send_email"),
    );
    // Nothing is prepared for it either: a fresh review could contradict an
    // effect that already happened.
    hooks.add({
      prepareTool: (_call, _context, next) => {
        reviewed += 1;
        return next();
      },
    });
    const handle = await loop.create({
      admitEffect: admissions.admit,
      sentOnce: admissions.sentOnce,
      botId: "bot-1",
      sessionId: "evicted",
      provider: "once",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(sent).toEqual([]);
    expect(reviewed).toBe(0);
    const result = handle.agent.session.activeRunJournal.find(
      (event) => event.type === "tool/result",
    );
    expect(result).toMatchObject({
      occurrenceId: "tool:1:1:0",
      isError: true,
      status: "interrupted",
    });
    expect(result?.type === "tool/result" && result.content).toContain(
      "cannot tell whether this call took effect",
    );
    expect(handle.agent.session.activeRunJournal.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("a keyed call dispatched before an eviction is sent again under the same key", async () => {
    const admissions = new Admissions();
    await admissions.admit({
      kind: "tool",
      effectId: "tool:1:1:0",
      once: false,
    });
    const sent: string[] = [];
    const { loop } = mount(
      "evicted-keyed",
      sendTool(sent),
      evictedAfterIntent("send_email"),
    );
    const handle = await loop.create({
      admitEffect: admissions.admit,
      sentOnce: admissions.sentOnce,
      botId: "bot-1",
      sessionId: "evicted-keyed",
      provider: "once",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(sent).toEqual(["tool:1:1:0"]);
    expect(
      handle.agent.session.activeRunJournal.find(
        (event) => event.type === "tool/result",
      ),
    ).toMatchObject({ content: "sent", isError: false, status: "completed" });
  });

  test("an unkeyed call whose intent was journaled but never admitted is sent", async () => {
    const admissions = new Admissions();
    const sent: string[] = [];
    const { loop } = mount(
      "evicted-before-admission",
      sendTool(sent, { unkeyed: true }),
      evictedAfterIntent("send_email"),
    );
    const handle = await loop.create({
      admitEffect: admissions.admit,
      sentOnce: admissions.sentOnce,
      botId: "bot-1",
      sessionId: "evicted-before-admission",
      provider: "once",
      model: "test-model",
    });

    handle.agent.resume();
    await handle.agent.whenIdle();

    expect(sent).toEqual(["tool:1:1:0"]);
  });
});

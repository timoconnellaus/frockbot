import { describe, expect, test } from "bun:test";
import {
  parseChatCompletionStreamV1,
  renderVoiceSystemPromptV1,
  runVoiceTurnV1,
  VOICE_ANSWER_MAX_CHARS_V1,
  VOICE_PROMPT_MAX_LOG_FACTS_V1,
  VOICE_TURN_BRIDGE_V1,
  VOICE_TURN_MAX_STEPS_V1,
  type VoiceAssistantHostV1,
  type VoiceTurnChunkV1,
  type VoiceTurnResultV1,
} from "./assistant.js";
import type { MemoryTierReadV1 } from "@frockbot/app/memory/store";

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  // Split at awkward boundaries so the parser proves it reassembles lines.
  const chunks = [lines.slice(0, 7), lines.slice(7, 40), lines.slice(40)];
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const text = (content: string) => ({ choices: [{ delta: { content } }] });
const toolCall = (index: number, id: string, name: string, args: string) => ({
  choices: [
    {
      delta: {
        tool_calls: [{ index, id, function: { name, arguments: args } }],
      },
    },
  ],
});
const toolArgs = (index: number, args: string) => ({
  choices: [
    { delta: { tool_calls: [{ index, function: { arguments: args } }] } },
  ],
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function said(
  iterable: AsyncIterable<VoiceTurnChunkV1>,
): Promise<string[]> {
  return (await collect(iterable)).map((chunk) => chunk.text);
}

describe("the chat completion stream parser", () => {
  test("yields text deltas in order and tool calls assembled by index", async () => {
    const events = await collect(
      parseChatCompletionStreamV1(
        sse([
          text("Hel"),
          text("lo"),
          toolCall(0, "call_1", "ask_bot", '{"bot_id":'),
          toolArgs(0, '"remy","message":"plan"}'),
          toolCall(1, "call_2", "list_bots", "{}"),
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      {
        type: "tool-call",
        call: {
          id: "call_1",
          name: "ask_bot",
          arguments: '{"bot_id":"remy","message":"plan"}',
        },
      },
      {
        type: "tool-call",
        call: { id: "call_2", name: "list_bots", arguments: "{}" },
      },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  test("ignores comments, blank lines and malformed data", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            ': keep-alive\n\ndata: {not json}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n',
          ),
        );
        controller.close();
      },
    });
    expect(await collect(parseChatCompletionStreamV1(stream))).toEqual([
      { type: "text", text: "ok" },
      { type: "finish", reason: undefined },
    ]);
  });
});

function host(
  steps: (() => unknown[])[],
  overrides: Partial<VoiceAssistantHostV1> = {},
): VoiceAssistantHostV1 & {
  bodies: Record<string, unknown>[];
  asked: string[];
} {
  const bodies: Record<string, unknown>[] = [];
  const asked: string[] = [];
  let step = 0;
  return {
    bodies,
    asked,
    chat: async (body) => {
      bodies.push(body);
      const events = steps[Math.min(step, steps.length - 1)]!();
      step += 1;
      return sse(events);
    },
    listBots: async () => [
      { botId: "remy", name: "Remy", activity: "idle" },
      { botId: "finch", name: "Finch", activity: "working" },
    ],
    botStatus: async (botId) => `${botId} is idle`,
    askBot: async (botId, message) => {
      asked.push(`${botId}:${message}`);
      return `Asked ${botId}.`;
    },
    cancelBot: async (botId) => `Stopped ${botId}.`,
    recallProject: async (projectId) => `Project ${projectId}: nothing yet.`,
    ...overrides,
  };
}

const baseInput = (transcript: string) => ({
  system: "sys",
  history: [] as { role: "user" | "assistant"; content: string }[],
  transcript,
  signal: new AbortController().signal,
});

describe("one voice turn", () => {
  test("streams a plain answer and reports it", async () => {
    const h = host([() => [text("Sure, "), text("it is ten.")]]);
    let result: VoiceTurnResultV1 | undefined;
    const chunks = await said(
      runVoiceTurnV1(h, baseInput("what time is it"), (r) => {
        result = r;
      }),
    );
    expect(chunks).toEqual(["Sure, ", "it is ten."]);
    expect(result).toEqual({
      answer: "Sure, it is ten.",
      delegations: 0,
      outcome: "answered",
    });
    expect(h.bodies).toHaveLength(1);
    expect((h.bodies[0]!.messages as unknown[]).at(-1)).toEqual({
      role: "user",
      content: "what time is it",
    });
    expect(h.bodies[0]!.tools).toBeDefined();
  });

  test("runs tools, feeds results back, and speaks the second answer", async () => {
    const h = host([
      () => [
        toolCall(
          0,
          "c1",
          "ask_bot",
          '{"bot_id":"remy","message":"plan my week"}',
        ),
      ],
      () => [text("I've asked Remy to plan your week.")],
    ]);
    let result: VoiceTurnResultV1 | undefined;
    const chunks = await collect(
      runVoiceTurnV1(h, baseInput("get remy to plan my week"), (r) => {
        result = r;
      }),
    );
    // The tool step is bridged aloud; the bridge is spoken, not answered,
    // and it is labelled as filler so a caller timing the model does not
    // read it as the model's first word.
    expect(chunks).toEqual([
      { kind: "bridge", text: `${VOICE_TURN_BRIDGE_V1} ` },
      { kind: "text", text: "I've asked Remy to plan your week." },
    ]);
    expect(result?.answer).toBe("I've asked Remy to plan your week.");
    expect(h.asked).toEqual(["remy:plan my week"]);
    expect(result?.delegations).toBe(1);
    const second = h.bodies[1]!.messages as {
      role: string;
      content: string;
      tool_call_id?: string;
    }[];
    expect(second.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "Asked remy.",
    });
    expect(second.at(-2)?.role).toBe("assistant");
  });

  test("a tool that throws becomes a result the model hears, not a failed turn", async () => {
    const h = host(
      [
        () => [toolCall(0, "c1", "bot_status", '{"bot_id":"ghost"}')],
        () => [text("I couldn't find that Bot.")],
      ],
      {
        botStatus: async () => {
          throw new Error("no such Bot");
        },
      },
    );
    const chunks = await said(runVoiceTurnV1(h, baseInput("x"), () => {}));
    expect(chunks).toEqual([
      `${VOICE_TURN_BRIDGE_V1} `,
      "I couldn't find that Bot.",
    ]);
    const second = h.bodies[1]!.messages as { content: string }[];
    expect(second.at(-1)?.content).toBe("That failed: no such Bot");
  });

  test("the last step offers no tools so the model cannot loop forever", async () => {
    const h = host([() => [toolCall(0, "c", "list_bots", "{}")]]);
    let result: VoiceTurnResultV1 | undefined;
    const chunks = await said(
      runVoiceTurnV1(h, baseInput("loop"), (r) => {
        result = r;
      }),
    );
    expect(h.bodies).toHaveLength(VOICE_TURN_MAX_STEPS_V1);
    expect(h.bodies.at(-1)!.tools).toBeUndefined();
    // The bridge was said once, and on its own it is not an answer.
    expect(chunks).toEqual([`${VOICE_TURN_BRIDGE_V1} `]);
    expect(result?.outcome).toBe("no_output");
    expect(result?.answer).toBe("");
  });

  test("a tool step the model has already spoken into is not bridged", async () => {
    const h = host([
      () => [
        text("Let me check. "),
        toolCall(0, "c1", "bot_status", '{"bot_id":"remy"}'),
      ],
      () => [text("Remy is idle.")],
    ]);
    const chunks = await said(runVoiceTurnV1(h, baseInput("x"), () => {}));
    expect(chunks).toEqual(["Let me check. ", "Remy is idle."]);
  });

  test("refuses to delegate past the per-turn bound", async () => {
    const calls = Array.from({ length: 9 }, (_, i) =>
      toolCall(i, `c${i}`, "ask_bot", `{"bot_id":"remy","message":"job ${i}"}`),
    );
    const h = host([() => calls, () => [text("Done asking.")]]);
    let result: VoiceTurnResultV1 | undefined;
    await collect(
      runVoiceTurnV1(h, baseInput("many"), (r) => {
        result = r;
      }),
    );
    expect(h.asked).toHaveLength(8);
    expect(result?.delegations).toBe(8);
    const second = h.bodies[1]!.messages as { role: string; content: string }[];
    expect(second.filter((m) => m.role === "tool").at(-1)?.content).toContain(
      "Refused",
    );
  });

  test("an abort mid-stream stops speaking and reports aborted", async () => {
    const controller = new AbortController();
    const h = host([() => [text("one "), text("two "), text("three")]]);
    let result: VoiceTurnResultV1 | undefined;
    const chunks: string[] = [];
    for await (const chunk of runVoiceTurnV1(
      h,
      { ...baseInput("x"), signal: controller.signal },
      (r) => {
        result = r;
      },
    )) {
      chunks.push(chunk.text);
      controller.abort();
    }
    expect(chunks).toEqual(["one "]);
    expect(result?.outcome).toBe("aborted");
  });

  test("bounds the spoken answer", async () => {
    const long = "a".repeat(VOICE_ANSWER_MAX_CHARS_V1 + 50);
    const h = host([() => [text(long.slice(0, 700)), text(long.slice(700))]]);
    let result: VoiceTurnResultV1 | undefined;
    const chunks = await said(
      runVoiceTurnV1(h, baseInput("x"), (r) => {
        result = r;
      }),
    );
    expect(chunks.join("").length).toBe(700);
    expect(result?.answer.length).toBe(700);
  });

  test("history is bounded to the newest messages", async () => {
    const h = host([() => [text("ok")]]);
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `m${i}`,
    }));
    await collect(runVoiceTurnV1(h, { ...baseInput("x"), history }, () => {}));
    const messages = h.bodies[0]!.messages as { content: string }[];
    expect(messages).toHaveLength(1 + 12 + 1);
    expect(messages[1]!.content).toBe("m18");
  });
});

describe("the system prompt", () => {
  const tier = (
    facts: { date: string; text: string; kind: "profile" | "log" }[],
  ): MemoryTierReadV1 => ({
    root: { kind: "user-memory", userId: "u" },
    profile: facts
      .filter((f) => f.kind === "profile")
      .map((f) => ({ ...f, botId: "b", generationId: "g" })),
    recent: facts
      .filter((f) => f.kind === "log")
      .map((f) => ({ ...f, botId: "b", generationId: "g" })),
    sources: [],
    logTotal: 0,
  });

  test("carries live Bots, bounded memory, and answers owed", () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    const facts = [
      {
        date: "2026-09-01",
        text: "Prefers short answers",
        kind: "profile" as const,
      },
      { date: "2026-07-01", text: "Old thing", kind: "log" as const },
      ...Array.from({ length: 40 }, (_, i) => ({
        date: "2026-09-09",
        text: `Recent ${i}`,
        kind: "log" as const,
      })),
    ];
    const prompt = renderVoiceSystemPromptV1({
      bots: [
        {
          botId: "remy",
          name: "Remy <x>",
          description: "planner",
          activity: "working",
        },
      ],
      memory: { user: tier(facts), logDays: 30 },
      unspoken: [{ botName: "Remy", text: "Your week is planned." }],
      now,
    });
    expect(prompt).toContain("- remy: Remy &lt;x&gt; — planner (working)");
    expect(prompt).toContain("Prefers short answers");
    expect(prompt).not.toContain("Old thing");
    expect(prompt.match(/Recent \d+/g)).toHaveLength(
      VOICE_PROMPT_MAX_LOG_FACTS_V1,
    );
    expect(prompt).toContain("Your week is planned.");
    expect(prompt).toContain("2026-09-10");
  });

  test("says when memory could not be read rather than pretending it is empty", () => {
    const prompt = renderVoiceSystemPromptV1({
      bots: [],
      memory: {
        user: { ...tier([]), unavailable: "bucket missing" },
        logDays: 30,
      },
      unspoken: [],
      now: new Date(),
    });
    expect(prompt).toContain("Memory could not be read");
    expect(prompt).toContain("no Bots yet");
  });
});

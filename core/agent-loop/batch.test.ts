// The `batch` meta-tool, as the loop expands it: what each declared call
// journals, what it is keyed on, what order the ordered effects land in, and
// what the model reads back.
import { afterEach, describe, expect, test } from "bun:test";
import {
  BATCH_INVALID_CALL_NAME_V1,
  BATCH_MAX_CALLS_V1,
  BATCH_TOOL_NAME,
  decodeSessionEvent,
  type LlmProvider,
  LoopHookListV1,
  type NormalizedModelRequest,
  type SessionEvent,
  SessionStore,
  TOOL_ATTACHMENT_LIMIT_V1,
  type ToolAttachmentV1,
  type ToolDefinition,
} from "@frockbot/core/contracts";
import { LlmRegistry } from "@frockbot/core/models";
import { SystemPromptRegistry } from "@frockbot/core/prompt";
import { CALL_DYNAMIC_TOOL_NAME, ToolRegistry } from "@frockbot/core/tools";
import { type AgentLoop, createAgentLoop } from "./index.js";

const TEST_COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

const loops: AgentLoop[] = [];

afterEach(async () => {
  await Promise.all(
    loops.splice(0).map((loop) => loop.dispose().catch(() => undefined)),
  );
});

interface BatchTurn {
  events: SessionEvent[];
  requests: NormalizedModelRequest[];
}

interface BatchRun extends BatchTurn {
  /** The aggregate result the model reads back from the batch itself. */
  report: {
    ran: number;
    failed: number;
    attachments?: Record<string, unknown>;
    results: Array<{
      index: number;
      tool: string;
      isError: boolean;
      content: string;
    }>;
  };
  result: Extract<SessionEvent, { type: "tool/result" }>;
}

interface BatchOptions {
  /** A log to resume rather than a fresh Turn to send. */
  resume?: Record<string, SessionEvent[]>;
  admitEffect?: (effect: {
    kind: "model" | "tool";
    effectId: string;
  }) => Promise<boolean>;
}

/**
 * Runs one Turn whose only tool call is a `batch`, through the real loop, the
 * real registry and the real session journal.
 */
async function runTurn(
  definitions: ToolDefinition[],
  calls: unknown,
  options: BatchOptions = {},
): Promise<BatchTurn> {
  const requests: NormalizedModelRequest[] = [];
  // A resumed log already holds the assistant message that declared the
  // batch; the provider is only asked for what comes after it.
  let served = options.resume ? 1 : 0;
  const provider: LlmProvider = {
    id: "batch-provider",
    async *stream(request) {
      requests.push(request);
      if (served++ === 0) {
        yield {
          type: "tool-call",
          call: {
            id: "provider-call",
            name: BATCH_TOOL_NAME,
            input: { calls },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "completed" };
    },
  };
  const hooks = new LoopHookListV1();
  const sessions = new SessionStore(
    options.resume ? { initialSessions: options.resume } : {},
  );
  const systemPrompt = new SystemPromptRegistry(hooks);
  const llm = new LlmRegistry(hooks);
  const tools = new ToolRegistry(hooks, systemPrompt);
  systemPrompt.register({ id: "identity", render: () => "Test agent." });
  llm.register(provider);
  for (const definition of definitions) tools.register(definition);
  const loop = createAgentLoop(
    { sessions, systemPrompt, llm, tools, hooks },
    { maxSteps: 4, composition: TEST_COMPOSITION },
  );
  loops.push(loop);
  const handle = await loop.create({
    admitEffect: options.admitEffect ?? (() => Promise.resolve(true)),
    botId: "bot-batch",
    sessionId: "batch",
    provider: provider.id,
    model: "test-model",
  });

  if (options.resume) handle.agent.resume();
  else handle.agent.send("do the work");
  await handle.agent.whenIdle();

  return { events: [...handle.agent.session.events], requests };
}

/** The batch's own settled result — what the model reads back. */
function batchResultOf(
  turn: BatchTurn,
): Extract<SessionEvent, { type: "tool/result" }> {
  const result = turn.events.find(
    (event) => event.type === "tool/result" && event.name === BATCH_TOOL_NAME,
  );
  if (result?.type !== "tool/result") {
    throw new Error("the batch recorded no result");
  }
  return result;
}

/** The same Turn, with the aggregate result decoded. */
async function runBatch(
  definitions: ToolDefinition[],
  calls: unknown,
  options: BatchOptions = {},
): Promise<BatchRun> {
  const turn = await runTurn(definitions, calls, options);
  const result = batchResultOf(turn);
  return {
    ...turn,
    report: JSON.parse(result.content) as BatchRun["report"],
    result,
  };
}

function toolEvents(
  events: readonly SessionEvent[],
  type: "tool/call" | "tool/result",
): Array<{ occurrenceId: string; name: string }> {
  return events.flatMap((event) =>
    event.type === type
      ? [{ occurrenceId: event.occurrenceId, name: event.name }]
      : [],
  );
}

/** A tool that records the effect id every call ran under. */
function recorder(name: string, effects: string[]): ToolDefinition {
  return {
    name,
    description: `${name} fixture.`,
    inputSchema: { type: "object" },
    execute: (input, context) => {
      effects.push(context.effectId);
      return Promise.resolve({
        content: `${name}:${JSON.stringify(input)}`,
        isError: false,
      });
    },
  };
}

/** A tool whose dispatch throws, so the caller cannot see whether it ran. */
function thrower(name: string, idempotent: boolean): ToolDefinition {
  return {
    name,
    description: `${name} fixture.`,
    inputSchema: { type: "object" },
    idempotent,
    execute: () => Promise.reject(new Error("fetch failed")),
  };
}

/** One image reference, named by the call that produced it. */
function attachmentFor(shot: number): ToolAttachmentV1 {
  return {
    kind: "image",
    mediaType: "image/png",
    workspacePath: {
      root: {
        kind: "package-declared",
        userId: "user-1",
        packageId: "computer",
        rootId: "screenshots",
      },
      path: `bot-1/shot-${shot}.png`,
    },
    contentHash: `${shot}`.padStart(64, "a"),
    bytes: 2048,
  };
}

describe("batch", () => {
  test("is offered to the model as a native tool", () => {
    const hooks = new LoopHookListV1();
    const names = new ToolRegistry(hooks)
      .schemas({ turnType: "chat" })
      .map((schema) => schema.name);

    expect(names).toContain(BATCH_TOOL_NAME);
  });

  test("journals one tool/call and one tool/result per declared call", async () => {
    // The invariant every reader of the durable log depends on — the audit
    // index, the journal's replay skip, the admission fence: one journalled
    // occurrence per effect, named after the tool that actually ran. A batch
    // that performed its calls privately was invisible to all three.
    const effects: string[] = [];
    const run = await runBatch(
      [recorder("alpha", effects), recorder("beta", effects)],
      [
        { tool: "alpha", arguments: { n: 1 } },
        { tool: "beta", arguments: { n: 2 } },
      ],
    );

    expect(toolEvents(run.events, "tool/call")).toEqual([
      { occurrenceId: "tool:1:1:0", name: BATCH_TOOL_NAME },
      { occurrenceId: "tool:1:1:0.0", name: "alpha" },
      { occurrenceId: "tool:1:1:0.1", name: "beta" },
    ]);
    expect(
      toolEvents(run.events, "tool/result").map((event) => event.occurrenceId),
    ).toEqual(
      expect.arrayContaining(["tool:1:1:0", "tool:1:1:0.0", "tool:1:1:0.1"]),
    );
    const call = run.events.find(
      (event) => event.type === "tool/call" && event.name === "beta",
    );
    expect(call).toMatchObject({ input: { n: 2 } });
    // A dot, not a colon: an approval id may not carry a colon. Sharing one
    // id would let the journal and every effect-keyed tool collapse the calls
    // of a batch into one.
    expect([...effects].sort()).toEqual(["tool:1:1:0.0", "tool:1:1:0.1"]);
    expect(run.report).toMatchObject({ ran: 2, failed: 0 });
  });

  test("replays only the calls the journal has no result for", async () => {
    // A crash between two of a batch's calls used to replay all of them. Each
    // call now holds its own result, so the journal's "already settled" skip
    // covers a sub-call exactly as it covers a top-level one.
    const effects: string[] = [];
    const timestamp = "2026-09-16T00:00:00.000Z";
    const calls = [
      { tool: "send_email", arguments: { to: "ada" } },
      { tool: "send_email", arguments: { to: "bob" } },
    ];
    const interrupted = (
      [
        { type: "session/created", createdAt: timestamp },
        { type: "turn/start", turn: 1 },
        { type: "step/start", turn: 1, step: 1 },
        {
          type: "model/request",
          turn: 1,
          step: 1,
          request: {
            requestId: "batch-request",
            provider: "batch-provider",
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
          requestId: "batch-request",
          text: "",
          toolCalls: [
            {
              id: "provider-call",
              name: BATCH_TOOL_NAME,
              input: { calls },
            },
          ],
        },
        {
          type: "tool/call",
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: BATCH_TOOL_NAME,
          input: { calls },
        },
        {
          type: "tool/call",
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0.0",
          name: "send_email",
          input: { to: "ada" },
        },
        {
          type: "tool/result",
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0.0",
          name: "send_email",
          content: "sent",
          isError: false,
          status: "completed",
        },
      ] as const
    ).map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];

    const run = await runBatch([recorder("send_email", effects)], calls, {
      resume: { batch: interrupted },
    });

    expect(effects).toEqual(["tool:1:1:0.1"]);
    expect(run.report.results.map((entry) => entry.content)).toEqual([
      "sent",
      'send_email:{"to":"bob"}',
    ]);
  });

  test("replays the batch's own calls to the model as one tool message", async () => {
    // The sub-calls are the loop's occurrences, not the provider's: a tool
    // message naming a call id the assistant never sent is one the provider
    // rejects. The aggregate is what the model reads.
    const run = await runBatch(
      [recorder("alpha", [])],
      [
        { tool: "alpha", arguments: { n: 1 } },
        { tool: "alpha", arguments: { n: 2 } },
      ],
    );

    const replayed = run.requests
      .at(-1)!
      .messages.filter((message) => message.role === "tool");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      callId: "provider-call",
      name: BATCH_TOOL_NAME,
    });
  });

  test("one failing call does not stop the others", async () => {
    const effects: string[] = [];
    const run = await runBatch(
      [
        recorder("alpha", effects),
        {
          name: "explodes",
          description: "Throws.",
          inputSchema: { type: "object" },
          execute: () => Promise.reject(new Error("the bucket went away")),
        },
      ],
      [
        { tool: "alpha", arguments: {} },
        { tool: "explodes", arguments: {} },
        { tool: "alpha", arguments: {} },
      ],
    );

    expect(run.report.ran).toBe(3);
    expect(run.report.failed).toBe(1);
    expect(run.report.results[1]).toMatchObject({
      index: 1,
      isError: true,
      content:
        "the bucket went away (the loop cannot tell whether this call took effect)",
    });
    expect(effects.length).toBe(2);
  });

  test("reports an unknown tool as that call's failure, not the batch's", async () => {
    const run = await runBatch([], [{ tool: "no_such_tool", arguments: {} }]);

    expect(run.result.isError).toBe(false);
    expect(run.report.failed).toBe(1);
    expect(run.report.results[0]?.isError).toBe(true);
  });

  test("refuses to call itself", async () => {
    const run = await runBatch(
      [],
      [{ tool: BATCH_TOOL_NAME, arguments: { calls: [] } }],
    );

    expect(run.report.results[0]?.content).toBe(
      "batch call 0 was refused: batch cannot call itself",
    );
    // A refusal reaches no tool, but it is still a call the model declared,
    // so it is journalled under its own id like any other.
    expect(toolEvents(run.events, "tool/call")).toEqual([
      { occurrenceId: "tool:1:1:0", name: BATCH_TOOL_NAME },
      { occurrenceId: "tool:1:1:0.0", name: BATCH_INVALID_CALL_NAME_V1 },
    ]);
  });

  test("ends the Turn when any call inside it does", async () => {
    const run = await runBatch(
      [
        recorder("alpha", []),
        {
          name: "finishes",
          description: "Ends the Turn.",
          inputSchema: { type: "object" },
          execute: () =>
            Promise.resolve({
              content: "done",
              isError: false,
              endsTurn: true,
            }),
        },
      ],
      [
        { tool: "alpha", arguments: {} },
        { tool: "finishes", arguments: {} },
      ],
    );

    // Without this a send_to_user with disposition "finish", a widget or an
    // approval inside a batch would silently fail to end the Turn: the Turn
    // would run on and ask the model again.
    expect(run.requests).toHaveLength(1);
    expect(run.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("a structurally invalid call fails alone, and the rest still run", async () => {
    const effects: string[] = [];
    const run = await runBatch(
      [recorder("alpha", effects)],
      [
        { tool: "alpha", arguments: { n: 1 } },
        { tool: "alpha", arguments: { n: 2 } },
        { tool: "alpha", arguments: ["not an object"] },
      ],
    );

    // Losing two good calls because the third was malformed is exactly what
    // the batch exists to avoid, and the report names what was wrong with
    // that one call so the model repairs it rather than guessing.
    expect(run.result.isError).toBe(false);
    expect(run.report).toMatchObject({ ran: 3, failed: 1 });
    expect(run.report.results[2]).toMatchObject({
      index: 2,
      isError: true,
      content: "batch call 2 was refused: its arguments must be an object",
    });
    expect(effects).toHaveLength(2);
  });

  test("a call missing its tool name fails alone", async () => {
    const effects: string[] = [];
    const run = await runBatch(
      [recorder("alpha", effects)],
      [{ arguments: {} }, { tool: "alpha", arguments: {} }],
    );

    expect(run.report.failed).toBe(1);
    expect(run.report.results[0]?.content).toBe(
      "batch call 0 was refused: it needs a tool name",
    );
    // The surviving call keeps the id its declared position gives it, so a
    // replay re-issues it under the same key.
    expect(effects).toEqual(["tool:1:1:0.1"]);
    // The nameless call still journals its own pair of events: a name the log
    // accepts, the arguments the model actually wrote, and the refusal. A
    // declared call that left no trace at all was invisible to the person
    // reading the thread.
    expect(
      run.events.find(
        (event) =>
          event.type === "tool/call" && event.occurrenceId === "tool:1:1:0.0",
      ),
    ).toMatchObject({
      name: BATCH_INVALID_CALL_NAME_V1,
      input: { arguments: {} },
    });
    expect(
      run.events.find(
        (event) =>
          event.type === "tool/result" && event.occurrenceId === "tool:1:1:0.0",
      ),
    ).toMatchObject({
      isError: true,
      content: "batch call 0 was refused: it needs a tool name",
    });
  });

  test("journals every declared call's intent in declared order", async () => {
    const run = await runBatch(
      [recorder("alpha", [])],
      [
        { tool: "alpha", arguments: { n: 1 } },
        { tool: "", arguments: {} },
      ],
    );

    // A refused call settles in the same tick it is reached, while a
    // dispatched one has to wait on prepare(). Journalling every declared
    // intent before anything is dispatched is what keeps the rows in declared
    // order regardless, so the person reads call 0 above call 1.
    expect(
      toolEvents(run.events, "tool/call").map((event) => event.occurrenceId),
    ).toEqual(["tool:1:1:0", "tool:1:1:0.0", "tool:1:1:0.1"]);
    expect(run.report).toMatchObject({ ran: 2, failed: 1 });
  });

  test("refuses a batch past the declared bound, and an empty one", async () => {
    const tooMany = Array.from({ length: BATCH_MAX_CALLS_V1 + 1 }, () => ({
      tool: "alpha",
      arguments: {},
    }));

    const over = batchResultOf(await runTurn([recorder("alpha", [])], tooMany));
    const empty = batchResultOf(await runTurn([recorder("alpha", [])], []));

    // The batch itself has nothing to run, so the refusal is the batch's own
    // rather than a per-call slot the model would look for.
    expect(over.isError).toBe(true);
    expect(over.content).toContain(String(BATCH_MAX_CALLS_V1));
    expect(empty.isError).toBe(true);
  });

  test("says a thrown non-idempotent call may still have taken effect", async () => {
    const run = await runBatch(
      [thrower("send_email", false), thrower("read_inbox", true)],
      [
        { tool: "send_email", arguments: {} },
        { tool: "read_inbox", arguments: {} },
      ],
    );

    // The same sentence the loop gives a top-level throw: it is what the
    // model reads to decide whether retrying would send the mail twice.
    expect(run.report.results).toEqual([
      {
        index: 0,
        tool: "send_email",
        isError: true,
        content:
          "fetch failed (the loop cannot tell whether this call took effect)",
      },
      { index: 1, tool: "read_inbox", isError: true, content: "fetch failed" },
    ]);
  });
});

describe("batch ordering", () => {
  /**
   * A tool whose effect has a place in the conversation, and which takes as
   * long to land as its input asks for.
   */
  function orderedEffect(
    name: string,
    landed: string[],
    timeline?: string[],
  ): ToolDefinition {
    return {
      name,
      description: `${name} fixture.`,
      inputSchema: { type: "object" },
      orderedEffect: true,
      execute: async (input) => {
        const { text, delay } = input as { text: string; delay: number };
        await Bun.sleep(delay);
        landed.push(text);
        timeline?.push(`${name}:${text}`);
        return { content: text, isError: false };
      },
    };
  }

  test("ordered effects land in declared order, whatever their latency", async () => {
    // The whole point: a send's position in the conversation is where the
    // model wrote it, not how fast the append happened to be. Dispatched at
    // once these would land back to front, and every consumer of "the Turn's
    // sends" — the wire ordinal, the rendered order, the unread boundary, the
    // push order, the preview, the answer text — reads the log's order.
    const landed: string[] = [];
    const run = await runBatch(
      [orderedEffect("send", landed)],
      [
        { tool: "send", arguments: { text: "one", delay: 30 } },
        { tool: "send", arguments: { text: "two", delay: 10 } },
        { tool: "send", arguments: { text: "three", delay: 0 } },
      ],
    );

    expect(landed).toEqual(["one", "two", "three"]);
    expect(
      toolEvents(run.events, "tool/result")
        .filter((event) => event.name === "send")
        .map((event) => event.occurrenceId),
    ).toEqual(["tool:1:1:0.0", "tool:1:1:0.1", "tool:1:1:0.2"]);
  });

  test("ordering the sends does not serialise the rest of the batch", async () => {
    // Ordered calls run one after another; everything else still runs at
    // once, and overlaps them. Serialising the whole batch would make the two
    // slow reads wait for each other and for the sends, which is the cost the
    // batch exists to avoid.
    const timeline: string[] = [];
    const landed: string[] = [];
    const slow: ToolDefinition = {
      name: "read",
      description: "read fixture.",
      inputSchema: { type: "object" },
      execute: async (input) => {
        const { id } = input as { id: string };
        timeline.push(`read:start:${id}`);
        await Bun.sleep(40);
        timeline.push(`read:end:${id}`);
        return { content: id, isError: false };
      },
    };

    await runBatch(
      [orderedEffect("send", landed, timeline), slow],
      [
        { tool: "send", arguments: { text: "one", delay: 5 } },
        { tool: "read", arguments: { id: "a" } },
        { tool: "send", arguments: { text: "two", delay: 5 } },
        { tool: "read", arguments: { id: "b" } },
      ],
    );

    expect(timeline).toEqual([
      "read:start:a",
      "read:start:b",
      "send:one",
      "send:two",
      "read:end:a",
      "read:end:b",
    ]);
  });

  test("a dynamic tool's own orderedEffect decides, not the meta-tool's", async () => {
    // A batch reaches a dynamic tool through `call_dynamic_tool`, which
    // declares nothing. Reading the flag off that outer name would put every
    // approval card and agent card — all of which append to the conversation
    // — back in the racing group.
    const landed: string[] = [];
    const run = await runBatch(
      [{ ...orderedEffect("send_card", landed), namespace: "frockbot" }],
      ["one", "two", "three"].map((text, index) => ({
        tool: CALL_DYNAMIC_TOOL_NAME,
        arguments: {
          namespace: "frockbot",
          toolName: "send_card",
          arguments: { text, delay: 30 - index * 15 },
        },
      })),
    );

    expect(landed).toEqual(["one", "two", "three"]);
    expect(run.report).toMatchObject({ ran: 3, failed: 0 });
  });

  test("a fenced call stops the chain and leaves the Turn cancelled", async () => {
    // Serialising the chain is what creates a window for a Stop to land in.
    // A sub-call is admitted under its own effect id, so a Stop fences it
    // exactly as it fences a top-level call: the send that already landed
    // stays landed, the rest never start, and the Turn ends cancelled rather
    // than reporting a batch that quietly did less than it was asked to.
    const landed: string[] = [];
    const turn = await runTurn(
      [
        {
          name: "send",
          description: "send fixture.",
          inputSchema: { type: "object" },
          orderedEffect: true,
          execute: (input) => {
            landed.push((input as { text: string }).text);
            return Promise.resolve({ content: "sent", isError: false });
          },
        },
      ],
      ["one", "two", "three"].map((text) => ({
        tool: "send",
        arguments: { text },
      })),
      {
        admitEffect: ({ effectId }) =>
          Promise.resolve(effectId !== "tool:1:1:0.1"),
      },
    );

    expect(landed).toEqual(["one"]);
    expect(turn.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
    // Nothing is left open: the fenced call and the ones that never started
    // are settled by the Turn's own cancellation.
    expect(
      turn.events.filter(
        (event) => event.type === "tool/call" || event.type === "tool/result",
      ).length % 2,
    ).toBe(0);
  });

  test("carries at most the durable attachment limit, in declared order, and says so", async () => {
    // A batch of screenshot calls produces one attachment each. The aggregate
    // has to fit what a tool/result may durably carry, or the Session that
    // tried to persist it wedges on every later flush.
    const capture: ToolDefinition = {
      name: "capture",
      description: "capture fixture.",
      inputSchema: { type: "object" },
      execute: (input) => {
        const { shot } = input as { shot: number };
        return Promise.resolve({
          content: `captured ${shot}`,
          isError: false,
          attachments: [attachmentFor(shot)],
        });
      },
    };
    const shots = TOOL_ATTACHMENT_LIMIT_V1 + 3;

    const run = await runBatch(
      [capture],
      Array.from({ length: shots }, (_unused, shot) => ({
        tool: "capture",
        arguments: { shot },
      })),
    );

    expect(run.result.attachments).toEqual(
      Array.from({ length: TOOL_ATTACHMENT_LIMIT_V1 }, (_unused, shot) =>
        attachmentFor(shot),
      ),
    );
    expect(run.report).toMatchObject({
      ran: shots,
      failed: 0,
      attachments: `${TOOL_ATTACHMENT_LIMIT_V1} of ${shots} attachments carried, in declared call order; ${shots - TOOL_ATTACHMENT_LIMIT_V1} dropped.`,
    });
    // The aggregate the loop journalled is one the durable decoder accepts.
    expect(() =>
      decodeSessionEvent({
        ...run.result,
        seq: 0,
        timestamp: "2026-09-16T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

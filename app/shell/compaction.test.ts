import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentRuntimeHarness,
  createAgentRuntimeHarness,
} from "@frockbot/app/testkit";
import {
  decodeSessionEvent,
  type LlmMessage,
  type SessionEvent,
  type SessionEventInput,
} from "@frockbot/core/contracts";
import {
  assessCompactionV1,
  compactionMessageV1,
  compactionStateV1,
  historyCharsV1,
  parseCompactionSummaryV1,
  PRUNED_TOOL_RESULT_V1,
  pruneToolOutputsV1,
  runCompactionV1,
  COMPACTION_INPUT_MAX_CHARS_V1,
  COMPACTION_SYSTEM_PROMPT_V1,
  COMPACTION_TRIGGER_RATIO_V1,
} from "./compaction.js";
import { chatWindowV1, turnScopedMessagesV1 } from "./history.js";

const SESSION_ID = "user-1:bot-1";

function log(inputs: SessionEventInput[]): SessionEvent[] {
  return inputs.map((input, index) =>
    decodeSessionEvent({
      ...input,
      seq: index,
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    }),
  );
}

/** The same derivation `Session.deriveMessages` performs, over a fixed log. */
function derive(events: readonly SessionEvent[]): LlmMessage[] {
  const messages: LlmMessage[] = [];
  for (const event of events) {
    if (event.type === "user/message") {
      messages.push({ role: "user", content: event.text });
    } else if (event.type === "assistant/message") {
      messages.push({
        role: "assistant",
        content: event.text,
        toolCalls: event.toolCalls,
      });
    } else if (event.type === "tool/result") {
      messages.push({
        role: "tool",
        callId: event.occurrenceId,
        name: event.name,
        content: event.content,
        isError: event.isError,
      });
    }
  }
  return messages;
}

interface TurnShape {
  turn: number;
  say?: string;
  reply?: string;
  /** A tool result of this many characters. */
  toolChars?: number;
}

function turnEvents(shape: TurnShape): SessionEventInput[] {
  const { turn } = shape;
  const events: SessionEventInput[] = [
    { type: "turn/start", turn },
    { type: "turn/admission", turn, turnType: "chat" },
    { type: "step/start", turn, step: 1 },
    {
      type: "user/message",
      turn,
      step: 1,
      messageId: `m-${turn}`,
      text: shape.say ?? `question ${turn}`,
    },
  ];
  if (shape.toolChars !== undefined) {
    events.push(
      {
        type: "assistant/message",
        turn,
        step: 1,
        requestId: `r-${turn}`,
        text: "",
        toolCalls: [{ id: `c-${turn}`, name: "search", input: {} }],
      },
      {
        type: "tool/result",
        turn,
        step: 1,
        occurrenceId: `o-${turn}`,
        name: "search",
        content: "T".repeat(shape.toolChars),
        isError: false,
        status: "completed",
      },
    );
  }
  events.push(
    {
      type: "assistant/message",
      turn,
      step: 1,
      requestId: `r2-${turn}`,
      text: shape.reply ?? `answer ${turn}`,
      toolCalls: [],
    },
    { type: "step/end", turn, step: 1, outcome: "completed" },
    { type: "turn/end", turn, outcome: "completed" },
  );
  return events;
}

/** A conversation of `count` Turns, each carrying a fat tool result. */
function conversation(count: number, toolChars: number): SessionEventInput[] {
  return Array.from({ length: count }, (_, index) =>
    turnEvents({ turn: index + 1, toolChars }),
  ).flat();
}

/** The same, with the weight in the assistant's words rather than in tools. */
function wordy(count: number, chars: number): SessionEventInput[] {
  return Array.from({ length: count }, (_, index) =>
    turnEvents({ turn: index + 1, reply: "W".repeat(chars) }),
  ).flat();
}

/** An open Turn, so `currentTurnV1` names it and it is never compacted. */
function openTurn(turn: number): SessionEventInput[] {
  return [
    { type: "turn/start", turn },
    { type: "turn/admission", turn, turnType: "chat" },
    { type: "step/start", turn, step: 1 },
    {
      type: "user/message",
      turn,
      step: 1,
      messageId: `m-${turn}`,
      text: `question ${turn}`,
    },
  ];
}

const MODEL_REQUEST: SessionEventInput = {
  type: "model/request",
  turn: 1,
  step: 1,
  request: {
    requestId: "seed",
    provider: "ollama-cloud",
    model: "kimi-k2",
    system: "",
    messages: [],
    tools: [],
  },
};

function windowOf(events: readonly SessionEvent[]) {
  return chatWindowV1(events, derive(events));
}

describe("the size estimate", () => {
  test("is the character measure over the pruned window", () => {
    const events = log([MODEL_REQUEST, ...conversation(8, 5_000)]);
    const window = windowOf(events);
    const raw = historyCharsV1(window.messages);
    const pruned = historyCharsV1(
      pruneToolOutputsV1(window.messages, window.turns),
    );
    // Pruning is what the trigger measures, so a conversation whose weight is
    // tool output never reaches the summariser at all.
    expect(pruned).toBeLessThan(raw / 2);
  });

  test("does not fire under the threshold", () => {
    const events = log([MODEL_REQUEST, ...conversation(8, 100)]);
    const window = windowOf(events);
    const assessment = assessCompactionV1({
      ...window,
      budget: 150_000,
      currentTurn: 8,
    });
    expect(assessment.skipped).toBe("under-threshold");
    expect(assessment.throughTurn).toBeUndefined();
    expect(assessment.threshold).toBe(
      Math.floor(150_000 * COMPACTION_TRIGGER_RATIO_V1),
    );
  });

  test("fires over the threshold and keeps the newest four Turns", () => {
    const events = log([MODEL_REQUEST, ...wordy(10, 400)]);
    const window = windowOf(events);
    const assessment = assessCompactionV1({
      ...window,
      budget: 4_000,
      currentTurn: 10,
    });
    expect(assessment.chars).toBeGreaterThan(assessment.threshold);
    expect(assessment.throughTurn).toBe(6);
    expect(assessment.fromTurn).toBe(1);
  });

  test("has nothing new to cover when only the recent Turns are left", () => {
    const events = log([MODEL_REQUEST, ...conversation(3, 4_000)]);
    const window = windowOf(events);
    expect(
      assessCompactionV1({ ...window, budget: 2_000, currentTurn: 3 }).skipped,
    ).toBe("nothing-new-to-cover");
  });

  test("backs off after a failure, then tries again", () => {
    const base = [
      MODEL_REQUEST,
      ...wordy(10, 400),
      {
        type: "conversation/compaction-intent" as const,
        effectId: "e1",
        throughTurn: 6,
        provider: "ollama-cloud",
        model: "kimi-k2",
      },
      {
        type: "conversation/compaction-failed" as const,
        effectId: "e1",
        throughTurn: 6,
        reason: "provider said no",
      },
    ];
    const events = log(base);
    const window = windowOf(events);
    expect(window.state.failures).toBe(1);
    // One failure waits one Turn: the Turn it failed on is not enough.
    expect(
      assessCompactionV1({ ...window, budget: 4_000, currentTurn: 6 }).skipped,
    ).toBe("backing-off");
    expect(
      assessCompactionV1({ ...window, budget: 4_000, currentTurn: 10 })
        .throughTurn,
    ).toBe(6);
  });
});

describe("pruning tool outputs", () => {
  const messages: LlmMessage[] = [
    {
      role: "tool",
      callId: "c1",
      name: "search",
      content: "A".repeat(500),
      isError: false,
    },
    {
      role: "tool",
      callId: "c2",
      name: "search",
      content: "short",
      isError: false,
    },
    {
      role: "tool",
      callId: "c3",
      name: "search",
      content: "B".repeat(500),
      isError: false,
    },
  ];
  const turns = [1, 1, 5];

  test("keeps the pairing and drops only the payload", () => {
    const pruned = pruneToolOutputsV1(messages, turns, 1);
    expect(pruned[0]).toEqual({
      role: "tool",
      callId: "c1",
      name: "search",
      content: PRUNED_TOOL_RESULT_V1,
      isError: false,
    });
  });

  test("leaves the newest Turns and small results alone", () => {
    const pruned = pruneToolOutputsV1(messages, turns, 1);
    expect(pruned[1]!.content).toBe("short");
    expect(pruned[2]!.content).toBe("B".repeat(500));
  });

  test("reaches a Turn's tool results through request assembly", () => {
    const events = log([
      MODEL_REQUEST,
      ...conversation(6, 1_000),
      ...openTurn(7),
    ]);
    const messages = turnScopedMessagesV1({
      events,
      messages: derive(events),
      pointer: () => "pointer",
      sessionId: SESSION_ID,
    });
    // The newest three Turns of the window are 5, 6 and the open 7, so only
    // Turns 5 and 6 still carry a payload.
    const tools = messages.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(6);
    expect(
      tools.slice(0, 4).every((t) => t.content === PRUNED_TOOL_RESULT_V1),
    ).toBe(true);
    expect(tools.slice(4).every((t) => t.content === "T".repeat(1_000))).toBe(
      true,
    );
  });
});

describe("injecting a compaction", () => {
  const events = log([
    MODEL_REQUEST,
    ...conversation(6, 0),
    {
      type: "conversation/compacted" as const,
      effectId: "e1",
      fromTurn: 1,
      throughTurn: 4,
      summary: "## Summary\nThey discussed the plan.",
      identifiers: ["pkg-abc123"],
      provider: "ollama-cloud",
      model: "kimi-k2",
    },
    ...openTurn(7),
  ]);

  test("puts the summary first and drops the Turns it covers", () => {
    const messages = turnScopedMessagesV1({
      events,
      messages: derive(events),
      pointer: () => "pointer",
      sessionId: SESSION_ID,
    });
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("They discussed the plan.");
    expect(messages[0]!.content).toContain("pkg-abc123");
    const text = messages.slice(1).map((message) => message.content);
    expect(text).not.toContain("question 4");
    expect(text).toContain("question 5");
    expect(text).toContain("question 7");
  });

  test("spends the summary from the budget rather than evicting it", () => {
    const messages = turnScopedMessagesV1({
      events,
      messages: derive(events),
      pointer: () => "pointer",
      sessionId: SESSION_ID,
      budget: 400,
    });
    expect(messages[0]!.content).toContain("They discussed the plan.");
    expect(messages.at(-1)!.content).toBe("question 7");
  });

  test("never covers the Turn being assembled", () => {
    const stale = log([
      MODEL_REQUEST,
      ...conversation(3, 0),
      {
        type: "conversation/compacted" as const,
        effectId: "e1",
        fromTurn: 1,
        throughTurn: 9,
        summary: "everything",
        identifiers: [],
        provider: "ollama-cloud",
        model: "kimi-k2",
      },
      ...openTurn(4),
    ]);
    const messages = turnScopedMessagesV1({
      events: stale,
      messages: derive(stale),
      pointer: () => "pointer",
      sessionId: SESSION_ID,
    });
    expect(messages.at(-1)!.content).toBe("question 4");
  });
});

describe("reading the summariser's answer", () => {
  test("asks for the headings it reads back, not for JSON", () => {
    for (const heading of [
      "## Summary",
      "## Decisions",
      "## Open items",
      "## Identifiers mentioned",
    ]) {
      expect(COMPACTION_SYSTEM_PROMPT_V1).toContain(heading);
    }
    expect(COMPACTION_SYSTEM_PROMPT_V1).not.toContain("`summary`");
  });

  test("lifts the identifiers out of their heading", () => {
    const parsed = parseCompactionSummaryV1(
      [
        "## Summary",
        "Work on the Applet.",
        "## Identifiers mentioned",
        "- applet-9f2c",
        "- https://example.test/a?b=c",
        "",
      ].join("\n"),
    );
    expect(parsed?.identifiers).toEqual([
      "applet-9f2c",
      "https://example.test/a?b=c",
    ]);
    expect(parsed?.summary).toContain("Work on the Applet.");
  });

  test("reads `none` as an empty list", () => {
    expect(
      parseCompactionSummaryV1("## Identifiers mentioned\n- none")?.identifiers,
    ).toEqual([]);
  });

  test("refuses an empty answer", () => {
    expect(parseCompactionSummaryV1("   ")).toBeUndefined();
  });
});

describe("running a compaction", () => {
  const roots: AgentRuntimeHarness[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) void root.dispose();
  });

  function sessionFrom(inputs: SessionEventInput[]) {
    const root = createAgentRuntimeHarness({
      sessions: { initialSessions: { [SESSION_ID]: log(inputs) } },
    });
    roots.push(root);
    return root.sessions.create(SESSION_ID);
  }

  function runner(
    session: Awaited<ReturnType<typeof sessionFrom>>,
    summarise: (request: {
      effectId: string;
      provider: string;
      model: string;
    }) => Promise<string>,
    currentTurn = 10,
  ) {
    return {
      session,
      window: chatWindowV1(session.activeRunJournal, session.deriveMessages()),
      budget: 4_000,
      currentTurn,
      newEffectId: () => "effect-1",
      summarise,
    };
  }

  const SUMMARY = "## Summary\nA long talk.\n## Identifiers mentioned\n- id-7";

  test("records intent, then one compaction covering the range", async () => {
    const session = await sessionFrom([MODEL_REQUEST, ...wordy(10, 400)]);
    const outcome = await runCompactionV1(runner(session, async () => SUMMARY));
    expect(outcome).toEqual({ kind: "compacted", throughTurn: 6, fromTurn: 1 });
    const types = session.activeRunJournal.map((event) => event.type);
    expect(
      types.filter((t) => t === "conversation/compaction-intent"),
    ).toHaveLength(1);
    const compacted = session.activeRunJournal.findLast(
      (event) => event.type === "conversation/compacted",
    );
    expect(
      compacted?.type === "conversation/compacted" && compacted,
    ).toMatchObject({
      fromTurn: 1,
      throughTurn: 6,
      identifiers: ["id-7"],
      provider: "ollama-cloud",
      model: "kimi-k2",
    });
    // Every event it wrote decodes, so a reload reads back what it stored.
    for (const event of session.activeRunJournal) {
      expect(() => decodeSessionEvent(event)).not.toThrow();
    }
  });

  test("hands the summariser the effect id its intent was recorded under", async () => {
    const session = await sessionFrom([MODEL_REQUEST, ...wordy(10, 400)]);
    const seen: string[] = [];
    await runCompactionV1(
      runner(session, async (request) => {
        seen.push(request.effectId);
        return SUMMARY;
      }),
    );
    const intent = session.activeRunJournal.find(
      (event) => event.type === "conversation/compaction-intent",
    );
    expect(
      intent?.type === "conversation/compaction-intent" && intent.effectId,
    ).toBe("effect-1");
    // The call is dispatched under the id the intent was written under, and
    // the outcome is written under it too: one effect, one identity.
    expect(seen).toEqual(["effect-1"]);
  });

  test("is keyed by the range, so a second run compacts nothing", async () => {
    const session = await sessionFrom([MODEL_REQUEST, ...wordy(10, 400)]);
    let calls = 0;
    await runCompactionV1(
      runner(session, async () => {
        calls += 1;
        return SUMMARY;
      }),
    );
    const again = await runCompactionV1(
      runner(session, async () => {
        calls += 1;
        return SUMMARY;
      }),
    );
    expect(calls).toBe(1);
    expect(again.kind).toBe("skipped");
    expect(
      session.activeRunJournal.filter(
        (event) => event.type === "conversation/compacted",
      ),
    ).toHaveLength(1);
  });

  test("settles an intent a restart left open, then tries again", async () => {
    const session = await sessionFrom([
      MODEL_REQUEST,
      ...wordy(10, 400),
      {
        type: "conversation/compaction-intent",
        effectId: "orphan",
        throughTurn: 6,
        provider: "ollama-cloud",
        model: "kimi-k2",
      },
    ]);
    let calls = 0;
    const outcome = await runCompactionV1(
      runner(session, async () => {
        calls += 1;
        return SUMMARY;
      }),
    );
    // An interruption says nothing about the next attempt, so there is no
    // backoff to wait out: the range is summarised in the same run.
    expect(calls).toBe(1);
    expect(outcome).toEqual({ kind: "compacted", throughTurn: 6, fromTurn: 1 });
    const failed = session.activeRunJournal.filter(
      (event) => event.type === "conversation/compaction-failed",
    );
    expect(
      failed.map(
        (event) =>
          event.type === "conversation/compaction-failed" && event.effectId,
      ),
    ).toEqual(["orphan"]);
    expect(
      compactionStateV1(session.activeRunJournal).unsettled,
    ).toBeUndefined();
  });

  test("runs on the model it is given rather than the Turn's own", async () => {
    const session = await sessionFrom([MODEL_REQUEST, ...wordy(10, 400)]);
    const seen: { provider: string; model: string }[] = [];
    await runCompactionV1({
      ...runner(session, async (request) => {
        seen.push({ provider: request.provider, model: request.model });
        return SUMMARY;
      }),
      model: {
        provider: "flock-ai",
        model: "@frock/structured",
        modelBinding: { connectionId: "ambient", connectionGeneration: "v1" },
      },
    });
    expect(seen).toEqual([
      { provider: "flock-ai", model: "@frock/structured" },
    ]);
    const compacted = session.activeRunJournal.findLast(
      (event) => event.type === "conversation/compacted",
    );
    expect(compacted).toMatchObject({
      provider: "flock-ai",
      model: "@frock/structured",
    });
  });

  test("summarises a backlog larger than one call can read a slice at a time", async () => {
    // Each Turn is a fifth of what one summariser call may read.
    const turnChars = Math.floor(COMPACTION_INPUT_MAX_CHARS_V1 / 5);
    const session = await sessionFrom([MODEL_REQUEST, ...wordy(20, turnChars)]);
    const budget = turnChars * 20;
    const seen: number[] = [];
    const run = () =>
      runCompactionV1({
        ...runner(
          session,
          async (request) => {
            seen.push(String(request.effectId).length);
            return SUMMARY;
          },
          21,
        ),
        window: chatWindowV1(
          session.activeRunJournal,
          session.deriveMessages(),
        ),
        budget,
      });
    const first = await run();
    expect(first).toMatchObject({ kind: "compacted", fromTurn: 1 });
    const firstThrough = first.kind === "compacted" ? first.throughTurn : 0;
    // Bounded: well short of the sixteen Turns that were due.
    expect(firstThrough).toBeGreaterThanOrEqual(1);
    expect(firstThrough).toBeLessThan(6);
    const second = await run();
    expect(second.kind).toBe("compacted");
    expect(second.kind === "compacted" && second.throughTurn).toBeGreaterThan(
      firstThrough,
    );
  });

  test("summarises one Turn larger than the cap on its own, from its beginning", async () => {
    const session = await sessionFrom([
      MODEL_REQUEST,
      ...wordy(10, COMPACTION_INPUT_MAX_CHARS_V1 * 2),
    ]);
    let sent = 0;
    const outcome = await runCompactionV1({
      ...runner(session, async () => SUMMARY),
      budget: COMPACTION_INPUT_MAX_CHARS_V1 * 4,
      summarise: async (request) => {
        sent = String(request.messages[0]?.content ?? "").length;
        return SUMMARY;
      },
    });
    expect(outcome).toEqual({ kind: "compacted", throughTurn: 1, fromTurn: 1 });
    expect(sent).toBeGreaterThan(COMPACTION_INPUT_MAX_CHARS_V1 / 2);
    expect(sent).toBeLessThan(COMPACTION_INPUT_MAX_CHARS_V1 + 200);
  });

  test("records a failure and leaves the conversation alone", async () => {
    const session = await sessionFrom([MODEL_REQUEST, ...wordy(10, 400)]);
    const outcome = await runCompactionV1(
      runner(session, async () => {
        throw new Error("provider refused\nthe request");
      }),
    );
    expect(outcome.kind).toBe("failed");
    const failure = session.activeRunJournal.findLast(
      (event) => event.type === "conversation/compaction-failed",
    );
    expect(
      failure?.type === "conversation/compaction-failed" && failure.reason,
    ).toBe("provider refused the request");
    // The request that follows is exactly the one that would be assembled
    // without a compaction.
    expect(
      compactionStateV1(session.activeRunJournal).compaction,
    ).toBeUndefined();
  });

  test("folds a previous summary into the range it extends", async () => {
    const session = await sessionFrom([
      MODEL_REQUEST,
      ...wordy(14, 400),
      {
        type: "conversation/compacted",
        effectId: "old",
        fromTurn: 1,
        throughTurn: 5,
        summary: "the first five",
        identifiers: [],
        provider: "ollama-cloud",
        model: "kimi-k2",
      },
    ]);
    let seen = "";
    const outcome = await runCompactionV1({
      ...runner(session, async () => SUMMARY, 14),
      summarise: async (request) => {
        seen = String(request.messages[0]?.content ?? "");
        return SUMMARY;
      },
    });
    expect(seen).toContain("the first five");
    expect(seen).not.toContain("question 3");
    expect(seen).toContain("question 6");
    expect(outcome).toEqual({
      kind: "compacted",
      fromTurn: 1,
      throughTurn: 10,
    });
  });
});

describe("the compaction message", () => {
  test("says plainly that the Turns are not there", () => {
    const message = compactionMessageV1({
      effectId: "e",
      fromTurn: 1,
      throughTurn: 9,
      summary: "the gist",
      identifiers: ["bot-42"],
      provider: "p",
      model: "m",
    });
    expect(message.role).toBe("user");
    expect(message.content).toContain("Turns 1 to 9");
    expect(message.content).toContain("the gist");
    expect(message.content).toContain("bot-42");
  });
});

import { describe, expect, test } from "bun:test";
import { createMemoryVoiceLedgerStorageV1 } from "./ledger.js";
import {
  applyVoiceMemoryUpdateV1,
  decodeVoiceMemoryUpdateV1,
  emptyVoiceMemoryRecordV1,
  matchVoiceMemoryV1,
  pruneVoiceMemoryV1,
  renderVoiceMemoryLinesV1,
  renderVoiceMemoryRequestMessagesV1,
  voiceMemoryCorrectionTargetsV1,
  voiceMemoryHorizonEndV1,
  VoiceMemoryLedgerV1,
  VOICE_MEMORY_CHUNK_TURNS_V1,
  VOICE_MEMORY_FORGOTTEN_PREFIX_V1,
  VOICE_MEMORY_MAX_ATTEMPTS_V1,
  VOICE_MEMORY_MAX_DURABLE_V1,
  VOICE_MEMORY_MAX_TOMBSTONES_V1,
  VOICE_MEMORY_RECENT_DAYS_V1,
  VOICE_MEMORY_RECORD_KEY_V1,
  VOICE_MEMORY_UNCERTAIN_FAILURE_V1,
  type VoiceMemoryOperationV1,
  type VoiceMemoryRecordV1,
  type VoiceMemorySourceTurnV1,
} from "./memory.js";

const DAY = 24 * 60 * 60_000;
const CALL_ONE = 1_000;
const CALL_TWO = 2_000;

function turn(input: {
  call?: string;
  sequence?: number;
  ordinal?: number;
  at: string;
  said?: string;
  answered?: string;
}): VoiceMemorySourceTurnV1 {
  const callId = input.call ?? "call-1";
  const ordinal = input.ordinal ?? 1;
  return {
    id: `${callId}:${ordinal}`,
    ordinal,
    callId,
    sequence: input.sequence ?? (callId === "call-1" ? CALL_ONE : CALL_TWO),
    at: input.at,
    said: input.said ?? `turn ${ordinal}`,
    ...(input.answered ? { answered: input.answered } : {}),
  };
}

function apply(
  record: VoiceMemoryRecordV1,
  operations: VoiceMemoryOperationV1[],
  sources: VoiceMemorySourceTurnV1[],
) {
  return applyVoiceMemoryUpdateV1(record, { operations, sources });
}

describe("what the model answered with", () => {
  test("reads operations and dates each one by the turn it names", () => {
    const update = decodeVoiceMemoryUpdateV1(
      JSON.stringify({
        operations: [
          {
            kind: "durable/add",
            id: "short-answers",
            text: "Keep answers to one sentence.",
            source: "call-1:1",
          },
          {
            kind: "recent/add",
            text: "Booked the flights.",
            source: "call-1:2",
          },
        ],
      }),
    );
    expect(update.malformed).toBe(false);
    expect(update.operations).toHaveLength(2);

    const result = apply(emptyVoiceMemoryRecordV1(), update.operations, [
      turn({ ordinal: 1, at: "2026-09-01T10:00:00.000Z" }),
      turn({ ordinal: 2, at: "2026-09-01T10:05:00.000Z" }),
    ]);
    expect(result.record.durable[0]).toMatchObject({
      id: "short-answers",
      at: "2026-09-01T10:00:00.000Z",
      sourceTurnId: "call-1:1",
      sourceCallId: "call-1",
      stamp: { sequence: CALL_ONE, turn: 1 },
    });
    expect(result.record.recent[0]?.at).toBe("2026-09-01T10:05:00.000Z");
  });

  test("reads JSON the model fenced in markdown", () => {
    const update = decodeVoiceMemoryUpdateV1(
      '```json\n{"operations":[{"kind":"ongoing/add","id":"flights","text":"Deciding on dates.","source":"t1"}]}\n```',
    );
    expect(update.malformed).toBe(false);
    expect(update.operations[0]).toMatchObject({ kind: "ongoing/add" });
  });

  test("output that is not an update is malformed, not an empty update", () => {
    for (const raw of ["I have nothing to add.", "", "[1,2,3]"]) {
      expect(decodeVoiceMemoryUpdateV1(raw).malformed).toBe(true);
    }
    // An honest empty answer is not malformed: there was nothing to record.
    const empty = decodeVoiceMemoryUpdateV1('{"operations":[]}');
    expect(empty.malformed).toBe(false);
    expect(empty.operations).toEqual([]);
  });

  test("an operation with no source turn is refused", () => {
    const update = decodeVoiceMemoryUpdateV1(
      '{"operations":[{"kind":"durable/add","id":"x","text":"Something."}]}',
    );
    expect(update.operations).toEqual([]);
    expect(update.refusals[0]).toContain("no source turn");
  });

  test("an operation naming a turn from another conversation is discarded", () => {
    const update = decodeVoiceMemoryUpdateV1(
      '{"operations":[{"kind":"durable/add","id":"x","text":"Something.","source":"other:9"}]}',
    );
    const result = apply(emptyVoiceMemoryRecordV1(), update.operations, [
      turn({ at: "2026-09-01T10:00:00.000Z" }),
    ]);
    expect(result.record.durable).toEqual([]);
    expect(result.skipped[0]).toContain("not in this conversation");
  });

  test("a credential is refused rather than remembered", () => {
    const update = decodeVoiceMemoryUpdateV1(
      JSON.stringify({
        operations: [
          {
            kind: "durable/add",
            id: "key",
            text: "Their OpenAI key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
            source: "call-1:1",
          },
          {
            kind: "durable/add",
            id: "short",
            text: "Keep it short.",
            source: "call-1:1",
          },
        ],
      }),
    );
    expect(update.operations).toHaveLength(1);
    expect(update.operations[0]).toMatchObject({ id: "short" });
    expect(update.refusals[0]).toContain("no secrets");
  });

  test("a hostile operation never costs the good ones", () => {
    const update = decodeVoiceMemoryUpdateV1(
      JSON.stringify({
        operations: [
          "not an object",
          { kind: "drop/everything", source: "t1" },
          { kind: "durable/remove", source: "t1" },
          { kind: "durable/add", id: "ok", text: "Fine.", source: "t1" },
        ],
      }),
    );
    expect(update.operations).toHaveLength(1);
    expect(update.refusals).toHaveLength(3);
  });
});

describe("what memory keeps", () => {
  test("a durable preference survives into the next conversation's prompt", () => {
    const first = apply(
      emptyVoiceMemoryRecordV1(),
      [
        {
          kind: "durable/add",
          id: "short-answers",
          text: "Keep answers short.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    );
    expect(renderVoiceMemoryLinesV1(first.record).join("\n")).toContain(
      "(short-answers) Keep answers short.",
    );
  });

  test("applying the same update twice leaves the same record", () => {
    const sources = [turn({ at: "2026-09-01T10:00:00.000Z" })];
    const operations: VoiceMemoryOperationV1[] = [
      {
        kind: "durable/add",
        id: "short",
        text: "Keep it short.",
        source: "call-1:1",
      },
      {
        kind: "recent/add",
        text: "Talked about flights.",
        source: "call-1:1",
      },
    ];
    const once = apply(emptyVoiceMemoryRecordV1(), operations, sources);
    const twice = apply(once.record, operations, sources);
    expect(twice.record).toEqual(once.record);
    expect(twice.changed).toBe(0);
  });

  test("a correction replaces the preference rather than leaving both", () => {
    const first = apply(
      emptyVoiceMemoryRecordV1(),
      [
        {
          kind: "durable/add",
          id: "length",
          text: "Keep answers short.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    );
    const corrected = apply(
      first.record,
      [
        {
          kind: "durable/add",
          id: "length",
          text: "Explain things more fully.",
          source: "call-2:1",
        },
      ],
      [turn({ call: "call-2", at: "2026-09-05T10:00:00.000Z" })],
    );
    expect(corrected.record.durable).toHaveLength(1);
    expect(corrected.record.durable[0]?.text).toBe(
      "Explain things more fully.",
    );
    expect(corrected.record.durable[0]?.at).toBe("2026-09-05T10:00:00.000Z");
  });

  test("a forget takes effect", () => {
    const first = apply(
      emptyVoiceMemoryRecordV1(),
      [
        {
          kind: "durable/add",
          id: "coffee",
          text: "Drinks flat whites.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    );
    const after = apply(
      first.record,
      [{ kind: "durable/remove", id: "coffee", source: "call-1:2" }],
      [turn({ ordinal: 2, at: "2026-09-01T10:02:00.000Z" })],
    );
    expect(after.record.durable).toEqual([]);
    expect(after.record.forgotten).toHaveLength(1);
  });

  test("a durable fact is never evicted to make room; the new one is refused", () => {
    let record = emptyVoiceMemoryRecordV1();
    for (let index = 0; index < VOICE_MEMORY_MAX_DURABLE_V1; index += 1) {
      record = apply(
        record,
        [
          {
            kind: "durable/add",
            id: `fact-${index}`,
            text: `Fact ${index}.`,
            source: "call-1:1",
          },
        ],
        [turn({ at: "2026-09-01T10:00:00.000Z" })],
      ).record;
    }
    const overflow = apply(
      record,
      [
        {
          kind: "durable/add",
          id: "one-more",
          text: "One more.",
          source: "call-2:1",
        },
      ],
      [turn({ call: "call-2", at: "2026-09-02T10:00:00.000Z" })],
    );
    expect(overflow.record.durable).toHaveLength(VOICE_MEMORY_MAX_DURABLE_V1);
    expect(overflow.record.durable[0]?.id).toBe("fact-0");
    expect(overflow.skipped[0]).toContain("memory is full");
    // Pruning is for the handover only: nothing durable ages out.
    const pruned = pruneVoiceMemoryV1(
      overflow.record,
      new Date("2027-09-01T00:00:00.000Z"),
    );
    expect(pruned.durable).toHaveLength(VOICE_MEMORY_MAX_DURABLE_V1);
  });
});

describe("freshness", () => {
  const recorded = apply(
    emptyVoiceMemoryRecordV1(),
    [{ kind: "recent/add", text: "Chased the invoice.", source: "call-1:1" }],
    [turn({ at: "2026-09-01T10:00:00.000Z" })],
  ).record;

  test("a handover line falls away after its fourteen days", () => {
    const inside = pruneVoiceMemoryV1(
      recorded,
      new Date(Date.parse("2026-09-01T10:00:00.000Z") + 13 * DAY),
    );
    expect(inside.recent).toHaveLength(1);
    const outside = pruneVoiceMemoryV1(
      recorded,
      new Date(
        Date.parse("2026-09-01T10:00:00.000Z") +
          (VOICE_MEMORY_RECENT_DAYS_V1 + 1) * DAY,
      ),
    );
    expect(outside.recent).toEqual([]);
  });

  test("reading it does not renew it", () => {
    renderVoiceMemoryLinesV1(recorded);
    const later = pruneVoiceMemoryV1(
      recorded,
      new Date(Date.parse("2026-09-01T10:00:00.000Z") + 10 * DAY),
    );
    renderVoiceMemoryLinesV1(later);
    expect(later.recent[0]?.at).toBe("2026-09-01T10:00:00.000Z");
  });

  test("reading the same turn again does not renew it", () => {
    // This is the carry-forward case: an earlier call re-read by a later
    // job. The words and the turn are the same, so nothing moves.
    const again = apply(
      recorded,
      [{ kind: "recent/add", text: "Chased the invoice.", source: "call-1:1" }],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    );
    expect(again.record.recent).toHaveLength(1);
    expect(again.record.recent[0]?.at).toBe("2026-09-01T10:00:00.000Z");
    expect(again.skipped[0]).toContain("already recorded");
  });

  test("saying it again in a later conversation does refresh it", () => {
    const again = apply(
      recorded,
      [{ kind: "recent/add", text: "Chased the invoice.", source: "call-2:1" }],
      [turn({ call: "call-2", at: "2026-09-10T10:00:00.000Z" })],
    );
    expect(again.record.recent).toHaveLength(1);
    expect(again.record.recent[0]?.at).toBe("2026-09-10T10:00:00.000Z");
  });

  test("a timeframe is a word, never a date the model supplies", () => {
    const update = decodeVoiceMemoryUpdateV1(
      JSON.stringify({
        operations: [
          {
            kind: "recent/add",
            text: "Skip the small talk today.",
            source: "call-1:1",
            until: "today",
          },
          {
            kind: "recent/add",
            text: "Something until the 30th.",
            source: "call-1:1",
            until: "2026-09-30",
          },
          {
            kind: "recent/add",
            text: "Something dated by hand.",
            source: "call-1:1",
            expiresAt: "2027-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(update.operations[0]).toMatchObject({ until: "today" });
    // An unsupported timeframe is dropped, not interpreted…
    expect(update.operations[1]).not.toHaveProperty("until");
    expect(update.refusals.join(" ")).toContain("not today or week");
    // …and a date the model invented is not carried at all.
    expect(update.operations[2]).not.toHaveProperty("expiresAt");

    // The dating is the applier's, from the turn's own time and their zone.
    const applied = applyVoiceMemoryUpdateV1(emptyVoiceMemoryRecordV1(), {
      operations: [update.operations[0]!],
      sources: [turn({ at: "2026-09-12T13:00:00.000Z" })],
      timezone: "Australia/Sydney",
    });
    expect(applied.record.recent[0]?.expiresAt).toBe(
      "2026-09-12T14:00:00.000Z",
    );
  });

  test("a temporary preference survives the call and stops the next day", () => {
    // Said in the call and written by the tool, then read again by the
    // end-of-call update: it holds tomorrow morning's conversation only if
    // that is still inside its own day.
    const spoken = applyVoiceMemoryUpdateV1(emptyVoiceMemoryRecordV1(), {
      operations: [
        {
          kind: "recent/add",
          text: "Skip the small talk.",
          source: "call-1:1",
          until: "today",
        },
      ],
      sources: [turn({ at: "2026-09-12T03:00:00.000Z" })],
      timezone: "Australia/Sydney",
    }).record;
    const expiresAt = spoken.recent[0]!.expiresAt!;
    // A later call the same local day still has it.
    expect(
      pruneVoiceMemoryV1(spoken, new Date("2026-09-12T09:00:00.000Z")).recent,
    ).toHaveLength(1);
    // The finalization reads the same turn again and changes nothing.
    const summarised = applyVoiceMemoryUpdateV1(spoken, {
      operations: [
        {
          kind: "recent/add",
          text: "Skip the small talk.",
          source: "call-1:1",
          until: "today",
        },
      ],
      sources: [turn({ at: "2026-09-12T03:00:00.000Z" })],
      timezone: "Australia/Sydney",
    });
    expect(summarised.record.recent[0]?.expiresAt).toBe(expiresAt);
    // The next local day does not.
    expect(
      pruneVoiceMemoryV1(
        summarised.record,
        new Date("2026-09-13T03:00:00.000Z"),
      ).recent,
    ).toEqual([]);
  });

  test("a timeframe request nobody answered still gets its end", () => {
    // The person asked and hung up before any reply, so nothing wrote it
    // during the call. The finalization reads the turn and dates it from
    // that turn, not from whenever the summary happened to run.
    const summarised = applyVoiceMemoryUpdateV1(emptyVoiceMemoryRecordV1(), {
      operations: [
        {
          kind: "recent/add",
          text: "Keep it brief just for today.",
          source: "call-1:1",
          until: "today",
        },
      ],
      sources: [turn({ at: "2026-09-12T03:00:00.000Z" })],
      timezone: "Australia/Sydney",
    });
    expect(summarised.record.recent[0]?.expiresAt).toBe(
      "2026-09-12T14:00:00.000Z",
    );
    expect(summarised.record.durable).toEqual([]);
  });

  test("a timeframe set on a clock-change day still stops at their midnight", () => {
    // Sydney starts daylight saving at 2am on 4 October 2026, so that local
    // day is twenty-three hours long: a fixed twenty-four minus the minutes
    // already gone lands an hour past their midnight, on the wrong day.
    const spring = new Date("2026-10-03T15:30:17.500Z");
    const springEnd = voiceMemoryHorizonEndV1(
      "today",
      spring,
      "Australia/Sydney",
    );
    // 01:30 on the 4th, local; midnight starting the 5th, local.
    expect(springEnd).toBe("2026-10-04T13:00:00.000Z");

    // And back the other way: 4 April 2027 is twenty-five hours long.
    const autumn = new Date("2027-04-03T13:30:00.000Z");
    expect(voiceMemoryHorizonEndV1("today", autumn, "Australia/Sydney")).toBe(
      "2027-04-04T14:00:00.000Z",
    );

    // What the person asked for holds for the whole of their day and not
    // past it.
    const kept = applyVoiceMemoryUpdateV1(emptyVoiceMemoryRecordV1(), {
      operations: [
        {
          kind: "recent/add",
          text: "Skip the small talk.",
          source: "call-1:1",
          until: "today",
        },
      ],
      sources: [turn({ at: spring.toISOString() })],
      timezone: "Australia/Sydney",
    }).record;
    expect(kept.recent[0]?.expiresAt).toBe(springEnd);
    // Late on their 4th — past the twenty-four hours the old arithmetic gave.
    expect(
      pruneVoiceMemoryV1(kept, new Date("2026-10-04T12:59:00.000Z")).recent,
    ).toHaveLength(1);
    // Their 5th.
    expect(
      pruneVoiceMemoryV1(kept, new Date("2026-10-04T13:00:01.000Z")).recent,
    ).toEqual([]);
  });

  test("a day that begins when the clock changes ends when it begins", () => {
    // Chile puts its clocks forward at midnight, so 00:00 on 6 September 2026
    // never happens there and the day begins an hour later.
    const now = new Date("2026-09-05T18:00:00.000Z");
    const end = voiceMemoryHorizonEndV1("today", now, "America/Santiago");
    expect(end).toBe("2026-09-06T04:00:00.000Z");
    const kept = applyVoiceMemoryUpdateV1(emptyVoiceMemoryRecordV1(), {
      operations: [
        {
          kind: "recent/add",
          text: "Skip the small talk.",
          source: "call-1:1",
          until: "today",
        },
      ],
      sources: [turn({ at: now.toISOString() })],
      timezone: "America/Santiago",
    }).record;
    expect(kept.recent[0]?.expiresAt).toBe(end);
    // Half past eleven on their 5th: still their day.
    expect(
      pruneVoiceMemoryV1(kept, new Date("2026-09-06T03:30:00.000Z")).recent,
    ).toHaveLength(1);
    // Their 6th.
    expect(
      pruneVoiceMemoryV1(kept, new Date("2026-09-06T04:00:01.000Z")).recent,
    ).toEqual([]);
    // Lebanon changes at midnight too, going the other way round the world.
    expect(
      voiceMemoryHorizonEndV1(
        "today",
        new Date("2026-03-28T12:00:00.000Z"),
        "Asia/Beirut",
      ),
    ).toBe("2026-03-28T22:00:00.000Z");
  });

  test("something asked for within a timeframe stops at its own end", () => {
    const today = voiceMemoryHorizonEndV1(
      "today",
      new Date("2026-09-12T13:00:00.000Z"),
      "Australia/Sydney",
    );
    // 23:00 local on the 12th: an hour to their midnight, not a fortnight.
    expect(Date.parse(today) - Date.parse("2026-09-12T13:00:00.000Z")).toBe(
      60 * 60_000,
    );
    const kept = applyVoiceMemoryUpdateV1(emptyVoiceMemoryRecordV1(), {
      operations: [
        {
          kind: "recent/add",
          text: "Skip the small talk.",
          source: "call-1:1",
          until: "today",
        },
      ],
      sources: [turn({ at: "2026-09-12T13:00:00.000Z" })],
      timezone: "Australia/Sydney",
    }).record;
    expect(kept.recent[0]?.expiresAt).toBe(today);
    expect(
      pruneVoiceMemoryV1(kept, new Date("2026-09-12T13:30:00.000Z")).recent,
    ).toHaveLength(1);
    expect(
      pruneVoiceMemoryV1(kept, new Date("2026-09-13T02:00:00.000Z")).recent,
    ).toEqual([]);
  });
});

describe("order", () => {
  const corrected = apply(
    emptyVoiceMemoryRecordV1(),
    [
      {
        kind: "durable/add",
        id: "length",
        text: "Explain things more fully.",
        source: "call-2:1",
      },
    ],
    [turn({ call: "call-2", at: "2026-09-05T10:00:00.000Z" })],
  ).record;

  test("a late summary of an older conversation cannot undo the correction", () => {
    const stale = apply(
      corrected,
      [
        {
          kind: "durable/add",
          id: "length",
          text: "Keep answers short.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    );
    expect(stale.record.durable[0]?.text).toBe("Explain things more fully.");
    expect(stale.skipped.join(" ")).toContain("already newer");
  });

  test("an earlier turn of the same call cannot undo a later one", () => {
    const later = apply(
      corrected,
      [
        {
          kind: "durable/add",
          id: "length",
          text: "Keep answers short.",
          source: "call-2:0",
        },
      ],
      // The same call and the same millisecond: only the turn order separates
      // them, and it is what decides.
      [
        {
          ...turn({ call: "call-2", at: "2026-09-05T10:00:00.000Z" }),
          id: "call-2:0",
          ordinal: 0,
        },
      ],
    );
    expect(later.record.durable[0]?.text).toBe("Explain things more fully.");
  });

  test("re-reading an old conversation cannot resurrect what was forgotten", () => {
    // Said in the first call, dropped in the second. The first call's
    // summary only runs now — and must not bring it back.
    const said = apply(
      emptyVoiceMemoryRecordV1(),
      [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    ).record;
    const dropped = apply(
      said,
      [{ kind: "durable/remove", id: "flat-whites", source: "call-2:1" }],
      [turn({ call: "call-2", at: "2026-09-05T10:00:00.000Z" })],
    ).record;
    expect(dropped.durable).toEqual([]);
    const resurrected = apply(
      dropped,
      [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    );
    expect(resurrected.record.durable).toEqual([]);
    expect(resurrected.skipped.join(" ")).toContain("dropped more recently");
  });

  test("a removal read out of order still fences the write that undoes it", () => {
    // The later call's "forget that" is applied first; the earlier call's
    // summary arrives after it and is refused.
    const dropped = apply(
      emptyVoiceMemoryRecordV1(),
      [{ kind: "durable/remove", id: "flat-whites", source: "call-2:1" }],
      [turn({ call: "call-2", at: "2026-09-05T10:00:00.000Z" })],
    ).record;
    const late = apply(
      dropped,
      [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    );
    expect(late.record.durable).toEqual([]);
  });
});

describe("what a spoken forget names", () => {
  const record = apply(
    emptyVoiceMemoryRecordV1(),
    [
      {
        kind: "durable/add",
        id: "flat-whites",
        text: "Drinks flat whites in the morning.",
        source: "call-1:1",
      },
      {
        kind: "recent/add",
        text: "Talked about the roof.",
        source: "call-1:1",
      },
    ],
    [turn({ at: "2026-09-01T10:00:00.000Z" })],
  ).record;

  test("matches by id and by their own words", () => {
    expect(matchVoiceMemoryV1(record, "flat-whites")).toEqual([
      { kind: "durable", id: "flat-whites" },
    ]);
    expect(matchVoiceMemoryV1(record, "flat whites")).toHaveLength(1);
    expect(matchVoiceMemoryV1(record, "the roof")).toEqual([
      { kind: "recent", id: "talked-about-the-roof" },
    ]);
  });

  test("names nothing when nothing is like it", () => {
    expect(matchVoiceMemoryV1(record, "my sister's birthday")).toEqual([]);
  });
});

describe("what a correction drops", () => {
  const record = apply(
    emptyVoiceMemoryRecordV1(),
    [
      {
        kind: "durable/add",
        id: "mornings",
        text: "Prefers calls in the morning.",
        source: "call-1:1",
      },
      {
        kind: "ongoing/add",
        id: "standup-time",
        text: "Deciding whether to move the morning standup.",
        source: "call-1:1",
      },
    ],
    [turn({ at: "2026-09-01T10:00:00.000Z" })],
  ).record;

  test("the id it names, and nothing that merely says the same words", () => {
    expect(voiceMemoryCorrectionTargetsV1(record, "mornings")).toEqual([
      { kind: "durable", id: "mornings" },
    ]);
    // A spoken forget is deliberately literal, so this wording finds both.
    expect(matchVoiceMemoryV1(record, "the morning")).toHaveLength(2);
    // A correction is a deletion, so it takes neither: it fences its own
    // slug instead, which no entry here answers to.
    expect(voiceMemoryCorrectionTargetsV1(record, "the morning")).toEqual([
      { kind: "durable", id: "the-morning" },
      { kind: "ongoing", id: "the-morning" },
      { kind: "recent", id: "the-morning" },
    ]);
  });

  test("an id the prompt listed lands exactly as it was listed", () => {
    // `validId` keeps the id the model gave, and it may hold a run of dashes
    // that slugging the same words would collapse. The prompt lists that id,
    // so a correction naming it has to find the entry rather than fence a
    // name nothing answers to.
    const odd = apply(
      emptyVoiceMemoryRecordV1(),
      [
        {
          kind: "durable/add",
          id: "answer--length",
          text: "Keep answers short.",
          source: "call-1:1",
        },
      ],
      [turn({ at: "2026-09-01T10:00:00.000Z" })],
    ).record;
    expect(odd.durable.map((entry) => entry.id)).toEqual(["answer--length"]);
    expect(voiceMemoryCorrectionTargetsV1(odd, "answer--length")).toEqual([
      { kind: "durable", id: "answer--length" },
    ]);
  });

  test("the open question survives a correction worded over it", () => {
    const corrected = apply(
      record,
      [
        ...voiceMemoryCorrectionTargetsV1(record, "the morning").map(
          (target): VoiceMemoryOperationV1 =>
            target.kind === "durable"
              ? { kind: "durable/remove", id: target.id, source: "call-2:1" }
              : target.kind === "ongoing"
                ? { kind: "ongoing/remove", id: target.id, source: "call-2:1" }
                : { kind: "recent/remove", id: target.id, source: "call-2:1" },
        ),
        {
          kind: "durable/add",
          id: "afternoons",
          text: "Prefers calls in the afternoon.",
          source: "call-2:1",
        },
      ],
      [turn({ call: "call-2", at: "2026-09-05T10:00:00.000Z" })],
    ).record;
    expect(corrected.ongoing.map((entry) => entry.id)).toEqual([
      "standup-time",
    ]);
    expect(corrected.durable.map((entry) => entry.id)).toEqual([
      "mornings",
      "afternoons",
    ]);
  });

  test("an id said in their own casing still lands", () => {
    expect(voiceMemoryCorrectionTargetsV1(record, " Standup-Time ")).toEqual([
      { kind: "ongoing", id: "standup-time" },
    ]);
  });
});

// ---------------------------------------------------------------------------

function ledger() {
  const storage = createMemoryVoiceLedgerStorageV1();
  const calls: Record<string, VoiceMemorySourceTurnV1[]> = {};
  const read = async (callId: string) => calls[callId] ?? [];
  return {
    storage,
    calls,
    read,
    memory: new VoiceMemoryLedgerV1(storage),
  };
}

function conversation(
  callId: string,
  sequence: number,
  count: number,
  from = "2026-09-01T10:00:00.000Z",
): VoiceMemorySourceTurnV1[] {
  return Array.from({ length: count }, (_, index) =>
    turn({
      call: callId,
      sequence,
      ordinal: index + 1,
      at: new Date(Date.parse(from) + index * 60_000).toISOString(),
      said: `turn ${index + 1}`,
      answered: `answer ${index + 1}`,
    }),
  );
}

describe("the end-of-call job", () => {
  test("a second end finds the job the first wrote", async () => {
    const { memory } = ledger();
    const input = {
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    };
    expect((await memory.createJob(input)).status).toBe("created");
    expect((await memory.createJob(input)).status).toBe("existing");
    expect(await memory.jobs()).toHaveLength(1);
  });

  test("a fact dropped long ago is not written back by a job that never finished", async () => {
    const { memory, calls, read } = ledger();
    // The first call's summary was dispatched and never came back, so its
    // turns are still unread source that could yet be summarised.
    calls["call-1"] = conversation("call-1", CALL_ONE, 1);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    await memory.claimChunk({
      callId: "call-1",
      at: new Date("2026-09-01T11:00:02.000Z"),
      read,
    });
    await memory.abandonChunk(
      "call-1",
      "the connection failed",
      new Date("2026-09-01T11:00:30.000Z"),
    );
    expect((await memory.readJob("call-1"))?.state).toBe("failed");

    // In a later call they state the fact and then take it back.
    const [said, took] = conversation(
      "call-2",
      CALL_TWO,
      2,
      "2026-09-05T10:00:00.000Z",
    );
    await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: said!.id,
        },
      ],
      sources: [said!],
      now: new Date("2026-09-05T10:00:00.000Z"),
    });
    await memory.apply({
      operations: [
        { kind: "durable/remove", id: "flat-whites", source: took!.id },
      ],
      sources: [took!],
      now: new Date("2026-09-05T10:01:00.000Z"),
    });

    // Then far more corrections than the fences are counted to.
    const later = conversation(
      "call-3",
      3_000,
      VOICE_MEMORY_MAX_TOMBSTONES_V1 + 20,
      "2026-09-06T10:00:00.000Z",
    );
    await memory.apply({
      operations: later.flatMap((source) => [
        {
          kind: "durable/add" as const,
          id: `fact-${source.ordinal}`,
          text: `Fact ${source.ordinal}.`,
          source: source.id,
        },
        {
          kind: "durable/remove" as const,
          id: `fact-${source.ordinal}`,
          source: source.id,
        },
      ]),
      sources: later,
      now: new Date("2026-09-06T12:00:00.000Z"),
    });

    // The first call finally gets summarised, and says the fact again.
    const stale = await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: calls["call-1"]![0]!.id,
        },
      ],
      sources: calls["call-1"]!,
      now: new Date("2026-09-07T10:00:00.000Z"),
    });
    expect(stale.record.durable).toEqual([]);
    expect(stale.skipped.join(" ")).toContain("dropped more recently");
  });

  test("a correction fences a fact whose conversation was never read, when the summary names it the same", async () => {
    const { memory, calls, read } = ledger();
    // They asked for long answers in the first call, and that call's
    // finalization was dispatched and never came back.
    calls["call-1"] = conversation("call-1", CALL_ONE, 1);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    await memory.claimChunk({
      callId: "call-1",
      at: new Date("2026-09-01T11:00:02.000Z"),
      read,
    });
    await memory.abandonChunk(
      "call-1",
      "the connection failed",
      new Date("2026-09-01T11:00:30.000Z"),
    );

    // In the next call they correct it. Nothing in the record matches what
    // they are replacing, because nothing has been written down yet.
    const [correcting] = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-05T10:00:00.000Z",
    );
    const record = await memory.read();
    const replaced = "Give me long answers.";
    expect(matchVoiceMemoryV1(record, replaced)).toEqual([]);
    await memory.apply({
      operations: [
        ...voiceMemoryCorrectionTargetsV1(record, replaced).map(
          (target): VoiceMemoryOperationV1 =>
            target.kind === "durable"
              ? {
                  kind: "durable/remove",
                  id: target.id,
                  source: correcting!.id,
                }
              : target.kind === "ongoing"
                ? {
                    kind: "ongoing/remove",
                    id: target.id,
                    source: correcting!.id,
                  }
                : {
                    kind: "recent/remove",
                    id: target.id,
                    source: correcting!.id,
                  },
        ),
        {
          kind: "durable/add",
          id: "short-answers",
          text: "Keep answers short.",
          source: correcting!.id,
        },
      ],
      sources: [correcting!],
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    // The first call is finally summarised and says the old preference. It
    // is refused because it named the fact the same way the correction did:
    // the fence is exact, and this is the case where both sides agree.
    const stale = await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "give-me-long-answers",
          text: replaced,
          source: calls["call-1"]![0]!.id,
        },
      ],
      sources: calls["call-1"]!,
      now: new Date("2026-09-07T10:00:00.000Z"),
    });
    expect(stale.record.durable.map((entry) => entry.id)).toEqual([
      "short-answers",
    ]);
    expect(stale.skipped.join(" ")).toContain("dropped more recently");
  });

  test("when the late summary names it differently the instruction is what carries the order", async () => {
    const { memory, calls, read } = ledger();
    // The same shape as above: the first call stated a preference and its
    // finalization never came back.
    calls["call-1"] = conversation("call-1", CALL_ONE, 1);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    await memory.claimChunk({
      callId: "call-1",
      at: new Date("2026-09-01T11:00:02.000Z"),
      read,
    });
    await memory.abandonChunk(
      "call-1",
      "the connection failed",
      new Date("2026-09-01T11:00:30.000Z"),
    );

    calls["call-2"] = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-05T10:00:00.000Z",
    );
    const correcting = calls["call-2"]![0];
    const replaced = "Give me long answers.";
    await memory.apply({
      operations: [
        ...voiceMemoryCorrectionTargetsV1(await memory.read(), replaced).map(
          (target): VoiceMemoryOperationV1 =>
            target.kind === "durable"
              ? {
                  kind: "durable/remove",
                  id: target.id,
                  source: correcting!.id,
                }
              : target.kind === "ongoing"
                ? {
                    kind: "ongoing/remove",
                    id: target.id,
                    source: correcting!.id,
                  }
                : {
                    kind: "recent/remove",
                    id: target.id,
                    source: correcting!.id,
                  },
        ),
        {
          kind: "durable/add",
          id: "short-answers",
          text: "Keep answers short.",
          source: correcting!.id,
        },
      ],
      sources: [correcting!],
      now: new Date("2026-09-05T10:00:00.000Z"),
    });

    // The second call ends and its finalization carries the first one's
    // unread turns. This is the instruction it is given: it dates what is
    // remembered, lists what has been dropped since, and says that an older
    // conversation is not a reason to write a remembered fact back. That
    // instruction is the whole of what decides this case — whether the model
    // then names the old preference `answer-length` or leaves it alone is
    // the model's call, and this test does not stand in for it.
    await memory.createJob({
      callId: "call-2",
      sequence: CALL_TWO,
      at: new Date("2026-09-07T09:00:00.000Z"),
    });
    const chunk = await memory.claimChunk({
      callId: "call-2",
      at: new Date("2026-09-07T09:00:01.000Z"),
      read,
    });
    expect(chunk!.turns.map((source) => source.id)).toContain("call-1:1");
    const instruction = renderVoiceMemoryRequestMessagesV1({
      turns: chunk!.turns,
      record: await memory.read(),
      progress: { from: chunk!.from, total: chunk!.total },
    }).at(-1)!.content;
    expect(instruction).toContain(
      `durable (short-answers) Keep answers short. [said 2026-09-05T10:00:00.000Z, call ${CALL_TWO} turn 1]`,
    );
    expect(instruction).toContain("durable (give-me-long-answers) [dropped");
    expect(instruction).toContain(
      "may be older than what you already remember",
    );

    // If it names it differently anyway, nothing in the record refuses it:
    // there is no id the two sides share. The record then holds a fact the
    // person has moved on from until they correct it again — the bound of a
    // fence built from words nobody wrote down.
    const stale = await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "answer-length",
          text: replaced,
          source: calls["call-1"]![0]!.id,
        },
      ],
      sources: calls["call-1"]!,
      now: new Date("2026-09-07T10:00:00.000Z"),
    });
    expect(stale.record.durable.map((entry) => entry.id)).toEqual([
      "short-answers",
      "answer-length",
    ]);
  });

  test("a correction made mid-call outlives that call's own summary", async () => {
    const { memory, calls, read } = ledger();
    // One live call: they state a preference, take it back, and then say
    // enough other things to push past the fence count.
    const turns = conversation(
      "call-1",
      CALL_ONE,
      VOICE_MEMORY_MAX_TOMBSTONES_V1 + 4,
      "2026-09-01T10:00:00.000Z",
    );
    calls["call-1"] = turns;
    await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "long-answers",
          text: "Give long answers.",
          source: turns[0]!.id,
        },
      ],
      sources: [turns[0]!],
      now: new Date(turns[0]!.at),
    });
    for (const source of turns.slice(1)) {
      await memory.apply({
        operations: [
          {
            kind: "durable/remove",
            id:
              source.ordinal === 2 ? "long-answers" : `fact-${source.ordinal}`,
            source: source.id,
          },
        ],
        sources: [source],
        now: new Date(source.at),
      });
    }

    // Only now does the call end and its finalization read the turn that
    // first stated the preference.
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T14:00:00.000Z"),
    });
    const chunk = await memory.claimChunk({
      callId: "call-1",
      at: new Date("2026-09-01T14:00:01.000Z"),
      read,
    });
    const applied = await memory.applyChunk({
      callId: "call-1",
      chunk: chunk!,
      update: {
        operations: [
          {
            kind: "durable/add",
            id: "long-answers",
            text: "Give long answers.",
            source: turns[0]!.id,
          },
        ],
        refusals: [],
        malformed: false,
      },
      at: new Date("2026-09-01T14:00:02.000Z"),
    });
    expect(applied.status).toBe("applied");
    expect((await memory.read()).durable).toEqual([]);
  });

  test("with nothing left unread the removal fences are held to their count", async () => {
    const { memory, calls, read } = ledger();
    const later = conversation(
      "call-1",
      CALL_ONE,
      VOICE_MEMORY_MAX_TOMBSTONES_V1 + 20,
      "2026-09-06T10:00:00.000Z",
    );
    calls["call-1"] = later;
    await memory.apply({
      operations: later.map((source) => ({
        kind: "durable/remove" as const,
        id: `fact-${source.ordinal}`,
        source: source.id,
      })),
      sources: later,
      now: new Date("2026-09-06T12:00:00.000Z"),
    });
    // Its own finalization reads every one of those turns, so nothing is
    // left that could argue with the fences they wrote.
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-06T12:30:00.000Z"),
    });
    for (let pass = 0; pass < 20; pass += 1) {
      const chunk = await memory.claimChunk({
        callId: "call-1",
        at: new Date("2026-09-06T12:30:01.000Z"),
        read,
      });
      if (!chunk) break;
      const result = await memory.applyChunk({
        callId: "call-1",
        chunk,
        update: { operations: [], refusals: [], malformed: false },
        at: new Date("2026-09-06T12:30:02.000Z"),
      });
      if (result.status !== "applied" || result.done) break;
    }
    expect((await memory.readJob("call-1"))?.state).toBe("applied");

    // The next conversation is where the count is finally applied.
    const next = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-07T10:00:00.000Z",
    );
    await memory.apply({
      operations: [
        { kind: "durable/remove", id: "anything", source: next[0]!.id },
      ],
      sources: next,
      now: new Date("2026-09-07T10:00:00.000Z"),
    });
    expect((await memory.read()).forgotten).toHaveLength(
      VOICE_MEMORY_MAX_TOMBSTONES_V1,
    );
  });

  test("a call with nothing said finishes without spending anything", async () => {
    const { memory, read } = ledger();
    await memory.createJob({
      callId: "call-empty",
      sequence: CALL_ONE,
      at: new Date(),
    });
    expect(
      await memory.claimChunk({
        callId: "call-empty",
        at: new Date(),
        read,
      }),
    ).toBeUndefined();
    expect((await memory.readJob("call-empty"))?.state).toBe("applied");
  });

  test("only one of two racing finalizations claims the chunk", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    const at = new Date("2026-09-01T11:00:02.000Z");
    const both = await Promise.all([
      memory.claimChunk({ callId: "call-1", at, read }),
      memory.claimChunk({ callId: "call-1", at, read }),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect((await memory.readJob("call-1"))?.attempts).toBe(1);
  });

  test("a dispatched request that never answered is not sent again", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    expect(
      await memory.claimChunk({
        callId: "call-1",
        at: new Date("2026-09-01T11:00:02.000Z"),
        read,
      }),
    ).toBeDefined();
    // The gateway failed after the request left, or the object was evicted.
    await memory.abandonChunk(
      "call-1",
      "the connection failed",
      new Date("2026-09-01T11:00:30.000Z"),
    );
    const job = await memory.readJob("call-1");
    expect(job?.state).toBe("failed");
    expect(job?.cursor).toBe(0);
    // Nothing claims it again, however many attempts it has left.
    expect(
      await memory.claimChunk({
        callId: "call-1",
        at: new Date("2026-09-01T11:01:00.000Z"),
        read,
      }),
    ).toBeUndefined();
    // The turns are still the ledger's, ready for the next call to read.
    expect(await memory.carriedContinuity(read)).toHaveLength(2);
  });

  test("an eviction mid-request is recorded as uncertain, never repeated", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    await memory.claimChunk({
      callId: "call-1",
      at: new Date("2026-09-01T11:00:02.000Z"),
      read,
    });
    expect(
      await memory.failUncertainJobs(new Date("2026-09-01T11:05:00.000Z")),
    ).toEqual(["call-1"]);
    const job = await memory.readJob("call-1");
    expect(job?.state).toBe("failed");
    expect(job?.failure).toBe(VOICE_MEMORY_UNCERTAIN_FAILURE_V1);
    expect(await memory.pendingJobs()).toEqual([]);
  });

  test("an answer that arrived whole but could not be read is asked again", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    let attempts = 0;
    for (let index = 0; index < VOICE_MEMORY_MAX_ATTEMPTS_V1 + 2; index += 1) {
      const chunk = await memory.claimChunk({
        callId: "call-1",
        at: new Date(),
        read,
      });
      if (!chunk) break;
      attempts += 1;
      await memory.retryChunk("call-1", "the update was not JSON", new Date());
    }
    expect(attempts).toBe(VOICE_MEMORY_MAX_ATTEMPTS_V1);
    const job = await memory.readJob("call-1");
    expect(job?.state).toBe("failed");
    expect(job?.cursor).toBe(0);
    expect(await memory.read()).toEqual(emptyVoiceMemoryRecordV1());
  });

  test("a long call is read in chunks, keeping what was said at the start", async () => {
    const { memory, calls, read } = ledger();
    const total = VOICE_MEMORY_CHUNK_TURNS_V1 + 5;
    calls["call-1"] = conversation("call-1", CALL_ONE, total);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T12:00:00.000Z"),
    });
    const first = await memory.claimChunk({
      callId: "call-1",
      at: new Date(),
      read,
    });
    expect(first?.turns).toHaveLength(VOICE_MEMORY_CHUNK_TURNS_V1);
    // The very first turn of the call is in the first chunk, whole.
    expect(first?.turns[0]?.id).toBe("call-1:1");
    const applied = await memory.applyChunk({
      callId: "call-1",
      chunk: first!,
      update: {
        operations: [
          {
            kind: "durable/add",
            id: "early",
            text: "Said in the first minute.",
            source: "call-1:1",
          },
        ],
        refusals: [],
        malformed: false,
      },
      at: new Date("2026-09-01T12:00:05.000Z"),
    });
    expect(applied).toMatchObject({ status: "applied", done: false });
    expect((await memory.read()).durable[0]?.text).toBe(
      "Said in the first minute.",
    );
    const second = await memory.claimChunk({
      callId: "call-1",
      at: new Date(),
      read,
    });
    expect(second?.turns).toHaveLength(5);
    expect(second?.from).toBe(VOICE_MEMORY_CHUNK_TURNS_V1);
    const done = await memory.applyChunk({
      callId: "call-1",
      chunk: second!,
      update: { operations: [], refusals: [], malformed: false },
      at: new Date("2026-09-01T12:00:09.000Z"),
    });
    expect(done).toMatchObject({ status: "applied", done: true });
    expect((await memory.readJob("call-1"))?.state).toBe("applied");
  });

  test("a call that starts before the last one was summarised carries it", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    calls["call-2"] = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-01T11:10:00.000Z",
    );
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    // The first call's own attempt came to nothing.
    await memory.claimChunk({ callId: "call-1", at: new Date(), read });
    await memory.abandonChunk("call-1", "never answered", new Date());
    // The next call ends, and reads what the first one never finished.
    await memory.createJob({
      callId: "call-2",
      sequence: CALL_TWO,
      at: new Date("2026-09-01T11:11:00.000Z"),
    });
    const chunk = await memory.claimChunk({
      callId: "call-2",
      at: new Date(),
      read,
    });
    expect(chunk?.turns.map((item) => item.id)).toEqual([
      "call-1:1",
      "call-1:2",
      "call-2:1",
    ]);
    const applied = await memory.applyChunk({
      callId: "call-2",
      chunk: chunk!,
      update: {
        operations: [
          {
            kind: "recent/add",
            text: "Something from the earlier call.",
            source: "call-1:1",
          },
        ],
        refusals: [],
        malformed: false,
      },
      at: new Date("2026-09-01T11:12:00.000Z"),
    });
    expect(applied.status).toBe("applied");
    // The fact takes the earlier call's own time, not this summary's.
    expect((await memory.read()).recent[0]?.at).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    // And the call it read is answered for, not left to be read again.
    expect((await memory.readJob("call-1"))?.state).toBe("applied");
    expect(await memory.carriedContinuity(read)).toEqual([]);
  });

  test("carrying a long unfinished call reads all of it, not just its opening", async () => {
    const { memory, calls, read } = ledger();
    const long = VOICE_MEMORY_CHUNK_TURNS_V1 * 3;
    calls["call-1"] = conversation("call-1", CALL_ONE, long);
    calls["call-2"] = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-02T10:00:00.000Z",
    );
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T12:00:00.000Z"),
    });
    await memory.claimChunk({ callId: "call-1", at: new Date(), read });
    await memory.abandonChunk("call-1", "never answered", new Date());
    await memory.createJob({
      callId: "call-2",
      sequence: CALL_TWO,
      at: new Date("2026-09-02T10:01:00.000Z"),
    });

    const empty = { operations: [], refusals: [], malformed: false };
    // The first chunk is all of the older call's opening, so the older call
    // moves forward by exactly that and keeps the rest.
    const first = await memory.claimChunk({
      callId: "call-2",
      at: new Date(),
      read,
    });
    expect(first?.turns.every((item) => item.callId === "call-1")).toBe(true);
    const applied = await memory.applyChunk({
      callId: "call-2",
      chunk: first!,
      update: empty,
      at: new Date(),
    });
    expect(applied).toMatchObject({ status: "applied", done: false });
    const carried = await memory.readJob("call-1");
    expect(carried?.cursor).toBe(VOICE_MEMORY_CHUNK_TURNS_V1);
    expect(carried?.state).not.toBe("applied");

    // It keeps going until the older call's last turn has been read, and only
    // then is the newer call finished.
    for (let round = 0; round < 4; round += 1) {
      const chunk = await memory.claimChunk({
        callId: "call-2",
        at: new Date(),
        read,
      });
      if (!chunk) break;
      await memory.applyChunk({
        callId: "call-2",
        chunk,
        update: empty,
        at: new Date(),
      });
    }
    expect(await memory.readJob("call-1")).toMatchObject({
      cursor: long,
      state: "applied",
    });
    expect(await memory.readJob("call-2")).toMatchObject({
      cursor: 1,
      state: "applied",
    });
  });

  test("a call still working on its own is never read by another one", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 3);
    calls["call-2"] = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-02T10:00:00.000Z",
    );
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T12:00:00.000Z"),
    });
    await memory.createJob({
      callId: "call-2",
      sequence: CALL_TWO,
      at: new Date("2026-09-02T10:01:00.000Z"),
    });
    // The older call is still pending: it has its own scheduled path, so the
    // newer one leaves it alone rather than reading the same source twice.
    const chunk = await memory.claimChunk({
      callId: "call-2",
      at: new Date(),
      read,
    });
    expect(chunk?.turns.map((item) => item.callId)).toEqual(["call-2"]);
  });

  test("two readers of one carried call cannot step over its source", async () => {
    const { memory, calls, read } = ledger();
    calls["call-0"] = conversation("call-0", 500, 6);
    calls["call-1"] = conversation("call-1", CALL_ONE, 1);
    calls["call-2"] = conversation("call-2", CALL_TWO, 1);
    await memory.createJob({ callId: "call-0", sequence: 500, at: new Date() });
    await memory.claimChunk({ callId: "call-0", at: new Date(), read });
    await memory.abandonChunk("call-0", "never answered", new Date());
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date(),
    });
    await memory.createJob({
      callId: "call-2",
      sequence: CALL_TWO,
      at: new Date(),
    });

    // Both later calls claim while the older one is still failed, so both
    // windows cover the same carried turns.
    const first = await memory.claimChunk({
      callId: "call-1",
      at: new Date(),
      read,
    });
    const second = await memory.claimChunk({
      callId: "call-2",
      at: new Date(),
      read,
    });
    expect(first?.turns.filter((t) => t.callId === "call-0")).toHaveLength(6);
    expect(second?.turns.filter((t) => t.callId === "call-0")).toHaveLength(6);

    const empty = { operations: [], refusals: [], malformed: false };
    await memory.applyChunk({
      callId: "call-1",
      chunk: first!,
      update: empty,
      at: new Date(),
    });
    await memory.applyChunk({
      callId: "call-2",
      chunk: second!,
      update: empty,
      at: new Date(),
    });
    // The cursor is where the reading actually reached, not six plus six.
    expect(await memory.readJob("call-0")).toMatchObject({
      cursor: 6,
      state: "applied",
    });
  });

  test("the previous call's tail is the next one's temporary continuity", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 3);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    const carried = await memory.carriedContinuity(read);
    expect(carried).toHaveLength(3);
    const lines = renderVoiceMemoryLinesV1(emptyVoiceMemoryRecordV1(), {
      carried,
    }).join("\n");
    expect(lines).toContain("<last-conversation>");
    expect(lines).toContain("turn 3");
    // Once it is summarised there is nothing left to carry.
    const chunk = await memory.claimChunk({
      callId: "call-1",
      at: new Date(),
      read,
    });
    await memory.applyChunk({
      callId: "call-1",
      chunk: chunk!,
      update: { operations: [], refusals: [], malformed: false },
      at: new Date("2026-09-01T11:05:00.000Z"),
    });
    expect(await memory.carriedContinuity(read)).toEqual([]);
  });

  test("unfinished source is never retired for being old", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    await memory.abandonChunk(
      "call-1",
      "never answered",
      new Date("2026-09-01T11:01:00.000Z"),
    );
    expect(
      await memory.retireJobs(new Date("2027-01-01T00:00:00.000Z")),
    ).toEqual([]);
    expect(await memory.readJob("call-1")).toBeDefined();
    expect(await memory.carriedContinuity(read)).toHaveLength(2);
  });

  test("the request carries the call's own system message and the current ids", async () => {
    const { memory, calls, read } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      system: "the call's last system prompt",
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "short-answers",
          text: "Keep it short.",
          source: "call-1:1",
        },
      ],
      sources: calls["call-1"]!,
      now: new Date("2026-09-01T11:00:00.000Z"),
    });
    const chunk = await memory.claimChunk({
      callId: "call-1",
      at: new Date(),
      read,
    });
    const messages = renderVoiceMemoryRequestMessagesV1({
      system: chunk!.job.system,
      turns: chunk!.turns,
      record: await memory.read(),
      progress: { from: chunk!.from, total: chunk!.total },
    });
    expect(messages[0]).toEqual({
      role: "system",
      content: "the call's last system prompt",
    });
    expect(messages[1]).toEqual({ role: "user", content: "turn 1" });
    const instruction = messages.at(-1)!.content;
    expect(instruction).toContain("[end of conversation]");
    expect(instruction).toContain("call-1:1");
    // What it already remembers, with the ids to correct — read now, not at
    // the call's start.
    expect(instruction).toContain("durable (short-answers) Keep it short.");
  });
});

describe("the order the finalizer is shown", () => {
  test("an earlier turn and a newer correction on the same day are told apart", async () => {
    const { memory, calls, read } = ledger();
    // The first call said something in the morning and its finalization never
    // landed, so its turns are still unread.
    calls["call-1"] = conversation(
      "call-1",
      CALL_ONE,
      1,
      "2026-09-05T09:00:00.000Z",
    );
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-05T09:30:00.000Z"),
    });
    await memory.claimChunk({
      callId: "call-1",
      at: new Date("2026-09-05T09:30:01.000Z"),
      read,
    });
    await memory.abandonChunk(
      "call-1",
      "the connection failed",
      new Date("2026-09-05T09:30:30.000Z"),
    );

    // That same afternoon they correct it in a second call.
    calls["call-2"] = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-05T14:00:00.000Z",
    );
    await memory.apply({
      operations: [
        { kind: "durable/remove", id: "long-answers", source: "call-2:1" },
        {
          kind: "durable/add",
          id: "short-answers",
          text: "Keep answers short.",
          source: "call-2:1",
        },
      ],
      sources: calls["call-2"]!,
      now: new Date("2026-09-05T14:00:00.000Z"),
    });

    await memory.createJob({
      callId: "call-2",
      sequence: CALL_TWO,
      at: new Date("2026-09-05T15:00:00.000Z"),
    });
    const chunk = await memory.claimChunk({
      callId: "call-2",
      at: new Date("2026-09-05T15:00:01.000Z"),
      read,
    });
    const instruction = renderVoiceMemoryRequestMessagesV1({
      turns: chunk!.turns,
      record: await memory.read(),
      progress: { from: chunk!.from, total: chunk!.total },
    }).at(-1)!.content;

    // The carried turn is the morning one; the correction is the afternoon
    // one. On a calendar day alone they are the same date, so the request
    // carries the admission time and the ordering stamp of both.
    expect(instruction).toContain(
      `- call-1:1 [2026-09-05T09:00:00.000Z, call ${CALL_ONE} turn 1]:`,
    );
    expect(instruction).toContain(
      `- call-2:1 [2026-09-05T14:00:00.000Z, call ${CALL_TWO} turn 1]:`,
    );
    expect(instruction).toContain(
      `durable (short-answers) Keep answers short. [said 2026-09-05T14:00:00.000Z, call ${CALL_TWO} turn 1]`,
    );
    expect(instruction).toContain(
      `durable (long-answers) [dropped 2026-09-05T14:00:00.000Z, call ${CALL_TWO} turn 1]`,
    );
  });
});

describe("where the removal fences are kept", () => {
  /** Every fence record stored, and how much of it the memory record holds. */
  async function fences(storage: ReturnType<typeof ledger>["storage"]) {
    const kept = [...storage.entries.entries()].filter(([key]) =>
      key.startsWith(VOICE_MEMORY_FORGOTTEN_PREFIX_V1),
    );
    return {
      keys: kept.map(([key]) => key),
      recordHolds: (
        (
          storage.entries.get(VOICE_MEMORY_RECORD_KEY_V1) as
            VoiceMemoryRecordV1 | undefined
        )?.forgotten ?? []
      ).length,
    };
  }

  /**
   * A backlog of protected fences: one call ends and its finalization keeps
   * failing, so every removal after it is at or past the unread fence and
   * none can be pruned.
   */
  async function backlog(count: number) {
    const context = ledger();
    const { memory, calls, read } = context;
    calls["call-1"] = conversation("call-1", CALL_ONE, 1);
    await memory.createJob({
      callId: "call-1",
      sequence: CALL_ONE,
      at: new Date("2026-09-01T11:00:00.000Z"),
    });
    await memory.claimChunk({
      callId: "call-1",
      at: new Date("2026-09-01T11:00:02.000Z"),
      read,
    });
    await memory.abandonChunk(
      "call-1",
      "the model gateway is down",
      new Date("2026-09-01T11:00:30.000Z"),
    );
    const later = conversation(
      "call-2",
      CALL_TWO,
      count,
      "2026-09-05T10:00:00.000Z",
    );
    calls["call-2"] = later;
    for (const source of later) {
      await memory.apply({
        operations: [
          {
            kind: "durable/remove",
            id: `fact-${source.ordinal}`,
            source: source.id,
          },
        ],
        sources: [source],
        now: new Date(source.at),
      });
    }
    return { ...context, later };
  }

  test("a backlog no value could hold is still written, and still fences", async () => {
    const wanted = VOICE_MEMORY_MAX_TOMBSTONES_V1 + 60;
    const { memory, storage, later } = await backlog(wanted);
    const record = await memory.read();
    // Nothing was dropped: every one of these fences sits at or after the
    // unread call, so the soft count does not apply to any of them.
    expect(record.forgotten).toHaveLength(wanted);
    const stored = await fences(storage);
    expect(stored.recordHolds).toBe(0);
    // One record per fenced fact, so no single value grows with the backlog.
    expect(stored.keys).toHaveLength(wanted);

    // Memory is not locked out: another write lands normally.
    const next = later.at(-1)!;
    const after = await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: next.id,
        },
      ],
      sources: [next],
      now: new Date(next.at),
    });
    expect(after.record.durable.map((entry) => entry.id)).toEqual([
      "flat-whites",
    ]);

    // And the oldest fence in the backlog still refuses a stale summary.
    const stale = await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "fact-1",
          text: "Fact one.",
          source: "call-1:1",
        },
      ],
      sources: [turn({ at: "2026-09-01T10:00:00.000Z" })],
      now: new Date("2026-09-06T10:00:00.000Z"),
    });
    expect(stale.record.durable.map((entry) => entry.id)).toEqual([
      "flat-whites",
    ]);
    expect(stale.skipped.join(" ")).toContain("dropped more recently");
  });

  test("a fence outlives the write it was part of failing", async () => {
    const { memory, storage, calls } = ledger();
    calls["call-1"] = conversation("call-1", CALL_ONE, 2);
    const [said, took] = calls["call-1"]!;
    await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: said!.id,
        },
      ],
      sources: [said!],
      now: new Date(said!.at),
    });

    // The removal's fence is written, and then the record put fails.
    const put = storage.put;
    storage.put = async (key: string, value: unknown) => {
      if (key === VOICE_MEMORY_RECORD_KEY_V1) throw new Error("storage full");
      return put(key, value);
    };
    await expect(
      memory.apply({
        operations: [
          { kind: "durable/remove", id: "flat-whites", source: took!.id },
        ],
        sources: [took!],
        now: new Date(took!.at),
      }),
    ).rejects.toThrow("storage full");
    storage.put = put;

    // The entry is still there — the person hears that it failed and says it
    // again — but the fence survived, so the recovery is a repeat and not a
    // resurrection.
    const recovered = await memory.read();
    expect(recovered.durable.map((entry) => entry.id)).toEqual(["flat-whites"]);
    expect(recovered.forgotten).toHaveLength(1);
    const again = await memory.apply({
      operations: [
        { kind: "durable/remove", id: "flat-whites", source: took!.id },
      ],
      sources: [took!],
      now: new Date(took!.at),
    });
    expect(again.record.durable).toEqual([]);

    // A later summary of the conversation that stated it is still refused.
    const stale = await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "flat-whites",
          text: "Drinks flat whites.",
          source: said!.id,
        },
      ],
      sources: [said!],
      now: new Date("2026-09-02T10:00:00.000Z"),
    });
    expect(stale.record.durable).toEqual([]);
    expect(stale.skipped.join(" ")).toContain("dropped more recently");
  });

  test("a failed write cannot destroy a fence already committed", async () => {
    const { memory, storage } = await backlog(60);
    const before = await memory.read();
    expect(before.forgotten).toHaveLength(60);

    // A newer removal of the first fact, alongside two the record has never
    // fenced, and the second fence write of that batch fails.
    const next = conversation("call-3", 3_000, 3, "2026-09-06T10:00:00.000Z");
    const put = storage.put;
    let fenceWrites = 0;
    storage.put = async (key: string, value: unknown) => {
      if (key.startsWith(VOICE_MEMORY_FORGOTTEN_PREFIX_V1)) {
        fenceWrites += 1;
        if (fenceWrites === 2) throw new Error("storage full");
      }
      return put(key, value);
    };
    await expect(
      memory.apply({
        operations: next.map((source, index) => ({
          kind: "durable/remove" as const,
          id: index === 0 ? "fact-1" : `late-${index}`,
          source: source.id,
        })),
        sources: next,
        now: new Date(next[0]!.at),
      }),
    ).rejects.toThrow("storage full");
    storage.put = put;

    // Every fence that was on record before the failed write is still on
    // record: the earliest fact of the backlog cannot come back.
    const after = await memory.read();
    const fenced = new Set(after.forgotten.map((fence) => fence.id));
    for (const fence of before.forgotten)
      expect(fenced.has(fence.id)).toBe(true);

    // And the fence for the first fact still refuses the stale summary of the
    // conversation that stated it.
    const stale = await memory.apply({
      operations: [
        {
          kind: "durable/add",
          id: "fact-1",
          text: "Fact one.",
          source: "call-1:1",
        },
      ],
      sources: [turn({ at: "2026-09-01T10:00:00.000Z" })],
      now: new Date("2026-09-06T12:00:00.000Z"),
    });
    expect(stale.record.durable).toEqual([]);
    expect(stale.skipped.join(" ")).toContain("dropped more recently");
  });

  test("fences pruned by the count leave no record behind", async () => {
    const { memory, storage, calls } = ledger();
    const turns = conversation(
      "call-1",
      CALL_ONE,
      VOICE_MEMORY_MAX_TOMBSTONES_V1 + 30,
      "2026-09-06T10:00:00.000Z",
    );
    calls["call-1"] = turns;
    // No unread source at all, so the soft count applies to every fence.
    await memory.apply({
      operations: turns.map((source) => ({
        kind: "durable/remove" as const,
        id: `fact-${source.ordinal}`,
        source: source.id,
      })),
      sources: turns,
      now: new Date("2026-09-06T12:00:00.000Z"),
    });
    // The next conversation is where the count is finally applied: nothing
    // before it is unread, so those fences are all disposable.
    const next = conversation(
      "call-2",
      CALL_TWO,
      1,
      "2026-09-07T10:00:00.000Z",
    );
    await memory.apply({
      operations: [
        { kind: "durable/remove", id: "anything", source: next[0]!.id },
      ],
      sources: next,
      now: new Date("2026-09-07T10:00:00.000Z"),
    });
    expect((await memory.read()).forgotten).toHaveLength(
      VOICE_MEMORY_MAX_TOMBSTONES_V1,
    );
    const stored = await fences(storage);
    expect(stored.keys).toHaveLength(VOICE_MEMORY_MAX_TOMBSTONES_V1);
  });
});

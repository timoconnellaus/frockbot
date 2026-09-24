import { describe, expect, test } from "bun:test";
import type { ToolInputDispatchV1 } from "@frockbot/core/agent-loop/agent";
import {
  createReplyDraftWatchV1,
  readPartialJsonV1,
  REPLY_DRAFT_INPUT_MAX_CHARS_V1,
  replyDraftPartsV1,
  type ReplyDraftV1,
} from "./reply-draft.js";

/** Every prefix of `text`, the way a stream could have cut it. */
function prefixes(text: string): string[] {
  return Array.from({ length: text.length + 1 }, (_, end) =>
    text.slice(0, end),
  );
}

describe("readPartialJsonV1", () => {
  test("reads a whole value exactly as JSON.parse does", () => {
    const value = {
      disposition: "finish",
      payload: { type: "text", text: 'Quote " slash \\ tab \t ☃ 😀' },
      n: [1, -2.5e3, true, false, null],
    };
    expect(readPartialJsonV1(JSON.stringify(value))).toEqual(value);
  });

  test("a string cut short is its words so far", () => {
    expect(readPartialJsonV1('{"payload":{"type":"text","text":"Hel')).toEqual({
      payload: { type: "text", text: "Hel" },
    });
  });

  test("an escape still arriving is left out, not guessed", () => {
    expect(readPartialJsonV1('{"text":"a\\')).toEqual({ text: "a" });
    expect(readPartialJsonV1('{"text":"a\\u26')).toEqual({ text: "a" });
    expect(readPartialJsonV1('{"text":"a\\u2603')).toEqual({ text: "a☃" });
    expect(readPartialJsonV1('{"text":"a\\nb')).toEqual({ text: "a\nb" });
  });

  test("half a surrogate pair is never drawn", () => {
    const whole = JSON.stringify({ text: "hi 😀" }).replace(
      "😀",
      "\\ud83d\\ude00",
    );
    for (const prefix of prefixes(whole)) {
      const text = (readPartialJsonV1(prefix) as { text?: string } | undefined)
        ?.text;
      if (text === undefined) continue;
      expect(text === "hi " || text === "hi 😀" || "hi ".startsWith(text)).toBe(
        true,
      );
    }
    expect(readPartialJsonV1('{"text":"x\ud83d')).toEqual({ text: "x" });
  });

  test("a key without its value, or a number that may grow, is left out", () => {
    expect(readPartialJsonV1('{"a":1,"b"')).toEqual({ a: 1 });
    expect(readPartialJsonV1('{"a":1,"b":')).toEqual({ a: 1 });
    expect(readPartialJsonV1('{"a":12')).toEqual({});
    expect(readPartialJsonV1('{"a":tru')).toEqual({});
    expect(readPartialJsonV1('{"a":[1,2')).toEqual({ a: [1] });
    expect(readPartialJsonV1("")).toBeUndefined();
  });

  test("every prefix of a reply reads as a prefix of its text", () => {
    const text = 'Line one.\n\nLine "two" — with \\ and ☃.';
    const whole = JSON.stringify({
      disposition: "finish",
      payload: { type: "text", text },
    });
    let longest = "";
    for (const prefix of prefixes(whole)) {
      const [part = ""] = replyDraftPartsV1([
        { name: "send_to_user", input: prefix },
      ]);
      expect(text.startsWith(part)).toBe(true);
      expect(part.length).toBeGreaterThanOrEqual(longest.length);
      longest = part;
    }
    expect(longest).toBe(text);
  });
});

describe("replyDraftPartsV1", () => {
  test("a send's text, whichever order its keys are written in", () => {
    expect(
      replyDraftPartsV1([
        {
          name: "send_to_user",
          input: '{"disposition":"finish","payload":{"type":"text","text":"Hi',
        },
      ]),
    ).toEqual(["Hi"]);
    expect(
      replyDraftPartsV1([
        {
          name: "send_to_user",
          input: '{"payload":{"text":"Hi there","type":"te',
        },
      ]),
    ).toEqual([]);
    expect(
      replyDraftPartsV1([
        { name: "send_to_user", input: '{"payload":{"text":"Hi there' },
      ]),
    ).toEqual(["Hi there"]);
  });

  test("a send that is not text holds its place and draws nothing", () => {
    expect(
      replyDraftPartsV1([
        {
          name: "send_to_user",
          input:
            '{"disposition":"continue","payload":{"type":"card","surfaceId":"s"}}',
        },
        {
          name: "send_to_user",
          input: '{"payload":{"type":"text","text":"After the card',
        },
      ]),
    ).toEqual(["", "After the card"]);
  });

  test("other tools are not sends and take no place", () => {
    expect(
      replyDraftPartsV1([
        { name: "web_search", input: '{"query":"weather"}' },
        {
          name: "send_to_user",
          input: '{"payload":{"type":"text","text":"Looking',
        },
      ]),
    ).toEqual(["Looking"]);
  });

  test("a batch's sends, in declared order, around its other calls", () => {
    const batch = JSON.stringify({
      calls: [
        {
          tool: "send_to_user",
          arguments: {
            disposition: "continue",
            payload: { type: "text", text: "First." },
          },
        },
        { tool: "web_search", arguments: { query: "x" } },
        {
          tool: "send_to_user",
          arguments: {
            disposition: "finish",
            payload: { type: "text", text: "Second, still going" },
          },
        },
      ],
    });
    expect(
      replyDraftPartsV1([{ name: "batch", input: batch.slice(0, -7) }]),
    ).toEqual(["First.", "Second, still goin"]);
  });

  test("a batch call still writing its name ends the reading", () => {
    const head =
      '{"calls":[{"tool":"send_to_user","arguments":{"payload":{"type":"text","text":"One"}}},';
    expect(
      replyDraftPartsV1([
        {
          name: "batch",
          input: `${head}{"arguments":{"payload":{"type":"text","text":"Two`,
        },
      ]),
    ).toEqual(["One"]);
    expect(
      replyDraftPartsV1([
        {
          name: "batch",
          input: `${head}{"tool":"send_to_u`,
        },
      ]),
    ).toEqual(["One"]);
    expect(
      replyDraftPartsV1([
        {
          name: "batch",
          input: `${head}{"tool":"send_to_user","arguments":{"payload":{"type":"text","text":"Two`,
        },
      ]),
    ).toEqual(["One", "Two"]);
  });

  test("a send not yet begun is not a part yet", () => {
    expect(
      replyDraftPartsV1([
        {
          name: "send_to_user",
          input: '{"payload":{"type":"text","text":"Done"}}',
        },
        { name: "send_to_user", input: '{"disposition":"fin' },
      ]),
    ).toEqual(["Done"]);
  });
});

function dispatch(requestId: string, sends = 0, step = 1): ToolInputDispatchV1 {
  return {
    requestId,
    turn: 1,
    step,
    journal: Array.from({ length: sends }, () => ({
      type: "send/to-user" as const,
      turn: 1,
      step: 1,
      occurrenceId: "o",
      payload: { type: "text" as const, text: "earlier" },
      seq: 0,
      timestamp: "2026-09-24T00:00:00.000Z",
    })),
  } as unknown as ToolInputDispatchV1;
}

function harness() {
  let clock = 0;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const drafts: ReplyDraftV1[] = [];
  const watch = createReplyDraftWatchV1({
    runId: "run-1",
    publish: (draft) => drafts.push(structuredClone(draft)),
    now: () => clock,
    setTimer: (run, ms) => {
      const timer = { at: clock + ms, run, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  });
  return {
    watch,
    drafts,
    advance(ms: number) {
      clock += ms;
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue;
        if (timer.at <= clock) timer.run();
        else timers.push(timer);
      }
    },
  };
}

const call = { id: "call-1", name: "send_to_user" };

describe("createReplyDraftWatchV1", () => {
  test("draws at once, then at most once an interval, then on the end", () => {
    const { watch, drafts, advance } = harness();
    const opened = watch(dispatch("request-1", 2));
    opened.delta(call, '{"payload":{"type":"text","text":"He');
    expect(drafts).toEqual([{ runId: "run-1", ordinal: 2, parts: ["He"] }]);

    advance(10);
    opened.delta(call, "llo");
    advance(10);
    opened.delta(call, " the");
    expect(drafts).toHaveLength(1);

    advance(80);
    expect(drafts.at(-1)).toEqual({
      runId: "run-1",
      ordinal: 2,
      parts: ["Hello the"],
    });

    opened.delta(call, "re");
    opened.end();
    expect(drafts.at(-1)?.parts).toEqual(["Hello there"]);
    expect(drafts).toHaveLength(3);

    // Nothing is drawn after the end, whatever the clock does.
    advance(1_000);
    expect(drafts).toHaveLength(3);
  });

  test("a tool that is not a send never draws", () => {
    const { watch, drafts } = harness();
    const opened = watch(dispatch("request-1"));
    opened.delta({ id: "call-1", name: "web_search" }, '{"query":"weather"}');
    opened.end();
    expect(drafts).toEqual([]);
  });

  test("the next dispatch clears what the last one drew", () => {
    const { watch, drafts } = harness();
    const first = watch(dispatch("request-1"));
    first.delta(call, '{"payload":{"type":"text","text":"Maybe"');
    first.end();
    expect(drafts).toEqual([{ runId: "run-1", ordinal: 0, parts: ["Maybe"] }]);

    // The step's send was refused, so nothing landed at ordinal 0.
    watch(dispatch("request-2", 0, 2)).end();
    expect(drafts.at(-1)).toEqual({ runId: "run-1", ordinal: 0, parts: [] });

    // A dispatch after one that drew nothing says nothing at all.
    watch(dispatch("request-3", 0, 3)).end();
    expect(drafts).toHaveLength(2);
  });

  test("the ordinal is the run's sends when the dispatch began", () => {
    const { watch, drafts } = harness();
    const journal = dispatch("request-1", 1);
    const opened = watch(journal);
    (journal.journal as unknown[]).push(journal.journal[0]);
    opened.delta(call, '{"payload":{"type":"text","text":"x"');
    opened.end();
    expect(drafts[0]?.ordinal).toBe(1);
  });

  test("a dispatch past the input bound stops drawing and stays quiet", () => {
    const { watch, drafts, advance } = harness();
    const opened = watch(dispatch("request-1"));
    opened.delta(call, '{"payload":{"type":"text","text":"');
    opened.delta(call, "a".repeat(10));
    advance(200);
    const drawn = drafts.length;
    opened.delta(call, "a".repeat(REPLY_DRAFT_INPUT_MAX_CHARS_V1));
    advance(200);
    opened.end();
    expect(drafts).toHaveLength(drawn);
  });
});

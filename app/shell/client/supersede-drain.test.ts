import { describe, expect, test } from "bun:test";
import {
  SUPERSEDE_DRAIN_LABEL_V1,
  SUPERSEDE_DRAIN_SLOW_AFTER_MS_V1,
  SUPERSEDE_DRAIN_SLOW_LABEL_V1,
  supersedeDrainLabelV1,
  supersedeDrainStateV1,
  type SupersedeDrainMessageV1,
} from "./supersede-drain.ts";

const SENT_AT = "2026-09-05T00:00:00.000Z";
const SENT = Date.parse(SENT_AT);

/** The thread the moment a message is sent into a Turn that is still running. */
function draining(): SupersedeDrainMessageV1[] {
  return [
    { role: "user", status: "completed", at: "2026-09-04T23:59:00.000Z" },
    // The Turn being displaced: still streaming, and not waiting on anything.
    { role: "assistant", status: "streaming", at: "2026-09-04T23:59:00.000Z" },
    { role: "user", status: "completed", pending: true, at: SENT_AT },
    { role: "assistant", status: "streaming", pending: true, at: SENT_AT },
  ];
}

describe("the working row while a supersede drains", () => {
  test("says the previous reply is being stopped", () => {
    const state = supersedeDrainStateV1({ messages: draining(), now: SENT });

    expect(state).toBe("stopping");
    expect(supersedeDrainLabelV1(state)).toBe(SUPERSEDE_DRAIN_LABEL_V1);
  });

  test("keeps saying it, differently, once the drain runs long", () => {
    const state = supersedeDrainStateV1({
      messages: draining(),
      now: SENT + SUPERSEDE_DRAIN_SLOW_AFTER_MS_V1,
    });

    expect(state).toBe("slow");
    expect(supersedeDrainLabelV1(state)).toBe(SUPERSEDE_DRAIN_SLOW_LABEL_V1);
  });

  test("still says the first thing a moment before the bound", () => {
    expect(
      supersedeDrainStateV1({
        messages: draining(),
        now: SENT + SUPERSEDE_DRAIN_SLOW_AFTER_MS_V1 - 1,
      }),
    ).toBe("stopping");
  });

  // The transition the person is waiting for: the Turn they replaced settles,
  // theirs is admitted, and the row goes back to being an ordinary working row.
  test("says nothing once the new Turn has started", () => {
    const started = draining().map((message) =>
      message.pending ? { ...message, pending: false } : message,
    );
    // The displaced Turn is gone from the thread by then, settled.
    const messages = started.filter(
      (message, index) => !(index === 1 && message.role === "assistant"),
    );

    const state = supersedeDrainStateV1({ messages, now: SENT + 1000 });

    expect(state).toBe("none");
    expect(supersedeDrainLabelV1(state)).toBeUndefined();
  });

  test("says nothing about an ordinary running Turn", () => {
    expect(
      supersedeDrainStateV1({
        messages: [
          { role: "user", status: "completed", at: SENT_AT },
          { role: "assistant", status: "streaming", at: SENT_AT },
        ],
        now: SENT + 60_000,
      }),
    ).toBe("none");
  });

  test("says nothing when there is no Turn at all", () => {
    expect(supersedeDrainStateV1({ messages: [], now: SENT })).toBe("none");
  });

  // A settled line that somehow kept the flag is not a drain: only a Turn that
  // has not started is waiting on the one before it.
  test("ignores a pending line whose Turn has already ended", () => {
    expect(
      supersedeDrainStateV1({
        messages: [
          {
            role: "assistant",
            status: "completed",
            pending: true,
            at: SENT_AT,
          },
        ],
        now: SENT,
      }),
    ).toBe("none");
  });

  test("shows the ordinary wording when the line carries no time", () => {
    expect(
      supersedeDrainStateV1({
        messages: [{ role: "assistant", status: "streaming", pending: true }],
        now: SENT,
      }),
    ).toBe("stopping");
  });
});

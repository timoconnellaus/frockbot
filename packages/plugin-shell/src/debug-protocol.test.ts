import { describe, expect, test } from "bun:test";
import {
  BOT_DEBUG_RUN_LIMIT_V1,
  boundDebugEventsV1,
  decodeBotDebugQueryV1,
} from "./debug-protocol.js";

describe("debug query", () => {
  test("accepts the empty query", () => {
    expect(decodeBotDebugQueryV1({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
    });
  });

  test("carries a run lookup, a page bound, a cursor, and an events flag", () => {
    expect(
      decodeBotDebugQueryV1({
        schemaVersion: 1,
        runId: "run-1",
        limit: 3,
        before: "run-index:2026-08-28T00:00:00.000Z:run-0",
        events: true,
      }),
    ).toEqual({
      schemaVersion: 1,
      runId: "run-1",
      limit: 3,
      before: "run-index:2026-08-28T00:00:00.000Z:run-0",
      events: true,
    });
  });

  test("rejects an unknown field", () => {
    expect(() =>
      decodeBotDebugQueryV1({ schemaVersion: 1, sql: "select 1" }),
    ).toThrow("debug query has invalid fields");
  });

  test("rejects a limit past the page bound", () => {
    expect(() =>
      decodeBotDebugQueryV1({
        schemaVersion: 1,
        limit: BOT_DEBUG_RUN_LIMIT_V1 + 1,
      }),
    ).toThrow("debug query limit is invalid");
  });

  test("rejects a wrong schema version", () => {
    expect(() => decodeBotDebugQueryV1({ schemaVersion: 2 })).toThrow(
      "debug query schemaVersion is invalid",
    );
  });
});

describe("event bounding", () => {
  test("keeps everything inside the budget", () => {
    const events = [{ seq: 1 }, { seq: 2 }];
    expect(boundDebugEventsV1(events, 1_000)).toMatchObject({
      events,
      omittedEvents: 0,
    });
  });

  test("drops the oldest events, because a failure is described by the tail", () => {
    const events = [{ seq: 1 }, { seq: 2 }, { seq: 3 }];
    const size = new TextEncoder().encode(JSON.stringify(events[0])).byteLength;
    const bounded = boundDebugEventsV1(events, size * 2);

    expect(bounded.events).toEqual([{ seq: 2 }, { seq: 3 }]);
    expect(bounded.omittedEvents).toBe(1);
  });

  test("keeps the newest event even when it alone exceeds the budget", () => {
    const events = [{ seq: 1 }, { seq: 2 }];
    const bounded = boundDebugEventsV1(events, 1);

    expect(bounded.events).toEqual([{ seq: 2 }]);
    expect(bounded.omittedEvents).toBe(1);
  });
});

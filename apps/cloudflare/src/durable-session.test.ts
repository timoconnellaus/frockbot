import { describe, expect, test } from "bun:test";
import { type SessionEvent } from "@frockbot/kernel-contracts";
import { appendedSessionEvents } from "./durable-session.js";

const created: SessionEvent = {
  type: "session/created",
  createdAt: "2026-08-27T00:00:00.000Z",
  seq: 0,
  timestamp: "2026-08-27T00:00:00.000Z",
};
const turnStart: SessionEvent = {
  type: "turn/start",
  turn: 1,
  seq: 1,
  timestamp: "2026-08-27T00:00:01.000Z",
};

describe("durable session history", () => {
  test("returns only events appended to an unchanged history", () => {
    expect(appendedSessionEvents([created], [created, turnStart])).toEqual([
      turnStart,
    ]);
  });

  test("rejects truncation and mutation of durable history", () => {
    expect(() => appendedSessionEvents([created], [])).toThrow(
      "changed durable session history",
    );
    expect(() =>
      appendedSessionEvents(
        [created],
        [{ ...created, createdAt: "changed" }, turnStart],
      ),
    ).toThrow("changed durable session history");
  });
});

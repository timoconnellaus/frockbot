import { describe, expect, test } from "bun:test";
import {
  decodeBotStateChannelFrameV1,
  decodeBotStateCursorV1,
} from "./index.js";

describe("Bot-state channel protocol", () => {
  test("decodes each exact version 1 frame", () => {
    expect(
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/event",
          cursor: "12",
          topic: "computer",
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      type: "state/event",
      cursor: "12",
      topic: "computer",
    });
    expect(
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/reset",
          cursor: "4",
          reason: "gap",
        }),
      ),
    ).toMatchObject({ type: "state/reset", reason: "gap" });
    expect(
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/ready",
          cursor: "0",
        }),
      ),
    ).toMatchObject({ type: "state/ready", cursor: "0" });
  });

  test("rejects non-canonical cursors and protocol extensions", () => {
    for (const cursor of ["", "01", "-1", "1.5", "9007199254740992"]) {
      expect(() => decodeBotStateCursorV1(cursor)).toThrow();
    }
    expect(() =>
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/ready",
          cursor: "0",
          extra: true,
        }),
      ),
    ).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import {
  decodeBotStateChannelFrameV1,
  decodeBotStateCursorV1,
} from "./index.js";

describe("Bot-state channel protocol", () => {
  test("decodes each committed-update frame", () => {
    expect(
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/update",
          epoch: "1",
          cursor: "12",
          kind: "computer",
          entityId: "computer",
          revision: 12,
          payload: {},
        }),
      ),
    ).toMatchObject({
      type: "state/update",
      kind: "computer",
      cursor: "12",
    });
    expect(
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/snapshot",
          epoch: "1",
          cursor: "4",
          reason: "gap",
          conversation: {
            schemaVersion: 1,
            runs: [],
            page: { truncated: false },
          },
        }),
      ),
    ).toMatchObject({ type: "state/snapshot", reason: "gap" });
    expect(
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/part",
          epoch: "1",
          cursor: "9",
          eventId: "1:9",
          part: 0,
          parts: 2,
          data: "abc",
        }),
      ),
    ).toMatchObject({ type: "state/part", part: 0, parts: 2 });
  });

  test("rejects non-canonical cursors, superseded invalidations, and extras", () => {
    for (const cursor of ["", "01", "-1", "1.5", "9007199254740992"]) {
      expect(() => decodeBotStateCursorV1(cursor)).toThrow();
    }
    expect(() =>
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/event",
          cursor: "1",
          topic: "runs",
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeBotStateChannelFrameV1(
        JSON.stringify({
          schemaVersion: 1,
          type: "state/ready",
          epoch: "1",
          cursor: "0",
          extra: true,
        }),
      ),
    ).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import {
  advanceChannelReadCursorV1,
  channelReadCommandFingerprintV1,
  decodeChannelReadCommandV1,
  decodeChannelReadCursorV1,
  decodeChannelUnreadDirectoryViewV1,
  projectChannelUnreadViewV1,
  CHANNEL_UNREAD_COUNT_CAP,
} from "./unread.js";

function messages(count: number, from = 0) {
  return Array.from({ length: count }, (_, index) => ({
    seq: from + index,
    at: `2026-09-01T00:00:00.00${index % 10}Z`,
    messageId: `cm-${from + index}`,
  }));
}

describe("Channel read cursor", () => {
  test("records the first read", () => {
    expect(
      advanceChannelReadCursorV1(undefined, {
        channelId: "room",
        upToSeq: 3,
        at: "2026-09-01T00:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: 1,
      channelId: "room",
      lastReadSeq: 3,
      at: "2026-09-01T00:00:00.000Z",
    });
  });

  test("is monotonic: an older position leaves the record untouched", () => {
    const current = advanceChannelReadCursorV1(undefined, {
      channelId: "room",
      upToSeq: 5,
      at: "2026-09-01T00:00:00.000Z",
    });

    expect(
      advanceChannelReadCursorV1(current, {
        channelId: "room",
        upToSeq: 2,
        at: "2026-09-01T00:01:00.000Z",
      }),
    ).toBe(current);
    expect(
      advanceChannelReadCursorV1(current, {
        channelId: "room",
        upToSeq: 5,
        at: "2026-09-01T00:01:00.000Z",
      }),
    ).toBe(current);
  });

  test("round-trips through its codec", () => {
    const cursor = advanceChannelReadCursorV1(undefined, {
      channelId: "room",
      upToSeq: 7,
      at: "2026-09-01T00:00:00.000Z",
    });

    expect(decodeChannelReadCursorV1(cursor)).toEqual(cursor);
  });

  test("refuses a record carrying an unknown field", () => {
    expect(() =>
      decodeChannelReadCursorV1({
        schemaVersion: 1,
        channelId: "room",
        lastReadSeq: 1,
        at: "2026-09-01T00:00:00.000Z",
        extra: true,
      }),
    ).toThrow();
  });
});

describe("Channel unread projection", () => {
  test("counts every message above the read position", () => {
    const view = projectChannelUnreadViewV1("room", {
      messages: messages(5),
      cursor: {
        schemaVersion: 1,
        channelId: "room",
        lastReadSeq: 2,
        at: "2026-09-01T00:00:00.000Z",
      },
    });

    expect(view.count).toBe(2);
    expect(view.unread).toBe(true);
    expect(view.lastSeq).toBe(4);
    expect(view.lastReadSeq).toBe(2);
  });

  test("counts everything when nothing was ever read", () => {
    expect(
      projectChannelUnreadViewV1("room", { messages: messages(3) }).count,
    ).toBe(3);
  });

  test("reads as read when the position is at the end", () => {
    const view = projectChannelUnreadViewV1("room", {
      messages: messages(3),
      cursor: {
        schemaVersion: 1,
        channelId: "room",
        lastReadSeq: 2,
        at: "2026-09-01T00:00:00.000Z",
      },
    });

    expect(view.count).toBe(0);
    expect(view.unread).toBe(false);
  });

  test("a delivery still pending keeps the row unread past the position", () => {
    const view = projectChannelUnreadViewV1("room", {
      messages: messages(3),
      pendingMessageIds: ["cm-2"],
      cursor: {
        schemaVersion: 1,
        channelId: "room",
        lastReadSeq: 2,
        at: "2026-09-01T00:00:00.000Z",
      },
    });

    expect(view.count).toBe(0);
    expect(view.pending).toBe(true);
    expect(view.unread).toBe(true);
  });

  test("caps the count and says it capped", () => {
    const view = projectChannelUnreadViewV1("room", {
      messages: messages(CHANNEL_UNREAD_COUNT_CAP + 5),
    });

    expect(view.count).toBe(CHANNEL_UNREAD_COUNT_CAP);
    expect(view.capped).toBe(true);
  });

  test("an empty room names no position to read up to", () => {
    const view = projectChannelUnreadViewV1("room", { messages: [] });

    expect(view.unread).toBe(false);
    expect(view.lastSeq).toBeUndefined();
  });

  test("round-trips through the directory codec", () => {
    const directory = {
      schemaVersion: 1 as const,
      botId: "alpha",
      unread: [projectChannelUnreadViewV1("room", { messages: messages(2) })],
    };

    expect(decodeChannelUnreadDirectoryViewV1(directory)).toEqual(directory);
  });
});

describe("Channel read command", () => {
  test("decodes and fingerprints without its idempotency key", () => {
    const command = decodeChannelReadCommandV1({
      schemaVersion: 1,
      type: "channel/mark-read",
      commandId: "one",
      channelId: "room",
      upToSeq: 4,
    });

    expect(command.upToSeq).toBe(4);
    expect(channelReadCommandFingerprintV1(command)).toBe(
      channelReadCommandFingerprintV1({ ...command, commandId: "two" }),
    );
    expect(channelReadCommandFingerprintV1(command)).not.toBe(
      channelReadCommandFingerprintV1({ ...command, upToSeq: 5 }),
    );
  });

  test("refuses another command family and a negative position", () => {
    expect(() =>
      decodeChannelReadCommandV1({
        schemaVersion: 1,
        type: "channel/post",
        commandId: "one",
        channelId: "room",
        upToSeq: 1,
      }),
    ).toThrow();
    expect(() =>
      decodeChannelReadCommandV1({
        schemaVersion: 1,
        type: "channel/mark-read",
        commandId: "one",
        channelId: "room",
        upToSeq: -1,
      }),
    ).toThrow();
  });
});

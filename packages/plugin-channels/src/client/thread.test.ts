import { describe, expect, test } from "bun:test";
import {
  foldChannelReactionsV1,
  projectChannelMembersV1,
  projectChannelThreadV1,
} from "./thread.js";
import type { ChannelMessageViewV1 } from "../shared.js";

function message(
  seq: number,
  sender: { botId?: string; peer?: string },
  overrides: Partial<ChannelMessageViewV1> = {},
): ChannelMessageViewV1 {
  return {
    schemaVersion: 1,
    messageId: `cm-${seq}`,
    channelId: "room",
    seq,
    text: `message ${seq}`,
    hop: 1,
    at: `2026-09-01T00:00:0${seq}.000Z`,
    reactions: [],
    ...(sender.botId === undefined ? {} : { senderBotId: sender.botId }),
    ...(sender.peer === undefined ? {} : { senderPeer: sender.peer }),
    ...overrides,
  };
}

describe("Channel thread grouping", () => {
  test("draws consecutive messages from one sender under one avatar", () => {
    const groups = projectChannelThreadV1([
      message(0, { botId: "alpha" }),
      message(1, { botId: "alpha" }),
      message(2, { botId: "beta" }),
    ]);

    expect(groups.map((group) => group.senderBotId)).toEqual(["alpha", "beta"]);
    expect(groups[0]!.messages.map((entry) => entry.seq)).toEqual([0, 1]);
  });

  test("a reply in between breaks a sender's run rather than merging it", () => {
    const groups = projectChannelThreadV1([
      message(0, { botId: "alpha" }),
      message(1, { botId: "beta" }),
      message(2, { botId: "alpha" }),
    ]);

    expect(groups).toHaveLength(3);
  });

  test("orders by seq, not by the order the log was handed over", () => {
    const groups = projectChannelThreadV1([
      message(2, { botId: "beta" }),
      message(0, { botId: "alpha" }),
      message(1, { botId: "alpha" }),
    ]);

    expect(groups[0]!.messages.map((entry) => entry.seq)).toEqual([0, 1]);
    expect(groups[1]!.senderBotId).toBe("beta");
  });

  test("a peer's messages group under the peer, not under a Bot", () => {
    const groups = projectChannelThreadV1([
      message(0, { peer: "you" }),
      message(1, { peer: "you" }),
      message(2, { botId: "alpha" }),
    ]);

    expect(groups[0]!.senderPeer).toBe("you");
    expect(groups[0]!.senderBotId).toBeUndefined();
    expect(groups[0]!.messages).toHaveLength(2);
  });

  test("marks the viewing member's own bubbles", () => {
    const groups = projectChannelThreadV1(
      [message(0, { botId: "alpha" }), message(1, { botId: "beta" })],
      { selfBotId: "alpha" },
    );

    expect(groups.map((group) => group.mine)).toEqual([true, false]);
  });
});

describe("Channel unread seq", () => {
  test("puts the divider above the first message past the read position", () => {
    const groups = projectChannelThreadV1(
      [
        message(0, { botId: "alpha" }),
        message(1, { botId: "beta" }),
        message(2, { botId: "beta" }),
      ],
      { lastReadSeq: 0 },
    );

    expect(groups.map((group) => group.firstUnread)).toEqual([false, true]);
  });

  test("splits a sender's run so the divider never falls inside one", () => {
    const groups = projectChannelThreadV1(
      [
        message(0, { botId: "alpha" }),
        message(1, { botId: "alpha" }),
        message(2, { botId: "alpha" }),
      ],
      { lastReadSeq: 0 },
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]!.messages.map((entry) => entry.seq)).toEqual([0]);
    expect(groups[1]!.firstUnread).toBe(true);
  });

  test("draws no divider when the read position is at the end", () => {
    const groups = projectChannelThreadV1(
      [message(0, { botId: "alpha" }), message(1, { botId: "beta" })],
      { lastReadSeq: 1 },
    );

    expect(groups.some((group) => group.firstUnread)).toBe(false);
  });

  test("draws no divider when nothing was ever read", () => {
    const groups = projectChannelThreadV1([message(0, { botId: "alpha" })]);

    expect(groups[0]!.firstUnread).toBe(false);
  });
});

describe("Channel reaction folding", () => {
  test("folds one emoji from several senders into one chip", () => {
    const chips = foldChannelReactionsV1([
      { emoji: "👍", botId: "alpha" },
      { emoji: "👍", botId: "beta" },
      { emoji: "🎉", botId: "beta" },
    ]);

    expect(chips).toEqual([
      { emoji: "👍", count: 2, botIds: ["alpha", "beta"], mine: false },
      { emoji: "🎉", count: 1, botIds: ["beta"], mine: false },
    ]);
  });

  test("the same sender twice is one tapback, not two", () => {
    const chips = foldChannelReactionsV1([
      { emoji: "👍", botId: "alpha" },
      { emoji: "👍", botId: "alpha" },
    ]);

    expect(chips[0]!.count).toBe(1);
  });

  test("names the chip the viewing member already left", () => {
    const chips = foldChannelReactionsV1(
      [
        { emoji: "👍", botId: "alpha" },
        { emoji: "🎉", botId: "beta" },
      ],
      "alpha",
    );

    expect(chips.map((chip) => chip.mine)).toEqual([true, false]);
  });

  test("folds through the thread projection onto each message", () => {
    const groups = projectChannelThreadV1([
      message(
        0,
        { botId: "alpha" },
        {
          reactions: [
            { emoji: "👍", botId: "beta", at: "2026-09-01T00:00:00.000Z" },
            { emoji: "👍", botId: "gamma", at: "2026-09-01T00:00:01.000Z" },
          ],
        },
      ),
    ]);

    expect(groups[0]!.messages[0]!.reactions[0]).toEqual({
      emoji: "👍",
      count: 2,
      botIds: ["beta", "gamma"],
      mine: false,
    });
  });
});

describe("Channel members strip", () => {
  test("names every member, then every peer that has spoken", () => {
    const strip = projectChannelMembersV1(
      ["alpha", "beta"],
      [message(0, { peer: "you" }), message(1, { peer: "you" })],
    );

    expect(strip).toEqual([
      { botId: "alpha" },
      { botId: "beta" },
      { peer: "you" },
    ]);
  });
});

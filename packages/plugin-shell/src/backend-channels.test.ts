// The join between a delivered Channel message and the Turn that answers it.
import { describe, expect, test } from "bun:test";
import type { ChannelInputV1 } from "@frockbot/plugin-channels/shared";
import {
  channelPendingKeyV1,
  channelRunIdV1,
  channelTurnCommandV1,
  channelTurnHistoryV1,
  channelTurnTextV1,
  settledChannelOriginV1,
} from "./backend-channels.ts";

const IDENTITY = { userId: "tim", botId: "beta" };

function message(
  seq: number,
  text: string,
  senderBotId: string,
): ChannelInputV1["history"][number] {
  return {
    schemaVersion: 1,
    messageId: `cm-${seq}`,
    channelId: "standup",
    seq,
    senderBotId,
    text,
    hop: seq + 1,
    at: `2026-09-01T00:00:0${seq}.000Z`,
    reactions: [],
  };
}

const input: ChannelInputV1 = {
  schemaVersion: 1,
  channelId: "standup",
  channelName: "Standup",
  messageId: "cm-2",
  botId: "beta",
  senderBotId: "alpha",
  text: "Standup in five.",
  hop: 2,
  at: "2026-09-01T00:00:02.000Z",
  history: [
    message(0, "Morning.", "alpha"),
    message(1, "Morning.", "beta"),
    message(2, "Standup in five.", "alpha"),
  ],
};

describe("a delivered Channel message becomes a Turn", () => {
  test("the run is derived from the message, so a redelivery is one run", () => {
    expect(channelRunIdV1("cm-2")).toBe("ch-cm-2");
    expect(channelPendingKeyV1("cm-2")).toBe("channel-pending:cm-2");
  });

  test("the command names the Channel, the message, and the turn type", () => {
    expect(
      channelTurnCommandV1(IDENTITY, input, "2026-09-01T00:00:03.000Z"),
    ).toMatchObject({
      userId: "tim",
      botId: "beta",
      runId: "ch-cm-2",
      sessionId: "channel:standup",
      turnType: "channel",
      origin: {
        kind: "channel",
        channelId: "standup",
        fireId: "cm-2",
        trigger: "integration",
      },
    });
  });

  test("the Turn runs on the message, framed by the room it was said in", () => {
    expect(channelTurnTextV1(input)).toBe(
      [
        'You are in channel "Standup" (standup).',
        "alpha posted:",
        "Standup in five.",
      ].join("\n"),
    );
  });

  test("the history is the Channel's own thread, less the message itself", () => {
    expect(
      channelTurnHistoryV1({
        history: input.history,
        messageId: input.messageId,
        selfBotId: "beta",
      }),
    ).toEqual([
      { role: "user", content: "alpha: Morning." },
      // The Bot's own earlier post is its own voice, not a teammate's.
      { role: "assistant", content: "Morning.", toolCalls: [] },
    ]);
  });

  test("a settled run says which Channel it belonged to, or nothing", () => {
    expect(
      settledChannelOriginV1({
        admission: {
          turnType: "channel",
          origin: { kind: "channel", channelId: "standup", fireId: "cm-2" },
        },
      }),
    ).toEqual({ channelId: "standup", messageId: "cm-2" });
    expect(settledChannelOriginV1({})).toBeUndefined();
    expect(
      settledChannelOriginV1({
        admission: {
          turnType: "automation",
          origin: { kind: "channel", channelId: "standup", fireId: "cm-2" },
        },
      }),
    ).toBeUndefined();
  });
});

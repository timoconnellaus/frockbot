import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  groupMessageWaitingV1,
  groupTurnStateOfRunV1,
  groupWaitingKeyV1,
} from "./bot.js";
import type { GroupTurnOriginV1 } from "./context.js";

const origin: GroupTurnOriginV1 = {
  kind: "group",
  groupId: "g-0123456789abcdef0123",
  groupName: "Trip",
  members: [{ botId: "fox", name: "Fox" }],
  throughSeq: 4,
  reason: "mention",
};

function event(partial: Record<string, unknown>): SessionEvent {
  return {
    sessionId: "group:g-0123456789abcdef0123",
    timestamp: "2026-09-23T10:00:00.000Z",
    ...partial,
  } as unknown as SessionEvent;
}

describe("a member's group Turn, read back by its group", () => {
  test("its sends are posted by occurrence; what a group cannot draw is left out", () => {
    const state = groupTurnStateOfRunV1({
      sessionId: "group:g-0123456789abcdef0123",
      status: "completed",
      events: [
        event({ seq: 1, type: "turn/start", turn: 1 }),
        event({
          seq: 5,
          type: "send/to-user",
          turn: 1,
          payload: { type: "text", text: " Hi all " },
        }),
        event({
          seq: 6,
          type: "send/to-user",
          turn: 1,
          payload: { type: "widget", widget: {} },
        }),
        event({
          seq: 7,
          type: "send/to-user",
          turn: 1,
          payload: {
            type: "attachment",
            url: "https://x/a.pdf",
            name: "a.pdf",
          },
        }),
      ],
      admission: { origin },
    });
    expect(state).toEqual({
      status: "completed",
      started: true,
      sends: [
        { occurrence: 5, text: "Hi all", at: "2026-09-23T10:00:00.000Z" },
        {
          occurrence: 7,
          text: "[a.pdf](https://x/a.pdf)",
          at: "2026-09-23T10:00:00.000Z",
        },
      ],
      yielded: false,
    });
  });

  test("a queued Turn has not started", () => {
    expect(
      groupTurnStateOfRunV1({
        sessionId: "group:g-0123456789abcdef0123",
        status: "running",
        phase: "queued",
        events: [],
      }),
    ).toMatchObject({ status: "queued", started: false });
  });

  test("a newer group message is waiting only past what the Turn was given", async () => {
    const stored = new Map<string, unknown>();
    const read = <T>(key: string) => Promise.resolve(stored.get(key) as T);
    expect(await groupMessageWaitingV1(origin, read)).toBe(false);
    stored.set(groupWaitingKeyV1(origin.groupId), 4);
    expect(await groupMessageWaitingV1(origin, read)).toBe(false);
    stored.set(groupWaitingKeyV1(origin.groupId), 5);
    expect(await groupMessageWaitingV1(origin, read)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/core/configuration";
import type { SessionEvent } from "@frockbot/core/contracts";
import type { StoredRunV1 } from "@frockbot/core/durable";
import {
  messageRecords,
  visibleMessageRecordsV1,
  type MessageNotice,
} from "./messages.js";
import {
  optionalProjectedSendV1,
  PUSH_OUTBOX_PREFIX,
  sentAutomationRunKeyV1,
} from "./storage-keys.js";
import {
  decodeUnreadStateV1,
  MESSAGE_PREFIX,
  MESSAGE_SEQUENCE_KEY,
  SIDEBAR_PREVIEW_KEY,
  UNREAD_STATE_KEY,
} from "../shell/unread.js";
import { BOT_CONFIGURATION_KEY } from "../settings/bot.js";

const send = (seq: number, text: string, type: "text" | "approval" = "text") =>
  ({
    type: "send/to-user" as const,
    seq,
    timestamp: `2026-09-01T00:00:0${seq}.000Z`,
    turn: 1,
    step: 1,
    occurrenceId: `tool:1:1:${seq}`,
    payload:
      type === "text"
        ? { type: "text" as const, text }
        : {
            type: "approval" as const,
            approvalId: `ap-${seq}`,
            action: text,
            risk: "low" as const,
          },
  }) satisfies SessionEvent;

function run(
  events: SessionEvent[],
  enabled = true,
): StoredRunV1<ReturnType<typeof initializeBotSettingsV1>> {
  return {
    runId: "run-1",
    commandFingerprint: "fingerprint",
    sessionId: "user-1:primary",
    acceptedAt: "2026-09-01T00:00:00.000Z",
    input: "hello",
    events,
    effectAdmissions: [],
    status: "running",
    phase: "executing",
    compositionGenerationId: "generation-1",
    configurationSnapshot: {
      ...initializeBotSettingsV1("primary"),
      profile: { name: "Primary" },
      notifications: { enabled },
    },
    previousEventCount: 0,
  };
}

function reader(initial: Record<string, unknown> = {}) {
  return <T>(key: string) => Promise.resolve(initial[key] as T | undefined);
}

describe("message-time unread and notification records", () => {
  test("each newly committed send counts immediately and exactly once", async () => {
    const first = send(1, "First");
    const second = send(2, "Second");
    const records = await messageRecords({
      run: run([first, second]),
      events: [first, second],
      read: reader(),
    });

    expect(records[MESSAGE_SEQUENCE_KEY]).toBe(2);
    expect(
      Object.keys(records).filter((key) => key.startsWith(MESSAGE_PREFIX)),
    ).toHaveLength(2);
    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastActivityCursor: "message-00000000000000000002",
      lastMessageId: "run-1:send:1",
    });
    expect(records[SIDEBAR_PREVIEW_KEY]).toMatchObject({
      text: "Second",
      role: "assistant",
    });
  });

  test("a muted message remains unread but creates no visible notification", async () => {
    const event = send(1, "Quiet");
    const records = await messageRecords({
      run: run([event], false),
      events: [event],
      read: reader(),
    });

    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastActivityCursor: "message-00000000000000000001",
    });
    expect(
      Object.keys(records).filter((key) => key.startsWith(PUSH_OUTBOX_PREFIX)),
    ).toHaveLength(1);
    expect(
      Object.keys(records).filter((key) => key.startsWith("notification:")),
    ).toHaveLength(0);
  });

  test("a send uses the Bot's current notification setting, not its admission snapshot", async () => {
    const event = send(1, "Current choice");
    const enabledNow = initializeBotSettingsV1("primary");
    const mutedNow = {
      ...enabledNow,
      notifications: { enabled: false },
    };

    const enabled = await messageRecords({
      run: run([event], false),
      events: [event],
      read: reader({ [BOT_CONFIGURATION_KEY]: enabledNow }),
    });
    const muted = await messageRecords({
      run: run([event], true),
      events: [event],
      read: reader({ [BOT_CONFIGURATION_KEY]: mutedNow }),
    });

    expect(enabled["notification:message-00000000000000000001"]).toBeDefined();
    expect(muted["notification:message-00000000000000000001"]).toBeUndefined();
    expect(muted[UNREAD_STATE_KEY]).toBeDefined();
  });

  test("approval messages follow the same mute rule as ordinary replies", async () => {
    const event = send(1, "Approve deletion", "approval");
    const muted = await messageRecords({
      run: run([event], false),
      events: [event],
      read: reader(),
    });
    const enabled = await messageRecords({
      run: run([event], true),
      events: [event],
      read: reader(),
    });

    expect(
      Object.keys(muted).filter((key) => key.startsWith("notification:")),
    ).toHaveLength(0);
    expect(
      Object.keys(enabled).filter((key) => key.startsWith("notification:")),
    ).toHaveLength(1);
    expect(enabled["notification:message-00000000000000000001"]).toMatchObject({
      body: "Approve deletion",
    });
  });

  test("a send from a Turn the voice session asked counts unread but wakes no device", async () => {
    const event = send(1, "Here is the longer version.");
    const voiced = {
      ...run([event]),
      admission: {
        schemaVersion: 1 as const,
        turnType: "agent" as const,
        origin: {
          kind: "voice" as const,
          callId: "call-1",
          voiceTurnId: "turn_1",
          requestId: "voice-00000000000000000000000000000001",
        },
      },
    };
    const records = await messageRecords({
      run: voiced,
      events: [event],
      read: reader(),
    });
    const notice = records[
      `${PUSH_OUTBOX_PREFIX}message-${"1".padStart(20, "0")}`
    ] as MessageNotice;
    expect(notice.notify).toBe(false);
    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastMessageId: notice.messageId,
    });
  });

  test("names a batch's sends the way the transcript does, by declared position", async () => {
    // One batch's three sends, landed out of order: the one declared first
    // finished last. The transcript draws them at their declared ordinal, so
    // the unread boundary and the push intent have to name the same bubble.
    const landed = ["tool:1:1:0.1", "tool:1:1:0.2", "tool:1:1:0.0"].map(
      (occurrenceId, index) =>
        ({
          ...send(index + 1, occurrenceId),
          occurrenceId,
        }) satisfies SessionEvent,
    );
    const records = await messageRecords({
      run: run(landed),
      events: landed,
      read: reader(),
    });

    expect(
      Object.keys(records)
        .filter((key) => key.startsWith(PUSH_OUTBOX_PREFIX))
        .map((key) => {
          const notice = records[key] as MessageNotice;
          return [notice.body, notice.messageId];
        }),
    ).toEqual([
      ["tool:1:1:0.0", "run-1:send:0"],
      ["tool:1:1:0.1", "run-1:send:1"],
      ["tool:1:1:0.2", "run-1:send:2"],
    ]);
    // The boundary is the last bubble of the batch as it is drawn, which is
    // the last one declared — not whichever call happened to land last.
    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastMessageId: "run-1:send:2",
    });
  });

  test("a subagent send does not create user unread or push records", async () => {
    const event = send(1, "Internal");
    const subagent = {
      ...run([event]),
      admission: { schemaVersion: 1 as const, turnType: "subagent" as const },
    };
    expect(
      await messageRecords({ run: subagent, events: [event], read: reader() }),
    ).toEqual({});
  });
});

describe("a message whose run has no send event to carry it", () => {
  const settings = {
    ...initializeBotSettingsV1("primary"),
    profile: { name: "Primary" },
    notifications: { enabled: true },
  };

  test("is projected into its run at the ordinal it was named by", async () => {
    const records = await visibleMessageRecordsV1({
      settings,
      read: reader(),
      messages: [
        {
          messageId: "rf-brief-1:send:2",
          runId: "rf-brief-1",
          createdAt: "2026-09-01T00:00:00.000Z",
          body: "It stopped without saying why.",
          automation: true,
          projectedSendOrdinal: 2,
        },
      ],
    });

    // The transcript reads the message back off this marker, so the id the
    // device renders is the id the unread record names.
    expect(
      optionalProjectedSendV1(records[sentAutomationRunKeyV1("rf-brief-1")]),
    ).toEqual({ ordinal: 2, text: "It stopped without saying why." });
    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastMessageId: "rf-brief-1:send:2",
    });
  });

  test("never leaves an unread record that cannot be read back", async () => {
    // An id outside the boundary grammar would make every later unread read —
    // and every event commit, which performs one — throw for ever.
    const records = await visibleMessageRecordsV1({
      settings,
      read: reader(),
      messages: [
        {
          messageId: `${"r".repeat(240)}:send:0`,
          runId: "r".repeat(240),
          createdAt: "2026-09-01T00:00:00.000Z",
          body: "Too long to name",
        },
      ],
    });

    const state = decodeUnreadStateV1(records[UNREAD_STATE_KEY]);
    expect(state.lastMessageId).toBeUndefined();
    expect(state.lastActivityCursor).toBe("message-00000000000000000001");
  });
});

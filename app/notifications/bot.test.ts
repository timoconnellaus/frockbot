import { describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/core/configuration";
import { Session, type SessionEvent } from "@frockbot/core/contracts";
import { RUN_FAILURE_FALLBACK_COPY_V1 } from "../shell/run-failure-copy.js";
import { SIDEBAR_PREVIEW_KEY, UNREAD_STATE_KEY } from "../shell/unread.js";
import { failedTurnRecordsV1 } from "./bot.js";
import { PUSH_OUTBOX_PREFIX } from "./storage-keys.js";

function settings(enabled: boolean) {
  return {
    ...initializeBotSettingsV1("primary"),
    profile: { name: "Bob" },
    notifications: { enabled },
  };
}

function admitted(turnType: "chat" | "automation"): SessionEvent[] {
  const session = new Session("user-1:primary");
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "turn/admission", turn: 1, turnType } as SessionEvent,
  ]);
  return [...session.events];
}

const read = <T>(_key: string) => Promise.resolve(undefined as T | undefined);

describe("what a failed chat Turn leaves for the person", () => {
  test("is one message: unread, previewed, pushed and listed", async () => {
    // No `turn/end` in this journal, so the copy is the generic line; the
    // outcome-specific sentences are `run-failure-copy.test.ts`'s to prove.
    const records = await failedTurnRecordsV1({
      settings: settings(true),
      read,
      failed: {
        runId: "run-1",
        failure: "Bot turn ended with outcome model-error: 401 from provider-1",
        events: admitted("chat"),
      },
    });

    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastMessageId: "run-1:failed",
      lastActivityCursor: "message-00000000000000000001",
    });
    expect(records[SIDEBAR_PREVIEW_KEY]).toMatchObject({
      text: RUN_FAILURE_FALLBACK_COPY_V1,
      role: "assistant",
    });
    const pushed = Object.entries(records).filter(([key]) =>
      key.startsWith(PUSH_OUTBOX_PREFIX),
    );
    expect(pushed).toHaveLength(1);
    expect(pushed[0]![1]).toMatchObject({
      title: "Bob",
      body: RUN_FAILURE_FALLBACK_COPY_V1,
      notify: true,
    });
    expect(records["notification:message-00000000000000000001"]).toMatchObject({
      runId: "run-1",
      body: RUN_FAILURE_FALLBACK_COPY_V1,
    });
    // The diagnostic stays on the run record.
    expect(JSON.stringify(records)).not.toContain("provider-1");
  });

  test("a muted Bot still counts it, and alerts nobody", async () => {
    const records = await failedTurnRecordsV1({
      settings: settings(false),
      read,
      failed: { runId: "run-1", failure: "", events: admitted("chat") },
    });

    expect(records[UNREAD_STATE_KEY]).toMatchObject({
      lastMessageId: "run-1:failed",
    });
    expect(
      Object.keys(records).filter((key) => key.startsWith("notification:")),
    ).toEqual([]);
  });

  test("an automation Turn leaves nothing here; its own surface tells it", async () => {
    expect(
      await failedTurnRecordsV1({
        settings: settings(true),
        read,
        failed: {
          runId: "fire-1",
          failure: "",
          events: admitted("automation"),
        },
      }),
    ).toEqual({});
  });
});

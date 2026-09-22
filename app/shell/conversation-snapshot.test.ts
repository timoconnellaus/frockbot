import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  commitPublicationsV1,
  RUN_INDEX_PREFIX,
  runEntityIdV1,
} from "@frockbot/core/durable";
import { CLIENT_RUN_PAGE_LIMIT } from "./run-protocol.js";
import { readConversationSnapshotV1 } from "./conversation-snapshot.js";

describe("conversation snapshot", () => {
  test("reads committed rows from the same store as the publication head", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "run-status",
          entityId: runEntityIdV1("run-1"),
          payload: {
            run: {
              schemaVersion: 1,
              runId: "run-1",
              admittedAt: "2026-09-22T00:00:00.000Z",
              input: "hi",
              status: "completed",
              events: [],
            },
          },
        },
      ]),
    );
    const snapshot = await readConversationSnapshotV1(storage);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.runId).toBe("run-1");
    expect(snapshot.page.truncated).toBe(false);
  });

  test("names the older-page cursor when the run index continues", async () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < CLIENT_RUN_PAGE_LIMIT + 2; i += 1) {
      const runId = `run-${i}`;
      await storage.put(`${RUN_INDEX_PREFIX}2026-09-22T00:00:00.000Z:${runId}`, runId);
      await storage.put(`run:${runId}`, {
        runId,
        sessionId: "user-1:scout",
        acceptedAt: "2026-09-22T00:00:00.000Z",
        input: "hi",
        events: [],
        eventRange: { startSeq: 0, endSeq: 0 },
        effectAdmissions: [],
        status: "completed",
        phase: "executing",
        previousEventCount: 0,
        compositionGenerationId: "g1",
        commandFingerprint: "{}",
        configurationSnapshot: {},
      });
    }
    const snapshot = await readConversationSnapshotV1(storage);
    expect(snapshot.page.truncated).toBe(true);
    expect(snapshot.page.nextCursor).toBeString();
  });
});

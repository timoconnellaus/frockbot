// Integrated startup acceptance. Each packet already has its own suite.
// This one runs the cross-packet obligations on the same fakes: several
// Bots, a committed send that is delivered once, opening audio held to its
// attempt, and Memory that survives eviction and does not return after forget.
// Provider timing stays out of the test. Pre-answer voice recall stays the
// documented unsupported path.

import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  commitPublicationsV1,
  drainPendingPublicationV1,
  messageEntityIdV1,
  readReplayUpdatesV1,
  readPublicationHeadV1,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import { MemoryEngineV1 } from "../memory/engine.ts";
import { drainMemoryProcessingV1 } from "../memory/processing.ts";
import {
  MEMORY_JOB_WAKEUP_MS_V1,
  type MemoryAuthorityV1,
  type MemoryJobPrincipalV1,
  type MemoryScopeRefV1,
  type MemorySourceInputV1,
} from "../memory/records.ts";
import type { MemorySqlStorageV1, MemorySqlValueV1 } from "../memory/sql.ts";
import { createTestMemoryAuthorityV1 } from "../memory/testing.ts";
import {
  decideVoicePcmSequenceV1,
  decodeVoiceAssistantPcmEnvelopeV1,
  encodeVoiceAssistantPcmEnvelopeV1,
  voiceAssistantOpeningBudgetBytesV1,
} from "../voice/opening.ts";
import { VOICE_AUTOMATIC_PREANSWER_RECALL_V1 } from "../voice/memory-recall.ts";

const databases: Database[] = [];

function storage(): MemorySqlStorageV1 & { database: Database } {
  const database = new Database(":memory:");
  databases.push(database);
  return {
    database,
    sql: {
      exec<Row extends Record<string, MemorySqlValueV1>>(
        query: string,
        ...bindings: SQLQueryBindings[]
      ) {
        const rows = database
          .query<Row, SQLQueryBindings[]>(query)
          .all(...bindings);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return database.transaction(callback)();
    },
  };
}

const USER = "user-1";
const ROSEMARY: MemoryScopeRefV1 = {
  kind: "bot",
  userId: USER,
  botId: "rosemary",
};
const CLEMENTINE: MemoryScopeRefV1 = {
  kind: "bot",
  userId: USER,
  botId: "clementine",
};
const ACCOUNT: MemoryScopeRefV1 = { kind: "user", userId: USER };
const PRINCIPAL: MemoryJobPrincipalV1 = {
  userId: USER,
  botId: "rosemary",
  actor: "bot",
  turnId: "turn-acceptance",
};

function authority(
  botId: string,
  overrides: Partial<MemoryAuthorityV1> = {},
): MemoryAuthorityV1 {
  return createTestMemoryAuthorityV1({ botId, ...overrides });
}

function chatSource(capturedText: string): MemorySourceInputV1 & {
  capturedText: string;
} {
  return {
    sourceId: "src-acceptance",
    sourceRevision: "1",
    kind: "chat",
    locator: {
      kind: "chat",
      botId: "rosemary",
      sessionId: "user-1:rosemary",
      runId: "run-acceptance",
      eventSeq: 1,
      revision: "1",
    },
    capturedText,
  };
}

describe("startup acceptance", () => {
  test("private facts stay on their Bot, and a forgotten fact stays gone after eviction", () => {
    const sql = storage();
    const now = new Date("2026-09-22T12:00:00.000Z");
    const first = new MemoryEngineV1({ storage: sql, now: () => now });
    const rosemary = authority("rosemary");
    const clementine = authority("clementine");
    const shared = first.write({
      authority: rosemary,
      scope: ACCOUNT,
      content: "Tim prefers blunt answers.",
      operationKey: "user-pref",
    });
    const secret = first.write({
      authority: rosemary,
      scope: ROSEMARY,
      content: "Rosemary's draft is unfinished.",
      operationKey: "rosemary-private",
    });
    expect(shared.status).toBe("ok");
    expect(secret.status).toBe("ok");
    if (secret.status !== "ok") throw new Error("unreachable");

    const cold = new MemoryEngineV1({ storage: sql, now: () => now });
    expect(
      cold.recall({
        authority: clementine,
        query: "blunt answers",
        scopes: [ACCOUNT, CLEMENTINE],
      }).hits.length,
    ).toBeGreaterThan(0);
    expect(
      cold.recall({
        authority: clementine,
        query: "unfinished draft",
        scopes: [ACCOUNT, CLEMENTINE],
      }).hits,
    ).toEqual([]);

    const forgotten = cold.forget({
      authority: rosemary,
      scope: ROSEMARY,
      operationKey: "forget-draft",
      itemId: secret.receipt.itemId,
    });
    expect(forgotten.status).toBe("ok");
    const after = new MemoryEngineV1({ storage: sql, now: () => now });
    expect(
      after.recall({
        authority: rosemary,
        query: "unfinished draft",
        scopes: [ROSEMARY],
      }).hits,
    ).toEqual([]);
    for (const database of databases.splice(0)) database.close();
  });

  test("a sealed chat records extraction, and the alarm drain runs without another message", async () => {
    const sql = storage();
    let at = new Date("2026-09-22T12:00:00.000Z");
    const engine = new MemoryEngineV1({ storage: sql, now: () => at });
    const captured = engine.captureExtraction({
      authority: authority("rosemary"),
      scope: ROSEMARY,
      principal: PRINCIPAL,
      source: chatSource("Remember the gate code is verbal only."),
    });
    expect(captured.status).toBe("ok");
    expect(engine.nextWakeupAt()).toBeTypeOf("number");
    at = new Date(at.getTime() + MEMORY_JOB_WAKEUP_MS_V1 + 1);
    const spent: string[] = [];
    const drained = await drainMemoryProcessingV1(
      engine,
      {
        extract: async (input) => {
          spent.push(input.capturedText);
          return [
            {
              text: "The gate code is given verbally.",
              kind: "fact",
              subjectKey: "gate",
            },
          ];
        },
      },
      at,
    );
    expect(drained.processed).toBeGreaterThan(0);
    expect(spent).toEqual(["Remember the gate code is verbal only."]);
    const again = await drainMemoryProcessingV1(engine, {}, at);
    expect(again.spent).toBe(0);
    expect(
      engine.recall({
        authority: authority("rosemary"),
        query: "gate code",
        scopes: [ROSEMARY],
      }).hits.length,
    ).toBeGreaterThan(0);
    for (const database of databases.splice(0)) database.close();
  });

  test("two committed sends publish once, in order, without a second transcript write", async () => {
    const storage = new MemoryStorage();
    const sessionId = "user-1:rosemary";
    await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "message",
          entityId: messageEntityIdV1({
            sessionId,
            runId: "run-1",
            occurrenceId: "occ-1",
          }),
          payload: { text: "first" },
        },
        {
          kind: "message",
          entityId: messageEntityIdV1({
            sessionId,
            runId: "run-2",
            occurrenceId: "occ-2",
          }),
          payload: { text: "second" },
        },
      ]),
    );
    const delivered: string[] = [];
    const more = await drainPendingPublicationV1(storage, async (updates) => {
      for (const update of updates) delivered.push(String(update.cursor));
    });
    expect(more).toBe(false);
    expect(delivered).toEqual(["1", "2"]);
    const head = await readPublicationHeadV1(storage);
    const replay = await readReplayUpdatesV1(storage, head, 0);
    expect(replay.map((update) => update.cursor)).toEqual([1, 2]);
    const again = await drainPendingPublicationV1(storage, async () => {
      delivered.push("again");
    });
    expect(again).toBe(false);
    expect(delivered).toEqual(["1", "2"]);
  });

  test("opening speech stays bound to its attempt and a gap is not played as the next word", () => {
    const attempt = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeVoiceAssistantPcmEnvelopeV1({
      attemptId: attempt,
      sequence: 0,
      pcm,
    });
    const decoded = decodeVoiceAssistantPcmEnvelopeV1(frame);
    expect(decoded?.attemptId).toBe(attempt);
    expect(decoded?.pcm).toEqual(pcm);
    const foreign = encodeVoiceAssistantPcmEnvelopeV1({
      attemptId: other,
      sequence: 0,
      pcm,
    });
    expect(decodeVoiceAssistantPcmEnvelopeV1(foreign)?.attemptId).not.toBe(
      attempt,
    );
    expect(decideVoicePcmSequenceV1(undefined, 0).kind).toBe("accept");
    expect(decideVoicePcmSequenceV1(0, 2).kind).toBe("gap");
    expect(voiceAssistantOpeningBudgetBytesV1()).toBe(320_000);
    expect(VOICE_AUTOMATIC_PREANSWER_RECALL_V1).toBe("unsupported");
  });
});

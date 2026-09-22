import { describe, expect, test } from "bun:test";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import {
  commitPublicationsV1,
  COMPUTER_ENTITY_ID_V1,
  decodePublicationHeadV1,
  drainPendingPublicationV1,
  emptyPublicationHeadV1,
  messageEntityIdV1,
  readPublicationHeadV1,
  readReplayUpdatesV1,
  runEntityIdV1,
  utf8BytesV1,
} from "./publication.ts";
import {
  CONVERSATION_UPDATE_PREFIX,
  PUBLICATION_PENDING_PREFIX,
  PUBLICATION_REPLAY_MAX_EVENTS_V1,
} from "./storage-keys.ts";

describe("committed publication", () => {
  test("allocates a cursor, row, event and pending marker in one transaction", async () => {
    const storage = new MemoryStorage();
    const committed = await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "message",
          entityId: messageEntityIdV1({
            sessionId: "user-1:scout",
            runId: "run-1",
            occurrenceId: "occ-1",
          }),
          payload: { text: "hello" },
        },
      ]),
    );
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      epoch: 1,
      cursor: 1,
      kind: "message",
      revision: 1,
    });
    const head = await readPublicationHeadV1(storage);
    expect(head).toEqual({
      schemaVersion: 1,
      epoch: 1,
      firstRetainedCursor: 1,
      lastCursor: 1,
      broadcastThrough: 0,
    });
    expect(
      [...storage.values.keys()].some((key) =>
        key.startsWith(PUBLICATION_PENDING_PREFIX),
      ),
    ).toBe(true);
  });

  test("a stale revision does not allocate a cursor", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "card-revision",
          entityId: "card:draft",
          revision: 2,
          payload: { surfaceId: "draft", revision: 2 },
        },
      ]),
    );
    const again = await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "card-revision",
          entityId: "card:draft",
          revision: 2,
          payload: { surfaceId: "draft", revision: 2 },
        },
      ]),
    );
    expect(again).toEqual([]);
    expect(await readPublicationHeadV1(storage)).toMatchObject({
      lastCursor: 1,
    });
  });

  test("a thrown transaction leaves no publication records", async () => {
    const storage = new MemoryStorage();
    await expect(
      storage.transaction(async (transaction) => {
        await commitPublicationsV1(transaction, [
          {
            kind: "run-status",
            entityId: runEntityIdV1("run-1"),
            payload: { runId: "run-1", status: "running" },
          },
        ]);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow(/rolled back/);
    expect(storage.values.size).toBe(0);
  });

  test("drain delivers once, then advances broadcastThrough", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "computer",
          entityId: COMPUTER_ENTITY_ID_V1,
          payload: {},
        },
      ]),
    );
    const delivered: unknown[] = [];
    expect(
      await drainPendingPublicationV1(storage, async (updates) => {
        delivered.push(...updates);
      }),
    ).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(await readPublicationHeadV1(storage)).toMatchObject({
      lastCursor: 1,
      broadcastThrough: 1,
    });
    expect(
      [...storage.values.keys()].some((key) =>
        key.startsWith(PUBLICATION_PENDING_PREFIX),
      ),
    ).toBe(false);
    expect(
      await drainPendingPublicationV1(storage, async () => {
        throw new Error("must not deliver twice");
      }),
    ).toBe(false);
  });

  test("a failed deliver leaves pending so recovery can retry", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((transaction) =>
      commitPublicationsV1(transaction, [
        {
          kind: "announcement",
          entityId: "ann:1",
          payload: { type: "bot/renamed" },
        },
      ]),
    );
    expect(
      await drainPendingPublicationV1(storage, async () => {
        throw new Error("socket down");
      }),
    ).toBe(true);
    expect(await readPublicationHeadV1(storage)).toMatchObject({
      broadcastThrough: 0,
    });
    const delivered: number[] = [];
    expect(
      await drainPendingPublicationV1(storage, async (updates) => {
        delivered.push(...updates.map((update) => update.cursor));
      }),
    ).toBe(false);
    expect(delivered).toEqual([1]);
  });

  test("replay does not drop undrained updates to fit the count bound", async () => {
    const storage = new MemoryStorage();
    await storage.transaction(async (transaction) => {
      await commitPublicationsV1(
        transaction,
        Array.from(
          { length: PUBLICATION_REPLAY_MAX_EVENTS_V1 + 8 },
          (_, i) => ({
            kind: "run-status" as const,
            entityId: runEntityIdV1(`run-${i}`),
            payload: { runId: `run-${i}` },
          }),
        ),
      );
    });
    const head = await readPublicationHeadV1(storage);
    expect(head.lastCursor).toBe(PUBLICATION_REPLAY_MAX_EVENTS_V1 + 8);
    expect(head.firstRetainedCursor).toBe(1);
    expect(head.broadcastThrough).toBe(0);
    const replay = await readReplayUpdatesV1(storage, head, 0);
    expect(replay).toHaveLength(PUBLICATION_REPLAY_MAX_EVENTS_V1 + 8);
    await drainPendingPublicationV1(storage, async () => undefined, {
      batch: 200,
    });
    const drained = await readPublicationHeadV1(storage);
    expect(drained.broadcastThrough).toBe(drained.lastCursor);
    expect(drained.firstRetainedCursor).toBe(
      drained.lastCursor - PUBLICATION_REPLAY_MAX_EVENTS_V1 + 1,
    );
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith(CONVERSATION_UPDATE_PREFIX),
      ),
    ).toHaveLength(PUBLICATION_REPLAY_MAX_EVENTS_V1);
  });

  test("empty head is a valid starting epoch", () => {
    expect(decodePublicationHeadV1(undefined)).toEqual(
      emptyPublicationHeadV1(),
    );
    expect(utf8BytesV1({ a: 1 })).toBeGreaterThan(0);
  });
});

// The disposable cleanup a User Durable Object runs once before it serves
// Bot-owned Applets (ADR 0027): old-shape Applet data goes, nothing else does,
// and a second load is free. The workerd suite proves the same against an
// evicted object and a fresh conversation.
import { describe, expect, test } from "bun:test";
import {
  APPLET_CLEANUP_PREFIX,
  APPLET_DIRECTORY_REVISION_KEY,
  COMPOSITION_CURRENT_KEY,
  COMPOSITION_LAST_KNOWN_GOOD_KEY,
  appletDirectoryEntryKey,
  compositionArtifactSetHashV1,
  compositionGenerationKey,
  compositionIndexKey,
  decodeCompositionGenerationV1,
} from "@frockbot/core/durable";
import {
  BOT_OWNED_APPLETS_CLEANUP_RECEIPT_KEY,
  cleanAppletTestStateV1,
} from "./applet-test-state-cleanup.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }
  put(entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries))
      this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  delete(keys: string | string[]): Promise<number> {
    let removed = 0;
    for (const key of Array.isArray(keys) ? keys : [keys])
      if (this.values.delete(key)) removed += 1;
    return Promise.resolve(removed);
  }
  list<T>(options: { prefix: string; limit?: number }) {
    const matching = [...this.values]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY);
    return Promise.resolve(new Map(matching) as Map<string, T>);
  }
  transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>) {
    return callback(this);
  }
}

const USER = "user-42";
const OLD = `${USER}.${"a".repeat(32)}`;
const NEW = `${USER}.${"b".repeat(32)}`;
const CREATED = "2026-09-01T00:00:00.000Z";

const tool = {
  name: "add_todo",
  description: "Add a todo",
  inputSchema: { type: "object" },
};

/** A directory entry as the build before Bot ownership wrote it. */
const legacyEntry = {
  schemaVersion: 1,
  appletId: OLD,
  displayName: "Todo",
  currentGenerationId: "g1",
  tools: [tool],
  provenance: { kind: "user" },
  createdAt: CREATED,
  status: "published",
};

const currentEntry = {
  ...legacyEntry,
  appletId: NEW,
  ownerBotId: "scout",
  sharedWithBotIds: [],
  available: true,
};

const legacyMember = {
  kind: "applet",
  appletId: OLD,
  generationId: "g1",
  tools: [tool],
  provenance: {
    kind: "user",
    packageId: OLD,
    version: "g1",
    userId: USER,
    authoredAt: new Date(0).toISOString(),
  },
};

async function legacyGeneration(id: string) {
  return {
    schemaVersion: 1,
    generationId: `${CREATED}:${id}`,
    artifactSetHash: await compositionArtifactSetHashV1([]),
    createdAt: CREATED,
    origin: { kind: "bootstrap" },
    members: [],
    applets: [legacyMember],
    status: "active",
  };
}

async function seeded() {
  const storage = new MemoryStorage();
  const pinned = await legacyGeneration("pinned");
  const history = await legacyGeneration("history");
  await storage.put({
    [appletDirectoryEntryKey(OLD)]: legacyEntry,
    [appletDirectoryEntryKey(NEW)]: currentEntry,
    [APPLET_DIRECTORY_REVISION_KEY]: 7,
    [compositionGenerationKey(pinned.generationId)]: pinned,
    [compositionIndexKey(CREATED, pinned.generationId)]: pinned.generationId,
    [compositionGenerationKey(history.generationId)]: history,
    [compositionIndexKey(CREATED, history.generationId)]: history.generationId,
    [COMPOSITION_CURRENT_KEY]: {
      generationId: pinned.generationId,
      artifactSetHash: pinned.artifactSetHash,
    },
    [COMPOSITION_LAST_KNOWN_GOOD_KEY]: pinned.generationId,
    // Not Applet data: nothing here may touch it.
    "flock:directory:v1": { schemaVersion: 1, revision: 1, bots: [] },
  });
  return { storage, pinned, history };
}

describe("the Bot-owned Applets cleanup", () => {
  test("removes old-shape Applet data, queues its state and source, and keeps the rest", async () => {
    const { storage, pinned, history } = await seeded();
    await cleanAppletTestStateV1(
      storage as unknown as DurableObjectStorage,
      new Date("2026-09-14T00:00:00.000Z"),
    );

    expect(storage.values.has(appletDirectoryEntryKey(OLD))).toBe(false);
    expect(storage.values.get(appletDirectoryEntryKey(NEW))).toEqual(
      currentEntry,
    );
    expect(storage.values.get(`${APPLET_CLEANUP_PREFIX}${OLD}`)).toMatchObject({
      appletId: OLD,
    });
    // Every Bot re-resolves its Applets at its next Turn.
    expect(storage.values.get(APPLET_DIRECTORY_REVISION_KEY)).toBe(8);

    for (const generation of [pinned, history]) {
      expect(
        storage.values.has(compositionGenerationKey(generation.generationId)),
      ).toBe(false);
      expect(
        storage.values.has(
          compositionIndexKey(CREATED, generation.generationId),
        ),
      ).toBe(false);
    }
    const pin = storage.values.get(COMPOSITION_CURRENT_KEY) as {
      generationId: string;
    };
    expect(pin.generationId).not.toBe(pinned.generationId);
    const replacement = decodeCompositionGenerationV1(
      storage.values.get(compositionGenerationKey(pin.generationId)),
    );
    expect(replacement).toMatchObject({
      members: [],
      status: "active",
      parentGenerationId: pinned.generationId,
    });
    expect(replacement.applets).toBeUndefined();
    expect(replacement.artifactSetHash).toBe(
      await compositionArtifactSetHashV1([]),
    );
    expect(storage.values.get(COMPOSITION_LAST_KNOWN_GOOD_KEY)).toBe(
      pin.generationId,
    );
    expect(storage.values.get("flock:directory:v1")).toEqual({
      schemaVersion: 1,
      revision: 1,
      bots: [],
    });
    expect(
      storage.values.get(BOT_OWNED_APPLETS_CLEANUP_RECEIPT_KEY),
    ).toMatchObject({ removedApplets: 1, removedGenerations: 2 });
  });

  test("runs once: a second load finds the receipt and touches nothing", async () => {
    const { storage } = await seeded();
    await cleanAppletTestStateV1(storage as unknown as DurableObjectStorage);
    // A stray old-shape entry written after the cleanup is not this
    // release's to remove.
    await storage.put({ [appletDirectoryEntryKey(OLD)]: legacyEntry });
    const before = structuredClone([...storage.values]);
    await cleanAppletTestStateV1(storage as unknown as DurableObjectStorage);
    expect([...storage.values]).toEqual(before);
  });

  test("an account with nothing old writes only its receipt", async () => {
    const storage = new MemoryStorage();
    await storage.put({ [appletDirectoryEntryKey(NEW)]: currentEntry });
    await cleanAppletTestStateV1(storage as unknown as DurableObjectStorage);
    expect([...storage.values.keys()].sort()).toEqual(
      [
        appletDirectoryEntryKey(NEW),
        BOT_OWNED_APPLETS_CLEANUP_RECEIPT_KEY,
      ].sort(),
    );
  });
});

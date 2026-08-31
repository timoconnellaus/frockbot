import { describe, expect, test } from "bun:test";
import type {
  WorkspaceGenerationRecordV1,
  WorkspaceGenerationV1,
  WorkspaceRootV1,
} from "@frockbot/kernel-contracts";
import { DurableWorkspaceGenerations } from "./workspace-generations.ts";
import {
  WORKSPACE_CONFLICT_PREFIX,
  WORKSPACE_GENERATION_PREFIX,
  workspaceFileKeyTail,
} from "./storage-keys.ts";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  list<T>(options: {
    prefix?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ""))
      .sort(([left], [right]) => left.localeCompare(right));
    return Promise.resolve(
      new Map(entries.slice(0, options.limit) as Array<[string, T]>),
    );
  }
}

const ROOT: WorkspaceRootV1 = {
  kind: "bot-instructions",
  userId: "user-1",
  botId: "bot-1",
};
const HASH = "a".repeat(64);

function store(storage = new MemoryStorage()): {
  generations: DurableWorkspaceGenerations;
  storage: MemoryStorage;
} {
  return {
    storage,
    generations: new DurableWorkspaceGenerations({
      state: { storage } as unknown as DurableObjectState,
    }),
  };
}

function generation(
  generationId: string,
  overrides: Partial<WorkspaceGenerationV1> = {},
): WorkspaceGenerationV1 {
  return {
    schemaVersion: 1,
    generationId,
    contentHash: HASH,
    size: 4,
    writer: { kind: "user", userId: "user-1" },
    writtenAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function record(
  generationId: string,
  overrides: Partial<WorkspaceGenerationRecordV1> = {},
): WorkspaceGenerationRecordV1 {
  return {
    schemaVersion: 1,
    root: ROOT,
    path: "skills/deploy/SKILL.md",
    generation: generation(generationId),
    etag: "etag-1",
    ...overrides,
  };
}

describe("minted generation ids", () => {
  test("are sortable and strictly increasing", async () => {
    const { generations } = store();
    const ids = [
      await generations.mint(new Date("2026-08-31T00:00:00.000Z")),
      await generations.mint(new Date("2026-08-31T00:00:00.000Z")),
      await generations.mint(new Date("2026-08-31T00:00:01.000Z")),
    ];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  test("never move backwards when the clock does", async () => {
    const { generations } = store();
    const later = await generations.mint(new Date("2026-08-31T00:00:10.000Z"));
    const earlier = await generations.mint(
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(earlier > later).toBe(true);
  });

  test("are distinct when two cold mints run concurrently", async () => {
    // The cursor is only assigned after an `await` on storage, so two mints
    // that begin before either has read it — the ordinary case on a freshly
    // constructed object, where nothing is cached — must not both read the
    // same cursor and hand two files one generation.
    const { generations, storage } = store();
    const at = new Date("2026-08-31T00:00:00.000Z");
    const ids = await Promise.all([
      generations.mint(at),
      generations.mint(at),
      generations.mint(at),
    ]);
    expect(new Set(ids).size).toBe(3);
    // And the durable cursor still describes the last of them.
    const highest = [...ids].sort().at(-1) ?? "";
    expect((await store(storage).generations.mint(at)) > highest).toBe(true);
  });

  test("keep increasing across eviction, because the cursor is durable", async () => {
    const storage = new MemoryStorage();
    const first = await store(storage).generations.mint(
      new Date("2026-08-31T00:00:00.000Z"),
    );
    // A fresh instance over the same storage is a reconstructed object.
    const second = await store(storage).generations.mint(
      new Date("2026-08-31T00:00:00.000Z"),
    );
    expect(second > first).toBe(true);
  });
});

describe("the generation ledger", () => {
  test("records a generation and reads it back decoded", async () => {
    const { generations, storage } = store();
    await generations.record(record("000000000000001-000000001"));

    const current = await generations.current(ROOT, "skills/deploy/SKILL.md");
    expect(current?.generation.generationId).toBe("000000000000001-000000001");
    expect(current?.etag).toBe("etag-1");
    expect([...storage.values.keys()]).toEqual([
      `${WORKSPACE_GENERATION_PREFIX}${workspaceFileKeyTail(
        "bot-instructions:user-1:bot-1",
        "skills/deploy/SKILL.md",
      )}`,
    ]);
    expect(await generations.current(ROOT, "absent.md")).toBe(undefined);
  });

  test("a tombstone survives eviction and names who deleted the file", async () => {
    const storage = new MemoryStorage();
    await store(storage).generations.tombstone(
      record("000000000000002-000000001", {
        etag: undefined,
        generation: generation("000000000000002-000000001", {
          contentHash:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          size: 0,
        }),
      }),
    );

    const recovered = await store(storage).generations.current(
      ROOT,
      "skills/deploy/SKILL.md",
    );
    expect(recovered?.deleted).toBe(true);
    expect(recovered?.generation.writer).toEqual({
      kind: "user",
      userId: "user-1",
    });
  });

  test("a conflict is stored beside the current record, never over it", async () => {
    const { generations, storage } = store();
    await generations.record(record("000000000000001-000000001"));
    await generations.conflict(
      record("000000000000003-000000001", {
        etag: "etag-9",
        conflictKey: "workspace/root/file.conflict/000000000000003-000000001",
        generation: generation("000000000000003-000000001", {
          conflictsWith: "000000000000001-000000001",
        }),
      }),
    );

    const current = await generations.current(ROOT, "skills/deploy/SKILL.md");
    expect(current?.generation.generationId).toBe("000000000000001-000000001");
    const conflicts = await generations.conflicts(
      ROOT,
      "skills/deploy/SKILL.md",
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.generation.conflictsWith).toBe(
      "000000000000001-000000001",
    );
    expect(
      [...storage.values.keys()].some((key) =>
        key.startsWith(WORKSPACE_CONFLICT_PREFIX),
      ),
    ).toBe(true);
  });

  test("refuses to record a malformed generation record", async () => {
    const { generations } = store();
    await expect(
      generations.record({
        ...record("000000000000001-000000001"),
        path: "../escape.md",
      }),
    ).rejects.toThrow();
  });

  test("a very long path still yields a bounded storage key", () => {
    const tail = workspaceFileKeyTail(
      "bot-instructions:user-1:bot-1",
      `${"deep/".repeat(200)}file.md`,
    );
    expect(tail.length).toBeLessThanOrEqual(900);
    expect(tail).toContain("#");
  });
});

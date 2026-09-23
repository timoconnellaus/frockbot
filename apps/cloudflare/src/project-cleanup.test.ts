import { afterEach, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  createTestMemoryAuthorityV1,
  groupChatScopeV1,
  MemoryEngineV1,
  type MemorySqlValueV1,
} from "@frockbot/app/memory";
import { cleanRetiredProjectsV1 } from "./project-cleanup.js";

const GROUP_ID = "g-5c0015c0015c0015c001";
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function engine(): MemoryEngineV1 {
  const database = new Database(":memory:");
  databases.push(database);
  return new MemoryEngineV1({
    storage: {
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
      transactionSync: (callback) => database.transaction(callback)(),
    },
    ownedKinds: ["user", "groupChat"],
  });
}

function bucket(keys: string[]) {
  const objects = new Set(keys);
  return {
    objects,
    list: async (options: {
      prefix: string;
      limit: number;
      cursor?: string;
    }) => {
      // Like R2's, the cursor names where the last page ended, so a delete
      // between pages skips nothing.
      const matching = [...objects]
        .filter(
          (key) =>
            key.startsWith(options.prefix) &&
            (options.cursor === undefined || key > options.cursor),
        )
        .sort();
      const page = matching.slice(0, options.limit);
      const truncated = matching.length > options.limit;
      return {
        keys: page,
        truncated,
        ...(truncated ? { cursor: page.at(-1) } : {}),
      };
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
  };
}

test("everything a Project kept goes, and a Group Chat's Memory stays", async () => {
  const storage = new MemoryStorage();
  await storage.put({
    "memory:projects": { acme: { name: "Acme" } },
    "memory:projects:general": ["acme"],
    "memory:projects:general:rev": 3,
    "workspace:generation:project-memory:u1:acme:by-agent/general/profile.md":
      {},
    "workspace:conflict:project-memory:u1:acme:by-agent/general/profile.md:g1":
      {},
    "workspace:generation:user-memory:u1:by-agent/general/profile.md": {},
  });
  const memory = engine();
  const member = createTestMemoryAuthorityV1({
    userId: "u1",
    joinedGroupChatIds: ["acme", GROUP_ID],
  });
  for (const [groupChatId, content] of [
    ["acme", "The Acme launch is in May."],
    [GROUP_ID, "The offsite is in Bowral."],
  ] as const) {
    expect(
      memory.write({
        authority: member,
        scope: { kind: "groupChat", userId: "u1", groupChatId },
        content,
        operationKey: content,
      }).status,
    ).toBe("ok");
  }
  const objects = bucket([
    ...Array.from(
      { length: 120 },
      (_, index) =>
        `workspace/project-memory:u1:acme/by-agent/b${index}/profile.md`,
    ),
    "workspace/user-memory:u1/by-agent/general/profile.md",
  ]);

  await cleanRetiredProjectsV1(storage, {
    userId: "u1",
    bucket: objects,
    engine: memory,
  });

  expect([...storage.values.keys()].sort()).toEqual([
    "maintenance:project-removal:2026-09-23",
    "workspace:generation:user-memory:u1:by-agent/general/profile.md",
  ]);
  expect(memory.scopeKeysOfKind("groupChat")).toEqual([
    `groupChat:u1:${GROUP_ID}`,
  ]);
  expect(
    memory.recall({
      authority: member,
      query: "Bowral",
      scopes: [groupChatScopeV1("u1", GROUP_ID)],
    }).hits,
  ).toHaveLength(1);
  // Only the User Memory root's file is left.
  expect(objects.objects.size).toBe(1);
  expect(
    storage.values.get("maintenance:project-removal:2026-09-23"),
  ).toMatchObject({
    done: true,
    objects: 120,
    scopes: 1,
  });
});

test("a large root finishes over several wakes, then runs no more", async () => {
  const storage = new MemoryStorage();
  const objects = bucket(
    Array.from(
      { length: 450 },
      (_, index) =>
        `workspace/project-memory:u1:acme/${String(index).padStart(4, "0")}.md`,
    ),
  );
  await cleanRetiredProjectsV1(storage, { userId: "u1", bucket: objects });
  expect(objects.objects.size).toBe(250);
  expect(
    storage.values.get("maintenance:project-removal:2026-09-23"),
  ).toMatchObject({
    done: false,
  });
  await cleanRetiredProjectsV1(storage, { userId: "u1", bucket: objects });
  expect(objects.objects.size).toBe(50);
  await cleanRetiredProjectsV1(storage, { userId: "u1", bucket: objects });
  expect(objects.objects.size).toBe(0);
  objects.objects.add("workspace/project-memory:u1:late/profile.md");
  await cleanRetiredProjectsV1(storage, { userId: "u1", bucket: objects });
  expect(objects.objects.size).toBe(1);
});

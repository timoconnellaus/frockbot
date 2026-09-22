import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { MemoryEngineV1 } from "./engine.ts";
import { MemoryRecordsV1, inProcessMemoryRemoteV1 } from "./owner.ts";
import {
  groupChatScopeFromProjectV1,
  productScopeToEngineV1,
  type MemoryAuthorityV1,
  type MemoryScopeRefV1,
} from "./records.ts";
import type { MemorySqlStorageV1, MemorySqlValueV1 } from "./sql.ts";
import { createTestMemoryAuthorityV1 } from "./testing.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function storage(): MemorySqlStorageV1 & {
  alarmAt: number | null;
  database: Database;
} {
  const database = new Database(":memory:");
  databases.push(database);
  const handle = {
    alarmAt: null as number | null,
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
    getAlarm(): number | null {
      return handle.alarmAt;
    },
    setAlarm(at: number): void {
      handle.alarmAt = at;
    },
  };
  return handle;
}

function engine(
  extras: { onTransactionStep?: (step: string) => void; at?: Date } = {},
) {
  const sql = storage();
  const at = extras.at ?? new Date("2026-09-22T10:00:00.000Z");
  return {
    sql,
    engine: new MemoryEngineV1({
      storage: sql,
      now: () => at,
      ...(extras.onTransactionStep
        ? { onTransactionStep: extras.onTransactionStep }
        : {}),
    }),
    at,
  };
}

const BOT: MemoryScopeRefV1 = {
  kind: "bot",
  userId: "user-1",
  botId: "bot-1",
};
const USER: MemoryScopeRefV1 = { kind: "user", userId: "user-1" };
const GROUP = groupChatScopeFromProjectV1("user-1", "school");

function auth(overrides: Partial<MemoryAuthorityV1> = {}): MemoryAuthorityV1 {
  return createTestMemoryAuthorityV1(overrides);
}

describe("canonical Memory write and recall", () => {
  test("exact and lexical read-after-write works without Vectorize", () => {
    const { engine: store } = engine();
    const authority = auth();
    const written = store.write({
      authority,
      scope: BOT,
      content: "Tim lives in Wollongong.",
      operationKey: "write-1",
      sources: [
        {
          sourceId: "src-chat-1",
          sourceRevision: "1",
          kind: "chat",
          locator: {
            kind: "chat",
            botId: "bot-1",
            sessionId: "s1",
            runId: "r1",
            eventSeq: 4,
            revision: "1",
          },
          safeExcerpt: "I live in Wollongong.",
        },
      ],
    });
    expect(written.status).toBe("ok");
    if (written.status !== "ok") throw new Error("unreachable");
    const exact = store.recall({
      authority,
      query: "Tim lives in Wollongong.",
      scopes: [BOT],
    });
    expect(exact.status).toBe("complete");
    expect(exact.hits.map((hit) => hit.item.text)).toEqual([
      "Tim lives in Wollongong.",
    ]);
    const lexical = store.recall({
      authority,
      query: "Wollongong",
      scopes: [BOT],
    });
    expect(lexical.hits.map((hit) => hit.item.id)).toEqual([
      written.receipt.itemId,
    ]);
  });

  test("duplicate operation keys return one result", () => {
    const { engine: store } = engine();
    const authority = auth();
    const first = store.write({
      authority,
      scope: BOT,
      content: "Term ends on the 12th.",
      operationKey: "same-key",
    });
    const second = store.write({
      authority,
      scope: BOT,
      content: "A different sentence that must not land.",
      operationKey: "same-key",
    });
    expect(first).toEqual(second);
    const recalled = store.recall({
      authority,
      query: "Term ends",
      scopes: [BOT],
    });
    expect(recalled.hits).toHaveLength(1);
    expect(recalled.hits[0]?.item.text).toBe("Term ends on the 12th.");
  });

  test("the same canonical text in one scope is one item", () => {
    const { engine: store } = engine();
    const authority = auth();
    const first = store.write({
      authority,
      scope: BOT,
      content: "Tim prefers blunt answers.",
      operationKey: "a",
    });
    const second = store.write({
      authority,
      scope: BOT,
      content: "Tim prefers blunt answers.",
      operationKey: "b",
    });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") {
      throw new Error("unreachable");
    }
    expect(second.receipt.duplicate).toBe(true);
    expect(second.receipt.itemId).toBe(first.receipt.itemId);
  });

  test("refuses a credential-shaped fact and writes nothing", () => {
    const { engine: store } = engine();
    const authority = auth();
    const refused = store.write({
      authority,
      scope: BOT,
      content: "The key is sk-abcdefghijklmnopqrstuvwxyz.",
      operationKey: "secret",
    });
    expect(refused).toMatchObject({ status: "refused" });
    if (refused.status !== "refused") throw new Error("unreachable");
    expect(refused.reason).toContain("no secrets");
    expect(
      store.recall({ authority, query: "key", scopes: [BOT] }).hits,
    ).toEqual([]);
  });
});

describe("scope and membership isolation", () => {
  test("separate Bot scopes cannot leak", () => {
    const { engine: store } = engine();
    store.write({
      authority: auth(),
      scope: BOT,
      content: "Private to bot-1.",
      operationKey: "bot-1-private",
    });
    const other = auth({ botId: "bot-2" });
    const otherScope: MemoryScopeRefV1 = {
      kind: "bot",
      userId: "user-1",
      botId: "bot-2",
    };
    store.write({
      authority: other,
      scope: otherScope,
      content: "Private to bot-2.",
      operationKey: "bot-2-private",
    });
    const leaked = store.recall({
      authority: other,
      query: "bot-1",
      scopes: [BOT],
    });
    expect(leaked.status).toBe("refused");
    expect(leaked.hits).toEqual([]);
    const own = store.recall({
      authority: other,
      query: "bot-2",
      scopes: [otherScope],
    });
    expect(own.hits.map((hit) => hit.item.text)).toEqual(["Private to bot-2."]);
  });

  test("unjoined Group Chat membership cannot read or write", () => {
    const { engine: store } = engine();
    const member = auth({ joinedGroupChatIds: ["school"] });
    const outsider = auth({ botId: "bot-2", joinedGroupChatIds: [] });
    const written = store.write({
      authority: member,
      scope: GROUP,
      content: "Assembly is on Friday.",
      operationKey: "school-1",
    });
    expect(written.status).toBe("ok");
    expect(
      store.write({
        authority: outsider,
        scope: GROUP,
        content: "Forged shared fact.",
        operationKey: "forge",
      }).status,
    ).toBe("refused");
    const leaked = store.recall({
      authority: outsider,
      query: "Assembly",
      scopes: [GROUP],
    });
    expect(leaked.status).toBe("refused");
    expect(leaked.hits).toEqual([]);
  });

  test("project ids map to groupChat in one adapter", () => {
    expect(
      productScopeToEngineV1(
        "project",
        { userId: "user-1", botId: "bot-1" },
        "school",
      ),
    ).toEqual(GROUP);
    expect(GROUP.kind).toBe("groupChat");
  });
});

describe("correction and forget", () => {
  test("a correction preserves provenance and hides the replaced assertion", () => {
    const { engine: store } = engine();
    const authority = auth();
    const original = store.write({
      authority,
      scope: BOT,
      content: "Tim teaches on Tuesdays.",
      operationKey: "orig",
      sources: [
        {
          sourceId: "src-1",
          sourceRevision: "1",
          kind: "explicit",
          locator: { kind: "explicit", revision: "1" },
          safeExcerpt: "teaches on Tuesdays",
        },
      ],
    });
    expect(original.status).toBe("ok");
    if (original.status !== "ok") throw new Error("unreachable");
    const correction = store.write({
      authority,
      scope: BOT,
      content: "Tim teaches on Thursdays.",
      operationKey: "corr",
      replaces: original.receipt.itemId,
      sources: [
        {
          sourceId: "src-2",
          sourceRevision: "1",
          kind: "explicit",
          locator: { kind: "explicit", revision: "1" },
          safeExcerpt: "teaches on Thursdays",
        },
      ],
    });
    expect(correction.status).toBe("ok");
    const recalled = store.recall({
      authority,
      query: "teaches",
      scopes: [BOT],
    });
    expect(recalled.hits.map((hit) => hit.item.text)).toEqual([
      "Tim teaches on Thursdays.",
    ]);
    const expanded = store.expand({
      authority,
      sourceRefs: [
        { scope: BOT, itemId: original.receipt.itemId },
        {
          scope: BOT,
          itemId: correction.status === "ok" ? correction.receipt.itemId : "",
        },
      ],
    });
    expect(
      expanded.omissions.some((entry) => entry.ref === original.receipt.itemId),
    ).toBe(true);
    expect(
      expanded.evidence.some((entry) => entry.excerpt?.includes("Thursdays")),
    ).toBe(true);
  });

  test("forgotten evidence cannot return through recall, browse, or replay", () => {
    const { engine: store } = engine();
    const authority = auth();
    const written = store.write({
      authority,
      scope: USER,
      content: "The gym opens at six.",
      operationKey: "gym",
      sources: [
        {
          sourceId: "src-gym",
          sourceRevision: "1",
          kind: "chat",
          locator: {
            kind: "chat",
            botId: "bot-1",
            sessionId: "s",
            runId: "r",
            eventSeq: 1,
            revision: "1",
          },
          safeExcerpt: "gym opens at six",
        },
      ],
    });
    expect(written.status).toBe("ok");
    if (written.status !== "ok") throw new Error("unreachable");
    const forgotten = store.forget({
      authority,
      scope: USER,
      operationKey: "forget-gym",
      itemId: written.receipt.itemId,
    });
    expect(forgotten.status).toBe("ok");
    expect(
      store.recall({
        authority,
        query: "gym opens",
        scopes: [USER],
      }).hits,
    ).toEqual([]);
    expect(
      store
        .browse({ authority, scope: USER })
        .sections.flatMap((section) => section.items.map((item) => item.id)),
    ).not.toContain(written.receipt.itemId);
    const replay = store.write({
      authority,
      scope: USER,
      content: "The gym opens at six.",
      operationKey: "extract-replay",
    });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") throw new Error("unreachable");
    expect(replay.receipt.suppressedOverride).toBe(true);
    expect(
      store
        .recall({
          authority,
          query: "gym opens",
          scopes: [USER],
        })
        .hits.map((hit) => hit.item.text),
    ).toEqual(["The gym opens at six."]);
  });

  test("a Bot cannot forget another Bot's shared evidence", () => {
    const { engine: store } = engine();
    const author = auth();
    const written = store.write({
      authority: author,
      scope: USER,
      content: "Shared by bot-1.",
      operationKey: "shared",
    });
    expect(written.status).toBe("ok");
    if (written.status !== "ok") throw new Error("unreachable");
    const other = auth({ botId: "bot-2" });
    const refused = store.forget({
      authority: other,
      scope: USER,
      operationKey: "other-forget",
      itemId: written.receipt.itemId,
    });
    expect(refused.status).toBe("refused");
    const user = auth({ actor: "user" });
    const forgotten = store.forget({
      authority: user,
      scope: USER,
      operationKey: "user-forget",
      itemId: written.receipt.itemId,
    });
    expect(forgotten.status).toBe("ok");
  });
});

describe("expansion authorization", () => {
  test("arbitrary source ids cannot bypass expansion authorization", () => {
    const { engine: store } = engine();
    const authority = auth();
    store.write({
      authority,
      scope: BOT,
      content: "A private quote.",
      operationKey: "private-src",
      sources: [
        {
          sourceId: "secret-source",
          sourceRevision: "9",
          kind: "chat",
          locator: {
            kind: "chat",
            botId: "bot-1",
            sessionId: "s",
            runId: "r",
            eventSeq: 8,
            revision: "9",
          },
          safeExcerpt: "the private quote",
        },
      ],
    });
    const outsider = auth({ botId: "bot-2" });
    const expanded = store.expand({
      authority: outsider,
      sourceRefs: [
        {
          scope: BOT,
          sourceId: "secret-source",
          sourceRevision: "9",
        },
      ],
    });
    expect(expanded.status).toBe("refused");
    expect(expanded.evidence).toEqual([]);
    expect(expanded.omissions[0]?.reason).toContain("own Bot");
  });
});

describe("eviction, rollback, and wakeup", () => {
  test("rows survive a new engine over the same database", () => {
    const sql = storage();
    const first = new MemoryEngineV1({
      storage: sql,
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    });
    const authority = auth();
    const written = first.write({
      authority,
      scope: BOT,
      content: "Survives eviction.",
      operationKey: "evict",
    });
    expect(written.status).toBe("ok");
    const cold = new MemoryEngineV1({ storage: sql });
    const recalled = cold.recall({
      authority,
      query: "Survives",
      scopes: [BOT],
    });
    expect(recalled.hits.map((hit) => hit.item.text)).toEqual([
      "Survives eviction.",
    ]);
  });

  test("a throw inside the owner transaction rolls back the mutation", () => {
    const { engine: store } = engine({
      onTransactionStep: (step) => {
        if (step === "fts") throw new Error("injected crash");
      },
    });
    const authority = auth();
    const outcome = store.write({
      authority,
      scope: BOT,
      content: "Must not persist.",
      operationKey: "crash-write",
    });
    expect(outcome.status).toBe("unavailable");
    const clean = engine().engine;
    // Same logical store is crashed; prove a fresh engine on a new db is empty
    // and that the crashed engine's own recall also finds nothing.
    expect(
      store.recall({ authority, query: "persist", scopes: [BOT] }).hits,
    ).toEqual([]);
    expect(
      clean.recall({ authority, query: "persist", scopes: [BOT] }).hits,
    ).toEqual([]);
  });

  test("a job is durable before alarm arming, and eviction re-arms from the due index", () => {
    const sql = storage();
    let failAlarm = true;
    const armed: { alarmAt: number | null } = { alarmAt: null };
    const crashing: MemorySqlStorageV1 = {
      sql: sql.sql,
      transactionSync: (callback) => sql.transactionSync(callback),
      getAlarm: () => armed.alarmAt,
      setAlarm: (at) => {
        if (failAlarm) throw new Error("alarm lost");
        armed.alarmAt = at;
      },
    };
    const first = new MemoryEngineV1({
      storage: crashing,
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    });
    const authority = auth();
    const written = first.write({
      authority,
      scope: BOT,
      content: "Needs an index.",
      operationKey: "wakeup",
    });
    expect(written.status).toBe("ok");
    expect(
      first.recall({ authority, query: "index", scopes: [BOT] }).hits,
    ).toHaveLength(1);
    expect(first.nextWakeupAt()).toBeGreaterThan(0);
    failAlarm = false;
    const cold = new MemoryEngineV1({ storage: crashing });
    expect(armed.alarmAt).toBeNull();
    cold.ensureWakeup();
    expect(armed.alarmAt).toBe(cold.nextWakeupAt() ?? null);
  });
});

describe("Bot plus User owner facade", () => {
  test("chat reads Bot-local state and one User RPC for shared scopes", async () => {
    const botSql = storage();
    const userSql = storage();
    const botEngine = new MemoryEngineV1({
      storage: botSql,
      ownedKinds: ["bot"],
    });
    const userEngine = new MemoryEngineV1({
      storage: userSql,
      ownedKinds: ["user", "groupChat"],
    });
    const records = new MemoryRecordsV1({
      owner: "bot",
      engine: botEngine,
      remote: inProcessMemoryRemoteV1(userEngine),
    });
    const member = auth({ joinedGroupChatIds: ["school"] });
    await records.write({
      authority: member,
      scope: BOT,
      content: "Bot-local fact.",
      operationKey: "local",
    });
    await records.write({
      authority: member,
      scope: USER,
      content: "User-shared fact.",
      operationKey: "user",
    });
    await records.write({
      authority: member,
      scope: GROUP,
      content: "School assembly Friday.",
      operationKey: "group",
    });
    const recalled = await records.recall({
      authority: member,
      query: "fact",
      scopes: [BOT, USER, GROUP],
    });
    expect(recalled.hits.map((hit) => hit.item.text).sort()).toEqual([
      "Bot-local fact.",
      "User-shared fact.",
    ]);
    const school = await records.recall({
      authority: member,
      query: "assembly",
      scopes: [GROUP],
    });
    expect(school.hits.map((hit) => hit.item.text)).toEqual([
      "School assembly Friday.",
    ]);
    expect(
      botEngine.recall({
        authority: member,
        query: "User-shared",
        scopes: [USER],
      }).status,
    ).toBe("refused");
  });
});

describe("browse and prepared core", () => {
  test("browse pages canonical items and validates a section manifest", () => {
    const { engine: store } = engine();
    const authority = auth();
    store.write({
      authority,
      scope: BOT,
      content: "First dated experience.",
      operationKey: "e1",
      kind: "experience",
      subjectKey: "gym",
    });
    store.write({
      authority,
      scope: BOT,
      content: "Second dated experience.",
      operationKey: "e2",
      kind: "experience",
      subjectKey: "gym",
    });
    const page = store.browse({
      authority,
      scope: BOT,
      topic: "gym",
    });
    expect(page.status).toBe("complete");
    expect(page.sections).toHaveLength(1);
    expect(page.sections[0]?.items).toHaveLength(2);
    expect(page.sections[0]?.manifest).toHaveLength(2);
  });

  test("prepared core is omitted until a projection exists", () => {
    const { engine: store } = engine();
    const core = store.preparedCore({
      authority: auth(),
      scopes: [BOT],
    });
    expect(core.status).toBe("empty");
    expect(core.blocks).toEqual([]);
    expect(core.omissions[0]?.reason).toContain("not available");
  });
});

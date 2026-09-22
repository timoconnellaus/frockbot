import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { MemoryEngineV1 } from "./engine.ts";
import { drainMemoryProcessingV1 } from "./processing.ts";
import type { MemoryProcessingAdaptersV1 } from "./processing.ts";
import {
  groupChatScopeFromProjectV1,
  MEMORY_JOB_WAKEUP_MS_V1,
  type MemoryAuthorityV1,
  type MemoryJobPrincipalV1,
  type MemoryScopeRefV1,
  type MemorySourceInputV1,
} from "./records.ts";
import type { MemorySqlStorageV1, MemorySqlValueV1 } from "./sql.ts";
import { createTestMemoryAuthorityV1 } from "./testing.ts";
import type { MemoryVectorIndex } from "./types.ts";

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

function clock(at = new Date("2026-09-22T10:00:00.000Z")) {
  const handle = { at };
  return {
    handle,
    now: () => handle.at,
    advance(ms: number) {
      handle.at = new Date(handle.at.getTime() + ms);
    },
  };
}

function engineOf(owned?: readonly ("bot" | "user" | "groupChat")[]) {
  const sql = storage();
  const time = clock();
  const engine = new MemoryEngineV1({
    storage: sql,
    now: time.now,
    ...(owned ? { ownedKinds: owned } : {}),
  });
  return { sql, time, engine };
}

const BOT: MemoryScopeRefV1 = {
  kind: "bot",
  userId: "user-1",
  botId: "bot-1",
};
const USER: MemoryScopeRefV1 = { kind: "user", userId: "user-1" };
const GROUP = groupChatScopeFromProjectV1("user-1", "school");
const PRINCIPAL: MemoryJobPrincipalV1 = {
  userId: "user-1",
  botId: "bot-1",
  actor: "bot",
  turnId: "turn-1",
};

function auth(overrides: Partial<MemoryAuthorityV1> = {}): MemoryAuthorityV1 {
  return createTestMemoryAuthorityV1(overrides);
}

function chatSource(
  extras: Partial<MemorySourceInputV1> & { capturedText: string },
): MemorySourceInputV1 & { capturedText: string } {
  return {
    sourceId: extras.sourceId ?? "src-1",
    sourceRevision: extras.sourceRevision ?? "1",
    kind: extras.kind ?? "chat",
    locator: extras.locator ?? {
      kind: "chat",
      botId: "bot-1",
      sessionId: "s1",
      runId: "r1",
      eventSeq: 4,
      revision: extras.sourceRevision ?? "1",
    },
    capturedText: extras.capturedText,
    ...(extras.safeExcerpt ? { safeExcerpt: extras.safeExcerpt } : {}),
  };
}

function fakeVectors(): MemoryVectorIndex & {
  upserts: string[];
  deletes: string[];
  fail?: "upsert" | "delete";
} {
  const handle: MemoryVectorIndex & {
    upserts: string[];
    deletes: string[];
    fail?: "upsert" | "delete";
  } = {
    upserts: [],
    deletes: [],
    async upsert(vectors) {
      if (handle.fail === "upsert") throw new Error("upsert failed");
      handle.upserts.push(...vectors.map((vector) => vector.id));
      return { mutationId: `mut-${handle.upserts.length}` };
    },
    async query() {
      return { matches: [] };
    },
    async deleteByIds(ids) {
      if (handle.fail === "delete") throw new Error("delete failed");
      handle.deletes.push(...ids);
      return { mutationId: `del-${handle.deletes.length}` };
    },
  };
  return handle;
}

async function drainDue(
  engine: MemoryEngineV1,
  time: ReturnType<typeof clock>,
  adapters?: MemoryProcessingAdaptersV1,
) {
  time.advance(MEMORY_JOB_WAKEUP_MS_V1 + 1);
  return drainMemoryProcessingV1(engine, adapters ?? {}, time.now());
}

describe("extraction obligations", () => {
  test("duplicate capture and delayed drain do not duplicate facts or spend", async () => {
    const { engine, time } = engineOf();
    const authority = auth();
    const source = chatSource({
      capturedText: "Tim lives in Wollongong and prefers blunt answers.",
    });
    const first = engine.captureExtraction({
      authority,
      scope: BOT,
      principal: PRINCIPAL,
      source,
    });
    const second = engine.captureExtraction({
      authority,
      scope: BOT,
      principal: PRINCIPAL,
      source,
    });
    expect(first).toMatchObject({ status: "ok", duplicate: false });
    expect(second).toMatchObject({ status: "ok", duplicate: true });
    let calls = 0;
    const adapters = {
      extract: async () => {
        calls += 1;
        return [
          {
            text: "Tim lives in Wollongong.",
            kind: "fact" as const,
            subjectKey: "profile",
          },
        ];
      },
    };
    await drainDue(engine, time, adapters);
    await drainDue(engine, time, adapters);
    expect(calls).toBe(1);
    const recalled = engine.recall({
      authority,
      query: "Wollongong",
      scopes: [BOT],
    });
    expect(recalled.hits.map((hit) => hit.item.text)).toEqual([
      "Tim lives in Wollongong.",
    ]);
  });

  test("a late extract result cannot overwrite a corrected successor", async () => {
    const { engine, time } = engineOf();
    const authority = auth();
    engine.captureExtraction({
      authority,
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Tim lives in Sydney." }),
    });
    await drainDue(engine, time, {
      extract: async () => [
        { text: "Tim lives in Sydney.", kind: "fact", subjectKey: "profile" },
      ],
    });
    const original = engine.recall({
      authority,
      query: "Sydney",
      scopes: [BOT],
    }).hits[0];
    expect(original).toBeDefined();
    engine.write({
      authority,
      scope: BOT,
      content: "Tim lives in Wollongong.",
      operationKey: "correct-1",
      replaces: original?.item.id,
      subjectKey: "profile",
    });
    const extractJob = engine
      .inspectJobs()
      .find((job) => job.kind === "extract");
    expect(extractJob?.state).toBe("done");
    engine.applyExtractedProposals(
      {
        id: extractJob?.id ?? "",
        kind: "extract",
        scopeKey: "bot:user-1:bot-1",
        scope: BOT,
        sourceRef: extractJob?.sourceRef,
        inputGeneration: extractJob?.inputGeneration ?? 0,
        attempt: 1,
        claimToken: "stale",
        principal: PRINCIPAL,
        authority,
      },
      [{ text: "Tim lives in Sydney.", kind: "fact", subjectKey: "profile" }],
    );
    const recalled = engine.recall({
      authority,
      query: "lives",
      scopes: [BOT],
    });
    expect(recalled.hits.map((hit) => hit.item.text)).toEqual([
      "Tim lives in Wollongong.",
    ]);
  });

  test("forgotten sources block extraction and consolidation reintroduction", async () => {
    const { engine, time } = engineOf();
    const authority = auth();
    engine.captureExtraction({
      authority,
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "The dog is named Maple." }),
    });
    await drainDue(engine, time, {
      extract: async () => [
        { text: "The dog is named Maple.", kind: "fact", subjectKey: "pets" },
      ],
    });
    engine.forget({
      authority,
      scope: BOT,
      operationKey: "forget-maple",
      exactKey: "The dog is named Maple.",
    });
    engine.captureExtraction({
      authority,
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({
        sourceId: "src-replay",
        sourceRevision: "2",
        capturedText: "Remember Maple the dog.",
      }),
    });
    await drainDue(engine, time, {
      extract: async () => [
        { text: "The dog is named Maple.", kind: "fact", subjectKey: "pets" },
      ],
    });
    expect(
      engine.recall({ authority, query: "Maple", scopes: [BOT] }).hits,
    ).toEqual([]);
  });

  test("retry exhaustion retains captured source", async () => {
    const { engine, time } = engineOf();
    engine.captureExtraction({
      authority: auth(),
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Keep this transcript." }),
    });
    const job = engine.inspectJobs().find((row) => row.kind === "extract");
    expect(job).toBeDefined();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      time.advance(MEMORY_JOB_WAKEUP_MS_V1 + 301_000);
      await drainMemoryProcessingV1(engine, {}, time.now());
    }
    const retained = engine.inspectRetention();
    expect(retained[0]?.state).toBe("retained");
    expect(
      engine.inspectJobs().find((row) => row.kind === "extract")?.state,
    ).not.toBe("done");
  });

  test("an authenticated User can abandon an unfinished obligation", () => {
    const { engine } = engineOf();
    const captured = engine.captureExtraction({
      authority: auth(),
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Abandon me." }),
    });
    expect(captured.status).toBe("ok");
    if (captured.status !== "ok") throw new Error("unreachable");
    const abandoned = engine.abandonObligation({
      authority: auth({ actor: "user" }),
      obligationId: captured.obligationId,
    });
    expect(abandoned).toEqual({ status: "ok", abandoned: true });
    expect(engine.inspectRetention()[0]?.state).toBe("released");
  });
});

describe("prepared core and topic pages", () => {
  test("core and topic pages have complete valid manifests", async () => {
    const { engine, time } = engineOf();
    const authority = auth();
    engine.write({
      authority,
      scope: BOT,
      content: "Tim prefers blunt answers.",
      operationKey: "p1",
      subjectKey: "profile",
    });
    engine.write({
      authority,
      scope: BOT,
      content: "Gym on Tuesdays.",
      operationKey: "e1",
      kind: "experience",
      subjectKey: "gym",
    });
    await drainDue(engine, time);
    await drainDue(engine, time);
    const core = engine.preparedCore({ authority, scopes: [BOT] });
    expect(core.status).toBe("complete");
    expect(core.blocks).toHaveLength(1);
    expect(core.blocks[0]?.manifest.length).toBeGreaterThan(0);
    expect(core.blocks[0]?.text).toContain("Tim prefers blunt answers.");
    const page = engine.browse({ authority, scope: BOT, topic: "gym" });
    expect(page.status).toBe("complete");
    expect(page.sections[0]?.manifest.length).toBeGreaterThan(0);
    expect(page.sections[0]?.items.map((item) => item.text)).toEqual([
      "Gym on Tuesdays.",
    ]);
  });

  test("an additive write leaves a valid older core until rebuild", () => {
    const { engine } = engineOf();
    const authority = auth();
    engine.write({
      authority,
      scope: BOT,
      content: "Tim prefers blunt answers.",
      operationKey: "p1",
      subjectKey: "profile",
    });
    engine.rebuildCore("bot:user-1:bot-1");
    const before = engine.preparedCore({ authority, scopes: [BOT] });
    engine.write({
      authority,
      scope: BOT,
      content: "Tim drinks tea.",
      operationKey: "p2",
      subjectKey: "profile",
    });
    const after = engine.preparedCore({ authority, scopes: [BOT] });
    expect(after.status).toBe("complete");
    expect(after.blocks[0]?.text).toBe(before.blocks[0]?.text);
    expect(after.blocks[0]?.text).not.toContain("tea");
  });

  test("forget fences an invalid core instead of returning stale leaves", async () => {
    const { engine, time } = engineOf();
    const authority = auth();
    engine.write({
      authority,
      scope: BOT,
      content: "Secret nickname is Skip.",
      operationKey: "p1",
      subjectKey: "profile",
    });
    await drainDue(engine, time);
    expect(
      engine.preparedCore({ authority, scopes: [BOT] }).blocks[0]?.text,
    ).toContain("Skip");
    engine.forget({
      authority,
      scope: BOT,
      operationKey: "forget-skip",
      exactKey: "Secret nickname is Skip.",
    });
    const fenced = engine.preparedCore({ authority, scopes: [BOT] });
    expect(fenced.blocks).toEqual([]);
    expect(fenced.omissions[0]?.reason).toContain("no longer valid");
  });
});

describe("indexing and degraded semantic status", () => {
  test("failed embeddings keep exact recall and report unconfirmed coverage", async () => {
    const { engine, time } = engineOf();
    const authority = auth();
    engine.write({
      authority,
      scope: BOT,
      content: "Exact names still work.",
      operationKey: "w1",
    });
    const vectors = fakeVectors();
    vectors.fail = "upsert";
    await drainDue(engine, time);
    for (let step = 0; step < 4; step += 1) {
      const indexing = await drainDue(engine, time, {
        embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
        vectors,
      });
      if (indexing.kind === "index") break;
    }
    const recalled = engine.recall({
      authority,
      query: "Exact names still work.",
      scopes: [BOT],
    });
    expect(recalled.hits).toHaveLength(1);
    expect(recalled.semanticCoverage).toBe("unconfirmed");
  });

  test("a delayed vector delete cannot resurrect a forgotten fact", async () => {
    const { engine, time } = engineOf();
    const authority = auth();
    engine.write({
      authority,
      scope: BOT,
      content: "Forgettable fact.",
      operationKey: "w1",
    });
    engine.forget({
      authority,
      scope: BOT,
      operationKey: "forget-1",
      exactKey: "Forgettable fact.",
    });
    const vectors = fakeVectors();
    await drainDue(engine, time);
    await drainDue(engine, time, {
      embed: async (texts) => texts.map(() => [1, 0]),
      vectors,
    });
    expect(
      engine.recall({ authority, query: "Forgettable", scopes: [BOT] }).hits,
    ).toEqual([]);
    const tombstones = engine
      .inspectIndexIntents()
      .filter((intent) => intent.operation === "delete");
    expect(tombstones.length).toBeGreaterThan(0);
  });
});

describe("wakeup, eviction and isolation", () => {
  test("maintenance progresses after eviction without another message", async () => {
    const sql = storage();
    const time = clock();
    const first = new MemoryEngineV1({ storage: sql, now: time.now });
    first.write({
      authority: auth(),
      scope: BOT,
      content: "Needs a core.",
      operationKey: "w1",
      subjectKey: "profile",
    });
    expect(sql.alarmAt).toBeGreaterThan(0);
    const cold = new MemoryEngineV1({ storage: sql, now: time.now });
    sql.alarmAt = null;
    cold.ensureWakeup();
    const due = cold.nextWakeupAt();
    if (sql.alarmAt === null) throw new Error("alarm was not re-armed");
    if (due === undefined) throw new Error("due index was empty");
    expect(sql.alarmAt === due).toBe(true);
    time.advance(MEMORY_JOB_WAKEUP_MS_V1 + 1);
    await drainMemoryProcessingV1(cold, {}, time.now());
    const core = cold.preparedCore({ authority: auth(), scopes: [BOT] });
    expect(core.status).toBe("complete");
    expect(core.blocks[0]?.text).toContain("Needs a core.");
  });

  test("a stale claim cannot commit after eviction re-claims the job", async () => {
    const { engine, time } = engineOf();
    engine.captureExtraction({
      authority: auth(),
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Claim fence." }),
    });
    time.advance(MEMORY_JOB_WAKEUP_MS_V1 + 1);
    const first = engine.claimDueWork(time.now());
    expect(first.kind).toBe("external");
    if (first.kind !== "external") throw new Error("unreachable");
    const stale = first.jobs[0];
    time.advance(300_000);
    const second = engine.claimDueWork(time.now());
    expect(second.kind).toBe("external");
    expect(engine.completeClaimedJob(stale!, "done")).toBe(false);
  });

  test("Bot and User scopes stay isolated across owners", async () => {
    const bot = engineOf(["bot"]);
    const user = engineOf(["user", "groupChat"]);
    const member = auth({ joinedGroupChatIds: ["school"] });
    bot.engine.captureExtraction({
      authority: member,
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Private Bot note." }),
    });
    user.engine.captureExtraction({
      authority: member,
      scope: USER,
      principal: PRINCIPAL,
      source: chatSource({
        sourceId: "src-user",
        capturedText: "User-wide preference.",
      }),
    });
    user.engine.captureExtraction({
      authority: member,
      scope: GROUP,
      principal: PRINCIPAL,
      source: chatSource({
        sourceId: "src-group",
        capturedText: "School assembly Friday.",
      }),
    });
    await drainDue(bot.engine, bot.time, {
      extract: async () => [
        { text: "Private Bot note.", kind: "fact", subjectKey: "profile" },
      ],
    });
    await drainDue(user.engine, user.time, {
      extract: async (input) =>
        input.scope.kind === "groupChat"
          ? [
              {
                text: "School assembly Friday.",
                kind: "experience" as const,
                subjectKey: "school",
              },
            ]
          : [
              {
                text: "User-wide preference.",
                kind: "fact" as const,
                subjectKey: "preference",
              },
            ],
    });
    for (let step = 0; step < 6; step += 1) {
      await drainDue(user.engine, user.time, {
        extract: async (input) =>
          input.scope.kind === "groupChat"
            ? [
                {
                  text: "School assembly Friday.",
                  kind: "experience" as const,
                  subjectKey: "school",
                },
              ]
            : [
                {
                  text: "User-wide preference.",
                  kind: "fact" as const,
                  subjectKey: "preference",
                },
              ],
      });
    }
    expect(
      bot.engine.recall({
        authority: member,
        query: "preference",
        scopes: [USER],
      }).status,
    ).toBe("refused");
    expect(
      user.engine.recall({
        authority: member,
        query: "Private",
        scopes: [BOT],
      }).status,
    ).toBe("refused");
    expect(
      user.engine
        .recall({
          authority: member,
          query: "assembly",
          scopes: [GROUP],
        })
        .hits.map((hit) => hit.item.text),
    ).toEqual(["School assembly Friday."]);
    expect(
      user.engine.recall({
        authority: auth(),
        query: "assembly",
        scopes: [GROUP],
      }).status,
    ).toBe("refused");
  });

  test("outbox admit is idempotent and releases source retention after ack", async () => {
    const source = engineOf(["bot"]);
    const dest = engineOf(["user", "groupChat"]);
    const authority = auth();
    const captured = source.engine.captureExtraction({
      authority,
      scope: BOT,
      destinationScope: USER,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Promote this to User memory." }),
    });
    expect(captured).toMatchObject({ status: "ok", queued: "outbox" });
    if (captured.status !== "ok") throw new Error("unreachable");
    const payload = source.engine.outboxPayload(captured.obligationId);
    expect(payload).toBeDefined();
    const first = dest.engine.admitOutbox({
      outboxId: captured.obligationId,
      payload: payload!,
    });
    const second = dest.engine.admitOutbox({
      outboxId: captured.obligationId,
      payload: payload!,
    });
    expect(first).toMatchObject({ status: "ok", duplicate: false });
    expect(second).toMatchObject({ status: "ok", duplicate: true });
    source.engine.acknowledgeOutbox(captured.obligationId);
    expect(source.engine.inspectRetention()[0]?.state).toBe("released");
    expect(source.engine.inspectOutbox()[0]?.state).toBe("acked");
  });

  test("loss of principal blocks dispatch without discarding retained source", async () => {
    const { engine, time } = engineOf();
    engine.captureExtraction({
      authority: auth(),
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Needs the original Bot." }),
    });
    await drainDue(engine, time, {
      principalExists: async () => false,
      extract: async () => {
        throw new Error("must not spend");
      },
    });
    expect(
      engine.inspectJobs().find((job) => job.kind === "extract")?.state,
    ).toBe("blocked");
    expect(engine.inspectRetention()[0]?.state).toBe("retained");
  });
});

describe("consolidation inherits the source principal", () => {
  test("subject consolidation uses the extract job principal, not a drain-time Bot", async () => {
    const { engine, time } = engineOf();
    const seen: MemoryJobPrincipalV1[] = [];
    engine.captureExtraction({
      authority: auth(),
      scope: BOT,
      principal: PRINCIPAL,
      source: chatSource({ capturedText: "Maple is the dog. Maple is loud." }),
    });
    await drainDue(engine, time, {
      extract: async () => [
        { text: "Maple is the dog.", kind: "fact", subjectKey: "pets" },
        { text: "Maple is loud.", kind: "fact", subjectKey: "pets" },
      ],
    });
    for (let step = 0; step < 6 && seen.length === 0; step += 1) {
      await drainDue(engine, time, {
        consolidate: async (input) => {
          seen.push(input.principal);
          return {
            text: "Maple is a loud dog.",
            subjectKey: "pets",
            leafItemIds: input.items.map((item) => item.itemId),
            relations: input.items.map((item) => ({
              relation: "supports" as const,
              toId: item.itemId,
            })),
          };
        },
      });
    }
    expect(seen).toEqual([PRINCIPAL]);
    const observation = engine.recall({
      authority: auth(),
      query: "loud dog",
      scopes: [BOT],
    });
    expect(observation.hits[0]?.item.kind).toBe("observation");
  });
});

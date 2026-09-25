// The Memory runtime Contribution: what it injects, what it records, and what
// its tools refuse.
import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { SessionStore, type Session } from "@frockbot/core/contracts";
import type { WorkspaceFilesV1 } from "@frockbot/core/contracts";
import {
  createMemoryForgetTool,
  createMemorySearchTool,
  createMemoryWriteTool,
  MemoryProjection,
  type MemoryRuntimeHostV1,
} from "./agent.ts";
import { botMemoryRootV1, userMemoryRootV1 } from "./roots.ts";
import { TURN_READ_CONCURRENCY_V1 } from "@frockbot/core/concurrency";
import { MemoryStore, MEMORY_MAX_FILES_PER_TIER } from "./store.ts";
import {
  createInMemoryMemoryGroupsV1,
  createTestMemoryAuthorityV1,
  createTestMemoryFilesV1,
} from "./testing.ts";
import { MemoryEngineV1 } from "./engine.ts";
import { MemoryRecordsV1, inProcessMemoryRemoteV1 } from "./owner.ts";
import { groupChatScopeV1, memoryScopeKeyV1 } from "./records.ts";
import type { MemorySqlStorageV1, MemorySqlValueV1 } from "./sql.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const WRITER = { sessionId: "user-1:bot-1", turnId: "turn-4", runId: "run-9" };
const AT = new Date("2026-08-31T10:00:00.000Z");

const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

async function openSession(): Promise<{
  session: Session;
  sessions: { get(id: string): Session | undefined };
  dispose(): Promise<void>;
}> {
  const sessions = new SessionStore();
  const session = sessions.create("user-1:bot-1");
  session.appendBatch([
    { type: "turn/start", turn: 4 },
    { type: "step/start", turn: 4, step: 2 },
  ]);
  return {
    session,
    sessions,
    dispose: async () => {},
  };
}

function hostFor(
  botId = "bot-1",
  files = createTestMemoryFilesV1({ userId: "user-1" }),
): MemoryRuntimeHostV1 & {
  writer: NonNullable<MemoryRuntimeHostV1["writer"]>;
} {
  return {
    owner: { userId: "user-1", botId },
    store: new MemoryStore({
      files,
      owner: { userId: "user-1", botId },
      botNames: { "bot-1": "General", "bot-2": "School" },
      clock: () => AT,
    }),
    writer: WRITER,
    // The Turn's clock, which the note fade's cutoff is derived from.
    clock: () => AT,
  };
}

/** The Bot provenance one shard's writes carry. */
function botWriter(botId: string) {
  return {
    kind: "bot" as const,
    botId,
    sessionId: `user-1:${botId}`,
    turnId: "turn-4",
    runId: "run-9",
  };
}

/**
 * A Workspace surface that serves reads normally and stops accepting writes
 * after `allowed` of them, so a change that spans two files can be interrupted
 * between them.
 */
function writesFailAfter(
  files: WorkspaceFilesV1,
  allowed: number,
): WorkspaceFilesV1 {
  let seen = 0;
  return {
    read: (path) => files.read(path),
    list: (request) => files.list(request),
    stat: (path) => files.stat(path),
    write: (request) => {
      seen += 1;
      if (seen > allowed) {
        return Promise.resolve({
          status: "unavailable" as const,
          reason: "the bucket went away",
        });
      }
      return files.write(request);
    },
    delete: (request) => files.delete(request),
  };
}

describe("memory_write", () => {
  test("records intent before the effect, then the generation it produced", async () => {
    const host = hostFor();
    const { session, sessions, dispose } = await openSession();
    const projection = new MemoryProjection(host);
    const tool = createMemoryWriteTool(host, sessions, projection);

    const result = await tool.execute(
      { scope: "user", tier: "profile", fact: "Tim lives in Wollongong." },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    const intent = session.activeRunJournal.find(
      (event) => event.type === "memory/write-intent",
    );
    const written = session.activeRunJournal.find(
      (event) => event.type === "memory/written",
    );
    expect(intent).toMatchObject({
      turn: 4,
      step: 2,
      action: "write",
      scope: "user",
      tier: "profile",
    });
    expect(written).toMatchObject({ action: "write", scope: "user" });
    expect(intent!.seq).toBeLessThan(written!.seq);
    if (written?.type !== "memory/written") throw new Error("unreachable");
    expect(written.path).toBe("by-agent/bot-1/profile.md");
    expect(written.effectId).toBe(
      intent?.type === "memory/write-intent" ? intent.effectId : "",
    );
    await dispose();
  });

  test("refuses a credential-shaped fact, visibly, and writes nothing", async () => {
    const host = hostFor();
    const { session, sessions, dispose } = await openSession();
    const tool = createMemoryWriteTool(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const result = await tool.execute(
      { fact: "The key is sk-abcdefghijklmnopqrstuvwxyz." },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no secrets");
    // The intent is still recorded: the refusal is an observable outcome of an
    // attempt, not an event that never happened.
    expect(
      session.activeRunJournal.some(
        (event) => event.type === "memory/write-intent",
      ),
    ).toBe(true);
    expect(
      session.activeRunJournal.some((event) => event.type === "memory/written"),
    ).toBe(false);
    await dispose();
  });
});

describe("memory_forget", () => {
  test("retracts another Bot's shared fact in this Bot's own shard", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const other = hostFor("bot-2", files);
    await other.store.write({
      root: userMemoryRootV1(OWNER),
      tier: "profile",
      fact: "Tim teaches on Tuesdays.",
      writer: {
        kind: "bot",
        botId: "bot-2",
        sessionId: "user-1:bot-2",
        turnId: "t",
        runId: "r",
      },
    });
    const host = hostFor("bot-1", files);
    const { session, sessions, dispose } = await openSession();
    const tool = createMemoryForgetTool(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const result = await tool.execute(
      { scope: "user", fact: "Tim teaches on Tuesdays." },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    // The result the model paraphrases says what happened, not how: the
    // retraction, the shard and "newest wins" are this Package's mechanics.
    expect(result.content).toContain("Forgotten");
    expect(result.content).not.toContain("shard");
    const written = session.activeRunJournal.find(
      (event) => event.type === "memory/written",
    );
    if (written?.type !== "memory/written") throw new Error("unreachable");
    expect(written.action).toBe("forget");
    expect(written.path).toBe("by-agent/bot-1/log/2026-08.md");
    await dispose();
  });
});

describe("the note fade", () => {
  test("drops a stale note from the prompt and records the fade beside the cutoff", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const host = hostFor("bot-1", files);
    const writer = botWriter("bot-1");
    const root = userMemoryRootV1(OWNER);
    // Two notes, one either side of the 14-day cutoff, and one durable log
    // fact that never fades. All three stay on disk.
    await host.store.write({
      root,
      tier: "note",
      fact: "[note] the standup moved to nine",
      writer,
      at: new Date("2026-08-30T10:00:00.000Z"),
    });
    await host.store.write({
      root,
      tier: "note",
      fact: "[note] the standup moved to eight",
      writer,
      at: new Date("2026-08-01T10:00:00.000Z"),
    });
    await host.store.write({
      root,
      tier: "log",
      fact: "Tim teaches on Tuesdays.",
      writer,
      at: new Date("2026-08-01T10:00:00.000Z"),
    });

    const { session, dispose } = await openSession();
    const injection = await new MemoryProjection(host).refresh(4, session);

    expect(injection.text).toContain("[note] the standup moved to nine");
    expect(injection.text).not.toContain("moved to eight");
    expect(injection.text).toContain("Tim teaches on Tuesdays.");

    const injected = session.activeRunJournal.find(
      (event) => event.type === "memory/injected",
    );
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    // The cutoff is on the log, so the request reconstructs exactly.
    expect(injected.noteTtlDays).toBe(14);
    expect(injected.noteCutoff).toBe("2026-08-17");
    expect(injected.faded).toEqual([{ scope: "user", groupId: "", count: 1 }]);
    // A fade is not an omission.
    expect(injected.omissions).toEqual([]);

    // NO WRITES. The faded note is still on disk, in the same generation, and
    // is still forgettable — the fade is a read-time filter and nothing else.
    const tier = await host.store.read(root);
    expect(tier.recent.map((entry) => entry.text)).toContain(
      "[note] the standup moved to eight",
    );
    const forgotten = await host.store.forget({
      root,
      fact: "the standup moved to eight",
      writer,
    });
    expect(forgotten.status).toBe("ok");
    await dispose();
  });
});

describe("the Turn projection", () => {
  test("records exactly what it injected, generations included", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const other = hostFor("bot-2", files);
    const shared = await other.store.write({
      root: userMemoryRootV1(OWNER),
      tier: "profile",
      fact: "Tim teaches on Tuesdays.",
      writer: {
        kind: "bot",
        botId: "bot-2",
        sessionId: "user-1:bot-2",
        turnId: "t",
        runId: "r",
      },
    });
    const host = hostFor("bot-1", files);
    const { session, dispose } = await openSession();
    const projection = new MemoryProjection(host);

    const injection = await projection.refresh(4, session);

    expect(injection.text).toContain(
      "- (learned 2026-08-31) [via School] Tim teaches on Tuesdays.",
    );
    const injected = session.activeRunJournal.find(
      (event) => event.type === "memory/injected",
    );
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    expect(injected.turn).toBe(4);
    expect(injected.facts).toEqual([
      {
        scope: "user",
        groupId: "",
        tier: "profile",
        via: "School",
        learnedAt: "2026-08-31",
        text: "Tim teaches on Tuesdays.",
      },
    ]);
    expect(injected.sources).toEqual([
      {
        scope: "user",
        groupId: "",
        path: "by-agent/bot-2/profile.md",
        generationId:
          shared.status === "ok" ? shared.generationId : "unreachable",
        contentHash:
          shared.status === "ok" ? shared.contentHash : "unreachable",
      },
    ]);
    expect(projection.loadedTurn()).toBe(4);
    await dispose();
  });
});

const GROUP_ID = "g-5c0015c0015c0015c001";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function sqlStorage(): MemorySqlStorageV1 {
  const database = new Database(":memory:");
  databases.push(database);
  return {
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
  };
}

/** Canonical Memory split as production splits it: the Bot's, and the User's. */
function canonical() {
  const userEngine = new MemoryEngineV1({
    storage: sqlStorage(),
    ownedKinds: ["user", "groupChat"],
  });
  const records = new MemoryRecordsV1({
    owner: "bot",
    engine: new MemoryEngineV1({ storage: sqlStorage(), ownedKinds: ["bot"] }),
    remote: inProcessMemoryRemoteV1(userEngine),
  });
  return { userEngine, records };
}

describe("a Group Chat's Memory", () => {
  test("reaches the prompt in that group's Turns and nowhere else", async () => {
    const { userEngine, records } = canonical();
    const scope = groupChatScopeV1("user-1", GROUP_ID);
    const authority = createTestMemoryAuthorityV1({
      joinedGroupChatIds: [GROUP_ID],
    });
    expect(
      userEngine.write({
        authority,
        scope,
        content: "The offsite is in Bowral.",
        operationKey: "g-1",
      }).status,
    ).toBe("ok");
    userEngine.rebuildCore(memoryScopeKeyV1(scope));
    const groups = createInMemoryMemoryGroupsV1([GROUP_ID]);

    const inGroup = { ...hostFor(), records, groups, group: GROUP_ID };
    const { session, dispose } = await openSession();
    const injection = await new MemoryProjection(inGroup).refresh(4, session);
    expect(injection.text).toContain("The offsite is in Bowral.");
    const injected = session.activeRunJournal.find(
      (event) => event.type === "memory/injected",
    );
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    expect(injected.facts).toContainEqual(
      expect.objectContaining({ scope: "group", groupId: GROUP_ID }),
    );

    // The Bot's own chat carries its own and its User's Memory, not a group's.
    const oneToOne = await new MemoryProjection({
      ...hostFor(),
      records,
      groups,
    }).refresh(4, (await openSession()).session);
    expect(oneToOne.text).not.toContain("Bowral");

    // A Bot that left the group no longer reads it, even in the group's Turn.
    groups.set([]);
    const left = await new MemoryProjection(inGroup).refresh(
      4,
      (await openSession()).session,
    );
    expect(left.text).not.toContain("Bowral");
    await dispose();
  });

  test("memory_write in a group's Turn defaults group_id to that group", async () => {
    const { userEngine, records } = canonical();
    const groups = createInMemoryMemoryGroupsV1([GROUP_ID]);
    const host = { ...hostFor(), records, groups, group: GROUP_ID };
    const { session, sessions, dispose } = await openSession();
    const write = createMemoryWriteTool(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const written = await write.execute(
      { scope: "group", fact: "Friday stand-ups are cancelled." },
      CONTEXT,
    );
    expect(written).toEqual({ content: "Remembered.", isError: false });
    expect(
      session.activeRunJournal.find((event) => event.type === "memory/written"),
    ).toMatchObject({ scope: "group", groupId: GROUP_ID });
    expect(userEngine.scopeKeysOfKind("groupChat")).toEqual([
      `groupChat:user-1:${GROUP_ID}`,
    ]);
    await dispose();
  });

  test("a lone recall hit is judged, so one bearing on nothing stays out", async () => {
    const { userEngine, records } = canonical();
    const scope = groupChatScopeV1("user-1", GROUP_ID);
    const authority = createTestMemoryAuthorityV1({
      joinedGroupChatIds: [GROUP_ID],
    });
    userEngine.write({
      authority,
      scope,
      content: "The offsite is in Bowral.",
      operationKey: "g-1",
    });
    const groups = createInMemoryMemoryGroupsV1([GROUP_ID]);
    const request = { role: "user" as const, content: "Where is the offsite?" };
    const recalled = async (rankRecall?: MemoryRuntimeHostV1["rankRecall"]) => {
      const projection = new MemoryProjection({
        ...hostFor(),
        records,
        groups,
        group: GROUP_ID,
        ...(rankRecall ? { rankRecall } : {}),
      });
      await projection.recallForTurn(request.content, "sig-1");
      return projection.renderMessages([request]);
    };

    expect((await recalled())[0]?.content).toContain("Bowral");
    const judged: number[] = [];
    expect(
      await recalled(async ({ hits }) => {
        judged.push(hits.length);
        return [];
      }),
    ).toEqual([request]);
    expect(judged).toEqual([1]);
  });
});

describe("the Turn's Memory read", () => {
  test("reads each file once and still indexes what it read", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const store = new MemoryStore({
      files,
      owner: OWNER,
      clock: () => AT,
    });
    for (const fact of [
      "Tim lives in Wollongong.",
      "Tim rides a Brompton to the station.",
    ]) {
      expect(
        (
          await store.write({
            root: userMemoryRootV1(OWNER),
            tier: "profile",
            fact,
            writer: botWriter("bot-1"),
          })
        ).status,
      ).toBe("ok");
    }
    const reads: string[] = [];
    const counted: WorkspaceFilesV1 = {
      read: (path) => {
        reads.push(path.path);
        return files.read(path);
      },
      list: (request) => files.list(request),
      stat: (path) => files.stat(path),
      write: (request) => files.write(request),
      delete: (request) => files.delete(request),
    };
    const host = hostFor("bot-1", counted);
    const { session, dispose } = await openSession();
    const projection = new MemoryProjection(host);

    await projection.refresh(4, session);

    // The render and the index use the same pass over the same bytes. Search
    // waits for the derived index, while the first model request does not.
    await projection.ensureIndex();
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads).size).toBe(reads.length);
    expect(
      projection
        .index()
        .chunks.some((chunk) => chunk.content.includes("Brompton")),
    ).toBe(true);
    await dispose();
  });

  test("retries a deferred lazy index on the next search", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const store = new MemoryStore({ files, owner: OWNER, clock: () => AT });
    expect(
      (
        await store.write({
          root: userMemoryRootV1(OWNER),
          tier: "profile",
          fact: "Tim rides a Brompton to the station.",
          writer: botWriter("bot-1"),
        })
      ).status,
    ).toBe("ok");
    let failNextRead = true;
    const transientRead: WorkspaceFilesV1 = {
      read: (path) => {
        if (failNextRead) {
          failNextRead = false;
          return Promise.resolve({
            status: "unavailable" as const,
            reason: "the bucket briefly went away",
          });
        }
        return files.read(path);
      },
      list: (request) => files.list(request),
      stat: (path) => files.stat(path),
      write: (request) => files.write(request),
      delete: (request) => files.delete(request),
    };
    const host = hostFor("bot-1", transientRead);
    const { session, dispose } = await openSession();
    const projection = new MemoryProjection(host);

    await projection.refresh(4, session);
    expect((await projection.ensureIndex()).chunks).toHaveLength(0);
    expect(
      (await projection.ensureIndex()).chunks.some((chunk) =>
        chunk.content.includes("Brompton"),
      ),
    ).toBe(true);
    await dispose();
  });

  test("does not keep the first response behind derived embeddings", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const host = hostFor("bot-1", files);
    expect(
      (
        await host.store.write({
          root: userMemoryRootV1(OWNER),
          tier: "profile",
          fact: "Tim rides a Brompton to the station.",
          writer: botWriter("bot-1"),
        })
      ).status,
    ).toBe("ok");
    let releaseEmbedding!: () => void;
    const embeddingReleased = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    let embeddingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      embeddingStarted = resolve;
    });
    let embeddingCalls = 0;
    const projection = new MemoryProjection({
      ...host,
      embed: async (texts) => {
        embeddingCalls += 1;
        embeddingStarted();
        await embeddingReleased;
        return texts.map(() => [1]);
      },
      vectorize: {
        upsert: () => Promise.resolve(),
        query: () => Promise.resolve({ matches: [] }),
        deleteByIds: () => Promise.resolve(),
      },
    });
    const { session, dispose } = await openSession();
    let promptReady = false;
    const refresh = projection.refresh(4, session).then(() => {
      promptReady = true;
    });

    await refresh;
    expect(promptReady).toBe(true);
    expect(embeddingCalls).toBe(0);

    let searchReady = false;
    const index = projection.ensureIndex().then((result) => {
      searchReady = true;
      return result;
    });
    await started;
    expect(searchReady).toBe(false);
    releaseEmbedding();
    expect(
      (await index).chunks.some((chunk) => chunk.content.includes("Brompton")),
    ).toBe(true);
    await dispose();
  });

  test("an invalidation wins over an in-flight lazy index build", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const host = hostFor("bot-1", files);
    const store = new MemoryStore({ files, owner: OWNER, clock: () => AT });
    expect(
      (
        await store.write({
          root: userMemoryRootV1(OWNER),
          tier: "profile",
          fact: "Tim rides a Brompton to the station.",
          writer: botWriter("bot-1"),
        })
      ).status,
    ).toBe("ok");
    let releaseEmbedding!: () => void;
    const embeddingReleased = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    let embeddingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      embeddingStarted = resolve;
    });
    let upserts = 0;
    let recorded = 0;
    const projection = new MemoryProjection({
      ...host,
      embed: async (texts) => {
        embeddingStarted();
        await embeddingReleased;
        return texts.map(() => [1]);
      },
      vectorize: {
        upsert: () => {
          upserts += 1;
          return Promise.resolve();
        },
        query: () => Promise.resolve({ matches: [] }),
        deleteByIds: () => Promise.resolve(),
      },
      chunkIndex: {
        record: () => {
          recorded += 1;
          return Promise.resolve();
        },
      },
    });
    const { session, dispose } = await openSession();
    await projection.refresh(4, session);
    const indexing = projection.ensureIndex();
    await started;

    projection.invalidate();
    expect(
      (
        await store.write({
          root: userMemoryRootV1(OWNER),
          tier: "profile",
          fact: "Tim's Project membership changed while indexing.",
          writer: botWriter("bot-1"),
        })
      ).status,
    ).toBe("ok");
    releaseEmbedding();

    expect(
      (await indexing).chunks.some((chunk) =>
        chunk.content.includes("Project membership changed"),
      ),
    ).toBe(true);
    expect(upserts).toBe(1);
    expect(recorded).toBe(1);
    await dispose();
  });

  test("an invalidation wins over an in-flight explicit rebuild", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const host = hostFor("bot-1", files);
    const store = new MemoryStore({ files, owner: OWNER, clock: () => AT });
    expect(
      (
        await store.write({
          root: userMemoryRootV1(OWNER),
          tier: "profile",
          fact: "Tim rides a Brompton to the station.",
          writer: botWriter("bot-1"),
        })
      ).status,
    ).toBe("ok");
    let releaseEmbedding!: () => void;
    const embeddingReleased = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    let embeddingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      embeddingStarted = resolve;
    });
    let upserts = 0;
    let recorded = 0;
    const projection = new MemoryProjection({
      ...host,
      embed: async (texts) => {
        embeddingStarted();
        await embeddingReleased;
        return texts.map(() => [1]);
      },
      vectorize: {
        upsert: () => {
          upserts += 1;
          return Promise.resolve();
        },
        query: () => Promise.resolve({ matches: [] }),
        deleteByIds: () => Promise.resolve(),
      },
      chunkIndex: {
        record: () => {
          recorded += 1;
          return Promise.resolve();
        },
      },
    });
    const { session, dispose } = await openSession();
    await projection.refresh(4, session);
    const rebuilding = projection.rebuild();
    await started;

    projection.invalidate();
    expect(
      (
        await store.write({
          root: userMemoryRootV1(OWNER),
          tier: "profile",
          fact: "Tim's Project membership changed during the rebuild.",
          writer: botWriter("bot-1"),
        })
      ).status,
    ).toBe("ok");
    releaseEmbedding();

    expect((await rebuilding).deferred).toBeUndefined();
    expect(
      projection
        .index()
        .chunks.some((chunk) =>
          chunk.content.includes("Project membership changed"),
        ),
    ).toBe(true);
    expect(upserts).toBe(1);
    expect(recorded).toBe(1);
    await dispose();
  });
});

describe("a Memory read that a bound cut short", () => {
  test("records an omission naming the tier rather than a complete-looking injection", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    // One profile shard per Bot, one more than the tier read bound.
    const shards = MEMORY_MAX_FILES_PER_TIER + 1;
    for (let index = 0; index < shards; index += 1) {
      const botId = `bot-${String(index).padStart(3, "0")}`;
      const store = new MemoryStore({
        files,
        owner: { userId: "user-1", botId },
        clock: () => AT,
      });
      const written = await store.write({
        root: userMemoryRootV1(OWNER),
        tier: "profile",
        fact: `Shard ${index} learned something.`,
        writer: botWriter(botId),
      });
      expect(written.status).toBe("ok");
    }
    const host = hostFor("bot-000", files);
    const { session, dispose } = await openSession();

    await new MemoryProjection(host).refresh(4, session);

    const injected = session.activeRunJournal.find(
      (event) => event.type === "memory/injected",
    );
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    const omission = injected.omissions.find(
      (entry) =>
        entry.scope === "user" && entry.reason.includes("read bound were not"),
    );
    expect(omission).toBeDefined();
    expect(omission?.reason).toContain(`1 Memory file(s)`);
    await dispose();
  });
});

describe("the group scope where it cannot apply", () => {
  test("is refused, and nothing is recorded or written", async () => {
    const host = hostFor();
    const { session, sessions, dispose } = await openSession();
    const projection = new MemoryProjection(host);
    const write = createMemoryWriteTool(host, sessions, projection);
    const forget = createMemoryForgetTool(host, sessions, projection);

    // Outside a group's Turn, the group must be named.
    expect(
      await write.execute({ scope: "group", fact: "A shared fact." }, CONTEXT),
    ).toMatchObject({ isError: true });
    // Group Memory is canonical only; a host without it has none.
    const written = await write.execute(
      { scope: "group", group_id: GROUP_ID, fact: "A shared fact." },
      CONTEXT,
    );
    const forgotten = await forget.execute(
      { scope: "group", group_id: GROUP_ID, fact: "A shared fact." },
      CONTEXT,
    );

    expect(written.isError).toBe(true);
    expect(written.content).toContain("group memory is not available");
    expect(forgotten.isError).toBe(true);
    expect(
      session.activeRunJournal.some((event) => event.type === "memory/written"),
    ).toBe(false);
    expect(
      session.activeRunJournal.some(
        (event) => event.type === "memory/write-intent",
      ),
    ).toBe(false);
    await dispose();
  });
});

describe("a memory_forget that changes one file and then fails", () => {
  test("records the generation it did write, so the log matches the files", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const seed = new MemoryStore({ files, owner: OWNER, clock: () => AT });
    const fact = "Tim teaches on Tuesdays.";
    for (const tier of ["profile", "log"] as const) {
      const written = await seed.write({
        root: userMemoryRootV1(OWNER),
        tier,
        fact,
        writer: botWriter("bot-1"),
      });
      expect(written.status).toBe("ok");
    }
    // The forget rewrites log/2026-08.md then profile.md; only the first lands.
    const host = hostFor("bot-1", writesFailAfter(files, 1));
    const { session, sessions, dispose } = await openSession();
    const tool = createMemoryForgetTool(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const result = await tool.execute({ scope: "user", fact }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("after changing 1 file(s)");
    const written = session.activeRunJournal.filter(
      (event) => event.type === "memory/written",
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: "forget",
      path: "by-agent/bot-1/log/2026-08.md",
    });
    // The event log names the file that really changed on disk.
    const remaining = await host.store.read(userMemoryRootV1(OWNER));
    expect(remaining.recent.map((entry) => entry.text)).toEqual([]);
    expect(remaining.profile.map((entry) => entry.text)).toEqual([fact]);
    await dispose();
  });
});

describe("memory_search", () => {
  test("decodes its input at the seam, refusing an unknown field", async () => {
    const host = hostFor();
    const projection = new MemoryProjection(host);
    const tool = createMemorySearchTool(host, projection);

    expect(tool.validate?.({ query: "tuesdays", limit: 3 })).toBe(false);
    const unknown = await tool.execute(
      { query: "tuesdays", limit: 3 },
      CONTEXT,
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("unknown fields");

    expect(tool.validate?.({ query: "tuesdays", maxResults: 99 })).toBe(false);
    const range = await tool.execute(
      { query: "tuesdays", maxResults: 99 },
      CONTEXT,
    );
    expect(range.isError).toBe(true);
    expect(range.content).toContain("maxResults");

    const ok = await tool.execute({ query: "tuesdays" }, CONTEXT);
    expect(ok.isError).toBe(false);
  });
});

/**
 * A Workspace surface that serves reads normally but only after a turn of the
 * microtask queue, and reports the high-water mark of reads outstanding at any
 * instant. A read that resolved synchronously would never overlap another, so
 * the deferral is what makes the ceiling observable at all.
 */
function readsCountConcurrency(files: WorkspaceFilesV1): {
  files: WorkspaceFilesV1;
  peak: () => number;
  total: () => number;
} {
  let outstanding = 0;
  let peak = 0;
  let total = 0;
  const counted = async <T>(run: () => Promise<T>): Promise<T> => {
    outstanding += 1;
    total += 1;
    peak = Math.max(peak, outstanding);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await run();
    } finally {
      outstanding -= 1;
    }
  };
  return {
    peak: () => peak,
    total: () => total,
    files: {
      read: (path) => counted(() => files.read(path)),
      list: (request) => counted(() => files.list(request)),
      stat: (path) => files.stat(path),
      write: (request) => files.write(request),
      delete: (request) => files.delete(request),
    },
  };
}

describe("the turn-start Memory read across every tier", () => {
  test("never holds more reads open at once than the declared bound", async () => {
    const seed = createTestMemoryFilesV1({ userId: "user-1" });
    // Many shards in the shared tier: enough files that a squared bound and
    // an honest one are far apart.
    const shardCount = 16;
    for (let index = 0; index < shardCount; index += 1) {
      const botId = `bot-${String(index).padStart(3, "0")}`;
      const store = new MemoryStore({
        files: seed,
        owner: { userId: "user-1", botId },
        clock: () => AT,
      });
      for (const root of [
        botMemoryRootV1({ userId: "user-1", botId }),
        userMemoryRootV1(OWNER),
      ]) {
        const written = await store.write({
          root,
          tier: "profile",
          fact: `Shard ${index} learned something about ${root.kind}.`,
          writer: botWriter(botId),
        });
        expect(written.status).toBe("ok");
      }
    }

    const counting = readsCountConcurrency(seed);
    const host = hostFor("bot-000", counting.files);
    const { session, dispose } = await openSession();

    await new MemoryProjection(host).refresh(4, session);

    // The fan-out really happened — otherwise a serial read would pass this
    // test by never overlapping anything.
    expect(counting.total()).toBeGreaterThan(TURN_READ_CONCURRENCY_V1);
    expect(counting.peak()).toBeGreaterThan(1);
    expect(counting.peak()).toBeLessThanOrEqual(TURN_READ_CONCURRENCY_V1);
    await dispose();
  });
});

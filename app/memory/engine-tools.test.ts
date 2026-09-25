import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { MemoryEngineV1 } from "./engine.ts";
import {
  createMemoryBrowseTool,
  createMemoryExpandTool,
  executeRecordsForgetV1,
  executeRecordsSearchV1,
  executeRecordsWriteV1,
} from "./engine-tools.ts";
import { MemoryRecordsV1, inProcessMemoryRemoteV1 } from "./owner.ts";
import type { MemorySqlStorageV1, MemorySqlValueV1 } from "./sql.ts";
import { createInMemoryMemoryGroupsV1 } from "./testing.ts";

const SCHOOL = "g-5c0015c0015c0015c001";
const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "s",
  compositionGenerationId: "g",
  turnType: "chat" as const,
  effectId: "e",
  signal: new AbortController().signal,
};

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function sqlStorage(database: Database): MemorySqlStorageV1 {
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

function recordsHost(joined: string[] = [], group?: string) {
  const botDb = new Database(":memory:");
  const userDb = new Database(":memory:");
  databases.push(botDb, userDb);
  const botEngine = new MemoryEngineV1({
    storage: sqlStorage(botDb),
    ownedKinds: ["bot"],
  });
  const userEngine = new MemoryEngineV1({
    storage: sqlStorage(userDb),
    ownedKinds: ["user", "groupChat"],
  });
  const records = new MemoryRecordsV1({
    owner: "bot",
    engine: botEngine,
    remote: inProcessMemoryRemoteV1(userEngine),
  });
  const groups = createInMemoryMemoryGroupsV1(joined);
  return {
    owner: { userId: "user-1", botId: "bot-1" },
    records,
    writer: { sessionId: "s", turnId: "t", runId: "r" },
    groups,
    ...(group ? { group } : {}),
  };
}

describe("canonical Memory tools", () => {
  test("write, search, expand and browse round-trip", async () => {
    const host = recordsHost();
    const written = await executeRecordsWriteV1(
      host,
      {
        scope: "user",
        tier: "log",
        fact: "Tim lives in Wollongong.",
      },
      "op-write",
    );
    expect(written).toEqual({ content: "Remembered.", isError: false });
    const botWritten = await executeRecordsWriteV1(
      host,
      { scope: "bot", tier: "log", fact: "Bot-local reminder." },
      "op-bot",
    );
    expect(botWritten).toEqual({ content: "Remembered.", isError: false });
    const search = await executeRecordsSearchV1(host, {
      query: "Wollongong",
      scope: "user",
    });
    expect(search.isError).toBe(false);
    expect(search.content).toContain("Tim lives in Wollongong.");
    const id = /user:(it_[a-f0-9]+)/.exec(String(search.content))?.[1];
    expect(id).toBeTruthy();
    const expand = createMemoryExpandTool(host);
    const expanded = await expand.execute(
      { scope: "user", itemId: id },
      {
        botId: "bot-1",
        agentId: "bot-1",
        sessionId: "s",
        compositionGenerationId: "g",
        turnType: "chat",
        effectId: "e",
        signal: new AbortController().signal,
      },
    );
    expect(expanded.isError).toBe(false);
    const browse = createMemoryBrowseTool(host);
    const page = await browse.execute(
      { scope: "user" },
      {
        botId: "bot-1",
        agentId: "bot-1",
        sessionId: "s",
        compositionGenerationId: "g",
        turnType: "chat",
        effectId: "e",
        signal: new AbortController().signal,
      },
    );
    expect(page.content).toContain("Tim lives in Wollongong.");
  });

  test("forget hides the item from search", async () => {
    const host = recordsHost();
    await executeRecordsWriteV1(
      host,
      { scope: "user", tier: "profile", fact: "A secret preference." },
      "w1",
    );
    const forgotten = await executeRecordsForgetV1(
      host,
      { scope: "user", fact: "A secret preference." },
      "f1",
    );
    expect(forgotten).toEqual({ content: "Forgotten.", isError: false });
    const search = await executeRecordsSearchV1(host, {
      query: "preference",
      scope: "user",
    });
    expect(search.content).toBe("No memory matches.");
  });

  test("a group's Memory is its members' alone", async () => {
    const outsider = recordsHost();
    const refused = await executeRecordsWriteV1(
      outsider,
      {
        scope: "group",
        groupId: SCHOOL,
        tier: "log",
        fact: "Assembly is Friday.",
      },
      "p1",
    );
    expect(refused.isError).toBe(true);
    expect(String(refused.content)).toContain("not a member");

    const member = recordsHost([SCHOOL], SCHOOL);
    expect(
      await executeRecordsWriteV1(
        member,
        {
          scope: "group",
          groupId: SCHOOL,
          tier: "log",
          fact: "Assembly is Friday.",
        },
        "p2",
      ),
    ).toEqual({ content: "Remembered.", isError: false });
    const found = await executeRecordsSearchV1(member, {
      query: "Assembly",
      scope: "group",
    });
    expect(found.content).toContain(`group/${SCHOOL}:`);
    // In the group's own Turn, browse needs no group_id.
    const page = await createMemoryBrowseTool(member).execute(
      { scope: "group" },
      CONTEXT,
    );
    expect(page.content).toContain("Assembly is Friday.");
    // A Bot that leaves loses the group's Memory with the membership.
    member.groups.set([]);
    const gone = await executeRecordsSearchV1(member, {
      query: "Assembly",
      scope: "group",
    });
    expect(gone.content).toBe("No memory matches.");
  });
});

describe("a judged Memory write", () => {
  const search = async (host: ReturnType<typeof recordsHost>, query: string) =>
    String(
      (await executeRecordsSearchV1(host, { query, scope: "user" })).content,
    );

  test("a secret is refused and never written", async () => {
    const host = {
      ...recordsHost(),
      judgeWrite: async () => ({ action: "refuse-secret" as const }),
    };
    const written = await executeRecordsWriteV1(
      host,
      { scope: "user", tier: "profile", fact: "The alarm code is 4417." },
      "w-secret",
    );
    expect(written).toMatchObject({ isError: true });
    expect(written.content).toContain("secret");
    expect(await search(host, "alarm")).toBe("No memory matches.");
  });

  test("a newer value replaces the kept one, found by recall and named back", async () => {
    const seen: unknown[] = [];
    const host = recordsHost();
    await executeRecordsWriteV1(
      host,
      { scope: "user", tier: "profile", fact: "Tim drinks flat whites." },
      "w-old",
    );
    const judged = {
      ...host,
      judgeWrite: async (evidence: {
        candidates: readonly { id: string; text: string }[];
      }) => {
        seen.push(evidence);
        const kept = evidence.candidates[0]!;
        return {
          action: "write" as const,
          tier: "profile" as const,
          replaces: kept,
        };
      },
    };
    const written = await executeRecordsWriteV1(
      judged,
      { scope: "user", tier: "profile", fact: "Tim drinks long blacks now." },
      "w-new",
    );
    expect(seen).toEqual([
      {
        fact: "Tim drinks long blacks now.",
        tier: "profile",
        candidates: [
          { id: expect.any(String), text: "Tim drinks flat whites." },
        ],
      },
    ]);
    expect(written).toEqual({
      content:
        'Remembered. It replaces what was kept before: "Tim drinks flat whites.".',
      isError: false,
    });
    const found = await search(host, "Tim drinks");
    expect(found).toContain("long blacks");
    expect(found).not.toContain("flat whites");
  });

  test("a fact already kept writes nothing; a passing one is kept as a log entry", async () => {
    const host = recordsHost();
    const kept = await executeRecordsWriteV1(
      {
        ...host,
        judgeWrite: async () => ({ action: "already-kept", id: "x" }),
      },
      { scope: "user", tier: "profile", fact: "Tim likes coffee." },
      "w-kept",
    );
    expect(kept).toEqual({
      content: "Already remembered; nothing changed.",
      isError: false,
    });
    expect(await search(host, "coffee")).toBe("No memory matches.");
    const passing = await executeRecordsWriteV1(
      {
        ...host,
        judgeWrite: async () => ({ action: "write", tier: "log" }),
      },
      { scope: "user", tier: "profile", fact: "Tim is at the dentist today." },
      "w-passing",
    );
    expect(passing.content).toBe(
      "Remembered. It is kept as a log entry, since it will not stay true.",
    );
  });

  test("a credential-shaped fact is refused without asking the judge", async () => {
    let asked = false;
    const host = {
      ...recordsHost(),
      judgeWrite: async () => {
        asked = true;
        return undefined;
      },
    };
    const written = await executeRecordsWriteV1(
      host,
      {
        scope: "user",
        tier: "profile",
        fact: "The deploy key is ghp_0123456789abcdefghijABCDEFGHIJ012345.",
      },
      "w-token",
    );
    expect(written).toMatchObject({ isError: true });
    expect(asked).toBe(false);
  });

  test("another Bot's kept fact is not replaced, and the new one is still kept", async () => {
    const host = recordsHost();
    await executeRecordsWriteV1(
      { ...host, owner: { userId: "user-1", botId: "bot-2" } },
      { scope: "user", tier: "profile", fact: "Tim lives in Wollongong." },
      "w-other",
    );
    const written = await executeRecordsWriteV1(
      {
        ...host,
        judgeWrite: async (evidence: {
          candidates: readonly { id: string; text: string }[];
        }) => ({
          action: "write" as const,
          tier: "profile" as const,
          replaces: evidence.candidates[0]!,
        }),
      },
      { scope: "user", tier: "profile", fact: "Tim moved to Melbourne." },
      "w-moved",
    );
    expect(written).toEqual({ content: "Remembered.", isError: false });
    const found = await search(host, "Tim");
    expect(found).toContain("Melbourne");
    expect(found).toContain("Wollongong");
  });

  test("a judge that cannot say leaves the write as asked", async () => {
    const host = { ...recordsHost(), judgeWrite: async () => undefined };
    expect(
      await executeRecordsWriteV1(
        host,
        { scope: "user", tier: "profile", fact: "Tim lives in Wollongong." },
        "w-plain",
      ),
    ).toEqual({ content: "Remembered.", isError: false });
  });
});

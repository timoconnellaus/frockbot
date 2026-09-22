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
import { createInMemoryMemoryProjectsV1 } from "./testing.ts";

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

function recordsHost(joined: string[] = []) {
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
  const projects = createInMemoryMemoryProjectsV1(
    joined.map((projectId) => ({
      projectId,
      name: projectId,
      description: "",
    })),
  );
  return {
    owner: { userId: "user-1", botId: "bot-1" },
    records,
    writer: { sessionId: "s", turnId: "t", runId: "r" },
    projects,
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

  test("unjoined project write is refused", async () => {
    const host = recordsHost();
    const written = await executeRecordsWriteV1(
      host,
      {
        scope: "project",
        project: "school",
        tier: "log",
        fact: "Assembly is Friday.",
      },
      "p1",
    );
    expect(written.isError).toBe(true);
    expect(String(written.content)).toContain("not joined");
  });
});

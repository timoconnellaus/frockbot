import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { SearchIndexV1, type SearchSqlValueV1 } from "./index-store.ts";
import { SEARCH_MAX_RESULTS_V1, type SearchRowV1 } from "./shared.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createIndex() {
  const database = new Database(":memory:");
  databases.push(database);
  return new SearchIndexV1({
    sql: {
      exec<Row extends Record<string, SearchSqlValueV1>>(
        query: string,
        ...bindings: SQLQueryBindings[]
      ) {
        const rows = database
          .query<Row, SQLQueryBindings[]>(query)
          .all(...bindings);
        return { toArray: () => rows };
      },
    },
  });
}

function row(overrides: Partial<SearchRowV1> = {}): SearchRowV1 {
  return {
    botId: "bot-a",
    runId: "run-1",
    seq: 0,
    kind: "media",
    at: "2026-09-01T00:00:00.000Z",
    body: "report.pdf\napplication/pdf\nhttps://example.com/report.pdf",
    ...overrides,
  };
}

describe("category browsing through real SQLite FTS5", () => {
  test("an empty query returns recent items with kind, Bot and archive filters", () => {
    const index = createIndex();
    index.insert([
      row(),
      row({ runId: "run-2", at: "2026-09-02T00:00:00.000Z" }),
      row({ runId: "run-3", kind: "tool", body: "private tool output" }),
      row({ botId: "archived", runId: "run-4" }),
      row({ botId: "bot-b", runId: "run-5" }),
      row({
        runId: "run-6",
        kind: "link",
        body: "https://school.example/letter",
      }),
    ]);
    const directory = { archivedBotIds: ["archived"] };
    expect(
      index
        .query(
          { schemaVersion: 1, query: "", kinds: ["media"], botId: "bot-a" },
          directory,
        )
        .hits.map((hit) => hit.runId),
    ).toEqual(["run-2", "run-1"]);
    expect(
      index
        .query({ schemaVersion: 1, query: "", kinds: ["link"] }, directory)
        .hits.map((hit) => hit.snippet),
    ).toEqual(["https://school.example/letter"]);
    expect(
      index.query(
        {
          schemaVersion: 1,
          query: "",
          kinds: ["media"],
          includeArchived: true,
        },
        directory,
      ).hits,
    ).toHaveLength(4);
    expect(
      index.query(
        { schemaVersion: 1, query: "report", kinds: ["media"] },
        directory,
      ).hits,
    ).toHaveLength(3);
    expect(
      index.query(
        { schemaVersion: 1, query: " *** ", kinds: ["media"] },
        directory,
      ).hits,
    ).toHaveLength(0);
  });

  test("recent pages have stable ordering and no repeated rows", () => {
    const index = createIndex();
    index.insert(
      Array.from({ length: SEARCH_MAX_RESULTS_V1 + 3 }, (_, seq) =>
        row({ seq, body: `report-${seq}.pdf` }),
      ),
    );
    const query = {
      schemaVersion: 1 as const,
      query: "",
      kinds: ["media" as const],
    };
    const directory = { archivedBotIds: [] };
    const first = index.query(query, directory);
    expect(first.hits).toHaveLength(SEARCH_MAX_RESULTS_V1);
    expect(first.truncated).toBe(true);
    const second = index.query(
      { ...query, before: first.nextCursor },
      directory,
    );
    expect(second.hits).toHaveLength(3);
    expect(second.truncated).toBe(false);
    expect(
      new Set([...first.hits, ...second.hits].map((hit) => hit.snippet)).size,
    ).toBe(SEARCH_MAX_RESULTS_V1 + 3);
  });
});

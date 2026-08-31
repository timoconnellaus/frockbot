import { describe, expect, test } from "bun:test";
import { SearchIndexV1, searchMatchExpressionV1 } from "./index-store.ts";
import { FakeSearchSql } from "./testing.ts";
import type { SearchRowV1 } from "./shared.ts";

function row(overrides: Partial<SearchRowV1> = {}): SearchRowV1 {
  return {
    botId: "bot-a",
    runId: "run-1",
    seq: 0,
    kind: "user",
    at: "2026-08-31T00:00:00.000Z",
    body: "the gym build in Wollongong",
    ...overrides,
  };
}

function index(maxRows?: number) {
  const sql = new FakeSearchSql();
  return {
    sql,
    index: new SearchIndexV1({
      sql,
      ...(maxRows === undefined ? {} : { maxRows }),
    }),
  };
}

const NO_ARCHIVED = { archivedBotIds: [] as string[] };

describe("the FTS5 match expression", () => {
  test("quotes every token, so FTS5 syntax is searched for and never executed", () => {
    expect(searchMatchExpressionV1("gym build")).toBe('"gym" "build"*');
    // `NEAR`, `OR`, `-`, `^` and a column filter are all literal text here.
    expect(searchMatchExpressionV1("NEAR(a b) OR -c^")).toBe(
      '"NEAR" "a" "b" "OR" "c"*',
    );
  });

  test("a query with no word characters matches nothing at all", () => {
    expect(searchMatchExpressionV1("   *  ")).toBeUndefined();
  });
});

describe("the transcript index", () => {
  test("indexes a row and finds it", () => {
    const { index: store } = index();
    expect(store.insert([row()])).toBe(1);
    const results = store.query(
      { schemaVersion: 1, query: "wollongong" },
      NO_ARCHIVED,
    );
    expect(results.hits).toHaveLength(1);
    expect(results.hits[0]).toMatchObject({ botId: "bot-a", runId: "run-1" });
    expect(results.indexState).toBe("ready");
  });

  test("is idempotent on (botId, runId, seq)", () => {
    const { index: store } = index();
    expect(store.insert([row(), row()])).toBe(1);
    expect(store.insert([row()])).toBe(0);
    expect(store.count()).toBe(1);
  });

  test("excludes tool rows by default and returns them when asked", () => {
    const { index: store } = index();
    store.insert([
      row({ seq: 0, kind: "user", body: "run the deploy" }),
      row({ seq: 1, kind: "tool", body: "shell\ndeploy token abc" }),
    ]);
    expect(
      store.query({ schemaVersion: 1, query: "deploy" }, NO_ARCHIVED).hits,
    ).toHaveLength(1);
    expect(
      store.query(
        { schemaVersion: 1, query: "deploy", kinds: ["tool"] },
        NO_ARCHIVED,
      ).hits,
    ).toHaveLength(1);
  });

  test("hides an archived Bot's rows unless they are opted in", () => {
    const { index: store } = index();
    store.insert([row({ botId: "bot-archived" })]);
    const directory = { archivedBotIds: ["bot-archived"] };
    expect(
      store.query({ schemaVersion: 1, query: "wollongong" }, directory).hits,
    ).toHaveLength(0);
    expect(
      store.query(
        { schemaVersion: 1, query: "wollongong", includeArchived: true },
        directory,
      ).hits,
    ).toHaveLength(1);
  });

  test("filters to one Bot", () => {
    const { index: store } = index();
    store.insert([row({ botId: "bot-a" }), row({ botId: "bot-b" })]);
    const results = store.query(
      { schemaVersion: 1, query: "wollongong", botId: "bot-b" },
      NO_ARCHIVED,
    );
    expect(results.hits.map((hit) => hit.botId)).toEqual(["bot-b"]);
  });

  test("refuses a cursor it did not mint", () => {
    const { index: store } = index();
    expect(() =>
      store.query(
        { schemaVersion: 1, query: "gym", before: "'; DROP TABLE" },
        NO_ARCHIVED,
      ),
    ).toThrow("cursor is invalid");
  });

  test("evicts the oldest rows over quota and records a durable marker", () => {
    const { index: store } = index(2);
    store.insert([
      row({ runId: "run-1", at: "2026-08-01T00:00:00.000Z" }),
      row({ runId: "run-2", at: "2026-08-02T00:00:00.000Z" }),
      row({ runId: "run-3", at: "2026-08-03T00:00:00.000Z" }),
    ]);
    expect(store.count()).toBe(2);
    expect(store.state()).toBe("truncated");
    const results = store.query(
      { schemaVersion: 1, query: "wollongong" },
      NO_ARCHIVED,
    );
    expect(results.hits.map((hit) => hit.runId)).toEqual(["run-2", "run-3"]);
    expect(results.indexState).toBe("truncated");
  });

  test("purges one Bot and leaves the others", () => {
    const { index: store } = index();
    store.insert([row({ botId: "bot-a" }), row({ botId: "bot-b" })]);
    expect(store.purge("bot-a")).toBe(1);
    expect(store.count()).toBe(1);
    expect(
      store.query({ schemaVersion: 1, query: "gym" }, NO_ARCHIVED).hits[0]
        ?.botId,
    ).toBe("bot-b");
  });

  test("a rebuild from an emptied table reproduces the identical result set", async () => {
    const { index: store } = index();
    const rows = [
      row({ botId: "bot-a", runId: "run-1", seq: 0 }),
      row({
        botId: "bot-a",
        runId: "run-1",
        seq: 1,
        kind: "assistant",
        body: "Wollongong noted.",
      }),
      row({ botId: "bot-b", runId: "run-2", seq: 0, body: "the gym roster" }),
    ];
    store.insert(rows);
    const before = store.query({ schemaVersion: 1, query: "gym" }, NO_ARCHIVED);

    const outcome = await store.rebuild([
      {
        botId: "bot-a",
        page: async (cursor) =>
          cursor
            ? { rows: rows.slice(1, 2) }
            : { rows: rows.slice(0, 1), nextCursor: "page-2" },
      },
      { botId: "bot-b", page: async () => ({ rows: rows.slice(2) }) },
    ]);

    expect(outcome).toEqual({ indexedRows: 3, bots: 2, indexState: "ready" });
    expect(
      store.query({ schemaVersion: 1, query: "gym" }, NO_ARCHIVED),
    ).toEqual(before);
  });

  test("a rebuild clears a truncation marker it no longer needs", async () => {
    const { index: store } = index(1);
    store.insert([
      row({ runId: "run-1", at: "2026-08-01T00:00:00.000Z" }),
      row({ runId: "run-2", at: "2026-08-02T00:00:00.000Z" }),
    ]);
    expect(store.state()).toBe("truncated");
    await store.rebuild([
      {
        botId: "bot-a",
        page: async () => ({ rows: [row({ runId: "run-9" })] }),
      },
    ]);
    expect(store.state()).toBe("ready");
  });

  test("a rebuild refuses rows a Bot offers on another Bot's behalf", async () => {
    const { index: store } = index();
    await store.rebuild([
      {
        botId: "bot-a",
        page: async () => ({
          rows: [row({ botId: "bot-a" }), row({ botId: "bot-elsewhere" })],
        }),
      },
    ]);
    expect(store.count()).toBe(1);
  });
});

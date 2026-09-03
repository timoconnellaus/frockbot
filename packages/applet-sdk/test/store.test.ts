import { describe, expect, it } from "bun:test";

import {
  AppletValidationError,
  jsonSchemaFromColumns,
  t,
  table,
  type TablesShape,
} from "../src/schema/index.js";
import { AppletStore } from "../src/server/store.js";
import { createTestSql, type TestSql } from "./sqlite.js";

const todos: TablesShape = {
  todos: table({
    id: t.id(),
    title: t.text(),
    done: t.boolean().default(false),
    note: t.text().optional(),
    tags: t.json().default([]),
    createdAt: t.timestamp(),
  }),
};

function store(tables: TablesShape = todos): {
  store: AppletStore;
  sql: TestSql;
} {
  const sql = createTestSql();
  const applet = new AppletStore(sql, tables);
  applet.ensureSchema();
  return { store: applet, sql };
}

const NOW = "2026-09-03T00:00:00.000Z";

describe("table declaration", () => {
  it("requires exactly one id column", () => {
    expect(() => table({ title: t.text() })).toThrow(/exactly one t.id/);
    expect(() => table({ a: t.id(), b: t.id() })).toThrow(/exactly one t.id/);
  });

  it("rejects an invalid column name", () => {
    expect(() => table({ id: t.id(), "not ok": t.text() })).toThrow(
      /valid identifier/,
    );
  });
});

describe("DDL", () => {
  it("creates the declared table with SQLite types and nullability", () => {
    const { sql } = store();
    const columns = sql
      .exec(`PRAGMA table_info("todos")`)
      .toArray()
      .map(
        (column) =>
          `${column.name}:${column.type}:${column.notnull}:${column.pk}`,
      );
    expect(columns).toEqual([
      "id:TEXT:1:1",
      "title:TEXT:1:0",
      "done:INTEGER:1:0",
      "note:TEXT:0:0",
      "tags:TEXT:1:0",
      "createdAt:TEXT:1:0",
    ]);
  });

  it("is idempotent across mounts and reports the shape as unchanged", () => {
    const sql = createTestSql();
    expect(new AppletStore(sql, todos).ensureSchema()).toMatchObject({
      revision: 1,
      changed: true,
      previousRevision: 0,
    });
    expect(new AppletStore(sql, todos).ensureSchema()).toMatchObject({
      revision: 1,
      changed: false,
    });
  });

  it("adds a column declared since the last mount and keeps the rows", () => {
    const sql = createTestSql();
    const first = new AppletStore(sql, todos);
    first.ensureSchema();
    first.insert("todos", { title: "milk", createdAt: NOW });

    const widened: TablesShape = {
      todos: table({
        id: t.id(),
        title: t.text(),
        done: t.boolean().default(false),
        note: t.text().optional(),
        tags: t.json().default([]),
        createdAt: t.timestamp(),
        priority: t.integer().default(3),
      }),
    };
    const second = new AppletStore(sql, widened);
    const state = second.ensureSchema();
    expect(state).toMatchObject({
      revision: 2,
      changed: true,
      previousRevision: 1,
    });
    expect(second.select("todos")[0]).toMatchObject({
      title: "milk",
      priority: 3,
    });
  });

  it("refuses a required column added with no default", () => {
    const sql = createTestSql();
    new AppletStore(sql, todos).ensureSchema();
    const widened: TablesShape = {
      todos: table({
        id: t.id(),
        title: t.text(),
        done: t.boolean().default(false),
        note: t.text().optional(),
        tags: t.json().default([]),
        createdAt: t.timestamp(),
        owner: t.text(),
      }),
    };
    expect(() => new AppletStore(sql, widened).ensureSchema()).toThrow(
      /added without \.default\(\) or \.optional\(\)/,
    );
  });
});

describe("rows", () => {
  it("fills defaults, generates a key, and round-trips every column kind", () => {
    const { store: applet } = store();
    const change = applet.insert("todos", { title: "milk", createdAt: NOW });
    expect(change.op).toBe("insert");
    expect(change.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(change.row).toEqual({
      id: change.key,
      title: "milk",
      done: false,
      note: null,
      tags: [],
      createdAt: NOW,
    });
  });

  it("refuses an unknown column and an unknown table", () => {
    const { store: applet } = store();
    expect(() =>
      applet.insert("todos", { title: "a", createdAt: NOW, nope: 1 }),
    ).toThrow(AppletValidationError);
    expect(() => applet.insert("other", {})).toThrow(/Unknown table/);
  });

  it("refuses a value of the wrong kind", () => {
    const { store: applet } = store();
    expect(() => applet.insert("todos", { title: 7, createdAt: NOW })).toThrow(
      /must be a string/,
    );
    expect(() =>
      applet.insert("todos", { title: "a", createdAt: "yesterday" }),
    ).toThrow(/ISO-8601/);
  });

  it("refuses null in a required column", () => {
    const { store: applet } = store();
    expect(() =>
      applet.insert("todos", { title: null, createdAt: NOW }),
    ).toThrow(/may not be null/);
  });

  it("updates, filters, and deletes", () => {
    const { store: applet } = store();
    const key = applet.insert("todos", { title: "milk", createdAt: NOW }).key;
    applet.insert("todos", { title: "eggs", createdAt: NOW, done: true });

    expect(applet.update("todos", key, { done: true })!.row!.done).toBe(true);
    expect(applet.update("todos", "missing", { done: true })).toBeUndefined();
    expect(() => applet.update("todos", key, { id: "x" })).toThrow(
      /is the key/,
    );

    expect(applet.select("todos", { done: true })).toHaveLength(2);
    expect(applet.select("todos", { note: null })).toHaveLength(2);

    expect(applet.delete("todos", key)!.op).toBe("delete");
    expect(applet.delete("todos", key)).toBeUndefined();
    expect(applet.select("todos")).toHaveLength(1);
  });
});

describe("change log", () => {
  it("advances a cursor and replays changes after it", () => {
    const { store: applet } = store();
    expect(applet.lastChangeId).toBe(0);
    const first = applet.insert("todos", { title: "milk", createdAt: NOW });
    const at = applet.lastChangeId;
    applet.update("todos", first.key, { done: true });
    applet.delete("todos", first.key);

    const changes = applet.changesSince(at)!;
    expect(changes.map((change) => change.op)).toEqual(["update", "delete"]);
    expect(changes[1]!.row).toBeUndefined();
    expect(applet.changesSince(applet.lastChangeId)).toEqual([]);
  });

  it("asks for a full snapshot when the cursor is beyond the log", () => {
    const { store: applet } = store();
    applet.insert("todos", { title: "milk", createdAt: NOW });
    expect(applet.changesSince(99)).toBeUndefined();
  });

  it("survives a remount, resuming the cursor", () => {
    const sql = createTestSql();
    const first = new AppletStore(sql, todos);
    first.ensureSchema();
    first.insert("todos", { title: "milk", createdAt: NOW });
    const cursor = first.lastChangeId;

    const second = new AppletStore(sql, todos);
    second.ensureSchema();
    expect(second.lastChangeId).toBe(cursor);
    expect(second.snapshot().todos).toHaveLength(1);
  });
});

describe("mutations", () => {
  it("applies a client transaction and reports the resulting rows", () => {
    const { store: applet } = store();
    const [insert] = applet.applyMutations(
      [
        {
          table: "todos",
          op: "insert",
          value: { title: "milk", createdAt: NOW },
        },
      ],
      "txn-1",
    );
    const [update] = applet.applyMutations(
      [
        {
          table: "todos",
          op: "update",
          key: insert!.key,
          value: { done: true },
        },
      ],
      "txn-2",
    );
    expect(update!.row).toMatchObject({ title: "milk", done: true });
  });

  it("rejects a mutation against a row that is gone", () => {
    const { store: applet } = store();
    expect(() =>
      applet.applyMutations([{ table: "todos", op: "delete", key: "missing" }]),
    ).toThrow(/is not in "todos"/);
  });
});

describe("tool input schema", () => {
  it("marks defaulted and optional columns as not required", () => {
    expect(
      jsonSchemaFromColumns({
        title: t.text(),
        done: t.boolean().default(false),
        note: t.text().optional(),
      }),
    ).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        done: { type: "boolean" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["title"],
      additionalProperties: false,
    });
  });
});

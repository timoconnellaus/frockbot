import { describe, expect, test } from "bun:test";
import { AuditStoreV1 } from "./store.ts";
import { FakeAuditSql } from "./testing.ts";
import type { AuditEntryV1 } from "./shared.ts";

const DIGEST = "a".repeat(64);

function entry(overrides: Partial<AuditEntryV1> = {}): AuditEntryV1 {
  const occurrenceId = overrides.occurrenceId ?? "tool:1:1:0";
  const [, turn, step, ordinal] = /^tool:(\d+):(\d+):(\d+)$/.exec(
    occurrenceId,
  )!;
  return {
    schemaVersion: 1,
    botId: "foreman",
    runId: "run-1",
    occurrenceId,
    turn: Number(turn),
    step: Number(step),
    ordinal: Number(ordinal),
    effectId: occurrenceId,
    at: "2026-08-31T00:00:00.000Z",
    kind: "shell",
    target: "computer",
    toolName: "computer_exec",
    argumentDigest: DIGEST,
    preview: "ls -la",
    outcome: "ok",
    ...overrides,
  };
}

function store(
  options: { maxRows?: number; maxAgeMs?: number; now?: () => number } = {},
) {
  return new AuditStoreV1({ sql: new FakeAuditSql(), ...options });
}

describe("the audit table", () => {
  test("inserts idempotently on (botId, runId, occurrenceId)", () => {
    const table = store();
    expect(table.insert([entry(), entry({ occurrenceId: "tool:1:1:1" })])).toBe(
      2,
    );
    // The outbox delivers at least once; the table is what makes that safe.
    expect(table.insert([entry()])).toBe(0);
    expect(table.count()).toBe(2);
    // A different Bot with the same coordinates is a different effect.
    expect(table.insert([entry({ botId: "scheduler" })])).toBe(1);
    expect(table.count()).toBe(3);
  });

  test("evicts the oldest rows past the row bound and says so", () => {
    const table = store({ maxRows: 3 });
    expect(table.state()).toBe("ready");
    for (let index = 0; index < 5; index += 1) {
      table.insert([
        entry({
          occurrenceId: `tool:1:1:${index}`,
          at: `2026-08-3${index}T00:00:00.000Z`,
        }),
      ]);
    }
    expect(table.count()).toBe(3);
    expect(table.state()).toBe("truncated");
    // The newest survived; the oldest are what left.
    expect(table.all().map((row) => row.at)).toEqual([
      "2026-08-34T00:00:00.000Z",
      "2026-08-33T00:00:00.000Z",
      "2026-08-32T00:00:00.000Z",
    ]);
  });

  test("evicts past the age bound whatever the row count", () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    const table = store({ maxAgeMs: 1_000, now: () => now });
    table.insert([
      entry({ occurrenceId: "tool:1:1:0", at: "2026-08-30T00:00:00.000Z" }),
      entry({ occurrenceId: "tool:1:1:1", at: "2026-08-30T23:59:59.900Z" }),
    ]);
    expect(table.all().map((row) => row.occurrenceId)).toEqual(["tool:1:1:1"]);
    expect(table.state()).toBe("truncated");
  });

  test("purges one Bot and leaves the others", () => {
    const table = store();
    table.insert([entry(), entry({ botId: "scheduler" })]);
    expect(table.purge("foreman")).toEqual(1);
    expect(table.all().map((row) => row.botId)).toEqual(["scheduler"]);
    expect(table.purge("foreman")).toEqual(0);
  });

  test("filters by kind, target and Bot, and pages with a cursor", () => {
    const table = store();
    table.insert([
      entry({ occurrenceId: "tool:1:1:0", at: "2026-08-31T00:00:01.000Z" }),
      entry({
        occurrenceId: "tool:1:1:1",
        at: "2026-08-31T00:00:02.000Z",
        kind: "mcp",
        target: "remote:mcp.example.test",
        toolName: "mcp__example__echo",
      }),
      entry({
        occurrenceId: "tool:1:1:2",
        at: "2026-08-31T00:00:03.000Z",
        kind: "browser",
      }),
    ]);
    expect(
      table.query({ kind: "shell" }).entries.map((row) => row.kind),
    ).toEqual(["shell"]);
    expect(
      table
        .query({ target: "remote:mcp.example.test" })
        .entries.map((row) => row.toolName),
    ).toEqual(["mcp__example__echo"]);
    expect(table.query({ botId: "nobody" }).entries).toEqual([]);

    // Newest first, one at a time, and the cursor walks the rest.
    const first = table.query({ limit: 1 });
    expect(first.total).toBe(3);
    expect(first.entries[0]!.occurrenceId).toBe("tool:1:1:2");
    const second = table.query({ limit: 1, before: first.nextCursor! });
    expect(second.entries[0]!.occurrenceId).toBe("tool:1:1:1");
    const third = table.query({ limit: 1, before: second.nextCursor! });
    expect(third.entries[0]!.occurrenceId).toBe("tool:1:1:0");
    expect(third.nextCursor).toBeUndefined();
  });

  test("rows written between two pages do not repeat or hide a row", () => {
    const table = store();
    table.insert([
      entry({ occurrenceId: "tool:1:1:0", at: "2026-08-31T00:00:01.000Z" }),
      entry({ occurrenceId: "tool:1:1:1", at: "2026-08-31T00:00:02.000Z" }),
      entry({ occurrenceId: "tool:1:1:2", at: "2026-08-31T00:00:03.000Z" }),
    ]);

    const first = table.query({ limit: 2 });
    expect(first.entries.map((row) => row.occurrenceId)).toEqual([
      "tool:1:1:2",
      "tool:1:1:1",
    ]);

    // The Bot keeps working while the reader reads. Under an offset cursor
    // these two new rows shifted the window down by two, so "Load more"
    // returned `tool:1:1:2` and `tool:1:1:1` a second time — duplicate rows on
    // screen and duplicate Vue keys — and `tool:1:1:0` was never reachable.
    table.insert([
      entry({ occurrenceId: "tool:1:1:3", at: "2026-08-31T00:00:04.000Z" }),
      entry({ occurrenceId: "tool:1:1:4", at: "2026-08-31T00:00:05.000Z" }),
    ]);

    const second = table.query({ limit: 2, before: first.nextCursor! });
    expect(second.entries.map((row) => row.occurrenceId)).toEqual([
      "tool:1:1:0",
    ]);
    expect(second.nextCursor).toBeUndefined();
    const shown = [...first.entries, ...second.entries].map(
      (row) => row.occurrenceId,
    );
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("a rebuild empties the table and reproduces the identical set", async () => {
    const table = store({ maxRows: 2 });
    const entries = [
      entry({ occurrenceId: "tool:1:1:0", at: "2026-08-31T00:00:01.000Z" }),
      entry({ occurrenceId: "tool:1:1:1", at: "2026-08-31T00:00:02.000Z" }),
    ];
    table.insert([
      ...entries,
      entry({ occurrenceId: "tool:1:1:2", at: "2026-08-01T00:00:00.000Z" }),
    ]);
    expect(table.state()).toBe("truncated");
    const before = table.all();

    const outcome = await table.rebuild([
      {
        botId: "foreman",
        page: async (cursor) =>
          cursor ? { entries: [] } : { entries, nextCursor: undefined },
      },
    ]);
    expect(outcome).toMatchObject({ entries: 2, bots: 1, indexState: "ready" });
    // A completed rebuild clears the truncation marker, because the table is
    // once again everything the durable events say it should be.
    expect(table.state()).toBe("ready");
    expect(table.all()).toEqual(before);
  });

  test("a rebuild refuses a page that names another Bot's rows", async () => {
    const table = store();
    await table.rebuild([
      {
        botId: "foreman",
        page: async () => ({ entries: [entry({ botId: "scheduler" })] }),
      },
    ]);
    expect(table.count()).toBe(0);
  });
});

describe("a rebuild that fails", () => {
  test("leaves the live table exactly as it was", async () => {
    const table = store();
    table.insert([entry(), entry({ occurrenceId: "tool:1:1:1" })]);
    expect(table.count()).toBe(2);

    // The rebuild used to `DELETE FROM` the live table before it fetched page
    // one, so any source failure left a truncated table still reporting
    // `ready` — a person would read an audit log with rows silently missing
    // and nothing saying so.
    await expect(
      table.rebuild([
        {
          botId: "foreman",
          page: async () => {
            throw new Error("the Bot object is unreachable");
          },
        },
      ]),
    ).rejects.toThrow("unreachable");

    expect(table.count()).toBe(2);
    expect(table.state()).toBe("ready");
  });

  test("a rebuild that succeeds replaces the table wholesale", async () => {
    const table = store();
    table.insert([entry({ occurrenceId: "tool:9:9:9" })]);

    const receipt = await table.rebuild([
      {
        botId: "foreman",
        page: async (cursor?: string) =>
          cursor === undefined
            ? {
                entries: [entry({ occurrenceId: "tool:1:1:0" })],
                nextCursor: "p1",
              }
            : { entries: [entry({ occurrenceId: "tool:1:1:1" })] },
      },
    ]);

    expect(receipt).toMatchObject({ entries: 2, bots: 1, indexState: "ready" });
    expect(table.count()).toBe(2);
    // The row the old table held and the sources no longer offer is gone: a
    // rebuild is a replacement, not a merge.
    expect(
      table
        .query({})
        .entries.map((row) => row.occurrenceId)
        .sort(),
    ).toEqual(["tool:1:1:0", "tool:1:1:1"]);
  });

  test("refuses a second rebuild while one is running", async () => {
    const table = store();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = table.rebuild([
      {
        botId: "foreman",
        page: async () => {
          await gate;
          return { entries: [entry()] };
        },
      },
    ]);

    // `audit-rebuilding` was written and never read as a lock, so two
    // concurrent rebuilds wiped each other.
    await expect(
      table.rebuild([
        { botId: "foreman", page: async () => ({ entries: [] }) },
      ]),
    ).rejects.toThrow("already running");

    release?.();
    await first;
    expect(table.state()).toBe("ready");
  });
});

describe("retention", () => {
  test("is enforced on a read too, not only when something is written", () => {
    let now = Date.parse("2026-08-31T00:00:00.000Z");
    const table = store({ maxAgeMs: 60_000, now: () => now });
    table.insert([entry({ at: "2026-08-31T00:00:00.000Z" })]);
    expect(table.count()).toBe(1);

    // A Bot nobody has spoken to since kept every row past the age bound,
    // because eviction only ever ran on insert. Retention is a promise about
    // time.
    now += 10 * 60_000;
    expect(table.query({}).entries).toHaveLength(0);
  });
});

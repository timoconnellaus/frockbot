import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  activityPageV1,
  activityRowV1,
  activityTextV1,
  serviceNameV1,
} from "./activity.ts";
import {
  decodeAuditActivityPageV1,
  type AuditActivityGroupV1,
  type AuditEntryV1,
} from "./shared.ts";
import { AuditStoreV1, type AuditSqlValueV1 } from "./store.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** The store over a real SQLite table: grouping is SQL, not a fake's. */
function store(): AuditStoreV1 {
  const database = new Database(":memory:");
  databases.push(database);
  return new AuditStoreV1({
    sql: {
      exec<Row extends Record<string, AuditSqlValueV1>>(
        query: string,
        ...bindings: SQLQueryBindings[]
      ) {
        const rows = database
          .query<Row, SQLQueryBindings[]>(query)
          .all(...bindings);
        return { toArray: () => rows };
      },
    },
    now: () => Date.parse("2026-09-25T12:00:00.000Z"),
  });
}

let occurrence = 0;
function entry(over: Partial<AuditEntryV1> = {}): AuditEntryV1 {
  occurrence += 1;
  const occurrenceId = `tool:1:${occurrence}:0`;
  return {
    schemaVersion: 1,
    botId: "bob",
    runId: "run-1",
    occurrenceId,
    turn: 1,
    step: occurrence,
    ordinal: 0,
    effectId: occurrenceId,
    at: "2026-09-25T10:00:00.000Z",
    kind: "shell",
    target: "computer",
    toolName: "computer_exec",
    argumentDigest: "a".repeat(64),
    preview: "ls -la",
    outcome: "ok",
    ...over,
  };
}

function group(over: Partial<AuditActivityGroupV1> = {}): AuditActivityGroupV1 {
  return {
    botId: "bob",
    runId: "run-1",
    kind: "shell",
    target: "computer",
    count: 1,
    at: "2026-09-25T10:00:00.000Z",
    preview: "ls -la",
    toolNames: ["computer_exec"],
    failed: 0,
    refused: 0,
    interrupted: 0,
    unknown: 0,
    approved: 0,
    ...over,
  };
}

describe("Activity, read a Turn at a time", () => {
  test("one Turn's effects in one place are one row, however interleaved", () => {
    const audit = store();
    audit.insert([
      entry({ at: "2026-09-25T10:00:01.000Z" }),
      // Another Bot's Turn lands between two of Bob's commands.
      entry({ botId: "scout", runId: "run-9", at: "2026-09-25T10:00:02.000Z" }),
      entry({ at: "2026-09-25T10:00:03.000Z", outcome: "error" }),
      entry({
        at: "2026-09-25T10:00:04.000Z",
        kind: "email",
        target: "email",
        toolName: "email/email_send",
        preview: "Sent an email the person approved",
      }),
    ]);
    const { groups } = audit.activity({});
    expect(
      groups.map((row) => [row.botId, row.kind, row.count, row.at]),
    ).toEqual([
      ["bob", "email", 1, "2026-09-25T10:00:04.000Z"],
      ["bob", "shell", 2, "2026-09-25T10:00:03.000Z"],
      ["scout", "shell", 1, "2026-09-25T10:00:02.000Z"],
    ]);
    expect(groups[0]).toMatchObject({ approved: 1 });
    expect(groups[1]).toMatchObject({
      failed: 1,
      toolNames: ["computer_exec"],
    });
  });

  test("a filter is a union of kinds, and a Bot filter is that Bot's", () => {
    const audit = store();
    audit.insert([
      entry(),
      entry({ kind: "browser", toolName: "computer_browser" }),
      entry({
        kind: "mcp",
        target: "remote:mcp.notion.com",
        toolName: "mcp-notion/create_page",
      }),
      entry({
        botId: "scout",
        kind: "mcp",
        target: "remote:mcp.notion.com",
        toolName: "mcp-notion/search",
      }),
    ]);
    expect(
      audit
        .activity({ kinds: ["shell", "process", "browser"] })
        .groups.map((row) => row.kind),
    ).toEqual(["browser", "shell"]);
    expect(
      audit
        .activity({ botId: "scout", kinds: ["email", "mcp", "file"] })
        .groups.map((row) => row.botId),
    ).toEqual(["scout"]);
    expect(audit.activity({ kinds: [] }).groups).toEqual([]);
  });

  test("Show earlier walks every row once, and never splits a Turn", () => {
    const audit = store();
    const entries: AuditEntryV1[] = [];
    for (let turn = 0; turn < 7; turn += 1) {
      for (let command = 0; command < 3; command += 1) {
        entries.push(
          entry({
            runId: `run-${turn}`,
            // Every Turn's commands share one moment, the worst case for a
            // cursor that addressed entries.
            at: new Date(Date.UTC(2026, 8, 25, turn)).toISOString(),
          }),
        );
      }
    }
    audit.insert(entries);
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = audit.activity({ limit: 3, ...(before ? { before } : {}) });
      seen.push(...page.groups.map((row) => `${row.runId}:${row.count}`));
      before = page.nextCursor;
      pages += 1;
    } while (before !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([
      "run-6:3",
      "run-5:3",
      "run-4:3",
      "run-3:3",
      "run-2:3",
      "run-1:3",
      "run-0:3",
    ]);
  });

  test("a group crosses the Worker boundary through its decoder", () => {
    const audit = store();
    audit.insert([entry()]);
    const page = {
      schemaVersion: 1,
      ...audit.activity({}),
      indexState: "ready",
    };
    expect(decodeAuditActivityPageV1(page).groups).toHaveLength(1);
    expect(() =>
      decodeAuditActivityPageV1({ ...page, groups: [{ botId: "bob" }] }),
    ).toThrow();
  });
});

describe("an Activity row", () => {
  test("says what happened in a sentence, grouped by Turn", () => {
    expect(activityTextV1(group({ count: 6 }))).toBe(
      "ran 6 commands on its Computer",
    );
    expect(activityTextV1(group())).toBe("ran “ls -la” on its Computer");
    expect(
      activityTextV1(
        group({
          target: "machine:tims-mac",
          preview: "git pull tims-mac",
          toolNames: ["machine_exec"],
        }),
      ),
    ).toBe("ran “git pull” on your computer");
    expect(
      activityTextV1(
        group({
          kind: "email",
          target: "email",
          toolNames: ["email/email_owner"],
          preview: "Emailed you: Weekly review",
        }),
      ),
    ).toBe("emailed you: “Weekly review”");
    expect(
      activityTextV1(
        group({
          kind: "mcp",
          target: "remote:mcp.notion.com",
          toolNames: ["mcp-notion/createPage"],
        }),
      ),
    ).toBe("called Notion: create page");
    expect(
      activityTextV1(
        group({
          kind: "file",
          target: "workspace",
          count: 2,
          toolNames: ["memory_write"],
        }),
      ),
    ).toBe("updated its memory 2 times");
  });

  test("a device use says how long and through what, and opens nothing", () => {
    const row = activityRowV1(
      group({
        kind: "device",
        runId: "device:use-12345678",
        target: "device:android",
        toolNames: ["microphone"],
        preview: "Tuner used the microphone",
        durationMs: 125_000,
      }),
      "Juniper",
    );
    expect(row).toEqual({
      botId: "bob",
      botName: "Juniper",
      at: "2026-09-25T10:00:00.000Z",
      text: "used the microphone for 2 min, through Tuner",
      place: "Android",
    });
  });

  test("a read is quiet, an approved send says so, and an unknown outcome is drawn", () => {
    const read = activityRowV1(
      group({
        kind: "mcp",
        count: 12,
        target: "remote:gmail.googleapis.com",
        toolNames: ["mcp-gmail/list_messages", "mcp-gmail/get_message"],
      }),
      "Scout",
    );
    expect(read).toMatchObject({
      text: "made 12 calls to Gmail",
      place: "Gmail",
      quiet: true,
    });
    // One write among the reads is a change.
    expect(
      activityRowV1(
        group({
          kind: "mcp",
          target: "remote:gmail.googleapis.com",
          toolNames: ["mcp-gmail/list_messages", "mcp-gmail/send_message"],
        }),
        "Scout",
      ).quiet,
    ).toBeUndefined();
    expect(
      activityRowV1(
        group({
          kind: "email",
          target: "email",
          toolNames: ["email/email_send"],
          approved: 1,
        }),
        "Scout",
      ),
    ).toMatchObject({ text: "sent an email", approved: true, place: "Email" });
    expect(
      activityRowV1(group({ count: 3, unknown: 1, failed: 2 }), "Bob").note,
    ).toBe("1 outcome unknown · 2 failed");
    expect(activityRowV1(group({ unknown: 1 }), "Bob").note).toBe(
      "Outcome unknown",
    );
  });

  test("a service is named the way a person knows it", () => {
    expect(serviceNameV1("remote:mcp.notion.com")).toBe("Notion");
    expect(serviceNameV1("remote:api.linear.app")).toBe("Linear");
    expect(serviceNameV1("remote:mcp-google-drive")).toBe("Google drive");
    expect(serviceNameV1("remote:mcp-proxy.acme.com")).toBe("Mcp-proxy");
    expect(serviceNameV1("remote:192.168.1.10:3000")).toBe("192.168.1.10");
  });

  test("a page names each Bot, and a Bot it cannot name is still a Bot", () => {
    const page = activityPageV1(
      {
        schemaVersion: 1,
        groups: [group(), group({ botId: "gone" })],
        nextCursor: "abc",
        indexState: "truncated",
      },
      { bob: "Bob" },
    );
    expect(page.rows.map((row) => row.botName)).toEqual(["Bob", "A Bot"]);
    expect(page).toMatchObject({ nextCursor: "abc", indexState: "truncated" });
  });
});

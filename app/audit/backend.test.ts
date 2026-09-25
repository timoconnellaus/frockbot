import { describe, expect, test } from "bun:test";
import {
  createAuditBackendContribution,
  decodeAuditRequestQueryV1,
  type AuditGatewayHost,
} from "./backend.ts";
import type { ActivityPage } from "@frockbot/core/protocol-schemas";
import {
  decodeClientAuditPageV1,
  type AuditActivityQueryV1,
  type AuditEntryV1,
  type AuditQueryV1,
  type AuditRebuildReceiptV1,
  type ClientAuditPageV1,
} from "./shared.ts";
import { FakeAuditSql } from "./testing.ts";
import { AuditUserBackendContribution } from "./user.ts";

function url(query: string): URL {
  return new URL(`https://bot.frockbot.com/api/audit?${query}`);
}

describe("the audit query decoder", () => {
  test("decodes exactly the parameters the route implements", () => {
    expect(
      decodeAuditRequestQueryV1(
        url("botId=foreman&kind=shell&target=computer&before=p50&limit=20"),
      ),
    ).toEqual({
      schemaVersion: 1,
      botId: "foreman",
      kind: "shell",
      target: "computer",
      before: "p50",
      limit: 20,
    });
    expect(decodeAuditRequestQueryV1(url(""))).toEqual({ schemaVersion: 1 });
  });

  test("refuses an unexpected parameter rather than ignoring it", () => {
    // A client that means something the route does not implement finds out,
    // instead of being handed a page it will misread as filtered.
    expect(() => decodeAuditRequestQueryV1(url("userId=someone"))).toThrow(
      "not allowed",
    );
    expect(() => decodeAuditRequestQueryV1(url("q=ls"))).toThrow("not allowed");
  });

  test("refuses a repeated parameter", () => {
    expect(() => decodeAuditRequestQueryV1(url("kind=shell&kind=mcp"))).toThrow(
      "is repeated",
    );
  });

  test("refuses a value the schema does not carry", () => {
    expect(() => decodeAuditRequestQueryV1(url("kind=network"))).toThrow();
    expect(() => decodeAuditRequestQueryV1(url("target=box"))).toThrow();
    expect(() => decodeAuditRequestQueryV1(url("limit=0"))).toThrow();
    expect(() => decodeAuditRequestQueryV1(url("limit=abc"))).toThrow();
    expect(() =>
      decodeAuditRequestQueryV1(url(`before=${"p".repeat(2_000)}`)),
    ).toThrow();
  });
});

const ENTRY: AuditEntryV1 = {
  schemaVersion: 1,
  botId: "foreman",
  runId: "run-1",
  occurrenceId: "tool:1:1:0",
  turn: 1,
  step: 1,
  ordinal: 0,
  effectId: "tool:1:1:0",
  at: "2026-08-31T00:00:00.000Z",
  kind: "shell",
  target: "computer",
  toolName: "computer_exec",
  argumentDigest: "a".repeat(64),
  preview: "ls -la",
  outcome: "ok",
};

const RECEIPT: AuditRebuildReceiptV1 = {
  schemaVersion: 1,
  status: "rebuilt",
  entries: 1,
  bots: 1,
  indexState: "ready",
  unknownOutcomes: 0,
};

function host(overrides: Partial<AuditGatewayHost> = {}): AuditGatewayHost & {
  queries: AuditQueryV1[];
  activity: AuditActivityQueryV1[];
} {
  const queries: AuditQueryV1[] = [];
  const activity: AuditActivityQueryV1[] = [];
  return {
    queries,
    activity,
    readActivity: async (_userId, query) => {
      activity.push(query);
      return {
        schemaVersion: 1,
        groups: [
          {
            botId: "foreman",
            runId: "run-1",
            kind: "shell",
            target: "computer",
            count: 6,
            at: ENTRY.at,
            preview: "ls -la",
            toolNames: ["computer_exec"],
            failed: 0,
            refused: 0,
            interrupted: 0,
            unknown: 0,
            approved: 0,
          },
        ],
        indexState: "ready",
      };
    },
    readAudit: async (_userId, query) => {
      queries.push(query);
      const page: ClientAuditPageV1 = {
        schemaVersion: 1,
        entries: [ENTRY],
        page: { truncated: false },
        total: 1,
        indexState: "ready",
      };
      return page;
    },
    rebuildAuditIndex: async () => RECEIPT,
    listBots: async () => ({
      schemaVersion: 1 as const,
      revision: 1,
      bots: [
        {
          schemaVersion: 1 as const,
          botId: "foreman",
          registeredAt: "2026-08-31T00:00:00.000Z",
          initialName: "Foreman",
          avatar: {
            schemaVersion: 1 as const,
            characterId: "pixel",
            primary: "#fc85ae",
          },
        },
      ],
    }),
    ...overrides,
  };
}

function get(path: string): { request: Request; url: URL } {
  const target = new URL(`https://bot.frockbot.com${path}`);
  return { request: new Request(target), url: target };
}

describe("the audit gateway route", () => {
  const context = { userId: "alice", client: "browser" as const };

  test("answers only its own paths, and only for an authenticated User", async () => {
    const route = createAuditBackendContribution(host());
    const other = get("/api/search?q=x");
    expect(
      await route.route(other.request, other.url, context),
    ).toBeUndefined();
    const mine = get("/api/audit");
    expect(
      await route.route(mine.request, mine.url, {
        client: "browser",
      }),
    ).toBeUndefined();
  });

  test("carries the decoded filters to the User Durable Object", async () => {
    const gateway = host();
    const route = createAuditBackendContribution(gateway);
    const { request, url: target } = get("/api/audit?kind=mcp&botId=foreman");
    const response = await route.route(request, target, context);
    expect(response?.status).toBe(200);
    expect(gateway.queries).toEqual([
      { schemaVersion: 1, botId: "foreman", kind: "mcp" },
    ]);
    expect(await response!.json()).toMatchObject({ total: 1 });
  });

  test("refuses an invalid query definitively, and a wrong method", async () => {
    const route = createAuditBackendContribution(host());
    const bad = get("/api/audit?userId=someone");
    const refused = await route.route(bad.request, bad.url, context);
    expect(refused?.status).toBe(400);
    expect(await refused!.json()).toMatchObject({
      code: "invalid-request",
      definitive: true,
    });

    const posted = new URL("https://bot.frockbot.com/api/audit");
    const wrong = await route.route(
      new Request(posted, { method: "POST" }),
      posted,
      context,
    );
    expect(wrong?.status).toBe(405);
  });

  test("rebuilds on POST and answers the receipt", async () => {
    const route = createAuditBackendContribution(host());
    const target = new URL("https://bot.frockbot.com/api/audit/rebuild");
    const response = await route.route(
      new Request(target, { method: "POST" }),
      target,
      context,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json<unknown>()).toEqual(RECEIPT);

    // A rebuild is a write; a GET must not perform one.
    const read = await route.route(new Request(target), target, context);
    expect(read?.status).toBe(405);
  });

  test("`as=activity` answers Activity rows, named, for the filter asked", async () => {
    const gateway = host();
    const route = createAuditBackendContribution(gateway);
    const { request, url: target } = get(
      "/api/audit?botId=foreman&filter=commands&as=activity",
    );
    const response = await route.route(request, target, context);
    expect(response?.status).toBe(200);
    const page = await response!.json<ActivityPage>();
    expect(page.rows).toEqual([
      {
        botId: "foreman",
        botName: "Foreman",
        at: "2026-08-31T00:00:00.000Z",
        text: "ran 6 commands on its Computer",
        place: "Computer",
        runId: "run-1",
      },
    ]);
    // `as` never reaches the query the User Durable Object is asked.
    expect(gateway.activity.at(-1)).toEqual({
      botId: "foreman",
      filter: "commands",
    });

    // A client that wants the page keeps getting one.
    const plain = get("/api/audit?botId=foreman");
    const raw = await route.route(plain.request, plain.url, context);
    expect(await raw!.json<{ total: number }>()).toMatchObject({ total: 1 });
  });

  test("Activity refuses the entry filters, and the entry read refuses Activity's", async () => {
    const route = createAuditBackendContribution(host());
    for (const path of [
      "/api/audit?kind=shell&as=activity",
      "/api/audit?filter=bogus&as=activity",
      "/api/audit?filter=commands",
      "/api/audit?as=document",
    ]) {
      const { request, url: target } = get(path);
      const response = await route.route(request, target, context);
      expect(response?.status).toBe(400);
    }
  });

  test("turns an unexpected failure into a 500, not a leaked stack", async () => {
    const route = createAuditBackendContribution(
      host({
        readAudit: () => Promise.reject(new Error("the User object is away")),
      }),
    );
    const { request, url: target } = get("/api/audit");
    const response = await route.route(request, target, context);
    expect(response?.status).toBe(500);
    expect(await response!.json<unknown>()).toEqual({
      error: "the User object is away",
    });
  });
});

describe("paging the audit route with real ids", () => {
  test("walks every page past the first, cursor and all", async () => {
    // Real ids, not "p50": a Bot id is a UUID and a native run id is 33
    // characters, and the cursor carries both. A bound that fit a toy cursor
    // refused the second page of every real account.
    const botId = crypto.randomUUID();
    const entries = Array.from({ length: 120 }, (_, index) => {
      const occurrenceId = `tool:${index + 1}:1:0`;
      return {
        ...ENTRY,
        botId,
        runId: `n${btoa(String(index).padStart(24, "x")).replaceAll("=", "")}`,
        occurrenceId,
        turn: index + 1,
        effectId: occurrenceId,
        at: new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString(),
      };
    });
    expect(entries[0]!.runId).toHaveLength(33);
    const audit = new AuditUserBackendContribution({
      sql: new FakeAuditSql(),
      readDirectory: async () => ({ botIds: [botId] }),
      projectBotEntries: async () => ({ schemaVersion: 1, botId, entries: [] }),
    });
    await audit.indexAuditEntries(entries);
    // The same answer the User Durable Object gives, through the same decoder
    // the Worker reads it with.
    const route = createAuditBackendContribution(
      host({
        readAudit: async (_userId, query) => {
          const page = audit.query(query);
          return decodeClientAuditPageV1({
            schemaVersion: 1,
            entries: page.entries,
            page: {
              truncated: page.nextCursor !== undefined,
              ...(page.nextCursor === undefined
                ? {}
                : { nextCursor: page.nextCursor }),
            },
            total: page.total,
            indexState: audit.state(),
          });
        },
      }),
    );
    const context = { userId: "alice", client: "browser" as const };
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const { request, url: target } = get(
        `/api/audit?${new URLSearchParams(before === undefined ? {} : { before })}`,
      );
      const response = await route.route(request, target, context);
      expect(response?.status).toBe(200);
      const page = await response!.json<ClientAuditPageV1>();
      seen.push(...page.entries.map((entry) => entry.runId));
      before = page.page.nextCursor;
      pages += 1;
    } while (before !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(120);
  });
});

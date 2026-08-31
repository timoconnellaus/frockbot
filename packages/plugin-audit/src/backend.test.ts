import { describe, expect, test } from "bun:test";
import {
  createAuditBackendContribution,
  decodeAuditRequestQueryV1,
  type AuditGatewayHost,
} from "./backend.ts";
import type {
  AuditEntryV1,
  AuditQueryV1,
  AuditRebuildReceiptV1,
  ClientAuditPageV1,
} from "./shared.ts";

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
      decodeAuditRequestQueryV1(url(`before=${"p".repeat(200)}`)),
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
  hostJournalDiscrepancies: 0,
};

function host(
  overrides: Partial<AuditGatewayHost> = {},
): AuditGatewayHost & { queries: AuditQueryV1[] } {
  const queries: AuditQueryV1[] = [];
  return {
    queries,
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

  test("rebuilds on POST and answers the receipt, discrepancies and all", async () => {
    const route = createAuditBackendContribution(host());
    const target = new URL("https://bot.frockbot.com/api/audit/rebuild");
    const response = await route.route(
      new Request(target, { method: "POST" }),
      target,
      context,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(RECEIPT);

    // A rebuild is a write; a GET must not perform one.
    const read = await route.route(new Request(target), target, context);
    expect(read?.status).toBe(405);
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
    expect(await response!.json()).toEqual({
      error: "the User object is away",
    });
  });
});

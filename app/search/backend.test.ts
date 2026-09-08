import { describe, expect, test } from "bun:test";
import {
  createSearchBackendContribution,
  decodeSearchRequestQueryV1,
  type SearchGatewayHost,
} from "./backend.ts";
import {
  decodeClientSearchRebuildReceiptV1,
  decodeClientSearchResultsV1,
  type SearchIndexResultsV1,
  type SearchQueryV1,
} from "./shared.ts";

function url(search: string): URL {
  return new URL(`https://frockbot.test/api/search${search}`);
}

function host(
  overrides: Partial<SearchGatewayHost> = {},
): SearchGatewayHost & { queries: SearchQueryV1[] } {
  const queries: SearchQueryV1[] = [];
  return {
    queries,
    async searchTranscripts(_userId, query) {
      queries.push(query);
      return {
        schemaVersion: 1,
        query: query.query,
        hits: [
          {
            botId: "bot-a",
            runId: "run-1",
            kind: "user",
            at: "2026-08-31T00:00:00.000Z",
            snippet: "the gym build",
          },
        ],
        truncated: false,
        indexState: "ready",
      } satisfies SearchIndexResultsV1;
    },
    async rebuildSearchIndex() {
      return {
        schemaVersion: 1,
        status: "rebuilt",
        indexedRows: 4,
        bots: 2,
        indexState: "ready",
      };
    },
    async listBotIdentities() {
      return {
        schemaVersion: 1,
        identities: [
          {
            schemaVersion: 1,
            botId: "bot-a",
            name: "Site foreman",
            namedBy: "user",
            hiddenFromSidebar: false,
          },
        ],
      };
    },
    async listBotLifecycles() {
      return { schemaVersion: 1, lifecycles: [] };
    },
    ...overrides,
  };
}

const CONTEXT = { userId: "user-1", client: "browser" as const };

describe("the search query string", () => {
  test("round-trips every accepted parameter into the exact DTO", () => {
    expect(
      decodeSearchRequestQueryV1(
        url(
          "?q=gym&before=p50&kinds=user,tool&botId=bot-a&includeArchived=true",
        ),
      ),
    ).toEqual({
      schemaVersion: 1,
      query: "gym",
      before: "p50",
      kinds: ["user", "tool"],
      botId: "bot-a",
      includeArchived: true,
    });
  });

  test("refuses an unexpected, repeated, or invalid parameter", () => {
    expect(() =>
      decodeSearchRequestQueryV1(url("?q=gym&userId=other")),
    ).toThrow("not allowed");
    expect(() => decodeSearchRequestQueryV1(url("?q=gym&q=other"))).toThrow(
      "repeated",
    );
    expect(() =>
      decodeSearchRequestQueryV1(url("?q=gym&includeArchived=yes")),
    ).toThrow("includeArchived is invalid");
    expect(() =>
      decodeSearchRequestQueryV1(url("?q=gym&kinds=secret")),
    ).toThrow();
  });
});

describe("the search route", () => {
  test("declines a path it does not own and an unauthenticated request", async () => {
    const route = createSearchBackendContribution(host());
    expect(
      await route.route(
        new Request("https://frockbot.test/api/bots"),
        new URL("https://frockbot.test/api/bots"),
        CONTEXT,
      ),
    ).toBeUndefined();
    expect(
      await route.route(new Request(url("?q=gym")), url("?q=gym"), {
        client: "browser",
      }),
    ).toBeUndefined();
  });

  test("answers a grouped page the client decoder accepts", async () => {
    const route = createSearchBackendContribution(host());
    const response = await route.route(
      new Request(url("?q=gym")),
      url("?q=gym"),
      CONTEXT,
    );
    expect(response?.status).toBe(200);
    const decoded = decodeClientSearchResultsV1(await response!.json());
    expect(decoded.groups).toHaveLength(1);
    expect(decoded.groups[0]).toMatchObject({
      botId: "bot-a",
      botName: "Site foreman",
      archived: false,
    });
    expect(decoded.groups[0]!.hits[0]!.deepLink).toBe("/?bot=bot-a#turn-run-1");
  });

  test("marks a Bot archived from the live lifecycle directory", async () => {
    const route = createSearchBackendContribution(
      host({
        listBotLifecycles: async () => ({
          schemaVersion: 1,
          lifecycles: [
            {
              schemaVersion: 1,
              botId: "bot-a",
              status: "archived",
              revision: 1,
            },
          ],
        }),
      }),
    );
    const response = await route.route(
      new Request(url("?q=gym&includeArchived=true")),
      url("?q=gym&includeArchived=true"),
      CONTEXT,
    );
    const decoded = decodeClientSearchResultsV1(await response!.json());
    expect(decoded.groups[0]!.archived).toBe(true);
  });

  test("refuses an invalid query with a definitive 400", async () => {
    const route = createSearchBackendContribution(host());
    const response = await route.route(
      new Request(url("?q=gym&nope=1")),
      url("?q=gym&nope=1"),
      CONTEXT,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      code: "invalid-request",
      definitive: true,
    });
  });

  test("rebuilds only on POST", async () => {
    const route = createSearchBackendContribution(host());
    const rebuildUrl = new URL("https://frockbot.test/api/search/rebuild");
    expect(
      (
        await route.route(
          new Request(rebuildUrl, { method: "GET" }),
          rebuildUrl,
          CONTEXT,
        )
      )?.status,
    ).toBe(405);
    const response = await route.route(
      new Request(rebuildUrl, { method: "POST" }),
      rebuildUrl,
      CONTEXT,
    );
    expect(
      decodeClientSearchRebuildReceiptV1(await response!.json()),
    ).toMatchObject({ status: "rebuilt", indexedRows: 4 });
  });

  test("defaults to excluding tool rows and archived Bots", async () => {
    const contribution = host();
    const route = createSearchBackendContribution(contribution);
    await route.route(new Request(url("?q=gym")), url("?q=gym"), CONTEXT);
    expect(contribution.queries[0]).toEqual({ schemaVersion: 1, query: "gym" });
  });
});

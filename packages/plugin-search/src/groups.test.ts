import { describe, expect, test } from "bun:test";
import { groupSearchHitsV1, type SearchBotDescriptorV1 } from "./groups.ts";
import {
  decodeClientSearchResultsV1,
  type SearchIndexResultsV1,
} from "./shared.ts";

const AT = "2026-08-31T00:00:00.000Z";

function results(
  hits: Array<{ botId: string; runId: string }>,
  overrides: Partial<SearchIndexResultsV1> = {},
): SearchIndexResultsV1 {
  return {
    schemaVersion: 1,
    query: "gym",
    hits: hits.map((hit) => ({
      botId: hit.botId,
      runId: hit.runId,
      kind: "user" as const,
      at: AT,
      snippet: "the gym build",
    })),
    truncated: false,
    indexState: "ready",
    ...overrides,
  };
}

const DIRECTORY: SearchBotDescriptorV1[] = [
  { botId: "bot-a", name: "Site foreman", archived: false, hidden: false },
  { botId: "bot-b", name: "Bookkeeper", archived: false, hidden: true },
  { botId: "bot-c", name: "Old hand", archived: true, hidden: false },
];

describe("grouping hits by Bot", () => {
  test("keeps rank order for groups and for hits inside a group", () => {
    const grouped = groupSearchHitsV1(
      results([
        { botId: "bot-b", runId: "run-1" },
        { botId: "bot-a", runId: "run-2" },
        { botId: "bot-b", runId: "run-3" },
      ]),
      DIRECTORY,
    );
    expect(grouped.groups.map((group) => group.botId)).toEqual([
      "bot-b",
      "bot-a",
    ]);
    expect(grouped.groups[0]!.hits.map((hit) => hit.runId)).toEqual([
      "run-1",
      "run-3",
    ]);
    expect(grouped.groups[0]!.totalHits).toBe(2);
  });

  test("names each Bot from the live directory and labels hidden and archived", () => {
    const grouped = groupSearchHitsV1(
      results([
        { botId: "bot-b", runId: "run-1" },
        { botId: "bot-c", runId: "run-2" },
      ]),
      DIRECTORY,
    );
    expect(grouped.groups[0]).toMatchObject({
      botName: "Bookkeeper",
      hidden: true,
      archived: false,
    });
    expect(grouped.groups[1]).toMatchObject({
      botName: "Old hand",
      archived: true,
    });
  });

  test("builds the deep link so no client assembles one", () => {
    const grouped = groupSearchHitsV1(
      results([{ botId: "bot-a", runId: "run-2" }]),
      DIRECTORY,
    );
    expect(grouped.groups[0]!.hits[0]!.deepLink).toBe("/?bot=bot-a#turn-run-2");
  });

  test("keeps a hit whose Bot the directory no longer describes", () => {
    const grouped = groupSearchHitsV1(
      results([{ botId: "bot-gone", runId: "run-9" }]),
      DIRECTORY,
    );
    expect(grouped.groups[0]).toMatchObject({
      botId: "bot-gone",
      botName: "bot-gone",
      archived: false,
      hidden: false,
    });
  });

  test("carries the page and index state through", () => {
    const grouped = groupSearchHitsV1(
      results([{ botId: "bot-a", runId: "run-1" }], {
        truncated: true,
        nextCursor: "p50",
        indexState: "truncated",
      }),
      DIRECTORY,
    );
    expect(grouped.page).toEqual({ truncated: true, nextCursor: "p50" });
    expect(grouped.indexState).toBe("truncated");
  });

  test("produces a value the client decoder accepts unchanged", () => {
    const grouped = groupSearchHitsV1(
      results([
        { botId: "bot-a", runId: "run-1" },
        { botId: "bot-c", runId: "run-2" },
      ]),
      [
        ...DIRECTORY,
        {
          botId: "bot-a",
          name: "Site foreman",
          archived: false,
          hidden: false,
          avatarUrl: "/api/bots/bot-a/avatar?v=abc",
        },
      ],
    );
    expect(
      decodeClientSearchResultsV1(JSON.parse(JSON.stringify(grouped))),
    ).toEqual(grouped);
  });
});

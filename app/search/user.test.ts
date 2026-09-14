import { expect, test } from "bun:test";
import { searchRowsFromClientRunV1 } from "./bot.ts";
import { SearchUserBackendContribution } from "./user.ts";
import { FakeSearchSql } from "./testing.ts";

test("rebuilding preserves every decoded row when a turn shares several links", async () => {
  const rows = Array.from({ length: 32 }, (_, index) =>
    searchRowsFromClientRunV1("scout", {
      runId: `run-${index}`,
      admittedAt: "2026-09-01T00:00:00.000Z",
      status: "completed",
      input: "Find reports",
      events: [
        {
          type: "send/to-user",
          payload: {
            type: "text",
            text: Array.from(
              { length: 7 },
              (_, link) => `https://example.com/report-${link}`,
            ).join(" "),
          },
        },
      ],
    }),
  ).flat();
  const search = new SearchUserBackendContribution({
    sql: new FakeSearchSql(),
    readDirectory: async () => ({ botIds: ["scout"], archivedBotIds: [] }),
    projectBotRows: async () => ({ schemaVersion: 1, botId: "scout", rows }),
  });
  expect(rows).toHaveLength(288);
  expect(await search.indexRows(rows)).toEqual({ indexed: 288 });
  expect(await search.rebuild()).toMatchObject({
    indexedRows: 288,
    indexState: "ready",
  });
});

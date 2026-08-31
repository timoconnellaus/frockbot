// Transcript search through the gateway, the loaded artifact, and the User
// Durable Object's real FTS5 index.
//
// The claim this layer exists to make is the one no unit test can: Alice
// searching sees Alice's turns and only Alice's, because the index lives in
// her Durable Object and there is no cross-User store for a query to reach
// into. Bob, searching the same words, finds nothing at all.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface SearchHit {
  runId: string;
  kind: string;
  at: string;
  snippet: string;
  deepLink: string;
}

interface SearchGroup {
  botId: string;
  botName: string;
  archived: boolean;
  hidden: boolean;
  hits: SearchHit[];
  totalHits: number;
}

interface SearchResults {
  schemaVersion: 1;
  query: string;
  groups: SearchGroup[];
  page: { truncated: boolean; nextCursor?: string };
  indexState: string;
}

async function settleTurn(
  userId: string,
  botId: string,
  commandId: string,
  text: string,
): Promise<void> {
  const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
    schemaVersion: 1,
    commandId,
    text,
  });
  expect(response.status).toBe(200);
}

async function search(userId: string, query: string): Promise<SearchResults> {
  return (await expectOkJson(
    await asUser(userId, `/api/search?${query}`),
  )) as SearchResults;
}

function hitRunIds(results: SearchResults): string[] {
  return results.groups.flatMap((group) => group.hits.map((hit) => hit.runId));
}

describe("searching every Bot's transcript", () => {
  it("returns one User's turns grouped by Bot, and another User none", async () => {
    const alice = freshUserId("search-alice");
    const bob = freshUserId("search-bob");
    await provisionThroughGateway({ userId: alice, botId: "foreman" });
    await provisionThroughGateway({ userId: bob, botId: "bookkeeper" });

    // A second Bot for Alice, so grouping has more than one group to make.
    const second = await postAsUser(alice, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-scheduler",
      expectedRevision: 1,
      botId: "scheduler",
      name: "Scheduler",
    });
    expect(second.status).toBe(201);

    await settleTurn(
      alice,
      "foreman",
      "alice-1",
      "How is the gym build in Wollongong?",
    );
    await settleTurn(
      alice,
      "scheduler",
      "alice-2",
      "Book the Wollongong site visit.",
    );
    await settleTurn(bob, "bookkeeper", "bob-1", "Reconcile the March ledger.");

    const results = await search(alice, "q=wollongong");
    expect(results.indexState).toBe("ready");
    expect(results.groups.map((group) => group.botId).sort()).toEqual([
      "foreman",
      "scheduler",
    ]);
    expect(hitRunIds(results).sort()).toEqual(["alice-1", "alice-2"]);
    // Each group is named from the live Bot directory, not from a copy the
    // index made when the row was written.
    expect(
      results.groups.find((group) => group.botId === "scheduler")?.botName,
    ).toBe("Scheduler");

    // THE DEEP LINK RESOLVES TO A REAL RUN. Same shape the overlay follows.
    const hit = results.groups
      .flatMap((group) => group.hits)
      .find((candidate) => candidate.runId === "alice-1");
    expect(hit?.deepLink).toBe("/?bot=foreman#turn-alice-1");
    const run = (await expectOkJson(
      await asUser(alice, "/api/bots/foreman/turns/alice-1"),
    )) as { state: string; run: { runId: string; input: string } };
    expect(run.state).toBe("terminal");
    expect(run.run.runId).toBe("alice-1");
    expect(run.run.input).toContain("Wollongong");

    // BOB SEES NOTHING. His own words still find his own turn, which is what
    // makes the empty answer above evidence rather than a broken route.
    expect((await search(bob, "q=wollongong")).groups).toEqual([]);
    expect(hitRunIds(await search(bob, "q=ledger"))).toEqual(["bob-1"]);
  });

  it("excludes an archived Bot until the query opts in, and labels it", async () => {
    const userId = freshUserId("search-archive");
    await provisionThroughGateway({ userId, botId: "keeper" });
    await settleTurn(userId, "keeper", "keep-1", "Where are the Bendigo keys?");

    expect(hitRunIds(await search(userId, "q=bendigo"))).toEqual(["keep-1"]);

    const archived = await postAsUser(userId, "/api/bots/keeper/lifecycle", {
      schemaVersion: 1,
      type: "bot/archive",
      commandId: "archive-keeper",
      botId: "keeper",
    });
    expect([200, 202]).toContain(archived.status);

    // Archiving purges the rows outright, so the Bot leaves the index rather
    // than merely being filtered out of it.
    expect((await search(userId, "q=bendigo")).groups).toEqual([]);
    expect(
      (await search(userId, "q=bendigo&includeArchived=true")).groups,
    ).toEqual([]);

    // A rebuild re-projects them, because archiving a Bot deletes no Turn —
    // the conversation is still there, and the index is only a view of it.
    // The default query still hides them; `includeArchived` is what asks.
    await expectOkJson(await postAsUser(userId, "/api/search/rebuild", {}));
    expect((await search(userId, "q=bendigo")).groups).toEqual([]);
    const opted = await search(userId, "q=bendigo&includeArchived=true");
    expect(hitRunIds(opted)).toEqual(["keep-1"]);
    expect(opted.groups[0]).toMatchObject({ botId: "keeper", archived: true });
  });

  it("rebuilds the index from the Bots' own stored runs", async () => {
    const userId = freshUserId("search-rebuild");
    await provisionThroughGateway({ userId, botId: "rebuilder" });
    await settleTurn(
      userId,
      "rebuilder",
      "rebuild-1",
      "Log the Ballarat delivery.",
    );

    const before = await search(userId, "q=ballarat");
    expect(hitRunIds(before)).toEqual(["rebuild-1"]);

    const receipt = (await expectOkJson(
      await postAsUser(userId, "/api/search/rebuild", {}),
    )) as { status: string; indexedRows: number; indexState: string };
    expect(receipt).toMatchObject({ status: "rebuilt", indexState: "ready" });
    expect(receipt.indexedRows).toBeGreaterThan(0);

    const after = await search(userId, "q=ballarat");
    expect(hitRunIds(after)).toEqual(hitRunIds(before));
  });

  it("keeps tool rows out of the default answer and refuses an invalid query", async () => {
    const userId = freshUserId("search-kinds");
    await provisionThroughGateway({ userId, botId: "toolbot" });
    await settleTurn(userId, "toolbot", "kind-1", "Check the Geelong roster.");

    const byDefault = await search(userId, "q=geelong");
    expect(
      byDefault.groups.every((group) =>
        group.hits.every((hit) => hit.kind !== "tool"),
      ),
    ).toBe(true);

    const refused = await asUser(
      userId,
      "/api/search?q=geelong&userId=someone",
    );
    expect(refused.status).toBe(400);
    expect(await expectJson(refused)).toMatchObject({
      code: "invalid-request",
      definitive: true,
    });
  });
});

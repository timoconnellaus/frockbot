// The transcript index against two real Bot Durable Objects and one real User
// Durable Object, on real FTS5.
//
// The claims, in order:
//
//  1. the Durable Object SQL authorizer allows `CREATE VIRTUAL TABLE … USING
//     fts5` at all — everything below assumes it;
//  2. two Bots of one User settle ordinary Turns and their transcripts land in
//     the *User* Durable Object, because "The User's Durable Object is the
//     authority for everything User-scoped";
//  3. the rows survive eviction, because they are durable state and not a
//     resident cache;
//  4. archiving a Bot purges its rows;
//  5. a rebuild from an emptied table reproduces the identical result set —
//     the property that makes the index a projection rather than an authority.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type {
  ClientSearchRebuildReceiptV1,
  SearchIndexResultsV1,
} from "@frockbot/plugin-search";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";

interface SearchRpc {
  searchTranscripts(input: unknown): Promise<SearchIndexResultsV1>;
  rebuildSearchIndex(input: unknown): Promise<ClientSearchRebuildReceiptV1>;
  purgeSearchIndex(input: unknown): Promise<{ removed: number }>;
  executeBotLifecycle(input: unknown): Promise<{ status: string }>;
}

function userStub(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as SearchRpc;
}

function botStub(userId: string, botId: string) {
  // The production address: `apps/cloudflare/src/index.ts` and the User
  // Durable Object's rebuild fan-out both name a Bot object this way, so a
  // test that named it anything else would exercise a different object.
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

async function settleTurn(
  identity: { userId: string; botId: string },
  runId: string,
  text: string,
): Promise<void> {
  const result = await botStub(identity.userId, identity.botId).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text,
    },
  });
  expect(result.text).toBe("Ollama reply");
}

function search(
  userId: string,
  query: Record<string, unknown>,
): Promise<SearchIndexResultsV1> {
  return userStub(userId).searchTranscripts({
    schemaVersion: 1,
    userId,
    query: { schemaVersion: 1, ...query },
  });
}

describe("the transcript index in Workerd", () => {
  test("the Durable Object SQL authorizer allows an FTS5 virtual table", async () => {
    // @ts-expect-error the spike probe is bound by this suite alone.
    const probe = env.SEARCH_SPIKE.getByName(`fts5-${crypto.randomUUID()}`);
    const outcome = await probe.fts5();
    expect(outcome.failure).toBeUndefined();
    expect(outcome.created).toBe(true);
    expect(outcome.hits).toEqual(["the gym build in Wollongong"]);
  });

  test("two Bots of one User settle Turns, and both transcripts are searchable in the User Durable Object", async () => {
    const suffix = crypto.randomUUID();
    const userId = `search-user-${suffix}`;
    const first = { userId, botId: `search-bot-a-${suffix}` };
    const second = { userId, botId: `search-bot-b-${suffix}` };
    await provisionBot(first);
    await provisionSiblingBot(second, 1);

    await settleTurn(first, "run-1", "How is the gym build in Wollongong?");
    await settleTurn(second, "run-2", "Remind me about the Wollongong roster.");

    const results = await search(userId, { query: "wollongong" });
    expect(results.indexState).toBe("ready");
    expect(new Set(results.hits.map((hit) => hit.botId))).toEqual(
      new Set([first.botId, second.botId]),
    );
    // Every hit is a `user` row: the assistant's reply is indexed too, but
    // "Ollama reply" does not contain the query.
    expect(results.hits.every((hit) => hit.kind === "user")).toBe(true);
    expect(results.hits[0]!.snippet).toContain("Wollongong");

    // A search naming one Bot returns that Bot alone.
    const scoped = await search(userId, {
      query: "wollongong",
      botId: second.botId,
    });
    expect(scoped.hits.map((hit) => hit.botId)).toEqual([second.botId]);

    // THE INDEX IS DURABLE. It survives the User object being evicted.
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
    const afterEviction = await search(userId, { query: "wollongong" });
    expect(new Set(afterEviction.hits.map((hit) => hit.runId))).toEqual(
      new Set(["run-1", "run-2"]),
    );

    // A REBUILD REPRODUCES IT. The rows are read back out of the Bots' own
    // stored runs, so a thrown-away index is a repair, never a loss.
    const receipt = await userStub(userId).rebuildSearchIndex({
      schemaVersion: 1,
      userId,
    });
    expect(receipt).toMatchObject({ status: "rebuilt", indexState: "ready" });
    expect(receipt.indexedRows).toBeGreaterThanOrEqual(4);
    const rebuilt = await search(userId, { query: "wollongong" });
    expect(rebuilt.hits).toHaveLength(afterEviction.hits.length);
    expect(
      new Set(rebuilt.hits.map((hit) => `${hit.botId}:${hit.runId}`)),
    ).toEqual(
      new Set(afterEviction.hits.map((hit) => `${hit.botId}:${hit.runId}`)),
    );

    // AND ARCHIVING PURGES. An archived Bot's rows leave the index entirely.
    const lifecycle = await userStub(userId).executeBotLifecycle({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "bot/archive",
        commandId: `archive-${suffix}`,
        botId: second.botId,
      },
    });
    expect(lifecycle.status).toBe("applied");
    const afterArchive = await search(userId, {
      query: "wollongong",
      includeArchived: true,
    });
    expect(afterArchive.hits.map((hit) => hit.botId)).toEqual([first.botId]);
  });

  test("a tool row is indexed but stays out of the default results", async () => {
    const suffix = crypto.randomUUID();
    const userId = `search-tool-user-${suffix}`;
    const identity = { userId, botId: `search-tool-bot-${suffix}` };
    await provisionBot(identity);
    await settleTurn(identity, "run-1", "What is the time in Wollongong?");

    const byDefault = await search(userId, { query: "wollongong" });
    expect(byDefault.hits.every((hit) => hit.kind !== "tool")).toBe(true);

    // The `kinds` filter is the opt-in, and it is the only way to reach a
    // tool row at all.
    const tools = await search(userId, {
      query: "wollongong",
      kinds: ["tool"],
    });
    expect(tools.hits.every((hit) => hit.kind === "tool")).toBe(true);
  });

  test("a User Durable Object refuses a search naming another User", async () => {
    const suffix = crypto.randomUUID();
    const mine = `search-user-${suffix}`;
    const theirs = `search-other-${suffix}`;
    await provisionBot({ userId: mine, botId: `search-bot-${suffix}` });
    // Addressed as *this* User's object, and asked about another User. The
    // request agrees with itself, which is exactly why agreeing proves nothing.
    let refusal = "";
    try {
      await userStub(mine).searchTranscripts({
        schemaVersion: 1,
        userId: theirs,
        query: { schemaVersion: 1, query: "wollongong" },
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("different User");
    await expect(search(mine, { query: "wollongong" })).resolves.toMatchObject({
      schemaVersion: 1,
    });
  });
});

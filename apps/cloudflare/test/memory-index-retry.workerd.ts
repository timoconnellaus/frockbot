// The lazy Memory index against a bucket that blinks.
//
// One claim: a transient object-storage failure on the Turn's Memory read must
// not blind `memory_search` for the rest of that Turn.
//
// The render reads every Memory tier once and keeps that document snapshot for
// the derived index, which the Turn's first search builds from it. A read that
// answers `unavailable` leaves the snapshot short of a tier, so that first
// search can only refuse to index it — the indexer reads an absent document as
// a deleted one, and applying a short listing would delete chunks permanently
// and silently. The *next* search in the same Turn must go back to the files
// instead of treating the incomplete snapshot as this Turn's index: the blip
// is over, and the bot's Memory is one round trip away.
//
// Driven through a real Bot Durable Object over real R2 with the production
// Memory surface, store, projection and `memory_search` tool, and exactly one
// read answered `unavailable` (`memorySearchAfterTransientReadFailure`).
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

const FACT = "Tim rides a Brompton to the station.";

describe("the lazy Memory index after a transient read failure", () => {
  test("the next search in the same Turn retries instead of keeping the empty index", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `retry-user-${id}`, botId: `retry-${id}` };
    await provisionBot(identity);
    const stub = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    );

    // The fact is on disk, through the production write path, before the Turn
    // that cannot read the tier it lives in.
    const written = await stub.memoryWrite({
      ...identity,
      scope: "bot",
      tier: "profile",
      fact: FACT,
    });
    expect(written.isError).toBe(false);

    const searched = await stub.memorySearchAfterTransientReadFailure({
      ...identity,
      query: "Brompton station",
    });

    // The Turn's snapshot is missing the tier whose read failed, so the first
    // search has nothing to search and says so.
    expect(searched.first).toBe("No memory matches.");
    expect(searched.chunks[0]).toBe(0);
    // The second search reads the files again and finds what is there.
    expect(searched.second).toContain(FACT);
    expect(searched.chunks[1]).toBeGreaterThan(0);
  });
});

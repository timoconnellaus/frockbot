// A file-read blip against canonical Memory.
//
// One claim: a transient object-storage failure while the Turn renders Memory
// files must not hide a fact `memory_write` already recorded. Search reads the
// canonical engine, not the file snapshot the blip shortened.
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

    // The fact lives in canonical Memory, so a file-read blip does not hide
    // it. The file index stays empty; the search does not consult it.
    expect(searched.first).toContain(FACT);
    expect(searched.second).toContain(FACT);
    expect(searched.chunks).toEqual([0, 0]);
  });
});

// An idle Bot wearing the activity ring, against a real Bot Durable Object.
//
// The sidebar's `working` flag was `status === "running"` on the newest run,
// and nothing renews that field: every way a Turn can stop without settling
// itself left a record that says `running` for ever. Production had Bots quiet
// for hours pulsing as though they were mid-sentence, and the wedge that
// produced the record also refused the next message.
//
// The claims a Bun double cannot make, because all three are claims about the
// deployed object:
//
//  1. The sidebar read of a Bot holding a stale `running` record reports no
//     ring — through the same liveness rule the transcript uses.
//  2. That read repairs: the record is durably terminal afterwards, and stays
//     terminal across an eviction, so no later reader has to work it out again.
//  3. The Bot is not wedged behind it. The next Turn admits and answers
//     normally, on a session log that reads as a complete history.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

interface StaleRunRpc {
  readUnread(input: unknown): Promise<{
    botId: string;
    count: number;
    working?: boolean;
  }>;
  listRuns(input: unknown): Promise<{
    runs: Array<{ runId: string; status: string }>;
  }>;
}

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function rpc(name: string): StaleRunRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(name) as unknown as StaleRunRpc;
}

describe("a Bot left holding a run marked running", () => {
  test("wears no ring, is repaired by the read, and admits its next Turn", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `stale-run-user-${suffix}`,
      botId: `stale-run-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const stub = bot(name);

    await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: name,
        acceptedAt: "2026-08-31T00:00:00.000Z",
        text: "hello",
      },
    });
    expect(await rpc(name).readUnread(identity)).toMatchObject({
      count: 1,
    });

    // The wedge, as the durable store holds it: a record that says `running`,
    // admitted days ago — far past the fifteen-minute Turn deadline — with its
    // events already journaled and nothing left anywhere that could settle it.
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get("run:run-1")) as Record<
        string,
        unknown
      >;
      const { responseText: _responseText, ...wedged } = stored;
      await state.storage.put({
        "run:run-1": { ...wedged, status: "running", phase: "executing" },
      });
      // The `active-run` marker is deliberately *not* restored. Recovery only
      // ever looks at the run that marker names, which is exactly why these
      // records survived every recovery path and went on pulsing.
      await state.storage.delete("active-run");
    });
    await evictDurableObject(stub);

    const read = await rpc(name).readUnread(identity);
    expect(read.working ?? false).toBe(false);

    // The read settled it rather than merely declining to draw a ring, so
    // every other reader — the transcript's own running-Turn ring included —
    // sees a terminal record without having to reach the same conclusion.
    const runs = await rpc(name).listRuns({
      ...identity,
      query: { schemaVersion: 1 },
    });
    const projected = runs.runs.find((run) => run.runId === "run-1");
    expect(projected?.status).toBe("failed");

    await evictDurableObject(stub);
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ status: string; failure?: string }>("run:run-1"),
    );
    expect(stored?.status).toBe("failed");
    expect(stored?.failure).toContain("Try sending it again");

    // And the Bot is free: the next Turn admits against a log the settlement
    // closed, rather than "turn 2 started while turn 1 is open".
    const next = await stub.run({
      ...identity,
      command: {
        runId: "run-2",
        sessionId: name,
        acceptedAt: new Date().toISOString(),
        text: "still there?",
      },
    });
    expect(next.text).toBe("Ollama reply");
    expect((await rpc(name).readUnread(identity)).working ?? false).toBe(false);
  });
});

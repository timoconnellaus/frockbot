// A Bot left holding a run marked running, against a real Bot Durable Object.
//
// Nothing but a settlement moves a record off `running`, so every way a Turn
// can stop without settling itself leaves a record that says `running` until
// something settles it. The sidebar row and the open chat both read that
// record, so they must change together: neither hides the record on its own.
//
// The claims a Bun double cannot make, because all three are claims about the
// deployed object:
//
//  1. Before the repair, the sidebar row and the transcript agree: both report
//     the record as it stands.
//  2. The alarm's repair settles it: the record is durably terminal afterwards,
//     and stays terminal across an eviction, and both surfaces go idle.
//  3. The Bot is not wedged behind it. The next Turn admits and answers
//     normally, on a session log that reads as a complete history.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { repairDueKey, repairRunKey } from "@frockbot/core/durable";
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
  test("reads the same on the row and in the chat, is repaired by the alarm, and admits its next Turn", async () => {
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
    // events already journaled and no Turn left executing it.
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
      // ever looks at the run that marker names, so a record like this one is
      // the repair index's to settle.
      await state.storage.delete("active-run");
    });
    await evictDurableObject(stub);

    const beforeRepair = await rpc(name).listRuns({
      ...identity,
      query: { schemaVersion: 1 },
    });
    expect(beforeRepair.runs.find((run) => run.runId === "run-1")?.status).toBe(
      "running",
    );
    expect((await rpc(name).readUnread(identity)).working).toBe(true);

    // The repair is the alarm's indexed obligation, not the sidebar read.
    await runInDurableObject(stub, async (instance, state) => {
      const due = Date.now() - 1_000;
      await state.storage.put({
        [repairRunKey("run-1")]: due,
        [repairDueKey(due, "run-1")]: "run-1",
      });
      await (instance as { alarm(): Promise<void> }).alarm();
    });

    const runs = await rpc(name).listRuns({
      ...identity,
      query: { schemaVersion: 1 },
    });
    const projected = runs.runs.find((run) => run.runId === "run-1");
    expect(projected?.status).toBe("failed");
    expect((await rpc(name).readUnread(identity)).working ?? false).toBe(false);

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

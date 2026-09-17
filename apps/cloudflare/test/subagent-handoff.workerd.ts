// `subagent` in a text Turn, against a real Bot Durable Object.
//
// One claim, and it is the one the design rests on: a chat Turn that hands off
// admits a second Turn *in its own object* on the `agent` lane and then
// answers without waiting for it. Everything about that is timing — the
// hand-off is queued behind the Turn that asked for it and is promoted only
// once that Turn settles — so nothing but a real object can show it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { frockbotToolCallPrompt } from "./harness/miniflare.ts";

interface Identity {
  userId: string;
  botId: string;
}

function bot(identity: Identity) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

interface BotRpc {
  run(command: unknown): Promise<{ runId: string; events: unknown[] }>;
}

function rpc(identity: Identity): BotRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the method this test calls.
  return bot(identity) as unknown as BotRpc;
}

interface StoredRunProbe {
  runId: string;
  status: string;
  input: string;
  admission?: {
    turnType: string;
    lane?: string;
    origin?: { kind: string; parentRunId?: string; depth?: number };
  };
}

async function storedRuns(identity: Identity): Promise<StoredRunProbe[]> {
  return runInDurableObject(bot(identity), async (_instance, state) => [
    ...(await state.storage.list<StoredRunProbe>({ prefix: "run:" })).values(),
  ]);
}

/**
 * The hand-off, once the object has got to it.
 *
 * It is promoted by the promise the tool left behind, or by the recovery
 * alarm, so this nudges the alarm between looks rather than assuming which of
 * the two won.
 */
async function handoff(identity: Identity): Promise<StoredRunProbe> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = (await storedRuns(identity)).find(
      (run) => run.admission?.origin?.kind === "handoff",
    );
    if (found && found.status !== "running") return found;
    await runInDurableObject(bot(identity), (_instance, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(bot(identity), (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error("the hand-off was never admitted");
}

describe("a text Turn handing work off to itself", () => {
  test("admits an agent-lane Turn here and answers without waiting", async () => {
    const identity = {
      userId: `handoff-${crypto.randomUUID()}`,
      botId: "primary",
    };
    await provisionBot(identity);

    const asked = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `run-${crypto.randomUUID()}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: frockbotToolCallPrompt("subagent", {
          task: "Read last month's ledger and tell me what stands out.",
        }),
      },
    });

    // The Turn that asked is done. It never waited on the work.
    const chat = (await storedRuns(identity)).find(
      (run) => run.runId === asked.runId,
    );
    expect(chat?.status).toBe("completed");

    // It really ran, on its own, after the Turn that asked for it settled.
    const spawned = await handoff(identity);
    expect(spawned.status).toBe("completed");
    expect(spawned.admission?.turnType).toBe("agent");
    // The lane is not on the record because it is the one an `agent` Turn
    // defaults to, which is exactly the lane this had to land on.
    expect(spawned.admission?.lane ?? "agent").toBe("agent");
    expect(spawned.admission?.origin).toEqual({
      kind: "handoff",
      parentRunId: asked.runId,
      depth: 1,
    });
    // The task, as the model wrote it, is what the hand-off was given.
    expect(spawned.input).toContain("last month's ledger");
  });
});

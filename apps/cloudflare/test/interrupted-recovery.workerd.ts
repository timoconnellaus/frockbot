// What the recovery alarm does with a Turn the User already threw away.
//
// This is the shape that killed the dev Worker. A Stop left a run durably
// discarded but still marked active, the object was evicted before it settled,
// and the recovery alarm re-entered it — straight into "Model response outcome
// is uncertain after cancellation", which `executeAdmittedRun` rethrows after
// recording the failure. An alarm has no caller, so the rejection was uncaught
// and wrangler exited, taking the shared stack down mid-run.
//
// Two claims, against a real Bot Durable Object:
//
//  * The alarm settles a discarded Turn rather than resuming it, and does not
//    throw doing it.
//  * The Bot is not wedged afterwards: the next message is answered.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

/**
 * How far ahead a test arms an alarm it is about to fire by hand.
 *
 * A deadline already in the past can be delivered by the runtime before
 * `runDurableObjectAlarm` asks for it; that helper then finds nothing
 * scheduled, returns without running anything, and does not await the handler
 * already in flight — so the assertions below could read the record
 * mid-settlement. `runDurableObjectAlarm` fires whatever alarm is scheduled
 * whether or not it is due, so a deadline out of the runtime's reach makes the
 * hand-fired run the only delivery, and an awaited one.
 */
const HAND_FIRED_ALARM_DELAY_MS = 60_000;

function bot(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

interface RecoveryRpc {
  run(command: unknown): Promise<{ runId: string; text: string }>;
  lookupRun(input: unknown): Promise<{ run: { status: string } }>;
}

interface StoredRunProbe {
  runId: string;
  status: string;
  previousEventCount: number;
  stopRequestedAt?: string;
  events: Array<{ type: string }>;
}

function rpc(identity: { userId: string; botId: string }): RecoveryRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity.userId, identity.botId) as unknown as RecoveryRpc;
}

async function storedRuns(identity: {
  userId: string;
  botId: string;
}): Promise<StoredRunProbe[]> {
  return runInDurableObject(
    bot(identity.userId, identity.botId),
    async (_instance, state) => [
      ...(
        await state.storage.list<StoredRunProbe>({ prefix: "run:" })
      ).values(),
    ],
  );
}

async function activeRunId(identity: {
  userId: string;
  botId: string;
}): Promise<string | undefined> {
  return runInDurableObject(
    bot(identity.userId, identity.botId),
    (_instance, state) => state.storage.get<string>("active-run"),
  );
}

/**
 * Rewinds a settled run to the durable state a Stop mid-answer leaves behind:
 * the Turn open, the run active, and the User's intent to discard it written.
 */
async function rewindToStopped(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<void> {
  await runInDurableObject(
    bot(identity.userId, identity.botId),
    async (_instance, state) => {
      const key = `run:${runId}`;
      const stored = (await state.storage.get<
        StoredRunProbe & { responseText?: string; failure?: string }
      >(key))!;
      // A running run carries no completion fields; the codec says so.
      const { responseText: _text, failure: _failure, ...run } = stored;
      const open = run.events.filter((event) => event.type !== "turn/end");
      const latest =
        (await state.storage.get<Array<{ type: string }>>("latest-events")) ??
        [];
      await state.storage.put({
        [key]: {
          ...run,
          events: open,
          status: "running",
          phase: "executing",
          stopRequestedAt: new Date().toISOString(),
        },
        "latest-events": [...latest.slice(0, run.previousEventCount), ...open],
        "active-run": runId,
      });
    },
  );
}

/** Arms and fires the recovery deadline the object would be holding. */
async function fireRecoveryAlarm(identity: {
  userId: string;
  botId: string;
}): Promise<void> {
  await runInDurableObject(
    bot(identity.userId, identity.botId),
    (_instance, state) =>
      state.storage.setAlarm(Date.now() + HAND_FIRED_ALARM_DELAY_MS),
  );
  // The deadline is out of the runtime's own reach, so this hand-fired run is
  // the only delivery of it and its handler is awaited here — whatever the
  // alarm leaves behind is settled by the time this returns. It must not
  // reject.
  await runDurableObjectAlarm(bot(identity.userId, identity.botId));
}

describe("recovery of a Turn the User discarded", () => {
  test("the alarm settles a stopped Turn instead of re-entering it", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `stop-recover-${suffix}`,
      botId: `stop-recover-bot-${suffix}`,
    };
    await provisionBot(identity);

    const first = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `stopped-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "say something",
      },
    });
    await rewindToStopped(identity, first.runId);
    await evictDurableObject(bot(identity.userId, identity.botId));

    // The whole claim. Before the fix this rejected, and in the dev Worker the
    // rejection was uncaught and the process exited.
    await fireRecoveryAlarm(identity);

    const settled = (await storedRuns(identity)).find(
      (run) => run.runId === first.runId,
    )!;
    // Terminal on the User's own intent, and terminal it stays.
    expect(settled.status).toBe("cancelled");
    expect(await activeRunId(identity)).toBeUndefined();

    // Firing again changes nothing: a settled run is not recovery's business.
    await evictDurableObject(bot(identity.userId, identity.botId));
    await fireRecoveryAlarm(identity);
    expect(
      (await storedRuns(identity)).find((run) => run.runId === first.runId)!
        .status,
    ).toBe("cancelled");

    // And the Bot is not wedged behind it.
    const next = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `after-stop-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "still there?",
      },
    });
    expect(next.text.length).toBeGreaterThan(0);
  });
});

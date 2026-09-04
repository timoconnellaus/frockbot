// A pending decision, against a real Bot Durable Object.
//
// Two claims, and both are about the gap between asking and answering, because
// that gap is exactly where a Bot that has stopped and a person who has not yet
// looked can lose each other:
//
//  * The object may be gone entirely between the Turn that asked and the click
//    that answers. The record is durable, so the decision lands on the record
//    the settled Turn wrote and the queued input reaches the next chat Turn.
//  * Nobody may ever click. The alarm expires the card exactly once, records
//    `expired`, and queues the same input — so the Bot always learns the
//    outcome and never waits unboundedly.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";

const ACTION = "Delete the staging database";

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

interface ApprovalRpc {
  run(command: unknown): Promise<{ runId: string }>;
  listApprovals(input: unknown): Promise<{
    pending: number;
    approvals: Array<{
      approvalId: string;
      decision: string;
      expiresAt: string;
      risk: string;
    }>;
  }>;
  decideApproval(input: unknown): Promise<{
    status: string;
    approval: { approvalId: string; decision: string; decidedAt?: string };
  }>;
  listNotifications(
    input: unknown,
  ): Promise<Array<{ notificationId: string; urgency?: string }>>;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  events: Array<{ type: string; text?: string }>;
}

function rpc(identity: { userId: string; botId: string }): ApprovalRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity.userId, identity.botId) as unknown as ApprovalRpc;
}

async function storedRuns(identity: {
  userId: string;
  botId: string;
}): Promise<StoredRunProbe[]> {
  return runInDurableObject(
    bot(identity.userId, identity.botId),
    (_instance, state) => hydratedStoredRunsV1<StoredRunProbe>(state.storage),
  );
}

/** One chat Turn whose scripted tool call is an approval card. */
async function askForApproval(
  identity: { userId: string; botId: string },
  approvalId: string,
  expiresInSeconds?: number,
): Promise<string> {
  const turn = await rpc(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId: `ask-${approvalId}`,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([
        "send_to_user",
        {
          payload: {
            type: "approval",
            approvalId,
            action: ACTION,
            risk: "high",
            ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
          },
        },
      ]),
    },
  });
  return turn.runId;
}

describe("a pending decision's durable life in Workerd", () => {
  test("a decision lands on a record written by a Turn the object has since forgotten", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `approve-${suffix}`,
      botId: `approve-bot-${suffix}`,
    };
    await provisionBot(identity);
    const runId = await askForApproval(identity, "ap-1");

    // The Turn is over the moment the card is sent: the Bot has nothing to do
    // until a person answers.
    const asked = (await storedRuns(identity)).find(
      (run) => run.runId === runId,
    )!;
    expect(asked.status).toBe("completed");

    // Everything the object held is gone before anybody clicks.
    await evictDurableObject(bot(identity.userId, identity.botId));

    const listed = await rpc(identity).listApprovals({
      schemaVersion: 1,
      ...identity,
    });
    expect(listed.pending).toBe(1);
    expect(listed.approvals[0]).toMatchObject({
      approvalId: "ap-1",
      decision: "pending",
      risk: "high",
    });

    await evictDurableObject(bot(identity.userId, identity.botId));

    const recorded = await rpc(identity).decideApproval({
      schemaVersion: 1,
      ...identity,
      approvalId: "ap-1",
      command: { schemaVersion: 1, decision: "approved" },
    });
    expect(recorded).toMatchObject({
      status: "recorded",
      approval: { approvalId: "ap-1", decision: "approved" },
    });

    // First write wins, across an eviction: a second click — or a retried
    // request that never saw the first answer — reads back the one decision
    // that was recorded, not a new one.
    await evictDurableObject(bot(identity.userId, identity.botId));
    const replayed = await rpc(identity).decideApproval({
      schemaVersion: 1,
      ...identity,
      approvalId: "ap-1",
      command: { schemaVersion: 1, decision: "denied" },
    });
    expect(replayed.status).toBe("replayed");
    expect(replayed.approval).toEqual(recorded.approval);

    // And the Bot learns the outcome on its next conversational Turn.
    await evictDurableObject(bot(identity.userId, identity.botId));
    const next = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `chat-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "well?",
      },
    });
    const chat = (await storedRuns(identity)).find(
      (run) => run.runId === next.runId,
    )!;
    const inputs = chat.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.text ?? "");
    expect(
      inputs.some((text) =>
        text.includes('The decision on "ap-1" is approved.'),
      ),
    ).toBe(true);

    // Delivered once. A later Turn is not told again.
    const again = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `chat-again-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "anything else?",
      },
    });
    const laterRun = (await storedRuns(identity)).find(
      (run) => run.runId === again.runId,
    )!;
    expect(
      laterRun.events
        .filter((event) => event.type === "user/message")
        .some((event) => (event.text ?? "").includes('The decision on "ap-1"')),
    ).toBe(false);
  });

  test("the alarm expires a stale card exactly once and queues the input", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `expire-${suffix}`,
      botId: `expire-bot-${suffix}`,
    };
    await provisionBot(identity);
    await askForApproval(identity, "ap-stale");

    // Wind the record's own deadline into the past. Nothing else is touched:
    // the alarm is what decides, and this only makes the deadline due.
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      async (_instance, state) => {
        const key = "shell:approval:ap-stale";
        const stored = (await state.storage.get<{ expiresAt: string }>(key))!;
        await state.storage.put(key, {
          ...stored,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
        await state.storage.setAlarm(Date.now() + HAND_FIRED_ALARM_DELAY_MS);
      },
    );
    await evictDurableObject(bot(identity.userId, identity.botId));
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));

    const afterFirst = await rpc(identity).listApprovals({
      schemaVersion: 1,
      ...identity,
    });
    expect(afterFirst.pending).toBe(0);
    expect(afterFirst.approvals[0]).toMatchObject({
      approvalId: "ap-stale",
      decision: "expired",
    });

    // A second alarm changes nothing: the record is no longer pending, so the
    // expiry is a no-op and no second input is queued.
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      async (_instance, state) =>
        state.storage.setAlarm(Date.now() + HAND_FIRED_ALARM_DELAY_MS),
    );
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));

    const queued = await runInDurableObject(
      bot(identity.userId, identity.botId),
      async (_instance, state) => [
        ...(
          await state.storage.list<{ kind: string; approvalId?: string }>({
            prefix: "routine-wake:",
          })
        ).values(),
      ],
    );
    expect(
      queued.filter(
        (input) => input.kind === "approval" && input.approvalId === "ap-stale",
      ),
    ).toHaveLength(1);

    // Expiry is not a decision a person may then overwrite.
    const replayed = await rpc(identity).decideApproval({
      schemaVersion: 1,
      ...identity,
      approvalId: "ap-stale",
      command: { schemaVersion: 1, decision: "approved" },
    });
    expect(replayed).toMatchObject({
      status: "replayed",
      approval: { decision: "expired" },
    });
  });

  test("a muted Bot is still told a decision is waiting, at critical urgency", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `muted-${suffix}`,
      botId: `muted-bot-${suffix}`,
    };
    // A new Bot's notifications are off, which is the muted case exactly.
    await provisionBot(identity);
    await askForApproval(identity, "ap-muted");

    const notifications = await rpc(identity).listNotifications({
      schemaVersion: 1,
      ...identity,
    });
    // Muting silences chatter, not a question that has stopped the Bot.
    expect(
      notifications.find(
        (intent) => intent.notificationId === "approval:ap-muted",
      ),
    ).toMatchObject({ urgency: "critical" });
  });
});

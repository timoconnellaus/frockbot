// A pending decision, against a real Bot Durable Object.
//
// Two claims, and both are about the gap between asking and answering, because
// that gap is exactly where a Bot that has stopped and a person who has not yet
// looked can lose each other:
//
//  * The object may be gone entirely between the Turn that asked and the click
//    that answers. The record is durable, so the decision lands on the record
//    the settled Turn wrote, and the click opens the Turn that acts on it.
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
  readConfiguration(input: unknown): Promise<{ revision: number }>;
  executeConfiguration(input: unknown): Promise<unknown>;
  readUnread(input: unknown): Promise<{
    count: number;
    unread: boolean;
    lastMessageId?: string;
  }>;
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
  admission?: {
    turnType: string;
    lane?: string;
    origin?: { kind: string; inputId?: string };
  };
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

/**
 * The Turn a decision opened, once it has settled. It starts on the promise
 * the decision left behind, or on the recovery alarm after an eviction, so
 * this nudges the alarm between looks rather than assuming which of the two
 * won.
 */
async function approvalDelivery(identity: {
  userId: string;
  botId: string;
}): Promise<StoredRunProbe> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = (await storedRuns(identity)).find(
      (run) => run.admission?.origin?.kind === "input-delivery",
    );
    if (found && found.status !== "running") return found;
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      (_instance, state) => state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      (instance: unknown) => (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error("the decision never opened a Turn");
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
          disposition: "finish",
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

    // And the Bot acts on it at once, in a Turn of its own: nobody has to
    // speak again for the answer to reach it.
    const delivery = await approvalDelivery(identity);
    expect(delivery).toMatchObject({
      status: "completed",
      sessionId: `${identity.userId}:${identity.botId}`,
      admission: {
        turnType: "chat",
        lane: "agent",
        origin: { kind: "input-delivery", inputId: "ap-1" },
      },
    });
    const delivered = delivery.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.text ?? "");
    expect(
      delivered.some((text) =>
        text.includes('The decision on "ap-1" is approved.'),
      ),
    ).toBe(true);
    expect(
      delivered.some((text) => text.includes("Nobody has said anything")),
    ).toBe(true);
    // One Turn per decision, whatever the replay did.
    expect(
      (await storedRuns(identity)).filter(
        (run) => run.admission?.origin?.kind === "input-delivery",
      ),
    ).toHaveLength(1);

    // Delivered once. The person's own next Turn is not told again.
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
    expect(
      chat.events
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

  test("a muted approval is unread without raising an alert", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `muted-${suffix}`,
      botId: `muted-bot-${suffix}`,
    };
    await provisionBot(identity);
    const request = { schemaVersion: 1, ...identity };
    const configuration = await rpc(identity).readConfiguration(request);
    await rpc(identity).executeConfiguration({
      ...request,
      command: {
        schemaVersion: 1,
        type: "bot/update-notifications",
        commandId: `mute-${suffix}`,
        expectedRevision: configuration.revision,
        botId: identity.botId,
        notifications: { enabled: false },
      },
    });
    const runId = await askForApproval(identity, "ap-muted");

    const notifications = await rpc(identity).listNotifications({
      schemaVersion: 1,
      ...identity,
    });
    expect(notifications).toEqual([]);
    expect(await rpc(identity).readUnread(request)).toMatchObject({
      unread: true,
      count: 1,
      lastMessageId: `${runId}:send:0`,
    });
  });
});

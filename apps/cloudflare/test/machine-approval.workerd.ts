// The approval that gates a registered machine, against real Durable Objects.
//
// One claim, in four parts, and all of it about the gap between a Bot asking
// and a person answering:
//
//  * A Turn that calls `machine_exec` ends `completed` with an approval
//    recorded, an intent recorded, and **nothing on the machine's queue**.
//    That is intent-before-effect at a tool boundary: the command exists as a
//    durable proposal and nowhere else.
//  * Approving it queues exactly one command, with `commandId === effectId`.
//  * Denying it, and letting the clock expire it, queue none — and the intent
//    is terminal either way, so a later read can still say what happened.
//  * An eviction between the card and the decision changes nothing, because
//    nothing that matters was resident.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { machineTokenDigestV1 } from "@frockbot/machine-protocol";
import type {
  MachineCommandV1,
  MachineEnrollmentReceiptV1,
  MachinePairingOfferV1,
} from "@frockbot/machine-protocol";
import type { MachineIntentRecordV1 } from "@frockbot/plugin-user-machine/intent";
import { machineIntentKeyV1 } from "@frockbot/plugin-user-machine/intent";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";

interface BotRpc {
  run(command: unknown): Promise<{ runId: string }>;
  listApprovals(input: unknown): Promise<{
    pending: number;
    approvals: Array<{ approvalId: string; decision: string; action: string }>;
  }>;
  decideApproval(input: unknown): Promise<{
    status: string;
    approval: { approvalId: string; decision: string };
  }>;
}

interface UserRpc {
  createMachinePairing(input: unknown): Promise<MachinePairingOfferV1>;
  enrollMachine(input: unknown): Promise<MachineEnrollmentReceiptV1>;
  pollMachine(input: unknown): Promise<{ commands: MachineCommandV1[] }>;
}

function bot(identity: { userId: string; botId: string }) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

function botRpc(identity: { userId: string; botId: string }): BotRpc {
  // SAFETY: the generated Bot stub type is too deep to instantiate here; this
  // names only the methods this file calls.
  return bot(identity) as unknown as BotRpc;
}

function userRpc(userId: string): UserRpc {
  // SAFETY: as above, for the User Durable Object's machine RPCs.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as UserRpc;
}

/** One registered, connected machine, through the RPCs the routes call. */
async function enrolled(userId: string) {
  const rpc = userRpc(userId);
  const offer = await rpc.createMachinePairing({ schemaVersion: 1, userId });
  const receipt = await rpc.enrollMachine({
    schemaVersion: 1,
    userId,
    machineId: offer.machineId,
    enrollment: {
      schemaVersion: 1,
      code: offer.code,
      label: "Approval-Mac.local",
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: ["exec", "files"],
    },
  });
  return {
    machineId: offer.machineId,
    claims: { u: userId, m: offer.machineId, v: receipt.keyVersion },
    token: receipt.token,
  };
}

/** Everything on this machine's queue, read straight out of durable state. */
async function queued(
  userId: string,
  machineId: string,
): Promise<MachineCommandV1[]> {
  return runInDurableObject(
    env.USER_CONFIGURATIONS.getByName(userId),
    async (_instance, state) => [
      ...(
        await state.storage.list<MachineCommandV1>({
          prefix: `machine-queue:${machineId}:`,
        })
      ).values(),
    ],
  );
}

async function intents(identity: {
  userId: string;
  botId: string;
}): Promise<MachineIntentRecordV1[]> {
  return runInDurableObject(bot(identity), async (_instance, state) => [
    ...(
      await state.storage.list<MachineIntentRecordV1>({
        prefix: machineIntentKeyV1(""),
      })
    ).values(),
  ]);
}

/** One chat Turn whose scripted tool call asks to run something on the Mac. */
async function askToRun(
  identity: { userId: string; botId: string },
  machineId: string,
  runId: string,
): Promise<string> {
  const turn = await botRpc(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([
        "machine_exec",
        { machineId, command: "git status --short" },
      ]),
    },
  });
  return turn.runId;
}

async function storedRun(
  identity: { userId: string; botId: string },
  runId: string,
) {
  const runs = await runInDurableObject(
    bot(identity),
    async (_instance, state) => [
      ...(
        await state.storage.list<{ runId: string; status: string }>({
          prefix: "run:",
        })
      ).values(),
    ],
  );
  return runs.find((run) => run.runId === runId)!;
}

async function identityFor(prefix: string) {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `${prefix}-${suffix}`,
    botId: `${prefix}-bot-${suffix}`,
  };
  await provisionBot(identity);
  return identity;
}

describe("a machine command's approval in Workerd", () => {
  test("asking records intent and an approval, and queues nothing", async () => {
    const identity = await identityFor("machine-ask");
    const { machineId, claims, token } = await enrolled(identity.userId);

    const runId = await askToRun(identity, machineId, "ask-1");

    // The Turn is over the moment the card is sent: the Bot has nothing left
    // to do until a person answers.
    expect((await storedRun(identity, runId)).status).toBe("completed");

    const listed = await botRpc(identity).listApprovals({
      schemaVersion: 1,
      ...identity,
    });
    expect(listed.pending).toBe(1);
    expect(listed.approvals[0]!.action).toContain("git status --short");

    const [intent] = await intents(identity);
    expect(intent).toMatchObject({
      approvalId: listed.approvals[0]!.approvalId,
      commandId: listed.approvals[0]!.approvalId,
      machineId,
      botId: identity.botId,
    });
    expect(intent!.decision).toBeUndefined();

    // Nothing has run and nothing is waiting to. The machine's own poll — the
    // only way a command ever reaches it — answers empty.
    expect(await queued(identity.userId, machineId)).toEqual([]);
    const polled = await userRpc(identity.userId).pollMachine({
      schemaVersion: 1,
      userId: identity.userId,
      machineId,
      claims,
      tokenDigest: await machineTokenDigestV1(token),
      waitSeconds: 0,
    });
    expect(polled.commands).toEqual([]);
  });

  test("approving queues exactly one command, across an eviction", async () => {
    const identity = await identityFor("machine-approve");
    const { machineId } = await enrolled(identity.userId);
    await askToRun(identity, machineId, "ask-approve");
    const approvalId = (
      await botRpc(identity).listApprovals({ schemaVersion: 1, ...identity })
    ).approvals[0]!.approvalId;

    // Everything the Bot held is gone before anybody clicks.
    await evictDurableObject(bot(identity));

    const recorded = await botRpc(identity).decideApproval({
      schemaVersion: 1,
      ...identity,
      approvalId,
      command: { schemaVersion: 1, decision: "approved" },
    });
    expect(recorded.status).toBe("recorded");

    const commands = await queued(identity.userId, machineId);
    expect(commands).toHaveLength(1);
    // `commandId === effectId === approvalId`: one identity for the decision,
    // the queue key and the Turn's durable occurrence.
    expect(commands[0]).toMatchObject({
      commandId: approvalId,
      approvalId,
      machineId,
      status: "queued",
      op: { kind: "exec", command: "git status --short" },
    });

    const [intent] = await intents(identity);
    expect(intent).toMatchObject({
      decision: "approved",
      outcome: "dispatched",
    });

    // A second click is a replay, and a replay reaches no laptop: still one.
    await evictDurableObject(bot(identity));
    const replayed = await botRpc(identity).decideApproval({
      schemaVersion: 1,
      ...identity,
      approvalId,
      command: { schemaVersion: 1, decision: "denied" },
    });
    expect(replayed.status).toBe("replayed");
    expect(await queued(identity.userId, machineId)).toHaveLength(1);
  });

  test("denying queues nothing and leaves the intent terminal", async () => {
    const identity = await identityFor("machine-deny");
    const { machineId } = await enrolled(identity.userId);
    await askToRun(identity, machineId, "ask-deny");
    const approvalId = (
      await botRpc(identity).listApprovals({ schemaVersion: 1, ...identity })
    ).approvals[0]!.approvalId;

    await botRpc(identity).decideApproval({
      schemaVersion: 1,
      ...identity,
      approvalId,
      command: { schemaVersion: 1, decision: "denied" },
    });

    expect(await queued(identity.userId, machineId)).toEqual([]);
    expect((await intents(identity))[0]).toMatchObject({
      decision: "denied",
      outcome: "denied",
    });
  });

  test("a card nobody answers expires on the Bot's own alarm and queues nothing", async () => {
    const identity = await identityFor("machine-expire");
    const { machineId } = await enrolled(identity.userId);
    await askToRun(identity, machineId, "ask-expire");
    const approvalId = (
      await botRpc(identity).listApprovals({ schemaVersion: 1, ...identity })
    ).approvals[0]!.approvalId;

    // Wind the record's own deadline into the past; the alarm is what decides.
    await runInDurableObject(bot(identity), async (_instance, state) => {
      const key = `shell:approval:${approvalId}`;
      const stored = (await state.storage.get<{ expiresAt: string }>(key))!;
      await state.storage.put(key, {
        ...stored,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await state.storage.setAlarm(Date.now());
    });
    await evictDurableObject(bot(identity));
    await runDurableObjectAlarm(bot(identity));

    const listed = await botRpc(identity).listApprovals({
      schemaVersion: 1,
      ...identity,
    });
    expect(listed.pending).toBe(0);
    expect(listed.approvals[0]!.decision).toBe("expired");
    expect(await queued(identity.userId, machineId)).toEqual([]);
    expect((await intents(identity))[0]).toMatchObject({
      decision: "expired",
      outcome: "expired",
    });
  });

  test("a machine that is not connected is refused before anybody is asked", async () => {
    const identity = await identityFor("machine-offline");
    const { machineId } = await enrolled(identity.userId);
    // Age the row past its presence TTL. `connected` is arithmetic, so this is
    // the honest way to make a laptop offline without waiting ninety seconds.
    await runInDurableObject(
      env.USER_CONFIGURATIONS.getByName(identity.userId),
      async (_instance, state) => {
        const key = `machine:${machineId}`;
        const record = await state.storage.get<{ lastSeenAt: string }>(key);
        await state.storage.put(key, {
          ...record!,
          lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        });
      },
    );

    await askToRun(identity, machineId, "ask-offline");
    // No card, no intent, no command: a refusal is a sentence the Bot reads,
    // never a question that wasted a person's attention.
    expect(
      (await botRpc(identity).listApprovals({ schemaVersion: 1, ...identity }))
        .pending,
    ).toBe(0);
    expect(await intents(identity)).toEqual([]);
    expect(await queued(identity.userId, machineId)).toEqual([]);
  });
});

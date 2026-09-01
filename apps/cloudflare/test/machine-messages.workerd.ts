// Row 57g's three gates, against real Durable Objects.
//
// The claim is that a Messages call reaches somebody's Mac only when all three
// are open, and that each of them refuses in its own way:
//
//  * **The User setting.** Off, and the tools are not in the catalog at all —
//    so a scripted call for one is a call for a tool that does not exist, and
//    nothing is queued.
//  * **The device capability.** A machine that never reported `messages` is
//    refused at the tool boundary, before anything durable is written.
//  * **The OS permission.** A Mac that has not reported Full Disk Access
//    refuses visibly and queues nothing; once it has, one read queues exactly
//    one `{kind:"messages"}` command and the same queue delivers it.
//
// And the send: an outbound message takes the *landed* approval card, so the
// Turn ends with a pending decision and an empty queue, exactly as
// `machine_exec` does.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { machineTokenDigestV1 } from "@frockbot/machine-protocol";
import type {
  MachineCommandV1,
  MachineEnrollmentReceiptV1,
  MachineMessagesPermissionsV1,
  MachinePairingOfferV1,
  MachineTokenClaimsV1,
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
}

interface UserRpc {
  createMachinePairing(input: unknown): Promise<MachinePairingOfferV1>;
  enrollMachine(input: unknown): Promise<MachineEnrollmentReceiptV1>;
  pollMachine(input: unknown): Promise<{ commands: MachineCommandV1[] }>;
  claimMachineCommand(input: unknown): Promise<{ status: string }>;
  recordMachineResult(input: unknown): Promise<{ status: string }>;
  readConfiguration(input: unknown): Promise<{ revision: number }>;
  executeConfiguration(input: unknown): Promise<unknown>;
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
  // SAFETY: as above, for the User Durable Object's machine and settings RPCs.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as UserRpc;
}

/** The User turns the feature on, exactly as the settings surface does. */
async function enableMessages(userId: string): Promise<void> {
  const rpc = userRpc(userId);
  const revision = async (): Promise<number> =>
    (await rpc.readConfiguration({ schemaVersion: 1, userId })).revision;
  await rpc.executeConfiguration({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-messages-${userId}`,
      expectedRevision: await revision(),
      packageId: "machine-messages",
      version: "0.0.1",
    },
  });
  await rpc.executeConfiguration({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      type: "user/set-package-settings",
      commandId: `enable-messages-${userId}`,
      expectedRevision: await revision(),
      packageId: "machine-messages",
      values: { "messages-enabled": true },
    },
  });
}

interface Enrolled {
  machineId: string;
  claims: MachineTokenClaimsV1;
  tokenDigest: string;
}

async function enrolled(
  userId: string,
  capabilities: string[] = ["exec", "files", "messages"],
): Promise<Enrolled> {
  const rpc = userRpc(userId);
  const offer = await rpc.createMachinePairing({ schemaVersion: 1, userId });
  const receipt = await rpc.enrollMachine({
    schemaVersion: 1,
    userId,
    machineId: offer.machineId,
    enrollment: {
      schemaVersion: 1,
      code: offer.code,
      label: "Messages-Mac.local",
      platform: "macos",
      agentVersion: "0.4.1",
      capabilities,
    },
  });
  return {
    machineId: offer.machineId,
    claims: { u: userId, m: offer.machineId, v: receipt.keyVersion },
    tokenDigest: await machineTokenDigestV1(receipt.token),
  };
}

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

/** One chat Turn whose scripted call is the Messages tool under test. */
async function ask(
  identity: { userId: string; botId: string },
  runId: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<void> {
  await botRpc(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([tool, input]),
    },
  });
}

/** The agent claims one command and answers it, over the same routes. */
async function answer(
  machine: Enrolled,
  userId: string,
  commandId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const rpc = userRpc(userId);
  const identity = {
    schemaVersion: 1,
    userId,
    machineId: machine.machineId,
    claims: machine.claims,
    tokenDigest: machine.tokenDigest,
  };
  await rpc.claimMachineCommand({ ...identity, commandId });
  await rpc.recordMachineResult({
    ...identity,
    commandId,
    result: { schemaVersion: 1, commandId, ...result },
  });
}

const granted: MachineMessagesPermissionsV1 = {
  schemaVersion: 1,
  fullDiskAccess: true,
  automation: true,
  checkedAt: "2026-09-01T00:00:00.000Z",
};

/** Report a permission state through the real check-permissions round trip. */
async function reportPermissions(
  identity: { userId: string; botId: string },
  machine: Enrolled,
  runId: string,
  permissions: MachineMessagesPermissionsV1,
): Promise<void> {
  await ask(identity, runId, "machine_messages_check_permissions", {
    machineId: machine.machineId,
  });
  const [command] = await queued(identity.userId, machine.machineId);
  expect(command?.op).toEqual({
    kind: "messages",
    call: { kind: "check-permissions" },
  });
  await answer(machine, identity.userId, command!.commandId, {
    finishedAt: new Date().toISOString(),
    outcome: "ok",
    truncated: false,
    stdout: JSON.stringify({ kind: "permissions", permissions }),
  });
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

describe("the Messages gate in Workerd", () => {
  test("with the setting off, the tools are absent and nothing is queued", async () => {
    const identity = await identityFor("messages-off");
    const machine = await enrolled(identity.userId);

    await ask(identity, "off-1", "machine_messages_find_chats", {
      machineId: machine.machineId,
    });

    // Not registered means not there: no command, and no intent record either,
    // because no tool ran to write one.
    expect(await queued(identity.userId, machine.machineId)).toEqual([]);
    expect(await intents(identity)).toEqual([]);
  });

  test("with the setting on but no macOS machine reporting messages, still absent", async () => {
    const identity = await identityFor("messages-nocap");
    await enableMessages(identity.userId);
    const machine = await enrolled(identity.userId, ["exec", "files"]);

    await ask(identity, "nocap-1", "machine_messages_find_chats", {
      machineId: machine.machineId,
    });
    expect(await queued(identity.userId, machine.machineId)).toEqual([]);
    expect(await intents(identity)).toEqual([]);
  });

  test("permissions unreported refuses visibly and queues nothing", async () => {
    const identity = await identityFor("messages-unknown");
    await enableMessages(identity.userId);
    const machine = await enrolled(identity.userId);

    await ask(identity, "unknown-1", "machine_messages_find_chats", {
      machineId: machine.machineId,
    });
    // The tool existed and refused: the third gate is per call, not per
    // catalog, because macOS consent can change between one Turn and the next.
    expect(await queued(identity.userId, machine.machineId)).toEqual([]);
    expect(await intents(identity)).toEqual([]);
  });

  test("a reported permission opens the gate, and one read queues one command", async () => {
    const identity = await identityFor("messages-read");
    await enableMessages(identity.userId);
    const machine = await enrolled(identity.userId);

    await reportPermissions(identity, machine, "read-check", granted);
    // The check's own command left the queue when it was answered.
    expect(await queued(identity.userId, machine.machineId)).toEqual([]);

    await ask(identity, "read-1", "machine_messages_find_chats", {
      machineId: machine.machineId,
      query: "mum",
      limit: 5,
    });
    const commands = await queued(identity.userId, machine.machineId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      status: "queued",
      machineId: machine.machineId,
      op: {
        kind: "messages",
        call: { kind: "find-chats", query: "mum", limit: 5 },
      },
    });
    // No card was raised: the reads are approval-exempt, and the intent
    // records that they were dispatched by the tool rather than by a person.
    expect(
      (await botRpc(identity).listApprovals({ schemaVersion: 1, ...identity }))
        .pending,
    ).toBe(0);
    const intent = (await intents(identity)).find(
      (candidate) => candidate.commandId === commands[0]!.commandId,
    );
    expect(intent).toMatchObject({ outcome: "dispatched" });
    expect(intent!.decision).toBeUndefined();

    // The machine takes it off the same queue every other command rides.
    const polled = await userRpc(identity.userId).pollMachine({
      schemaVersion: 1,
      userId: identity.userId,
      machineId: machine.machineId,
      claims: machine.claims,
      tokenDigest: machine.tokenDigest,
      waitSeconds: 0,
    });
    expect(polled.commands.map((command) => command.commandId)).toEqual([
      commands[0]!.commandId,
    ]);
  });

  test("a denied permission refuses the read and queues nothing", async () => {
    const identity = await identityFor("messages-denied");
    await enableMessages(identity.userId);
    const machine = await enrolled(identity.userId);

    await reportPermissions(identity, machine, "denied-check", {
      ...granted,
      fullDiskAccess: false,
    });

    await ask(identity, "denied-1", "machine_messages_search", {
      machineId: machine.machineId,
      query: "dinner",
    });
    expect(await queued(identity.userId, machine.machineId)).toEqual([]);
  });

  test("a send asks first: one approval, and an empty queue", async () => {
    const identity = await identityFor("messages-send");
    await enableMessages(identity.userId);
    const machine = await enrolled(identity.userId);
    await reportPermissions(identity, machine, "send-check", granted);

    await ask(identity, "send-1", "machine_messages_send", {
      machineId: machine.machineId,
      to: "+61400000000",
      text: "on my way",
    });

    const listed = await botRpc(identity).listApprovals({
      schemaVersion: 1,
      ...identity,
    });
    expect(listed.pending).toBe(1);
    // The card carries the exact text: approving a message you have not read
    // is not approving anything.
    expect(listed.approvals[0]!.action).toContain("on my way");
    expect(listed.approvals[0]!.action).toContain("+61400000000");
    // Nothing reached the Mac. The settlement dispatches, not the tool.
    expect(await queued(identity.userId, machine.machineId)).toEqual([]);
  });
});

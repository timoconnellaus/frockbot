// The Bot Durable Object's side of the registered machine (register rows 48,
// 49).
//
// Three seams, and no rules: the rules are `plugin-user-machine`'s, and the
// authority for the registry and the queue is the User Durable Object's. What
// lives here is the wiring one admitted Turn needs —
//
//  * the runtime host the machine tools are handed, carrying this Bot's own
//    durable storage (where an intent record lives) and four closed-over calls
//    into the User object;
//  * the dispatch the approval settlement performs once a person has said yes.
//
// The Bot Durable Object holds the approval record, the alarm that expires it,
// and the route a person answers on, so the hand-off from "decided" to
// "queued" — and the delivery of the result back into the conversation — have
// nowhere else they could honestly live.
import type { BotIdentity } from "@frockbot/core/durable";
import type {
  MachineCommandResultV1,
  MachineCommandV1,
  MachineListViewV1,
} from "@frockbot/core/machine-protocol";
import { enqueuePendingBotInputV1 } from "@frockbot/app/routines/inbox-store";
import {
  readBotSettingsV1,
  userConfigurationV1,
} from "@frockbot/app/settings/bot";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import type { MachineMessagesRuntimeHostV1 } from "@frockbot/app/machine-messages/agent";
import {
  machineMessagesEnabledV1,
  machineMessagesGateV1,
  type MachineMessagesGateV1,
} from "@frockbot/app/machine-messages/gate";
import type {
  MachineIntentStorageV1,
  MachineRuntimeHostV1,
  MachineWriterIdentityV1,
} from "@frockbot/app/machine/agent";
import {
  dispatchMachineIntentV1,
  type MachineDispatchAnswerV1,
} from "@frockbot/app/machine/approval";
import type { MachineIntentRecordV1 } from "@frockbot/app/machine/intent";
import type { MachineResultDeliveryV1 } from "@frockbot/app/machine/delivery";
import type { MachineTargetViewV1 } from "@frockbot/app/machine/target";

/** The User Durable Object, as this Bot is allowed to see its machines. */
export interface BotMachineSeamV1 {
  list(): Promise<MachineListViewV1>;
  describeTarget(machineId: string): Promise<MachineTargetViewV1>;
  readResult(commandId: string): Promise<MachineCommandResultV1 | undefined>;
  dispatch(command: MachineCommandV1): Promise<MachineDispatchAnswerV1>;
}

/** The Turn an intent record is attributed to. */
export interface BotMachineTurnV1 {
  sessionId: string;
  turnId: string;
  runId: string;
}

/**
 * The runtime host for one admitted Turn.
 *
 * `storage` is the Bot's own, because an intent is Bot-scoped durable state:
 * it is what the settlement reads back from an `approvalId` to know what a
 * person actually approved.
 */
export function createBotMachineHost(
  identity: { botId: string },
  turn: BotMachineTurnV1,
  storage: MachineIntentStorageV1,
  seam: BotMachineSeamV1,
): MachineRuntimeHostV1 {
  return {
    botId: identity.botId,
    writer: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
    storage,
    list: () => seam.list(),
    describeTarget: (machineId) => seam.describeTarget(machineId),
    readResult: (commandId) => seam.readResult(commandId),
  };
}

/**
 * Put an approved command on its machine's queue, after the decision has
 * committed.
 *
 * Outside the settling transaction on purpose: a cross-Durable-Object call
 * inside one would make its atomicity a lie. It does not need to be inside
 * one — the dispatch is idempotent on `commandId`, which is the Turn's own
 * `effectId`, so a crash between the commit and this call is a retry and never
 * a second command on somebody's laptop.
 */
export async function dispatchApprovedMachineIntentV1(
  storage: MachineIntentStorageV1,
  intent: MachineIntentRecordV1,
  seam: Pick<BotMachineSeamV1, "dispatch">,
  now: () => string = () => new Date().toISOString(),
): Promise<MachineIntentRecordV1> {
  return dispatchMachineIntentV1(
    storage,
    intent,
    (command) => seam.dispatch(command),
    now(),
  );
}

/**
 * Row 57g's gate, answered for one Turn.
 *
 * Two facts and one read. The setting is already in hand — it came from the
 * same User configuration the rest of this Composition was resolved from — and
 * the registry is asked for only when it is on, so a deployment with the
 * feature off pays nothing for it.
 *
 * `undefined` means the tools are not mounted: off, or no connected macOS
 * machine reporting `messages`. A Bot never sees a Messages tool it could only
 * be refused by.
 */
export async function resolveBotMachineMessagesGateV1(
  settings: Readonly<Record<string, string | number | boolean>> | undefined,
  list: () => Promise<MachineListViewV1>,
): Promise<MachineMessagesGateV1> {
  if (!machineMessagesEnabledV1(settings)) return { status: "off" };
  const view = await list();
  return machineMessagesGateV1({ enabled: true, machines: view.machines });
}

/**
 * The Messages host for one admitted Turn.
 *
 * It is the machine host plus `dispatch`, and it exists only because the six
 * approval-exempt reads have no settlement to ride: `machine_exec` is queued by
 * the approval settlement, and a read has no approval. Nothing else widens —
 * the Package cannot enrol, revoke, or reach any machine this User does not
 * own, because the seam it is handed is the same one the control tools use.
 */
export function createBotMachineMessagesHost(
  machines: MachineRuntimeHostV1 & { writer: MachineWriterIdentityV1 },
  seam: Pick<BotMachineSeamV1, "dispatch">,
): MachineMessagesRuntimeHostV1 {
  return {
    machines,
    dispatch: (command) => seam.dispatch(command),
  };
}

/**
 * The User's machines, as this Bot may see them.
 *
 * Four calls and no more: list them, resolve one, queue an approved command,
 * and read a finished command's result. There is no register, no revoke and no
 * token here — a Bot cannot enrol or revoke a machine, and "self modification
 * never widens authority" is why.
 */
export function machineSeam(
  state: ShellBotStateV1,
  identity: BotIdentity,
): BotMachineSeamV1 {
  const userConfiguration = userConfigurationV1(state, identity);
  return {
    list: () => userConfiguration.listMachines(identity.userId),
    describeTarget: (machineId) =>
      userConfiguration.describeMachineTarget(identity.userId, machineId),
    readResult: (commandId) =>
      userConfiguration.readMachineResult(identity.userId, commandId),
    dispatch: (command) =>
      userConfiguration.dispatchMachineCommand(identity.userId, command),
  };
}

/**
 * One finished machine command, handed over by the User Durable Object.
 *
 * The machine answers the backend, never the Bot, so this is how the Bot
 * learns without being asked: the same durable input queue a Routine hand-off
 * and an approval decision ride, idempotent on the command id, drained as a
 * preamble line on the Bot's next conversational Turn. The line carries a
 * preview; `machine_command_check` reads the whole result.
 */
export async function deliverMachineResult(
  state: ShellBotStateV1,
  delivery: MachineResultDeliveryV1,
): Promise<{ status: "accepted" }> {
  await state.ctx.storage.transaction(async (transaction) => {
    await enqueuePendingBotInputV1(transaction, {
      schemaVersion: 1,
      kind: "machine-result",
      commandId: delivery.commandId,
      machineId: delivery.machineId,
      outcome: delivery.outcome,
      preview: delivery.preview,
      createdAt: delivery.finishedAt,
    });
  });
  await state.ctx.storage.transaction((transaction) =>
    state.authority.refreshRecoveryAlarm(transaction),
  );
  return { status: "accepted" };
}

/**
 * The second of the two points a pending wake is heard at.
 *
 * The first is the Bot's next conversational Turn. This one is the User's: an
 * intent recorded in the settling transaction cannot be lost, but a client that
 * was not connected when it landed can miss the delivery, so the alarm re-emits
 * it once for a wake whose inbox entry is still unread. Once per wake, recorded
 * on the wake, so a Bot nobody talks to is not notified on every alarm forever.
 */
export async function replayPendingWakeNotifications(
  state: ShellBotStateV1,
): Promise<void> {
  const pending = await state.routineInbox.pending();
  if (pending.length === 0) return;
  const identity = await state.authority.readDurableIdentity();
  if (!identity) return;
  const settings = await readBotSettingsV1(state, identity);
  if (!settings.notifications.enabled) return;
  const unread = new Map(
    (await state.routineInbox.list())
      .filter((entry) => !entry.acknowledged)
      .map((entry) => [entry.runId, entry] as const),
  );
  for (const { key, input } of pending) {
    if (input.kind !== "wake" || input.renotifiedAt !== undefined) continue;
    const entry = unread.get(input.runId);
    if (!entry) continue;
    // The same notification id the settle recorded, per source: a replay is a
    // second delivery of one intent, never a second intent.
    const subagent = input.source === "subagent";
    await state.authority.recordNotification({
      notificationId: subagent
        ? `task-settled:${input.runId}`
        : `routine-wake:${input.runId}`,
      runId: input.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} finished ${
        subagent ? "a subagent task" : "a Routine"
      }`,
      body: entry.text.slice(0, 240),
    });
    await state.routineInbox.markRenotified(key);
  }
}

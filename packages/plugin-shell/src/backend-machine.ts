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
// The Shell owns this file for the same reason it owns `backend-routines.ts`:
// it is the object that holds the approval record, the alarm that expires it,
// and the route a person answers on, so the hand-off from "decided" to "queued"
// has nowhere else it could honestly live.
import type {
  MachineCommandResultV1,
  MachineCommandV1,
  MachineListViewV1,
} from "@frockbot/machine-protocol";
import type {
  MachineIntentStorageV1,
  MachineRuntimeHostV1,
} from "@frockbot/plugin-user-machine/agent";
import {
  dispatchMachineIntentV1,
  type MachineDispatchAnswerV1,
} from "@frockbot/plugin-user-machine/approval";
import type { MachineIntentRecordV1 } from "@frockbot/plugin-user-machine/intent";
import type { MachineTargetViewV1 } from "@frockbot/plugin-user-machine/target";

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

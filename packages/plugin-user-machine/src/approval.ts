// The approval settlement, as far as this Package owns it.
//
// `plugin-shell` owns the approval record, its expiry alarm and the route a
// person answers on; it has done since row 53 landed, and this slice adds no
// second approval mechanism. What it adds is two functions the settlement
// calls:
//
//  * `settleMachineIntentV1` runs *inside* the transaction that records the
//    decision. The decision and what it authorized become durable together, so
//    there is no instant at which a person has approved something whose intent
//    record still says nobody answered.
//
//  * `dispatchMachineIntentV1` runs *after* it. A cross-Durable-Object call
//    inside a storage transaction would make the transaction's atomicity a
//    lie, and it does not need to be inside one: the dispatch is idempotent on
//    `commandId`, so a crash between the commit and the RPC is a retry and
//    never a second command on somebody's laptop.
//
// A denial or an expiry dispatches nothing and terminates the intent where it
// stands. Only `approved` reaches a queue.
import {
  MACHINE_LIMITS_V1,
  MachineDecodeError,
  decodeMachineCommandV1,
  type MachineCommandV1,
} from "@frockbot/machine-protocol";
import type { MachineIntentStorageV1 } from "./agent.js";
import {
  decodeMachineIntentRecordV1,
  dispatchedMachineIntentV1,
  machineCommandForIntentV1,
  machineIntentKeyV1,
  settledMachineIntentV1,
  type MachineIntentRecordV1,
} from "./intent.js";

/** What the queue answered a dispatch with. `store.ts`'s outcome, narrowed. */
export type MachineDispatchAnswerV1 =
  | { status: "queued"; command: MachineCommandV1 }
  | { status: "duplicate"; command: MachineCommandV1 }
  | { status: "refused"; reason: string };

/**
 * The dispatch answer, decoded at the seam it crosses.
 *
 * It comes back from another Durable Object, so it is decoded rather than
 * trusted in the shape RPC happened to return — the same rule every other
 * value in this Package's protocol is held to.
 */
export function decodeMachineDispatchAnswerV1(
  input: unknown,
  label = "machine dispatch answer",
): MachineDispatchAnswerV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new MachineDecodeError(`${label} must be an object`);
  }
  const value = input as Record<string, unknown>;
  if (value.status === "refused") {
    for (const key of Object.keys(value)) {
      if (!["status", "reason"].includes(key)) {
        throw new MachineDecodeError(`${label} has an unexpected key "${key}"`);
      }
    }
    if (
      typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      value.reason.length > MACHINE_LIMITS_V1.message
    ) {
      throw new MachineDecodeError(`${label} reason is invalid`);
    }
    return { status: "refused", reason: value.reason };
  }
  if (value.status !== "queued" && value.status !== "duplicate") {
    throw new MachineDecodeError(`${label} status is invalid`);
  }
  for (const key of Object.keys(value)) {
    if (!["status", "command"].includes(key)) {
      throw new MachineDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
  return {
    status: value.status,
    command: decodeMachineCommandV1(value.command, `${label} command`),
  };
}

/**
 * Record what a decision means for the machine command it authorized, in the
 * transaction that records the decision itself.
 *
 * Answers `undefined` when the approval was not a machine command's — the
 * common case, since most cards are not this Package's — so the caller can
 * treat "not ours" and "nothing to do" identically.
 */
export async function settleMachineIntentV1(
  transaction: MachineIntentStorageV1,
  approvalId: string,
  decision: "approved" | "denied" | "expired",
  at: string,
): Promise<MachineIntentRecordV1 | undefined> {
  const key = machineIntentKeyV1(approvalId);
  const stored = await transaction.get<unknown>(key);
  if (stored === undefined) return undefined;
  let intent: MachineIntentRecordV1;
  try {
    intent = decodeMachineIntentRecordV1(stored, "stored machine intent");
  } catch (error) {
    // A record this Package cannot read is not a reason a person's decision
    // fails to record. It is left exactly as it is and reported nowhere but
    // here, where the settlement can carry on.
    if (error instanceof MachineDecodeError) return undefined;
    throw error;
  }
  const settled = settledMachineIntentV1(intent, decision, at);
  if (settled !== intent) await transaction.put(key, settled);
  return settled;
}

/**
 * Put an approved intent's command on its machine's queue, and record what the
 * queue said.
 *
 * Called after the settling transaction has committed. `dispatch` is the
 * narrow User-Durable-Object seam; nothing here knows it is an RPC.
 */
export async function dispatchMachineIntentV1(
  storage: MachineIntentStorageV1,
  intent: MachineIntentRecordV1,
  dispatch: (command: MachineCommandV1) => Promise<MachineDispatchAnswerV1>,
  at: string,
): Promise<MachineIntentRecordV1> {
  // Only an approved intent that has not already been answered by the queue
  // reaches a machine. A replayed settlement stops here.
  if (intent.decision !== "approved" || intent.outcome !== undefined) {
    return intent;
  }
  const answer = await dispatch(machineCommandForIntentV1(intent, at));
  const settled =
    answer.status === "refused"
      ? dispatchedMachineIntentV1(intent, "refused", at, answer.reason)
      : dispatchedMachineIntentV1(
          intent,
          answer.status === "queued" ? "dispatched" : "duplicate",
          at,
        );
  await storage.put(machineIntentKeyV1(intent.approvalId), settled);
  return settled;
}

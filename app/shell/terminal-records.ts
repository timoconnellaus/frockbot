/**
 * Everything the Shell writes in the transaction that settles a Turn.
 *
 * Several policies share the kernel's one `terminalRecords` seam and none of
 * them knows about the others: unread state advances for a conversational Turn,
 * an automation Turn writes its completion-inbox entry and the pending input it
 * hands off, any Turn that asked for an approval writes the durable pending
 * decision, and a Turn the voice session asked for notes that a call is owed
 * its answer. The kernel writes the returned keys without reading them, so this
 * is the only place their composition is decided.
 *
 * Two rules the composition itself has to keep, and they are why this is a
 * function with a test rather than a row of spreads in a method body.
 *
 *  * **Each producer runs exactly once per settlement.** A settlement that ran
 *    a producer twice would write two records where the Turn earned one — a
 *    firing with two inbox entries, say — and the second would be invisible
 *    until somebody counted.
 *
 *  * **No producer may silently overwrite another.** A spread lets a later key
 *    clobber an earlier one with no sign; a collision here is a bug in the key
 *    spaces two Packages chose, so it throws rather than picking a winner.
 *
 * One settlement also gets one `now`. Producers each reading their own clock
 * would stamp one transaction with several different instants.
 */
import {
  enqueuePendingBotInputV1,
  pendingInputSettlementWritesV1,
  requeueDrainedInputsV1,
} from "@frockbot/app/routines/inbox-store";
import type { PendingBotInputV1 } from "@frockbot/app/routines/inbox";
import { approvalTerminalRecordsV1 } from "./approvals.js";
import { cardTerminalRecordsV1 } from "./cards.js";
import { routineTerminalRecordsForRunV1 } from "@frockbot/app/routines/bot";
import { voiceReplyOutboxRecordsV1 } from "./voice-reply.js";

/** The settled run a terminal record set is computed from. */
export interface ShellTerminalRunV1 {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
  events: readonly { type: string }[];
  responseText?: string;
  admission?: {
    turnType?: string;
    // Wide on purpose: the kernel records one origin shape per producer, and
    // this module only asks which producer it was.
    origin?: { kind: string; routineId?: string };
  };
}

export interface ShellTerminalInputV1 {
  run: ShellTerminalRunV1;
  /** The admission-index cursor the Turn was admitted under. */
  cursor: string;
  /** The one instant this settlement is stamped with. */
  now: string;
  /** Reader bound to the transaction that is settling the Turn. */
  read<T>(key: string): Promise<T | undefined>;
}

/**
 * The unread record — FrockBot's `lastTurnSettlement`. Activity advances
 * whatever the Bot's notification policy says: muting silences the intent,
 * never the badge. Only a chat Turn advances it; an automation Turn reaches
 * the User through its own inbox entry.
 */
/**
 * The completion-inbox entry and pending wake an automation Turn contributes.
 * Nothing for a conversational one, so a chat Turn's settlement is
 * byte-for-byte what it was before Routines existed.
 */
async function routineRecordsV1(
  input: ShellTerminalInputV1,
): Promise<Record<string, unknown>> {
  const contributed = await routineTerminalRecordsForRunV1({
    run: input.run,
    read: input.read,
    now: input.now,
  });
  return contributed?.records ?? {};
}

/**
 * The pending decisions the Turn asked for. "A request for more becomes a
 * durable pending decision for the User, never a grant": the card the User
 * sees and the record their answer is written against become durable in one
 * transaction, so there is no instant at which the question has been asked and
 * the answer has nowhere to go.
 */
async function approvalRecordsV1(
  input: ShellTerminalInputV1,
): Promise<Record<string, unknown>> {
  return approvalTerminalRecordsV1({
    run: {
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      events: input.run.events,
    },
    now: input.now,
    read: input.read,
  });
}

/**
 * The Cards the Turn drew or updated, folded onto the records the Session
 * holds. Beside the approvals for the same reason: a `card` send is a thing
 * in the transcript a person can press, and the record their press is posted
 * against becomes durable in the same transaction as the send.
 */
async function cardRecordsV1(
  input: ShellTerminalInputV1,
): Promise<Record<string, unknown>> {
  return cardTerminalRecordsV1({
    run: {
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      events: input.run.events,
    },
    now: input.now,
    read: input.read,
  });
}

/**
 * The note that a voice call is owed this Turn's answer.
 *
 * In the settling transaction rather than after it, for the reason every
 * durable hand-off here is: between "the answer is recorded" and "somebody has
 * been told" there must be no instant where an eviction loses the hand-off.
 */
function voiceRecordsV1(
  input: ShellTerminalInputV1,
): Promise<Record<string, unknown>> {
  return Promise.resolve(
    voiceReplyOutboxRecordsV1({ run: input.run, now: input.now }),
  );
}

/** The producers, in the order they are composed. Each is called once. */
const SHELL_TERMINAL_PRODUCERS_V1 = [
  routineRecordsV1,
  approvalRecordsV1,
  cardRecordsV1,
  voiceRecordsV1,
] as const;

/**
 * What a Turn the User's next message replaced leaves behind.
 *
 * One durable input, drained once by the next conversational Turn. The session
 * log already carries what the Turn sent and what its tools returned; this is
 * the part that is *not* in the log — that it was cut off, that nothing still
 * in flight completed, and that a subagent it dispatched is still working.
 * Background work survives a supersede, so the reminder is how the Bot learns
 * that an answer is still coming rather than losing track of it.
 *
 * It also gives back whatever the Turn drained and never carried. A chat Turn
 * takes the pending queue before the model runs, so a Turn the next message
 * replaced has consumed hand-offs nobody heard — and a delivery Turn, opened
 * by the alarm with nobody present, is replaced by the person's very first
 * word. The drained inputs go back on the queue in this same transaction, and
 * the Turn that replaced this one drains them itself.
 *
 * An automation Turn contributes nothing: a firing is not the conversation,
 * and it reaches the User through its own inbox entry.
 */
export async function supersededTurnRecordsV1(input: {
  run: ShellTerminalRunV1;
  now: string;
  read<T>(key: string): Promise<T | undefined>;
}): Promise<Record<string, unknown>> {
  if ((input.run.admission?.turnType ?? "chat") !== "chat") return {};
  const pending = {
    schemaVersion: 1,
    kind: "superseded-turn",
    runId: input.run.runId,
    unfinishedWork: input.run.events.some(
      (event) => event.type === "task/dispatched",
    ),
    createdAt: input.now,
  } satisfies PendingBotInputV1;
  const records: Record<string, unknown> = {};
  const writes = pendingInputSettlementWritesV1(records, input.read);
  await requeueDrainedInputsV1(writes, input.run.runId);
  await enqueuePendingBotInputV1(writes, pending);
  return records;
}

export async function shellTerminalRecordsV1(
  input: ShellTerminalInputV1,
): Promise<Record<string, unknown>> {
  const records: Record<string, unknown> = {};
  for (const produce of SHELL_TERMINAL_PRODUCERS_V1) {
    for (const [key, value] of Object.entries(await produce(input))) {
      if (Object.hasOwn(records, key)) {
        throw new Error(
          `two terminal-record producers both wrote "${key}"; one would have silently overwritten the other`,
        );
      }
      records[key] = value;
    }
  }
  return records;
}

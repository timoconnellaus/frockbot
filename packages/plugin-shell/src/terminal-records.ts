/**
 * Everything the Shell writes in the transaction that settles a Turn.
 *
 * Three policies share the kernel's one `terminalRecords` seam and none of them
 * knows about the others: unread state advances for a conversational Turn, an
 * automation Turn writes its completion-inbox entry and the pending input it
 * hands off, and any Turn that asked for an approval writes the durable pending
 * decision. The kernel writes the returned keys without reading them, so this
 * is the only place their composition is decided.
 *
 * Two rules the composition itself has to keep, and they are why this is a
 * function with a test rather than three spreads in a method body.
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
 * One settlement also gets one `now`. Three producers each reading their own
 * clock would stamp one transaction with three different instants.
 */
import {
  advanceUnreadActivityV1,
  optionalUnreadStateV1,
  sidebarMessagePreviewForTurnV1,
  SIDEBAR_PREVIEW_KEY,
  UNREAD_STATE_KEY,
} from "./unread.js";
import { enqueuePendingBotInputV1 } from "@frockbot/plugin-routines/inbox-store";
import type { PendingBotInputV1 } from "@frockbot/plugin-routines/inbox";
import { approvalTerminalRecordsV1 } from "./approvals.js";
import { routineTerminalRecordsForRunV1 } from "./backend-routines.js";

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
async function unreadRecordsV1(
  input: ShellTerminalInputV1,
): Promise<Record<string, unknown>> {
  if ((input.run.admission?.turnType ?? "chat") !== "chat") return {};
  const current = optionalUnreadStateV1(
    await input.read<unknown>(UNREAD_STATE_KEY),
  );
  const next = advanceUnreadActivityV1(current, {
    cursor: input.cursor,
    at: input.now,
  });
  const preview = sidebarMessagePreviewForTurnV1(input.run, input.now);
  return {
    [UNREAD_STATE_KEY]: next,
    // `advanceUnreadActivityV1` returns the current object for a replay or an
    // older settlement. The preview follows that same monotonic decision, so
    // recovery cannot replace a newer row with an older Turn.
    ...(next === current || preview === undefined
      ? {}
      : { [SIDEBAR_PREVIEW_KEY]: preview }),
  };
}

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

/** The producers, in the order they are composed. Each is called once. */
const SHELL_TERMINAL_PRODUCERS_V1 = [
  unreadRecordsV1,
  routineRecordsV1,
  approvalRecordsV1,
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
  await enqueuePendingBotInputV1(
    {
      get: <T>(key: string) => input.read<T>(key),
      // A settling transaction cannot list. De-duplication is by the input's
      // id, which is this run's, and a run settles once.
      list: <T>() => Promise.resolve(new Map<string, T>()),
      put: (key: string, value: unknown) => {
        records[key] = value;
        return Promise.resolve();
      },
      delete: () => Promise.resolve(false),
    },
    pending,
  );
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

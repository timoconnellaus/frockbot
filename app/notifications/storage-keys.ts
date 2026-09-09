// The Bot Durable Object storage keys the message-notification path owns.
//
// A leaf module so the writer and the drainer share one definition: the unread
// command writes the read intent, `messageRecords` writes the message intents,
// and the Durable Object drains both. A rename that reached only one of them
// would strand delivery, so none of them names these keys itself.

/** One undelivered `MessageNotice`, keyed by its message cursor. */
export const PUSH_OUTBOX_PREFIX = "shell:push:";
/** The one undelivered read cursor: what every other device should clear. */
export const PUSH_READ_KEY = "shell:push-read";

/**
 * How many outbox entries one drain pass delivers. A full page means the outbox
 * may hold more, and the drainer takes another pass rather than leaving the
 * remainder to the next alarm.
 */
export const PUSH_OUTBOX_DRAIN_LIMIT = 100;

/**
 * One marker per automation run that produced a visible message, written in the
 * transaction that committed the message.
 *
 * A Routine's Turn belongs in the transcript only when it spoke, and that fact
 * lives in the Turn's journal. Reading the journal to find it made a transcript
 * page hydrate every silent firing it scanned past — the ordinary case for a
 * Routine that runs every minute. The marker moves the fact to a single keyed
 * read beside the run record the scan already holds.
 */
export const SENT_AUTOMATION_RUN_PREFIX = "shell:sent-run:";

export function sentAutomationRunKeyV1(runId: string): string {
  return `${SENT_AUTOMATION_RUN_PREFIX}${runId}`;
}

/**
 * What one automation run left beside the message it contributed.
 *
 * Written in the same transaction as the message. Its presence is the fact
 * the transcript scan needs — this firing spoke, so it belongs in the
 * conversation — and `send`, when there is one, is the message itself for a
 * run whose journal has no send event to project.
 */
export interface SentAutomationRunV1 {
  schemaVersion: 1;
  at: string;
  send?: { ordinal: number; text: string };
}

/** A display read: an unrecognisable marker projects no send, never throws. */
export function optionalProjectedSendV1(
  value: unknown,
): { ordinal: number; text: string } | undefined {
  const send = (value as SentAutomationRunV1 | undefined)?.send;
  if (
    !send ||
    typeof send !== "object" ||
    !Number.isSafeInteger(send.ordinal) ||
    send.ordinal < 0 ||
    typeof send.text !== "string" ||
    send.text.length === 0
  ) {
    return undefined;
  }
  return { ordinal: send.ordinal, text: send.text };
}

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

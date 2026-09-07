/**
 * What a send means when the answer was not a Turn.
 *
 * There are two of those and they are not alike. A 4xx is the server having
 * read the request and decided against it: the Turn does not exist, will not
 * exist, and the answer says why. Everything else — a 5xx, a socket that
 * closed, a browser that lost the network — leaves admission genuinely
 * unknown, and only that case is worth reconciling.
 *
 * Telling them apart is the whole point. Treating a 413 as unknown drew the
 * person's oversized draft into the thread as though it had been sent, then
 * polled for a run that was never admitted.
 */

/**
 * True when the transport's error carries a 4xx: a refusal, not a doubt.
 *
 * Duck-typed on `status` rather than on an error class, because the transport
 * is an interface with more than one implementation and a plain `Error` with a
 * status is all any of them can be relied on to throw.
 */
export function isCertainSendRefusalV1(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("status" in error)) return false;
  const status = error.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * How many times admission reconciliation asks before it stops asking.
 *
 * A bound rather than an ever-retrying loop: a backend the tab cannot reach
 * does not become reachable by being asked a thousand times, and the person
 * watching a placeholder deserves an answer inside a few seconds. Six attempts
 * over the schedule below spans roughly eight seconds, which covers a Worker
 * cold start and a brief network blip without outliving anybody's patience.
 */
export const UNCERTAIN_ADMISSION_MAX_ATTEMPTS_V1 = 6;

const FIRST_DELAY_MS_V1 = 250;
const MAX_DELAY_MS_V1 = 5_000;

/**
 * How long to wait before attempt `attempt + 1`, or `undefined` once the bound
 * is spent and the client should settle instead of asking again.
 */
export function uncertainAdmissionDelayMsV1(
  attempt: number,
): number | undefined {
  if (attempt >= UNCERTAIN_ADMISSION_MAX_ATTEMPTS_V1) return undefined;
  return Math.min(FIRST_DELAY_MS_V1 * 2 ** (attempt - 1), MAX_DELAY_MS_V1);
}

/**
 * What the thread says when the client gave up reaching the backend.
 *
 * Naming the app's own failure, because nothing else in the product did: every
 * other line blames the message or the Bot, and a person whose wifi dropped
 * was told their message "didn't go through" as though the Bot had refused it.
 */
export const UNREACHABLE_BOT_MESSAGE_V1 =
  "Couldn't reach the Bot. Check your connection and try again.";

/**
 * A timestamp one millisecond after `at`.
 *
 * The thread sorts by time, so a line that belongs under another needs a time
 * of its own: the placeholder used to carry the moment the send *began*, which
 * put it above the message it was reporting on the instant the durable
 * projection gave that message its later `admittedAt`.
 */
export function momentAfterV1(at: string): string {
  const moment = new Date(at).getTime();
  // An unparsable timestamp is not worth inventing an order for; the thread's
  // insertion order still holds the line where it was put.
  if (!Number.isFinite(moment)) return at;
  return new Date(moment + 1).toISOString();
}

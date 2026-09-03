/**
 * The boundary every entry point answers behind.
 *
 * The gateway's `fetch` has had an error boundary for a long time. Nothing else
 * did — and the dev Worker died twice in one evening on a `BotNotFoundError`
 * thrown out of a Durable Object's own `fetch` during a state-channel upgrade,
 * followed by wrangler reporting the network connection lost. An entry point is
 * whatever workerd calls into: `fetch`, a WebSocket callback, `alarm`,
 * `scheduled`, `queue`. Every one of them is a place where a thrown error has
 * no caller left to catch it, so every one of them ends here instead.
 *
 * Two shapes, because the two kinds of entry point owe different things. A
 * request-shaped one owes an answer, and the answer is JSON with a readable
 * reason — a client that receives `Internal Server Error` as plain text can
 * only report a JSON parse failure, which tells the person nothing. A
 * fire-and-forget one owes nothing to anybody, so it records what happened and
 * lets the next firing try again.
 */

/**
 * The named failures a Durable Object raises for a Bot that is not there, and
 * the status each is owed.
 *
 * Matched on `name` rather than by class, because the error has crossed an RPC
 * boundary by the time it is read and only its name and message survive — the
 * same convention the gateway's Bot routes already rely on.
 */
const ENTRY_STATUS_BY_ERROR_NAME_V1 = new Map<string, number>([
  ["BotNotFoundError", 404],
  ["ComputerBotNotFoundError", 404],
  ["BotArchivedError", 409],
]);

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : undefined;
}

/** The status an escaped error is owed, defaulting to 500. */
export function entryFailureStatusV1(error: unknown): number {
  return ENTRY_STATUS_BY_ERROR_NAME_V1.get(errorName(error) ?? "") ?? 500;
}

export function entryFailureResponseV1(
  error: unknown,
  fallback: string,
): Response {
  const status = entryFailureStatusV1(error);
  const message =
    error instanceof Error && error.message ? error.message : fallback;
  return Response.json({ error: message }, { status });
}

/**
 * Run a request-shaped entry point, answering rather than throwing.
 *
 * A Bot that is not there is a 404 the caller can act on, not a fault; anything
 * else is a 500 that still carries a reason. Either way the isolate survives to
 * answer the next request, which is the property this exists for.
 */
export async function answeredEntryV1(
  fallback: string,
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return entryFailureResponseV1(error, fallback);
  }
}

/**
 * Run a fire-and-forget entry point — an alarm, a socket callback — recording
 * a failure instead of letting it escape.
 *
 * Swallowing is deliberate and bounded: an alarm is rescheduled by whatever
 * owns it and a socket callback has nobody to answer, so the durable
 * consequence of a failure here is that the next firing tries again. What must
 * not happen is the throw, which in a Durable Object is an uncaught exception
 * and in the dev Worker took the whole process with it.
 */
export async function loggedEntryV1(
  label: string,
  work: () => void | Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

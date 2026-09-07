/**
 * Bounds on a remote call.
 *
 * `MEMORY_FILES` and `MEMORY_INDEX` are remote bindings even in development,
 * and so are the cross-Durable-Object ledger and membership calls beside them.
 * Every one of those seams used to be a bare `await`: no deadline, no retry.
 * A hung binding therefore hung the whole Turn to the platform limit, and a
 * blip that a second attempt would have survived failed a Turn instead.
 *
 * These are two small functions rather than a client wrapper on purpose. The
 * seams are in several Packages and take several shapes, and what they all
 * need is the same two sentences: do not wait forever, and try a transient
 * failure once more.
 */

/** How long one remote call may take before it is abandoned. */
export const REMOTE_CALL_TIMEOUT_MS_V1 = 10_000;

export class RemoteCallTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not answer within ${timeoutMs}ms`);
    this.name = "RemoteCallTimeoutError";
  }
}

/**
 * Runs one remote call under a deadline.
 *
 * The deadline is a bound on *waiting*, not a cancellation: a binding that
 * ignores its `AbortSignal` may still land its effect, which is why every
 * caller of this treats a timeout the way it treats any other uncertain
 * outcome rather than assuming nothing happened.
 */
export async function withDeadlineV1<T>(
  label: string,
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = REMOTE_CALL_TIMEOUT_MS_V1,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RemoteCallTimeoutError(label, timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs a call, and runs it once more if the first attempt threw.
 *
 * One retry, not a backoff schedule: the caller is inside a Turn a person is
 * waiting on, and the failure this recovers from is a blip. Anything that
 * fails twice is a real failure and is reported as one.
 */
export async function retryOnceV1<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    return call();
  }
}

/** A remote call under a deadline, attempted twice. */
export function remoteCallV1<T>(
  label: string,
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = REMOTE_CALL_TIMEOUT_MS_V1,
): Promise<T> {
  return retryOnceV1(() => withDeadlineV1(label, call, timeoutMs));
}

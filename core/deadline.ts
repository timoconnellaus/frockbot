/**
 * A request deadline that stops costing anything the moment the request is
 * done with it.
 *
 * `AbortSignal.timeout(ms)` is the obvious way to write this and the wrong one
 * inside a Durable Object. The timer it schedules cannot be cancelled, so it
 * stays pending for the whole timeout even after the fetch it guarded has
 * answered — and a pending timer is live I/O. The object cannot drain, so it
 * cannot hibernate, and `evictDurableObject` in a test waits out the timeout
 * before it can tear the instance down. An Ollama Connection created with a
 * 30-second inference probe pinned its User object awake for 30 seconds after
 * the probe returned, in production and in every workerd suite that provisions
 * a Bot.
 *
 * So the deadline owns a timer it can clear, and `clear()` is what the caller
 * owes it — from a `finally`, so a throw pays it too.
 */
export interface DeadlineV1 {
  /** Pass this to `fetch`; it aborts when the deadline passes. */
  readonly signal: AbortSignal;
  /** Whether *this* deadline aborted, rather than the caller's own signal. */
  timedOut(): boolean;
  /** Cancel the timer. Idempotent, and safe after the deadline has passed. */
  clear(): void;
}

/**
 * A deadline of `timeoutMs`, optionally also abortable through `signal`.
 *
 * `timedOut()` distinguishes the deadline from the caller's signal, so a
 * caller can report "the provider did not answer in time" rather than
 * attributing its own cancellation to the provider.
 */
export function withDeadlineV1(
  timeoutMs: number,
  signal?: AbortSignal,
): DeadlineV1 {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
  }, timeoutMs);
  return {
    signal: signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal,
    timedOut: () => expired,
    clear: () => clearTimeout(timer),
  };
}

/**
 * A bound on how many independent reads a turn-start fan-out keeps in flight.
 *
 * The fan-outs on this path are each bounded by their own catalog limit — 200
 * Skill entries per instruction root, 64 Memory files per tier — but those are
 * bounds on how much work there is, not on how much of it runs at once. A
 * Worker has a subrequest budget and a finite number of connections, so the
 * useful cap is small: the round trips overlap long before the two-hundredth
 * one is outstanding.
 */
export const TURN_READ_CONCURRENCY_V1 = 8;

/**
 * Runs the tasks handed to it with at most `limit` outstanding at a time.
 *
 * The returned function is transparent: it takes a thunk and gives back a
 * promise for exactly what the thunk resolves to, so a caller wraps its
 * existing `Promise.all(...map(...))` and changes nothing about the results,
 * their order, or which failures surface. Work queued behind the bound still
 * runs — this is bounded parallelism, not a serial loop.
 */
export type ConcurrencyLimiterV1 = <T>(task: () => Promise<T>) => Promise<T>;

export function createConcurrencyLimiterV1(
  limit: number = TURN_READ_CONCURRENCY_V1,
): ConcurrencyLimiterV1 {
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (running < limit) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // The slot is taken here, synchronously, rather than by the woken task:
      // two releases in the same tick must not admit three tasks.
      waiting.push(() => {
        running += 1;
        resolve();
      });
    });
  };
  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    acquire().then(task).finally(release);
}

// A workerd boot, bounded.
//
// Each build spawns its own workerd through Miniflare, and a spawn
// occasionally never reports ready (a bun+workerd spawn race, roughly one
// boot in fifty). A build that awaited `ready` unbounded would hang to the
// test's timeout, or hang the build container's request. So a boot is given
// a deadline, a boot that misses it is let go of rather than waited on, and
// the caller tries once more before answering with the deadline as its
// diagnostic.

/** How long a workerd boot is given before the build gives up on it. */
export const BOOT_DEADLINE_MS = 30_000;

/** A workerd that never reported ready; the boot, not the code, failed. */
export class RuntimeDidNotStart extends Error {}

/** `ready`, or a `RuntimeDidNotStart` when it has not settled in time. */
export async function bootedWithin<T>(ready: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RuntimeDidNotStart(
            `The Workers runtime did not start within ${BOOT_DEADLINE_MS}ms`,
          ),
        ),
      BOOT_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([ready, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `boot` again, once, when the runtime never came up the first time. */
export async function withOneMoreBoot<T>(boot: () => Promise<T>): Promise<T> {
  try {
    return await boot();
  } catch (error) {
    if (!(error instanceof RuntimeDidNotStart)) throw error;
    return await boot();
  }
}

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

/**
 * The same race seen from the other side: the spawn fails outright rather
 * than hanging, and the runtime's stdio socket is never there to connect to.
 * That is a boot that did not happen, not a fault in the code being built.
 */
function spawnFailed(error: unknown): boolean {
  const { code, syscall } = (error ?? {}) as {
    code?: unknown;
    syscall?: unknown;
  };
  return (
    (syscall === "connect" || syscall === "spawn") &&
    (code === "ENOENT" || code === "ECONNREFUSED" || code === "EAGAIN")
  );
}

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
  } catch (error) {
    if (!spawnFailed(error)) throw error;
    throw new RuntimeDidNotStart(
      `The Workers runtime could not be spawned: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
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

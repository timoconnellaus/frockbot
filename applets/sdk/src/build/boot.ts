// A workerd boot, bounded.
//
// Each build spawns its own workerd through Miniflare. A build that awaited
// `ready` unbounded would hang the build container's request on a runtime
// that never reported ready, so a boot is given a deadline and a boot that
// misses it is named as such. A boot takes well under a second, so the
// deadline is room for a loaded machine, not a guess at a slow start.

/** How long a workerd boot is given before the build gives up on it. */
export const BOOT_DEADLINE_MS = 30_000;

/** `ready`, or an error naming the boot when it did not settle in time. */
export async function bootedWithin<T>(ready: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
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

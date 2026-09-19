/** A deterministic timer seam shared by provider deadline tests. */
export function manualClock() {
  const pending = new Map<number, { run: () => void; due: number }>();
  let next = 1;
  let now = 0;
  return {
    schedule(run: () => void, milliseconds: number): () => void {
      const id = next++;
      pending.set(id, { run, due: now + milliseconds });
      return () => pending.delete(id);
    },
    /** Fire everything due at or before `now + milliseconds`. */
    advance(milliseconds: number): void {
      now += milliseconds;
      for (const [id, timer] of [...pending]) {
        if (timer.due <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
    get armed(): number {
      return pending.size;
    },
  };
}

/** Let a provider stream's pump run while its clock remains manually driven. */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

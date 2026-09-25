// When this Bot owes a `theme/assemble`. Apart from the assembly so the grants
// a Plugin writes through can owe one without importing the Plugin worker.

/**
 * When the next assemble is owed: the next hour's cadence, or now after a
 * Plugin switch or a write by a Plugin that wraps the look. An assemble that
 * finds it rewritten while it ran leaves it for the alarm. Absent means none.
 */
export const THEME_ASSEMBLE_DUE_KEY_V1 = "theme:assemble-due:v1";

/** The run id prefix of an assemble's own Plugin worker call. */
export const THEME_ASSEMBLE_RUN_PREFIX_V1 = "theme:";

/**
 * Present while the look the person last picked holds: no Plugin wraps it
 * until one is asked to set the look again.
 */
export const THEME_PICK_HOLDS_KEY_V1 = "theme:pick-holds:v1";

/** A person picked this Bot's look; it wins over any Plugin that wraps one. */
export async function holdThemePickV1(storage: {
  put(key: string, value: unknown): Promise<void>;
}): Promise<void> {
  await storage.put(THEME_PICK_HOLDS_KEY_V1, true);
}

export async function themePickHoldsV1(storage: {
  get<T>(key: string): Promise<T | undefined>;
}): Promise<boolean> {
  return (await storage.get<unknown>(THEME_PICK_HOLDS_KEY_V1)) === true;
}

/**
 * Owes an assemble now. Switching a Plugin, approving a new generation of
 * one, or a Plugin that wraps the look writing its own storage can each
 * change what the Bot should wear, and it would otherwise wear the old look
 * until the next hour. Owed rather than run, so the alarm carries it through
 * an eviction. Each is a Plugin being asked to set the look, so a person's
 * earlier pick stops holding.
 */
export async function oweThemeAssembleV1(
  storage: {
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<unknown>;
  },
  now: Date,
): Promise<void> {
  await storage.delete(THEME_PICK_HOLDS_KEY_V1);
  await storage.put(THEME_ASSEMBLE_DUE_KEY_V1, now.getTime());
}

export async function themeAssembleDeadlineV1(storage: {
  get<T>(key: string): Promise<T | undefined>;
}): Promise<number[]> {
  const due = await storage.get<unknown>(THEME_ASSEMBLE_DUE_KEY_V1);
  return typeof due === "number" && Number.isFinite(due) ? [due] : [];
}

/** How far an assemble due while a Turn executes is pushed each time. */
export const THEME_ASSEMBLE_TURN_DEFERRAL_MS_V1 = 2_000;

/**
 * The alarm cannot assemble while a Turn executes, and re-arms at once: an
 * assemble already due would fire it back to back until the Turn settled.
 */
export async function deferThemeAssembleV1(
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  },
  now: number,
): Promise<void> {
  const [due] = await themeAssembleDeadlineV1(storage);
  if (due === undefined || due > now) return;
  await storage.put(
    THEME_ASSEMBLE_DUE_KEY_V1,
    now + THEME_ASSEMBLE_TURN_DEFERRAL_MS_V1,
  );
}

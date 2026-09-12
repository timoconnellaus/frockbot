// A Plugin's health on one Bot (ADR 0026 step 9): what its failures count
// toward, and when they turn it off.
//
// "A Plugin that throws in a hook or exceeds its deadline is skipped for the
// Turn. The Turn completes without it, the User sees a notice in the Bot's
// words, and the failure counts toward a per-Bot quarantine at three. A
// quarantined Plugin stays off for that Bot until the User re-enables it."
//
// The count is of *consecutive Turns* that ended with the Plugin failing,
// whatever the phase — a descriptor the host refused, a health report that
// disagreed, a hook that threw or overran. A Turn the Plugin ran through
// cleanly resets it. Two failures in one Turn are one Turn's failure.
export const PLUGIN_HEALTH_PREFIX = "plugin:health:";

/** Consecutive failing Turns before a Plugin is turned off for this Bot. */
export const PLUGIN_QUARANTINE_THRESHOLD_V1 = 3;

export type PluginFailurePhaseV1 = "resolve" | "mount" | "health" | "hook";

export interface PluginHealthRecordV1 {
  schemaVersion: 1;
  pluginId: string;
  /** Turns in a row that ended with this Plugin failing. */
  consecutiveFailures: number;
  lastFailure: {
    runId: string;
    phase: PluginFailurePhaseV1;
    message: string;
    at: string;
  };
  /** Set when the count reached the threshold and the Plugin was turned off. */
  quarantinedAt?: string;
}

export interface PluginHealthStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_MESSAGE = 1_024;

export function pluginHealthKeyV1(pluginId: string): string {
  return `${PLUGIN_HEALTH_PREFIX}${pluginId}`;
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

export function decodePluginHealthRecordV1(
  input: unknown,
  label = "plugin health",
): PluginHealthRecordV1 {
  const value = record(input, label);
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "consecutiveFailures,lastFailure,pluginId,schemaVersion" &&
    keys !==
      "consecutiveFailures,lastFailure,pluginId,quarantinedAt,schemaVersion"
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${label} schemaVersion is unsupported`);
  }
  if (typeof value.pluginId !== "string" || !PLUGIN_ID.test(value.pluginId)) {
    throw new Error(`${label} pluginId is invalid`);
  }
  if (
    !Number.isSafeInteger(value.consecutiveFailures) ||
    (value.consecutiveFailures as number) < 0
  ) {
    throw new Error(`${label} consecutiveFailures must be a count`);
  }
  const last = record(value.lastFailure, `${label}.lastFailure`);
  if (
    typeof last.runId !== "string" ||
    typeof last.message !== "string" ||
    typeof last.at !== "string" ||
    Number.isNaN(Date.parse(last.at)) ||
    !["resolve", "mount", "health", "hook"].includes(last.phase as string)
  ) {
    throw new Error(`${label}.lastFailure is invalid`);
  }
  if (
    value.quarantinedAt !== undefined &&
    (typeof value.quarantinedAt !== "string" ||
      Number.isNaN(Date.parse(value.quarantinedAt)))
  ) {
    throw new Error(`${label} quarantinedAt is not a timestamp`);
  }
  return {
    schemaVersion: 1,
    pluginId: value.pluginId,
    consecutiveFailures: value.consecutiveFailures as number,
    lastFailure: {
      runId: last.runId,
      phase: last.phase as PluginFailurePhaseV1,
      message: last.message,
      at: last.at,
    },
    ...(value.quarantinedAt === undefined
      ? {}
      : { quarantinedAt: value.quarantinedAt as string }),
  };
}

export async function readPluginHealthV1(
  storage: Pick<PluginHealthStorageV1, "get">,
  pluginId: string,
): Promise<PluginHealthRecordV1 | undefined> {
  const stored = await storage.get<unknown>(pluginHealthKeyV1(pluginId));
  return stored === undefined ? undefined : decodePluginHealthRecordV1(stored);
}

/** Every Plugin this Bot holds a health record for, by id. */
export async function readPluginHealthMapV1(
  storage: Pick<PluginHealthStorageV1, "list">,
): Promise<Map<string, PluginHealthRecordV1>> {
  const stored = await storage.list<unknown>({ prefix: PLUGIN_HEALTH_PREFIX });
  const map = new Map<string, PluginHealthRecordV1>();
  for (const value of stored.values()) {
    const health = decodePluginHealthRecordV1(value);
    map.set(health.pluginId, health);
  }
  return map;
}

/**
 * One failure, counted. The same Turn failing twice counts once; a Turn after
 * a failing Turn counts up. Answers whether this failure crossed the
 * threshold, so the caller turns the Plugin off exactly once.
 */
export async function recordPluginFailureV1(
  storage: Pick<PluginHealthStorageV1, "get" | "put">,
  input: {
    pluginId: string;
    runId: string;
    phase: PluginFailurePhaseV1;
    message: string;
    now?: Date;
    threshold?: number;
  },
): Promise<{ health: PluginHealthRecordV1; quarantined: boolean }> {
  if (!PLUGIN_ID.test(input.pluginId)) {
    throw new Error(`plugin id "${input.pluginId}" is invalid`);
  }
  const threshold = input.threshold ?? PLUGIN_QUARANTINE_THRESHOLD_V1;
  const at = (input.now ?? new Date()).toISOString();
  const previous = await readPluginHealthV1(storage, input.pluginId);
  const sameTurn = previous?.lastFailure.runId === input.runId;
  const consecutiveFailures = sameTurn
    ? previous.consecutiveFailures
    : (previous?.consecutiveFailures ?? 0) + 1;
  const crossed =
    previous?.quarantinedAt === undefined &&
    !sameTurn &&
    consecutiveFailures >= threshold;
  const health: PluginHealthRecordV1 = {
    schemaVersion: 1,
    pluginId: input.pluginId,
    consecutiveFailures,
    lastFailure: {
      runId: input.runId,
      phase: input.phase,
      message: input.message.slice(0, MAX_MESSAGE),
      at,
    },
    ...(previous?.quarantinedAt !== undefined
      ? { quarantinedAt: previous.quarantinedAt }
      : crossed
        ? { quarantinedAt: at }
        : {}),
  };
  await storage.put(pluginHealthKeyV1(input.pluginId), health);
  return { health, quarantined: crossed };
}

/**
 * A Turn ended. Every Plugin that ran through it without failing is well
 * again; a record whose last failure was this Turn stays, and a quarantined
 * one stays until a person clears it.
 */
export async function settlePluginHealthV1(
  storage: PluginHealthStorageV1,
  input: { runId: string; ran: readonly string[] },
): Promise<string[]> {
  const cleared: string[] = [];
  for (const pluginId of input.ran) {
    const health = await readPluginHealthV1(storage, pluginId);
    if (!health || health.quarantinedAt !== undefined) continue;
    if (health.lastFailure.runId === input.runId) continue;
    await storage.delete(pluginHealthKeyV1(pluginId));
    cleared.push(pluginId);
  }
  return cleared;
}

/** A person switched the Plugin on again: its history starts over. */
export async function clearPluginHealthV1(
  storage: Pick<PluginHealthStorageV1, "delete">,
  pluginId: string,
): Promise<void> {
  await storage.delete(pluginHealthKeyV1(pluginId));
}

/** The words the Plugins page uses for a quarantined Plugin. */
export function pluginQuarantineCopyV1(health: PluginHealthRecordV1): string {
  return `Turned off after ${health.consecutiveFailures} Turns in a row with a failure (last: ${health.lastFailure.message.slice(0, 200)}). Turn it on to try again.`;
}

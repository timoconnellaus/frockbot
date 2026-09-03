/**
 * Durable keys the Bot Durable Object authority owns. Packages that share the
 * object's storage read them through the authority, never by key.
 */
export const RUN_PREFIX = "run:";
export const RUN_INDEX_PREFIX = "run-index:";
export const RUN_ADMISSION_FENCE_PREFIX = "run-admission-fence:";
export const RUN_ADMISSION_FENCE_INDEX_KEY = "run-admission-fences";
export const MAX_RUN_ADMISSION_FENCES = 256;
export const ACTIVE_RUN_KEY = "active-run";
/**
 * The one admitted user-lane Turn waiting for the object to become free.
 *
 * A single slot, not a queue: a second user message supersedes the first
 * waiting one exactly as it supersedes a running one, so the Bot is never
 * working through a backlog of things the User has already replaced.
 */
export const PENDING_RUN_KEY = "pending-run";
export const LATEST_EVENTS_KEY = "latest-events";
export const IDENTITY_KEY = "identity";
export const NOTIFICATION_PREFIX = "notification:";
export const COMPOSITION_CURRENT_KEY = "composition:current";
export const COMPOSITION_GENERATION_PREFIX = "composition:generation:";
export const COMPOSITION_INDEX_PREFIX = "composition:index:";
export const COMPOSITION_LAST_KNOWN_GOOD_KEY = "composition:last-known-good";
export const COMPOSITION_FAILURE_PREFIX = "composition:failure:";
export const COMPOSITION_FAILURE_COUNT_PREFIX = "composition:failure-count:";
export const COMPOSITION_QUARANTINE_PREFIX = "composition:quarantine:";
/** Attempts are zero-padded so the prefix listing is attempt-ordered. */
export const COMPOSITION_FAILURE_ATTEMPT_DIGITS = 4;
export const RECOVERY_ALARM_DELAY_MS = 60_000;
/** The current generation of one durable-root file. */
export const WORKSPACE_GENERATION_PREFIX = "workspace:generation:";
/** Preserved losing writes for one durable-root file. */
export const WORKSPACE_CONFLICT_PREFIX = "workspace:conflict:";
/** One unsettled durable-root sync push intent, by effect id (ADR 0013). */
export const WORKSPACE_SYNC_EFFECT_PREFIX = "workspace:sync-effect:";
/** The monotonic cursor every minted Workspace generation id advances. */
export const WORKSPACE_GENERATION_CURSOR_KEY = "workspace:generation-cursor";
/** Longest readable key tail before it is fingerprinted; Durable Object keys are bounded. */
const WORKSPACE_KEY_TAIL_LIMIT = 900;

function fingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The key tail identifying one file in one durable root. Readable while it
 * fits — a root key plus a relative path — and fingerprinted past that, so a
 * long path can never push a Durable Object key over its bound.
 */
export function workspaceFileKeyTail(rootKey: string, path: string): string {
  const tail = `${rootKey}:${path}`;
  if (tail.length <= WORKSPACE_KEY_TAIL_LIMIT) return tail;
  return `${tail.slice(0, WORKSPACE_KEY_TAIL_LIMIT - 20)}#${fingerprint(tail)}`;
}

export function workspaceGenerationKey(rootKey: string, path: string): string {
  return `${WORKSPACE_GENERATION_PREFIX}${workspaceFileKeyTail(rootKey, path)}`;
}

export function workspaceConflictPrefix(rootKey: string, path: string): string {
  return `${WORKSPACE_CONFLICT_PREFIX}${workspaceFileKeyTail(rootKey, path)}:`;
}

export function workspaceConflictKey(
  rootKey: string,
  path: string,
  generationId: string,
): string {
  return `${workspaceConflictPrefix(rootKey, path)}${generationId}`;
}

export function runIndexKey(acceptedAt: string, runId: string): string {
  return `${RUN_INDEX_PREFIX}${acceptedAt}:${runId}`;
}

export function compositionGenerationKey(generationId: string): string {
  return `${COMPOSITION_GENERATION_PREFIX}${generationId}`;
}

export function compositionIndexKey(
  createdAt: string,
  generationId: string,
): string {
  return `${COMPOSITION_INDEX_PREFIX}${createdAt}:${generationId}`;
}

export function compositionFailurePrefix(generationId: string): string {
  return `${COMPOSITION_FAILURE_PREFIX}${generationId}:`;
}

export function compositionFailureKey(
  generationId: string,
  attempt: number,
): string {
  return `${compositionFailurePrefix(generationId)}${String(attempt).padStart(
    COMPOSITION_FAILURE_ATTEMPT_DIGITS,
    "0",
  )}`;
}

export function compositionFailureCountKey(generationId: string): string {
  return `${COMPOSITION_FAILURE_COUNT_PREFIX}${generationId}`;
}

export function compositionQuarantineKey(generationId: string): string {
  return `${COMPOSITION_QUARANTINE_PREFIX}${generationId}`;
}

export function storedRunAdmissionFences(input: unknown): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > MAX_RUN_ADMISSION_FENCES ||
    input.some(
      (runId) =>
        typeof runId !== "string" || runId.length < 1 || runId.length > 128,
    )
  ) {
    throw new Error("Stored run admission fences are invalid");
  }
  return [...new Set(input)];
}

/**
 * The key one sync push intent is recorded under. The effect id is already a
 * bounded digest minted by the sync, so it is used verbatim.
 */
export function workspaceSyncEffectKey(effectId: string): string {
  return `${WORKSPACE_SYNC_EFFECT_PREFIX}${effectId}`;
}

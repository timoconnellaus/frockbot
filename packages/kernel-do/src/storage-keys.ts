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

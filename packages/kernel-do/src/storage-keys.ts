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
export const RECOVERY_ALARM_DELAY_MS = 60_000;

export function runIndexKey(acceptedAt: string, runId: string): string {
  return `${RUN_INDEX_PREFIX}${acceptedAt}:${runId}`;
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

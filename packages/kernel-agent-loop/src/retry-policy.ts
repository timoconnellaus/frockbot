import type {
  ModelProviderFailureClassV1,
  ModelProviderFailureError,
} from "@frockbot/kernel-contracts";

export const MODEL_RETRY_BACKOFF_BASE_MS_V1 = 500;
export const MODEL_RETRY_BACKOFF_CAP_MS_V1 = 8_000;

export interface ModelRetryPolicyRuntimeV1 {
  now(): number;
  random(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export function defaultModelRetrySleepV1(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Equal-jitter exponential delay; Retry-After is a floor, not silently capped. */
export function modelRetryDelayV1(input: {
  retry: number;
  random: number;
  retryAfterMs?: number;
}): number {
  const ceiling = Math.min(
    MODEL_RETRY_BACKOFF_CAP_MS_V1,
    MODEL_RETRY_BACKOFF_BASE_MS_V1 * 2 ** Math.max(0, input.retry - 1),
  );
  const boundedRandom = Math.min(1, Math.max(0, input.random));
  const jittered = Math.round(ceiling / 2 + (ceiling / 2) * boundedRandom);
  return Math.max(jittered, input.retryAfterMs ?? 0);
}

export function modelFailureMayRetryV1(input: {
  classification: ModelProviderFailureClassV1;
  attempt: number;
}): boolean {
  if (input.classification === "transient") return true;
  return input.classification === "unknown" && input.attempt === 1;
}

/** Undefined means the Turn has too little wall clock left for another try. */
export function nextModelRetryV1(input: {
  failure: ModelProviderFailureError;
  attempt: number;
  deadlineAt: number;
  runtime: Pick<ModelRetryPolicyRuntimeV1, "now" | "random">;
}): { attempt: number; delayMs: number } | undefined {
  if (
    !modelFailureMayRetryV1({
      classification: input.failure.classification,
      attempt: input.attempt,
    })
  ) {
    return undefined;
  }
  const delayMs = modelRetryDelayV1({
    retry: input.attempt,
    random: input.runtime.random(),
    ...(input.failure.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: input.failure.retryAfterMs }),
  });
  return delayMs < input.deadlineAt - input.runtime.now()
    ? { attempt: input.attempt + 1, delayMs }
    : undefined;
}

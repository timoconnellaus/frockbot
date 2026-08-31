// Composition fails closed. A generation that fails to resolve, mount, or pass
// its declared checks leaves the last known-good generation resident and
// records a durable, visible, repairable failure; a generation that fails to
// activate three consecutive times is quarantined until a User acts.
//
// The kernel owns the algorithm and the record shapes. The Durable Object owns
// the storage (`CompositionFailureLog`) and the Package owns the host that
// mounts, so this module is the only place the ordering lives.
import type {
  CompositionGenerationV1,
  MountedComposition,
} from "./generation.ts";

/**
 * Where activation gave up. The plan enumerates three distinct load sites and
 * only the last is observable as a rejected promise in a predictable place:
 * `resolve` is the artifact read (R2), `mount` is `LOADER.get` and the first
 * RPC into the loaded Worker, `health` is a mounted isolate that answered but
 * failed its declared check. `bundle` is the authoring-time site.
 */
export type CompositionFailurePhaseV1 =
  "resolve" | "bundle" | "mount" | "health";

export const COMPOSITION_FAILURE_PHASES_V1: readonly CompositionFailurePhaseV1[] =
  ["resolve", "bundle", "mount", "health"];

export interface CompositionFailureV1 {
  generationId: string;
  /** Which consecutive attempt this was; assigned by the log, never the caller. */
  attempt: number;
  at: string;
  phase: CompositionFailurePhaseV1;
  message: string;
  diagnostics: string[];
}

/** What a caller knows: the attempt number belongs to the durable authority. */
export type CompositionFailureInputV1 = Omit<CompositionFailureV1, "attempt">;

export interface CompositionQuarantineV1 {
  generationId: string;
  quarantinedAt: string;
  reason: string;
  failures: number;
}

export interface CompositionFailureOutcomeV1 {
  consecutiveFailures: number;
  quarantined: boolean;
}

/** The Durable Object implements this; the kernel only declares it. */
export interface CompositionFailureLog {
  record(
    failure: CompositionFailureInputV1,
  ): Promise<CompositionFailureOutcomeV1>;
  list(generationId: string): Promise<CompositionFailureV1[]>;
  quarantine(
    generationId: string,
  ): Promise<CompositionQuarantineV1 | undefined>;
  /** A generation that finally activates starts its consecutive count over. */
  clear(generationId: string): Promise<void>;
}

/** Three consecutive failures quarantine a generation. */
export const COMPOSITION_QUARANTINE_THRESHOLD = 3;
export const MAX_COMPOSITION_DIAGNOSTICS_V1 = 32;
export const MAX_COMPOSITION_DIAGNOSTIC_LENGTH_V1 = 2_000;
export const MAX_COMPOSITION_FAILURE_MESSAGE_V1 = 2_000;
export const MAX_COMPOSITION_FAILURE_ATTEMPTS_V1 = 1_000;

function failureRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function failureText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function failureTimestamp(value: unknown, label: string): string {
  const candidate = failureText(value, label, 64);
  if (!Number.isFinite(Date.parse(candidate))) {
    throw new Error(`${label} must be a timestamp`);
  }
  return candidate;
}

function failureDiagnostics(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_COMPOSITION_DIAGNOSTICS_V1) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) =>
    failureText(
      entry,
      `${label}[${index}]`,
      MAX_COMPOSITION_DIAGNOSTIC_LENGTH_V1,
    ),
  );
}

/** The exact v1 decoder for a durable Composition failure record. */
export function decodeCompositionFailureV1(
  input: unknown,
): CompositionFailureV1 {
  const label = "composition failure";
  const value = failureRecord(input, label);
  const keys = [
    "generationId",
    "attempt",
    "at",
    "phase",
    "message",
    "diagnostics",
  ];
  if (
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => keys.includes(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  const phase = COMPOSITION_FAILURE_PHASES_V1.find(
    (candidate) => candidate === value.phase,
  );
  if (!phase) throw new Error(`${label}.phase is invalid`);
  if (
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.attempt as number) > MAX_COMPOSITION_FAILURE_ATTEMPTS_V1
  ) {
    throw new Error(`${label}.attempt is invalid`);
  }
  return {
    generationId: failureText(value.generationId, `${label}.generationId`, 256),
    attempt: value.attempt as number,
    at: failureTimestamp(value.at, `${label}.at`),
    phase,
    message: failureText(
      value.message,
      `${label}.message`,
      MAX_COMPOSITION_FAILURE_MESSAGE_V1,
    ),
    diagnostics: failureDiagnostics(value.diagnostics, `${label}.diagnostics`),
  };
}

/** The exact v1 decoder for a durable quarantine record. */
export function decodeCompositionQuarantineV1(
  input: unknown,
): CompositionQuarantineV1 {
  const label = "composition quarantine";
  const value = failureRecord(input, label);
  const keys = ["generationId", "quarantinedAt", "reason", "failures"];
  if (
    !keys.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => keys.includes(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  if (
    !Number.isSafeInteger(value.failures) ||
    (value.failures as number) < COMPOSITION_QUARANTINE_THRESHOLD
  ) {
    throw new Error(`${label}.failures is invalid`);
  }
  return {
    generationId: failureText(value.generationId, `${label}.generationId`, 256),
    quarantinedAt: failureTimestamp(
      value.quarantinedAt,
      `${label}.quarantinedAt`,
    ),
    reason: failureText(
      value.reason,
      `${label}.reason`,
      MAX_COMPOSITION_FAILURE_MESSAGE_V1,
    ),
    failures: value.failures as number,
  };
}

/**
 * A mount or verification failure that names the load site it came from, so
 * the recorded `phase` is evidence rather than a guess.
 */
export class CompositionMountFailureError extends Error {
  readonly phase: CompositionFailurePhaseV1;
  readonly diagnostics: string[];

  constructor(
    phase: CompositionFailurePhaseV1,
    message: string,
    diagnostics: readonly string[] = [],
  ) {
    super(message);
    this.name = "CompositionMountFailureError";
    this.phase = phase;
    this.diagnostics = [...diagnostics].slice(
      0,
      MAX_COMPOSITION_DIAGNOSTICS_V1,
    );
  }
}

function bounded(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return bounded(message || "Composition activation failed", 2_000);
}

/** Classifies an activation error into the durable failure it records. */
export function compositionFailureFromErrorV1(
  generationId: string,
  error: unknown,
  at: string,
): CompositionFailureInputV1 {
  const phase =
    error instanceof CompositionMountFailureError ? error.phase : "mount";
  const diagnostics =
    error instanceof CompositionMountFailureError
      ? error.diagnostics.map((entry) =>
          bounded(entry, MAX_COMPOSITION_DIAGNOSTIC_LENGTH_V1),
        )
      : [];
  return { generationId, at, phase, message: errorMessage(error), diagnostics };
}

/** The narrow slice of `CompositionStore` activation needs. */
export interface CompositionActivationStore {
  read(generationId: string): Promise<CompositionGenerationV1 | undefined>;
  lastKnownGood(): Promise<CompositionGenerationV1>;
  commit(generationId: string): Promise<void>;
  /** Marks a generation `failed`, or `quarantined` on its third failure. */
  fail(generationId: string, options: { quarantined: boolean }): Promise<void>;
}

/** The mount half of `CompositionHost`, kept generic so a Package host's own
 *  mounted type survives activation. */
export interface CompositionMountHost<Mounted extends MountedComposition> {
  mount(
    generation: CompositionGenerationV1,
    signal: AbortSignal,
  ): Promise<Mounted>;
}

export type CompositionActivationV1<
  Mounted extends MountedComposition = MountedComposition,
> =
  | {
      status: "activated";
      generation: CompositionGenerationV1;
      mounted: Mounted;
    }
  | {
      status: "failed-closed";
      /** Absent when the pinned generation could not even be resolved. */
      generation?: CompositionGenerationV1;
      /** The last known-good generation the Turn is admitted on instead. */
      fallback: CompositionGenerationV1;
      mounted: Mounted;
      failure?: CompositionFailureV1;
      quarantined: boolean;
    };

export interface ActivateCompositionInputV1<
  Mounted extends MountedComposition = MountedComposition,
> {
  /** The generation this Turn pinned at admission. */
  generationId: string;
  store: CompositionActivationStore;
  failures: CompositionFailureLog;
  host: CompositionMountHost<Mounted>;
  signal: AbortSignal;
  now?(): Date;
  /**
   * Raises the visible failure. Called after the failure and the generation
   * status are durable, so a notification never outruns its record.
   */
  onFailure?(
    failure: CompositionFailureV1,
    fallback: CompositionGenerationV1,
  ): Promise<void>;
}

async function mountAndVerify<Mounted extends MountedComposition>(
  host: CompositionMountHost<Mounted>,
  generation: CompositionGenerationV1,
  signal: AbortSignal,
): Promise<Mounted> {
  const mounted = await host.mount(generation, signal);
  try {
    await mounted.verify(signal);
  } catch (error) {
    await mounted.dispose();
    throw error;
  }
  return mounted;
}

/**
 * Activation at the next admitted Turn: read the pin, mount, verify, and on
 * success commit and record the new last known good. On failure record the
 * durable failure, mark the generation `failed` (or `quarantined` on its third
 * consecutive failure), mount the last known good, raise the visible failure,
 * and admit the Turn anyway on that last known good.
 */
export async function activateCompositionV1<Mounted extends MountedComposition>(
  input: ActivateCompositionInputV1<Mounted>,
): Promise<CompositionActivationV1<Mounted>> {
  const now = input.now ?? (() => new Date());
  const pinned = await input.store.read(input.generationId);

  if (pinned && pinned.status === "quarantined") {
    // Never retried until a User acts: no new attempt, no new failure record.
    const fallback = await input.store.lastKnownGood();
    const mounted = await mountAndVerify(input.host, fallback, input.signal);
    const recorded = await input.failures.list(pinned.generationId);
    return {
      status: "failed-closed",
      generation: pinned,
      fallback,
      mounted,
      quarantined: true,
      ...(recorded.length > 0
        ? { failure: recorded[recorded.length - 1]! }
        : {}),
    };
  }

  let failureInput: CompositionFailureInputV1;
  if (!pinned) {
    failureInput = {
      generationId: input.generationId,
      at: now().toISOString(),
      phase: "resolve",
      message: `composition generation "${input.generationId}" is unknown`,
      diagnostics: [],
    };
  } else {
    try {
      const mounted = await mountAndVerify(input.host, pinned, input.signal);
      if (pinned.status !== "active") {
        await input.store.commit(pinned.generationId);
      }
      await input.failures.clear(pinned.generationId);
      return { status: "activated", generation: pinned, mounted };
    } catch (error) {
      const attempted = compositionFailureFromErrorV1(
        pinned.generationId,
        error,
        now().toISOString(),
      );
      /**
       * Every attempt is counted before anything is rethrown: an activation
       * that only ever throws would otherwise never reach the quarantine
       * threshold and would leave no durable trace of why. A generation that
       * is `active` is the one still running and is never marked failed, so
       * only the counter and the quarantine record move for it.
       */
      const recordAttempt = async (): Promise<void> => {
        const outcome = await input.failures.record(attempted);
        if (pinned.status !== "active") {
          await input.store.fail(pinned.generationId, {
            quarantined: outcome.quarantined,
          });
        }
      };
      if (input.signal.aborted) {
        // Cancellation raced the mount. The attempt still happened, so it is
        // recorded before the abort propagates.
        await recordAttempt();
        input.signal.throwIfAborted();
      }
      const lastKnownGood = await input.store.lastKnownGood();
      // Nothing better exists: the last known good *is* what failed, so there
      // is no closed state to fail into and the Turn cannot be admitted. The
      // failure is recorded and counted first, so repeated failures of a
      // pinned last known good still quarantine it visibly.
      if (lastKnownGood.generationId === pinned.generationId) {
        await recordAttempt();
        throw error;
      }
      failureInput = attempted;
    }
  }

  const outcome = await input.failures.record(failureInput);
  const failure = decodeCompositionFailureV1({
    ...failureInput,
    attempt: outcome.consecutiveFailures,
  });
  await input.store.fail(failureInput.generationId, {
    quarantined: outcome.quarantined,
  });
  const fallback = await input.store.lastKnownGood();
  const mounted = await mountAndVerify(input.host, fallback, input.signal);
  await input.onFailure?.(failure, fallback);
  return {
    status: "failed-closed",
    ...(pinned ? { generation: pinned } : {}),
    fallback,
    mounted,
    failure,
    quarantined: outcome.quarantined,
  };
}

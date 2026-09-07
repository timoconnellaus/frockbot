import type {
  ComputerProgressViewV1,
  ComputerProjectionV1,
} from "../protocol.js";

/** The midpoint of the measured two-to-three-minute cold setup expectation. */
export const COLD_PROVISION_PROGRESS_BUDGET_MS = 150_000;

/** Updates are small, in-place installs and must not imply a cold-setup wait. */
export const UPDATE_PROGRESS_BUDGET_MS = 30_000;

export type ComputerProgressRunKind =
  "cold-provision" | "resumed-provision" | "update" | "warm-wake";

export type ComputerProgressProjection = Pick<
  ComputerProjectionV1,
  "phase" | "progress"
>;

export interface ComputerProgressFrame {
  runKind: ComputerProgressRunKind;
  /** Present only when durable state provides a real phase position. */
  fraction?: number;
  /** The boundary of the next durable phase; easing cannot pass it. */
  nextBoundary?: number;
  /** Remaining presentational travel time to the next boundary. */
  remainingMs?: number;
}

export interface ComputerProgressFractionInput {
  projection: ComputerProgressProjection;
  /** Elapsed time since progress.startedAt, supplied by the rendering clock. */
  elapsedMs: number;
}

interface ProgressBounds {
  floor: number;
  nextBoundary: number;
  timingStart: number;
  timingSpan: number;
  phaseCount: number;
}

function ordinal(index: number): number {
  return Math.max(1, index);
}

function progressBounds(progress: ComputerProgressViewV1): ProgressBounds {
  const outerOrdinal = ordinal(progress.index);
  const outerFloor = (outerOrdinal - 1) / progress.total;
  const outerSpan = 1 / progress.total;
  const provisioning = progress.provisioning;

  if (!provisioning) {
    return {
      floor: outerFloor,
      nextBoundary: outerFloor + outerSpan,
      timingStart: 0,
      timingSpan: 1,
      phaseCount: progress.total,
    };
  }

  const provisioningOrdinal = ordinal(provisioning.index);
  const phaseSpan = outerSpan / provisioning.total;
  return {
    floor: outerFloor + (provisioningOrdinal - 1) * phaseSpan,
    nextBoundary: outerFloor + provisioningOrdinal * phaseSpan,
    timingStart: outerFloor,
    timingSpan: outerSpan,
    phaseCount: provisioning.total,
  };
}

function elapsedInCurrentPhase(
  progress: ComputerProgressViewV1,
  elapsedMs: number,
): number {
  const startedAt = Date.parse(progress.startedAt);
  const updatedAt = Date.parse(progress.updatedAt);
  const phaseStartedAfter = Math.max(0, updatedAt - startedAt);
  return Math.max(0, elapsedMs - phaseStartedAfter);
}

export function computerProgressRunKind(
  projection: ComputerProgressProjection,
): ComputerProgressRunKind {
  const progress = projection.progress;
  const provisioning = progress?.provisioning;
  if (
    projection.phase === "updating" ||
    progress?.kind === "update" ||
    provisioning?.kind === "update"
  ) {
    return "update";
  }
  if (provisioning?.kind === "provision") {
    return provisioning.resumed ? "resumed-provision" : "cold-provision";
  }
  return "warm-wake";
}

/**
 * Projects durable phase truth into one presentational frame.
 *
 * The durable floor always wins. Time advances only inside the current real
 * phase, and a run-wide time baseline prevents a refreshed projection for the
 * same phase from moving the fill backwards. Neither path can cross the next
 * durable boundary.
 */
export function computerProgressFrame({
  projection,
  elapsedMs,
}: ComputerProgressFractionInput): ComputerProgressFrame {
  const runKind = computerProgressRunKind(projection);
  if (projection.phase === "ready") {
    return { runKind, fraction: 1, nextBoundary: 1, remainingMs: 0 };
  }

  const progress = projection.progress;
  if (!progress || runKind === "warm-wake") return { runKind };

  const budgetMs =
    runKind === "update"
      ? UPDATE_PROGRESS_BUDGET_MS
      : COLD_PROVISION_PROGRESS_BUDGET_MS;
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const bounds = progressBounds(progress);
  const phaseBudgetMs = budgetMs / bounds.phaseCount;
  const phaseElapsedMs = elapsedInCurrentPhase(progress, elapsed);
  const phaseTimedFraction =
    bounds.floor +
    ((bounds.nextBoundary - bounds.floor) * phaseElapsedMs) / phaseBudgetMs;
  const runTimedFraction =
    bounds.timingStart + (bounds.timingSpan * elapsed) / budgetMs;
  const fraction = Math.min(
    bounds.nextBoundary,
    Math.max(bounds.floor, phaseTimedFraction, runTimedFraction),
  );

  const phaseRemainingMs = Math.max(0, phaseBudgetMs - phaseElapsedMs);
  const runBoundaryElapsedMs =
    ((bounds.nextBoundary - bounds.timingStart) / bounds.timingSpan) * budgetMs;
  const runRemainingMs = Math.max(0, runBoundaryElapsedMs - elapsed);

  return {
    runKind,
    fraction,
    nextBoundary: bounds.nextBoundary,
    remainingMs:
      fraction === bounds.nextBoundary
        ? 0
        : Math.round(Math.min(phaseRemainingMs, runRemainingMs)),
  };
}

/** Pure `{ durable projection, elapsed ms } -> fraction` test seam. */
export function computerProgressFraction(
  input: ComputerProgressFractionInput,
): number | undefined {
  return computerProgressFrame(input).fraction;
}

export function computerProgressElapsedMs(
  progress: ComputerProgressViewV1 | undefined,
  nowMs: number,
): number {
  if (!progress) return 0;
  const startedAt = Date.parse(progress.startedAt);
  return Number.isFinite(startedAt) ? Math.max(0, nowMs - startedAt) : 0;
}

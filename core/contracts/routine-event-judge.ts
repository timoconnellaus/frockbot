// A connected-app event, classified before the conversational model.
//
// This is not Turn supervision. `TurnSupervisor.startTurn` runs after a Turn
// is admitted; the inbox rejector must run before that, or a miss still
// occupies the Bot with a Turn identity, a cue, and the one-run lock.
//
// Two labels only. Only `clearly_unrelated` may skip. Anything else — including
// a judge that cannot answer — is a Turn we were going to pay anyway.

export const ROUTINE_EVENT_VERDICTS_V1 = [
  "clearly_unrelated",
  "is_or_might_be",
] as const;

export type RoutineEventVerdictV1 = (typeof ROUTINE_EVENT_VERDICTS_V1)[number];

/**
 * The standalone message a connected-app event carries. No Gmail thread, no
 * FrockBot chat, no raw provider `payload` object.
 */
export interface RoutineEventPayloadV1 {
  subject?: string;
  sender?: string;
  to?: string;
  snippet?: string;
  labels?: string[];
}

export interface RoutineEventEvidenceV1 {
  eventId: string;
  fireId: string;
  routineName: string;
  prompt: string;
  triggerType: string;
  payload: RoutineEventPayloadV1;
}

export interface RoutineEventJudgeV1 {
  classify(
    evidence: RoutineEventEvidenceV1,
    signal?: AbortSignal,
  ): Promise<RoutineEventVerdictV1>;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/**
 * The test and development adapter. It always keeps the event so the drain
 * can be exercised without Jev. Production mounts this until the hosted
 * adapter lands.
 */
export function createFakeRoutineEventJudgeV1(options?: {
  classify?: RoutineEventJudgeV1["classify"];
}): RoutineEventJudgeV1 {
  return {
    async classify(evidence, signal) {
      throwIfAborted(signal);
      if (options?.classify) return options.classify(evidence, signal);
      return "is_or_might_be";
    },
  };
}

/**
 * The adapter mounted when the judge is known to be down.
 *
 * It never returns `clearly_unrelated`. A miss is a Turn, not a drop.
 */
export function createUnavailableRoutineEventJudgeV1(): RoutineEventJudgeV1 {
  return {
    async classify(_evidence, signal) {
      throwIfAborted(signal);
      return "is_or_might_be";
    },
  };
}

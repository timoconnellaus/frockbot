import {
  noul,
  type JsonValue,
  type SystemOneResult,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";
import type {
  LoopActionV1,
  LoopSignalV1,
  ProgressDecisionV1,
  ProgressEvidenceV1,
} from "@frockbot/core/contracts";
import {
  RESPONSE_REVIEW_EVAL_BUDGET_V1,
  RESPONSE_REVIEW_MODEL_V1,
  type JevCallBudgetV1,
  type JevReviewV1,
} from "./response-review.js";

// Whether a long Turn is still getting anywhere. Code counts what it can —
// the same call made again, errors in a row — and says when to ask; Jev
// judges whether the latest steps moved the work; `composeProgressDecisionV1`
// decides. Tuning is a change here plus `bun run eval:response-review`.

/** No Turn is checked before this step: most finish well inside it. */
export const PROGRESS_FIRST_STEP_V1 = 5;

/** Steps between checks while code sees nothing wrong. */
export const PROGRESS_EVERY_V1 = 4;

/** Steps between checks once code sees a loop signal. */
export const PROGRESS_SIGNALLED_EVERY_V1 = 2;

/** The same call, with the same arguments, this many times is a signal. */
export const PROGRESS_REPEATED_CALL_V1 = 3;

/** This many failed results in a row is a signal. */
export const PROGRESS_REPEATED_ERROR_V1 = 3;

/** The Noul at or below which the Turn is stuck. */
export const PROGRESS_STUCK_NO_V1 = 0.25;

/** With a code signal, the Noul at or below which the Turn is stuck. */
export const PROGRESS_SIGNALLED_STUCK_NO_V1 = 0.45;

/** The latest calls Jev is shown. */
export const PROGRESS_ACTIONS_MAX_V1 = 8;

const PROGRESS_TEXT_CHARS_V1 = 240;

function clip(text: string): string {
  return text.length <= PROGRESS_TEXT_CHARS_V1
    ? text
    : `${text.slice(0, PROGRESS_TEXT_CHARS_V1)}…`;
}

/** A call as code compares it: the tool and exactly what it was given. */
export interface LoopCallV1 {
  readonly tool: string;
  readonly input: string;
  readonly isError: boolean;
}

/** What code sees wrong in a Turn's calls, oldest first. */
export function loopSignalsV1(calls: readonly LoopCallV1[]): LoopSignalV1[] {
  const signals: LoopSignalV1[] = [];
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = `${call.tool}\u0000${call.input}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if ([...counts.values()].some((n) => n >= PROGRESS_REPEATED_CALL_V1)) {
    signals.push("repeated_call");
  }
  const tail = calls.slice(-PROGRESS_REPEATED_ERROR_V1);
  if (
    tail.length === PROGRESS_REPEATED_ERROR_V1 &&
    tail.every((call) => call.isError)
  ) {
    signals.push("repeated_error");
  }
  return signals;
}

/**
 * Whether to ask before `step`, given the last step that was asked about
 * (none yet: 0) and what code sees.
 */
export function progressCheckDueV1(input: {
  readonly step: number;
  readonly lastChecked: number;
  readonly signals: readonly LoopSignalV1[];
}): boolean {
  if (input.step < PROGRESS_FIRST_STEP_V1) return false;
  if (input.lastChecked === 0) return true;
  const gap = input.step - input.lastChecked;
  return input.signals.length > 0
    ? gap >= PROGRESS_SIGNALLED_EVERY_V1
    : gap >= PROGRESS_EVERY_V1;
}

export function progressStateV1(
  evidence: ProgressEvidenceV1,
): Record<string, JsonValue> {
  return {
    request: { text: clip(evidence.objective), origin: evidence.origin },
    stepsSoFar: evidence.step - 1,
    latestActions: evidence.actions
      .slice(-PROGRESS_ACTIONS_MAX_V1)
      .map((action: LoopActionV1) => ({
        tool: action.tool,
        arguments: clip(action.arguments),
        outcome: action.isError ? "failed" : "done",
        result: clip(action.result),
      })),
  };
}

export const progressQuestionsV1 = {
  progressing: noul(
    {
      target: "`latestActions`, the Bot's most recent calls, oldest first",
      decision:
        "Are these steps moving the work toward what `request.text` asks for?",
      requirements: [
        "The later results give something the earlier ones did not: new information, a problem fixed, a part of the work finished",
        "It is not making the same call again and getting the same result, or retrying what failed without changing anything",
      ],
    },
    {
      true: "The work is moving forward",
      false:
        "It is going in circles: repeating calls, retrying the same failure, or getting nowhere",
    },
  ),
} as const;

export type ProgressAnswersV1 = SystemOneResult<
  typeof progressQuestionsV1
>["answers"];
export type ProgressReviewV1 = JevReviewV1<ProgressAnswersV1>;

export async function reviewProgressV1(
  client: TypeSafeClient,
  evidence: ProgressEvidenceV1,
  options: {
    readonly signal?: AbortSignal;
    readonly budget?: JevCallBudgetV1;
  } = {},
): Promise<ProgressReviewV1> {
  const budget = options.budget ?? RESPONSE_REVIEW_EVAL_BUDGET_V1;
  const { data, requestId } = await client
    .systemOne(
      {
        state: progressStateV1(evidence),
        questions: progressQuestionsV1,
        model: RESPONSE_REVIEW_MODEL_V1,
      },
      { retry: budget.retry, timeout: budget.timeout, signal: options.signal },
    )
    .withResponse();
  return {
    model: data.model,
    usage: data.usage,
    requestId,
    answers: data.answers,
  };
}

/** Stuck when Jev says so, more readily when code already saw a loop. */
export function composeProgressDecisionV1(input: {
  readonly answers: ProgressAnswersV1;
  readonly signals: readonly LoopSignalV1[];
  readonly model?: string;
}): ProgressDecisionV1 {
  const progressing = input.answers.progressing.noul;
  const threshold =
    input.signals.length > 0
      ? PROGRESS_SIGNALLED_STUCK_NO_V1
      : PROGRESS_STUCK_NO_V1;
  return {
    stuck: progressing <= threshold,
    signals: [...input.signals],
    judgments: [{ question: "progressing", value: progressing }],
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

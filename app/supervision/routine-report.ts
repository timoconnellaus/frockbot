import {
  noul,
  score,
  type JsonValue,
  type TypeSafeClient,
} from "@typesafe-ai/sdk";
import { hostedJevClientV1 } from "./jev.js";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";

// Whether a Routine's report is worth telling the person, and how soon. Jev
// judges; `routineReportVerdictV1` decides. A report nobody needs stays in the
// Routine's log and opens no Turn; one that can wait arrives without a push.
// A judgment that fails delivers as before: telling someone is the safe side.

/** Below this, a report is judged nothing the person would want. */
export const ROUTINE_REPORT_WORTH_NO_V1 = 0.2;

/** Below this urgency, a delivery lands unread and wakes no device. */
export const ROUTINE_REPORT_QUIET_BELOW_V1 = 0.8;

export const ROUTINE_REPORT_TIMEOUT_MS_V1 = 5_000;

export interface RoutineReportV1 {
  /** The Routine's name, as the person set it up. */
  readonly routine: string;
  /** What the firing handed off. */
  readonly report: string;
}

export interface RoutineReportVerdictV1 {
  readonly tell: boolean;
  readonly quiet: boolean;
  readonly worth: number;
  readonly urgency: number;
}

export type RoutineReportJudgeV1 = (
  report: RoutineReportV1,
  signal?: AbortSignal,
) => Promise<RoutineReportVerdictV1 | undefined>;

export function routineReportStateV1(
  report: RoutineReportV1,
): Record<string, JsonValue> {
  return {
    routine: report.routine.slice(0, 200),
    report:
      report.report.length <= 2_000
        ? report.report
        : `${report.report.slice(0, 2_000)}…`,
  };
}

export const routineReportQuestionsV1 = {
  worthTelling: noul(
    {
      target: "`report`, what the Routine called `routine` found this time",
      decision:
        "Did this firing find something the person would want to be told about?",
      requirements: [
        "It found what the Routine watches for, or something new, changed or due",
        "A report that nothing was found or nothing changed counts only when `routine` asks for a status every time, such as a daily summary",
      ],
    },
    {
      true: "It found something they would want to hear",
      false:
        "Nothing to report: nothing found, nothing new, a check that passed",
    },
  ),
  urgency: score(
    {
      target: "`report`",
      decision: "How soon does the person need to know?",
      rule: "Judge what the report says, not how it is worded.",
    },
    [
      "It can wait until they next look",
      "Worth knowing today",
      "They should know within the hour",
      "They need to know now",
    ] as const,
  ),
} as const;

export function routineReportVerdictV1(answers: {
  worthTelling: { noul: number };
  urgency: { score: number };
}): RoutineReportVerdictV1 {
  const worth = answers.worthTelling.noul;
  const urgency = answers.urgency.score;
  return {
    tell: worth >= ROUTINE_REPORT_WORTH_NO_V1,
    quiet: urgency < ROUTINE_REPORT_QUIET_BELOW_V1,
    worth,
    urgency,
  };
}

export function createJevRoutineReportJudgeV1(
  client: TypeSafeClient,
): RoutineReportJudgeV1 {
  return async (report, signal) => {
    try {
      const { answers } = await client.systemOne(
        {
          state: routineReportStateV1(report),
          questions: routineReportQuestionsV1,
          model: RESPONSE_REVIEW_MODEL_V1,
        },
        {
          retry: { maxRetries: 1 },
          timeout: ROUTINE_REPORT_TIMEOUT_MS_V1,
          ...(signal ? { signal } : {}),
        },
      );
      return routineReportVerdictV1(answers);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return undefined;
    }
  };
}

/** The deployment's judge, or none: every report is then delivered as before. */
export function createHostedRoutineReportJudgeV1(
  env: Record<string, string | undefined>,
): RoutineReportJudgeV1 | undefined {
  const client = hostedJevClientV1(env);
  return client ? createJevRoutineReportJudgeV1(client) : undefined;
}

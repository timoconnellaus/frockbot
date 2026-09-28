// Asking Jev the same question more than once. A case that passes once can
// still sit on a threshold and flip on the next call: the incident on
// 2026-09-27 refused and then allowed the same `gmail/list_threads` call five
// steps apart. These helpers say, per case, whether its decision held across
// repeats and how close each judgment came to the threshold code acts on.

/** How many times each case is asked: `EVAL_REPEAT`, at least one. */
export function evalRepeatV1(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.EVAL_REPEAT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 1 ? Math.min(parsed, 20) : 1;
}

/**
 * Whether a case is run: `EVAL_ONLY` matches its name or set by substring,
 * comma-separated; absent, every case runs.
 */
export function evalSelectedV1(
  env: Record<string, string | undefined>,
  fixture: { readonly name: string; readonly set?: string },
): boolean {
  const only = (env.EVAL_ONLY ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (only.length === 0) return true;
  return only.some(
    (part) => fixture.name.includes(part) || (fixture.set ?? "").includes(part),
  );
}

type Answer = {
  readonly noul?: number;
  readonly score?: number;
  readonly choice?: string;
  readonly probabilities?: Readonly<Record<string, number>>;
};

export interface QuestionSpreadV1 {
  /** The number each repeat produced: a noul, a score, or the chosen label's probability. */
  readonly values: readonly number[];
  readonly min: number;
  readonly max: number;
  /** For a choice, how often each label was chosen. */
  readonly choices?: Readonly<Record<string, number>>;
  /** The threshold code acts on, when the runner named one. */
  readonly threshold?: number;
  /** The smallest distance of any repeat from the threshold. */
  readonly margin?: number;
  /** Whether the repeats fell on both sides of the threshold. */
  readonly crosses?: boolean;
}

function valueOf(answer: Answer): number | undefined {
  if (typeof answer.noul === "number") return answer.noul;
  if (typeof answer.score === "number") return answer.score;
  if (typeof answer.choice === "string")
    return answer.probabilities?.[answer.choice] ?? 0;
  return undefined;
}

/** Per question, how the repeats' answers spread, and against which threshold. */
export function answerSpreadV1(
  answers: readonly Readonly<Record<string, unknown>>[],
  thresholds: Readonly<Record<string, number>> = {},
): Record<string, QuestionSpreadV1> {
  const questions = new Set(answers.flatMap((answer) => Object.keys(answer)));
  const spread: Record<string, QuestionSpreadV1> = {};
  for (const question of questions) {
    const each = answers
      .map((answer) => answer[question] as Answer | undefined)
      .filter((answer): answer is Answer => answer !== undefined);
    const values = each.flatMap((answer) => {
      const value = valueOf(answer);
      return value === undefined ? [] : [Math.round(value * 1000) / 1000];
    });
    if (values.length === 0) continue;
    const labels = each.flatMap((answer) =>
      typeof answer.choice === "string" ? [answer.choice] : [],
    );
    const threshold = thresholds[question];
    const min = Math.min(...values);
    const max = Math.max(...values);
    spread[question] = {
      values,
      min,
      max,
      ...(labels.length > 0
        ? {
            choices: Object.fromEntries(
              [...new Set(labels)].map((label) => [
                label,
                labels.filter((chosen) => chosen === label).length,
              ]),
            ),
          }
        : {}),
      ...(threshold === undefined
        ? {}
        : {
            threshold,
            margin:
              Math.round(
                Math.min(
                  ...values.map((value) => Math.abs(value - threshold)),
                ) * 1000,
              ) / 1000,
            crosses: min < threshold && max >= threshold,
          }),
    };
  }
  return spread;
}

export interface RepeatSummaryV1 {
  readonly runs: number;
  readonly passed: number;
  /** The decisions the repeats reached, each with how many reached it. */
  readonly decisions: Readonly<Record<string, number>>;
  /** Whether the repeats disagreed on the decision. */
  readonly flipped: boolean;
  readonly spread: Record<string, QuestionSpreadV1>;
}

export function repeatSummaryV1(
  runs: readonly {
    readonly passed: boolean;
    readonly decision?: string;
    readonly answers?: Readonly<Record<string, unknown>>;
  }[],
  thresholds: Readonly<Record<string, number>> = {},
): RepeatSummaryV1 {
  const decisions: Record<string, number> = {};
  for (const run of runs) {
    const decision = run.decision ?? (run.passed ? "pass" : "fail");
    decisions[decision] = (decisions[decision] ?? 0) + 1;
  }
  return {
    runs: runs.length,
    passed: runs.filter((run) => run.passed).length,
    decisions,
    flipped: Object.keys(decisions).length > 1,
    spread: answerSpreadV1(
      runs.flatMap((run) => (run.answers ? [run.answers] : [])),
      thresholds,
    ),
  };
}

/** One console line for a repeated case: how often it passed, and what moved. */
export function repeatLineV1(summary: RepeatSummaryV1): string {
  const decisions = Object.entries(summary.decisions)
    .map(([decision, count]) => `${decision}×${count}`)
    .join(" ");
  const near = Object.entries(summary.spread)
    .filter(([, spread]) => spread.crosses || (spread.margin ?? 1) < 0.05)
    .map(
      ([question, spread]) =>
        `${question} ${spread.min}–${spread.max} vs ${spread.threshold}${spread.crosses ? " (crosses)" : ""}`,
    );
  return `  ${summary.passed}/${summary.runs} passed; ${decisions}${summary.flipped ? " FLIPPED" : ""}${near.length > 0 ? `; near threshold: ${near.join(", ")}` : ""}`;
}

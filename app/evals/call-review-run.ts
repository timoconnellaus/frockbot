import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { callReviewFixturesV1 } from "./call-review.fixtures.js";
import { callReviewReportCaseV1, gradeCallReviewV1 } from "./call-review.js";
import { describeFailureV1 } from "./failure.js";
import {
  RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
  RESPONSE_REVIEW_RETRY_V1,
  RESPONSE_REVIEW_RUN_TIMEOUT_MS_V1,
} from "../supervision/response-review.js";
import {
  CALL_REVIEW_ARGUMENTS_YES_V1,
  CALL_REVIEW_IMPLIED_CONSEQUENCE_MAX_V1,
  CALL_REVIEW_INSTRUCTS_REVIEWER_YES_V1,
  CALL_REVIEW_MODEL_V1,
  reviewCallV1,
} from "../supervision/call-review.js";

/** Configuration the eval cannot run without. Reported, never graded. */
class CallReviewSetupError extends Error {}

/**
 * Production names the credential `JEV_API_KEY`. `TYPESAFE_API_KEY` remains a
 * local alias. The key is passed explicitly and never printed.
 */
function callReviewClientV1(env: Record<string, string | undefined>) {
  const apiKey = (env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey)
    throw new CallReviewSetupError(
      "Set JEV_API_KEY, or TYPESAFE_API_KEY, in the main checkout's .dev.vars",
    );
  try {
    return new TypeSafeClient({
      apiKey,
      defaultModel: CALL_REVIEW_MODEL_V1,
      retry: RESPONSE_REVIEW_RETRY_V1,
      timeout: RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
      // `debug` logs request bodies, which are conversation evidence.
      logLevel: "off",
    });
  } catch (error) {
    throw new CallReviewSetupError(
      `TypeSafe client setup failed: ${describeFailureV1(error).message}`,
    );
  }
}

const sourceHash = async (relative: string) =>
  createHash("sha256")
    .update(await Bun.file(new URL(relative, import.meta.url)).text())
    .digest("hex");

async function runCallReviewEvalV1() {
  const client = callReviewClientV1(process.env);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  // One pass, one call per case, no repetition: a rerun is a deliberate act.
  const signal = AbortSignal.timeout(RESPONSE_REVIEW_RUN_TIMEOUT_MS_V1);
  const cases = [];
  for (const fixture of callReviewFixturesV1) {
    const started = performance.now();
    let entry;
    try {
      const review = await reviewCallV1(client, fixture.evidence, { signal });
      entry = callReviewReportCaseV1(fixture, {
        review,
        checks: gradeCallReviewV1(fixture, review),
      });
    } catch (error) {
      entry = callReviewReportCaseV1(fixture, { failure: error });
    }
    const elapsedMs = Math.round(performance.now() - started);
    cases.push({ ...entry, elapsedMs });
    console.log(
      `${entry.passed ? "PASS" : "FAIL"} ${fixture.name} (${elapsedMs} ms)`,
    );
    if ("failure" in entry) console.log(`  failure: ${entry.failure.message}`);
    for (const check of "checks" in entry ? entry.checks : [])
      if (!check.passed)
        console.log(
          `  ${check.question}: expected ${check.expected}, got ${check.actual}`,
        );
  }
  const checks = cases.flatMap((c) => ("checks" in c ? c.checks : []));
  const report = {
    harness: "call-review",
    requestedModel: CALL_REVIEW_MODEL_V1,
    resolvedModels: [
      ...new Set(cases.flatMap((c) => ("model" in c ? [c.model] : []))),
    ],
    retry: RESPONSE_REVIEW_RETRY_V1,
    attemptTimeoutMs: RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
    runTimeoutMs: RESPONSE_REVIEW_RUN_TIMEOUT_MS_V1,
    thresholds: {
      argumentsYes: CALL_REVIEW_ARGUMENTS_YES_V1,
      impliedConsequenceMax: CALL_REVIEW_IMPLIED_CONSEQUENCE_MAX_V1,
      instructsReviewerYes: CALL_REVIEW_INSTRUCTS_REVIEWER_YES_V1,
    },
    commit: git("rev-parse", "HEAD"),
    workingTreeStatus: git("status", "--porcelain"),
    patchHash: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
    questionsSourceHash: await sourceHash("../supervision/call-review.ts"),
    gradingSourceHash: await sourceHash("./call-review.ts"),
    fixturesSourceHash: await sourceHash("./call-review.fixtures.ts"),
    createdAt: new Date().toISOString(),
    usage: cases.reduce(
      (total, c) =>
        "usage" in c
          ? {
              input_tokens: total.input_tokens + c.usage.input_tokens,
              output_tokens: total.output_tokens + c.usage.output_tokens,
            }
          : total,
      { input_tokens: 0, output_tokens: 0 },
    ),
    // Per question, so a threshold is tuned against the judgment that moved.
    byQuestion: Object.fromEntries(
      [...new Set(checks.map((check) => check.question))].map((question) => {
        const graded = checks.filter((check) => check.question === question);
        return [
          question,
          {
            passed: graded.filter((check) => check.passed).length,
            graded: graded.length,
          },
        ];
      }),
    ),
    passed: cases.every((c) => c.passed),
    cases,
  };
  await mkdir(".eval-results", { recursive: true });
  const path = `.eval-results/call-review-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(
    `${cases.filter((c) => c.passed).length}/${cases.length} cases passed, ${report.usage.input_tokens} input tokens`,
  );
  for (const [question, tally] of Object.entries(report.byQuestion))
    console.log(`  ${question}: ${tally.passed}/${tally.graded}`);
  console.log(`Trace: ${path}`);
  process.exitCode = report.passed ? 0 : 1;
}

try {
  await runCallReviewEvalV1();
} catch (error) {
  if (!(error instanceof CallReviewSetupError)) throw error;
  console.error(error.message);
  process.exit(2);
}

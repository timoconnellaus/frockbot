import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { responseReviewFixturesV1 } from "./response-review.fixtures.js";
import {
  gradeResponseAlignmentV1,
  gradeSendV1,
  responseReviewReportCaseV1,
} from "./response-review.js";
import { describeFailureV1 } from "./failure.js";
import {
  RESPONSE_REVIEW_ALIGNMENT_MIN_V1,
  RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
  RESPONSE_REVIEW_MODEL_V1,
  RESPONSE_REVIEW_NEEDED_NO_V1,
  RESPONSE_REVIEW_REDUNDANT_KIND_MIN_V1,
  RESPONSE_REVIEW_RETRY_V1,
  RESPONSE_REVIEW_RUN_TIMEOUT_MS_V1,
  reviewResponseV1,
  reviewSendV1,
} from "../supervision/response-review.js";

/** Configuration the eval cannot run without. Reported, never graded. */
class ResponseReviewSetupError extends Error {}

/**
 * Production names the credential `JEV_API_KEY`. `TYPESAFE_API_KEY` remains a
 * local alias. The key is passed explicitly and never printed.
 */
function responseReviewClientV1(env: Record<string, string | undefined>) {
  const apiKey = (env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey)
    throw new ResponseReviewSetupError(
      "Set JEV_API_KEY, or TYPESAFE_API_KEY, in the main checkout's .dev.vars",
    );
  try {
    return new TypeSafeClient({
      apiKey,
      defaultModel: RESPONSE_REVIEW_MODEL_V1,
      retry: RESPONSE_REVIEW_RETRY_V1,
      timeout: RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
      // `debug` logs request bodies, which are conversation evidence.
      logLevel: "off",
    });
  } catch (error) {
    throw new ResponseReviewSetupError(
      `TypeSafe client setup failed: ${describeFailureV1(error).message}`,
    );
  }
}

const sourceHash = async (relative: string) =>
  createHash("sha256")
    .update(await Bun.file(new URL(relative, import.meta.url)).text())
    .digest("hex");

async function runResponseReviewEvalV1() {
  const client = responseReviewClientV1(process.env);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  // One pass, one call per case, no repetition: a rerun is a deliberate act.
  const signal = AbortSignal.timeout(RESPONSE_REVIEW_RUN_TIMEOUT_MS_V1);
  const cases = [];
  for (const fixture of responseReviewFixturesV1) {
    const started = performance.now();
    let entry;
    try {
      if (fixture.kind === "response") {
        const review = await reviewResponseV1(client, fixture.evidence, {
          signal,
        });
        entry = responseReviewReportCaseV1(fixture, {
          review,
          checks: gradeResponseAlignmentV1(fixture, review),
        });
      } else {
        const review = await reviewSendV1(client, fixture.evidence, {
          signal,
        });
        entry = responseReviewReportCaseV1(fixture, {
          review,
          checks: gradeSendV1(fixture, review),
        });
      }
    } catch (error) {
      entry = responseReviewReportCaseV1(fixture, { failure: error });
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
    harness: "response-review",
    requestedModel: RESPONSE_REVIEW_MODEL_V1,
    resolvedModels: [
      ...new Set(cases.flatMap((c) => ("model" in c ? [c.model] : []))),
    ],
    retry: RESPONSE_REVIEW_RETRY_V1,
    attemptTimeoutMs: RESPONSE_REVIEW_ATTEMPT_TIMEOUT_MS_V1,
    runTimeoutMs: RESPONSE_REVIEW_RUN_TIMEOUT_MS_V1,
    thresholds: {
      alignmentMin: RESPONSE_REVIEW_ALIGNMENT_MIN_V1,
      neededNo: RESPONSE_REVIEW_NEEDED_NO_V1,
      redundantKindMin: RESPONSE_REVIEW_REDUNDANT_KIND_MIN_V1,
    },
    commit: git("rev-parse", "HEAD"),
    workingTreeStatus: git("status", "--porcelain"),
    patchHash: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
    questionsSourceHash: await sourceHash("../supervision/response-review.ts"),
    gradingSourceHash: await sourceHash("./response-review.ts"),
    fixturesSourceHash: await sourceHash("./response-review.fixtures.ts"),
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
  const path = `.eval-results/response-review-${Date.now()}.json`;
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
  await runResponseReviewEvalV1();
} catch (error) {
  if (!(error instanceof ResponseReviewSetupError)) throw error;
  console.error(error.message);
  process.exit(2);
}

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { turnStartFixturesV1 } from "./turn-start.fixtures.js";
import { gradeTurnStartV1, turnStartReportCaseV1 } from "./turn-start.js";
import { describeFailureV1 } from "./tool-approval.js";
import {
  reviewTurnStartV1,
  TURN_START_ACKNOWLEDGE_NO_V1,
  TURN_START_ACKNOWLEDGE_YES_V1,
  TURN_START_ATTEMPT_TIMEOUT_MS_V1,
  TURN_START_MODEL_V1,
  TURN_START_RETRY_V1,
  TURN_START_RUN_TIMEOUT_MS_V1,
} from "../supervision/turn-start.js";

/** Configuration the eval cannot run without. Reported, never graded. */
class TurnStartSetupError extends Error {}

/**
 * Production names the credential `JEV_API_KEY`. `TYPESAFE_API_KEY` remains a
 * local alias. The key is passed explicitly and never printed.
 */
function turnStartClientV1(env: Record<string, string | undefined>) {
  const apiKey = (env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey)
    throw new TurnStartSetupError(
      "Set JEV_API_KEY, or TYPESAFE_API_KEY, in the main checkout's .dev.vars",
    );
  try {
    return new TypeSafeClient({
      apiKey,
      defaultModel: TURN_START_MODEL_V1,
      retry: TURN_START_RETRY_V1,
      timeout: TURN_START_ATTEMPT_TIMEOUT_MS_V1,
      // `debug` logs request bodies, which are conversation evidence.
      logLevel: "off",
    });
  } catch (error) {
    throw new TurnStartSetupError(
      `TypeSafe client setup failed: ${describeFailureV1(error).message}`,
    );
  }
}

async function runTurnStartEvalV1() {
  const client = turnStartClientV1(process.env);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  // One pass, one call per case, no repetition: a rerun is a deliberate act.
  const signal = AbortSignal.timeout(TURN_START_RUN_TIMEOUT_MS_V1);
  const cases = [];
  for (const fixture of turnStartFixturesV1) {
    const started = performance.now();
    let entry;
    try {
      const review = await reviewTurnStartV1(client, fixture.evidence, {
        signal,
      });
      entry = turnStartReportCaseV1(fixture, {
        review,
        grade: gradeTurnStartV1(fixture.expected, review.answers),
      });
    } catch (error) {
      entry = turnStartReportCaseV1(fixture, { failure: error });
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
    harness: "turn-start",
    requestedModel: TURN_START_MODEL_V1,
    resolvedModels: [
      ...new Set(cases.flatMap((c) => ("model" in c ? [c.model] : []))),
    ],
    retry: TURN_START_RETRY_V1,
    attemptTimeoutMs: TURN_START_ATTEMPT_TIMEOUT_MS_V1,
    runTimeoutMs: TURN_START_RUN_TIMEOUT_MS_V1,
    thresholds: {
      acknowledgeYes: TURN_START_ACKNOWLEDGE_YES_V1,
      acknowledgeNo: TURN_START_ACKNOWLEDGE_NO_V1,
    },
    commit: git("rev-parse", "HEAD"),
    workingTreeStatus: git("status", "--porcelain"),
    patchHash: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
    questionsSourceHash: createHash("sha256")
      .update(
        await Bun.file(
          new URL("../supervision/turn-start.ts", import.meta.url),
        ).text(),
      )
      .digest("hex"),
    gradingSourceHash: createHash("sha256")
      .update(
        await Bun.file(new URL("./turn-start.ts", import.meta.url)).text(),
      )
      .digest("hex"),
    fixturesSourceHash: createHash("sha256")
      .update(
        await Bun.file(
          new URL("./turn-start.fixtures.ts", import.meta.url),
        ).text(),
      )
      .digest("hex"),
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
  const path = `.eval-results/turn-start-${Date.now()}.json`;
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
  await runTurnStartEvalV1();
} catch (error) {
  if (!(error instanceof TurnStartSetupError)) throw error;
  console.error(error.message);
  process.exit(2);
}

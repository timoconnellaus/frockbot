import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { toolApprovalFixturesV1 } from "./tool-approval.fixtures.js";
import {
  describeFailureV1,
  gradeToolApprovalV1,
  reviewToolApprovalV1,
  TOOL_APPROVAL_ATTEMPT_TIMEOUT_MS_V1,
  TOOL_APPROVAL_MODEL_V1,
  TOOL_APPROVAL_NOUL_NO_V1,
  TOOL_APPROVAL_NOUL_YES_V1,
  TOOL_APPROVAL_RETRY_V1,
  TOOL_APPROVAL_RUN_TIMEOUT_MS_V1,
  toolApprovalReportCaseV1,
} from "./tool-approval.js";

/** Configuration the eval cannot run without. Reported, never graded. */
class ToolApprovalSetupError extends Error {}

/**
 * `TYPESAFE_API_KEY` wins where both are set, because it is also what the SDK
 * would read by itself. The key is passed explicitly and never printed.
 */
function toolApprovalClientV1(env: Record<string, string | undefined>) {
  const apiKey = (env.TYPESAFE_API_KEY ?? env.JEV_API_KEY ?? "").trim();
  if (!apiKey)
    throw new ToolApprovalSetupError(
      "Set TYPESAFE_API_KEY, or JEV_API_KEY, in the main checkout's .dev.vars",
    );
  try {
    return new TypeSafeClient({
      apiKey,
      defaultModel: TOOL_APPROVAL_MODEL_V1,
      retry: TOOL_APPROVAL_RETRY_V1,
      timeout: TOOL_APPROVAL_ATTEMPT_TIMEOUT_MS_V1,
      // `debug` logs request bodies, which are conversation evidence.
      logLevel: "off",
    });
  } catch (error) {
    throw new ToolApprovalSetupError(
      `TypeSafe client setup failed: ${describeFailureV1(error).message}`,
    );
  }
}

async function runToolApprovalEvalV1() {
  const client = toolApprovalClientV1(process.env);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  // One pass, one call per fixture, no repetition: a rerun is a deliberate act.
  const signal = AbortSignal.timeout(TOOL_APPROVAL_RUN_TIMEOUT_MS_V1);
  const cases = [];
  for (const fixture of toolApprovalFixturesV1) {
    const started = performance.now();
    let entry;
    try {
      const review = await reviewToolApprovalV1(client, fixture.evidence, {
        signal,
      });
      entry = toolApprovalReportCaseV1(fixture, {
        review,
        grade: gradeToolApprovalV1(fixture.expected, review.answers),
      });
    } catch (error) {
      entry = toolApprovalReportCaseV1(fixture, { failure: error });
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
  const report = {
    harness: "tool-approval",
    requestedModel: TOOL_APPROVAL_MODEL_V1,
    resolvedModels: [
      ...new Set(cases.flatMap((c) => ("model" in c ? [c.model] : []))),
    ],
    retry: TOOL_APPROVAL_RETRY_V1,
    attemptTimeoutMs: TOOL_APPROVAL_ATTEMPT_TIMEOUT_MS_V1,
    runTimeoutMs: TOOL_APPROVAL_RUN_TIMEOUT_MS_V1,
    thresholds: {
      noulYes: TOOL_APPROVAL_NOUL_YES_V1,
      noulNo: TOOL_APPROVAL_NOUL_NO_V1,
    },
    commit: git("rev-parse", "HEAD"),
    workingTreeStatus: git("status", "--porcelain"),
    patchHash: createHash("sha256").update(git("diff", "HEAD")).digest("hex"),
    evalSourceHash: createHash("sha256")
      .update(
        await Bun.file(new URL("./tool-approval.ts", import.meta.url)).text(),
      )
      .digest("hex"),
    fixturesSourceHash: createHash("sha256")
      .update(
        await Bun.file(
          new URL("./tool-approval.fixtures.ts", import.meta.url),
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
    passed: cases.every((c) => c.passed),
    cases,
  };
  await mkdir(".eval-results", { recursive: true });
  const path = `.eval-results/tool-approval-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(
    `${cases.filter((c) => c.passed).length}/${cases.length} cases passed, ${report.usage.input_tokens} input tokens`,
  );
  console.log(`Trace: ${path}`);
  process.exitCode = report.passed ? 0 : 1;
}

try {
  await runToolApprovalEvalV1();
} catch (error) {
  if (!(error instanceof ToolApprovalSetupError)) throw error;
  console.error(error.message);
  process.exit(2);
}

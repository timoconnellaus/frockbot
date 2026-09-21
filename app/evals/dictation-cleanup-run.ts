import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { dictationCleanupFixturesV1 } from "./dictation-cleanup.fixtures.js";
import {
  describeDictationCleanupFailureV1,
  DICTATION_CLEANUP_ATTEMPT_TIMEOUT_MS_V1,
  DICTATION_CLEANUP_MODEL_V1,
  DICTATION_CLEANUP_RETRY_V1,
  DICTATION_CLEANUP_RUN_TIMEOUT_MS_V1,
  dictationCleanupReportCaseV1,
  gradeDictationCleanupV1,
  reviewDictationCleanupV1,
} from "./dictation-cleanup.js";

class DictationCleanupSetupError extends Error {}

function dictationCleanupClientV1(env: Record<string, string | undefined>) {
  const apiKey = (env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey)
    throw new DictationCleanupSetupError(
      "Set JEV_API_KEY, or TYPESAFE_API_KEY, in the main checkout's .dev.vars",
    );
  try {
    return new TypeSafeClient({
      apiKey,
      defaultModel: DICTATION_CLEANUP_MODEL_V1,
      retry: DICTATION_CLEANUP_RETRY_V1,
      timeout: DICTATION_CLEANUP_ATTEMPT_TIMEOUT_MS_V1,
      logLevel: "off",
    });
  } catch (error) {
    throw new DictationCleanupSetupError(
      `TypeSafe client setup failed: ${describeDictationCleanupFailureV1(error).message}`,
    );
  }
}

async function runDictationCleanupEvalV1() {
  const client = dictationCleanupClientV1(process.env);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  const signal = AbortSignal.timeout(DICTATION_CLEANUP_RUN_TIMEOUT_MS_V1);
  const cases = [];
  for (const fixture of dictationCleanupFixturesV1) {
    const started = performance.now();
    let entry;
    try {
      const review = await reviewDictationCleanupV1(client, fixture.evidence, {
        signal,
      });
      entry = dictationCleanupReportCaseV1(fixture, {
        review,
        grade: gradeDictationCleanupV1(fixture.expected, review.answers),
      });
    } catch (error) {
      entry = dictationCleanupReportCaseV1(fixture, { failure: error });
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
  const passed = cases.filter((row) => row.passed).length;
  const report = {
    harness: "dictation-cleanup",
    model: DICTATION_CLEANUP_MODEL_V1,
    git: {
      commit: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    },
    sourceHash: createHash("sha256")
      .update(
        await Bun.file(
          new URL("./dictation-cleanup.ts", import.meta.url),
        ).text(),
      )
      .update(
        await Bun.file(
          new URL("./dictation-cleanup.fixtures.ts", import.meta.url),
        ).text(),
      )
      .digest("hex"),
    passed,
    failed: cases.length - passed,
    cases,
  };
  await mkdir(".eval-results", { recursive: true });
  const path = `.eval-results/dictation-cleanup-${Date.now()}.json`;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${passed}/${cases.length} passed. Wrote ${path}`);
  if (passed !== cases.length) process.exitCode = 1;
}

await runDictationCleanupEvalV1();

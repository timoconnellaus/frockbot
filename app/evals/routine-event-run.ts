import { createHash } from "node:crypto";
import { EVAL_JEV_SETUP_HINT_V1, evalJevClientV1 } from "./jev-client.js";
import { mkdir, writeFile } from "node:fs/promises";
import { routineEventFixturesV1 } from "./routine-event.fixtures.js";
import {
  describeRoutineEventFailureV1,
  gradeRoutineEventV1,
  reviewRoutineEventV1,
  ROUTINE_EVENT_ATTEMPT_TIMEOUT_MS_V1,
  ROUTINE_EVENT_MODEL_V1,
  ROUTINE_EVENT_RETRY_V1,
  ROUTINE_EVENT_RUN_TIMEOUT_MS_V1,
  routineEventReportCaseV1,
} from "./routine-event.js";

class RoutineEventSetupError extends Error {}

function routineEventClientV1(env: Record<string, string | undefined>) {
  let client;
  try {
    client = evalJevClientV1(env, {
      defaultModel: ROUTINE_EVENT_MODEL_V1,
      retry: ROUTINE_EVENT_RETRY_V1,
      timeout: ROUTINE_EVENT_ATTEMPT_TIMEOUT_MS_V1,
    });
  } catch (error) {
    throw new RoutineEventSetupError(
      `TypeSafe client setup failed: ${describeRoutineEventFailureV1(error).message}`,
    );
  }
  if (!client) throw new RoutineEventSetupError(EVAL_JEV_SETUP_HINT_V1);
  return client;
}

async function runRoutineEventEvalV1() {
  const client = routineEventClientV1(process.env);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  const signal = AbortSignal.timeout(ROUTINE_EVENT_RUN_TIMEOUT_MS_V1);
  const cases = [];
  for (const fixture of routineEventFixturesV1) {
    const started = performance.now();
    let entry;
    try {
      const review = await reviewRoutineEventV1(client, fixture.evidence, {
        signal,
      });
      entry = routineEventReportCaseV1(fixture, {
        review,
        grade: gradeRoutineEventV1(fixture.expected, review.answers),
      });
    } catch (error) {
      entry = routineEventReportCaseV1(fixture, { failure: error });
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
    harness: "routine-event",
    model: ROUTINE_EVENT_MODEL_V1,
    git: {
      commit: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    },
    sourceHash: createHash("sha256")
      .update(
        await Bun.file(new URL("./routine-event.ts", import.meta.url)).text(),
      )
      .update(
        await Bun.file(
          new URL("./routine-event.fixtures.ts", import.meta.url),
        ).text(),
      )
      .digest("hex"),
    passed,
    failed: cases.length - passed,
    cases,
  };
  await mkdir(".eval-results", { recursive: true });
  const path = `.eval-results/routine-event-${Date.now()}.json`;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${passed}/${cases.length} passed. Wrote ${path}`);
  if (passed !== cases.length) process.exitCode = 1;
}

await runRoutineEventEvalV1();

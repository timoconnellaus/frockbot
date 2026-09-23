import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { groupReplyFixturesV1 } from "./group-reply.fixtures.js";
import {
  describeGroupReplyFailureV1,
  gradeGroupReplyV1,
  groupReplyDecisionOfV1,
  groupReplyStateV1,
  reviewGroupReplyV1,
  GROUP_REPLY_ATTEMPT_TIMEOUT_MS_V1,
  GROUP_REPLY_MODEL_V1,
  GROUP_REPLY_RETRY_V1,
  GROUP_REPLY_RUN_TIMEOUT_MS_V1,
} from "./group-reply.js";

// The labelled run: `bun app/evals/group-reply-run.ts`, with JEV_API_KEY or
// TYPESAFE_API_KEY set. Writes a report under `.eval-results/`.

function groupReplyClientV1(env: Record<string, string | undefined>) {
  const apiKey = (env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "Set JEV_API_KEY, or TYPESAFE_API_KEY, in the main checkout's .dev.vars",
    );
  }
  return new TypeSafeClient({
    apiKey,
    defaultModel: GROUP_REPLY_MODEL_V1,
    retry: GROUP_REPLY_RETRY_V1,
    timeout: GROUP_REPLY_ATTEMPT_TIMEOUT_MS_V1,
    logLevel: "off",
  });
}

async function runGroupReplyEvalV1() {
  const client = groupReplyClientV1(process.env);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args])
      .stdout.toString()
      .trim();
  const signal = AbortSignal.timeout(GROUP_REPLY_RUN_TIMEOUT_MS_V1);
  const cases = [];
  for (const fixture of groupReplyFixturesV1) {
    const started = performance.now();
    const base = {
      name: fixture.name,
      intent: fixture.intent,
      state: groupReplyStateV1(fixture.evidence),
      expected: fixture.expected,
    };
    let entry;
    try {
      const review = await reviewGroupReplyV1(client, fixture.evidence, {
        signal,
      });
      const decision = groupReplyDecisionOfV1(fixture.evidence, review.answers);
      const grade = gradeGroupReplyV1(fixture.expected, decision);
      entry = {
        ...base,
        passed: grade.passed,
        model: review.model,
        requestId: review.requestId ?? null,
        usage: review.usage,
        answers: review.answers,
        decision,
        checks: grade.checks,
      };
    } catch (error) {
      entry = {
        ...base,
        passed: false,
        failure: describeGroupReplyFailureV1(error),
      };
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
    harness: "group-reply",
    model: GROUP_REPLY_MODEL_V1,
    git: {
      commit: git("rev-parse", "HEAD"),
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    },
    sourceHash: createHash("sha256")
      .update(
        await Bun.file(new URL("./group-reply.ts", import.meta.url)).text(),
      )
      .update(
        await Bun.file(
          new URL("./group-reply.fixtures.ts", import.meta.url),
        ).text(),
      )
      .digest("hex"),
    passed,
    failed: cases.length - passed,
    cases,
  };
  await mkdir(".eval-results", { recursive: true });
  const path = `.eval-results/group-reply-${Date.now()}.json`;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${passed}/${cases.length} passed. Wrote ${path}`);
  if (passed !== cases.length) process.exitCode = 1;
}

await runGroupReplyEvalV1();

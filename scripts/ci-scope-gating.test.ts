// What `main.yml` promises about skipping the slow tier, asserted against the
// workflow itself rather than against a copy of it here.
//
// The skip is only safe because of how the jobs are wired, and the wiring is
// the kind of thing a later edit breaks silently: a job that loses its `scope`
// gate quietly runs on every push again, and — far worse — a gate that starts
// reading a skipped slow tier as permission to ship would cut a release on the
// fast tier alone. Neither shows up in a green run.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Job {
  needs?: string | string[];
  if?: string;
}
const workflow = Bun.YAML.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", ".github", "workflows", "main.yml"),
    "utf8",
  ) as string,
) as { jobs: Record<string, Job> };

/** A job's dependencies, however the workflow spelled them. */
function needs(job: string): string[] {
  const declared = workflow.jobs[job]?.needs;
  if (!declared) return [];
  return Array.isArray(declared) ? declared : [declared];
}

/** The slow tier: everything the scope decision is allowed to skip. */
const SLOW_TIER = ["flutter", "runtime", "integration", "e2e"];

/** The jobs that read the tier's verdict and act on it. */
const CONSUMERS = ["deploy-staging", "release"];

test("every slow-tier job is gated on the scope decision", () => {
  for (const job of SLOW_TIER) {
    expect(workflow.jobs[job]).toBeDefined();
    expect(needs(job)).toContain("scope");
    expect(workflow.jobs[job]!.if).toContain("needs.scope.outputs.slow-tier");
  }
});

test("the fast tier is never skipped", () => {
  // `validate` runs the formatter, the typechecker and the unit suite, all of
  // which read the whole repository including the workspaces the scope
  // decision can excuse from the slow tier. It owes every push.
  expect(needs("validate")).toEqual([]);
  expect(workflow.jobs.validate?.if).toBeUndefined();
});

test("a job that ships requires the scope decision to have succeeded", () => {
  // A failed `scope` skips its dependents, so tolerating a skipped slow tier
  // without this would read that failure as four clean skips.
  for (const job of CONSUMERS) {
    expect(needs(job)).toContain("scope");
    expect(workflow.jobs[job]!.if).toContain("needs.scope.result == 'success'");
  }
});

test("a job that ships tolerates a skipped slow tier but never a failed one", () => {
  for (const job of CONSUMERS) {
    const condition = workflow.jobs[job]!.if!;
    for (const slow of SLOW_TIER) {
      expect(needs(job)).toContain(slow);
      // Success or skipped, and nothing else: no `always()`, no bare
      // `!failure()` that would also admit a cancelled shard.
      expect(condition).toContain(
        `needs.${slow}.result == 'success' || needs.${slow}.result == 'skipped'`,
      );
    }
    expect(condition).toContain("!cancelled()");
  }
});

test("the end-to-end report cannot be resurrected by a skipped suite", () => {
  // It exists to explain a failure; a skipped suite has none to explain.
  expect(workflow.jobs["e2e-report"]!.if).toContain(
    "needs.e2e.result == 'failure'",
  );
});

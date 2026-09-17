// What `main.yml` promises about skipping the slow tier, asserted against the
// workflow itself rather than against a copy of it here.
//
// The skip is only safe because of how the jobs are wired, and the wiring is
// the kind of thing a later edit breaks silently: a job that loses its `scope`
// gate quietly runs on every push again, and — far worse — a gate that starts
// reading a skipped slow tier as permission to ship would cut a release on the
// fast tier alone. Neither shows up in a green run.
//
// A condition is asserted by running it, not by reading it: each `if` is
// evaluated the way Actions would, over a table of states the run can actually
// reach, and the assertion is whether the job runs. An inverted gate and a
// loosened gate are both invisible to a test that only looks for a fragment of
// the text, and both are exactly what this file exists to catch.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SLOW_TIER_IRRELEVANT_V1 } from "./ci-change-scope";

interface Job {
  needs?: string | string[];
  if?: string;
  steps?: { run?: string }[];
}
const root = resolve(import.meta.dirname, "..");
const workflow = Bun.YAML.parse(
  readFileSync(
    join(root, ".github", "workflows", "main.yml"),
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

/** The state a run is in when a job's `if` is evaluated. */
interface RunState {
  /** Result of each job this one needs: success, skipped, failure, cancelled. */
  results: Record<string, string>;
  /** Outputs each needed job published, by job then output name. */
  outputs?: Record<string, Record<string, string>>;
  /** Whether the run itself was cancelled. */
  cancelled?: boolean;
  github?: Record<string, string>;
  vars?: Record<string, string>;
}

/**
 * Evaluate the subset of the Actions expression language `main.yml` uses:
 * `&&`, `||`, `!`, parentheses, `==`/`!=` against single-quoted strings, the
 * `needs`/`github`/`vars` contexts and the status functions.
 */
function evaluateCondition(expression: string, state: RunState): boolean {
  const body = expression.trim().replace(/^\$\{\{(.*)\}\}$/s, "$1");
  const tokens =
    body.match(/\(|\)|&&|\|\||==|!=|!|'[^']*'|[A-Za-z0-9_.-]+/g) ?? [];
  let at = 0;

  const results = state.results;
  // Only the status functions the job conditions actually use. Anything else
  // throws below rather than being guessed at, because a function modelled
  // with the wrong semantics would assert a condition into passing.
  const statuses: Record<string, () => boolean> = {
    cancelled: () => state.cancelled === true,
    failure: () => Object.values(results).some((r) => r === "failure"),
  };

  function lookup(path: string): string | undefined {
    const parts = path.split(".");
    if (parts[0] === "needs") {
      const [, job, kind, name] = parts;
      if (kind === "result") return results[job!];
      if (kind === "outputs") return state.outputs?.[job!]?.[name!];
      return undefined;
    }
    if (parts[0] === "github") return state.github?.[parts[1]!];
    if (parts[0] === "vars") return state.vars?.[parts[1]!];
    throw new Error(`unsupported context in condition: ${path}`);
  }

  /** A string comparison, a status call, or a parenthesised sub-expression. */
  function parsePrimary(): boolean | string | undefined {
    const token = tokens[at++];
    if (token === undefined) throw new Error("condition ended early");
    if (token === "(") {
      const value = parseOr();
      if (tokens[at++] !== ")") throw new Error("unbalanced parentheses");
      return value;
    }
    if (token === "!") return !truthy(parsePrimary());
    if (token.startsWith("'")) return token.slice(1, -1);
    if (tokens[at] === "(") {
      at += 2; // the call's `(` and `)`; none of these take arguments
      const status = statuses[token];
      if (!status) throw new Error(`unsupported function: ${token}()`);
      return status();
    }
    return lookup(token);
  }

  function parseComparison(): boolean | string | undefined {
    const left = parsePrimary();
    const operator = tokens[at];
    if (operator !== "==" && operator !== "!=") return left;
    at++;
    const right = parsePrimary();
    return operator === "==" ? left === right : left !== right;
  }

  function parseAnd(): boolean | string | undefined {
    let left = parseComparison();
    while (tokens[at] === "&&") {
      at++;
      const right = parseComparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function parseOr(): boolean | string | undefined {
    let left = parseAnd();
    while (tokens[at] === "||") {
      at++;
      const right = parseAnd();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const value = parseOr();
  if (at !== tokens.length) throw new Error(`unparsed tail in: ${body}`);
  return truthy(value);
}

function truthy(value: boolean | string | undefined): boolean {
  return value !== undefined && value !== false && value !== "";
}

/** Whether Actions would run `job` in this state, honouring an absent `if`. */
function runs(job: string, state: RunState): boolean {
  const condition = workflow.jobs[job]?.if;
  if (condition === undefined) return true;
  return evaluateCondition(condition, state);
}

/** Every job a consumer needs, green, with the slow tier having run. */
function allGreen(): RunState {
  return {
    results: Object.fromEntries(
      ["scope", "validate", ...SLOW_TIER, "deploy-staging", "e2e-report"].map(
        (job) => [job, "success"],
      ),
    ),
    outputs: { scope: { "slow-tier": "true" } },
    github: { event_name: "push", ref: "refs/heads/main" },
    vars: { DEPLOY_STAGING: "true" },
  };
}

test("the scope decision is what makes a slow-tier job run", () => {
  for (const job of SLOW_TIER) {
    expect(workflow.jobs[job]).toBeDefined();
    expect(needs(job)).toContain("scope");

    const obliged: RunState = {
      results: { scope: "success" },
      outputs: { scope: { "slow-tier": "true" } },
    };
    const excused: RunState = {
      results: { scope: "success" },
      outputs: { scope: { "slow-tier": "false" } },
    };
    // Only the word `false` excuses the tier. A `scope` job that succeeded
    // without publishing the output at all — a stray line on standard output
    // ahead of the key, a step that wrote nothing — must run the tier, the
    // same direction `slowTierRequiredV1` defaults in.
    const silent: RunState = { results: { scope: "success" } };
    expect({ job, runs: runs(job, obliged) }).toEqual({ job, runs: true });
    expect({ job, runs: runs(job, excused) }).toEqual({ job, runs: false });
    expect({ job, runs: runs(job, silent) }).toEqual({ job, runs: true });
  }
});

test("the fast tier is never skipped", () => {
  // `validate` runs the formatter, the typechecker and the unit suite, all of
  // which read the whole repository including the workspaces the scope
  // decision can excuse from the slow tier. It owes every push.
  expect(needs("validate")).toEqual([]);
  expect(workflow.jobs.validate?.if).toBeUndefined();
});

/** Root `package.json` scripts, which is where a job's `run` line delegates. */
const rootScripts: Record<string, string> =
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};

/**
 * A command with every root script it delegates to, at any depth, folded into
 * it — so what a step ultimately builds is read from `package.json` rather
 * than guessed from the workflow's own wording.
 */
function resolveCommand(command: string, seen = new Set<string>()): string {
  let resolved = command;
  for (const word of command.match(/[\w:@./-]+/g) ?? []) {
    const body = rootScripts[word];
    if (body === undefined || seen.has(word)) continue;
    seen.add(word);
    resolved += ` ${resolveCommand(body, seen)}`;
  }
  return resolved;
}

/** Whether any of `job`'s steps ends up building the workspace named `pkg`. */
function builds(job: string, pkg: string): boolean {
  return (workflow.jobs[job]?.steps ?? []).some((step) =>
    step.run === undefined ? false : resolveCommand(step.run).includes(pkg),
  );
}

/**
 * Whether Actions would still reach `job` on a push the scope decision
 * excused: its own condition holds, and nothing it waits on is a slow-tier job
 * that the same decision skipped.
 */
function survivesAnExcusedScope(job: string): boolean {
  const state: RunState = {
    results: Object.fromEntries(
      Object.keys(workflow.jobs).map((name) => [
        name,
        SLOW_TIER.includes(name) ? "skipped" : "success",
      ]),
    ),
    outputs: { scope: { "slow-tier": "false" } },
    github: { event_name: "push", ref: "refs/heads/main" },
    vars: { DEPLOY_STAGING: "true" },
  };
  return (
    runs(job, state) &&
    needs(job).every(
      (need) => !SLOW_TIER.includes(need) && survivesAnExcusedScope(need),
    )
  );
}

test("every workspace the tier excuses is still bundled by a job that runs", () => {
  // The excused workspaces are the only Workers whose build no slow-tier job
  // performs, so whichever job bundles them has to be one an excused push
  // still reaches. Moving those bundles under the scope gate would leave them
  // built by nobody for precisely the pushes that touch only them.
  const excused = SLOW_TIER_IRRELEVANT_V1.map((prefix) =>
    join(root, prefix, "package.json"),
  )
    .filter((manifest) => existsSync(manifest))
    .map(
      (manifest) => JSON.parse(readFileSync(manifest, "utf8")).name as string,
    );
  expect(excused.length).toBe(2);

  for (const pkg of excused) {
    const builders = Object.keys(workflow.jobs).filter((job) =>
      builds(job, pkg),
    );
    expect({ pkg, bundled: builders.length > 0 }).toEqual({
      pkg,
      bundled: true,
    });
    expect({
      pkg,
      bundledWhenExcused: builders.some(survivesAnExcusedScope),
    }).toEqual({ pkg, bundledWhenExcused: true });
  }
});

test("a job that ships runs when every suite it needs is green", () => {
  for (const job of CONSUMERS) {
    expect(needs(job)).toContain("scope");
    for (const slow of SLOW_TIER) expect(needs(job)).toContain(slow);
    expect({ job, runs: runs(job, allGreen()) }).toEqual({ job, runs: true });
  }
});

test("a job that ships tolerates a slow tier the scope decision excused", () => {
  for (const job of CONSUMERS) {
    const state = allGreen();
    state.outputs = { scope: { "slow-tier": "false" } };
    for (const slow of SLOW_TIER) state.results[slow] = "skipped";
    expect({ job, runs: runs(job, state) }).toEqual({ job, runs: true });
  }
});

test("a scope job that failed is not four clean skips", () => {
  // A failed job's dependents do not run, so a `scope` failure presents as the
  // whole slow tier skipped. Without requiring `scope` itself, a condition
  // that tolerates skips would read that as permission to ship.
  for (const job of CONSUMERS) {
    const state = allGreen();
    state.results.scope = "failure";
    for (const slow of SLOW_TIER) state.results[slow] = "skipped";
    expect({ job, runs: runs(job, state) }).toEqual({ job, runs: false });
  }
});

test("a job that ships refuses a slow-tier job that failed or was cancelled", () => {
  for (const job of CONSUMERS) {
    for (const slow of SLOW_TIER) {
      for (const result of ["failure", "cancelled"]) {
        const state = allGreen();
        state.results[slow] = result;
        state.cancelled = result === "cancelled";
        expect({ job, slow, result, runs: runs(job, state) }).toEqual({
          job,
          slow,
          result,
          runs: false,
        });
      }
    }
  }
});

test("a job that ships refuses a slow-tier job cancelled on its own", () => {
  // A shard that runs out its `timeout-minutes` is cancelled while the run
  // around it is not, so `!cancelled()` says nothing about it. Only the
  // per-job enumeration of success-or-skipped refuses it; a bare
  // `!= 'failure'` would ship on a suite that never finished.
  for (const job of CONSUMERS) {
    for (const slow of SLOW_TIER) {
      const state = allGreen();
      state.results[slow] = "cancelled";
      state.cancelled = false;
      expect({ job, slow, runs: runs(job, state) }).toEqual({
        job,
        slow,
        runs: false,
      });
    }
  }
});

test("a job that ships refuses a failed fast tier", () => {
  for (const job of CONSUMERS) {
    const state = allGreen();
    state.results.validate = "failure";
    expect({ job, runs: runs(job, state) }).toEqual({ job, runs: false });
  }
});

test("staging stays opt-in and neither consumer ships off main", () => {
  const unconfigured = allGreen();
  unconfigured.vars = { DEPLOY_STAGING: "false" };
  expect(runs("deploy-staging", unconfigured)).toBe(false);
  expect(runs("release", unconfigured)).toBe(true);

  for (const job of CONSUMERS) {
    const branch = allGreen();
    branch.github = { event_name: "push", ref: "refs/heads/topic" };
    expect({ job, runs: runs(job, branch) }).toEqual({ job, runs: false });
  }
});

test("release tolerates a skipped staging deploy but not a failed one", () => {
  const skipped = allGreen();
  skipped.results["deploy-staging"] = "skipped";
  expect(runs("release", skipped)).toBe(true);

  const failed = allGreen();
  failed.results["deploy-staging"] = "failure";
  expect(runs("release", failed)).toBe(false);
});

test("the end-to-end report cannot be resurrected by a skipped suite", () => {
  // It exists to explain a failure; a skipped suite has none to explain.
  expect(runs("e2e-report", { results: { e2e: "failure" } })).toBe(true);
  expect(runs("e2e-report", { results: { e2e: "skipped" } })).toBe(false);
  expect(runs("e2e-report", { results: { e2e: "success" } })).toBe(false);
});

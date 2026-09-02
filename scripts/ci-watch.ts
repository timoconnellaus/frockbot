/**
 * Watches a change to its terminal state, so that opening a pull request or
 * pushing a tag is not mistaken for the work having landed.
 *
 * Two legs, because the repository has two: merging integrates and tagging
 * ships (`README.md` → Releases). Each leg fails in ways that are quiet — a
 * pull request whose merge was never queued just sits open, and a release
 * whose deploy failed after its packages published leaves a GitHub release
 * standing in front of a production that never moved. Both report as a plain
 * exit code so a session, a hook, or a person reads the same verdict:
 *
 *   0  settled, and settled well: the pull request merged, or production moved
 *   1  failed, and the summary says what and where
 *   2  still pending — not an error, just not finished
 *
 *   bun scripts/ci-watch.ts pr 128
 *   bun scripts/ci-watch.ts release v0.2.0 --once
 *
 * The default is to poll to a deadline. `--once` reports the current state and
 * exits, which is what a caller that owns its own scheduling wants: a session
 * pacing itself between turns, or a hook that must not block.
 */

export type WatchStatus = "passed" | "failed" | "pending";

export interface WatchReport {
  status: WatchStatus;
  summary: string;
  /** Lines of supporting evidence: which job, which step, which URL. */
  detail?: string[];
}

/** Runs `gh` with `--json`-shaped arguments and parses what it prints. */
export type GitHubJson = (args: readonly string[]) => Promise<unknown>;

/**
 * A check that reached one of these has nothing left to do and did not pass.
 * `CANCELLED` counts: a cancelled required check never becomes a green one, so
 * a pull request waiting on it waits forever.
 */
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

/** The jobs that actually move production. A release without them shipped nothing. */
const PRODUCTION_JOBS = ["Deploy marketing site", "Deploy FrockBot app"];

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} is not an object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface Check {
  name: string;
  /** Absent while the check is still running. */
  conclusion: string;
  complete: boolean;
}

/**
 * A status rollup mixes two shapes: `CheckRun` has a name and a conclusion,
 * and the older `StatusContext` has a context and a state. Read both, so a
 * required check reported by either is not silently treated as passing.
 */
function checksOf(rollup: unknown): Check[] {
  return list(rollup).map((entry) => {
    const value = record(entry, "status check");
    const name = text(value.name) || text(value.context) || "unnamed check";
    const conclusion = (
      text(value.conclusion) || text(value.state)
    ).toUpperCase();
    const status = text(value.status).toUpperCase();
    // A StatusContext has no `status` field; its state alone says whether it
    // settled, and `PENDING` is the one state that means it has not.
    const complete = status
      ? status === "COMPLETED"
      : conclusion !== "" &&
        conclusion !== "PENDING" &&
        conclusion !== "EXPECTED";
    return { name, conclusion, complete };
  });
}

export async function pullRequestReport(
  gh: GitHubJson,
  pullRequest: number,
): Promise<WatchReport> {
  const value = record(
    await gh([
      "pr",
      "view",
      String(pullRequest),
      "--json",
      "state,mergedAt,statusCheckRollup,autoMergeRequest,url",
    ]),
    "pull request",
  );
  const url = text(value.url) || `pull request #${pullRequest}`;
  const state = text(value.state).toUpperCase();

  if (state === "MERGED") {
    return {
      status: "passed",
      summary: `#${pullRequest} merged`,
      detail: [url],
    };
  }
  if (state === "CLOSED") {
    return {
      status: "failed",
      summary: `#${pullRequest} was closed without merging`,
      detail: [url],
    };
  }

  const checks = checksOf(value.statusCheckRollup);
  const failed = checks.filter(
    (check) => check.complete && FAILING_CONCLUSIONS.has(check.conclusion),
  );
  if (failed.length > 0) {
    return {
      status: "failed",
      summary: `#${pullRequest} has failing checks: ${failed
        .map((check) => check.name)
        .join(", ")}`,
      detail: [
        ...failed.map((check) => `${check.name}: ${check.conclusion}`),
        url,
      ],
    };
  }

  const running = checks.filter((check) => !check.complete);
  if (running.length > 0 || checks.length === 0) {
    return {
      status: "pending",
      summary:
        checks.length === 0
          ? `#${pullRequest} has no checks reported yet`
          : `#${pullRequest} is waiting on ${running
              .map((check) => check.name)
              .join(", ")}`,
      detail: [url],
    };
  }

  // Every check passed and the pull request is still open. Auto-merge should
  // have taken it; that it did not is the failure, not something to wait out.
  // The usual cause is a pull request touching `.github/workflows/`, which
  // `GITHUB_TOKEN` may not queue (see `.github/workflows/auto-merge.yml`).
  if (!value.autoMergeRequest) {
    return {
      status: "failed",
      summary: `#${pullRequest} passed its checks but nothing queued the merge`,
      detail: [
        "Auto-merge was refused or disabled; this pull request will sit open until it is merged by hand.",
        "A pull request that edits .github/workflows/ can never be queued by GITHUB_TOKEN.",
        url,
      ],
    };
  }
  return {
    status: "pending",
    summary: `#${pullRequest} is queued to merge`,
    detail: [url],
  };
}

export async function releaseReport(
  gh: GitHubJson,
  tag: string,
): Promise<WatchReport> {
  const runs = list(
    await gh([
      "run",
      "list",
      "--workflow",
      "release.yml",
      "--json",
      "databaseId,headBranch,status,conclusion,url",
      "--limit",
      "30",
    ]),
  ).map((entry) => record(entry, "workflow run"));
  // A tag push reports the tag as the run's head branch.
  const run = runs.find((entry) => text(entry.headBranch) === tag);
  if (!run) {
    return {
      status: "pending",
      summary: `no release run for ${tag} yet`,
    };
  }
  const url = text(run.url) || tag;
  const jobs = list(
    record(
      await gh(["run", "view", String(run.databaseId), "--json", "jobs"]),
      "workflow run",
    ).jobs,
  ).map((entry) => record(entry, "job"));

  const failed = jobs.filter((job) =>
    FAILING_CONCLUSIONS.has(text(job.conclusion).toUpperCase()),
  );
  if (failed.length > 0) {
    const shipped = failed.some((job) =>
      PRODUCTION_JOBS.includes(text(job.name)),
    );
    return {
      status: "failed",
      summary: shipped
        ? `${tag} published but production did not change: ${failed
            .map((job) => text(job.name))
            .join(", ")} failed`
        : `${tag} release failed: ${failed
            .map((job) => text(job.name))
            .join(", ")}`,
      detail: [
        ...failed.map((job) => {
          const step = list(job.steps)
            .map((entry) => record(entry, "step"))
            .find((entry) =>
              FAILING_CONCLUSIONS.has(text(entry.conclusion).toUpperCase()),
            );
          const where = step ? ` at step "${text(step.name)}"` : "";
          return `${text(job.name)}: ${text(job.conclusion)}${where}`;
        }),
        url,
      ],
    };
  }

  if (text(run.status).toLowerCase() !== "completed") {
    return {
      status: "pending",
      summary: `${tag} is still releasing`,
      detail: [url],
    };
  }

  // A completed, unfailed run still has to have deployed. A release that
  // published packages and never ran the deploy jobs looks like a success
  // everywhere except production.
  const deployed = PRODUCTION_JOBS.filter((name) =>
    jobs.some(
      (job) =>
        text(job.name) === name &&
        text(job.conclusion).toUpperCase() === "SUCCESS",
    ),
  );
  if (deployed.length < PRODUCTION_JOBS.length) {
    const missing = PRODUCTION_JOBS.filter((name) => !deployed.includes(name));
    return {
      status: "failed",
      summary: `${tag} completed without deploying production`,
      detail: [`no successful run of: ${missing.join(", ")}`, url],
    };
  }
  return {
    status: "passed",
    summary: `${tag} released and production deployed`,
    detail: [url],
  };
}

const EXIT_CODES: Record<WatchStatus, number> = {
  passed: 0,
  failed: 1,
  pending: 2,
};

export function formatReport(report: WatchReport): string {
  const lines = [`${report.status}: ${report.summary}`];
  for (const line of report.detail ?? []) lines.push(`  ${line}`);
  return lines.join("\n");
}

export interface WatchOptions {
  once: boolean;
  intervalSeconds: number;
  deadlineMinutes: number;
}

export function parseArguments(argv: readonly string[]): {
  leg: "pr" | "release";
  subject: string;
  options: WatchOptions;
} {
  const [leg, subject, ...rest] = argv;
  if ((leg !== "pr" && leg !== "release") || !subject) {
    throw new Error(
      "usage: bun scripts/ci-watch.ts <pr <number> | release <tag>> [--once] [--interval-seconds n] [--deadline-minutes n]",
    );
  }
  const numeric = (flag: string, fallback: number): number => {
    const index = rest.indexOf(flag);
    if (index === -1) return fallback;
    const value = Number(rest[index + 1]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${flag} needs a positive number`);
    }
    return value;
  };
  return {
    leg,
    subject,
    options: {
      once: rest.includes("--once"),
      // CI here runs eight to fourteen minutes, so a minute between polls is
      // frequent enough to feel immediate and rare enough to be free.
      intervalSeconds: numeric("--interval-seconds", 60),
      deadlineMinutes: numeric("--deadline-minutes", 40),
    },
  };
}

export async function watch(
  gh: GitHubJson,
  leg: "pr" | "release",
  subject: string,
  options: WatchOptions,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<WatchReport> {
  const deadline = now() + options.deadlineMinutes * 60_000;
  for (;;) {
    const report =
      leg === "pr"
        ? await pullRequestReport(gh, Number(subject))
        : await releaseReport(gh, subject);
    if (report.status !== "pending" || options.once) return report;
    if (now() >= deadline) {
      return {
        ...report,
        detail: [
          ...(report.detail ?? []),
          `still pending after ${options.deadlineMinutes} minutes`,
        ],
      };
    }
    await sleep(options.intervalSeconds * 1_000);
  }
}

async function ghJson(args: readonly string[]): Promise<unknown> {
  const result = Bun.spawnSync(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return stdout ? JSON.parse(stdout) : null;
}

if (import.meta.main) {
  const { leg, subject, options } = parseArguments(process.argv.slice(2));
  const report = await watch(ghJson, leg, subject, options);
  console.log(formatReport(report));
  process.exit(EXIT_CODES[report.status]);
}

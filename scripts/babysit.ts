/**
 * One look at the whole delivery pipeline — `main`, production and every open
 * pull request — reduced to the next action each one needs. The `/babysit`
 * skill reads it on every tick. It reads GitHub and nothing else, and changes
 * nothing: deciding and acting are the skill's.
 *
 *   bun scripts/babysit.ts          # for a person
 *   bun scripts/babysit.ts --json   # for a caller that acts on it
 *
 * `main` comes first because it gates everything else: a pull request that is
 * green on its own head is only ready while `main` is green, since merging
 * onto a red `main` ships nothing and hides who broke it (see
 * `.claude/skills/babysit/SKILL.md` → Stop the line).
 */

import {
  releaseReport,
  type GitHubJson,
  type WatchReport,
} from "./ci-watch.js";

/** A pull request carrying this label is left alone until someone removes it. */
export const HOLD_LABEL = "hold";

/**
 * A pull request carrying this label repairs `main`, so it may merge while
 * `main` is red. A revert (title `Revert "…"`) counts without the label.
 */
export const FIX_MAIN_LABEL = "fix-main";

/**
 * The commit status `scripts/main-health.ts` keeps on every open pull
 * request. It reports `main`, not the pull request, so its failing is never
 * the pull request's to fix.
 */
export const MAIN_HEALTH_CHECK = "main-health";

/**
 * Whether a pull request may merge while `main` is red. Applying a label
 * takes triage rights, but anyone can title a fork's pull request
 * `Revert "…"`, so the title counts only on a branch of this repository.
 */
export function repairsMain(pullRequest: {
  labels: readonly string[];
  title: string;
  crossRepository: boolean;
}): boolean {
  return (
    pullRequest.labels.includes(FIX_MAIN_LABEL) ||
    (!pullRequest.crossRepository && /^Revert "/.test(pullRequest.title))
  );
}

export interface RunRef {
  id: number;
  sha: string;
  url: string;
  createdAt: string;
}

export interface FailedJob {
  name: string;
  /** `failure`, or `cancelled` for a job that hit its timeout. */
  conclusion: string;
  steps: string[];
  url: string;
}

/** A commit on `main`'s first-parent line, and the pull request it landed. */
export interface Suspect {
  sha: string;
  pullRequest: number | null;
  title: string;
}

export interface MainState {
  /** `unknown` when no run on `main` has settled yet. */
  status: "green" | "red" | "unknown";
  /**
   * The newest run that decides `status`. A run the concurrency group
   * displaced before it started proves nothing and is passed over; any other
   * run that did not pass — failed, timed out (GitHub reports that as
   * cancelled), cancelled by hand — leaves `main` unproven, so red.
   */
  settled?: RunRef;
  /**
   * `settled` is a failed run being rerun. `main` stays red until the rerun
   * passes: a rerun keeps its id and creation time, so without this the run
   * would drop out of the settled list and an older green run would decide.
   */
  rerunning?: boolean;
  /** A run still going, which covers commits newer than `settled`. */
  running?: RunRef;
  /** When the first failed run of the current red streak started. */
  redSince?: string;
  /** The newest passing run before the streak: its head is the last good commit. */
  lastGreen?: RunRef;
  failedJobs: FailedJob[];
  /**
   * Every pull request that landed between the last good commit and the
   * failing head, oldest first. One of them broke `main`, or a flake did.
   */
  suspects: Suspect[];
}

export type PullRequestAction =
  "merge" | "rebase" | "fix" | "wait" | "held" | "skip";

export interface PullRequestState {
  number: number;
  title: string;
  url: string;
  branch: string;
  headSha: string;
  author: string;
  labels: string[];
  action: PullRequestAction;
  reason: string;
  failedChecks: string[];
  /**
   * Minutes since the head commit: how long its author has been quiet. Read
   * only for `fix` and `rebase`, the two actions that may mean taking the
   * branch over.
   */
  idleMinutes: number | null;
}

export interface Snapshot {
  takenAt: string;
  main: MainState;
  production: { tag: string | null; report: WatchReport };
  pullRequests: PullRequestState[];
}

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

function runRef(value: Record<string, unknown>): RunRef {
  return {
    id: Number(value.databaseId),
    sha: text(value.headSha),
    url: text(value.url),
    createdAt: text(value.createdAt),
  };
}

/**
 * The pull request a first-parent commit on `main` landed: a merge commit
 * says `Merge pull request #N`, a squash ends its subject with `(#N)`.
 */
export function pullRequestOf(message: string): number | null {
  const subject = message.split("\n", 1)[0] ?? "";
  const match =
    /^Merge pull request #(\d+)\b/.exec(subject) ??
    /\(#(\d+)\)\s*$/.exec(subject);
  return match ? Number(match[1]) : null;
}

/** The title a first-parent commit carries: a merge commit keeps it in the body. */
function titleOf(message: string): string {
  const [subject = "", ...rest] = message.split("\n");
  if (/^Merge pull request #\d+\b/.test(subject)) {
    const body = rest.find((line) => line.trim() !== "");
    if (body) return body.trim();
  }
  return subject.replace(/\s*\(#\d+\)\s*$/, "");
}

/**
 * Walks `main`'s first-parent line from `head` back to `base`. The compare
 * API lists every commit in the range, a merged branch's own commits
 * included; following first parents keeps exactly one commit per landing.
 */
async function landedBetween(
  gh: GitHubJson,
  base: string,
  head: string,
): Promise<Suspect[]> {
  const comparison = record(
    await gh(["api", `repos/{owner}/{repo}/compare/${base}...${head}`]),
    "comparison",
  );
  const bySha = new Map<string, { message: string; parent: string }>();
  for (const entry of list(comparison.commits)) {
    const commit = record(entry, "commit");
    const parents = list(commit.parents).map((parent) =>
      text(record(parent, "parent").sha),
    );
    bySha.set(text(commit.sha), {
      message: text(record(commit.commit, "commit body").message),
      parent: parents[0] ?? "",
    });
  }
  const landed: Suspect[] = [];
  for (let sha = head; sha && sha !== base;) {
    const commit = bySha.get(sha);
    if (!commit) break;
    landed.push({
      sha,
      pullRequest: pullRequestOf(commit.message),
      title: titleOf(commit.message),
    });
    sha = commit.parent;
  }
  return landed.reverse();
}

export async function mainState(gh: GitHubJson): Promise<MainState> {
  const runs = list(
    await gh([
      "run",
      "list",
      "--workflow",
      "main.yml",
      "--branch",
      "main",
      "--json",
      "databaseId,headSha,status,conclusion,createdAt,url,event,attempt",
      "--limit",
      "40",
    ]),
  ).map((run) => record(run, "workflow run"));

  const jobsOf = async (run: Record<string, unknown>, attempt?: number) =>
    list(
      record(
        await gh([
          "run",
          "view",
          String(run.databaseId),
          ...(attempt ? ["--attempt", String(attempt)] : []),
          "--json",
          "jobs",
        ]),
        "workflow run",
      ).jobs,
    ).map((job) => record(job, "job"));

  // Newest first, each run's verdict on `main`; the walk stops at the first
  // green, which is the last good commit. A dispatched run on `main` proves
  // the same thing a push run does; `--branch` already drops other branches.
  let running: Record<string, unknown> | undefined;
  const verdicts: Array<{
    run: Record<string, unknown>;
    green: boolean;
    rerunning: boolean;
  }> = [];
  for (const run of runs) {
    if (!["push", "workflow_dispatch"].includes(text(run.event))) continue;
    const conclusion = text(run.conclusion).toLowerCase();
    if (text(run.status).toLowerCase() !== "completed") {
      if (Number(run.attempt) > 1)
        verdicts.push({ run, green: false, rerunning: true });
      else running ??= run;
    } else if (conclusion === "success") {
      verdicts.push({ run, green: true, rerunning: false });
      break;
    } else if (conclusion === "cancelled") {
      // With `cancel-in-progress: false` only a queued run is displaced, and
      // a queued run has no jobs yet.
      if ((await jobsOf(run)).length > 0)
        verdicts.push({ run, green: false, rerunning: false });
    } else if (conclusion !== "skipped" && conclusion !== "neutral") {
      verdicts.push({ run, green: false, rerunning: false });
    }
  }

  const empty: MainState = {
    status: "unknown",
    failedJobs: [],
    suspects: [],
    ...(running ? { running: runRef(running) } : {}),
  };
  const newest = verdicts[0];
  if (!newest) return empty;
  const settled = runRef(newest.run);
  if (newest.green)
    return { ...empty, status: "green", settled, lastGreen: settled };

  const last = verdicts[verdicts.length - 1]!;
  const lastGreen = last.green ? runRef(last.run) : undefined;
  const streak = verdicts.filter((verdict) => !verdict.green);
  const firstRed = streak[streak.length - 1]!;

  // A rerun's own jobs are still going; what failed is the attempt before.
  const jobs = await jobsOf(
    newest.run,
    newest.rerunning ? Number(newest.run.attempt) - 1 : undefined,
  );
  const failedJobs = jobs
    .filter((job) =>
      ["failure", "timed_out", "cancelled"].includes(
        text(job.conclusion).toLowerCase(),
      ),
    )
    .map((job) => ({
      name: text(job.name),
      conclusion: text(job.conclusion).toLowerCase(),
      url: text(job.url),
      steps: list(job.steps)
        .map((step) => record(step, "step"))
        .filter((step) =>
          ["failure", "cancelled"].includes(
            text(step.conclusion).toLowerCase(),
          ),
        )
        .map((step) => text(step.name)),
    }));

  return {
    ...empty,
    status: "red",
    settled,
    ...(newest.rerunning ? { rerunning: true } : {}),
    redSince: text(firstRed.run.createdAt),
    ...(lastGreen ? { lastGreen } : {}),
    failedJobs,
    suspects: lastGreen
      ? await landedBetween(gh, lastGreen.sha, settled.sha)
      : [],
  };
}

interface CheckState {
  name: string;
  complete: boolean;
  passed: boolean;
}

/** Reads both rollup shapes, as `ci-watch.ts` does. */
function checksOf(rollup: unknown): CheckState[] {
  return list(rollup).map((entry) => {
    const value = record(entry, "status check");
    const name = text(value.name) || text(value.context) || "unnamed check";
    const conclusion = (
      text(value.conclusion) || text(value.state)
    ).toUpperCase();
    const status = text(value.status).toUpperCase();
    const complete = status
      ? status === "COMPLETED"
      : conclusion !== "" &&
        conclusion !== "PENDING" &&
        conclusion !== "EXPECTED";
    return {
      name,
      complete,
      passed: ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion),
    };
  });
}

/** The status checks the `main` ruleset requires, read from GitHub. */
export async function requiredChecks(gh: GitHubJson): Promise<string[]> {
  const rules = list(
    await gh(["api", "repos/{owner}/{repo}/rules/branches/main"]),
  );
  return rules
    .map((rule) => record(rule, "rule"))
    .filter((rule) => text(rule.type) === "required_status_checks")
    .flatMap((rule) =>
      list(record(rule.parameters, "rule parameters").required_status_checks),
    )
    .map((check) => text(record(check, "required check").context))
    .filter(Boolean);
}

export function pullRequestState(
  value: Record<string, unknown>,
  context: {
    main: MainState["status"];
    required: readonly string[];
    now: number;
  },
): PullRequestState {
  const labels = list(value.labels)
    .map((label) => text(record(label, "label").name))
    .filter(Boolean);
  const checks = checksOf(value.statusCheckRollup);
  const failedChecks = checks
    .filter(
      (check) =>
        check.complete && !check.passed && check.name !== MAIN_HEALTH_CHECK,
    )
    .map((check) => check.name);
  const title = text(value.title);
  const crossRepository = value.isCrossRepository === true;
  const fixesMain = repairsMain({ labels, title, crossRepository });
  const state = (
    action: PullRequestAction,
    reason: string,
  ): PullRequestState => ({
    number: Number(value.number),
    title,
    url: text(value.url),
    branch: text(value.headRefName),
    headSha: text(value.headRefOid),
    author: text(record(value.author ?? {}, "author").login),
    labels,
    action,
    reason,
    failedChecks,
    idleMinutes: null,
  });

  if (value.isDraft === true) return state("skip", "draft");
  if (labels.includes(HOLD_LABEL))
    return state("skip", `labelled ${HOLD_LABEL}`);
  if (text(value.baseRefName) !== "main")
    return state("skip", `targets ${text(value.baseRefName)}, not main`);
  // The repository is public and merging deploys production, so an outside
  // contribution waits for Tim's review rather than for its checks.
  if (crossRepository) return state("skip", "from a fork: Tim reviews it");
  if (text(value.reviewDecision).toUpperCase() === "CHANGES_REQUESTED")
    return state("skip", "changes requested");
  if (text(value.mergeable).toUpperCase() === "CONFLICTING")
    return state("rebase", "conflicts with main");
  if (failedChecks.length > 0)
    return state("fix", `failing: ${failedChecks.join(", ")}`);

  const missing = context.required.filter(
    (name) => !checks.some((check) => check.name === name && check.complete),
  );
  const running = checks
    .filter((check) => !check.complete)
    .map((check) => check.name);
  if (missing.length > 0 || running.length > 0)
    return state(
      "wait",
      `waiting on ${[...new Set([...missing, ...running])].join(", ")}`,
    );
  if (text(value.mergeable).toUpperCase() !== "MERGEABLE")
    return state("wait", "GitHub has not decided mergeability yet");

  if (context.main !== "green" && !fixesMain)
    return state(
      "held",
      context.main === "red"
        ? "green, but main is red"
        : "green, but main has no settled run",
    );
  // GitHub refuses the merge until the status catches up with `main`.
  const health = checks.find((check) => check.name === MAIN_HEALTH_CHECK);
  if (health && !health.passed)
    return state("wait", `${MAIN_HEALTH_CHECK} has not caught up with main`);
  return state("merge", fixesMain ? "green and repairs main" : "green");
}

export async function pullRequestStates(
  gh: GitHubJson,
  main: MainState["status"],
  now: number,
): Promise<PullRequestState[]> {
  const required = await requiredChecks(gh);
  const open = list(
    await gh([
      "pr",
      "list",
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,url,isDraft,labels,headRefName,headRefOid,baseRefName,mergeable,statusCheckRollup,author,isCrossRepository,reviewDecision",
    ]),
  ).map((value) => record(value, "pull request"));
  const states = open
    .map((value) => pullRequestState(value, { main, required, now }))
    .sort((a, b) => a.number - b.number);
  // `commits` on the list query asks GitHub for more nodes than it allows, so
  // the head commit is read on its own, and only where it matters.
  for (const pr of states) {
    if (pr.action !== "fix" && pr.action !== "rebase") continue;
    const commit = record(
      await gh(["api", `repos/{owner}/{repo}/commits/${pr.headSha}`]),
      "commit",
    );
    const committer = record(
      record(commit.commit, "commit body").committer,
      "committer",
    );
    const committedAt = Date.parse(text(committer.date));
    if (!Number.isNaN(committedAt))
      pr.idleMinutes = Math.max(0, Math.round((now - committedAt) / 60_000));
  }
  return states;
}

/** The highest `vX.Y.Z` tag, which is what production runs or is about to. */
export async function latestReleaseTag(gh: GitHubJson): Promise<string | null> {
  // `--slurp` wraps each page in one outer array, so pages flatten here.
  const refs = list(
    await gh([
      "api",
      "--paginate",
      "--slurp",
      "repos/{owner}/{repo}/git/matching-refs/tags/v",
    ]),
  ).flatMap(list);
  const versions = refs
    .map((ref) => text(record(ref, "ref").ref).replace(/^refs\/tags\//, ""))
    .map((tag) => ({ tag, parts: /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag) }))
    .filter((entry) => entry.parts)
    .map((entry) => ({
      tag: entry.tag,
      key: entry.parts!.slice(1).map(Number) as [number, number, number],
    }))
    .sort(
      (a, b) =>
        a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2],
    );
  return versions[versions.length - 1]?.tag ?? null;
}

export async function snapshot(
  gh: GitHubJson,
  now: number = Date.now(),
): Promise<Snapshot> {
  const main = await mainState(gh);
  const tag = await latestReleaseTag(gh);
  const [production, pullRequests] = await Promise.all([
    tag
      ? releaseReport(gh, tag)
      : Promise.resolve<WatchReport>({
          status: "failed",
          summary: "no vX.Y.Z tag exists",
        }),
    pullRequestStates(gh, main.status, now),
  ]);
  return {
    takenAt: new Date(now).toISOString(),
    main,
    production: { tag, report: production },
    pullRequests,
  };
}

function since(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatSnapshot(value: Snapshot): string {
  const now = Date.parse(value.takenAt);
  const lines: string[] = [];
  const { main } = value;
  const short = (sha: string) => sha.slice(0, 9);

  if (main.status === "red") {
    lines.push(
      `main   RED for ${since(main.redSince ?? main.settled!.createdAt, now)} — run ${main.settled!.id} on ${short(main.settled!.sha)}`,
    );
    if (main.rerunning)
      lines.push(
        `       rerunning: run ${main.settled!.id} is on a new attempt`,
      );
    for (const job of main.failedJobs)
      lines.push(
        `       ✗ ${job.name}${job.conclusion === "failure" ? "" : ` (${job.conclusion})`}${job.steps.length ? ` › ${job.steps.join(", ")}` : ""}`,
      );
    if (main.lastGreen) {
      lines.push(
        `       landed since last green ${short(main.lastGreen.sha)}:`,
      );
      for (const suspect of main.suspects)
        lines.push(
          `         ${suspect.pullRequest ? `#${suspect.pullRequest}` : short(suspect.sha)}  ${suspect.title}`,
        );
    } else lines.push("       no green run in the last 40 — read further back");
  } else if (main.status === "green") {
    lines.push(
      `main   green — run ${main.settled!.id} on ${short(main.settled!.sha)}`,
    );
  } else lines.push("main   no settled run yet");
  if (main.running)
    lines.push(
      `       running: run ${main.running.id} on ${short(main.running.sha)}`,
    );

  const production = value.production;
  lines.push(
    `prod   ${production.report.status === "passed" ? "" : `${production.report.status.toUpperCase()}: `}${production.report.summary}`,
  );

  if (value.pullRequests.length === 0) lines.push("PRs    none open");
  value.pullRequests.forEach((pr, index) => {
    const idle =
      pr.idleMinutes === null
        ? ""
        : `, idle ${since(new Date(now - pr.idleMinutes * 60_000).toISOString(), now)}`;
    lines.push(
      `${index === 0 ? "PRs    " : "       "}#${pr.number}  ${pr.action.padEnd(6)}  ${pr.title} (${pr.reason}${idle})`,
    );
  });
  return lines.join("\n");
}

/** Runs `gh` and parses what it prints. */
export async function ghJson(args: readonly string[]): Promise<unknown> {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim() ? JSON.parse(stdout) : null;
}

if (import.meta.main) {
  const value = await snapshot(ghJson);
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(value, null, 2)
      : formatSnapshot(value),
  );
}

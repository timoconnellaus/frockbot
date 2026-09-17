// What a landed change obliges `main.yml` to run.
//
// Most pushes to `main` touch the application, and the slow tier — the
// Flutter client's suite, the Cloudflare workerd and integration suites and
// the browser suite across four runners — is the whole point of running it
// once per landed change. A few pushes cannot possibly affect any of them: the
// marketing site and the admin portal are separate Workers, deployed by their
// own release job, and nothing under `apps/cloudflare`, `core`, `app` or
// `providers` imports either one. For those, eleven minutes of suites prove
// nothing that the fast tier has not already proven.
//
// The fast tier is not negotiable and is not decided here. `validate` runs
// `format:check`, `typecheck` and the unit suite, and all three cover the
// marketing and admin workspaces like any other — the formatter reads the
// whole repository and the typechecker walks every workspace package. It also
// bundles those two sites, for the same reason: their only build must belong
// to the job a skip cannot reach.
//
// The direction of the default is the point. A path nobody has classified
// obliges the slow tier, so adding a directory, or a workspace, or a new kind
// of file is safe by omission. Only the listed prefixes and root Markdown buy
// a skip, and only when every changed path is one of them.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Every call here is about `root`, so inherited repository pointers must not
// redirect it. That filter is one invariant with one definition, in the
// validator, which learned it the hard way from its own hook and fixtures.
import { GIT_ENV } from "./validate";

/**
 * Directories whose contents cannot change what the slow tier asserts.
 *
 * `apps/marketing/` and `apps/admin-portal/` are each a deployable of their
 * own with no import path into the application under test. Adding a workspace
 * to this list means claiming the same of something else, which is a claim to
 * check rather than assume — the application's own suites are what would
 * otherwise catch being wrong.
 *
 * `docs/` is here for a different reason, and together with
 * `isRootMarkdown` it must keep agreeing with `main.yml`'s `paths-ignore`,
 * because the two make the same claim: documentation changes nothing
 * deployable. The trigger states it by refusing to start a run; this states it
 * by refusing to let such a path oblige the tier. They have to agree because
 * the measured range spans pushes the trigger never ran for — the base is the
 * newest release tag, not the previous push — so documentation the trigger
 * filtered out still reaches this classifier inside a later range. Change one
 * and change the other. `scripts/validate.ts`'s `ignoredWorkingPath` encodes
 * the identical rule locally for the identical reason.
 */
export const SLOW_TIER_IRRELEVANT_V1 = [
  "apps/marketing/",
  "apps/admin-portal/",
  "docs/",
] as const;

/**
 * Markdown at the repository root, and only there. Markdown anywhere else is
 * code — a Package may ship a Skill or a prompt as `.md` — so it stays
 * unclassified and obliges the tier.
 */
function isRootMarkdown(path: string): boolean {
  return !path.includes("/") && path.endsWith(".md");
}

/**
 * Whether the slow tier must run for a push that touched `paths`.
 *
 * True whenever anything is unrecognised, and true for an empty list: a range
 * whose changed paths could not be determined — no release tag to measure
 * from, a tag the checkout cannot resolve — must not be read as a range that
 * changed nothing.
 *
 * The caller is responsible for reporting a rename's source path as well as
 * its destination; a set that named only the destination would describe a file
 * moved out of the application as a change to the excused workspace alone.
 */
export function slowTierRequiredV1(paths: readonly string[]): boolean {
  if (paths.length === 0) return true;
  return !paths.every(
    (path) =>
      isRootMarkdown(path) ||
      SLOW_TIER_IRRELEVANT_V1.some((prefix) => path.startsWith(prefix)),
  );
}

/**
 * The changed paths, one per line, as `git diff --name-only` writes them.
 */
function parsePathsV1(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function git(root: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * The newest release tag reachable from `HEAD`, or null when there is none
 * this checkout can resolve.
 *
 * The range is measured from the last commit known to have passed, not from
 * the commit this push started at. A burst of merges collapses to the newest
 * head — that is what `main.yml`'s concurrency group is for — so the pushed
 * range alone would let a cancelled run's commits go unverified by anybody. A
 * tag is only ever cut after a run concluded, so everything since the newest
 * one is exactly what no run has yet accepted.
 */
function lastReleaseTagV1(root: string): string | null {
  const described = git(root, [
    "describe",
    "--tags",
    "--abbrev=0",
    "--match",
    "v[0-9]*.[0-9]*.[0-9]*",
    "HEAD",
  ]);
  return described?.trim() || null;
}

/**
 * What this checkout's unreleased range obliges, and the tag it measured
 * from — null when there was none to measure from, which the caller reports.
 *
 * A base that cannot be resolved, and a diff that cannot be read, both leave
 * no paths, and the classifier reads an empty list as absence of evidence and
 * obliges the whole tier.
 *
 * `--no-renames` because rename detection prints only a rename's destination,
 * so a file moved out of the application into an excused workspace would
 * present as an excused change alone.
 */
export function scopeDecisionV1(root: string): {
  base: string | null;
  slowTier: boolean;
} {
  const base = lastReleaseTagV1(root);
  const diff =
    base === null
      ? null
      : git(root, ["diff", "--no-renames", "--name-only", base, "HEAD"]);
  return {
    base,
    slowTier: slowTierRequiredV1(diff === null ? [] : parsePathsV1(diff)),
  };
}

// Decides for the checkout it runs in and appends the workflow output line to
// `GITHUB_OUTPUT`. The workflow step is this invocation and nothing else.
if (import.meta.main) {
  const { base, slowTier } = scopeDecisionV1(process.cwd());
  if (base === null)
    console.log(
      "::notice::No release tag is reachable from this head, so the range since the last verified commit could not be read; running the full tier.",
    );
  const line = `slow-tier=${slowTier}\n`;
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, line);
  else process.stdout.write(line);
}

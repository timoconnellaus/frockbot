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
// whole repository and the typechecker walks every workspace package.
//
// Documentation never reaches this code at all: `main.yml` ignores `docs/**`
// and root Markdown at its trigger, so a documentation-only push starts no run
// rather than starting one that skips everything.
//
// The direction of the default is the point. A path nobody has classified
// obliges the slow tier, so adding a directory, or a workspace, or a new kind
// of file is safe by omission. Only the two listed prefixes buy a skip, and
// only when every changed path is under one of them.

/**
 * Directories whose contents cannot change what the slow tier asserts.
 *
 * Each is a deployable of its own with no import path into the application
 * under test. Adding to this list means claiming the same of something else,
 * which is a claim to check rather than assume — the application's own suites
 * are what would otherwise catch being wrong.
 */
export const SLOW_TIER_IRRELEVANT_V1 = [
  "apps/marketing/",
  "apps/admin-portal/",
] as const;

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
  return !paths.every((path) =>
    SLOW_TIER_IRRELEVANT_V1.some((prefix) => path.startsWith(prefix)),
  );
}

/**
 * The changed paths, one per line, as `git diff --no-renames --name-only`
 * writes them.
 */
export function parsePathsV1(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Reads the changed paths on standard input and writes the workflow output
// line on standard output, so the caller can append it to `GITHUB_OUTPUT`.
if (import.meta.main) {
  const required = slowTierRequiredV1(parsePathsV1(await Bun.stdin.text()));
  console.log(`slow-tier=${required}`);
}

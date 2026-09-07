/**
 * `wrangler r2 object put` addresses a bucket by *name*, and the dogfood stack
 * seeds three things a fresh User needs before the Worker starts. A name that
 * drifts from the `development` environment in `apps/cloudflare/wrangler.jsonc`
 * seeds a bucket the Worker never opens, and nothing fails loudly: the Catalog
 * was seeded into `frockbot-package-catalog` while `development` read
 * `frockbot-package-catalog-development`, so `catalog/current` was never there
 * to pin, every fresh User went unpinned, and `package_search` refused on its
 * first call (finding F4).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");
const script = readFileSync(
  join(repoRoot, "scripts", "dogfood", "dev-stack.sh"),
  "utf8",
);
const wranglerSource = readFileSync(
  join(repoRoot, "apps", "cloudflare", "wrangler.jsonc"),
  "utf8",
);

/** Enough of JSONC for this file: comments and trailing commas. */
function parseJsonc(source: string): unknown {
  const withoutComments = source.replace(
    /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => (match.startsWith('"') ? match : ""),
  );
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1")) as unknown;
}

const wrangler = parseJsonc(wranglerSource) as {
  env: Record<
    string,
    {
      r2_buckets?: Array<{ binding: string; bucket_name: string }>;
      services?: Array<{ binding: string; service: string }>;
    }
  >;
};

/** The script's lines with the comment-only ones dropped. */
const commands = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"));

function shellAssignment(name: string): string | undefined {
  return new RegExp(`^${name}="([^"$]+)"$`, "m").exec(script)?.[1];
}

/** The pid files the stop path must scope every kill to. */
const PID_FILES = ["wrangler.pid", "vite.pid"];

describe("the dogfood dev stack", () => {
  const development = wrangler.env.development!;
  const buckets = new Map(
    (development.r2_buckets ?? []).map((bucket) => [
      bucket.binding,
      bucket.bucket_name,
    ]),
  );

  test.each([
    ["catalog_bucket", "PACKAGE_CATALOG"],
    ["artifact_bucket", "APPLICATION_ARTIFACTS"],
  ])("seeds %s into the bucket %s binds", (variable, binding) => {
    expect(shellAssignment(variable)).toBe(buckets.get(binding)!);
  });

  test("names no R2 bucket literally outside those two assignments", () => {
    const literals = commands
      .filter((line) => !/^[a-z_]+_bucket="/.test(line))
      .filter((line) =>
        /frockbot-(package-catalog|application-artifacts)/.test(line),
      );
    expect(literals).toEqual([]);
  });

  test("stops only the processes it started", () => {
    // A previous fix removed an unscoped `pkill -f workerd`, which killed the
    // Playwright harness's runtime mid-suite. Every kill must start from a
    // recorded pid, this stack's own command line, or this stack's own ports.
    expect(commands.filter((line) => /\bpkill\b/.test(line))).toEqual([]);
    for (const pidFile of PID_FILES) expect(script).toContain(pidFile);
  });
});

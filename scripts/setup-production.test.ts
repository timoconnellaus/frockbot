/// <reference types="bun" />
import { expect, test } from "bun:test";

test("setup wizard expands GITHUB_REPOSITORY before the Unicode ellipsis", async () => {
  const script = await Bun.file(
    new URL("./setup-production.sh", import.meta.url),
  ).text();

  const line = script
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith('step "Checking environment secrets in'));
  expect(line).toBeDefined();

  const proc = Bun.spawnSync([
    "bash",
    "-c",
    [
      'step() { printf "%s\\n" "$1"; }',
      "GITHUB_REPOSITORY=owner/repo",
      line!,
    ].join("\n"),
  ]);

  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain(
    "Checking environment secrets in owner/repo…",
  );
});

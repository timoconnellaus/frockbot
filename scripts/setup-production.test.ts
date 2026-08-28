/// <reference types="bun" />
import { expect, test } from "bun:test";

test("setup wizard provisions the Fly Sprites production secret", async () => {
  const [script, workflow] = await Promise.all([
    Bun.file(new URL("./setup-production.sh", import.meta.url)).text(),
    Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text(),
  ]);

  expect(script).toContain(
    'ask_secret SPRITES_TOKEN "Paste the Fly Sprites token:"',
  );
  expect(script).toContain(
    'set_production_secret SPRITES_TOKEN "$SPRITES_TOKEN"',
  );
  expect(workflow).toContain("SPRITES_TOKEN: ${{ secrets.SPRITES_TOKEN }}");
  expect(workflow).toContain("'SPRITES_TOKEN',");
});

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

/// <reference types="bun" />
import { expect, test } from "bun:test";

test("setup wizard braces GITHUB_REPOSITORY before the Unicode ellipsis", async () => {
  const script = await Bun.file(
    new URL("./setup-production.sh", import.meta.url),
  ).text();

  expect(script).toContain(
    'step "Checking environment secrets in ${GITHUB_REPOSITORY}…"',
  );
  expect(script).not.toContain(
    'step "Checking environment secrets in $GITHUB_REPOSITORY…"',
  );
});

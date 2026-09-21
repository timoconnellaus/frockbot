import { expect, test } from "bun:test";
import { $ } from "bun";

test("every catalog provider icon is mapped and present", async () => {
  const result = await $`python3 scripts/sync-connector-icons.py --check`;
  expect(result.exitCode).toBe(0);
});

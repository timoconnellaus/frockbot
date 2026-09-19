import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("native acceptance builds consume checked metadata", () => {
  const result = Bun.spawnSync([
    "python3",
    fileURLToPath(new URL("./native-acceptance-test.py", import.meta.url)),
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

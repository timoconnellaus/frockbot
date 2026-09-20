import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Python release tools reject malformed native metadata", () => {
  const result = Bun.spawnSync([
    "python3",
    fileURLToPath(new URL("./native-metadata-test.py", import.meta.url)),
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

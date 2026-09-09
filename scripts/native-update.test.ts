import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Android release and patch delivery preserves signing, versions, and download access", () => {
  const result = Bun.spawnSync([
    "python3",
    fileURLToPath(new URL("./native-update-test.py", import.meta.url)),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() + result.stdout.toString());
  }
  expect(result.exitCode).toBe(0);
}, 30_000);

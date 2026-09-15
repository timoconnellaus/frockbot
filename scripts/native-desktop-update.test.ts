import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the local Mac build installs as FrockBot Dev and never takes the released identity", () => {
  const result = Bun.spawnSync([
    "python3",
    fileURLToPath(new URL("./native-desktop-update-test.py", import.meta.url)),
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

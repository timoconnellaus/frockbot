import { expect, test } from "bun:test";
test("Mac release refuses unsuitable signing credentials before building", async () => {
  const process = Bun.spawn(["python3", "scripts/mac-release-test.py"], {
    cwd: import.meta.dirname + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
});

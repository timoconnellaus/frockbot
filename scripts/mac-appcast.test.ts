import { expect, test } from "bun:test";
test("Mac update feed is signed, single-release and never moves backwards", async () => {
  const process = Bun.spawn(["python3", "scripts/mac-appcast-test.py"], {
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

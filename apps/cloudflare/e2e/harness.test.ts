// `wrangler dev`'s workerd child is what holds the serving port and the
// Durable Object files, so tearing a tree down has to wait for the whole
// process group, not just the Node parent that happens to exit first.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { stopProcessTree } from "./harness.ts";

/**
 * Stands in for workerd: it takes its time leaving after the group is
 * signalled, and it outlives the parent that supervises it.
 */
const lingering = `
process.on("SIGTERM", () => {});
console.log("linger-ready");
setTimeout(() => process.exit(0), 1500);
`;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

test("stopProcessTree waits for the group, not just the parent", async () => {
  // The parent dies on the first SIGTERM; the lingerer it left in the group
  // does not.
  const child = spawn(
    "/bin/sh",
    ["-c", `"$LINGER" -e "$SCRIPT" & exec sleep 30`],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LINGER: process.execPath, SCRIPT: lingering },
    },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("the parent did not start");
  await new Promise<void>((ready, fail) => {
    child.once("error", fail);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("linger-ready")) ready();
    });
  });

  await stopProcessTree(child);

  expect(groupAlive(pid)).toBe(false);
}, 20_000);

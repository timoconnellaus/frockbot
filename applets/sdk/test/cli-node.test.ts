// The published CLI, run the way the Computer runs it: `node dist/cli.mjs`.
//
// Everything else in this suite imports the CLI's modules under Bun, which
// proves the logic and proves nothing about the shipped entry point. The
// Computer image has Node and no Bun, and these sources are TypeScript that
// resolve siblings through `.js` specifiers — so the one thing that can go
// wrong in production is precisely the thing an in-process test cannot see: a
// bundle Node refuses to load, a `bin` pointing at TypeScript, or an
// `import.meta.url` that resolves the SDK's own root to the wrong directory.
// This test spawns the real binary under the real `node`.
import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = join(packageRoot, "dist/cli.mjs");

interface Ran {
  code: number;
  output: string;
}

/** `Bun.spawn`, not `node:child_process`: the repository forbids the import. */
async function runNode(args: string[], cwd: string): Promise<Ran> {
  const child = Bun.spawn({
    cmd: ["node", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, output: `${stdout}${stderr}` };
}

describe("the published `applet` binary under plain Node", () => {
  it("scaffolds, checks, and builds the template with no Bun anywhere", async () => {
    // Built here rather than assumed: a stale `dist/` would make this test
    // green about a bundle nobody ships.
    const build = Bun.spawnSync({
      cmd: ["bun", join(packageRoot, "scripts/build-cli.ts")],
      cwd: packageRoot,
    });
    expect(build.exitCode).toBe(0);

    const parent = await mkdtemp(join(tmpdir(), "applet-node-cli-"));
    const scaffolded = await runNode([cli, "new", "Weekly Todos"], parent);
    expect(scaffolded.output).toContain("weekly-todos");
    expect(scaffolded.code).toBe(0);

    const directory = join(parent, "weekly-todos");
    const checked = await runNode([cli, "check"], directory);

    expect(checked.output).toContain("applet check: no problems found");
    expect(checked.code).toBe(0);

    const built = await runNode([cli, "build"], directory);

    expect(built.output).toContain(join(directory, "dist/server.js"));
    expect(built.output).toContain(join(directory, "dist/ui.html"));
    expect(built.output).toContain("2 tool(s): add_todo, list_todos");
    expect(built.code).toBe(0);
  }, 180_000);
});

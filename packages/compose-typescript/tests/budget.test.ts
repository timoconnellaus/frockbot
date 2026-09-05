import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { rolldown } from "rolldown";
import { createTypeScriptChecker } from "../src/index";
import { toolsStub } from "./helpers/entry";

const here = dirname(fileURLToPath(import.meta.url));

/** A ~30-line written plugin: what a model rewrites several times in a turn. */
const thirtyLines = `interface Entry {
  readonly name: string
  readonly count: number
}

const seen = new Map<string, number>()

const setup: Setup = async ({ id, stubs }) => {
  await stubs.tools({ name: id + '.count', handler: 'count' })
  await stubs.tools({ name: id + '.report', handler: 'report' })
  return () => {
    seen.clear()
  }
}
export default setup

export function count(input: { name: string }): Entry {
  const next = (seen.get(input.name) ?? 0) + 1
  seen.set(input.name, next)
  return { name: input.name, count: next }
}

export function report(): Array<Entry> {
  const entries: Array<Entry> = []
  for (const [name, count] of seen) {
    entries.push({ name, count })
  }
  entries.sort((a, b) => b.count - a.count)
  return entries
}
`;

const request = (source: string) => ({
  baseVersion: "test",
  instanceId: "budget",
  source,
  declarations: toolsStub.declarations,
  grants: [{ name: "tools", declarations: toolsStub.declarations }],
});

describe("what the checker costs", () => {
  it("stays within its 1.5 MB min+gzip size budget", async () => {
    const bundle = await rolldown({
      input: join(here, "../src/index.ts"),
      external: ["@frockbot/compose-core"],
      logLevel: "silent",
    });
    const { output } = await bundle.generate({ format: "esm", minify: true });
    await bundle.close();
    const code = output
      .filter((chunk) => chunk.type === "chunk")
      .map((chunk) => chunk.code)
      .join("");
    const bytes = gzipSync(Buffer.from(code, "utf8"), { level: 9 }).byteLength;

    // Recorded in DESIGN.md and README.md. In a Worker this stays a separate
    // lazy chunk, so startup evaluates it only when the first check needs it.
    console.log(
      `checker bundle: ${(bytes / 1024 / 1024).toFixed(2)} MB min+gzip`,
    );
    expect(bytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  }, 120_000);

  it("checks a ~30-line plugin in under 40 ms once warm", async () => {
    expect(thirtyLines.split("\n").length).toBeGreaterThanOrEqual(28);
    const checker = createTypeScriptChecker();

    const cold = Date.now();
    expect((await checker.check(request(thirtyLines))).code).toBeTypeOf(
      "string",
    );
    const coldMs = Date.now() - cold;

    // Each edit is a fresh source in the same declaration environment, which is
    // what a model rewriting its plugin actually does.
    // The median of the runs is the figure: a single garbage-collection pause
    // or a busy neighbour in a parallel test run should not fail the budget.
    const runs = 20;
    const timings: Array<number> = [];
    for (let index = 0; index < runs; index += 1) {
      const source = thirtyLines
        .replace("const seen", `const seen${index}`)
        .replaceAll("seen.", `seen${index}.`)
        .replaceAll("seen)", `seen${index})`);
      const started = performance.now();
      const result = await checker.check(request(source));
      timings.push(performance.now() - started);
      expect(result.diagnostics).toBeUndefined();
    }
    const warmMs = timings.sort((a, b) => a - b)[Math.floor(runs / 2)]!;

    console.log(
      `check: ${coldMs} ms cold, ${warmMs.toFixed(1)} ms warm (median)`,
    );
    expect(warmMs).toBeLessThanOrEqual(40);
  }, 120_000);
});

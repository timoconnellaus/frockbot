import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "docs-only.sh");

async function classify(paths: string[]): Promise<boolean> {
  const proc = Bun.spawn(["bash", script], {
    stdin: new TextEncoder().encode(paths.map((path) => `${path}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

describe("scripts/docs-only.sh", () => {
  test("a plan, an ADR, and a root README are documentation", async () => {
    expect(
      await classify([
        "docs/plans/voice.md",
        "docs/adr/0029-voice.md",
        "README.md",
        "AGENTS.md",
      ]),
    ).toBe(true);
  });

  test("an image under docs/ is documentation", async () => {
    expect(await classify(["docs/screenshots/applets/canvas.png"])).toBe(true);
  });

  test("one code path makes the whole change code", async () => {
    expect(
      await classify([
        "docs/plans/voice.md",
        "packages/plugin-shell/src/agent.ts",
      ]),
    ).toBe(false);
  });

  test("Markdown outside docs/ and the root is code", async () => {
    expect(await classify(["packages/plugin-skills/skills/deploy.md"])).toBe(
      false,
    );
    expect(await classify([".github/PULL_REQUEST_TEMPLATE.md"])).toBe(false);
  });

  test("the workflow that decides this is code", async () => {
    expect(await classify([".github/workflows/ci.yml"])).toBe(false);
  });

  test("an empty change is not documentation", async () => {
    expect(await classify([])).toBe(false);
    expect(await classify([""])).toBe(false);
  });
});

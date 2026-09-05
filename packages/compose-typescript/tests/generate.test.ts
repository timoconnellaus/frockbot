import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { createTypeScriptChecker } from "../src";
import { generateDeclarations } from "../src/generate";

const entry = resolve(import.meta.dir, "fixtures/base.ts");

describe("generated base declarations", () => {
  it("prints method calls, source type aliases and a stable content version", () => {
    const generated = generateDeclarations({ entry, exportName: "testBase" });

    expect(generated.text).toMatch(
      /type RecordRow = \{\s+id: number;\s+label: string;\s+\}/,
    );
    expect(generated.text).toContain(
      "rows(filter: { prefix?: string; }): Promise<RecordRow[]>",
    );
    expect(generated.version).toBe(
      createHash("sha256").update(generated.text).digest("hex"),
    );
    expect(generateDeclarations({ entry, exportName: "testBase" })).toEqual(
      generated,
    );
  });

  it("checks source against the generated method shape", async () => {
    const generated = generateDeclarations({ entry, exportName: "testBase" });
    const checker = createTypeScriptChecker({
      baseDeclarations: generated.text,
      baseVersion: generated.version,
    });
    const result = await checker.check({
      baseVersion: generated.version,
      instanceId: "written",
      source: `const setup: Setup = async ({ stubs }) => {
  const rows = await stubs.data.rows({ prefix: 'a' })
  const first: number = rows[0]!.id
  void first
}
export default setup`,
      declarations: "",
      grants: [{ name: "data", declarations: "" }],
    });

    expect(result.diagnostics).toBeUndefined();
    expect(result.code).toBeTypeOf("string");
  });
});

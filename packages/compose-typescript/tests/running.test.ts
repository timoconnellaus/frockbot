import { describe, expect, it } from "bun:test";
import { createTypeScriptChecker } from "../src/index";
import { outcome, registryKey, toolsStub, write } from "./helpers/entry";
import { adder } from "./helpers/sources";

describe("source that type-checks", () => {
  it("starts in the in-process host and registers through its stub", async () => {
    const client = await write(adder);
    const { snapshot, detail } = outcome(client);

    expect(detail).toBeUndefined();
    expect(snapshot?.status).toBe("active");
    expect(
      await client.getContext(registryKey)!.call("written", { a: 2, b: 3 }),
    ).toBe(5);
  });

  it("releases what it registered when the entry is removed", async () => {
    const client = await write(adder);
    await client.removePlugin("written");

    expect(client.resources("written")).toBeUndefined();
    expect(client.inspect().map((one) => one.id)).toEqual(["registry"]);
  });

  it("hands the host plain JavaScript, not the TypeScript it was given", async () => {
    const result = await createTypeScriptChecker().check({
      baseVersion: "test",
      instanceId: "written",
      source: adder,
      declarations: toolsStub.declarations,
      grants: [{ name: "tools", declarations: toolsStub.declarations }],
    });

    const code = result.code!;
    expect(code).not.toContain(": Setup");
    expect(code).not.toContain("input: { a: number; b: number }");
    expect(code).toContain("export default setup");
    // Transpiled, not re-emitted: the same statements, in the same order.
    expect(code).toContain("await stubs.tools({ name: id, handler: 'add' })");
  });
});

import { describe, expect, it } from "bun:test";
import { createTypeScriptChecker } from "../../src/index";

const logGrant = {
  name: "log",
  declarations: "declare const log: (message: string) => Promise<void>",
};

const request = (argument: string) => ({
  baseVersion: "test",
  instanceId: "workerd-smoke",
  declarations: logGrant.declarations,
  grants: [logGrant],
  source: [
    "const setup: Setup = async ({ stubs }) => {",
    `  await stubs.log(${argument})`,
    "}",
    "export default setup",
  ].join("\n"),
});

describe("the TypeScript checker under workerd", () => {
  it("checks passing and failing source against a grant", async () => {
    const checker = createTypeScriptChecker();

    const passing = await checker.check(request("'ready'"));
    expect(passing.code).toContain("await stubs.log('ready')");
    expect(passing.diagnostics).toBeUndefined();

    const failing = await checker.check(request("42"));
    expect(failing.code).toBeUndefined();
    expect(failing.diagnostics).toHaveLength(1);
    expect(failing.diagnostics?.[0]?.message).toContain(
      "Argument of type 'number' is not assignable to parameter of type 'string'",
    );
  });
});

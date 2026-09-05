import ts from "typescript";
import { describe, expect, it } from "bun:test";
import {
  baseDeclarations,
  createTypeScriptChecker,
  pluginDeclarations,
} from "../src/index";
import { logStub, toolsStub } from "./helpers/entry";
import { adder } from "./helpers/sources";
import type { AnyStubGrant, SourceDiagnostic } from "@frockbot/compose-core";

const grantsOf = (...stubs: Array<AnyStubGrant>) =>
  stubs.map((stub) => ({ name: stub.name, declarations: stub.declarations }));

const check = async (
  source: string,
  grants: Array<{ name: string; declarations: string }>,
): Promise<Array<SourceDiagnostic>> => {
  const result = await createTypeScriptChecker().check({
    baseVersion: "test",
    instanceId: "draft",
    source,
    declarations: grants.map((one) => one.declarations).join("\n"),
    grants,
  });
  return result.diagnostics ?? [];
};

/** The type names a declaration text declares at its top level. */
function declaredTypes(text: string): Array<string> {
  const file = ts.createSourceFile(
    "declarations.d.ts",
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  return file.statements
    .filter(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement),
    )
    .map((statement) => (statement as ts.TypeAliasDeclaration).name.text);
}

describe("the declarations a written plugin is shown", () => {
  it("are the base shape, then each grant verbatim, then the stubs type", () => {
    const text = pluginDeclarations(grantsOf(toolsStub, logStub));

    expect(text.startsWith(baseDeclarations)).toBe(true);
    expect(text).toContain(toolsStub.declarations);
    expect(text).toContain(logStub.declarations);
    expect(text.indexOf(toolsStub.declarations)).toBeLessThan(
      text.indexOf(logStub.declarations),
    );
    expect(text).toContain(
      "interface Stubs {\n  readonly tools: typeof tools\n  readonly log: typeof log\n}",
    );
  });

  it("leak no `any` from the shape this package ships", () => {
    // A grant may say what it likes; the base shape may not, because an `any`
    // here would quietly accept source that is wrong about its own contract.
    expect(baseDeclarations).not.toMatch(/\bany\b/);
  });

  it("give an entry with no grants a stubs type with nothing on it", () => {
    expect(pluginDeclarations([])).toBe(
      `${baseDeclarations}\n/** The stubs this entry was granted. */\ninterface Stubs {}\n`,
    );
  });

  it("are exactly what the check compiles against", async () => {
    // Every type the text declares is in scope during a check, and a name it
    // does not declare is not: the text is the environment, not a description
    // of one.
    const grants = grantsOf(toolsStub, logStub);
    const names = declaredTypes(pluginDeclarations(grants));
    expect(names).toEqual([
      "Cleanup",
      "SetupArgument",
      "Setup",
      "Handler",
      "Stubs",
    ]);

    const probes = names.map((name, index) => `type Probe${index} = ${name}`);
    const source = [
      "const setup: Setup = () => {}",
      "export default setup",
      ...probes,
    ].join("\n");

    expect(await check(source, grants)).toEqual([]);
    expect(await check(`${source}\ntype Absent = NotDeclared`, grants)).toEqual(
      [
        {
          line: probes.length + 3,
          column: 15,
          message: "Cannot find name 'NotDeclared'.",
        },
      ],
    );
  });

  it("say what the entry may reach, not a shared vocabulary", async () => {
    const source = [
      "const setup: Setup = async ({ stubs }) => {",
      "  await stubs.log('hello')",
      "}",
      "export default setup",
    ].join("\n");

    expect(await check(source, grantsOf(logStub))).toEqual([]);
    expect(await check(source, grantsOf(toolsStub))).toHaveLength(1);
    expect(await check(source, [])).toHaveLength(1);
  });

  it("let a plugin written against them run with no casts", async () => {
    expect(adder).not.toContain(" as ");
    expect(await check(adder, grantsOf(toolsStub))).toEqual([]);
  });
});

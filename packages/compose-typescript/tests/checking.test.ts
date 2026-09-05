import { describe, expect, it } from "bun:test";
import { createTypeScriptChecker } from "../src/index";
import { logStub, outcome, toolsStub, write } from "./helpers/entry";
import type { SourceDiagnostic } from "@frockbot/compose-core";

/** Check one source outside a client, with the tools stub granted. */
const check = async (source: string): Promise<Array<SourceDiagnostic>> =>
  (
    (await createTypeScriptChecker().check({
      baseVersion: "test",
      instanceId: "draft",
      source,
      declarations: toolsStub.declarations,
      grants: [{ name: "tools", declarations: toolsStub.declarations }],
    })) as { diagnostics?: Array<SourceDiagnostic> }
  ).diagnostics ?? [];

describe("source that does not type-check", () => {
  it("is not started, and the entry says the check is what failed", async () => {
    const client = await write(
      [
        "const setup: Setup = async ({ stubs }) => {",
        "  await stubs.tools({ name: 42, handler: 'add' })",
        "}",
        "export default setup",
      ].join("\n"),
    );
    const { snapshot, detail } = outcome(client);

    expect(snapshot?.status).toBe("error");
    expect(detail?.phase).toBe("check");
    expect(detail?.diagnostics?.[0]?.line).toBe(2);
    expect(detail?.diagnostics?.[0]?.column).toBe(23);
    expect(detail?.diagnostics?.[0]?.message).toContain(
      "Type 'number' is not assignable to type 'string'",
    );
    // Nothing else in the client noticed.
    expect(client.inspect().find((one) => one.id === "registry")?.status).toBe(
      "active",
    );
  });

  it("reports a misuse of a granted stub at the line and column it is on", async () => {
    const diagnostics = await check(
      [
        "const setup: Setup = async ({ stubs }) => {",
        "  await stubs.tools({ name: 'add' })",
        "}",
        "export default setup",
      ].join("\n"),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.column).toBe(21);
    expect(diagnostics[0]?.message).toContain("'handler' is missing");
  });

  it("is a type error to name a stub the entry was not granted", async () => {
    const diagnostics = await check(
      [
        "const setup: Setup = async ({ stubs }) => {",
        "  await stubs.log('hello')",
        "}",
        "export default setup",
      ].join("\n"),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toBe(
      "Property 'log' does not exist on type 'Stubs'.",
    );
  });

  it("accepts the same source once the stub is granted", async () => {
    const source = [
      "const setup: Setup = async ({ stubs }) => {",
      "  await stubs.log('hello')",
      "}",
      "export default setup",
    ].join("\n");

    expect(outcome(await write(source, [toolsStub])).snapshot?.status).toBe(
      "error",
    );
    expect(
      outcome(await write(source, [toolsStub, logStub])).snapshot?.status,
    ).toBe("active");
  });

  it("is a type error to reach a granted stub as a bare global", async () => {
    const diagnostics = await check(
      [
        "const setup: Setup = async () => {",
        "  await tools({ name: 'add', handler: 'add' })",
        "}",
        "export default setup",
      ].join("\n"),
    );

    expect(diagnostics).toEqual([
      {
        line: 2,
        column: 9,
        message:
          '"tools" is a stub: reach it through the setup argument, as stubs.tools',
      },
    ]);
  });

  it("leaves a local of the same name alone", async () => {
    expect(
      await check(
        [
          "const setup: Setup = async ({ stubs }) => {",
          "  const tools = stubs.tools",
          "  await tools({ name: 'add', handler: 'add' })",
          "}",
          "export default setup",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("is a type error to use a DOM global", async () => {
    const diagnostics = await check(
      [
        "const setup: Setup = () => {",
        '  document.title = "hello"',
        "}",
        "export default setup",
      ].join("\n"),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.column).toBe(3);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'document'");
  });

  it("is a type error to import anything", async () => {
    const diagnostics = await check(
      [
        "import { readFile } from 'node:fs'",
        "const setup: Setup = () => {",
        "  void readFile",
        "}",
        "export default setup",
      ].join("\n"),
    );

    expect(diagnostics[0]?.line).toBe(1);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'node:fs'");
  });

  it("reports a syntax error as a diagnostic, not as a thrown exception", async () => {
    const client = await write("export default function ( {");
    const { snapshot, detail } = outcome(client);

    expect(snapshot?.status).toBe("error");
    // Same phase, same shape as a type error: one recovery loop for both.
    expect(detail?.phase).toBe("check");
    expect(detail?.diagnostics?.[0]?.line).toBe(1);
    expect(detail?.diagnostics?.[0]?.message).toBeTruthy();
  });

  it("orders diagnostics by position", async () => {
    const diagnostics = await check(
      [
        "const setup: Setup = async ({ stubs }) => {",
        "  const first: string = 1",
        '  const second: number = "two"',
        "  await stubs.nope()",
        "}",
        "export default setup",
      ].join("\n"),
    );

    expect(diagnostics.map((one) => one.line)).toEqual([2, 3, 4]);
  });
});

describe("the module shape the declarations describe", () => {
  it("requires a default export, and says so when there is none", async () => {
    const diagnostics = await check("export async function add() { return 1 }");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("default");
  });

  it("requires the default export to be a setup function", async () => {
    const diagnostics = await check("export default 42");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(1);
    expect(diagnostics[0]?.message).toContain("type 'Setup'");
  });

  it("requires every named export to be a callable handler", async () => {
    const diagnostics = await check(
      [
        "const setup: Setup = () => {}",
        "export default setup",
        "export const version = '1'",
      ].join("\n"),
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(3);
    expect(diagnostics[0]?.message).toContain("type 'Handler'");
  });
});

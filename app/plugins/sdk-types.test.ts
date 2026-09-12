/**
 * `@frockbot/applet-sdk/plugin` is types only and imports nothing from the
 * kernel, so nothing but this test keeps its `PluginContext` in step with the
 * `ctx` the wrapper really builds. The generated catalog is the kernel's
 * statement of that shape; the declaration file is parsed here and its members
 * compared, name for name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  BOT_ISOLATE_CONTEXT_KEYS_V1,
  BOT_ISOLATE_HOOK_EVENTS_V1,
  PLUGIN_GRANTS_V1,
} from "@frockbot/core/contracts";

const DECLARATIONS = new URL(
  "../../applets/sdk/plugin/index.d.ts",
  import.meta.url,
);

function source(): ts.SourceFile {
  return ts.createSourceFile(
    "index.d.ts",
    readFileSync(DECLARATIONS, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function interfaceMembers(name: string): string[] {
  const declaration = source().statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration) throw new Error(`no interface ${name}`);
  return declaration.members.map((member) =>
    member.name &&
    (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
      ? member.name.text
      : "",
  );
}

function unionLiterals(name: string): string[] {
  const declaration = source().statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  if (!declaration || !ts.isUnionTypeNode(declaration.type)) {
    throw new Error(`no union type ${name}`);
  }
  return declaration.type.types.map((type) =>
    ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)
      ? type.literal.text
      : "",
  );
}

describe("the Plugin SDK declarations", () => {
  test("PluginContext names exactly the ctx members the wrapper builds", () => {
    expect(interfaceMembers("PluginContext")).toEqual([
      ...BOT_ISOLATE_CONTEXT_KEYS_V1,
    ]);
  });

  test("the hook events and grants are the kernel's, in the kernel's order", () => {
    expect(unionLiterals("PluginHookEvent")).toEqual([
      ...BOT_ISOLATE_HOOK_EVENTS_V1,
    ]);
    expect(unionLiterals("PluginGrant")).toEqual([...PLUGIN_GRANTS_V1]);
  });

  test("PluginHookPayloads covers every hook event once", () => {
    expect(interfaceMembers("PluginHookPayloads")).toEqual([
      ...BOT_ISOLATE_HOOK_EVENTS_V1,
    ]);
    expect(interfaceMembers("PluginHookReplacements")).toEqual([
      ...BOT_ISOLATE_HOOK_EVENTS_V1,
    ]);
  });
});

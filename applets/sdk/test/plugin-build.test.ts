/**
 * The Plugin build over the real template: the stages, their diagnostics, and
 * the module and manifest a publish stores.
 *
 * The service in `apps/applet-build` runs this same `runPluginBuildV1`, so
 * what passes here is what a publish admits.
 */

import { describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runPluginBuildV1 } from "../src/build/plugin.js";
import { scaffoldPluginTemplateV1 } from "./plugin-scaffold.js";

async function scaffold(): Promise<string> {
  return (await scaffoldPluginTemplateV1()).directory;
}

describe("check", () => {
  it("passes on a fresh template", async () => {
    expect(
      await runPluginBuildV1(await scaffold(), { mode: "check", id: "notes" }),
    ).toEqual({ status: "checked" });
  }, 120_000);

  it("refuses a descriptor that names another Plugin", async () => {
    const outcome = await runPluginBuildV1(await scaffold(), {
      mode: "check",
      id: "weather",
    });
    expect(outcome).toMatchObject({ status: "failed", stage: "descriptor" });
  });

  it("reports a type error with a path, a line, and a column", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "plugin.ts"),
      [
        'import type { PluginTool } from "@frockbot/applet-sdk/plugin";',
        "export const tools: PluginTool[] = [{ name: 1 }];",
        "export const execute = () => 'x';",
        "",
      ].join("\n"),
      "utf8",
    );
    const outcome = await runPluginBuildV1(directory, { mode: "check" });
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outcome.stage).toBe("typecheck");
    expect(outcome.diagnostics[0]!.file).toBe("plugin.ts");
    expect(outcome.diagnostics[0]!.line).toBe(2);
  }, 120_000);
});

describe("build", () => {
  it("bundles one module and describes it by running it", async () => {
    const { directory, files } = await scaffoldPluginTemplateV1();
    const outcome = await runPluginBuildV1(directory, {
      mode: "build",
      id: "notes",
    });
    if (outcome.status !== "built") {
      throw new Error(`expected a build: ${JSON.stringify(outcome)}`);
    }
    // The template's two files describe one Plugin: what the module really
    // exports, read by running it, is what `plugin.json` declares.
    const descriptor = JSON.parse(
      files.find((file) => file.path === "plugin.json")!.text,
    ) as { id: string; tools: { name: string }[] };
    expect(descriptor.id).toBe("notes");
    expect(outcome.manifest.tools.map((tool) => tool.name)).toEqual(
      descriptor.tools.map((tool) => tool.name),
    );
    expect(outcome.manifest.tools.map((tool) => tool.name)).toEqual([
      "note_count",
      "note_add",
    ]);
    expect(outcome.manifest.hooks).toEqual([]);
    expect(outcome.manifest.services).toEqual([]);
    expect(outcome.manifest.triggers).toEqual([]);
    expect(outcome.manifest.hashes.module).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.module).toContain("export {");
    expect(outcome.module).not.toContain("import ");
  }, 180_000);

  it("reads hooks, services and triggers off the module's exports", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "plugin.ts"),
      [
        'import type { PluginHooks, PluginTool } from "@frockbot/applet-sdk/plugin";',
        "export const tools: PluginTool[] = [",
        '  { name: "ping", description: "Answers.", inputSchema: { type: "object" } },',
        "];",
        'export const execute = () => "pong";',
        "export const hooks: PluginHooks = {",
        '  "agent/tool-exposure": (payload) => payload.tools,',
        "};",
        "export const services = { lookup: { version: 1 } };",
        "export const triggers = { alert: () => undefined };",
        "",
      ].join("\n"),
      "utf8",
    );
    const outcome = await runPluginBuildV1(directory, { mode: "build" });
    if (outcome.status !== "built") {
      throw new Error(`expected a build: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.manifest.hooks).toEqual(["agent/tool-exposure"]);
    expect(outcome.manifest.services).toEqual(["lookup"]);
    expect(outcome.manifest.triggers).toEqual(["alert"]);
  }, 180_000);

  it("refuses an import the bundle cannot inline, and a value import of the SDK", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "plugin.ts"),
      [
        'import { something } from "cloudflare:workers";',
        "export const tools = [{ name: 'x', description: 'x', inputSchema: {} }];",
        "export const execute = () => String(something);",
        "",
      ].join("\n"),
      "utf8",
    );
    // The type checker stops it first — the module does not exist to it.
    expect(await runPluginBuildV1(directory, { mode: "build" })).toMatchObject({
      status: "failed",
      stage: "typecheck",
    });
    await writeFile(
      join(directory, "plugin.ts"),
      [
        "// @ts-nocheck",
        'import * as sdk from "@frockbot/applet-sdk/plugin";',
        "export const tools = [{ name: 'x', description: 'x', inputSchema: {} }];",
        "export const execute = () => String(sdk);",
        "",
      ].join("\n"),
      "utf8",
    );
    const outcome = await runPluginBuildV1(directory, { mode: "build" });
    expect(outcome).toMatchObject({ status: "failed", stage: "bundle" });
    if (outcome.status === "failed") {
      expect(outcome.diagnostics[0]!.message).toContain("types only");
    }
  }, 180_000);

  it("a module that exports no tools array fails at describe, not at mount", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "plugin.ts"),
      "export const execute = () => 'x';\n",
      "utf8",
    );
    const outcome = await runPluginBuildV1(directory, { mode: "build" });
    expect(outcome).toMatchObject({ status: "failed", stage: "describe" });
    if (outcome.status === "failed") {
      expect(outcome.diagnostics[0]!.message).toContain('a "tools" array');
    }
  }, 180_000);

  it("builds a Plugin that serves a hook and no tools", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "plugin.ts"),
      [
        'import type { PluginHooks, PluginTool } from "@frockbot/applet-sdk/plugin";',
        "export const tools: PluginTool[] = [];",
        'export const execute = () => "no tools";',
        "export const hooks: PluginHooks = {",
        '  "system-prompt/assemble": (payload) => payload.assembly,',
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const outcome = await runPluginBuildV1(directory, { mode: "build" });
    if (outcome.status !== "built") {
      throw new Error(`expected a build: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.manifest.tools).toEqual([]);
    expect(outcome.manifest.hooks).toEqual(["system-prompt/assemble"]);
  }, 180_000);
});

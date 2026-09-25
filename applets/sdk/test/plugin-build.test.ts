/**
 * The Plugin build over the real template: the stages, their diagnostics, and
 * the module and manifest a publish stores.
 *
 * The service in `apps/applet-build` runs this same `runPluginBuildV1`, so
 * what passes here is what a publish admits.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundlePlugin, runPluginBuildV1 } from "../src/build/plugin.js";
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
  it("emits identical module bytes from different and symlinked roots", async () => {
    const first = await scaffoldPluginTemplateV1({ prefix: "plugin-first-" });
    const second = await scaffoldPluginTemplateV1({
      prefix: "plugin-second-",
    });
    const pluginSource = [
      'import { answer } from "./..hidden/value";',
      'export const tools = [{ name: "answer", description: "Answers.", inputSchema: { type: "object" } }];',
      "export const execute = () => answer;",
      "",
    ].join("\n");
    for (const directory of [first.directory, second.directory]) {
      await writeFile(join(directory, "plugin.ts"), pluginSource, "utf8");
      await mkdir(join(directory, "..hidden"));
      await writeFile(
        join(directory, "..hidden", "value.ts"),
        "export const answer = 42;\n",
        "utf8",
      );
    }

    const firstModule = await bundlePlugin(first.directory);
    expect(await bundlePlugin(second.directory)).toBe(firstModule);
    expect(firstModule).toContain("// ..hidden/value.ts");
    expect(firstModule).toContain("// plugin.ts");

    const linkParent = await mkdtemp(join(tmpdir(), "plugin-link-"));
    const linkedDirectory = join(linkParent, "source");
    try {
      await symlink(first.directory, linkedDirectory, "dir");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      throw error;
    }
    expect(await bundlePlugin(linkedDirectory)).toBe(firstModule);
  });

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
    expect(outcome.manifest.views).toEqual([]);
    expect(outcome.manifest.hashes.module).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.module).toContain("export {");
    expect(outcome.module).not.toContain("import ");
  }, 180_000);

  it("reads hooks, services, triggers and views off the module's exports", async () => {
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
        'export const views = { "ping.settings": () => undefined };',
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
    expect(outcome.manifest.views).toEqual(["ping.settings"]);
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

describe("a device module", () => {
  async function withModule(source: string): Promise<string> {
    const directory = await scaffold();
    const descriptor = JSON.parse(
      await Bun.file(join(directory, "plugin.json")).text(),
    ) as Record<string, unknown>;
    await writeFile(
      join(directory, "plugin.json"),
      JSON.stringify({
        ...descriptor,
        grants: [...(descriptor.grants as string[]), "device"],
        device: {
          abilities: [],
          modules: [
            {
              id: "bridge",
              platforms: ["macos"],
              read: ["~/notes"],
              net: [],
              appleEvents: [],
              calls: ["count"],
              events: [],
            },
          ],
        },
      }),
      "utf8",
    );
    await mkdir(join(directory, "modules"), { recursive: true });
    await writeFile(join(directory, "modules", "bridge.ts"), source, "utf8");
    return directory;
  }

  const MODULE_SOURCE = [
    'import { readdir } from "node:fs/promises";',
    'import type { ModuleCalls } from "@frockbot/applet-sdk/module";',
    "export const calls = {",
    "  count: async (input: unknown, context) => {",
    '    context.log("log", "counting");',
    "    return (await readdir(String(input))).length;",
    "  },",
    "} satisfies ModuleCalls;",
    "",
  ].join("\n");

  it("is checked against Node and the module SDK, apart from the Worker", async () => {
    const directory = await withModule(MODULE_SOURCE);
    expect(await runPluginBuildV1(directory, { mode: "check" })).toEqual({
      status: "checked",
    });
  }, 120_000);

  it("is bundled for Deno, and its calls are read from its type", async () => {
    const directory = await withModule(MODULE_SOURCE);
    const outcome = await runPluginBuildV1(directory, { mode: "build" });
    if (outcome.status !== "built") {
      throw new Error(`expected a build: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.manifest.modules).toEqual([
      {
        id: "bridge",
        calls: ["count"],
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    const code = outcome.modules[0]!.code;
    expect(code).toContain('from "node:fs/promises"');
    expect(code).not.toContain("@frockbot/applet-sdk");
  }, 180_000);

  it("reports a missing source and a missing calls export", async () => {
    const missing = await scaffold();
    const descriptor = await withModule("export {};\n");
    const noCalls = await runPluginBuildV1(descriptor, { mode: "check" });
    expect(noCalls).toMatchObject({ status: "failed", stage: "typecheck" });
    if (noCalls.status === "failed") {
      expect(noCalls.diagnostics[0]!.message).toContain('export "calls"');
    }
    await writeFile(
      join(missing, "plugin.json"),
      await Bun.file(join(descriptor, "plugin.json")).text(),
      "utf8",
    );
    const absent = await runPluginBuildV1(missing, { mode: "check" });
    expect(absent).toMatchObject({ status: "failed", stage: "typecheck" });
    if (absent.status === "failed") {
      expect(absent.diagnostics[0]!.message).toContain("does not exist");
    }
  }, 120_000);
});

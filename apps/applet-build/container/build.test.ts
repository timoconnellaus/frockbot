/**
 * A Plugin posted to the build service is the module `runPluginBuildV1` writes
 * beside it: one file, and the exports read by running that file.
 */

import { describe, expect, test } from "bun:test";
import { scaffoldPluginTemplateV1 } from "../../../applets/sdk/test/plugin-scaffold.ts";
import { buildAppletRequestV1 } from "./build.ts";

describe("the Plugin build service", () => {
  test("builds a Plugin from the same route: one module, and what it exports", async () => {
    const { files } = await scaffoldPluginTemplateV1({
      prefix: "plugin-build-golden-",
    });
    const built = await buildAppletRequestV1({
      version: 1,
      effectId: "effect-6",
      kind: "plugin",
      id: "notes",
      mode: "build",
      files,
    });
    expect(built.status).toBe("built");
    if (built.status !== "built" || !("module" in built)) {
      throw new Error("expected a Plugin build");
    }
    expect(built.manifest.tools.map((tool) => tool.name)).toEqual([
      "note_count",
      "note_add",
    ]);
    expect(built.manifest.hashes.module).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await buildAppletRequestV1({
        version: 1,
        effectId: "effect-7",
        kind: "plugin",
        id: "notes",
        mode: "check",
        files,
      }),
    ).toEqual({ status: "built" });
    expect(
      await buildAppletRequestV1({
        version: 1,
        effectId: "effect-8",
        kind: "plugin",
        id: "weather",
        mode: "check",
        files,
      }),
    ).toMatchObject({ status: "failed", stage: "descriptor" });
  }, 180_000);

  test("refuses a Plugin manifest over the ceiling a publish stores", async () => {
    const { files } = await scaffoldPluginTemplateV1({
      prefix: "plugin-build-oversize-",
    });
    const oversize = await buildAppletRequestV1({
      version: 1,
      effectId: "effect-9",
      kind: "plugin",
      id: "notes",
      mode: "build",
      files: files.map((file) =>
        file.path === "plugin.ts"
          ? {
              ...file,
              text: [
                'import type { PluginTool } from "@frockbot/applet-sdk/plugin";',
                "export const tools: PluginTool[] = [",
                '  { name: "big", description: "Big.", inputSchema: { type: "object", title: "x".repeat(120_000) } },',
                "];",
                'export const execute = () => "x";',
                "",
              ].join("\n"),
            }
          : file,
      ),
    });
    expect(oversize).toMatchObject({ status: "failed", stage: "bundle" });
    if (oversize.status === "failed") {
      expect(oversize.diagnostics[0]?.message).toContain("manifest.json");
    }
  }, 180_000);
});

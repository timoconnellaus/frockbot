/**
 * The build pipeline over a real scaffold: the stages, their diagnostics, and
 * the artifacts a publish stores.
 *
 * The service in `apps/applet-build` runs this same `runAppletBuildV1`, so
 * what passes here is what a publish admits.
 */

import { describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runAppletBuildV1 } from "../src/build/pipeline.js";
import { decodeDescriptor } from "../src/build/manifest.js";
import { formatDiagnostic } from "../src/lint/index.js";
import { scaffoldTemplateV1 } from "./scaffold.js";

async function scaffold(): Promise<string> {
  return (await scaffoldTemplateV1()).directory;
}

describe("the scaffold", () => {
  it("carries the display name into the descriptor and the page", async () => {
    const { directory, files } = await scaffoldTemplateV1();
    const descriptor = decodeDescriptor(
      JSON.parse(files.find((file) => file.path === "applet.json")!.text),
    );
    expect(descriptor).toEqual({
      id: "weekly-todos",
      displayName: "Weekly Todos",
      contract: 1,
    });
    expect(files.find((file) => file.path === "ui.tsx")!.text).toContain(
      "Weekly Todos",
    );
    expect(directory).toBeString();
  });
});

describe("check", () => {
  it("passes on a fresh template", async () => {
    expect(await runAppletBuildV1(await scaffold(), { mode: "check" })).toEqual(
      {
        status: "checked",
      },
    );
  }, 120_000);

  it("reports a type error with a path, a line, and a column", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "extra.ts"),
      'export const n: number = "not a number";\n',
      "utf8",
    );
    const outcome = await runAppletBuildV1(directory, { mode: "check" });
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outcome.stage).toBe("typecheck");
    expect(outcome.diagnostics[0]!.file).toBe("extra.ts");
    expect(outcome.diagnostics[0]!.line).toBe(1);
    expect(formatDiagnostic(outcome.diagnostics[0]!)).toMatch(
      /^extra\.ts:1:\d+ /,
    );
  }, 120_000);

  it("reports a lint violation the type checker would accept", async () => {
    const directory = await scaffold();
    await writeFile(
      join(directory, "extra.ts"),
      'export const brand = "#ff0000";\n',
      "utf8",
    );
    const outcome = await runAppletBuildV1(directory, { mode: "check" });
    if (outcome.status !== "failed") throw new Error("expected a failure");
    expect(outcome.stage).toBe("lint");
    expect(
      outcome.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toContain("applet/no-raw-colors");
  }, 120_000);
});

describe("build", () => {
  it("emits a server module, a self-contained page, and a manifest", async () => {
    const outcome = await runAppletBuildV1(await scaffold(), { mode: "build" });
    if (outcome.status !== "built") throw new Error("expected artifacts");

    const imports = [
      ...outcome.server.matchAll(/^\s*import\s.*?from\s*"([^"]+)"/gm),
    ].map((match) => match[1]);
    expect(imports).toEqual(["cloudflare:workers"]);
    expect(outcome.server).toContain("export {");

    expect(outcome.ui.startsWith("<!doctype html>")).toBe(true);
    expect(outcome.ui).not.toMatch(/\ssrc=["']https?:/);
    expect(outcome.ui).not.toMatch(/<link[^>]+href=["']https?:/);

    expect(outcome.manifest.contract).toBe(1);
    expect(outcome.manifest.tools.map((tool) => tool.name).sort()).toEqual([
      "add_todo",
      "list_todos",
    ]);
    expect(outcome.manifest.tools[0]!.inputSchema).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
    expect(outcome.manifest.hashes.server).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.manifest.hashes.ui).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});

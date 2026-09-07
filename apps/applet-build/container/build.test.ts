/**
 * The point of the service, asserted: what it returns is what `applet build`
 * writes.
 *
 * Both sides run the SDK's `src/build/` pipeline, so this is a golden
 * equivalence rather than a comparison of two derivations — and it is worth
 * holding because the alternative, a second implementation of the bundle or of
 * `this.tool(...)`, is exactly what the manifest's hashes would silently
 * disagree about.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApplet } from "../../../applets/sdk/src/cli/build.ts";
import { newApplet } from "../../../applets/sdk/src/cli/new.ts";
import type { AppletBuildSourceFileV1 } from "@frockbot/applets/build-contract";
import { buildAppletRequestV1 } from "./build.ts";

const APPLET_ID = "vgpqfaCcwnPlzjYdb2mI.weekly-todos";

/** A scaffolded Applet, and the same source as a build request would carry. */
async function scaffold(): Promise<{
  directory: string;
  files: AppletBuildSourceFileV1[];
}> {
  const parent = await mkdtemp(join(tmpdir(), "applet-build-golden-"));
  const { directory } = await newApplet({ name: "Weekly Todos", parent });
  const files: AppletBuildSourceFileV1[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files.push({
      path: entry.name,
      text: await readFile(join(directory, entry.name), "utf8"),
    });
  }
  return { directory, files };
}

describe("the Applet build service", () => {
  test("returns the artifacts `applet build` writes, hash for hash", async () => {
    const { directory, files } = await scaffold();

    const service = await buildAppletRequestV1({
      version: 1,
      effectId: "effect-1",
      appletId: APPLET_ID,
      mode: "build",
      files,
    });
    const local = await buildApplet(directory);

    expect(service.status).toBe("built");
    if (service.status !== "built") return;
    expect(service.manifest?.hashes).toEqual(local.manifest.hashes);
    expect(service.manifest?.tools.map((tool) => tool.name)).toEqual(
      local.manifest.tools.map((tool) => tool.name),
    );
    expect(service.server).toBe(await readFile(local.serverPath, "utf8"));
    expect(service.ui).toBe(await readFile(local.uiPath, "utf8"));
  }, 180_000);

  test("a passing check carries no artifact", async () => {
    const { files } = await scaffold();
    expect(
      await buildAppletRequestV1({
        version: 1,
        effectId: "effect-2",
        appletId: APPLET_ID,
        mode: "check",
        files,
      }),
    ).toEqual({ status: "built" });
  }, 180_000);

  test("names the stage a failure stopped in", async () => {
    const { files } = await scaffold();

    const noDescriptor = await buildAppletRequestV1({
      version: 1,
      effectId: "effect-3",
      appletId: APPLET_ID,
      mode: "check",
      files: files.filter((file) => file.path !== "applet.json"),
    });
    expect(noDescriptor).toMatchObject({
      status: "failed",
      stage: "descriptor",
    });

    const badTypes = await buildAppletRequestV1({
      version: 1,
      effectId: "effect-4",
      appletId: APPLET_ID,
      mode: "check",
      files: files.map((file) =>
        file.path === "server.ts"
          ? { ...file, text: `${file.text}\nconst wrong: number = "x";\n` }
          : file,
      ),
    });
    expect(badTypes).toMatchObject({ status: "failed", stage: "typecheck" });
    if (badTypes.status === "failed") {
      expect(badTypes.diagnostics[0]?.file).toBe("server.ts");
    }

    const network = await buildAppletRequestV1({
      version: 1,
      effectId: "effect-5",
      appletId: APPLET_ID,
      mode: "check",
      files: files.map((file) =>
        file.path === "ui.tsx"
          ? {
              ...file,
              text: `${file.text}\nnew WebSocket("wss://example.test");\n`,
            }
          : file,
      ),
    });
    expect(network).toMatchObject({ status: "failed", stage: "lint" });
  }, 180_000);
});

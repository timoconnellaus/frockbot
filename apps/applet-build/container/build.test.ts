/**
 * The point of the service, asserted: the same source posted to it and built
 * beside it yields the same bytes.
 *
 * Both sides run the SDK's `src/build/` pipeline over a directory of their
 * own, so what this holds is that the artifacts are a function of the source
 * and nothing else — not of where the build ran. They are not: esbuild writes
 * each module's path into the unminified bundle, and until the labels were
 * made stable two builds of identical source hashed differently and every
 * publish of unchanged code wrote a new R2 object.
 */

import { describe, expect, test } from "bun:test";
import type { AppletBuildSourceFileV1 } from "@frockbot/applets/build-contract";
import { runAppletBuildV1 } from "@frockbot/applet-sdk/build";
import { scaffoldTemplateV1 } from "../../../applets/sdk/test/scaffold.ts";
import { buildAppletRequestV1 } from "./build.ts";

const APPLET_ID = "vgpqfaCcwnPlzjYdb2mI.weekly-todos";

/** A scaffolded Applet, and the same source as a build request would carry. */
async function scaffold(): Promise<{
  directory: string;
  files: AppletBuildSourceFileV1[];
}> {
  const { directory, files } = await scaffoldTemplateV1({
    prefix: "applet-build-golden-",
  });
  return { directory, files };
}

describe("the Applet build service", () => {
  test("returns the artifacts a build beside it writes, hash for hash", async () => {
    const { directory, files } = await scaffold();

    const service = await buildAppletRequestV1({
      version: 1,
      effectId: "effect-1",
      appletId: APPLET_ID,
      mode: "build",
      files,
    });
    const local = await runAppletBuildV1(directory, { mode: "build" });

    expect(service.status).toBe("built");
    if (service.status !== "built") return;
    if (local.status !== "built") throw new Error("the local build failed");
    expect(service.manifest?.hashes).toEqual(local.manifest.hashes);
    expect(service.manifest?.tools.map((tool) => tool.name)).toEqual(
      local.manifest.tools.map((tool) => tool.name),
    );
    expect(service.server).toBe(local.server);
    expect(service.ui).toBe(local.ui);
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

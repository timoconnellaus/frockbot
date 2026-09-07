import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  dependencies?: Record<string, string>;
}

describe("the published package", () => {
  it("installs every dependency used by applet check and applet build", async () => {
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as PackageManifest;

    expect(manifest.dependencies).toMatchObject({
      "@tanstack/db": "0.8.7",
      "@tanstack/react-db": "0.3.7",
      "@types/react": "19.2.18",
      "@types/react-dom": "19.2.4",
      esbuild: "0.28.2",
      eslint: "10.9.1",
      miniflare: "5.20260828.0-alpha",
      react: "19.2.8",
      "react-dom": "19.2.8",
      typescript: "npm:typescript-native-bridge@6.0.3-bridge.16.tsgo.7.0.2",
      "typescript-eslint": "8.69.0",
    });
  });
});

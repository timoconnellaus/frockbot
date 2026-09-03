import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import { authoredManifestV1 } from "@frockbot/plugin-authoring/shared";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("non-first-party Package UI boundaries", () => {
  test("a Bot-authored UI page renders with no Package JavaScript in the app origin", () => {
    const manifest = authoredManifestV1({
      packageId: "weather-page",
      displayName: "Weather page",
      version: "0.0.1",
      tools: [
        { name: "weather_lookup", description: "Weather", inputSchema: {} },
      ],
      ui: {
        pages: [
          {
            id: "main",
            artifact: {
              contentHash: "a".repeat(64),
              size: 1,
              mediaType: "text/html",
              bundlerVersion: "frockbot-inline-html@1",
            },
            mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
          },
        ],
      },
    });
    // The synthesized manifest crosses the kernel's own strict decoder.
    expect(decodeFrockBotManifest(manifest).schemaVersion).toBe(5);
    const client = (manifest.contributions as Record<string, unknown>)
      .client as Record<string, unknown>;
    expect(client.kind).toBe("iframe");
    expect(client).not.toHaveProperty("entry");
    expect(client).not.toHaveProperty("artifact");
    const host = read("packages/plugin-shell/src/client/PackageIframeHost.vue");
    expect(host).toContain("<iframe");
    expect(host).toContain("/packages/${props.page.artifact.contentHash}.html");
  });

  test("a page cannot read the app's cookies or storage", () => {
    const host = read("packages/plugin-shell/src/client/PackageIframeHost.vue");
    expect(host).toContain('sandbox="allow-scripts"');
    expect(host).not.toContain("allow-same-origin");
    expect(host).toContain("credentialless");
    const wrangler = read("apps/cloudflare/wrangler.jsonc");
    expect(wrangler).toContain('"pattern": "ui.bot.frockbot.com"');
    expect(wrangler).toContain('"pattern": "bot.frockbot.com"');
  });
});

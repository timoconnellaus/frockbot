import { describe, expect, test } from "bun:test";
import type { PackageIframeCompositionV1 } from "@frockbot/kernel-contracts";
import type { FrockBotManifest } from "@frockbot/kernel-composition";
import type { CompositionGenerationV1 } from "@frockbot/kernel-composition/generation";
import { requirePackageUiToolDeclarationV1 } from "./backend.js";
import { projectPackageIframeCompositionV1 } from "./composition-views.js";

describe("Package iframe server admission", () => {
  const catalog: PackageIframeCompositionV1 = {
    schemaVersion: 1,
    botId: "bot",
    generationId: "generation-1",
    contributions: [
      {
        packageId: "weather-page",
        displayName: "Weather page",
        provenance: "Bot-authored",
        artifact: {
          contentHash: "a".repeat(64),
          size: 123,
          mediaType: "text/html",
          bundlerVersion: "frockbot-inline-html@1",
        },
        mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
        declaredTools: ["weather_lookup"],
      },
    ],
  };

  test("refuses an undeclared tool before admitting a durable Turn", () => {
    expect(() =>
      requirePackageUiToolDeclarationV1(catalog, {
        generationId: "generation-1",
        packageId: "weather-page",
        name: "package_author",
      }),
    ).toThrow('did not declare tool "package_author"');
  });

  test("refuses a stale page after its Composition generation changed", () => {
    expect(() =>
      requirePackageUiToolDeclarationV1(catalog, {
        generationId: "generation-old",
        packageId: "weather-page",
        name: "weather_lookup",
      }),
    ).toThrow('generation "generation-old"');
  });

  test("projects a Catalog member through the same manifest reader", async () => {
    const manifestHash = "c".repeat(64);
    const uiArtifact = {
      contentHash: "d".repeat(64),
      size: 42,
      mediaType: "text/html" as const,
      bundlerVersion: "frockbot-inline-html@1",
    };
    const manifest: FrockBotManifest = {
      schemaVersion: 3,
      id: "weather-page",
      displayName: "Weather page",
      version: "0.0.1",
      compatibility: { frockbot: "*" },
      dependencies: {},
      contributions: {
        runtime: { entry: "./package.js", host: "bot-isolate" },
        client: {
          kind: "iframe",
          artifact: uiArtifact,
          mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
        },
      },
      tools: [
        { name: "weather_lookup", description: "Looks up", inputSchema: {} },
      ],
      permissions: [],
    };
    const generation: CompositionGenerationV1 = {
      schemaVersion: 1,
      generationId: "generation-1",
      artifactSetHash: "a".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z",
      origin: { kind: "bootstrap" },
      members: [
        {
          packageId: "weather-page",
          specifier: "catalog:weather-page",
          version: "0.0.1",
          manifestHash,
          provenance: {
            kind: "catalog",
            packageId: "weather-page",
            version: "0.0.1",
            catalogId: "weather-page",
            catalogGeneration: "catalog-1",
            contentHash: "b".repeat(64),
          },
          artifact: {
            contentHash: "b".repeat(64),
            size: 512,
            mediaType: "application/javascript",
            bundlerVersion: "catalog-test@1",
          },
        },
      ],
      status: "active",
    };
    const requested: string[] = [];

    const projected = await projectPackageIframeCompositionV1({
      botId: "bot",
      generation,
      readMemberManifest: (member) => {
        requested.push(member.manifestHash);
        return Promise.resolve(manifest);
      },
    });

    expect(requested).toEqual([manifestHash]);
    expect(projected.contributions).toEqual([
      {
        packageId: "weather-page",
        displayName: "Weather page",
        provenance: "User-installed",
        artifact: uiArtifact,
        mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
        declaredTools: ["weather_lookup"],
      },
    ]);
  });
});

/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  catalogContentHashV1,
  CATALOG_POINTER_KEY_V1,
  decodeCatalogIndexDocumentV1,
  parseCatalogEntryDocumentV1,
  decodeCatalogPointerV1,
} from "../packages/catalog-core/src/index.ts";
import type { FrockBotManifest } from "../packages/kernel-composition/src/manifest.ts";
import {
  buildCatalogGeneration,
  type CatalogSourcePackage,
} from "./publish-catalog.ts";
import { CATALOG_DESCRIPTIONS } from "./catalog-descriptions.ts";

function sourcePackage(
  id: string,
  overrides: Partial<FrockBotManifest> = {},
): CatalogSourcePackage {
  const manifest: FrockBotManifest = {
    schemaVersion: 3,
    id,
    displayName: id.toUpperCase(),
    version: "0.0.1",
    compatibility: { frockbot: "*" },
    dependencies: {},
    contributions: { runtime: { entry: "./runtime.js" } },
    permissions: [],
    ...overrides,
  };
  return { id, version: manifest.version, manifest };
}

function publishedPackage(): CatalogSourcePackage {
  const pkg = sourcePackage("parcel-tracking", {
    contributions: {
      runtime: { entry: "./package.js", host: "bot-isolate" },
    },
    tools: [
      {
        name: "track_parcel",
        description: "Tracks one parcel.",
        inputSchema: { type: "object" },
      },
    ],
  });
  return {
    ...pkg,
    catalog: {
      description: "Tracks parcels across carriers.",
      tags: ["shipping", "tracking"],
      bundle: {
        contentHash: "b".repeat(64),
        size: 1_024,
        mediaType: "application/javascript",
        bundlerVersion: "authoring-bundler@1",
        sourceHash: "c".repeat(64),
      },
    },
  };
}

describe("seed catalog generation", () => {
  test("indexes every compiled-in Package and writes one entry each", async () => {
    const built = await buildCatalogGeneration([
      sourcePackage("echo"),
      sourcePackage("clock"),
    ]);

    expect(built.index.entries.map((entry) => entry.catalogId)).toEqual([
      "clock",
      "echo",
    ]);
    expect(built.entries).toHaveLength(2);
    // L1 seeds no MCP connectors; L2 adds them with `plugin-mcp`.
    expect(built.index.entries.every((entry) => entry.kind === "package")).toBe(
      true,
    );
    expect(built.entries.every((entry) => entry.servers.length === 0)).toBe(
      true,
    );
  });

  test("the generation is the content hash of its entries", async () => {
    const first = await buildCatalogGeneration([sourcePackage("echo")]);
    const same = await buildCatalogGeneration([sourcePackage("echo")]);
    const different = await buildCatalogGeneration([
      sourcePackage("echo", { displayName: "Echo Pro" }),
    ]);

    expect(same.generation).toBe(first.generation);
    expect(same.indexHash).toBe(first.indexHash);
    expect(different.generation).not.toBe(first.generation);
  });

  test("every emitted document decodes and matches the published hash", async () => {
    const built = await buildCatalogGeneration([sourcePackage("echo")]);
    const byKey = new Map(built.files.map((file) => [file.key, file.document]));

    const indexDocument = byKey.get(`catalog/${built.generation}/index.json`);
    expect(indexDocument).toBeDefined();
    const index = await decodeCatalogIndexDocumentV1(
      indexDocument!,
      built.indexHash,
    );
    expect(index.generation).toBe(built.generation);

    const entryDocument = byKey.get(
      `catalog/${built.generation}/entry/echo.json`,
    );
    expect(entryDocument).toBeDefined();
    expect(parseCatalogEntryDocumentV1(entryDocument!).packageId).toBe("echo");

    const pointer = decodeCatalogPointerV1(
      JSON.parse(byKey.get(CATALOG_POINTER_KEY_V1)!) as unknown,
    );
    expect(pointer).toEqual({
      schemaVersion: 1,
      generation: built.generation,
      indexHash: await catalogContentHashV1(indexDocument!),
    });
  });

  test("the mutable pointer is written last, after the generation it names", async () => {
    const built = await buildCatalogGeneration([sourcePackage("echo")]);
    expect(built.files.at(-1)?.key).toBe(CATALOG_POINTER_KEY_V1);
    expect(
      built.files
        .slice(0, -1)
        .every((file) => file.key.startsWith(`catalog/${built.generation}/`)),
    ).toBe(true);
  });

  test("publishes a User-selected authored bundle as a hash-pinned Catalog entry", async () => {
    const built = await buildCatalogGeneration([
      sourcePackage("echo"),
      publishedPackage(),
    ]);
    const row = built.index.entries.find(
      (entry) => entry.catalogId === "parcel-tracking",
    );
    const entry = built.entries.find(
      (candidate) => candidate.catalogId === "parcel-tracking",
    );

    expect(row).toMatchObject({
      contentHash: "b".repeat(64),
      tags: ["shipping", "tracking"],
    });
    expect(entry?.bundle).toMatchObject({
      contentHash: "b".repeat(64),
      sourceHash: "c".repeat(64),
      mediaType: "application/javascript",
      manifest: {
        id: "parcel-tracking",
        contributions: {
          runtime: { entry: "./package.js", host: "bot-isolate" },
        },
      },
    });
    expect(entry?.description).toBe("Tracks parcels across carriers.");
  });

  test("every shipped Package carries a written line, not the fallback", async () => {
    const { compileFoundationApplication } = await import(
      "../applications/foundation/src/runtime.ts"
    );
    const plan = await compileFoundationApplication();
    const built = await buildCatalogGeneration(plan.packages);

    expect(built.index.entries.length).toBeGreaterThan(0);
    const architectural = built.index.entries.filter((entry) =>
      entry.description.startsWith("First-party FrockBot Package"),
    );
    expect(architectural.map((entry) => entry.catalogId)).toEqual([]);
    // The line is what `package_search` matches on, so it has to read as a
    // sentence a person would type words from, not as a label.
    expect(
      built.index.entries.every((entry) => entry.description.includes(" ")),
    ).toBe(true);
  });

  test("a Package with no written line still falls back to its Contributions", async () => {
    const built = await buildCatalogGeneration([
      sourcePackage("not-a-real-package"),
    ]);

    expect(built.index.entries[0]?.description).toBe(
      "First-party FrockBot Package contributing runtime.",
    );
  });

  test("a written line wins over the fallback, and a publication wins over both", async () => {
    const built = await buildCatalogGeneration([
      sourcePackage("memory"),
      publishedPackage(),
    ]);

    expect(
      built.index.entries.find((entry) => entry.catalogId === "memory")
        ?.description,
    ).toBe(CATALOG_DESCRIPTIONS.memory);
    expect(
      built.index.entries.find((entry) => entry.catalogId === "parcel-tracking")
        ?.description,
    ).toBe("Tracks parcels across carriers.");
  });

  test("delisting changes only the new pointer generation, never an old entry or artifact identity", async () => {
    const listed = await buildCatalogGeneration([publishedPackage()]);
    const delisted = await buildCatalogGeneration([]);

    expect(delisted.generation).not.toBe(listed.generation);
    expect(delisted.entries).toEqual([]);
    expect(listed.entries[0]?.bundle?.contentHash).toBe("b".repeat(64));
    expect(
      listed.files.some(
        (file) =>
          file.key ===
          `catalog/${listed.generation}/entry/parcel-tracking.json`,
      ),
    ).toBe(true);
  });
});

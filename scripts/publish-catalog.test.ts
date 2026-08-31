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
});

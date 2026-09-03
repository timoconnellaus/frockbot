import { describe, expect, test } from "bun:test";
import {
  MAX_CATALOG_SKILL_BODY_BYTES_V1,
  assertCatalogPackageBundleV1,
  assertCatalogEntryMatchesIndexV1,
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogPackageArtifactKeyV1,
  catalogPackageSourceKeyV1,
  catalogPackageUiArtifactKeyV1,
  catalogSetupFieldKeyV1,
  catalogIndexKeyV1,
  CATALOG_POINTER_KEY_V1,
  decodeCatalogEntryDocumentV1,
  decodeCatalogEntryV1,
  decodeCatalogIndexDocumentV1,
  decodeCatalogIndexV1,
  decodeCatalogPointerV1,
  MAX_CATALOG_ENTRIES_V1,
  parseCatalogIndexDocumentV1,
  type CatalogEntryV1,
  type CatalogIndexEntryV1,
} from "./index.ts";

const MANIFEST_HASH = "a".repeat(64);

function isolateManifest() {
  return {
    schemaVersion: 3 as const,
    id: "parcel-tracking",
    displayName: "Parcel tracking",
    version: "0.0.1",
    compatibility: { frockbot: ">=0.0.1" },
    dependencies: {},
    contributions: {
      runtime: { entry: "./package.js", host: "bot-isolate" as const },
    },
    tools: [
      {
        name: "track_parcel",
        description: "Tracks a parcel.",
        inputSchema: { type: "object" },
      },
    ],
    permissions: [],
  };
}

function indexEntry(
  overrides: Partial<CatalogIndexEntryV1> = {},
): CatalogIndexEntryV1 {
  return {
    catalogId: "mcp-weather",
    packageId: "mcp-weather",
    displayName: "Weather",
    description: "Forecasts from a public MCP server.",
    version: "0.0.1",
    manifestHash: MANIFEST_HASH,
    kind: "mcp-connector",
    ...overrides,
  };
}

function entryDetail(overrides: Partial<CatalogEntryV1> = {}): CatalogEntryV1 {
  return {
    schemaVersion: 1,
    catalogId: "mcp-weather",
    packageId: "mcp-weather",
    displayName: "Weather",
    description: "Forecasts from a public MCP server.",
    version: "0.0.1",
    kind: "mcp-connector",
    manifestHash: MANIFEST_HASH,
    servers: [],
    setupFields: [],
    skills: [],
    ...overrides,
  };
}

describe("catalog index decoding", () => {
  test("accepts an index and keeps only declared fields", () => {
    const index = decodeCatalogIndexV1({
      schemaVersion: 1,
      generation: "gen-0001",
      entries: [indexEntry()],
    });
    expect(index.entries[0]?.catalogId).toBe("mcp-weather");
    expect(Object.hasOwn(index.entries[0]!, "logo")).toBe(false);
  });

  test("rejects an unknown field on the index", () => {
    expect(() =>
      decodeCatalogIndexV1({
        schemaVersion: 1,
        generation: "gen-0001",
        entries: [],
        cursor: "next",
      }),
    ).toThrow('unknown field "cursor"');
  });

  test("rejects an unknown field on an entry", () => {
    expect(() =>
      decodeCatalogIndexV1({
        schemaVersion: 1,
        generation: "gen-0001",
        entries: [{ ...indexEntry(), price: 10 }],
      }),
    ).toThrow('unknown field "price"');
  });

  test("rejects an unsupported schema version", () => {
    expect(() =>
      decodeCatalogIndexV1({
        schemaVersion: 2,
        generation: "gen-0001",
        entries: [],
      }),
    ).toThrow("schema version is unsupported");
  });

  test("rejects a manifest hash that is not a SHA-256 digest", () => {
    expect(() =>
      decodeCatalogIndexV1({
        schemaVersion: 1,
        generation: "gen-0001",
        entries: [indexEntry({ manifestHash: "not-a-hash" })],
      }),
    ).toThrow("manifestHash is invalid");
  });

  test("rejects a repeated catalogId", () => {
    expect(() =>
      decodeCatalogIndexV1({
        schemaVersion: 1,
        generation: "gen-0001",
        entries: [indexEntry(), indexEntry()],
      }),
    ).toThrow("repeats a catalogId");
  });

  test("rejects more entries than the bound", () => {
    expect(() =>
      decodeCatalogIndexV1({
        schemaVersion: 1,
        generation: "gen-0001",
        entries: Array.from({ length: MAX_CATALOG_ENTRIES_V1 + 1 }, (_, i) =>
          indexEntry({ catalogId: `mcp-${i}`, packageId: `mcp-${i}` }),
        ),
      }),
    ).toThrow("bounded array");
  });

  test("rejects a non-https logo or homepage", () => {
    for (const field of ["logo", "homepage"] as const) {
      expect(() =>
        decodeCatalogIndexV1({
          schemaVersion: 1,
          generation: "gen-0001",
          entries: [
            indexEntry({
              [field]: "javascript:alert(1)",
            } as Partial<CatalogIndexEntryV1>),
          ],
        }),
      ).toThrow("must be an https URL");
    }
  });
});

describe("catalog entry decoding", () => {
  test("accepts servers, setup fields and skills", () => {
    const entry = decodeCatalogEntryV1(
      entryDetail({
        servers: [
          {
            name: "weather",
            transport: "streamable-http",
            url: "https://mcp.example.com/weather",
            auth: "api-key",
          },
        ],
        setupFields: [
          { type: "string", title: "Region", minLength: 2, maxLength: 8 },
        ],
        skills: [
          {
            name: "forecast",
            description: "Ask for a forecast.",
            body: "1. Ask the region.",
          },
        ],
      }),
    );
    expect(entry.servers[0]?.transport).toBe("streamable-http");
    expect(entry.setupFields[0]?.title).toBe("Region");
    expect(entry.skills[0]?.name).toBe("forecast");
    // The body lives in the entry document, at the pinned generation: a
    // plugin-borne Skill is indexed there and copied nowhere.
    expect(entry.skills[0]?.body).toBe("1. Ask the region.");
  });

  test("bounds a Skill body and refuses an unknown Skill field", () => {
    expect(() =>
      decodeCatalogEntryV1(
        entryDetail({
          skills: [
            {
              name: "forecast",
              body: "x".repeat(MAX_CATALOG_SKILL_BODY_BYTES_V1 + 1),
            },
          ],
        }),
      ),
    ).toThrow(/catalog skill body is invalid/u);
    // A field GrokBot's own plugin index carries and a Catalog entry must not:
    // a body is data, a file path is a claim about some host's disk.
    const withFilePath = entryDetail();
    (withFilePath.skills as unknown[]).push({
      name: "forecast",
      filePath: "plugins/cache/forecast/SKILL.md",
    });
    expect(() => decodeCatalogEntryV1(withFilePath)).toThrow(/unknown field/u);
  });

  test("rejects an unknown transport", () => {
    expect(() =>
      decodeCatalogEntryV1(
        entryDetail({
          servers: [
            {
              name: "weather",
              transport: "stdio" as never,
              url: "https://mcp.example.com/weather",
              auth: "none",
            },
          ],
        }),
      ),
    ).toThrow("transport is invalid");
  });

  test("rejects a setup field the Package manifest dialect would refuse", () => {
    expect(() =>
      decodeCatalogEntryV1(
        entryDetail({ setupFields: [{ $ref: "#/x" } as never] }),
      ),
    ).toThrow();
  });

  test("rejects an unknown field on the detail document", () => {
    expect(() =>
      decodeCatalogEntryV1({ ...entryDetail(), installs: 12 }),
    ).toThrow('unknown field "installs"');
  });

  test("decodes an immutable Bot-isolate bundle with the authored manifest shape", async () => {
    const manifest = isolateManifest();
    const manifestHash = await catalogContentHashV1(
      JSON.stringify(manifest, Object.keys(manifest).sort()),
    );
    const entry = decodeCatalogEntryV1({
      ...entryDetail({
        catalogId: "parcel-tracking",
        packageId: "parcel-tracking",
        displayName: "Parcel tracking",
        description: "Tracks deliveries.",
        kind: "package",
        manifestHash,
      }),
      tags: ["shipping", "parcels"],
      bundle: {
        contentHash: "b".repeat(64),
        size: 512,
        mediaType: "application/javascript",
        bundlerVersion: "catalog-test@1",
        manifest,
        sourceHash: "c".repeat(64),
      },
    });

    expect(entry.bundle?.manifest.tools?.[0]?.name).toBe("track_parcel");
    expect(entry.tags).toEqual(["shipping", "parcels"]);
    // The decoder validates shape synchronously; the reader additionally
    // verifies the exact manifest bytes against the entry's hash.
    await expect(assertCatalogPackageBundleV1(entry)).rejects.toThrow(
      "manifest failed content hash verification",
    );
  });

  test("keeps an iframe artifact reference in the bundle's verified manifest", () => {
    const uiArtifact = {
      contentHash: "d".repeat(64),
      size: 42,
      mediaType: "text/html" as const,
      bundlerVersion: "frockbot-inline-html@1",
    };
    const manifest = isolateManifest();
    const decoded = decodeCatalogEntryV1({
      ...entryDetail({
        catalogId: "parcel-tracking",
        packageId: "parcel-tracking",
        displayName: "Parcel tracking",
        description: "Tracks deliveries.",
        kind: "package",
      }),
      bundle: {
        contentHash: "b".repeat(64),
        size: 512,
        mediaType: "application/javascript",
        bundlerVersion: "catalog-test@1",
        manifest: {
          ...manifest,
          contributions: {
            ...manifest.contributions,
            client: {
              kind: "iframe",
              artifact: uiArtifact,
              mounts: [{ slot: "frockbot.tool-result:track_parcel" }],
            },
          },
        },
      },
    });

    // The Catalog carries a released single-page record; the manifest decoder
    // migrates it forward to the one multi-page shape.
    expect(decoded.bundle?.manifest.contributions.client).toEqual({
      kind: "iframe",
      pages: [
        {
          id: "main",
          artifact: uiArtifact,
          mounts: [{ slot: "frockbot.tool-result:track_parcel" }],
        },
      ],
    });
  });

  test("refuses code on a connector or a manifest that does not target the Bot isolate", () => {
    const bundle = {
      contentHash: "b".repeat(64),
      size: 512,
      mediaType: "application/javascript" as const,
      bundlerVersion: "catalog-test@1",
      manifest: isolateManifest(),
    };
    expect(() => decodeCatalogEntryV1({ ...entryDetail(), bundle })).toThrow(
      "only a package Catalog entry may carry a bundle",
    );
    expect(() =>
      decodeCatalogEntryV1({
        ...entryDetail({
          catalogId: "parcel-tracking",
          packageId: "parcel-tracking",
          kind: "package",
        }),
        bundle: {
          ...bundle,
          manifest: {
            ...isolateManifest(),
            contributions: { runtime: { entry: "./runtime.js" } },
            tools: undefined,
          },
        },
      }),
    ).toThrow("must declare a Bot isolate runtime");
  });
});

describe("content addressing", () => {
  test("verifies a document against its hash before decoding", async () => {
    const document = JSON.stringify({
      schemaVersion: 1,
      generation: "gen-0001",
      entries: [indexEntry()],
    });
    const hash = await catalogContentHashV1(document);
    const index = await decodeCatalogIndexDocumentV1(document, hash);
    expect(index.generation).toBe("gen-0001");
  });

  test("refuses a document whose bytes changed under a pinned hash", async () => {
    const document = JSON.stringify({
      schemaVersion: 1,
      generation: "gen-0001",
      entries: [indexEntry()],
    });
    const hash = await catalogContentHashV1(document);
    const tampered = JSON.stringify({
      schemaVersion: 1,
      generation: "gen-0001",
      entries: [indexEntry({ displayName: "Weather Pro" })],
    });
    await expect(decodeCatalogIndexDocumentV1(tampered, hash)).rejects.toThrow(
      "failed content hash verification",
    );
  });

  test("refuses an entry document under a mismatched hash", async () => {
    const document = JSON.stringify(entryDetail());
    await expect(
      decodeCatalogEntryDocumentV1(document, "b".repeat(64)),
    ).rejects.toThrow("failed content hash verification");
  });

  test("refuses a document that is not JSON", () => {
    expect(() => parseCatalogIndexDocumentV1("<html>")).toThrow("is not JSON");
  });
});

describe("object layout", () => {
  test("keys name a generation-scoped, immutable object", () => {
    expect(catalogIndexKeyV1("gen-0001")).toBe("catalog/gen-0001/index.json");
    expect(catalogEntryKeyV1("gen-0001", "mcp-weather")).toBe(
      "catalog/gen-0001/entry/mcp-weather.json",
    );
    expect(CATALOG_POINTER_KEY_V1).toBe("catalog/current");
    expect(catalogPackageArtifactKeyV1("b".repeat(64))).toBe(
      `packages/${"b".repeat(64)}.mjs`,
    );
    expect(catalogPackageSourceKeyV1("c".repeat(64))).toBe(
      `packages/${"c".repeat(64)}.ts`,
    );
    expect(catalogPackageUiArtifactKeyV1("d".repeat(64))).toBe(
      `packages/${"d".repeat(64)}.html`,
    );
  });

  test("refuses a generation or catalogId that could escape its prefix", () => {
    expect(() => catalogIndexKeyV1("../secrets")).toThrow(
      "catalog generation is invalid",
    );
    expect(() => catalogEntryKeyV1("gen-0001", "../../index")).toThrow(
      "catalogId is invalid",
    );
  });

  test("decodes the pointer and refuses a partial one", () => {
    expect(
      decodeCatalogPointerV1({
        schemaVersion: 1,
        generation: "gen-0001",
        indexHash: MANIFEST_HASH,
      }).generation,
    ).toBe("gen-0001");
    expect(() =>
      decodeCatalogPointerV1({ schemaVersion: 1, generation: "gen-0001" }),
    ).toThrow('is missing "indexHash"');
  });
});

describe("entry against index", () => {
  test("accepts an entry that agrees with its index row", () => {
    expect(() =>
      assertCatalogEntryMatchesIndexV1(entryDetail(), indexEntry()),
    ).not.toThrow();
  });

  test("refuses an entry whose version drifted from the index", () => {
    expect(() =>
      assertCatalogEntryMatchesIndexV1(
        entryDetail({ version: "0.0.2" }),
        indexEntry(),
      ),
    ).toThrow("does not match its index row");
  });
});

describe("a Catalog entry's setup fields", () => {
  test("map to the values key an install records the answer under", () => {
    // A setup field is a bare JSON Schema with no identifier, so the key an
    // install records the answer under is derived from the title — in one
    // place, because the form that collects it and anything that reads the
    // install back have to agree.
    expect(catalogSetupFieldKeyV1({ title: "Region" }, 0)).toBe("region");
    expect(catalogSetupFieldKeyV1({ title: "Base URL" }, 1)).toBe("base-url");
    expect(catalogSetupFieldKeyV1({ title: "  " }, 2)).toBe("setup-2");
    expect(catalogSetupFieldKeyV1({}, 3)).toBe("setup-3");
  });

  test("give a stable key, so an answer survives a reopened form", () => {
    const field = { title: "Workspace ID" };
    expect(catalogSetupFieldKeyV1(field, 0)).toBe(
      catalogSetupFieldKeyV1(field, 5),
    );
  });
});

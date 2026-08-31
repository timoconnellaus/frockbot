/**
 * Builds one immutable Catalog generation from the built application's Package
 * manifests, so every compiled-in Package also appears in the remote index and
 * a Catalog install and a compiled-in install describe the same Packages.
 *
 * Nothing is uploaded here: the script writes the generation to a directory and
 * prints its identity, and CI uploads the files with `wrangler r2 object put`.
 * That keeps "compilation and bundling happen outside Durable Objects" and
 * "Composition consumes immutable, content-addressed artifacts" honest — the
 * generation id *is* the content hash of the entry set, so republishing the
 * same application produces the same generation and overwrites nothing.
 *
 * L2 adds `plugin-mcp` and the connector entries that need it; this seed
 * generation deliberately contains zero MCP connectors.
 *
 *   bun scripts/publish-catalog.ts [--out <dir>]
 */
import {
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  CATALOG_POINTER_KEY_V1,
  decodeCatalogIndexV1,
  decodeCatalogEntryV1,
  type CatalogEntryV1,
  type CatalogIndexEntryV1,
  type CatalogIndexV1,
  type CatalogPointerV1,
} from "../packages/catalog-core/src/index.ts";
import { canonicalJson } from "../packages/kernel-composition/src/compiler.ts";
import type { FrockBotManifest } from "../packages/kernel-composition/src/manifest.ts";

export interface CatalogSourcePackage {
  id: string;
  version: string;
  manifest: FrockBotManifest;
}

export interface CatalogGenerationFile {
  key: string;
  document: string;
}

export interface BuiltCatalogGeneration {
  generation: string;
  indexHash: string;
  index: CatalogIndexV1;
  entries: CatalogEntryV1[];
  pointer: CatalogPointerV1;
  files: CatalogGenerationFile[];
}

async function contentHash(value: unknown): Promise<string> {
  return catalogContentHashV1(canonicalJson(value));
}

/**
 * A one-line description of what a Package contributes. The manifest carries
 * no prose, and inventing marketing copy for a first-party Package would be a
 * lie the index then repeats; naming its Contributions is true and useful.
 */
function describe(manifest: FrockBotManifest): string {
  const contributions = Object.keys(manifest.contributions).sort();
  const capabilities = manifest.configuration?.capabilities ?? [];
  const parts = [
    `First-party FrockBot Package contributing ${contributions.join(", ") || "no runtime"}.`,
  ];
  if (capabilities.length > 0) {
    parts.push(
      `Capabilities: ${capabilities.map((capability) => capability.id).join(", ")}.`,
    );
  }
  return parts.join(" ");
}

export async function buildCatalogGeneration(
  packages: readonly CatalogSourcePackage[],
): Promise<BuiltCatalogGeneration> {
  const entries: CatalogEntryV1[] = [];
  const rows: CatalogIndexEntryV1[] = [];
  for (const pkg of [...packages].sort((a, b) => a.id.localeCompare(b.id))) {
    const manifestHash = await contentHash(pkg.manifest);
    const row: CatalogIndexEntryV1 = {
      catalogId: pkg.id,
      packageId: pkg.id,
      displayName: pkg.manifest.displayName,
      description: describe(pkg.manifest),
      version: pkg.version,
      manifestHash,
      kind: "package",
    };
    rows.push(row);
    entries.push(
      decodeCatalogEntryV1({
        schemaVersion: 1,
        catalogId: row.catalogId,
        packageId: row.packageId,
        displayName: row.displayName,
        description: row.description,
        version: row.version,
        kind: row.kind,
        manifestHash,
        // A first-party Package is not an MCP connector: it declares no
        // server, needs no setup value, and carries no bundled Skill.
        servers: [],
        setupFields: [],
        skills: [],
      }),
    );
  }

  // The generation *is* the content hash of what it contains, so an identical
  // application always republishes to the same immutable key.
  const generation = `g${(await contentHash(rows)).slice(0, 32)}`;
  const index = decodeCatalogIndexV1({
    schemaVersion: 1,
    generation,
    entries: rows,
  });
  const indexDocument = `${JSON.stringify(index, null, 2)}\n`;
  const indexHash = await catalogContentHashV1(indexDocument);
  const pointer: CatalogPointerV1 = { schemaVersion: 1, generation, indexHash };
  return {
    generation,
    indexHash,
    index,
    entries,
    pointer,
    files: [
      { key: catalogIndexKeyV1(generation), document: indexDocument },
      ...entries.map((entry) => ({
        key: catalogEntryKeyV1(generation, entry.catalogId),
        document: `${JSON.stringify(entry, null, 2)}\n`,
      })),
      {
        key: CATALOG_POINTER_KEY_V1,
        document: `${JSON.stringify(pointer, null, 2)}\n`,
      },
    ],
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const outFlag = argv.indexOf("--out");
  const outDirectory =
    outFlag >= 0 ? argv[outFlag + 1] : "apps/cloudflare/dist/catalog";
  if (!outDirectory) throw new Error("--out requires a directory");
  const { compileFoundationApplication } =
    await import("../applications/foundation/src/runtime.ts");
  const plan = await compileFoundationApplication();
  const built = await buildCatalogGeneration(plan.packages);
  for (const file of built.files) {
    await Bun.write(`${outDirectory}/${file.key}`, file.document);
  }
  process.stdout.write(
    `${JSON.stringify({ generation: built.generation, indexHash: built.indexHash, entries: built.index.entries.length, out: outDirectory }, null, 2)}\n`,
  );
}

if (import.meta.main) await main();

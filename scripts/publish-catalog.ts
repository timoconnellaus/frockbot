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
 * A User-selected Bot-authored Package may be supplied with
 * `--published <json>`; its immutable artifact already lives in the shared
 * Package artifact store, so publication adds only the Catalog entry that
 * names its exact hash. Delisting omits an entry from a later generation and
 * moves `catalog/current`; it never deletes an artifact or revokes an
 * installation that already recorded the old generation.
 *
 *   bun scripts/publish-catalog.ts [--out <dir>] [--published <json>]
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
  type CatalogPackageBundleV1,
  type CatalogPointerV1,
} from "../packages/catalog-core/src/index.ts";
import { canonicalJson } from "../packages/kernel-composition/src/compiler.ts";
import { catalogDescriptionFor } from "./catalog-descriptions.ts";
import type { FrockBotManifest } from "../packages/kernel-composition/src/manifest.ts";

export interface CatalogSourcePackage {
  id: string;
  version: string;
  manifest: FrockBotManifest;
  /** Catalog copy supplied by the User publication action. */
  catalog?: {
    description: string;
    tags?: string[];
    bundle: Omit<CatalogPackageBundleV1, "manifest">;
  };
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
 * The last-resort description, for a Package nobody has written a line for.
 * Naming its Contributions is at least true, but it says nothing a person
 * browsing the Catalog can act on and nothing `package_search` can match, so
 * `scripts/catalog-descriptions.ts` should cover every Package we ship.
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
    // A Bot-authored publication brings its own copy; ours is looked up.
    const description =
      pkg.catalog?.description ??
      catalogDescriptionFor(pkg.id) ??
      describe(pkg.manifest);
    const row: CatalogIndexEntryV1 = {
      catalogId: pkg.id,
      packageId: pkg.id,
      displayName: pkg.manifest.displayName,
      description,
      version: pkg.version,
      manifestHash,
      kind: "package",
      ...(pkg.catalog
        ? {
            contentHash: pkg.catalog.bundle.contentHash,
            ...(pkg.catalog.tags ? { tags: pkg.catalog.tags } : {}),
          }
        : {}),
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
        ...(pkg.catalog?.tags ? { tags: pkg.catalog.tags } : {}),
        // A first-party Package is not an MCP connector: it declares no
        // server, needs no setup value, and carries no bundled Skill.
        servers: [],
        setupFields: [],
        skills: [],
        ...(pkg.catalog
          ? {
              bundle: {
                ...pkg.catalog.bundle,
                manifest: pkg.manifest,
              },
            }
          : {}),
      }),
    );
  }

  // The generation hashes entry details, not only index rows: an optional
  // retained source hash and every manifest field are part of what it names.
  const generation = `g${(await contentHash(entries)).slice(0, 32)}`;
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
  const publishedFlag = argv.indexOf("--published");
  const publishedPath =
    publishedFlag >= 0 ? argv[publishedFlag + 1] : undefined;
  if (publishedFlag >= 0 && !publishedPath) {
    throw new Error("--published requires a JSON file");
  }
  const { compileFoundationApplication } =
    await import("../applications/foundation/src/runtime.ts");
  const plan = await compileFoundationApplication();
  const published = publishedPath
    ? (JSON.parse(await Bun.file(publishedPath).text()) as unknown)
    : [];
  if (!Array.isArray(published)) {
    throw new Error("--published must contain a JSON array");
  }
  // `buildCatalogGeneration` decodes every emitted entry through catalog-core,
  // including the real manifest and artifact descriptor. The assertion here
  // only narrows the script input after JSON parsing; no unvalidated value is
  // published.
  const built = await buildCatalogGeneration([
    ...plan.packages,
    ...(published as CatalogSourcePackage[]),
  ]);
  for (const file of built.files) {
    await Bun.write(`${outDirectory}/${file.key}`, file.document);
  }
  process.stdout.write(
    `${JSON.stringify({ generation: built.generation, indexHash: built.indexHash, entries: built.index.entries.length, out: outDirectory }, null, 2)}\n`,
  );
}

if (import.meta.main) await main();

/**
 * The remote Package Catalog seam.
 *
 * A Catalog *generation* is an immutable, content-addressed set of objects in
 * the `PACKAGE_CATALOG` bucket:
 *
 *   catalog/<generation>/index.json          the whole index
 *   catalog/<generation>/entry/<catalogId>.json   one entry's detail
 *   catalog/current                          the mutable pointer
 *
 * The pointer is the only mutable object; everything it names is immutable, so
 * a User Durable Object can pin one generation and one index hash and refuse an
 * install that arrives against any other. Nothing here reaches the network or
 * object storage: this module is the DTOs, their strict decoders and the key
 * layout, so the gateway, the User Durable Object, the publisher script and the
 * browser all agree without any of them importing another's runtime.
 *
 * These are product DTOs, not kernel types, which is why they live beside
 * `configuration-core` and `connection-core` rather than in
 * `kernel-composition`: the kernel decodes a Package *manifest*, and contains
 * no product policy. The one thing borrowed from the kernel is the setting
 * schema decoder, so a Catalog entry cannot describe a setup field a Package
 * manifest could not declare.
 */
import {
  decodeFrockBotManifest,
  decodePackageSettingSchemaV1,
  type FrockBotManifest,
  type PackageSettingSchema,
} from "@frockbot/kernel-composition";
import { canonicalJson } from "@frockbot/kernel-composition/compiler";

export class CatalogDecodeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogDecodeError";
  }
}

export const CATALOG_POINTER_KEY_V1 = "catalog/current";

/** Bounds every Catalog document, so a hostile object cannot exhaust a DO. */
export const MAX_CATALOG_ENTRIES_V1 = 512;
export const MAX_CATALOG_SERVERS_V1 = 16;
export const MAX_CATALOG_SETUP_FIELDS_V1 = 32;
export const MAX_CATALOG_SKILLS_V1 = 64;
export const MAX_CATALOG_TAGS_V1 = 32;
/**
 * Longest Skill body one Catalog entry may carry.
 *
 * A plugin-borne Skill is *indexed*, never copied into an instruction root
 * (`docs/research/grokbot-computer.md` line 285: `plugin-skills/cache.json` is
 * only an index). The entry document at the pinned generation is therefore the
 * one place the body lives, and it is bounded here so a hostile entry cannot
 * fill a system prompt or exhaust the document bound above.
 */
export const MAX_CATALOG_SKILL_BODY_BYTES_V1 = 16_384;
export const MAX_CATALOG_DOCUMENT_BYTES_V1 = 1_048_576;

export type CatalogEntryKindV1 = "package" | "mcp-connector";
export type CatalogServerTransportV1 = "streamable-http" | "sse";
export type CatalogServerAuthV1 = "none" | "api-key" | "oauth";

export interface CatalogIndexEntryV1 {
  catalogId: string;
  packageId: string;
  displayName: string;
  description: string;
  version: string;
  manifestHash: string;
  kind: CatalogEntryKindV1;
  /** Present when this row names code loaded in a Bot isolate. */
  contentHash?: string;
  tags?: string[];
  logo?: string;
  homepage?: string;
}

export interface CatalogIndexV1 {
  schemaVersion: 1;
  generation: string;
  entries: CatalogIndexEntryV1[];
}

export interface CatalogServerV1 {
  name: string;
  transport: CatalogServerTransportV1;
  url: string;
  auth: CatalogServerAuthV1;
}

export interface CatalogSkillV1 {
  name: string;
  description?: string;
  /**
   * The Markdown recipe, as a `SKILL.md` body. Optional: an entry may announce
   * a Skill it does not ship, and the Skills Package then records a refusal
   * rather than injecting a Skill with nothing to say.
   */
  body?: string;
}

/**
 * One immutable non-first-party bundle named by a Package Catalog entry.
 *
 * The manifest is decoded with the same kernel decoder used for a stored
 * Bot-authored manifest. `sourceHash` is optional because source publication
 * is optional; when present it addresses the retained `.ts` object in the
 * shared Package artifact store.
 */
export interface CatalogPackageBundleV1 {
  contentHash: string;
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
  manifest: FrockBotManifest;
  sourceHash?: string;
}

export interface CatalogEntryV1 {
  schemaVersion: 1;
  catalogId: string;
  packageId: string;
  displayName: string;
  description: string;
  version: string;
  kind: CatalogEntryKindV1;
  manifestHash: string;
  tags?: string[];
  logo?: string;
  homepage?: string;
  servers: CatalogServerV1[];
  setupFields: PackageSettingSchema[];
  skills: CatalogSkillV1[];
  /** Absent means the existing reviewed, compiled-in first-party form. */
  bundle?: CatalogPackageBundleV1;
}

/**
 * The `values` key one `setupFields` entry fills in.
 *
 * A Catalog entry's setup fields are bare JSON Schemas: the shape carries a
 * `title` and a `description` but no identifier, so the key an install records
 * the answer under is derived from the title, and from its position when the
 * schema declares none. Derived in one place because the form that collects
 * the answer and anything that later reads it have to agree.
 */
export function catalogSetupFieldKeyV1(
  field: { title?: string },
  index: number,
): string {
  const slug = (field.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || `setup-${index}`;
}

/** The mutable pointer at `catalog/current`, naming the live generation. */
export interface CatalogPointerV1 {
  schemaVersion: 1;
  generation: string;
  indexHash: string;
}

/** What a reader pins: one generation and the hash of its index bytes. */
export interface CatalogPinV1 {
  generation: string;
  indexHash: string;
}

const GENERATION_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CatalogDecodeError(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new CatalogDecodeError(
        `${label} has unknown field "${String(key)}"`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new CatalogDecodeError(`${label} is missing "${key}"`);
    }
  }
  return value;
}

function text(
  value: unknown,
  label: string,
  maxLength: number,
  { allowEmpty = false } = {},
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new CatalogDecodeError(`${label} is invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : text(value, label, maxLength);
}

function pattern(
  value: unknown,
  label: string,
  expression: RegExp,
  maxLength = 128,
): string {
  const candidate = text(value, label, maxLength);
  if (!expression.test(candidate)) {
    throw new CatalogDecodeError(`${label} is invalid`);
  }
  return candidate;
}

function boundedArray(
  value: unknown,
  label: string,
  maxLength: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new CatalogDecodeError(`${label} must be a bounded array`);
  }
  return value;
}

function entryKind(value: unknown, label: string): CatalogEntryKindV1 {
  if (value !== "package" && value !== "mcp-connector") {
    throw new CatalogDecodeError(`${label} is invalid`);
  }
  return value;
}

function tags(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const decoded = boundedArray(value, label, MAX_CATALOG_TAGS_V1).map(
    (tag, index) => text(tag, `${label}[${index}]`, 64),
  );
  if (
    new Set(decoded.map((tag) => tag.toLocaleLowerCase())).size !==
    decoded.length
  ) {
    throw new CatalogDecodeError(`${label} repeats a tag`);
  }
  return decoded;
}

/**
 * A Catalog logo and homepage are rendered by the browser, so only an absolute
 * `https:` URL is admitted: a `javascript:` or `data:` value in a document the
 * gateway serves would otherwise reach an `href` or an `img`.
 */
function httpsUrl(value: unknown, label: string): string {
  const candidate = text(value, label, 2_048);
  const url = URL.parse(candidate);
  if (!url || url.protocol !== "https:") {
    throw new CatalogDecodeError(`${label} must be an https URL`);
  }
  return candidate;
}

function optionalHttpsUrl(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : httpsUrl(value, label);
}

function withOptional<T extends Record<string, unknown>>(
  base: T,
  optional: Record<string, string | undefined>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) result[key] = value;
  }
  return result as T;
}

function schemaVersion(value: Record<string, unknown>, label: string): void {
  if (value.schemaVersion !== 1) {
    throw new CatalogDecodeError(`${label} schema version is unsupported`);
  }
}

export function decodeCatalogGenerationIdV1(value: unknown): string {
  return pattern(value, "catalog generation", GENERATION_PATTERN, 64);
}

export function decodeCatalogIdV1(value: unknown): string {
  return pattern(value, "catalogId", CATALOG_ID_PATTERN, 64);
}

export function decodeCatalogContentHashV1(
  value: unknown,
  label = "catalog content hash",
): string {
  return pattern(value, label, HASH_PATTERN, 64);
}

export function decodeCatalogIndexEntryV1(value: unknown): CatalogIndexEntryV1 {
  const entry = exactRecord(
    value,
    "catalog entry",
    [
      "catalogId",
      "packageId",
      "displayName",
      "description",
      "version",
      "manifestHash",
      "kind",
    ],
    ["contentHash", "tags", "logo", "homepage"],
  );
  const decoded = withOptional(
    {
      catalogId: decodeCatalogIdV1(entry.catalogId),
      packageId: pattern(entry.packageId, "packageId", PACKAGE_ID_PATTERN, 64),
      displayName: text(entry.displayName, "displayName", 100),
      description: text(entry.description, "description", 2_000, {
        allowEmpty: true,
      }),
      version: text(entry.version, "version", 100),
      manifestHash: decodeCatalogContentHashV1(
        entry.manifestHash,
        "manifestHash",
      ),
      kind: entryKind(entry.kind, "kind"),
    },
    {
      contentHash:
        entry.contentHash === undefined
          ? undefined
          : decodeCatalogContentHashV1(entry.contentHash, "contentHash"),
      logo: optionalHttpsUrl(entry.logo, "logo"),
      homepage: optionalHttpsUrl(entry.homepage, "homepage"),
    },
  );
  const decodedTags = tags(entry.tags, "catalog tags");
  return decodedTags === undefined
    ? decoded
    : { ...decoded, tags: decodedTags };
}

export function decodeCatalogIndexV1(input: unknown): CatalogIndexV1 {
  const value = exactRecord(input, "catalog index", [
    "schemaVersion",
    "generation",
    "entries",
  ]);
  schemaVersion(value, "catalog index");
  const entries = boundedArray(
    value.entries,
    "catalog index entries",
    MAX_CATALOG_ENTRIES_V1,
  ).map(decodeCatalogIndexEntryV1);
  const identifiers = new Set(entries.map((entry) => entry.catalogId));
  if (identifiers.size !== entries.length) {
    throw new CatalogDecodeError("catalog index repeats a catalogId");
  }
  return {
    schemaVersion: 1,
    generation: decodeCatalogGenerationIdV1(value.generation),
    entries,
  };
}

function decodeCatalogServerV1(value: unknown): CatalogServerV1 {
  const server = exactRecord(value, "catalog server", [
    "name",
    "transport",
    "url",
    "auth",
  ]);
  if (server.transport !== "streamable-http" && server.transport !== "sse") {
    throw new CatalogDecodeError("catalog server transport is invalid");
  }
  if (
    server.auth !== "none" &&
    server.auth !== "api-key" &&
    server.auth !== "oauth"
  ) {
    throw new CatalogDecodeError("catalog server auth is invalid");
  }
  return {
    name: text(server.name, "catalog server name", 100),
    transport: server.transport,
    url: httpsUrl(server.url, "catalog server url"),
    auth: server.auth,
  };
}

function decodeCatalogSkillV1(value: unknown): CatalogSkillV1 {
  const skill = exactRecord(
    value,
    "catalog skill",
    ["name"],
    ["description", "body"],
  );
  return withOptional(
    { name: text(skill.name, "catalog skill name", 100) },
    {
      description: optionalText(
        skill.description,
        "catalog skill description",
        2_000,
      ),
      body: optionalText(
        skill.body,
        "catalog skill body",
        MAX_CATALOG_SKILL_BODY_BYTES_V1,
      ),
    },
  );
}

function decodeCatalogPackageBundleV1(input: unknown): CatalogPackageBundleV1 {
  const bundle = exactRecord(
    input,
    "catalog package bundle",
    ["contentHash", "size", "mediaType", "bundlerVersion", "manifest"],
    ["sourceHash"],
  );
  if (!Number.isSafeInteger(bundle.size) || (bundle.size as number) < 0) {
    throw new CatalogDecodeError("catalog package bundle size is invalid");
  }
  if (bundle.mediaType !== "application/javascript") {
    throw new CatalogDecodeError("catalog package bundle mediaType is invalid");
  }
  const manifest = decodeFrockBotManifest(bundle.manifest);
  if (manifest.contributions.runtime?.host !== "bot-isolate") {
    throw new CatalogDecodeError(
      "catalog package bundle manifest must declare a Bot isolate runtime",
    );
  }
  return {
    contentHash: decodeCatalogContentHashV1(
      bundle.contentHash,
      "catalog package bundle contentHash",
    ),
    size: bundle.size as number,
    mediaType: "application/javascript",
    bundlerVersion: text(
      bundle.bundlerVersion,
      "catalog package bundle bundlerVersion",
      128,
    ),
    manifest,
    ...(bundle.sourceHash === undefined
      ? {}
      : {
          sourceHash: decodeCatalogContentHashV1(
            bundle.sourceHash,
            "catalog package bundle sourceHash",
          ),
        }),
  };
}

export function decodeCatalogEntryV1(input: unknown): CatalogEntryV1 {
  const value = exactRecord(
    input,
    "catalog entry detail",
    [
      "schemaVersion",
      "catalogId",
      "packageId",
      "displayName",
      "description",
      "version",
      "kind",
      "manifestHash",
      "servers",
      "setupFields",
      "skills",
    ],
    ["tags", "logo", "homepage", "bundle"],
  );
  schemaVersion(value, "catalog entry detail");
  const decoded = withOptional(
    {
      schemaVersion: 1 as const,
      catalogId: decodeCatalogIdV1(value.catalogId),
      packageId: pattern(value.packageId, "packageId", PACKAGE_ID_PATTERN, 64),
      displayName: text(value.displayName, "displayName", 100),
      description: text(value.description, "description", 2_000, {
        allowEmpty: true,
      }),
      version: text(value.version, "version", 100),
      kind: entryKind(value.kind, "kind"),
      manifestHash: decodeCatalogContentHashV1(
        value.manifestHash,
        "manifestHash",
      ),
      servers: boundedArray(
        value.servers,
        "catalog servers",
        MAX_CATALOG_SERVERS_V1,
      ).map(decodeCatalogServerV1),
      setupFields: boundedArray(
        value.setupFields,
        "catalog setup fields",
        MAX_CATALOG_SETUP_FIELDS_V1,
      ).map(decodePackageSettingSchemaV1),
      skills: boundedArray(
        value.skills,
        "catalog skills",
        MAX_CATALOG_SKILLS_V1,
      ).map(decodeCatalogSkillV1),
    },
    {
      logo: optionalHttpsUrl(value.logo, "logo"),
      homepage: optionalHttpsUrl(value.homepage, "homepage"),
    },
  );
  const decodedTags = tags(value.tags, "catalog tags");
  const bundle =
    value.bundle === undefined
      ? undefined
      : decodeCatalogPackageBundleV1(value.bundle);
  if (bundle && decoded.kind !== "package") {
    throw new CatalogDecodeError(
      "only a package Catalog entry may carry a bundle",
    );
  }
  if (
    bundle &&
    (bundle.manifest.id !== decoded.packageId ||
      bundle.manifest.version !== decoded.version)
  ) {
    throw new CatalogDecodeError(
      "catalog package bundle manifest does not match its entry",
    );
  }
  return {
    ...decoded,
    ...(decodedTags === undefined ? {} : { tags: decodedTags }),
    ...(bundle === undefined ? {} : { bundle }),
  };
}

/** Verify the nested manifest against the entry's immutable manifest hash. */
export async function assertCatalogPackageBundleV1(
  entry: CatalogEntryV1,
): Promise<void> {
  if (!entry.bundle) return;
  const actual = await catalogContentHashV1(
    canonicalJson(entry.bundle.manifest),
  );
  if (actual !== entry.manifestHash) {
    throw new CatalogDecodeError(
      `catalog entry "${entry.catalogId}" bundle manifest failed content hash verification`,
    );
  }
}

export function decodeCatalogPointerV1(input: unknown): CatalogPointerV1 {
  const value = exactRecord(input, "catalog pointer", [
    "schemaVersion",
    "generation",
    "indexHash",
  ]);
  schemaVersion(value, "catalog pointer");
  return {
    schemaVersion: 1,
    generation: decodeCatalogGenerationIdV1(value.generation),
    indexHash: decodeCatalogContentHashV1(value.indexHash, "indexHash"),
  };
}

export function catalogIndexKeyV1(generation: string): string {
  return `catalog/${decodeCatalogGenerationIdV1(generation)}/index.json`;
}

export function catalogEntryKeyV1(
  generation: string,
  catalogId: string,
): string {
  return `catalog/${decodeCatalogGenerationIdV1(generation)}/entry/${decodeCatalogIdV1(catalogId)}.json`;
}

/** Package artifacts share the same immutable store and layout as authored code. */
export function catalogPackageArtifactKeyV1(contentHash: string): string {
  return `packages/${decodeCatalogContentHashV1(contentHash)}.mjs`;
}

export function catalogPackageSourceKeyV1(sourceHash: string): string {
  return `packages/${decodeCatalogContentHashV1(sourceHash)}.ts`;
}

/**
 * The content hash of one Catalog document: SHA-256 over the exact UTF-8 bytes
 * the bucket holds. Hashing the bytes rather than a re-serialization is what
 * makes a pinned `indexHash` mean "these bytes", so a reader that pins one and
 * later reads different bytes at the same key sees a mismatch, not a silent
 * re-canonicalization that hides it.
 */
export async function catalogContentHashV1(document: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(document),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertDocumentSize(document: string, label: string): void {
  if (document.length > MAX_CATALOG_DOCUMENT_BYTES_V1) {
    throw new CatalogDecodeError(`${label} is too large`);
  }
}

function parseDocument(document: string, label: string): unknown {
  assertDocumentSize(document, label);
  try {
    return JSON.parse(document) as unknown;
  } catch (error) {
    throw new CatalogDecodeError(`${label} is not JSON`, { cause: error });
  }
}

async function assertContentHash(
  document: string,
  expectedHash: string,
  label: string,
): Promise<void> {
  const actual = await catalogContentHashV1(document);
  if (actual !== decodeCatalogContentHashV1(expectedHash, `${label} hash`)) {
    throw new CatalogDecodeError(`${label} failed content hash verification`);
  }
}

/**
 * Read one index document: hash first, decode second. A mismatched hash is
 * refused before the bytes are parsed, so nothing downstream ever sees a
 * document that is not the one that was pinned.
 */
export async function decodeCatalogIndexDocumentV1(
  document: string,
  expectedHash: string,
): Promise<CatalogIndexV1> {
  await assertContentHash(document, expectedHash, "catalog index");
  return decodeCatalogIndexV1(parseDocument(document, "catalog index"));
}

export async function decodeCatalogEntryDocumentV1(
  document: string,
  expectedHash: string,
): Promise<CatalogEntryV1> {
  await assertContentHash(document, expectedHash, "catalog entry");
  const entry = decodeCatalogEntryV1(parseDocument(document, "catalog entry"));
  await assertCatalogPackageBundleV1(entry);
  return entry;
}

/** Parse an index document whose hash the caller has not pinned yet. */
export function parseCatalogIndexDocumentV1(document: string): CatalogIndexV1 {
  return decodeCatalogIndexV1(parseDocument(document, "catalog index"));
}

export function parseCatalogEntryDocumentV1(document: string): CatalogEntryV1 {
  return decodeCatalogEntryV1(parseDocument(document, "catalog entry"));
}

/**
 * An entry detail must agree with the index row that named it. The index is
 * what a reader pinned, so identity, version and manifest hash are checked
 * against it rather than trusted from the entry document.
 */
export function assertCatalogEntryMatchesIndexV1(
  entry: CatalogEntryV1,
  indexEntry: CatalogIndexEntryV1,
): void {
  if (
    entry.catalogId !== indexEntry.catalogId ||
    entry.packageId !== indexEntry.packageId ||
    entry.version !== indexEntry.version ||
    entry.kind !== indexEntry.kind ||
    entry.manifestHash !== indexEntry.manifestHash ||
    entry.bundle?.contentHash !== indexEntry.contentHash
  ) {
    throw new CatalogDecodeError(
      `catalog entry "${indexEntry.catalogId}" does not match its index row`,
    );
  }
}

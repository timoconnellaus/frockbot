import type {
  CatalogEntryV1,
  CatalogIndexEntryV1,
} from "@frockbot/catalog-core";

export const PACKAGE_CATALOG_QUERY_MAX_V1 = 200;
export const PACKAGE_CHANGE_SUMMARY_MAX_V1 = 160;
export const PACKAGE_CATALOG_RESULT_MAX_V1 = 50;

export type PackageCatalogChangeActionV1 = "install" | "update" | "remove";

export interface PackageSearchInputV1 {
  query: string;
}

export interface PackageInspectInputV1 {
  catalogId: string;
}

export interface PackageInstallInputV1 {
  catalogId: string;
  contentHash: string;
  /** Optional Bot-authored audit line; the host supplies a plain fallback. */
  summary?: string;
}

export type PackageUpdateInputV1 = PackageInstallInputV1;

export interface PackageRemoveInputV1 {
  packageId: string;
  summary?: string;
}

export interface PackageCatalogSearchOutcomeV1 {
  generation: string;
  entries: CatalogIndexEntryV1[];
}

export interface PackageCatalogInspectOutcomeV1 {
  generation: string;
  entry: CatalogEntryV1;
  declaredTools: string[];
  connectionTypes: Array<{
    id: string;
    displayName: string;
    connected: boolean;
  }>;
  missingConnectionTypes: string[];
  inert: boolean;
  source?: string;
}

export type PackageCatalogChangeOutcomeV1 =
  | {
      status: "recorded";
      action: PackageCatalogChangeActionV1;
      effectId: string;
      packageId: string;
      displayName: string;
      version?: string;
      contentHash?: string;
      generationId: string;
      missingConnectionTypes: string[];
    }
  | {
      status: "refused";
      action: PackageCatalogChangeActionV1;
      effectId: string;
      reason: string;
    };

const PACKAGE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const CATALOG_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function exactWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function bounded(
  value: unknown,
  label: string,
  maximum: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!options.allowEmpty && value.length === 0)
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function identifier(value: unknown, label: string, pattern: RegExp): string {
  const decoded = bounded(value, label, 64);
  if (!pattern.test(decoded)) throw new Error(`${label} is invalid`);
  return decoded;
}

function auditSummary(value: unknown, label: string): string {
  const decoded = bounded(value, label, PACKAGE_CHANGE_SUMMARY_MAX_V1);
  if (decoded.trim() !== decoded || /[\r\n]/u.test(decoded)) {
    throw new Error(`${label} must be one trimmed line`);
  }
  return decoded;
}

export function decodePackageSearchInputV1(
  input: unknown,
): PackageSearchInputV1 {
  const value = record(input, "package_search input");
  exact(value, ["query"], "package_search input");
  return {
    query: bounded(
      value.query,
      "package_search input.query",
      PACKAGE_CATALOG_QUERY_MAX_V1,
      { allowEmpty: true },
    ),
  };
}

export function decodePackageInspectInputV1(
  input: unknown,
): PackageInspectInputV1 {
  const value = record(input, "package_inspect input");
  exact(value, ["catalogId"], "package_inspect input");
  return {
    catalogId: identifier(
      value.catalogId,
      "package_inspect input.catalogId",
      CATALOG_ID,
    ),
  };
}

function decodeInstallLike(
  input: unknown,
  label: "package_install input" | "package_update input",
): PackageInstallInputV1 {
  const value = record(input, label);
  exactWithOptional(value, ["catalogId", "contentHash"], ["summary"], label);
  const contentHash = bounded(value.contentHash, `${label}.contentHash`, 64);
  if (!SHA256.test(contentHash))
    throw new Error(`${label}.contentHash is invalid`);
  return {
    catalogId: identifier(value.catalogId, `${label}.catalogId`, CATALOG_ID),
    contentHash,
    ...(value.summary === undefined
      ? {}
      : { summary: auditSummary(value.summary, `${label}.summary`) }),
  };
}

export function decodePackageInstallInputV1(
  input: unknown,
): PackageInstallInputV1 {
  return decodeInstallLike(input, "package_install input");
}

export function decodePackageUpdateInputV1(
  input: unknown,
): PackageUpdateInputV1 {
  return decodeInstallLike(input, "package_update input");
}

export function decodePackageRemoveInputV1(
  input: unknown,
): PackageRemoveInputV1 {
  const value = record(input, "package_remove input");
  exactWithOptional(value, ["packageId"], ["summary"], "package_remove input");
  return {
    packageId: identifier(
      value.packageId,
      "package_remove input.packageId",
      PACKAGE_ID,
    ),
    ...(value.summary === undefined
      ? {}
      : {
          summary: auditSummary(value.summary, "package_remove input.summary"),
        }),
  };
}

export const PACKAGE_SEARCH_INPUT_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: { type: "string", maxLength: PACKAGE_CATALOG_QUERY_MAX_V1 },
  },
} as const;

export const PACKAGE_INSPECT_INPUT_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["catalogId"],
  properties: { catalogId: { type: "string" } },
} as const;

export const PACKAGE_INSTALL_INPUT_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["catalogId", "contentHash"],
  properties: {
    catalogId: { type: "string" },
    contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
    summary: {
      type: "string",
      maxLength: PACKAGE_CHANGE_SUMMARY_MAX_V1,
      description: "One short plain-language audit line.",
    },
  },
} as const;

export const PACKAGE_UPDATE_INPUT_SCHEMA_V1 = PACKAGE_INSTALL_INPUT_SCHEMA_V1;

export const PACKAGE_REMOVE_INPUT_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["packageId"],
  properties: {
    packageId: { type: "string" },
    summary: {
      type: "string",
      maxLength: PACKAGE_CHANGE_SUMMARY_MAX_V1,
      description: "One short plain-language audit line.",
    },
  },
} as const;

export async function packageCatalogEffectIdV1(input: {
  runId: string;
  action: PackageCatalogChangeActionV1;
  identifier: string;
  contentHash?: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        input.runId,
        input.action,
        input.identifier,
        input.contentHash ?? null,
      ]),
    ),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `catalog-${hex.slice(0, 32)}`;
}

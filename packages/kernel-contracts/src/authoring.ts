// The kernel-declared Package bundler seam.
//
// "Compilation and bundling happen outside Durable Objects. Composition
// consumes immutable, content-addressed artifacts and never builds them."
// The kernel therefore declares *what* a bundler is — a narrow, versioned
// binding that turns Package source text into a content-addressed artifact —
// and owns no implementation of one. `apps/cloudflare-bundler` is the
// production implementation behind the `PACKAGE_BUNDLER` service binding.
//
// A Package that authors code receives this binding from the Durable Object
// host that owns it; it never reaches a Worker `env` itself.
import type {} from "cordis";

/** D7: 256 KB of source per Package. */
export const PACKAGE_BUNDLE_MAX_SOURCE_BYTES = 256 * 1024;
/** The only entry a Bot-authored Package may declare in this slice. */
export const PACKAGE_BUNDLE_ENTRY = "package.ts";
/** Raw HTML is content-addressed without transforming it. */
export const PACKAGE_UI_ARTIFACT_VERSION = "frockbot-inline-html@1";

/** Manifest v5: 1..8 UI pages, each hashed and stored under its own id. */
export const PACKAGE_UI_MAX_PAGES = 8;
export const PACKAGE_UI_PAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface PackageBundleSourceV1 {
  path: string;
  text: string;
}

/** One inline-only HTML page in a bundle request. */
export interface PackageUiPageSourceV1 {
  id: string;
  html: string;
}

/** One content-addressed HTML page in a bundle result. */
export interface PackageUiArtifactPageV1 {
  id: string;
  artifact: PackageUiArtifactV1;
  /** Exact HTML bytes; the Durable Object owns the immutable write. */
  html: string;
}

export interface PackageBundleRequestV1 {
  schemaVersion: 1;
  /** Idempotency key: the Durable-Object-recorded authorship intent id. */
  effectId: string;
  target: "bot-isolate";
  compatibilityDate: string;
  entry: "package.ts";
  sources: PackageBundleSourceV1[];
  /** Immutable inline-only HTML pages; never compiled into app code. */
  uiPages?: PackageUiPageSourceV1[];
}

export interface PackageBundleArtifactV1 {
  /** sha-256 hex of the bundled module bytes. */
  contentHash: string;
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
}

export interface PackageUiArtifactV1 {
  /** sha-256 hex of the exact HTML bytes. */
  contentHash: string;
  size: number;
  mediaType: "text/html";
  bundlerVersion: string;
}

export type PackageBundleResultV1 =
  | {
      schemaVersion: 1;
      effectId: string;
      status: "bundled";
      artifact: PackageBundleArtifactV1;
      uiArtifacts?: PackageUiArtifactPageV1[];
      /** The module bytes as text; the Durable Object owns the artifact write. */
      module: string;
      diagnostics: string[];
    }
  | {
      schemaVersion: 1;
      effectId: string;
      status: "failed";
      failure: string;
      diagnostics: string[];
    };

/** The `PACKAGE_BUNDLER` binding, declared structurally so the kernel stays platform-free. */
export interface PackageBundlerBinding {
  bundle(request: PackageBundleRequestV1): Promise<PackageBundleResultV1>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
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

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label} must be a bounded string`);
  return value;
}

function diagnostics(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length > 8_192) {
      throw new Error(`${label}[${index}] must be a bounded string`);
    }
    return entry;
  });
}

export function decodePackageBundleArtifactV1(
  input: unknown,
  label = "package bundle artifact",
): PackageBundleArtifactV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["contentHash", "size", "mediaType", "bundlerVersion"],
    label,
  );
  if (
    typeof value.contentHash !== "string" ||
    !SHA256_HEX.test(value.contentHash)
  )
    throw new Error(`${label}.contentHash must be a sha-256 hex digest`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0)
    throw new Error(`${label}.size must be a non-negative integer`);
  if (value.mediaType !== "application/javascript")
    throw new Error(`${label}.mediaType is invalid`);
  boundedString(value.bundlerVersion, `${label}.bundlerVersion`, 128);
  return {
    contentHash: value.contentHash,
    size: value.size as number,
    mediaType: "application/javascript",
    bundlerVersion: value.bundlerVersion as string,
  };
}

export function decodePackageUiArtifactV1(
  input: unknown,
  label = "package UI artifact",
): PackageUiArtifactV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["contentHash", "size", "mediaType", "bundlerVersion"],
    label,
  );
  if (
    typeof value.contentHash !== "string" ||
    !SHA256_HEX.test(value.contentHash)
  )
    throw new Error(`${label}.contentHash must be a sha-256 hex digest`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0)
    throw new Error(`${label}.size must be a non-negative integer`);
  if (value.mediaType !== "text/html")
    throw new Error(`${label}.mediaType is invalid`);
  const bundlerVersion = boundedString(
    value.bundlerVersion,
    `${label}.bundlerVersion`,
    128,
  );
  return {
    contentHash: value.contentHash,
    size: value.size as number,
    mediaType: "text/html",
    bundlerVersion,
  };
}

/**
 * The exact v1 decoder for what comes back across the bundler binding. The
 * bundler is a separate Worker, so its answer is an inbound value at a
 * cross-runtime seam and is decoded before a byte of it becomes an artifact.
 */
export function decodePackageBundleResultV1(
  input: unknown,
  label = "package bundle result",
): PackageBundleResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1)
    throw new Error(`${label}.schemaVersion is unsupported`);
  const effectId = boundedString(value.effectId, `${label}.effectId`, 200);
  if (value.status === "bundled") {
    const hasUi = value.uiArtifacts !== undefined;
    exactKeys(
      value,
      [
        "schemaVersion",
        "effectId",
        "status",
        "artifact",
        "module",
        "diagnostics",
        ...(hasUi ? ["uiArtifacts"] : []),
      ],
      label,
    );
    const artifact = decodePackageBundleArtifactV1(
      value.artifact,
      `${label}.artifact`,
    );
    if (typeof value.module !== "string" || value.module.length === 0)
      throw new Error(`${label}.module must be a non-empty string`);
    let uiArtifacts: PackageUiArtifactPageV1[] | undefined;
    if (hasUi) {
      if (
        !Array.isArray(value.uiArtifacts) ||
        value.uiArtifacts.length === 0 ||
        value.uiArtifacts.length > PACKAGE_UI_MAX_PAGES
      ) {
        throw new Error(
          `${label}.uiArtifacts must be a non-empty bounded array`,
        );
      }
      uiArtifacts = value.uiArtifacts.map((candidate, index) => {
        const pageLabel = `${label}.uiArtifacts[${index}]`;
        const page = record(candidate, pageLabel);
        exactKeys(page, ["id", "artifact", "html"], pageLabel);
        const id = boundedString(page.id, `${pageLabel}.id`, 32);
        if (!PACKAGE_UI_PAGE_ID.test(id))
          throw new Error(`${pageLabel}.id is invalid`);
        if (typeof page.html !== "string" || page.html.length === 0)
          throw new Error(`${pageLabel}.html must be a non-empty string`);
        return {
          id,
          artifact: decodePackageUiArtifactV1(
            page.artifact,
            `${pageLabel}.artifact`,
          ),
          html: page.html,
        };
      });
      if (
        new Set(uiArtifacts.map((page) => page.id)).size !== uiArtifacts.length
      )
        throw new Error(`${label}.uiArtifacts contains duplicate ids`);
    }
    return {
      schemaVersion: 1,
      effectId,
      status: "bundled",
      artifact,
      module: value.module,
      ...(uiArtifacts ? { uiArtifacts } : {}),
      diagnostics: diagnostics(value.diagnostics, `${label}.diagnostics`),
    };
  }
  if (value.status === "failed") {
    exactKeys(
      value,
      ["schemaVersion", "effectId", "status", "failure", "diagnostics"],
      label,
    );
    return {
      schemaVersion: 1,
      effectId,
      status: "failed",
      failure: boundedString(value.failure, `${label}.failure`, 256),
      diagnostics: diagnostics(value.diagnostics, `${label}.diagnostics`),
    };
  }
  throw new Error(`${label}.status is invalid`);
}

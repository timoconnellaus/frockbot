/**
 * Versioned DTOs for the Package bundler seam (plan `docs/plans/kernel-and-isolate.md`
 * Step 3). The Bot Durable Object calls `bundle` over the `PACKAGE_BUNDLER`
 * service binding; every inbound value is decoded here before the bundler runs.
 *
 * `ArtifactRefV1` is defined locally until `@frockbot/kernel-composition`
 * (Step 2) exists; the shape is verbatim from the plan.
 */

export const BUNDLER_ENTRY = "package.ts";
/** D7: 256 KB of source per Package. */
export const BUNDLER_MAX_SOURCE_BYTES = 256 * 1024;
/** Must match the kernel contract: raw HTML is never transformed. */
export const BUNDLER_UI_ARTIFACT_VERSION = "frockbot-inline-html@1";

export interface ArtifactRefV1 {
  contentHash: string; // sha-256 hex of the bundled module bytes
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
}

export interface UiArtifactRefV1 {
  contentHash: string;
  size: number;
  mediaType: "text/html";
  bundlerVersion: string;
}

export interface BundleSourceV1 {
  path: string;
  text: string;
}

export interface BundleRequestV1 {
  schemaVersion: 1;
  effectId: string; // idempotency key = DO-recorded intent id
  target: "bot-isolate";
  compatibilityDate: string;
  entry: "package.ts";
  sources: BundleSourceV1[]; // exactly 1 file in this slice
  ui?: { path: "ui.html"; html: string };
}

export type BundleResultV1 =
  | {
      schemaVersion: 1;
      effectId: string;
      status: "bundled";
      artifact: ArtifactRefV1;
      uiArtifact?: UiArtifactRefV1;
      uiHtml?: string;
      /** The module bytes as text. D4: the DO owns the R2 write, not the bundler. */
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

export interface BundlerBinding {
  bundle(request: BundleRequestV1): Promise<BundleResultV1>;
}

/** Stable machine-readable `failure` values. */
export type BundleFailureV1 =
  | "invalid-request"
  | "source-too-large"
  | "ui-too-large"
  | "single-file-only"
  | "bundle-failed"
  | "unresolved-import"
  | "empty-output";

export class BundleDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleDecodeError";
  }
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new BundleDecodeError(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    throw new BundleDecodeError("unknown or missing field");
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum
  )
    throw new BundleDecodeError(`${label} is invalid`);
  return value;
}

function compatibilityDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new BundleDecodeError("compatibilityDate is invalid");
  return value;
}

function decodeBundleSourceV1(input: unknown): BundleSourceV1 {
  const source = record(input, "bundle source");
  exact(source, ["path", "text"]);
  if (source.path !== BUNDLER_ENTRY)
    throw new BundleDecodeError(`source path must be "${BUNDLER_ENTRY}"`);
  if (typeof source.text !== "string" || source.text.length === 0)
    throw new BundleDecodeError("source text is invalid");
  return { path: BUNDLER_ENTRY, text: source.text };
}

export function decodeBundleRequestV1(input: unknown): BundleRequestV1 {
  const value = record(input, "bundle request");
  exact(
    value,
    [
      "schemaVersion",
      "effectId",
      "target",
      "compatibilityDate",
      "entry",
      "sources",
    ],
    ["ui"],
  );
  if (value.schemaVersion !== 1)
    throw new BundleDecodeError("unsupported bundle request");
  if (value.target !== "bot-isolate")
    throw new BundleDecodeError("target is invalid");
  if (value.entry !== BUNDLER_ENTRY)
    throw new BundleDecodeError("entry is invalid");
  if (!Array.isArray(value.sources) || value.sources.length !== 1)
    throw new BundleDecodeError("exactly one source file is required");
  let ui: BundleRequestV1["ui"];
  if (value.ui !== undefined) {
    const rawUi = record(value.ui, "bundle request ui");
    exact(rawUi, ["path", "html"]);
    if (
      rawUi.path !== "ui.html" ||
      typeof rawUi.html !== "string" ||
      rawUi.html.length === 0
    ) {
      throw new BundleDecodeError("ui must contain one non-empty ui.html");
    }
    ui = { path: "ui.html", html: rawUi.html };
  }
  return {
    schemaVersion: 1,
    effectId: boundedText(value.effectId, "effectId", 200),
    target: "bot-isolate",
    compatibilityDate: compatibilityDate(value.compatibilityDate),
    entry: BUNDLER_ENTRY,
    sources: value.sources.map(decodeBundleSourceV1),
    ...(ui ? { ui } : {}),
  };
}

export function failedResult(
  effectId: string,
  failure: BundleFailureV1,
  diagnostics: string[],
): Extract<BundleResultV1, { status: "failed" }> {
  return { schemaVersion: 1, effectId, status: "failed", failure, diagnostics };
}

/**
 * Fail closed on any specifier the bundle did not inline. `bundle: true`
 * silently leaves an unresolved import — bare (`zod`) or relative
 * (`./helper`) — in the output and still reports success; that failure would
 * otherwise only surface at Worker Loader mount time. This slice bundles a
 * single file, so `cloudflare:*` is the one specifier shape that may survive.
 */
export function findUnresolvedSpecifier(code: string): string | undefined {
  const pattern =
    /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)(["'])([^"']+)\1|\bimport\s*\(\s*(["'])([^"']+)\3\s*\)/g;
  for (const match of code.matchAll(pattern)) {
    const specifier = match[2] ?? match[4];
    if (specifier === undefined) continue;
    if (specifier.startsWith("cloudflare:")) continue;
    return specifier;
  }
  return undefined;
}

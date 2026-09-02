/**
 * `apps/cloudflare-bundler` — the Package bundler service
 * (`docs/plans/kernel-and-isolate.md` Step 3, decisions D1/D4/D5/D7).
 *
 * The Bot Durable Object records `authorship:intent:<effectId>` first, then
 * calls `bundle` over the `PACKAGE_BUNDLER` service binding. This Worker is
 * stateless and side-effect free: it returns the module bytes and the artifact
 * reference, and the DO performs the R2 write, so the durable effect stays with
 * its owner (D4). Determinism, not stored state, is what makes a replayed
 * `effectId` safe here — the same sources always produce the same
 * `contentHash`.
 *
 * `@cloudflare/worker-bundler` is imported at module scope on purpose: it
 * dynamically imports `./esbuild.wasm`, and only workerd's module loader can
 * resolve a `WebAssembly.Module` import.
 */
import { createWorker, type Modules } from "@cloudflare/worker-bundler";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  BUNDLER_ENTRY,
  BUNDLER_MAX_SOURCE_BYTES,
  BUNDLER_UI_ARTIFACT_VERSION,
  BundleDecodeError,
  decodeBundleRequestV1,
  failedResult,
  findUnresolvedSpecifier,
  type ArtifactRefV1,
  type UiArtifactRefV1,
  type BundleRequestV1,
  type BundleResultV1,
  type BundlerBinding,
} from "./contracts.ts";

/**
 * Pinned exactly, and recorded on every artifact. `@cloudflare/worker-bundler`
 * is published as experimental with an API that "may change without notice", so
 * a version bump is a re-bundle-everything event.
 */
export const BUNDLER_VERSION = "@cloudflare/worker-bundler@0.2.3";

function moduleText(mainModule: string, modules: Modules): string {
  const entry = modules[mainModule];
  if (typeof entry === "string") return entry;
  return entry?.js ?? entry?.text ?? "";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Never throws across the service binding: every rejection is a
 * `status: "failed"` result carrying a diagnostic.
 */
export async function bundlePackage(input: unknown): Promise<BundleResultV1> {
  let request: BundleRequestV1;
  const rawEffectId =
    typeof input === "object" &&
    input !== null &&
    typeof (input as { effectId?: unknown }).effectId === "string"
      ? (input as { effectId: string }).effectId
      : "";
  try {
    request = decodeBundleRequestV1(input);
  } catch (error) {
    return failedResult(rawEffectId, "invalid-request", [
      error instanceof BundleDecodeError
        ? error.message
        : String(error instanceof Error ? error.message : error),
    ]);
  }

  const source = request.sources[0]!;
  const sourceBytes = new TextEncoder().encode(source.text).byteLength;
  if (sourceBytes > BUNDLER_MAX_SOURCE_BYTES) {
    return failedResult(request.effectId, "source-too-large", [
      `${BUNDLER_ENTRY} is ${sourceBytes} bytes; the limit is ${BUNDLER_MAX_SOURCE_BYTES}`,
    ]);
  }
  const uiBytes = request.ui
    ? new TextEncoder().encode(request.ui.html)
    : undefined;
  if (uiBytes && uiBytes.byteLength > BUNDLER_MAX_SOURCE_BYTES) {
    return failedResult(request.effectId, "ui-too-large", [
      `ui.html is ${uiBytes.byteLength} bytes; the limit is ${BUNDLER_MAX_SOURCE_BYTES}`,
    ]);
  }

  let mainModule: string;
  let modules: Modules;
  let warnings: string[];
  try {
    // `files` holds only the entry: a `package.json` here would let
    // Bot-authored text drive a live registry.npmjs.org subrequest. The
    // decoder already rejects any other path, so this is defence in depth.
    ({
      mainModule,
      modules,
      warnings = [],
    } = await createWorker({
      files: { [BUNDLER_ENTRY]: source.text },
      entryPoint: BUNDLER_ENTRY,
      bundle: true,
    }));
  } catch (error) {
    // esbuild diagnostics arrive as the Error message, with file:line:col.
    return failedResult(request.effectId, "bundle-failed", [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const code = moduleText(mainModule, modules);
  if (code.trim().length === 0) {
    return failedResult(request.effectId, "empty-output", [
      "the bundler produced no module text",
    ]);
  }

  const unresolved = findUnresolvedSpecifier(code);
  if (unresolved !== undefined) {
    return failedResult(request.effectId, "unresolved-import", [
      `the bundled module still imports the unresolved specifier "${unresolved}"; only the single ${BUNDLER_ENTRY} entry and cloudflare:* modules are available`,
      ...warnings,
    ]);
  }

  const bytes = new TextEncoder().encode(code);
  const artifact: ArtifactRefV1 = {
    contentHash: await sha256Hex(bytes),
    size: bytes.byteLength,
    mediaType: "application/javascript",
    bundlerVersion: BUNDLER_VERSION,
  };
  const uiArtifact: UiArtifactRefV1 | undefined = uiBytes
    ? {
        contentHash: await sha256Hex(uiBytes),
        size: uiBytes.byteLength,
        mediaType: "text/html",
        bundlerVersion: BUNDLER_UI_ARTIFACT_VERSION,
      }
    : undefined;
  return {
    schemaVersion: 1,
    effectId: request.effectId,
    status: "bundled",
    artifact,
    module: code,
    ...(uiArtifact ? { uiArtifact, uiHtml: request.ui!.html } : {}),
    diagnostics: warnings,
  };
}

export default class PackageBundler
  extends WorkerEntrypoint
  implements BundlerBinding
{
  /** The `PACKAGE_BUNDLER` binding contract. */
  async bundle(request: BundleRequestV1): Promise<BundleResultV1> {
    return bundlePackage(request);
  }

  /** Same contract over HTTP, for local probing. Not used by the DO. */
  override async fetch(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch (error) {
      payload = { malformed: String(error) };
    }
    return Response.json(await bundlePackage(payload));
  }
}

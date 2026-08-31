// A faithful stand-in for the `PACKAGE_BUNDLER` service binding.
//
// Why a stand-in and not the real Worker: `apps/cloudflare-bundler` imports
// `@cloudflare/worker-bundler`, which dynamically imports a Go-compiled
// `esbuild.wasm`. That import only instantiates under the
// `wrangler: { configPath }` harness form (see
// `apps/cloudflare-bundler/vitest.config.ts`); this app's harness uses the
// `main` + inline `miniflare` form, which routes the dynamic import through
// Vite's Node module runner and cannot instantiate the module. The bundler's
// own workerd suite covers the real `bundlePackage`.
//
// What is real here: the wire contract. This module runs
// `apps/cloudflare-bundler/src/contracts.ts` verbatim — the same
// `decodeBundleRequestV1`, the same `BUNDLER_MAX_SOURCE_BYTES` refusal, the
// same `findUnresolvedSpecifier` fail-closed rule, the same `sha256` content
// address over the emitted bytes, and the same `BundleResultV1` shape. Only
// the transform is different: this is the plan's documented Fallback A
// (transpile-only, no npm resolution), so the fixtures are plain JavaScript.
import {
  BUNDLER_ENTRY,
  BUNDLER_MAX_SOURCE_BYTES,
  BundleDecodeError,
  decodeBundleRequestV1,
  failedResult,
  findUnresolvedSpecifier,
  type BundleRequestV1,
  type BundleResultV1,
  type BundlerBinding,
} from "../../cloudflare-bundler/src/contracts.ts";

export const FAKE_BUNDLER_VERSION = "transpile-only-fallback@0";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fakeBundlePackage(
  input: unknown,
): Promise<BundleResultV1> {
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
      error instanceof BundleDecodeError ? error.message : String(error),
    ]);
  }
  const source = request.sources[0]!;
  const sourceBytes = new TextEncoder().encode(source.text).byteLength;
  if (sourceBytes > BUNDLER_MAX_SOURCE_BYTES) {
    return failedResult(request.effectId, "source-too-large", [
      `${BUNDLER_ENTRY} is ${sourceBytes} bytes; the limit is ${BUNDLER_MAX_SOURCE_BYTES}`,
    ]);
  }
  const code = source.text;
  if (code.trim().length === 0) {
    return failedResult(request.effectId, "empty-output", [
      "the bundler produced no module text",
    ]);
  }
  if (!/export\s+(const|async\s+function|function)/.test(code)) {
    return failedResult(request.effectId, "bundle-failed", [
      "package.ts exports nothing the isolate wrapper can mount",
    ]);
  }
  const unresolved = findUnresolvedSpecifier(code);
  if (unresolved !== undefined) {
    return failedResult(request.effectId, "unresolved-import", [
      `the bundled module still imports the unresolved specifier "${unresolved}"`,
    ]);
  }
  const bytes = new TextEncoder().encode(code);
  return {
    schemaVersion: 1,
    effectId: request.effectId,
    status: "bundled",
    artifact: {
      contentHash: await sha256Hex(bytes),
      size: bytes.byteLength,
      mediaType: "application/javascript",
      bundlerVersion: FAKE_BUNDLER_VERSION,
    },
    module: code,
    diagnostics: [],
  };
}

/**
 * The binding, counting its calls in durable storage so the count survives
 * Durable Object eviction — the whole point of the duplicate-effect test.
 */
export function createCountingBundlerBinding(
  storage: DurableObjectStorage,
  key = "probe:bundler-calls",
): BundlerBinding {
  return {
    async bundle(request: BundleRequestV1): Promise<BundleResultV1> {
      const calls = (await storage.get<number>(key)) ?? 0;
      await storage.put(key, calls + 1);
      return await fakeBundlePackage(request);
    },
  };
}

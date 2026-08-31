# Spike: where does FrockBot bundle Bot-authored TypeScript?

## Status

Spike run 2026-08-31 in an isolated worktree. Answers `docs/plans/kernel-and-isolate.md` Step 3 and
open decision **D1** ("Does `@cloudflare/worker-bundler` run inside a Worker isolate, or do we need a
Container?").

## Question

Where can FrockBot bundle a Bot-authored TypeScript file into an immutable JavaScript artifact,
**outside the Durable Object**, on Cloudflare? D1 says: spike `@cloudflare/worker-bundler` in a
Worker; if it fails, fall back to single-file transpile-only.

## Verdict

**(a) `@cloudflare/worker-bundler` in a dedicated bundler Worker.** It runs under `workerd`, bundles
the 50-line fixture in **185–262 ms cold** and **~10–30 ms warm**, produces a byte-stable artifact
(identical `sha256` across runs and across separate `workerd` processes), and handles every language
feature the slice needs. Build the `apps/cloudflare-bundler` service from Step 3 as written.

Two constraints to carry into Step 3, both from this spike:

1. **The bundler Worker must set `bundle: true` and reject `package.json` in the Bot's source map.**
   With a `package.json` present the bundler resolves npm packages **for real** — it fetched and
   inlined `zod` from `https://registry.npmjs.org` (121,565 B, 229 ms). That is a live network
   subrequest driven by Bot-authored text and is out of scope for this slice. Worse, with a bare
   `import { z } from "zod"` and **no** `package.json`, the bundler silently emits the import
   unresolved and reports success — the failure would land at Worker Loader mount time, not at bundle
   time. The bundler Worker must reject any file other than the single entry `package.ts` and must
   assert the output contains no bare specifiers.
2. **Memory is not proven, only unfalsified.** Miniflare does not enforce the 128 MB isolate cap
   (`docs/research/zerobsai-memory-sandbox.md` finding 15 — zerobsai's `VibeSiteDO` passed
   `wrangler dev` and OOMed on every production request). A green spike here is _not_ evidence the
   deployed Worker fits. Step 3 must include a production smoke test that bundles the largest allowed
   source, and the size quota must be set from that measurement, not guessed.

Fallback B (Container) is not needed. Fallback A (transpile-only) is the documented degrade path if
constraint 2 turns red: **sucrase** is already proven under `workerd` here at 79 KiB gzip and ~1 ms.

## Results

| #   | Point                                      | Result                              | Observed                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `@cloudflare/worker-bundler` published?    | **PASS**                            | `0.2.3`, MIT, published 2026-08-18, 26.0 MB unpacked. Pure Worker code — **no `node:` imports**, no filesystem. `dist/esbuild.wasm` is 13,940,120 B (3,835 KiB gzip).                                                                                                                                   |
| 2   | Runs inside a Worker under `workerd`?      | **PASS**                            | Cold `createWorker` **185 ms / 252 ms** (two runs, incl. `esbuild.wasm` compile). Warm ×5: `[15,15,26,10,22]` mean **17.6 ms**; second run `[49,62,9,11,22]` mean **30.6 ms**. Transform-only (`bundle:false`) **10–11 ms**.                                                                            |
| 3   | Fallback A: transpile-only under `workerd` | **PASS (not required)**             | `sucrase@3.35.1` `transform({transforms:["typescript"]})`: cold **1 ms**, warm ×5 `[1,0,1,0,1]`, output stable-hashed. Deployable Worker **483.23 KiB / gzip 79.05 KiB**. Stopped here — first candidate tried, works. `esbuild-wasm`, `@swc/wasm-typescript`, `typescript.transpileModule` not needed. |
| 4   | Fallback B: Container                      | **BLOCKED (not built, not needed)** | Plumbing **does** exist to reuse — see below.                                                                                                                                                                                                                                                           |
| 5   | `sha256` stable across identical runs      | **PASS**                            | `23ee02769127586844484e5ed8a49f593971cb1ce64692f697440195877f748d` for the fixture, identical within a run, across runs, and across two separate `vitest`/`workerd` processes. Sucrase path likewise stable: `1f718d7b16daf3662ee798cd8d1d88b8084be444076ad5e3dd1f907ff3eb0ef9`.                        |
| 6a  | Relative sibling `import`                  | **PASS**                            | `./helper` resolved and inlined into a single module (`SIBLING_OK` present in output, one module in the map).                                                                                                                                                                                           |
| 6b  | npm package `import`                       | **PASS — and that is the problem**  | Not unsupported. See Verdict constraint 1.                                                                                                                                                                                                                                                              |
| 6c  | Top-level `await`                          | **PASS**                            | `var seed = await Promise.resolve(41);` preserved in ESM output.                                                                                                                                                                                                                                        |
| 6d  | TS `satisfies` / `enum`                    | **PASS**                            | `satisfies` stripped; `enum Severity` lowered to the standard `/* @__PURE__ */` IIFE with inlined `"high" /* High */` call sites.                                                                                                                                                                       |
| —   | Syntax error handling                      | **PASS**                            | Throws with an esbuild diagnostic carrying file and position: `Build failed with 1 error: virtual:package.ts:1:22: ERROR: Unexpected ";"` — maps cleanly onto `BundleResultV1.status: "failed"` + `diagnostics`.                                                                                        |
| —   | `nodejs_compat` required?                  | **No**                              | All 11 tests pass with `"compatibility_flags": []`.                                                                                                                                                                                                                                                     |
| —   | Memory                                     | **NOT OBSERVABLE**                  | `workerd`/Miniflare exposes no isolate heap metric and does not enforce 128 MB. See Verdict constraint 2.                                                                                                                                                                                               |

### Deployable size

| Bundler Worker contents                                       | Upload        | gzip             |
| ------------------------------------------------------------- | ------------- | ---------------- |
| `@cloudflare/worker-bundler` (incl. `esbuild.wasm`) + sucrase | 14,484.88 KiB | **3,834.46 KiB** |
| sucrase only (Fallback A)                                     | 483.23 KiB    | **79.05 KiB**    |

`wrangler deploy --dry-run`. The Workers Paid script limit is 10 MiB **compressed**, so 3.83 MiB
gzip fits with headroom. This is a script-size fact, not a memory fact.

### Point 4 — Container, from the docs

`docs/adr/0004-host-fly-computer-in-cloudflare-containers.md` (status: accepted) chose a **shared,
sharded, non-authoritative container service** called from the DO over narrow versioned DTOs carrying
an `effectId` — exactly the effect shape Step 3 already specifies for the bundler. The plumbing to
reuse is real and in-tree:

- `apps/fly-host-prototype/wrangler.jsonc` — a `containers[]` block (`class_name`, `image`,
  `max_instances: 3`) plus the DO binding and `new_sqlite_classes` migration.
- `apps/fly-host-prototype/src/index.ts` — `class FlyHostContainer extends Container` from
  `@cloudflare/containers@0.3.7`, with `defaultPort`, `sleepAfter: "2m"`, `enableInternet`,
  `interceptHttps`, an `outboundByHost` egress deny, and shard routing driven by `FLY_HOST_SHARDS`.
- `apps/fly-host-prototype/Dockerfile` — `node:24-bookworm-slim` with `npm ci`. Adding esbuild to
  this image is a one-line change.

`docs/research/zerobsai-memory-sandbox.md` finding 15 is the prior art _for_ this path: zerobsai moved
bundling out of `VibeSiteDO` and into the sandbox container's `/vibe/bundle` route
(`fe1bfd69:mcp-sandbox-container/vibe-bundler.ts`) precisely because `@cloudflare/worker-bundler` OOMed
the DO's 128 MB isolate. Note the distinction that decides D1: zerobsai's failure was the bundler
**inside a Durable Object**, not inside a Worker. Step 3's separate-service design is the correct
reading of that lesson, and this spike confirms the library itself is not the problem.

**Cost and latency: unquantified in the cited docs.** Neither ADR 0004 nor
`docs/research/zerobsai-memory-sandbox.md` carries a dollar figure or a millisecond figure for
Cloudflare Containers; ADR 0004 only records qualitatively that per-Bot containers "duplicate cold
starts and cost". What this spike _can_ say is the comparison baseline: a warm bundler Worker answers
in **~10–30 ms** and a cold one in **~185–262 ms**, both well inside a container's cold-start budget,
and a Worker has no idle-instance cost. Any move to a container should be forced by the memory
measurement in Verdict constraint 2, not chosen up front.

## Recommended code

The whole finding is in where the import lives. `@cloudflare/worker-bundler` dynamically imports
`./esbuild.wasm`, and **only `workerd`'s module loader can resolve a `WebAssembly.Module` import** —
so the import must sit in the Worker's own module graph.

`apps/cloudflare-bundler/src/index.ts`:

```ts
import { createWorker } from "@cloudflare/worker-bundler";

export default {
  async fetch(request: Request): Promise<Response> {
    const { effectId, sources } = (await request.json()) as BundleRequestV1;

    // Slice contract: exactly one file, named package.ts. A package.json here
    // would let Bot-authored text drive a live registry.npmjs.org fetch.
    if (sources.length !== 1 || sources[0]?.path !== "package.ts") {
      return Response.json({
        status: "failed",
        effectId,
        failure: "single-file-only",
      });
    }

    let modules: Record<string, string>;
    let mainModule: string;
    try {
      ({ mainModule, modules } = (await createWorker({
        files: { "package.ts": sources[0].text },
        entryPoint: "package.ts",
        bundle: true, // inlines relative siblings; leaves cloudflare:* external
      })) as { mainModule: string; modules: Record<string, string> });
    } catch (error) {
      // esbuild diagnostics arrive as the Error message, with file:line:col.
      return Response.json({
        status: "failed",
        effectId,
        failure: "bundle-failed",
        diagnostics: [(error as Error).message],
      });
    }

    const code = modules[mainModule]!;
    // Fail closed: bundle:true silently leaves an undeclared bare specifier
    // as an unresolved import, which would only break at Worker Loader mount.
    if (
      /\bfrom\s*["'][^./][^"']*["']/.test(
        code.replace(/from\s*["']cloudflare:[^"']*["']/g, ""),
      )
    ) {
      return Response.json({
        status: "failed",
        effectId,
        failure: "unresolved-import",
      });
    }

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(code),
    );
    const contentHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return Response.json({ status: "bundled", effectId, contentHash, code });
  },
};
```

The test harness matters as much as the code. `@cloudflare/vitest-plugin` must be pointed at a
`wrangler.jsonc` — the `main` + inline `miniflare` form routes the `.wasm` dynamic import through
Vite's Node module runner, which tries to instantiate the Go-compiled wasm under Node's ESM loader and
dies with `Cannot find package 'gojs' imported from .../dist/esbuild.wasm`:

```ts
// vitest.config.ts
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.join(import.meta.dirname, "wrangler.jsonc"),
      },
    }),
  ],
  test: { include: ["test/**/*.workerd.ts"] },
});
```

Tests drive the bundler through `SELF.fetch` rather than importing `createWorker` directly, for the
same reason — a direct import in the test file is evaluated by the Vite module runner, not `workerd`.

## Spike files

All under the worktree, nothing committed to `main`:

- `apps/cloudflare-bundler-spike/package.json` — `bun add -d` only inside the spike app.
- `apps/cloudflare-bundler-spike/wrangler.jsonc` — `compatibility_date: 2026-08-27`, **no** flags.
- `apps/cloudflare-bundler-spike/vitest.config.ts` — the `wrangler: { configPath }` form.
- `apps/cloudflare-bundler-spike/src/index.ts` — host Worker; runs a named scenario, returns timings,
  module keys, warnings, `sha256`, and output head. Also carries the sucrase (Fallback A) path.
- `apps/cloudflare-bundler-spike/src/sucrase-only.ts` — size-measurement entry for Fallback A.
- `apps/cloudflare-bundler-spike/src/fixture-tool.ts` — the 57-line / 1,494-byte Bot-authored tool
  fixture (`enum`, `satisfies`, generics, interfaces).
- `apps/cloudflare-bundler-spike/test/fixture-source.ts` — generated string form of the fixture.
- `apps/cloudflare-bundler-spike/test/worker-bundler.workerd.ts` — the 11 scenarios above.

Reproduce: `cd apps/cloudflare-bundler-spike && bun run vitest run --config vitest.config.ts --reporter=verbose`
→ `Test Files 1 passed (1) / Tests 11 passed (11)`.

## Versions pinned

| Package                        | Version              |
| ------------------------------ | -------------------- |
| `@cloudflare/worker-bundler`   | `0.2.3`              |
| ↳ `esbuild-wasm`               | `0.28.1`             |
| ↳ `typescript`                 | `6.0.3`              |
| ↳ `sucrase`                    | `3.35.1`             |
| `sucrase` (direct, Fallback A) | `3.35.1`             |
| `@cloudflare/vitest-plugin`    | `1.1.2`              |
| `vitest`                       | `4.1.11`             |
| `wrangler`                     | `4.127.1`            |
| `workerd`                      | `1.20260828.1`       |
| `miniflare`                    | `5.20260828.0-alpha` |
| `bun`                          | `1.3.6`              |
| compatibility date             | `2026-08-27`         |

`@cloudflare/worker-bundler` is published from `cloudflare/agents` and its own README calls it
**experimental, "API may change without notice", "not recommended for production use"** — it also
prints that warning to `stderr` on every `createWorker` call. Pin the exact version, record it as
`bundlerVersion` in the `artifact:<contentHash>` record so an artifact can be traced to the bundler
that produced it, and treat a version bump as a re-bundle-everything event.

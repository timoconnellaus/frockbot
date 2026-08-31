# Plan: Kernel extraction + first Bot-authored tool in a Dynamic Worker isolate

## Status

implemented; see docs/architecture-checks.md

## Resolved decisions

- **D1** spike `@cloudflare/worker-bundler` in Step 3; fall back to single-file transpile-only.
- **D2** loader identity is per-(Bot, artifactSet); cost bounded by the per-User generation-rate quota.
- **D3** DO authority moves out of `plugin-shell` into `packages/kernel-do` as Step 1.5, after the pure Step 1 move.
- **D4** the Bot DO calls the bundler through a service binding, intent recorded first.
- **D5** one artifact per Package; the generation is the set.
- **D6** the slice ships **tool and model binding**: the isolate's `CAPABILITIES` stub exposes model invocation as an Assignment-derived binding, so a Bot-authored adapter is a translation layer over that binding. Steps 4 and 5 grow accordingly (see the "D6 addendum" notes in those steps).
- **D7** quotas: 50 retained generations per Bot, 100 authored generations per User per day, 256 KB source per Package; durable per-User config with these defaults; nightly GC of unreferenced artifacts.
- **D8** `AgentRegistry` stays in the kernel.
- **D9** keep the `@frockbot/agent-core` barrel through Step 5; delete in Step 6.

## Where we are

| Constitutional part | Today                                                                                                                              | Verdict                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop          | `packages/agent-loop/src/index.ts`                                                                                                 | kernel, but imports `@frockbot/agent-core` which _contains_ the registries                                                                                                 |
| Tool registry       | `packages/agent-core/src/tools.ts:60-144` (`ToolRegistry extends Service`)                                                         | implementation living in the kernel → must become a Package                                                                                                                |
| Model registry      | `packages/agent-core/src/llm.ts:54-130` (`LlmRegistry extends Service`)                                                            | same                                                                                                                                                                       |
| System prompt       | `packages/agent-core/src/system-prompt.ts`                                                                                         | product policy → Package                                                                                                                                                   |
| Session/event log   | `packages/agent-core/src/session.ts`                                                                                               | kernel (DO authority projection)                                                                                                                                           |
| Package composition | `packages/plugin-catalog/src/index.ts:69-312` + `packages/application-compiler/src/index.ts` + `apps/agent-runtime/src/runtime.ts` | kernel behaviour, but spread across a _Package-named_ package and an app                                                                                                   |
| DO authority        | `packages/plugin-shell/src/backend.ts` (2571 lines) + `apps/cloudflare/src/bot-state.ts`                                           | admission/log/cursor/idempotency live in a Package (`plugin-shell`) — acceptable only if the kernel's DO-authority part is what `bot-state.ts` calls; see Open decision D3 |
| Worker Loader       | `apps/cloudflare/src/gateway.ts:299-311`, `contracts.ts:179-201`                                                                   | gateway-side, user-application-shaped                                                                                                                                      |

The kernel today imports Packages transitively: `agent-loop` → `agent-core` → (registries). `plugin-shell/src/backend-runner.ts:78-90` builds the whole Cordis root per Turn via `createFoundationRuntime`, which hard-codes `LlmRegistry`, `ToolRegistry`, `SessionStore`, `SystemPromptRegistry` (`apps/agent-runtime/src/runtime.ts:98-108`) — no Composition generation is pinned or recorded anywhere.

---

## Step 1 — Kernel extraction, zero behaviour change

**Goal.** The three kernel parts live in packages that import no Package. Tool execution and model invocation are consumed through kernel-declared interfaces. Existing 602 tests pass unchanged.

**Package moves (pure moves + import rewrites, no logic edits):**

- new `packages/kernel-contracts` ← `agent-core/src/types.ts`, `session.ts`, plus new `tool-execution.ts`, `model-invocation.ts`. Depends on `cordis` only.
- new `packages/kernel-composition` ← `plugin-catalog/src/index.ts` (`PackageCatalog`, `ContributionHost`, `LocalCordisContributionHost`), `plugin-catalog/src/manifest.ts`, `application-compiler/src/index.ts`. `packages/plugin-catalog` keeps its manifest/name as a re-export shim for one release.
- `packages/agent-loop` → `packages/kernel-agent-loop`; also absorbs `agent-core/src/agent.ts` (`AgentRegistry` is loop lifecycle, not a Package). Imports only `@frockbot/kernel-contracts`.
- new `packages/plugin-tools` ← `agent-core/src/tools.ts` verbatim; `ToolRegistry implements ToolExecution`. Runtime Contribution, manifest `id: "tools"`.
- new `packages/plugin-models` ← `agent-core/src/llm.ts` verbatim; `LlmRegistry implements ModelInvocation`. Manifest `id: "models"`.
- new `packages/plugin-prompt` ← `agent-core/src/system-prompt.ts`.
- `packages/agent-core` becomes a re-export barrel over the four above, so the ~14 Packages listed at `packages/plugin-*/package.json` keep compiling. Deleted in Step 6.

**Kernel-declared interfaces** (`packages/kernel-contracts/src/`):

```ts
// tool-execution.ts
export interface ToolExecutionContext {
  botId: string;
  agentId: string;
  sessionId: string;
  compositionGenerationId: string; // NEW: pinned generation, see Step 2
  signal: AbortSignal;
}
export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}
export type ToolPreparation =
  | { kind: "ready"; call: ToolCall; idempotent: boolean }
  | { kind: "denied"; call: ToolCall; result: ToolExecutionResult };
export interface ToolExecution {
  schemas(): ToolSchema[];
  prepare(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation>;
  executePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
declare module "cordis" {
  interface Context {
    tools: ToolExecution;
  }
}

// model-invocation.ts
export interface ModelInvocation {
  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
  reconcile(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): Promise<LlmReconciliationOutcome>;
}
declare module "cordis" {
  interface Context {
    llm: ModelInvocation;
  }
}
```

`compositionGenerationId` is added to `ToolExecutionContext` in this step but populated with a literal `"bootstrap"` until Step 2, so the type churn lands with the refactor and not with the feature.

**Architecture check (new, gating):** `scripts/check-kernel-imports.ts`, sibling of `scripts/check-ui-styles.ts`, walks the import graph of `packages/kernel-*` and fails on any `@frockbot/plugin-*`, `@frockbot/application-*`, `applications/`, or `apps/` specifier. Wire into `bun run typecheck` in root `package.json:29`.

**Tests that gate:** whole suite green with zero test-file edits other than import specifiers; `bun run typecheck`; new kernel-import check.

**What could go wrong.** (a) `agent-core`'s `declare module "cordis"` blocks are split across four packages — if a consumer imports only one, `ctx.tools` disappears. Mitigation: `kernel-contracts` owns _all_ augmentations; Packages import the interface, never re-declare. (b) Cordis `Service` name collisions if both `plugin-tools` and the barrel register `"tools"` — barrel must re-export types/classes, never plugin instances. (c) Circular `kernel-agent-loop` ↔ `kernel-contracts` if `Agent` types stay in contracts; keep `Agent`/`AgentRegistry` entirely in the loop.

---

## Step 2 — Composition generations recorded and pinned per Turn

**Goal.** DoD items 1 (finished), 5 (read side) and 6. Still one bootstrap generation, no isolates.

**Records** (Bot DO storage; existing style is prefixed KV over the SQLite backend — see `packages/plugin-shell/src/backend.ts:73-99`):

| Key                                            | Value                                    |
| ---------------------------------------------- | ---------------------------------------- |
| `composition:current`                          | `{ generationId, artifactSetHash }`      |
| `composition:generation:<generationId>`        | `CompositionGenerationV1`                |
| `composition:index:<createdAt>:<generationId>` | `generationId` (ordered list/pagination) |
| `composition:last-known-good`                  | `generationId`                           |

```ts
export type PackageProvenanceV1 =
  | { kind: "first-party"; packageId: string; version: string }
  | {
      kind: "user";
      packageId: string;
      version: string;
      userId: string;
      authoredAt: string;
    }
  | {
      kind: "bot";
      packageId: string;
      version: string;
      botId: string;
      sessionId: string;
      turnId: string;
      runId: string;
      authoredAt: string;
    };

export interface ArtifactRefV1 {
  contentHash: string; // sha-256 hex of the bundled module bytes
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
}
export interface CompositionMemberV1 {
  packageId: string;
  specifier: string;
  version: string;
  manifestHash: string;
  provenance: PackageProvenanceV1;
  artifact?: ArtifactRefV1; // absent ⇒ first-party, runs in the kernel isolate
}
export type CompositionOriginV1 =
  | { kind: "bootstrap" }
  | { kind: "bot-authored"; runId: string; sessionId: string; turnId: string }
  | { kind: "user-install"; userId: string }
  | { kind: "revert"; revertsTo: string; userId: string };

export interface CompositionGenerationV1 {
  schemaVersion: 1;
  generationId: string; // lexicographically sortable, monotonic per Bot
  artifactSetHash: string; // sha-256 over canonical member list — the loader identity
  parentGenerationId?: string;
  createdAt: string;
  origin: CompositionOriginV1;
  members: CompositionMemberV1[];
  status: "pending" | "active" | "superseded" | "failed" | "quarantined";
}

export interface CompositionStore {
  // DO implements; kernel declares
  current(): Promise<CompositionGenerationV1>;
  lastKnownGood(): Promise<CompositionGenerationV1>;
  propose(generation: CompositionGenerationV1): Promise<void>;
  commit(generationId: string): Promise<void>;
  list(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }>;
}
export interface MountedComposition {
  readonly generation: CompositionGenerationV1;
  readonly root: Context;
  verify(signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}
export interface CompositionHost {
  mount(
    generation: CompositionGenerationV1,
    signal: AbortSignal,
  ): Promise<MountedComposition>;
}
```

`artifactSetHash` reuses `canonicalJson` + `sha256` from `packages/application-compiler/src/index.ts:66-96` (now `kernel-composition`).

**Files to touch.** `packages/kernel-composition/src/generation.ts` (new). `packages/plugin-shell/src/backend.ts:2237-2318` (`acceptRun`) writes the pinned `generationId` into the admitted `StoredRun` inside the same transaction that writes `ACTIVE_RUN_KEY`. `apps/cloudflare/src/contracts.ts:64-77` (`StoredRun`) gains `compositionGenerationId: string`. `packages/kernel-agent-loop` emits a `composition/pinned` session event at `turn/start`. `packages/plugin-shell/src/backend-runner.ts:78-90` takes a `MountedComposition` instead of building a root.

**Tests.** Admitted Turn records a generation id; the id is stable across DO eviction mid-Turn (`evictDurableObject` from `cloudflare:test`, pattern at `apps/cloudflare/test/fly-compatibility.workerd.ts:2`); a generation change between admission and execution does not move the in-flight Turn; session log replay reproduces the exact `NormalizedModelRequest` given the generation.

**Risk.** The generation must be pinned at _admission_, not at execution, or eviction-and-resume silently upgrades a Turn. `backend.ts:1391` (`executeResumedRun`) must read the pin from the `StoredRun`, not recompute.

---

## Step 3 — Bundling outside the Durable Object

**Goal.** A content-addressed artifact can be produced from TypeScript text and stored, with no bundler in the DO isolate.

**Where bundling runs.** A **separate Worker service**, `apps/cloudflare-bundler`, service-bound to the gateway Worker and the Bot DO as `PACKAGE_BUNDLER`. Rationale, from `docs/research/cloudflare-dynamic-workers.md`: `@cloudflare/worker-bundler` "can compile TypeScript and resolve npm dependencies before loading the resulting modules" (§Why the model fits), and constraint 5 gives 128 MB per _isolate_ — a dedicated isolate keeps the bundler's memory out of the DO, satisfying the ADR's "in-object bundling exceeds the 128 MB isolate limit". Constraint 3 ("Runtime imports are not package installation") is why a bundle step exists at all. The zerobsai prior art (`docs/research/zerobsai-memory-sandbox.md` §12) ships _no_ bundler — plain JS source in a D1 row, a 2-entry module map — which is the fallback if `@cloudflare/worker-bundler` will not run under `workerd` (see Open decision D1).

**Effect ordering (constitution, Durable effects).** The DO writes `authorship:intent:<effectId>` _before_ the service call; the bundler is idempotent on `effectId`; the DO writes `artifact:<contentHash>` after. Recovery reads the intent and either finds the artifact in R2 by hash or classifies the effect unknown — it never re-bundles blindly.

```ts
export interface BundleRequestV1 {
  schemaVersion: 1;
  effectId: string; // idempotency key = DO-recorded intent id
  target: "bot-isolate";
  compatibilityDate: string;
  entry: "package.ts";
  sources: { path: string; text: string }[]; // ≤ 1 file in this slice
}
export type BundleResultV1 =
  | {
      schemaVersion: 1;
      effectId: string;
      status: "bundled";
      artifact: ArtifactRefV1;
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
```

**Records.** `artifact:<contentHash>` → `{ contentHash, size, bundlerVersion, provenance, r2Key, createdAt }`. R2 key `packages/<contentHash>.mjs` in the existing `APPLICATION_ARTIFACTS` bucket (`apps/cloudflare/wrangler.jsonc:20-24`); the reader verifies the hash before use, unlike today's `R2ApplicationArtifacts.load` (`apps/cloudflare/src/index.ts:293-305`).

**Files.** `apps/cloudflare-bundler/{wrangler.jsonc,src/index.ts}` (new). `apps/cloudflare/src/index.ts` extends the artifact store with `put`/`head`/hash-verified `load`. `wrangler.jsonc` gains a `services` binding.

**Tests.** Same source ⇒ same `contentHash`; a syntax error returns `status: "failed"` with diagnostics and writes nothing to R2; replaying the same `effectId` returns the first result and does not re-write; source > the size quota is refused. Bundler tests run under Miniflare, not Bun.

**Spike result (2026-08-31, `docs/research/spike-bundler-runtime.md`).** Resolved in favour of (a): `@cloudflare/worker-bundler@0.2.3` runs in a dedicated Worker under the pinned harness — warm ≈18–30 ms, cold ≈250 ms, deterministic `sha256`, 3.8 MiB gzip. Two hard rules follow: (1) the bundler Worker has **no network egress** (`globalOutbound`-style restriction or no outbound bindings at all), because with a `package.json` present the bundler live-fetches npm — Bot-authored text must never drive a subrequest; (2) it accepts exactly one `package.ts`, rejects any `package.json`, and fails the request if the output still contains a bare import specifier, because the bundler otherwise reports success on an unresolved import that would only fail at mount. `bundlerVersion` is recorded per artifact; memory under the 128 MB limit is unproven in Miniflare and needs a production smoke test before the size quota is final. Fallback A (`sucrase`, 1 ms, 79 KiB) stands ready. Bundler CPU is on the _bundler's_ limits, not the DO's — do not `await` it inside a storage transaction.

---

## Step 4 — Isolate host: mount an artifact through Worker Loader from the Bot DO

**Goal.** DoD item 3, using a hand-seeded artifact from Step 3. No authoring yet.

**Isolate binding contract** (`packages/kernel-contracts/src/isolate.ts`):

```ts
export interface IsolateToolDescriptorV1 {
  name: string;
  description: string;
  inputSchema: unknown;
  idempotent: boolean;
}
export interface IsolateToolInvocationV1 {
  schemaVersion: 1;
  tool: string;
  input: unknown;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  deadlineMs: number;
}
export interface IsolateToolResultV1 {
  schemaVersion: 1;
  content: string;
  isError: boolean;
}
export interface IsolateHealthV1 {
  schemaVersion: 1;
  ok: boolean;
  packageId: string;
  contractVersion: 1;
  tools: IsolateToolDescriptorV1[];
}
/** The wrapper WorkerEntrypoint the kernel generates; Bot code never implements this. */
export interface BotIsolateEntrypoint {
  health(): Promise<IsolateHealthV1>;
  execute(invocation: IsolateToolInvocationV1): Promise<IsolateToolResultV1>;
}
/** Everything Bot code can see. Nothing else is in scope: globalOutbound is null. */
export interface BotIsolateEnv {
  IDENTITY: { botId: string; generationId: string; packageId: string };
  CAPABILITIES: BotCapabilitiesStub; // loopback service binding via ctx.exports, Assignment-derived only
}
export interface BotCapabilitiesStub {
  list(): Promise<
    {
      capabilityId: string;
      kind: "tool" | "model" | "memory" | "notification";
    }[]
  >;
  /** D6 addendum: model invocation as a binding. Streams over RPC; the kernel records
   *  the normalized request and lease in the Bot DO before forwarding. Only capabilities
   *  an enabled model Assignment grants are callable. */
  invokeModel(
    request: NormalizedModelRequest,
  ): Promise<ReadableStream<LlmStreamEvent>>;
  requestAuthority(request: {
    capabilityId: string;
    reason: string;
  }): Promise<{ status: "pending-user-decision"; decisionId: string }>; // never a grant
}
export interface IsolateHost {
  load(input: {
    loaderId: string;
    modules: Record<string, { js: string }>;
    env: BotIsolateEnv;
    limits: { cpuMs: number; subRequests: number };
    compatibilityDate: string;
  }): BotIsolateEntrypoint;
}
```

**Module map — exactly two entries**, following `docs/research/zerobsai-memory-sandbox.md` §12: `index.js` (kernel-generated wrapper `WorkerEntrypoint` that decodes `IsolateToolInvocationV1`, hands user code a narrow `ctx` via `RpcTarget`, and enforces the deadline) and `package.js` (the bundled Bot module). The wrapper text is content-addressed together with the package, so a wrapper change is a new artifact.

**Loader identity.** `bot-package:${userId}:${botId}:${artifactSetHash}`. Bot-scoped because bindings are Assignment-derived and Assignments are Bot-scoped, and `LOADER.get` requires the callback to return identical `WorkerCode` for an id (research constraint 2). This costs one unique Dynamic Worker per (Bot, artifact set) per day — see Open decision D2.

**Reusable from the existing slice:** `WorkerCode`/`LoadedWorker`/`WorkerLoader` shapes and `globalOutbound: null` + `limits` (`apps/cloudflare/src/contracts.ts:179-201`); the immutable-callback call pattern (`apps/cloudflare/src/gateway.ts:299-311`); id validation (`gateway.ts:22-31` `applicationDeploymentId`); `createImmutablePlanRequestFactory` (`apps/cloudflare/src/immutable-application.ts`) for caching the mounted Composition per DO instance; `PackageCatalog`'s prepare/commit/rollback (`packages/plugin-catalog/src/index.ts:118-180`), which is already the two-phase mount the constitution asks for; `evictDurableObject` harness (`apps/cloudflare/vitest.config.ts`).

**Must be replaced:** `WorkerCode.env` is typed `UserApplicationEnv` (`contracts.ts:174-185`) — generalize to `BotIsolateEnv`. The loader is bound only into the gateway (`apps/cloudflare/src/index.ts:371`) — add a second `worker_loaders` binding `BOT_PACKAGES` to `wrangler.jsonc:14-18` and read it from the DO env. `artifacts.load(applicationHash)` keys on the deploy-time constant `DEFAULT_APPLICATION_HASH` (`wrangler.jsonc:68`) — Bot artifacts are content-addressed at runtime. `LocalCordisContributionHost` (`plugin-catalog/src/index.ts:253-312`) resolves by module import — a new `BotIsolateContributionHost implements ContributionHost` sits beside it and returns a `PreparedContribution` whose `commit()` registers one `ToolDefinition` per `health().tools` entry that RPCs into the isolate. `createFoundationRuntime` (`apps/agent-runtime/src/runtime.ts:80-190`) hard-codes the registries and `sessionId "barebones"` — becomes the kernel composition bootstrap driven by a `CompositionGenerationV1`.

**Tests (Miniflare/workerd, mandatory).** Isolate tool callable end-to-end through `ctx.tools`; `fetch()` inside Bot code rejects; the isolate cannot reach `ctx.storage`, secrets, or another Bot's DO; `requestAuthority` returns a pending decision, never a grant; two Bots with the same artifact get different loader ids; a Turn that uses no isolate tool makes no loader call.

**Spike result (2026-08-31, `docs/research/spike-worker-loader-from-do.md`).** Resolved: a DO can call `env.BOT_PACKAGES.get()` under the pinned Miniflare/workerd with no upgrade. Three contract changes follow: (1) `CAPABILITIES` cannot be an `RpcTarget` placed in `env` (`DataCloneError`); it is a loopback service binding created with `this.ctx.exports.BotCapabilities({ props })`, and per-invocation narrowed objects are `RpcTarget`s _returned_ from its methods; (2) `.get()` never throws — a broken `package.js` fails on the first RPC, so mount and `health()` are one guarded phase; (3) a reused loader id with different code silently serves the first code, so the id must be the content-addressed `artifactSetHash` and nothing else. RPC across the isolate boundary is structured-clone/RpcTarget only, so `ToolDefinition.execute`'s `AbortSignal` cannot cross — use `deadlineMs` plus DO-side `Promise.race`.

---

## Step 5 — Bot authors a Package

**Goal.** DoD item 2 and the activation half of 3.

**D6 addendum.** The authored Package may also declare a `model` Contribution: a Bot-authored adapter that implements the `ModelInvocation` interface _inside the isolate_ by calling `CAPABILITIES.invokeModel`. The kernel treats it as any other model Package member; it can never reach the network. Tests: a Bot-authored adapter that forwards to the binding streams a completion; one that calls `fetch` fails; an adapter without a matching model Assignment gets `pending-user-decision` from `requestAuthority`.

**New first-party Package `packages/plugin-authoring`** (runtime Contribution), exposing one tool, modelled on DeepSeek Harness's `cordis_define`/`cordis_run` split (`docs/research/deepseek-harness-extension.md` §2 — define mints identity and records source, run activates; the model never overwrites a version, it appends a corrected one):

```ts
// tool: package_author
interface AuthorPackageInputV1 {
  packageId: string; // stable Plugin identity; re-authoring appends a version
  displayName: string;
  tool: { name: string; description: string; inputSchema: unknown };
  source: string; // TypeScript text
}
```

**Flow, all inside the admitted Turn:** append `package/author-intent` session event → write `authorship:intent:<effectId>` → call `PACKAGE_BUNDLER` → write `artifact:<contentHash>` with `provenance.kind: "bot"` naming `{ botId, sessionId, turnId, runId }` → compute the new `artifactSetHash` → `CompositionStore.propose(generation)` with `origin.kind: "bot-authored"` → append `package/authored`. The generation is `pending`; the current Turn keeps running on its pin. Activation happens at the _next_ admitted Turn.

**Records.** `authorship:intent:<effectId>`, `artifact:<contentHash>`, `composition:generation:<id>` (status `pending`), `composition:index:<createdAt>:<id>`. Quota counters: `quota:generations:<yyyy-mm-dd>` in the **User** DO (generation-creation rate and retained generations are per-User per the constitution) — exceeding refuses and records a visible failure.

**Tests.** Authoring produces a durable artifact with full provenance; the authoring Turn completes on the _old_ generation; DO evicted between authoring and the next Turn still activates (workerd); a duplicate `effectId` after eviction does not double-bundle; re-authoring the same `packageId` appends a version and supersedes rather than mutating; quota breach is a visible failure, not a throw.

**Risk.** Tool `execute` returning before the artifact is durable would let the model believe it succeeded — record and flush before returning. Bundling latency inside a Turn: bound it with the DO alarm/resumable path (`backend.ts:1480` `deferRunRecovery`) rather than blocking indefinitely.

---

## Step 6 — Fail-closed, quarantine, revert, and the workerd proof

**Goal.** DoD items 4, 5, 7.

**Records.**

| Key                                            | Value                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `composition:failure:<generationId>:<attempt>` | `{ attempt, at, phase: "resolve"\|"mount"\|"health", message, diagnostics }` |
| `composition:failure-count:<generationId>`     | integer                                                                      |
| `composition:quarantine:<generationId>`        | `{ quarantinedAt, reason, failures: 3 }`                                     |
| `notification:<id>`                            | reuses the existing visible-failure channel (`backend.ts:1815`)              |

```ts
export interface CompositionFailureV1 {
  generationId: string;
  attempt: number;
  at: string;
  phase: "resolve" | "bundle" | "mount" | "health";
  message: string;
  diagnostics: string[];
}
export interface CompositionFailureLog {
  record(
    failure: CompositionFailureV1,
  ): Promise<{ consecutiveFailures: number; quarantined: boolean }>;
  list(generationId: string): Promise<CompositionFailureV1[]>;
}
```

**Activation algorithm at the next admitted Turn:** read `composition:current` (pending) → `mount()` → `verify()` (each isolate member answers `health()` with `contractVersion: 1` and a non-empty tool list within a deadline) → on success `commit()`, set `last-known-good`, mark parent `superseded`; on failure record the failure, mark `failed`, mount `last-known-good`, raise a notification, and admit the Turn anyway on the last known good. Third consecutive failure ⇒ `quarantined`, and the generation is never retried until a User acts.

**Revert.** A gateway route (`/api/bots/:id/composition/generations`, `.../revert`) served by a new Shell/Settings client Contribution. `revert(toGenerationId)` creates a **new** generation whose `members` equal the target's, `origin.kind: "revert"`. Diff is computed member-by-member client-side from two `CompositionGenerationV1` records plus the artifact source blobs.

**Tests (all Miniflare/workerd).** A generation whose artifact fails to load leaves the previous Composition serving Turns and records a visible failure; three failures quarantine and the fourth admitted Turn does not attempt it; revert restores the prior member set as a _new_ generation id; `list` paginates; every admitted Turn's log line carries its generation; DO eviction between author and use (the eviction test must sit between Steps 5 and 6's flows, not inside one). Plus the constitutional checks: kernel imports no Package; two provider Packages satisfy the model interface with no kernel diff (`plugin-provider-foundation`, `plugin-provider-ollama-cloud` already exist).

**Risk.** "Fails to load" has three distinct failure sites (R2 read, `LOADER.get` callback, `health()`) and only the third is observable as a rejected promise in a predictable place — enumerate all three in `phase`. A quarantined generation must not block _unrelated_ later generations; quarantine is per-generation, not per-Bot.

---

## Open decisions for Tim

- **D1. Does `@cloudflare/worker-bundler` run inside a Worker isolate, or do we need a Container?** _Recommend:_ spike it in Step 3; if it fails, ship the zerobsai shape — accept only a single TypeScript file with no imports, transpile-only (strip types), no npm resolution. That covers "one tool, TypeScript source" and defers dependency resolution.
- **D2. Loader identity: per-(User, artifactSet) or per-(Bot, artifactSet)?** _Recommend:_ per-Bot. Bindings are Assignment-derived and Assignments are Bot-scoped, so per-User would require identical bindings across a User's Bots. Accept the billing cost (research constraint 4: 1,000 unique Dynamic Workers/month included, then $0.002/worker/day) and bound it with the per-User generation-rate quota.
- **D3. Does DO authority stay in `@frockbot/plugin-shell` (2571 lines) or move to `packages/kernel-do`?** _Recommend:_ move admission / event log / cursor / idempotency / cancellation / scheduling to `packages/kernel-do` in a Step 1.5, leaving `plugin-shell` with run projection and the hosted client. Otherwise the "kernel imports no Package" check is satisfied on a technicality while a Package holds the DO authority. This is the one place the plan currently under-delivers against the constitution; it is deliberately deferred so Step 1 stays a pure move.
- **D4. Does the Bot DO call the bundler, or does the gateway?** _Recommend:_ the DO calls it via service binding, with intent recorded first. The DO is the authority for the effect; the gateway is explicitly non-authoritative.
- **D5. One artifact per Package, or one per Composition generation?** _Recommend:_ per Package. The generation is the _set_; `artifactSetHash` is derived. This lets identical Packages share isolates across generations.
- **D6. Does the isolate get a model binding in this slice?** _Recommend:_ no. Ship tool-only. A Bot-authored model adapter is "a translation layer over a kernel-declared binding" and needs the `CAPABILITIES` RPC surface designed properly; make it slice two.
- **D7. Retention: how many generations per Bot, and are superseded artifacts GC'd?** _Recommend:_ retain 50 generations per Bot; never delete artifacts referenced by a retained generation; a nightly sweep deletes unreferenced R2 objects. Needs a per-User quota number.
- **D8. Does `AgentRegistry` belong to the kernel or become a Package?** _Recommend:_ kernel — it is agent lifecycle, part of "claim input, call the model, run the tools, record events, repeat".
- **D9. Do we keep `@frockbot/agent-core` as a barrel, or rewrite all 14 Package imports in Step 1?** _Recommend:_ keep the barrel through Step 5, delete in Step 6. It keeps the refactor diff reviewable and the 602 tests untouched.

---

## Sequencing

Steps 1 → 2 are refactor-only and can land before any of the feature work. Step 3 is independent of 2 and can be parallelised. Step 4 depends on 3. Steps 5 and 6 are strictly ordered after 4. The two spikes that can invalidate the plan — Worker Loader callable from a DO (Step 4), and the bundler's runtime home (Step 3) — should both be answered in week one, before Step 2 lands.

---

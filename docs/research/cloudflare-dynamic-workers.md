# Cloudflare Dynamic Workers fit for FrockBot

## Status

Accepted direction with an initial runnable vertical slice in `apps/cloudflare`, 2026-08-27.

## Recommendation

Cloudflare Workers are a good candidate for hosting FrockBot. Each Dynamic Worker is a complete **user application** containing the user's UI, Cordis agent runtime, and executable contributions. The application and its contribution configuration are user-scoped: every bot owned by a user shares the same UI, contribution versions, and configuration. Durable conversational state remains bot-scoped.

Use this topology for a proof of concept:

```text
Browser / desktop client
  -> authenticated API / Loader Worker (one deployed service)
       - resolves the authenticated user and owned bot
       - loads userId:runtimeHash through Worker Loader
       -> user-scoped Dynamic Worker application
            - serves the user's complete WebUI and static assets
            - runs the Cordis agent runtime and enabled contributions
            - receives explicit bot/session/run identity per invocation
            - uses user-scoped capability and credential bindings
       -> Bot Durable Object (one per bot)
            - durable run admission and session events
            - eventual WebSocket event fan-out
            - isolated SQLite storage
```

This means one **Dynamic Worker application identity per user application deployment**, not a separately deployed loader service per user and not a fresh Worker per turn. Use `LOADER.get(userId + ":" + applicationHash, callback)`. Replace the application hash whenever UI, agent code, bindings, compatibility settings, or shared contribution configuration changes. The isolate remains a disposable cache; per-bot state never lives only in its Cordis root.

Dynamic Workers are only necessary where package selection changes executable code or where code is untrusted. If every available agent contribution is reviewed, shipped with FrockBot, and can be included in one static Worker bundle, a normal Worker plus per-bot Durable Objects and user-scoped configuration is simpler and cheaper. The proof should compare that baseline with the user-scoped Dynamic Worker design rather than assuming dynamic execution is required.

## Why the model fits

Dynamic Workers let a loader supply JavaScript/CommonJS/Python modules at runtime, choose bindings, control network access, attach tail workers, and enforce CPU/subrequest limits. `@cloudflare/worker-bundler` can compile TypeScript and resolve npm dependencies before loading the resulting modules. This matches FrockBot's package model better than deploying a separately named Worker for every bot. [Dynamic Workers overview](https://developers.cloudflare.com/dynamic-workers/) · [Getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)

Durable Object Facets are especially relevant: a normal supervisor Durable Object can load a class from a Dynamic Worker and run it as a child with its own isolated SQLite database. The supervisor retains access-control and billing state that dynamic code cannot read. A facet can be aborted and restarted with new code while preserving storage, or deleted to remove its storage. [Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)

Bindings provide a capability-oriented security seam. FrockBot can block direct network access with `globalOutbound: null`, then expose narrow RPC capabilities for model calls, approved tools, storage, and integrations. Credentials remain in the loader/supervisor and can be injected without exposing them to contribution code. [Bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/) · [Egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)

## Important platform constraints

1. **An isolate is only a cache.** `LOADER.get(id, callback)` may reuse a warm isolate, but Cloudflare explicitly does not guarantee that two requests reach the same isolate. The callback may run any number of times. No authoritative bot, session, plugin, or turn state can live only in Cordis service memory. [Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)
2. **IDs identify immutable runtime definitions.** A callback must return exactly the same `WorkerCode` for a given ID. Any code or shared contribution configuration change requires a new ID. Use `userId:runtimeHash` because capability bindings and contribution configuration are user-scoped; pass bot identity per invocation and keep bot data behind an authorization-checked Durable Object binding. [Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)
3. **Runtime imports are not package installation.** Dynamic Workers receive a complete module map. TypeScript and npm dependencies must be bundled first. FrockBot cannot preserve the current unrestricted `import(specifier)` contribution resolver as-is. [Getting started](https://developers.cloudflare.com/dynamic-workers/getting-started/)
4. **Paid plan and per-runtime economics.** Dynamic Workers currently require Workers Paid. Billing includes requests, CPU (including isolate startup/parsing), and unique Dynamic Workers created each day. The included allowance is 1,000 unique Dynamic Workers per month, then $0.002 per unique Worker per day; the same code under different IDs counts separately. [Pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
5. **Bounded resources.** Workers have 128 MB per isolate. Paid HTTP requests default to 30 seconds of CPU and can be configured up to five minutes; waiting on network I/O is not CPU time. HTTP wall time has no hard limit while the client remains connected. Dynamic Workers can receive lower custom CPU and subrequest limits. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Dynamic Worker custom limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/)
6. **Node compatibility is broad, not universal.** Workers implement many Node APIs and provide some import-only stubs. `node:crypto` is supported, but packages must be exercised under `workerd`; successful Bun/Node tests are not sufficient evidence. [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
7. **Dynamic Worker logs need explicit tails.** The loader's Workers Logs do not automatically include child logs. Attach a Tail Worker carrying user, runtime, bot, and run identifiers. [Observability](https://developers.cloudflare.com/dynamic-workers/usage/observability/)

## Repository impact

### Code that is close to portable

- `packages/agent-core`, `packages/agent-loop`, and `packages/provider-openai-compatible` mostly use Web APIs plus `node:crypto.randomUUID`; Workers supports crypto, streams, `fetch`, and `AbortSignal`. Replace the imports in `packages/agent-loop/src/index.ts`, `packages/provider-openai-compatible/src/index.ts`, and `packages/plugin-clock/src/agent.ts` with the global `crypto.randomUUID()` rather than depending on Node compatibility.
- The published `cordis@4.0.0-rc.8` core bundle contains no direct `node:` or `process` references. Cordis contexts remain useful for composition inside a Dynamic Worker or facet.
- The event-sourced turn contract in `docs/architecture.md` is appropriate for an evictable runtime because it already requires journal-before-side-effect ordering and interrupted-work reconciliation.
- `packages/protocol` can remain the DTO boundary, although its Electron-specific command/event transport needs an HTTP/WebSocket adapter.

### Required changes

1. **Separate the Worker entrypoint from Electron.** `apps/agent-runtime/src/index.ts` reads `process.env`, requires Electron's `parentPort`, and exits the process. Keep `createFoundationRuntime()` as the composition core, but add a Workers/facet entrypoint and binding-based configuration. The protocol's `worker-ready`, `shutdown`, and `worker-exit` messages are process semantics; hosted transport should instead expose enqueue, cancel, subscribe, status, and deployment revision while retaining run IDs and streamed tool/text events.
2. **Remove singleton assumptions.** `apps/agent-runtime/src/runtime.ts` creates one agent using the hard-coded session ID `"barebones"`; `apps/agent-runtime/src/index.ts` keeps one module-global `activeRunId`. Requests need explicit authenticated user, bot, session, run, and deployment identities, with turn serialization owned by the bot Durable Object rather than an isolate global.
3. **Make session durability asynchronous.** `packages/agent-core/src/session.ts` is an in-memory concrete store whose `append`/`appendBatch` operations are synchronous. A Durable Object SQLite adapter must commit event batches before a model request or tool execution. This likely requires an explicit session-store contract, hydration/reopen semantics, and async append operations throughout `packages/agent-loop`.
4. **Separate runtime disposal from domain deletion.** The current agent-loop disposal path disposes and removes its session. Isolate/facet eviction or Cordis teardown must only release an ephemeral projection; session archival/deletion and bot deletion must remain explicit durable domain operations. Cleanup cannot be assumed to run on eviction.
5. **Replace arbitrary runtime imports.** `apps/agent-runtime/src/runtime.ts` constructs `LocalCordisContributionHost` with `(specifier) => import(specifier)`. `packages/plugin-catalog/src/index.ts` resolves contribution paths at activation time. Build each runtime as a complete module graph and provide a generated contribution registry/map instead. Import package agent and manifest entrypoints directly so desktop/WebUI modules cannot leak into the Worker artifact.
6. **Recreate, do not resume, in-memory Cordis state.** On isolate construction, load the persisted user contribution configuration, construct the Cordis root, and activate the pinned contribution set. For each invocation, resolve explicit bot/session/run identity and reconcile that bot's incomplete session events before admitting input. Cordis maps, promises, abort controllers, and fibers are projections, not durable state.
7. **Move secrets behind capabilities.** The current OpenAI-compatible provider receives an API key and unrestricted base URL directly. For untrusted contributions, expose a scoped model gateway/tool RPC binding and set `globalOutbound: null` (or a restrictive audited gateway). Never place tenant secrets in dynamic code, workflow metadata, or directly readable bindings.
8. **Enforce manifest permissions.** `packages/plugin-catalog/src/manifest.ts` currently validates permission strings, but activation does not enforce them. Extend manifests with provenance/integrity, runtime compatibility, binding declarations, outbound destinations, and limit profiles; compile these into bindings, tool visibility, egress policy, and CPU/subrequest limits.
9. **Replace the desktop bridge.** Route authenticated commands to the bot's supervisor/facet and stream `AgentEvent` DTOs over a WebSocket or streaming HTTP response. Durable Object WebSocket hibernation can keep idle clients connected while resetting in-memory state. [Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
10. **Add a runtime artifact pipeline.** Resolve allowed package versions, verify provenance/integrity and permissions, bundle the exact agent contributions, store the artifact (for example in R2), and derive a runtime hash. Runtime activation should be transactional: persist the desired hash, load and health-check the new facet, then commit or roll back.
11. **Keep Computers out of Dynamic Workers.** FrockBot defines a Computer as a filesystem/process/browser environment. That remains a separate sandbox or remote execution service exposed through a narrow capability; a Dynamic Worker is not a replacement for it.

## Implemented system

The implementation has evolved beyond this research snapshot. See [FrockBot Architecture](../architecture.md) for the authoritative current system shape, including Bot Durable Object Agent ownership and User application publication.

## Dynamic Workflows

Dynamic Workflows can reload tenant code and resume durable steps after sleeps or failures. They may eventually fit FrockBot routines or long-running approval flows. They should **not** replace the current turn journal in the first migration: workflow retries can conflict with FrockBot's rule that model requests and tool calls are not implicitly repeated after an ambiguous interruption. The current loop already allows request middleware to return `"retry"` after a durable `model/request`; that policy must be made explicit and backed by an idempotency contract before Workflow retries are enabled. Preserve the session log's execution-intent semantics first, then evaluate Workflows for operations with explicit idempotency contracts. [Dynamic Workflows](https://developers.cloudflare.com/dynamic-workers/usage/dynamic-workflows/)

## Proof-of-concept plan

### Phase 1: static Worker compatibility

Build a normal Worker/one-bot Durable Object without Dynamic Workers.

Acceptance checks:

- Cordis root starts under `workerd`/Miniflare.
- The clock contribution activates from a generated registry.
- One streamed model-free turn completes.
- SQLite-backed session events survive Durable Object eviction/reconstruction.
- `model/request` and `tool/call` intents are committed before external calls.

This separates general Worker-porting risk from Dynamic Worker risk.

### Phase 2: Dynamic Worker loader

Bundle the same runtime into a module map and load it through `LOADER.get(userId + ":" + runtimeHash)`.

Acceptance checks:

- Every bot owned by one user observes the same contribution versions and shared configuration.
- Bots using the shared user runtime cannot see or mutate each other's sessions or bot-scoped data.
- Different users cannot see each other's state, bindings, credentials, or contribution configuration.
- Repeated requests may cold-start without changing observable session behavior.
- Changing the user's contribution set creates a new runtime ID while preserving every bot's session storage.
- Invalid contribution code fails health-check and rolls back the user to the prior runtime.
- Direct egress is blocked; the clock tool works; a model call works only through the user-scoped gateway.
- Tail logs include user ID, bot ID, runtime hash, turn ID, and request ID without secrets.
- CPU, subrequest, artifact-size, startup-time, and per-active-user cost measurements are recorded.

### Phase 3: hosted client seam

Replace the Electron utility-process bridge with authenticated HTTP/WebSocket routing while retaining the existing protocol DTOs. The desktop application can then become one client of the hosted backend rather than owning the agent process.

## Decision gate

Proceed with the full migration only if the proof demonstrates all of the following:

- Cordis and the selected contribution packages run under `workerd` without unsupported Node behavior.
- Durable session writes preserve FrockBot's journal-before-side-effect invariants.
- A cold start plus package activation is within the latency budget.
- A representative runtime fits the 128 MB memory and startup limits.
- Capability bindings can stream model/tool results without exposing credentials.
- Per-active-user Dynamic Worker pricing is acceptable.

If only the Dynamic Worker phase fails, retain the API Worker + per-bot Durable Object architecture and restrict hosted packages to reviewed contributions bundled into the static deployment.

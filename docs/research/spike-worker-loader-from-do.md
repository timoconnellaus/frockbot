# Spike: Worker Loader from inside a Durable Object

## Status

Spike completed 2026-08-31 in a throwaway worktree. Answers the "Risk" paragraph of
`docs/plans/kernel-and-isolate.md` Step 4 (commit `d6adfd9`; the file is not on
`feat/ollama-user-connections`, so it was read from git):

> Worker Loader is only usable from a Worker context — confirm it works from inside a DO
> under Miniflare _before_ building on it (this is the single highest-risk unknown in the
> plan; spike it at the top of Step 4).

**Verdict: it works. Proceed with one contract change.**

## Question

Can a Durable Object load and call a Dynamic Worker through a `worker_loaders` binding
under Miniflare/workerd, with `globalOutbound: null`, custom limits, and an `RpcTarget`
passed in `env`?

## Versions

Resolved inside the worktree after `bun install` (no upgrades were needed — every version
below is what the repo already pins):

| Package                     | Declared                              | Resolved             |
| --------------------------- | ------------------------------------- | -------------------- |
| `@cloudflare/vitest-plugin` | `^1.1.1`                              | `1.1.2`              |
| `miniflare` (transitive)    | —                                     | `5.20260828.0-alpha` |
| `workerd` (transitive)      | —                                     | `1.20260828.1`       |
| `wrangler`                  | `latest`                              | `4.127.1`            |
| `@cloudflare/workers-types` | `latest`                              | `5.20260830.1`       |
| `vitest`                    | `^4.1.0`                              | `4.1.11`             |
| compatibility date          | `2026-08-27` (host and loaded worker) | —                    |

Miniflare exposes the binding as a first-class option: `workerLoaders?: Record<string,
Record<string, never>>` on `V4WorkerOptionsShape`
(`node_modules/.bun/node_modules/miniflare/dist/src/index.d.ts:10149`), lowered to a
native `{ type: "worker-loader" }` binding
(`dist/src/index.js:111584`). Miniflare adds no shim of its own, so the behaviour observed
below is workerd's, not the test harness's.

## Setup

- Spike worker (DO + capability entrypoint + module-map fixtures):
  `apps/cloudflare/test/spike-worker-loader-worker.ts`
- Spike tests: `apps/cloudflare/test/worker-loader-from-do.spike.ts`
- Spike vitest config: `apps/cloudflare/vitest.spike.config.ts`
  (`workerLoaders: { BOT_PACKAGES: {} }`, `durableObjects: { SPIKE_BOTS: "SpikeBotState" }`,
  plus a `SECRET_TOKEN` host binding used as a leak canary)
- Run: `cd apps/cloudflare && ./node_modules/.bin/vitest run --config vitest.spike.config.ts`
  → **10 passed**.
- The module map is exactly two entries: `index.js` (a kernel-generated `WorkerEntrypoint`
  wrapper with `health()` / `execute(invocation)`) and `package.js` (user code exporting
  `run(input, env)`), with `globalOutbound: null`, `limits: { cpuMs: 5000, subRequests: 5 }`
  and `compatibilityDate: "2026-08-27"`.

## Results

### 1. DO receives the `worker_loaders` binding and calls `.get(id, callback)` — PASS

Inside the DO, `typeof this.env.BOT_PACKAGES.get === "function"`, and
`this.env.BOT_PACKAGES.get(id, async () => code).getEntrypoint().health()` resolves:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "contractVersion": 1,
  "envKeys": ["CAPABILITIES", "IDENTITY"]
}
```

No "only usable from a Worker context" restriction exists. The `.get(id, callback)` form
works (the docs' newer `.load({...})` form was not needed).

### 2. Two-module map + `WorkerEntrypoint` wrapper — PASS

`execute({ schemaVersion: 1, tool, input, deadlineMs })` returns
`{ schemaVersion: 1, content: "variant:A", isError: false }`.

Also proven separately (`2b`): a plain object returned by the loaded worker's RPC method
forwards straight through the DO to the DO's own caller with no re-serialization step —
`{"schemaVersion":1,"content":"variant:A","isError":false}`.

### 3. `IDENTITY` plus a capability stub — PASS, but **only as a `WorkerEntrypoint` stub, not an `RpcTarget`**

This is the one plan-affecting finding.

- `env.CAPABILITIES = new SomeRpcTarget(...)` (the shape `BotCapabilitiesStub` implies in
  the Step 4 contract) **fails**, at the `.get()`/first-call boundary:

  ```
  DataCloneError: Remote RPC references can only be serialized for RPC.
  ```

  The probe isolates it: capability kind `none` → `{"ok":true, envKeys:["IDENTITY"]}`;
  capability kind `rpc-target` → `{"ok":false,"error":"DataCloneError: Remote RPC
references can only be serialized for RPC."}`; capability kind `entrypoint` → `{"ok":true,
envKeys:["CAPABILITIES","IDENTITY"]}`.

- The documented shape works. Export a `WorkerEntrypoint` subclass from the DO's own
  worker and mint a loopback stub with `ctx.exports`:

  ```ts
  this.ctx.exports.SpikeCapabilities({ props: { botId } });
  ```

  `typeof this.ctx.exports` is `"object"` **inside a Durable Object**, so `ctx.exports` is
  available on `DurableObjectState`, not just `ExecutionContext`. Per-Bot state travels in
  `props`, read as `this.ctx.props` in the entrypoint.

  User code then calls across the boundary and gets values back:
  - `env.CAPABILITIES.shout("hello")` → `"bot-package:u1:b3:hash1:HELLO"`
  - `env.CAPABILITIES.describe()` → `{"botId":"…","capabilities":["shout","describe"]}`

- An `RpcTarget` **returned from** a stub method is fine — it is "serialized for RPC".
  `using scope = await env.CAPABILITIES.scope(); await scope.shout("nested")` →
  `"bot-package:u1:b3:hash1:NESTED"`. So a per-call narrowed `ctx` object handed to Bot
  code can still be an `RpcTarget`; only the top-level `env` slot cannot be.

  Confirmed against the docs: `WorkerCode.env` accepts "structured clonable types" and
  "Service Bindings, including loopback bindings from `ctx.exports`"
  (<https://developers.cloudflare.com/dynamic-workers/api-reference/>,
  <https://developers.cloudflare.com/dynamic-workers/usage/bindings/>).

`IDENTITY` as a plain object round-trips unchanged:
`{"botId":"bot-package:u1:b3:hash1","generationId":"gen-1","packageId":"spike-package"}`.

### 4. Egress blocked by `globalOutbound: null` — PASS

`await fetch("https://example.com")` inside `package.js` rejects with:

> This worker is not permitted to access the internet via global functions like fetch().
> It must use capabilities (such as bindings in 'env') to talk to the outside world.

The wrapper's try/catch surfaces it as `{ isError: true }`; nothing reached the network.

### 5. No visibility of DO storage or host bindings — PASS

From inside user code, `Object.keys(env).sort()` is exactly `["CAPABILITIES","IDENTITY"]`
(asserted both from user code and from the wrapper's `health().envKeys`). The leak canary
returns `{"storage":"undefined","ctx":"undefined","state":"undefined","loader":"undefined"}`
— i.e. the host's `SECRET_TOKEN` var, `globalThis.ctx`, the `BOT_STATES` DO namespace and
the `BOT_PACKAGES` loader binding are all absent. Meanwhile the DO's own
`ctx.storage.get("spike")` still reads `"host-only"` across the same calls.

### 6. Identity is per id — PASS

- Same id (`…:hashA`) called repeatedly → `variant:A` every time, including after a
  different id was loaded in between.
- Different id (`…:hashB`) with different `package.js` → `variant:B`.
- **6b (recorded, not asserted as a requirement):** calling `.get()` again with the _same_
  id but a callback returning _different_ code returns the **first** code —
  `variant:A -> variant:A`. The stale callback is silently ignored; the isolate cache
  wins. This matches research constraint 2 (an id must always map to identical
  `WorkerCode`) and means a code change that reuses an id fails _silently_, not loudly.
  The plan's content-addressed `artifactSetHash` in the loader id is what makes this safe.

### 7. Syntax error in `package.js` — PASS (behaviour recorded)

`.get()` does **not** throw. The callback is lazy; the failure surfaces on the **first
RPC** to the entrypoint:

```json
{
  "getThrew": null,
  "healthThrew": "Error: Failed to start Worker:\nUncaught SyntaxError: Unexpected end of input\n  at package.js:4"
}
```

Good news for Step 6: `health()` is a genuine health check — a broken artifact is
detectable by calling `health()` and catching, with a diagnostic that names the module and
line. Note the error is thrown at the RPC, so mount/health must be a single guarded phase;
"loaded successfully" is not observable from `.get()` alone.

### 8. Binding declared on the DO's worker — PASS

`apps/cloudflare/wrangler.jsonc` was given a second entry alongside `USER_APPLICATIONS`:

```jsonc
"worker_loaders": [
  { "binding": "USER_APPLICATIONS" },
  { "binding": "BOT_PACKAGES" },
]
```

`wrangler 4.127.1 deploy --dry-run --env ""` accepts it and lists both:

```
env.USER_APPLICATIONS                                              Worker Loader
env.BOT_PACKAGES                                                   Worker Loader
```

Note there is no "the loader is bound only into the gateway" problem to solve: DO classes
are declared in the _same_ Worker script (`main: "src/index.ts"`), so `BotState` already
shares that script's `env`. The plan's phrasing ("The loader is bound only into the gateway
… add a second `worker_loaders` binding") is really just "add a second binding name so the
Bot path and the user-application path do not share a loader namespace" — which the
dry-run confirms is legal. Miniflare support is equally unconditional: no upgrade,
compatibility flag, or `allowExperimental` was required at the pinned versions.

## Verdict for the plan

**Proceed, with one contract change.** Every Step 4 assumption holds under the pinned
harness: a Durable Object can drive a `worker_loaders` binding, load a two-module map with
`globalOutbound: null` and custom `limits`, call the wrapper's `health()`/`execute()`, keep
its own storage and all host bindings invisible to Bot code (`Object.keys(env)` is exactly
`["IDENTITY","CAPABILITIES"]`), block egress, and key isolate identity off the loader id.
The single required change is to `packages/kernel-contracts/src/isolate.ts` as drafted:
`BotIsolateEnv.CAPABILITIES` cannot be an `RpcTarget` — workerd rejects it with
`DataCloneError: Remote RPC references can only be serialized for RPC`. It must be a
loopback **service binding** minted from the DO with `this.ctx.exports.BotCapabilities({
props })`, i.e. `BotCapabilitiesStub` becomes a `WorkerEntrypoint` subclass and its
per-Bot/per-generation state moves into `ctx.props`. `RpcTarget` remains usable one level
down, as a return value from a capability method — which is exactly the right shape for
the narrowed per-invocation `ctx` the wrapper hands to Bot code, and for D6's streaming
model binding. Two secondary notes for Steps 4 and 6: a stale callback for an already-known
id is ignored silently, so the content-addressed id is load-bearing rather than
belt-and-braces; and a broken artifact throws on the first RPC rather than on `.get()`, so
mount and health-check must be one guarded phase (the diagnostic does name the module and
line, so the Step 6 failure log can be specific).

## Spike artefacts (throwaway)

- `apps/cloudflare/test/spike-worker-loader-worker.ts`
- `apps/cloudflare/test/worker-loader-from-do.spike.ts`
- `apps/cloudflare/vitest.spike.config.ts`
- `apps/cloudflare/wrangler.jsonc` — the `BOT_PACKAGES` loader binding (marked `// SPIKE:`)

None of this is production quality; it exists to answer the question above.

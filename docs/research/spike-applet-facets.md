# Spike: Durable Object facets from a kernel Durable Object, through Worker Loader

## Status

Spike completed 2026-09-03 (lane **S1** of [`docs/plans/applets.md`](../plans/applets.md)). Answers decision **D12(a)** — "facet mount from a kernel DO through `getDurableObjectClass`" — and the whole of §2 "Kernel: `AppletState` and the directory".

**Verdict: it works. Proceed, with four contract-affecting findings for lane K3.**

## Question

Can the kernel-owned `AppletState` Durable Object of [ADR 0022](../adr/0022-applets-as-instance-packages.md) load an Applet's server module through a `worker_loaders` binding, mount the loaded `Applet` class as a **facet** of itself, and get everything the plan promises the Applet: SQLite and key/value storage that survives a code change, a facet the kernel can delete, an `env` of exactly `IDENTITY` + `CAPABILITIES` with no egress, a hibernatable WebSocket, and an alarm?

## Versions

Resolved after `bun install --frozen-lockfile` on `worktree-applets`. No upgrade, no `allowExperimental`, and **no compatibility flag** was needed.

| Package                     | Declared                                     | Resolved             |
| --------------------------- | -------------------------------------------- | -------------------- |
| `@cloudflare/vitest-plugin` | `^1.1.1`                                     | `1.1.2`              |
| `miniflare` (transitive)    | —                                            | `5.20260828.0-alpha` |
| `workerd` (transitive)      | —                                            | `1.20260828.1`       |
| `wrangler`                  | `latest`                                     | `4.127.1`            |
| `@cloudflare/workers-types` | `latest`                                     | `5.20260831.1`       |
| `vitest`                    | `^4.1.0`                                     | `4.1.11`             |
| compatibility date          | `2026-08-27` (host **and** loaded worker)    | —                    |
| compatibility flags         | host `nodejs_compat`; loaded worker **none** | —                    |

`@cloudflare/workers-types@5.20260831.1` already declares the whole surface: `DurableObjectState.facets: DurableObjectFacets` with `get(name, getStartupOptions)`, `abort(name, reason)`, `delete(name)` and `clone(src, dst)`; `FacetStartupOptions { class: DurableObjectClass<T>; id?: DurableObjectId | string }`; and `WorkerStub.getDurableObjectClass(name, options)` (`apps/cloudflare/node_modules/@cloudflare/workers-types/index.d.ts:699,817,4159`). Miniflare needed no facet-specific option — the parent class is declared the same way every other SQLite Durable Object in this repo is (`durableObjects: { APPLET_FACETS: { className: "AppletStateSpike", useSQLite: true } }`).

cloudflare-os's `loadGadgetWorker` passes `allow_irrevocable_stub_storage` and compatibility date `2026-02-01`. **Neither is required here**: every result below passes with the loaded worker on `2026-08-27` and an empty `compatibilityFlags`, which was verified by removing the flag and re-running. That matters because it means `AppletState` can stay on the same compatibility date as the rest of the kernel (`BOT_ISOLATE_COMPATIBILITY_DATE`), rather than pinning Applets to a separate, older one.

## Setup

- Spike worker (kernel DO + capability entrypoint + Applet module fixtures): `apps/cloudflare/test/spike-applet-facet-worker.ts`
- Spike tests: `apps/cloudflare/test/applet-facet.spike.ts`
- Spike vitest config: `apps/cloudflare/vitest.spike.config.ts` (`workerLoaders: { APPLETS: {} }`, `durableObjects: { APPLET_FACETS: { className: "AppletStateSpike", useSQLite: true } }`, plus a `SECRET_TOKEN` host binding as a leak canary)
- Run:

  ```sh
  cd apps/cloudflare && ./node_modules/.bin/vitest run --config vitest.spike.config.ts
  ```

  → **9 passed**.

The spike is deliberately kept out of `test:workerd` (`vitest run --config vitest.config.ts`, which globs `test/**/*.workerd.ts`) so the project suite does not carry a throwaway loader binding and a second Durable Object class. `apps/cloudflare/test/tsconfig.json` gained `../vitest.spike.config.ts` in its `include`, so the spike is typechecked by `bun run typecheck` like everything else.

The module map is two entries — `server.js` (a `DurableObject` subclass named `Applet`, plus a default `WorkerEntrypoint`) and `manifest.js` — with `globalOutbound: null`, `limits: { cpuMs: 5000, subRequests: 10 }`, and `env: { IDENTITY, CAPABILITIES }`. Two versions, `A` and `B`, differ only in a substituted `VERSION` constant, so "different code over the same storage" is observable.

## Results

### 1. A kernel DO loads a module map and mounts its class as a facet — PASS

```ts
const stub = this.env.APPLETS.get(loaderId, () => ({
  compatibilityDate,
  mainModule: "server.js",
  modules,
  env,
  globalOutbound: null,
  limits,
}));
return this.ctx.facets.get("applet", () => ({
  class: stub.getDurableObjectClass("Applet"),
  id: "applet",
}));
```

The returned `Fetcher` is an ordinary RPC stub: `version()` → `"A"`, `addNote("milk")` → `["milk"]`. Inside the facet, both storage APIs work — `this.ctx.storage.sql.exec` (a `CREATE TABLE IF NOT EXISTS` in the constructor plus `INSERT`/`SELECT`) and `this.ctx.storage.put/get`. A facet is SQLite-backed with no option to say so; it inherits from the parent class's declaration.

`ctx.facets.get` is synchronous and returns immediately; the startup callback is lazy, exactly like the loader's `getCode`. The `stub.getDurableObjectClass("Applet")` call happens inside that callback, so the loader and the facet mount are one guarded phase, which is what `AppletState.publish` wants.

### 2. Facet storage survives abort + remount of _different_ code — PASS

Write a row through version `A`; `this.ctx.facets.abort("applet", new Error("remount"))`; load a **different** loader id with a **different** module map (version `B`) and `facets.get` again with the new class. `listNotes()` still returns `["before"]`, `lastNote()` still returns `"before"`, and a further `addNote` appends to the same table (`["before","after"]`). This is the whole point of ADR 0022 and it holds.

The parent's own storage is untouched by any of it (`ctx.storage.get("parent-only")` is still `"kernel-only"` afterwards) **and** invisible from inside: the facet's `ctx.storage.get("parent-only")` is `undefined`. So parent and facet have genuinely separate storage under one Durable Object.

### 3. `ctx.facets.delete("applet")` removes the storage — PASS

After `abort` then `delete`, a fresh mount of the same code sees `listNotes()` → `[]` and `lastNote()` → `null` — the SQL table and the key/value keys are both gone, and the constructor's `CREATE TABLE IF NOT EXISTS` starts over. The kernel's own records survive (`parent-only` still reads `"kernel-only"`), so `AppletState.delete()` can be `ctx.facets.delete("applet")` followed by its own `deleteAll()` in either order.

`facets.delete` is synchronous and returns `void`; there is nothing to await and no confirmation to check.

### 4. `env` is exactly `["CAPABILITIES","IDENTITY"]`, egress is blocked, the loopback stub works — PASS

- `Object.keys(this.env).sort()` inside the facet is exactly `["CAPABILITIES","IDENTITY"]`. The host's `SECRET_TOKEN`, the `APPLETS` loader binding and the `APPLET_FACETS` namespace are all `undefined` from in there.
- `await fetch("https://example.com")` rejects with _"This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world."_ — `globalOutbound: null` covers the facet, not only the loaded worker's entrypoint.
- `CAPABILITIES` is a `ctx.exports` loopback `WorkerEntrypoint` stub minted from the Durable Object (`this.ctx.exports.SpikeAppletCapabilities({ props: { appletId, stateName } })`), per the prior spike's finding that an `RpcTarget` in `env` is refused with `DataCloneError`. Calling it from inside the facet works: `env.CAPABILITIES.shout("hello")` → `"<appletId>:HELLO"`, with per-instance state read from `this.ctx.props`.

`IDENTITY` as a plain object round-trips unchanged.

### 5a. WebSocket through the parent into the facet's hibernation API — PASS

The parent's `fetch(request)` forwards the upgrade straight to the facet's `fetch`. The facet does the ordinary hibernation dance — `new WebSocketPair()`, `this.ctx.acceptWebSocket(server)`, `new Response(null, { status: 101, webSocket: client })` — and handles `webSocketMessage`. The test client accepts the returned `response.webSocket`, sends `"ping"` and receives `"A:echo:ping"`.

Nothing special was needed: the 101 response and its `webSocket` survive two hops (test → parent DO → facet), so `AppletState.connect(viewerTokenClaims, request)` can be a one-line forward after the token check.

### 5b. Alarms — FAIL inside the facet; PASS with the kernel object holding the alarm

**`this.ctx.storage.setAlarm(...)` inside a facet is refused outright**:

> `Error: Facets currently cannot set alarms.`

The string is unconditional in `workerd 1.20260828.1` (it is a literal in the binary, with no compatibility-flag guard beside it), so there is no date or flag to bump. Two details make it worse than a plain rejection:

- The error is **not catchable inside the facet**. A `try { await this.ctx.storage.setAlarm(...) } catch {}` in the Applet's own code does not swallow it; it escapes the facet's RPC and surfaces at the caller. The spike asserts this (`caughtInFacet === false`).
- Without an `alarm()` handler on the facet class you get a different, misleading error first — `TypeError: Your Durable Object class must have an alarm() handler in order to call setAlarm()` — which reads like a user mistake rather than a platform limit.

**The workaround, proven green:** the kernel object owns the alarm and delivers a tick.

1. The Applet calls `env.CAPABILITIES.scheduleAlarm(delayMs)`.
2. The capability entrypoint calls back into the `AppletState` object by name (`env.APPLET_FACETS.getByName(props.stateName).holdAlarmForFacet(delayMs)`), which does `this.ctx.storage.setAlarm(...)` on **its own** storage. The reentrant call back into a Durable Object that is currently awaiting the facet does not deadlock.
3. The kernel object's `alarm()` handler reads the mount input it persisted at mount time (`ctx.storage.kv.put("mount", …)`, the synchronous KV surface, so it is durable across eviction), remounts the facet, and calls `onAlarmTick()` on it.

The facet then records the tick in its own storage: `{ count: 1, version: "A" }`, and the kernel object's alarm is cleared. Total added latency is one extra hop each way.

### 6. Loader identity — PASS

Through the loaded worker's default entrypoint, with the facet out of the way:

- a fresh id → the new code (`"A"`), and the `getCode` callback runs once;
- the **same** id with a callback that would return different code → still `"A"`; the callback is not run at all (a counter in module scope, which survives Durable Object eviction, stays at 1);
- a **distinct** id → the new code (`"B"`), callback count 2.

This reconfirms the prior spike's finding 6b: a stale callback for a known id is silently ignored, so the content-addressed loader id is load-bearing.

### 7. A loader id captures the **first** caller's `env`, across Durable Objects — PASS (recorded; this is the sharpest finding)

Two different `AppletState` objects called `env.APPLETS.get(sameLoaderId, …)` with callbacks that build _different_ `env` values. The second object's facet was handed the **first** object's `IDENTITY` **and** the first object's `ctx.exports` capability stub:

- `second.facetIdentity(shared).appletId` === `first`'s name, not `second`'s;
- `second.facetCapabilityCall(shared, "hi")` === `"<first's name>:HI"` — i.e. calls the Applet believes it is making against its own capability arrive at another instance's kernel object.

The loader cache is keyed by id alone, process-wide, and the whole `WorkerLoaderWorkerCode` — `env` included — is frozen on first load. This was found the hard way: the alarm result (5b) failed intermittently because an earlier result had warmed the same id from a different object, so the alarm was being set on the _other_ object.

### 8. Limits recorded from the workerd binary

Not exercised, but present as hard errors and worth knowing before K3 designs facet naming: `Facet name cannot be empty`, `Facet name is too long (max N characters)`, `Maximum number of facets exceeded`, `Facet nesting depth limit exceeded` (a facet may itself have facets, to a bounded depth), and `DOMDataCloneError: Stubs pointing to Durable Object facets are not serializable` — a facet stub cannot be passed onward over RPC, so the kernel object must forward calls, never hand the facet stub out. Aborted facets report `Facet was deleted.` / `Facet was cloned-over.`

## Verdict for the plan

**Proceed.** `docs/plans/applets.md` §2 stands as written for mount, remount over the same storage, delete, the `env` shape, egress, the loopback capability, tool routing and the WebSocket. Facets are available in the pinned workerd with no flag, no `allowExperimental` and no compatibility-date bump, and the isolation is real in both directions: the Applet cannot see the kernel's storage or bindings, and the kernel's storage is untouched by anything the Applet does. One promise in the plan does not survive contact — a facet cannot set an alarm — and it has a working, cheap substitute the kernel already has the authority to run.

## Contract-affecting findings for lane K3

1. **The loader id must include the Applet instance, not only its code.** The plan's `sha256(contract + serverHash + bindingDigest)` with a per-**User** binding digest is not enough: result 7 shows the loader freezes `env` on first load and reuses it for every later `.get` of that id, so two Applets of the same User with byte-identical code would share one `IDENTITY` and one `CAPABILITIES` stub — the second Applet's capability calls would land on the first Applet's `AppletState` object. **`appletId` must be an input to the loader id.** (`generationId` need not be, since `serverHash` already moves with the code, but including it is free and makes the id read as what it is.)
2. **Applet alarms are the kernel's alarm.** `ctx.storage.setAlarm` inside a facet throws `Facets currently cannot set alarms.` and the throw is not catchable by the Applet, so an SDK that exposes `setAlarm` directly would hand Bot authors an uncatchable crash. The `AppletState` object must own the alarm: a `scheduleAlarm(delayMs)` method on the `CAPABILITIES` entrypoint, `AppletState.alarm()` that remounts the current generation and calls the facet's alarm hook, and the mount input persisted durably (the synchronous `ctx.storage.kv` is the natural place) so the handler can remount after eviction. The SDK's `Applet` base class should surface this as its own `setAlarm`/`onAlarm` pair and never expose `ctx.storage.setAlarm`.
3. **Mount and health must be one guarded phase, and `abort` must precede a version change.** `facets.get` is synchronous and lazy; the loaded code's failures — a syntax error, a constructor that throws, a bad `getDurableObjectClass` name — surface on the **first RPC**, not at `get`. `publish` should therefore `abort` the previous facet, `facets.get` the new class, and call `health()` inside one try/catch; on failure it can re-`get` the previous generation's class over the same, untouched storage. `facets.abort(name, reason)` and `facets.delete(name)` are both synchronous `void` — there is nothing to await and no acknowledgement to record.
4. **Never hand a facet stub out.** `DOMDataCloneError: Stubs pointing to Durable Object facets are not serializable` — `invokeTool` and `connect` must forward through the `AppletState` object rather than returning the facet's stub to the Bot Durable Object or the gateway. The WebSocket upgrade is the one thing that does travel: the facet's 101 `Response` and its `webSocket` forward through the parent unchanged.

Two smaller notes: no compatibility flag is required, so `AppletState` should reuse the kernel's existing compatibility date rather than cloudflare-os's `2026-02-01` plus `allow_irrevocable_stub_storage`; and facet names are bounded in length and count, so the plan's single fixed `"applet"` name stays comfortably inside the limits.

## Spike artefacts (throwaway)

- `apps/cloudflare/test/spike-applet-facet-worker.ts`
- `apps/cloudflare/test/applet-facet.spike.ts`
- `apps/cloudflare/vitest.spike.config.ts`
- `apps/cloudflare/test/tsconfig.json` — one line, so the spike config is typechecked

No production file, and no `wrangler.jsonc` binding, was touched: the `APPLETS` loader binding is declared only in the spike's miniflare options. The prior spike (`docs/research/spike-worker-loader-from-do.md` §8) already proved `wrangler` accepts an additional `worker_loaders` entry, so adding `APPLETS` to `wrangler.jsonc` is lane K3's to do.

# `@frockbot/compose-core` — kernel design

How the kernel meets upstream `docs/acceptance/kernel.md`. Terms are from the
upstream Compose glossary and are used exactly as defined there — not from
FrockBot's own `CONTEXT.md`, which is a different glossary. Decisions already
fixed upstream: ADR-0001 (types from builders), ADR-0002 (observable state is
`@tanstack/store`), ADR-0003 (middleware intercepts, events observe). None of
those acceptance or decision documents were vendored with the code; see
[ADR-0038](../../docs/adr/0038-frockbot-compose-is-a-vendored-copy.md) for the
source boundary.

## Public primitives

Seven builders and one client. Everything else is a method on the client or on
the instance handle a plugin's `setup` receives.

```ts
// Declarations — the type of every value travels with the value that names it.
createContextKey<TValue>(name: string): ContextKey<TValue>
createEvent<TPayload>(name: string): EventDefinition<TPayload, false>
createEvent<TPayload>(name: string, options: { awaited: true }): EventDefinition<TPayload, true>
createAction<TInput = void, TResult = void>(name: string): ActionDefinition<TInput, TResult>

createPlugin<TDeps, TProvides, TValidator>(definition: {
  name: string
  deps?: TDeps                 // context keys and owned actions needed before start
  provides?: TProvides         // context keys it may provide and actions it owns
  validator?: TValidator       // Standard Schema; validates and defaults options
  setup: (instance: Instance<TDeps, TProvides>, options: Options) => void | Cleanup | Promise<void | Cleanup>
}): Plugin<...>

// The client.
createClient(options?: {
  plugins?: Array<PluginEntry>
  checker?: SourceChecker
  onError?: (report: ClientErrorReport) => void
  errorLimit?: number          // retained reports; default 200
}): Client
```

### `Client`

```ts
interface Client {
  readonly checker: SourceChecker | undefined; // client infrastructure, not a plugin
  // Stores (ADR-0002). All three are written inside one `batch()` per settle pass.
  readonly pluginList: Store<Array<PluginEntry>>; // F1 — the source of truth
  readonly instances: Store<Array<InstanceSnapshot>>; // G1, G3
  readonly context: Store<Array<ContextSnapshot>>; // published context, for devtools
  readonly errors: Store<Array<ClientErrorReport>>; // A7, E3, F3 reporting surface

  // Plugin-list edits. Each writes to `pluginList` and resolves when the client is quiescent.
  setPluginList(next: Array<PluginEntry>): Promise<void>;
  addPlugin(entry: PluginEntry): Promise<void>;
  removePlugin(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setOptions(id: string, options: unknown): Promise<void>; // D2, D3 — dispatches `optionsUpdateAction`

  settled(): Promise<void>; // resolves when no reconcile or settle pass is outstanding
  destroy(): Promise<void>; // removes every instance, awaits every cleanup

  // Behaviour.
  dispatch<I, R>(action: ActionDefinition<I, R>, input: I): Promise<R>;
  emit<P, A>(
    event: EventDefinition<P, A>,
    payload: P,
  ): A extends true ? Promise<void> : void;
  on<P, A>(event: EventDefinition<P, A>, listener: Listener<P>): Cleanup; // client-owned
  use<I, R>(
    action: ActionDefinition<I, R>,
    middleware: Middleware<I, R>,
    options?: { first?: boolean },
  ): Cleanup;

  // Inspection.
  inspect(): Array<InstanceSnapshot>; // G1
  resources(instanceId: string): ResourceNode | undefined; // G2
  getContext<T>(key: ContextKey<T>): T | undefined;

  // Plugin source.
  callSource(id: string, name: string, input?: unknown): Promise<unknown>;
}
```

### `Instance` — the handle passed to `setup`

```ts
interface Instance<TDeps, TProvides> {
  readonly id: string;
  readonly client: Client; // F5 — a plugin can edit the list it belongs to
  readonly signal: AbortSignal; // aborted when this activation ends
  readonly context: {
    get<K extends ContextKeysOf<TDeps>>(key: K): ValueOf<K>; // H1 — activation snapshot, never undefined
    peek<T>(key: ContextKey<T>): T | undefined; // B4 — any key, may be absent
  };
  get<A extends ActionsOf<TDeps>>(action: A): ActionCall<A>;
  provide<K extends ContextKeysOf<TProvides>>(key: K, value: ValueOf<K>): void;
  cleanup(fn: Cleanup, label?: string): void;
  on<P, A>(event: EventDefinition<P, A>, listener: Listener<P>): Cleanup;
  emit<P, A>(
    event: EventDefinition<P, A>,
    payload: P,
  ): A extends true ? Promise<void> : void;
  defineAction<A extends ActionsOf<TProvides>>(
    action: A,
    handler: (input: InputOf<A>) => ResultOf<A> | Promise<ResultOf<A>>,
  ): void;
  use<I, R>(
    action: ActionDefinition<I, R>,
    middleware: Middleware<I, R>,
    options?: { first?: boolean },
  ): Cleanup;
  dispatch<I, R>(action: ActionDefinition<I, R>, input: I): Promise<R>;
}
```

Two built-in actions are exported so tooling can wrap them (ADR-0003, D3):
`optionsUpdateAction` (`{ id, options }`) and `reconcileAction` (the next plugin list).

### Choices made where the criteria are silent

- **`provides` is declared.** A plugin may only `provide` a context key or
  `defineAction` for an action listed in its `provides`. Declaring an action is
  what makes the plugin its owner for dependency ordering; registering
  middleware for the action does not establish ownership or an edge. Without
  declarations the client cannot know what a `pending` instance would make
  available, and B6 (name the cycle) is unimplementable.
- **Options need a validator.** With no `validator` a plugin's options are
  `undefined`; typed options come from the Standard Schema, not a type argument.
  This keeps D1 unconditional — every options value that exists was validated.
- **The instance handle is one object, not a class.** Plugin authors write plain
  functions; nothing in the public API is constructed with `new`.
- **Structural tags, never `instanceof` (I2).** Every declaration carries a
  `type: 'compose/context-key' | 'compose/event' | 'compose/action' | 'compose/plugin'`
  string. Identity is object identity of the imported declaration, so two copies
  of the package interoperate as long as the declaration itself is imported by
  value. There is no module-level registry and no interning.
- **Store writes are batched per pass, not per mutation.** Internal state is
  plain `Map`s; the stores are snapshots published once per settle pass inside
  `batch()`. This is what makes C2 true.
- **No `Proxy` anywhere** (I3, ADR-0001): context is read with `get`/`peek`.
- **A plugin composes only through the plugin list (F5).** There is no
  per-instance `start` operation and no second, unreconcilable instance tree.

## Instance lifecycle

Public `status` is exactly the glossary's four values. A fifth, internal `phase`
(`idle` | `setup` | `removing`) tracks work in progress without inventing a term.

```
                created
                   │  options validated (D1) — invalid ⇒ error, never starts
                   ▼
   ┌────────── pending ◀──────────────┐
   │  all deps published              │ a dep stopped being published (B2):
   │  ⇒ run setup (phase = setup)     │ full cleanup, then back to pending
   ▼                                  │
 setup threw (A6)                  active ──────────────────────────────┘
   │  ⇒ everything half-registered
   │    is cleaned up, provisions
   │    unclaimed, siblings untouched
   ▼
 error                              (any) ──▶ removed   entry gone / disabled (F2)
```

- `pending` while `setup` is running: an instance is only `active` once `setup`
  has resolved, which is what makes B3 true — provisions become visible to other
  instances at activation, not at the moment `provide` is called.
- `error` carries the original thrown value on the snapshot (`error`), plus the
  cycle for B6.
- A `removed` instance's record is dropped; re-enabling an entry (F2) builds a
  fresh instance with fresh options and fresh resources.

## Dependencies, pending and re-activation

- `published: Map<Dependency, unknown>` holds only context values and action
  callables provided by `active` instances. `claims: Map<Dependency,
InstanceRecord>` holds every context key claimed by `provide` and action
  claimed by `defineAction`, published or not; a second claim throws (B5 and
  action ownership's equivalent).
- An action listed in `deps` is satisfied only while the plugin declaring that
  action in `provides` is active. `instance.get(action)` reads the activation's
  captured callable, typed from `deps`; the callable dispatches through the
  current middleware chain. This gives actions the same waiting,
  dependent-before-owner cleanup, re-activation, inspection and cycle behavior
  as context keys. Merely calling `use(action, middleware)` adds a resource but
  no dependency edge.
- **Settle pass** — a fixpoint loop, bounded by the instance count, run inside the
  serialised queue:
  1. Any `active` instance whose deps are no longer all published is deactivated
     (full cleanup per A, record kept, status back to `pending`).
  2. Any `pending` instance whose deps are all published runs `setup`; on success
     its provisions are published, which can unblock others on the next turn.
  3. Repeat until nothing changed, then publish the store snapshots.
     Starting is attempted in plugin-list order, deactivation before starting, so
     B1 holds regardless of list order or of which side was added first.
- **Cycles (B6).** After the fixpoint, instances still `pending` are checked
  against a graph over non-active instances: `A → B` when a key in `A.deps`
  appears in `B.provides`. A cycle puts every instance on it into `error` with a
  message naming the ring (`a → b → a`). The loop is bounded, so nothing spins.
  The error is sticky until the entry changes.
- **Deps are snapshotted per activation.** Immediately before `setup`, the
  client captures every declared dep's published value. `context.get` reads
  that map for the lifetime of the activation, including async work that
  outlives deactivation, so its non-optional type remains honest.
  `context.peek` deliberately remains a live read of `published`.

## Cleanup ordering and quiescence

- Every registration (`provide`, `cleanup`, `on`, `use`, `defineAction`)
  appends a **resource node** `{ label, cleanup? }` to the instance's list, in
  registration order.
- Removing or deactivating an instance walks that list in **reverse** (A4),
  awaiting each cleanup. A cleanup that throws is caught, pushed to `errors`
  and passed to `onError`, and the walk continues (A7).
- Before any record releases its resources, every active instance whose deps
  include one of that record's currently provided keys is deactivated,
  recursively. This produces dependent-before-provider cleanup order for a
  removal, deactivation, failure, or whole-client destruction; each dependent
  is kept as `pending` unless its own entry is being removed.
- Each activation owns a fresh `AbortController`. Removal, deactivation, and
  failure abort it before dependent deactivation or cleanup begins, with reason
  `removed`, `deactivated`, or `failed` respectively. Re-activation creates a
  new signal rather than reusing an aborted one.
- `record.removal` memoises the in-flight removal promise: a second `remove`
  returns the same promise, so removing twice is safe and concurrent removals
  await one completion (A2).
- Registering on an instance whose `phase` is `removing`, or whose status is
  `removed`, throws (A5).
- Quiescence: every list edit, reconcile and settle pass runs on a single
  promise queue with an outstanding-work counter. `settled()` loops until the
  counter is zero, so it also covers passes scheduled _by_ a plugin (F5).

## Middleware vs events

|          | Middleware (ADR-0003)                                                            | Events                                                                            |
| -------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Wraps    | a named **action** its owner declared with `defineAction`                        | nothing — observation only                                                        |
| Can      | rewrite input, rewrite result, stop the action by not calling `next` (E1)        | only read the payload (E3)                                                        |
| Order    | registration order, outermost first; `{ first: true }` inserts at the front (E2) | registration order                                                                |
| Failure  | propagates to the dispatcher                                                     | contained, reported to `errors`, other listeners still run (E3)                   |
| Removal  | its owner's removal drops it; later dispatches still complete (E2)               | same                                                                              |
| Dispatch | always `Promise<TResult>`                                                        | `void`, or `Promise<void>` when the event was built with `{ awaited: true }` (E4) |

The chain is rebuilt from the current registration list on each dispatch, so a
middleware removed between dispatches is simply not in the next chain. The
action's owner sees only the input it is finally handed, and never learns whether
a middleware rewrote it, rewrote the result, or stopped the call (E1).

## Plugin-list reconciliation

- The list is `Store<Array<PluginEntry>>` (F1). `PluginEntry` is the union of a
  `PluginObjectEntry`, which requires `plugin` and excludes `source` and `host`,
  and a `PluginSourceEntry`, which requires `source` and may name `host` and
  `stubs`; both share `id`, `options` and `enabled`. Runtime validation still
  rejects untyped input that carries neither or both.
- Any write to the store — by an edit helper or directly — schedules a pass.
  Passes run one at a time on a promise queue, so edits made while a pass is
  running are applied by the next one and never interleave with it (F4). Edits
  made before a scheduled pass has started coalesce into it, so a burst of edits
  is applied once, in list order. The store is the intent; `appliedList` is what
  is running.
- Reconcile is itself a `dispatch(reconcileAction, nextList)` (ADR-0003), so it can
  be observed or wrapped. Its handler:
  1. validates the list (ids present, unique, plugin shaped like a plugin) — a
     failure here throws before anything is touched;
  2. removes instances whose entry disappeared, was disabled (F2), or whose
     plugin or options changed (compared with `shallow` from `@tanstack/store`);
  3. creates records for new or restarted entries, validating options (D1);
  4. runs the settle pass.
     On a throw the client restores `pluginList` to `appliedList`, reports the error
     and rejects the edit's promise; instances are untouched, so no half-applied
     list is ever observable (F3). A vetoed reconcile (middleware that never calls
     `next`) rolls back the same way.
- **Self-edit (F5).** `instance.client` is not the client object `createClient`
  returned: it is a view of it, one per instance, built on first use. Its edit
  helpers and its `settled()` resolve as soon as the edit is _recorded_ while
  that instance's own code is running inside a pass — during its `setup` or one
  of its cleanups, which is exactly what the record's `phase` names. There is
  nothing for it to wait for from in there, and awaiting one of its own edits
  would deadlock on the pass it is part of. The edit schedules a follow-up pass
  like any other, and an outside caller's `settled()` still covers it.

  At any other time — from a tool call, a listener, a timer, anything that runs
  after the instance is `active` — the instance is an ordinary caller and its
  edits resolve on full settlement, like everyone else's. That is what lets a
  plugin that edits the list on someone else's behalf report what its edit did:
  the agent layer's composer awaits `setPluginList` and then reads the statuses
  it produced. A per-instance flag is what makes this exact; a global "a pass is
  running" flag would not, because passes are asynchronous and a caller can be
  in the middle of one without being part of it.

- `setOptions` dispatches `optionsUpdateAction`, whose handler writes the entry's
  options; the ensuing reconcile restarts exactly that entry (D2), and middleware
  on the action can observe, replace or veto the update (D3).

## Inspection model

- `instances` store: one `InstanceSnapshot` per plugin entry, in plugin-list
  order — `{ id, plugin, status, missing: Array<string>, error? }`. `missing`
  lists the names of the dep keys that are not currently published (G1).
- `resources(id)` returns the instance's labelled resource nodes (G2).
- Both are published inside one `batch()` at the end of every pass, so a
  subscriber re-renders once per pass with a consistent view and never polls (G3).
- `errors` collects `{ scope, instanceId?, error }` for cleanup failures,
  listener failures and reconcile failures. It retains the newest `errorLimit`
  reports in occurrence order (default 200); `0` retains none. `errorLimit`
  must be a non-negative integer.

## Hosts and plugin source

How the kernel meets upstream `docs/acceptance/hosts.md` §A and the seam
upstream `docs/acceptance/self-modification.md` §D plugs into. Fixed by upstream
ADR-0004: the
contract and the in-process host live here, every isolation library lives in its
own package, and core stays dependency-free.

A **host** is the environment a plugin's code executes in. A plugin entry that
carries **plugin source** — a string — instead of a `plugin` reference is started
through the host the entry names. Omitting the host is a refused activation;
in-process execution must be selected explicitly.

```ts
{ id: 'greeter', source: '…', host: 'worker', stubs: [toolsStub, logStub] }
```

### The contract

Three types, and nothing a host may assume beyond them.

```ts
interface Host {
  readonly name: string;
  start: (request: HostStartRequest) => Promise<HostInstance>;
}

interface HostStartRequest {
  instanceId: string; // rides on every stub call this instance makes
  code: string; // what the checker produced, or the source as written
  options: unknown; // validated, and structured-clone-safe
  stubs: Record<string, (input: unknown) => Promise<unknown>>;
}

interface HostInstance {
  call: (name: string, input: unknown) => Promise<unknown>;
  stop: () => Promise<void>;
  destroy?: () => Promise<void>;
}
```

`start` is the whole of "load this and hand it its authority". `call` is the
whole of "the client reaches into the plugin": one named export, one
structured-clone-safe argument, one structured-clone-safe result. `stop` ends
one activation and does not resolve until the host has released its code;
optional `destroy` permanently removes state the host retained for that entry.
A host without `destroy` is stateless. Everything else a host might want to do
— caching by content hash, wall-clock limits, tails — is the host package's
business and invisible here.

The contract deliberately does **not** carry a `restart`, an `abort` or a
`status`. Restarting is the kernel's job: it stops the instance and starts a new
one. A host that terminates code abruptly expresses that as a `stop` whose
`call`s afterwards reject, which is what the in-process host does too.

### The written plugin shape

Plugin source is an **ES module**. Its default export is the setup function; its
other named exports are the handlers the client can `call`.

```ts
export default async function setup({ id, options, stubs }) {
  await stubs.tools.register({ name: "add", handler: "add" });
  return () => {
    /* release anything this module itself holds */
  };
}

export async function add({ a, b }) {
  return a + b;
}
```

Why this shape:

- **A module, not a function body.** Every remote host we intend to build loads
  ES modules (a Dynamic Worker takes `{ mainModule, modules }`; a Compartment
  takes a module source). A module is also what a model writes when asked for
  "a TypeScript file", and it is what a `.d.ts` describes.
- **Default export is setup**, so there is one obvious entry point and no name to
  remember. It receives one object, so adding to it later is not a breaking
  change, and returns a cleanup exactly the way `createPlugin`'s `setup` does —
  a written plugin and a written-in-TypeScript plugin have the same lifecycle.
- **Handlers are named exports, called by name.** A function cannot cross a host
  boundary (A5), so a written plugin cannot hand the client a callback. Naming
  the export is the smallest thing that works, it is how RPC into an isolate
  works anyway, and it keeps the registration payload plain data:
  `{ name: 'add', handler: 'add' }` is structured-clone-safe.
- **`stubs` is the only capability object.** There is no `client`, no `instance`,
  no `context` and no `require`. If a written plugin can do it, a stub was
  granted for it.

### Stubs and caller identity

A **stub grant** is created by whoever owns the capability, once, and handed to
entries by the operator:

```ts
const toolsStub = createStub({
  name: "tools",
  declarations: `declare const tools: { register(t: { name: string; handler: string }): Promise<void> }`,
  deps: [toolsKey],
  handler: async ({ input, instance, call }) => {
    const remove = instance.context.peek(toolsKey)!.add({
      name: input.name,
      run: (args) => call(input.handler, args),
    });
    instance.cleanup(remove, `tool(${input.name})`);
  },
});
```

- The **operator decides the grant set per entry** (A4). A written plugin's
  `stubs` object has exactly the granted names on it and nothing else; there is
  no registry to look one up in and no ambient object to reach through.
- A grant may declare `deps` and `provides`. The entry's synthesized plugin
  declares the union of its grants' — so a hosted entry sits in the dependency
  graph like any other instance, stays `pending` until its grants' deps are
  provided, and can `provide` through `instance.provide` inside a handler.
- **The handler is client-side, trusted code**, so it is given the real
  `Instance` handle. That is why registrations a stub makes are owned by the
  hosted instance and are undone by ordinary kernel cleanup (A2), with no new
  ownership concept.
- `call` calls back into the written plugin's named exports through its host, so
  a capability can be two-way without a function ever crossing.

**Caller identity (A6).** Every stub call is a dispatch of `stubCallAction`:

```ts
stubCallAction: ActionDefinition<
  { stub: string; instanceId: string; input: unknown },
  unknown
>;
```

The callable the plugin holds is `(input) => dispatch(stubCallAction, { stub, instanceId, input })`
— a closure the client built per instance before the host ever saw it. The
plugin is handed the closure, not the id: there is no argument it can pass, no
property it can read and no field it can overwrite that changes the
`instanceId` the client sees. Because it is an action, client-side middleware
approves, logs or refuses per instance exactly as it does for any other action
(ADR-0003), and it sees the id before the handler does.

### Host-local grants

The `@frockbot/compose-core/grants` subpath exports the five standard grant
declarations and their in-process implementations. The kernel knows none of
their names. Each declaration uses `defineGrant`, so source sees method-shaped
`storage`, `schedule`, `http`, `ai`, and `files` objects and every call crosses
the low-level seam as `{ method, args }`. `createInProcessHost({ grants })`
accepts factories keyed by stub name; each factory creates the value placed in
written source's `stubs` object and receives an `invoke` function which
dispatches `stubCallAction` before performing host-local work. The default
`inProcessHost` has no factories; method metadata still controls its exposed
shape, while products that need the standard resources supply their host-local
implementations.

In process, state is keyed by entry id outside an activation. `storage` is a
`Map` of structured-cloned values with `get`, `set`, `delete`, and prefix
`list`. `schedule` holds the one alarm an instance can own; `every`, `at`, and
`cancel` use `setTimeout`, and a firing calls the current activation's named
export with `{ scheduledAt }`. Stopping clears the live timer and call handle
but retains its descriptor and values; a restart restores the call handle and
re-arms it. Destroying clears both. Thus an options or source restart sees the
same state, while remove followed by re-add starts empty.

Stateful factories return separate `ready`, `stop`, `failed`, and `destroy`
hooks. `ready` is why a retained schedule is not re-armed until source setup has
succeeded; the other hooks preserve restart and removal semantics without
putting state or grant names in core.

`createInProcessGrants` is the behavioral oracle for the full standard set.
`http` accepts a base-owned name-to-origin policy and executes every approved
call through `executeHttpGrantFetch`, the hardened boundary in
`src/grants/http.ts` that the Cloudflare host shares, so neither host can drift
from the other: it decodes only `method`, string `headers`, and a string or
`ArrayBuffer` `body` from the approved init, overwrites its configured
credential header after middleware approves the request, rejects a path whose
resolved origin differs, sends with `redirect: "manual"` and refuses a redirect
status (301, 302, 303, 307, 308) so a credential never follows to another
origin, bounds the call with a wall-clock deadline and the streamed response
with a byte limit (five seconds and one mebibyte by default, both overridable
per host), and returns a structured-clone-safe response record rather than a
`Response`. A non-redirect 3xx such as `304` is an ordinary observable
response. Its fetch function is injectable for deterministic
tests and defaults to the runtime's real `fetch`. `ai` accepts a base-owned
responder and defaults to echoing the prompt. `files` stores body bytes and an
optional content type in a `Map` under `${entryId}/`; stopping retains objects
and destroying removes the entire prefix. String, `Blob`, and `ArrayBuffer`
bodies are normalized to `ArrayBuffer` so `get` has one portable shape.

### Serializable plugin catalogs

The `@frockbot/compose-core/catalog` subpath owns the wire-safe plugin-list shape and
the identity-based serialize/resolve pair. Catalog plugins and stubs are named
at rest; source remains source. Resolution never rejects the whole list for an
unknown plugin name: it substitutes a small plugin whose setup throws `no
plugin named "x" in the catalog`, so that entry reaches `error` through the
ordinary lifecycle while its siblings still load. An unknown stub name is a
resolution error because no executable source entry can truthfully represent
authority it was not given.

### Termination

`HostInstance.stop()` ends an activation, and it is what a remote host's
"terminate the isolate" looks like from here. It runs when an instance is
deactivated, restarted because its options/source/host changed, or its client
is destroyed. On teardown the hosted entry's instance runs two cleanups, in
this order:

1. **revoke** — the client forgets the instance's host record. Every later
   `stubCallAction` dispatch for that id throws, wherever it came from,
   including from code already running inside the host.
2. **stop** — `host.stop()`; the in-process host marks itself stopped (so `call`
   and its own stub wrappers reject), runs the cleanup the module's setup
   returned, and drops the module namespace.

Revoke-before-stop is deliberate and is what makes the in-process host an
honest oracle: a remote host that aborts an isolate never gets to run the
module's cleanup either, so a written plugin's cleanup must not be able to do
anything observable outside itself. It releases what the module holds; anything
the module registered through a stub is released by the kernel cleanup the
handler registered.

Because `stop` is between two calls by construction — the kernel awaits it
during removal, and every call in or out is asynchronous — the in-process host
reproduces the remote "terminated between two calls" case exactly (A7): after
it, `call` rejects, stub calls reject, and every cleanup has run before removal
reports done.

`HostInstance.destroy?.()` is different: after `stop`, the kernel calls it only
when the entry id disappears from the plugin list. Disabling an entry, changing
its source/options/host and destroying the client preserve host state. The
kernel retains one destroy callback per entry and host even while the entry is
disabled, so removing a stopped entry still deletes its state; moving an entry
between hosts leaves both retained states intact until that entry is removed.

### The evaluator, and workerd

Evaluating a string in-process needs an evaluator. The in-process host uses
`import()` of a `data:text/javascript` URL, reached through
`new Function('u', 'return import(u)')` so no bundler rewrites it. Node, Bun and
browsers have this; **workerd forbids runtime code generation**, so the
`new Function` throws there and the host reports it:

> `@frockbot/compose-core: the in-process host cannot evaluate plugin source in this runtime, which forbids code generation from strings; run source in a host package instead`

The entry lands in `error` with that message and the client keeps working. The
workerd smoke test asserts exactly that string rather than skipping — a runtime
where source cannot run must say so, not appear to work.

Every value crossing the in-process boundary is passed through
`structuredClone`: options in, stub input out and result in, `call` input and
result. This is not defensive copying for its own sake — it is what makes the
in-process host the oracle A5 demands. Source that smuggles a function or a
class instance through a stub fails in-process for the same reason it would fail
over a wire, instead of passing here and failing in a Dynamic Worker.

### Error mapping

Five failures, one shape. Each attaches a `SourceError` to the error the client
reports, readable with `sourceErrorOf(error)`:

| Failure                             | `phase` | Where it is caught                                                   | Line?           |
| ----------------------------------- | ------- | -------------------------------------------------------------------- | --------------- |
| checker rejected the source         | `check` | before the host is asked to start anything                           | from diagnostic |
| source does not parse               | `parse` | the dynamic `import` throws a `SyntaxError`                          | from the stack  |
| module throws while evaluating      | `load`  | the dynamic `import` throws anything else                            | from the stack  |
| default export throws               | `setup` | `host.start`                                                         | from the stack  |
| first `call` into the plugin throws | `call`  | the first `HostInstance.call`, before the instance has answered once | from the stack  |

`line` and `column` come from the first stack frame naming the data URL. All
five reach the entry through the kernel's existing machinery: the synthesized
plugin's `setup` throws, so the instance ends `error` with the error attached
(kernel A6), the `errors` store gets a `{ scope: 'setup' }` report, siblings are
untouched, and the client never crashes. Nothing new was added for hosted
plugins.

The `call` phase is the odd one, because a remote host can defer a load failure
to the first invocation. Only the **first** call promotes a rejection to the
instance's status; after the plugin has answered once, a throwing handler is an
ordinary rejected call and the instance stays `active`. Anything else would let
one bad tool argument remove a working plugin.

### The type-check seam

Type checking is not core's job (self-modification D9), but the place it plugs
in is. It is immutable client infrastructure, supplied when the client is
created and exposed read-only so a composer can use the exact same checker:

```ts
createClient({ checker?: SourceChecker })
client.checker: SourceChecker | undefined

interface SourceChecker {
  check: (request: {
    instanceId: string
    source: string
    declarations: string
    grants: ReadonlyArray<{ name: string; declarations: string }>
  }) => SourceCheckResult | Promise<SourceCheckResult>
  declarations?: (
    grants: ReadonlyArray<{ name: string; declarations: string }>,
  ) => string
}

interface SourceCheckResult {
  code?: string // what to start; absent means "do not start"
  diagnostics?: Array<SourceDiagnostic> // { message, line?, column? }
}
```

When the option is provided, every source entry is checked before its host is
asked to start anything, and the host is given `result.code` — so the same seam
is a transpiler: TypeScript in, JavaScript out. Plugin-list order cannot bypass
the check because the checker is not an entry. When the option is absent, the
source is started as written. The checker runs client-side, once, so an entry
gets the same diagnostics whichever host it names.

**Declarations are derived from the grants, not from the plugin.** Each
`createStub` carries the `.d.ts` text for its own capability — written once by
whoever provides it — and an entry's declarations are the concatenation for its
grants, in grant order, via `stubDeclarations(entry.stubs)`. A written plugin
therefore cannot even _name_ a capability it was not granted, which makes the
type environment a statement of the entry's authority rather than a separate
thing to keep in sync. The same string is what a composer shows the model
(D8), so what type-checks is what runs.

**`declarations` is optional, and it is what D8 is about.** A checker that
compiles the grant text as given has nothing to add: the concatenation is the
whole of the compilation, and `stubDeclarations(entry.stubs)` is what a composer
shows. A checker that derives more — a base declaration file describing the
module shape, a `stubs` object type synthesized from the grant names — compiles
against text neither core nor the composer can produce, and showing the model
the concatenation instead would show it something other than what the check
uses. So the checker may publish the text it actually compiles, and a composer
prefers it: `checker.declarations?.(grants) ?? stubDeclarations(grants)`. It
takes the grant set rather than an entry so that the answer for a set of stubs
can be had before any entry carries them.

`grants` carries the same text with each grant's `name` still attached, in the
same order. `declarations` alone is enough for a checker that only compiles the
text; a checker that has to give the plugin's `stubs` object a type has to know
which name each declaration belongs to, and recovering that by parsing the
concatenation would be guesswork. It carries the grant's `name` and
`declarations` only — never the grant itself, whose `handler` is client-side
authority a checker has no business holding.

**`exports` is optional too, and it lets one written module be described to
another.** `exports({ source, grants })` returns the module's named exports with
the type of each where the checker can recover one. Core does nothing with it;
it exists because a written plugin can now be a pair — a server half and a
**view** — and the half that calls the other should be checked against what the
other really exports (`ui.md` D2). Putting the recovery on the seam, rather than
a second source in the check request, keeps core out of the pairing entirely:
whoever knows what the pair means turns the exports into a grant's declaration
text, and the entry then carries that text like any other grant, so the check at
start time and the check before writing are the same check.

Core ships no checker and no `typescript` dependency. The tests use a
ten-line reference checker to prove the seam.

### Calling a source entry's exports from the client side

`client.callSource(id, name, input)` calls a named export of a source entry
through its host — the client side of the same door `StubCall.call` opens for a
grant handler, which reaches only the calling instance's own module.

It is here because a **view** calls its plugin's server half: the `server` stub's
handler runs client-side, on the view's own instance, and has to reach a
_different_ entry. Everything the boundary guarantees is unchanged — the call
goes through the host, only structured-clone-safe values cross, a stopped
instance refuses — and no new authority reaches hosted code, which can still
only call what a grant hands it. In 5b the same method is what the shell calls
when a stub crosses the connection (`ui.md` E3).

### The hosted entry as an ordinary instance

A source entry is not a special kind of record. During reconciliation the client
synthesizes a plugin for it — name `hosted`, `deps`/`provides` from the grants,
a `setup` that resolves the host, runs the client's checker, binds the stubs and
calls `host.start` — and from there every kernel rule applies unchanged: options are
validated and restart the instance, deps hold it `pending`, `inspect()` lists
it, `resources()` shows what its stub handlers registered, removal runs its
cleanups in reverse (A2).

Two consequences worth stating:

- **`plugin` and `source` are both optional on `PluginEntry`, and exactly one
  must be present.** A discriminated union would say this in the type system,
  but it makes the common `{ ...entry, plugin: other }` edit ill-typed and turns
  `Array<PluginEntry>` into something callers must narrow. The check is a
  reconcile-time error alongside the existing "id is missing" and "duplicate id"
  ones, which already fail a reconcile without touching a running instance
  (kernel F3).
- **Restart comparison is by value, not identity.** A synthesized plugin is a
  fresh object every pass, so `entry.plugin !== record.plugin` cannot be the
  test. A hosted record restarts when its `source`, `host`, grant list or
  options change, and otherwise is left alone. Changing `host` is therefore an
  options-style change: the instance is stopped in the old host and started in
  the new one (A3).

### Reusing the kernel suite

hosts.md B5 asks for the kernel's criteria to hold for a hosted plugin, and A2
asks the same in core. Duplicating `tests/A-lifecycle.test.ts` against source
would double the maintenance and halve the meaning: two suites drift, and the
second one becomes the place a weakened assertion hides.

Instead, `tests/helpers/instance-contract.ts` holds one parameterised suite —
the parts of the kernel's criteria that are observable of any single instance
(A1–A5, A7 cleanup and removal; B1–B2 deps; D2 options; F1–F2 reconcile and
`enabled`; G1–G2 inspection) — expressed against a factory that, given a
behaviour, returns a plugin entry realising it. `tests/hosts/instance-parity.test.ts`
runs that suite twice: once with a factory that builds an ordinary plugin, and
once with a factory that builds a source entry on the in-process host. The
control arm is the point: it proves the shared contract still says something
about the kernel, so a hosted-plugin bug cannot be hidden by weakening the
contract. A host package adds a third arm with one line and no new assertions,
which is B5.

The criterion-by-criterion kernel files stay as they are. They are the record of
what the kernel promises, written per criterion; the parameterised contract is a
parity oracle, and the two have different jobs.

## Criterion → test

| Id  | Test file                           | `it()` title                                                                                                                                                                                               |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `tests/A-lifecycle.test.ts`         | `adding a plugin starts it and removing it leaves no trace`                                                                                                                                                |
| A2  | `tests/A-lifecycle.test.ts`         | `removal reports complete only once every async cleanup has finished`                                                                                                                                      |
| A3  | —                                   | Retired — child instances were removed; plugins compose through the plugin list (F5)                                                                                                                       |
| A4  | `tests/A-lifecycle.test.ts`         | `cleanups of one instance run in reverse order of registration`                                                                                                                                            |
| A5  | `tests/A-lifecycle.test.ts`         | `registering on an instance being removed or already removed throws`                                                                                                                                       |
| A6  | `tests/A-lifecycle.test.ts`         | `a plugin that throws during start ends in error with nothing left behind`                                                                                                                                 |
| A7  | `tests/A-lifecycle.test.ts`         | `a cleanup that throws is reported and the remaining cleanups still run`                                                                                                                                   |
| B1  | `tests/B-deps.test.ts`              | `an instance stays pending until the last dep is provided, whatever the order`                                                                                                                             |
| B2  | `tests/B-deps.test.ts`              | `losing a dep cleans the dependent up and returns it to pending` / `keeps declared deps captured for async work after deactivation`                                                                        |
| B3  | `tests/B-deps.test.ts`              | `only a value provided by an active instance satisfies a dep`                                                                                                                                              |
| B4  | `tests/B-deps.test.ts`              | `a plugin can read a key it did not declare and keeps running either way`                                                                                                                                  |
| B5  | `tests/B-deps.test.ts`              | `providing a key that is already provided throws for the second provider`                                                                                                                                  |
| B6  | `tests/B-deps.test.ts`              | `circular deps are detected and reported with the cycle named`                                                                                                                                             |
| C1  | `tests/C-replacement.test.ts`       | `every dependent runs against the new provider after a swap`                                                                                                                                               |
| C2  | `tests/C-replacement.test.ts`       | `there is no window in which a dependent is active against a removed provider` / `cleans up a three-deep dependency chain before its provider` / `destroys dependents before the providers they still use` |
| D1  | `tests/D-options.test.ts`           | `options are validated and defaulted before the instance starts`                                                                                                                                           |
| D2  | `tests/D-options.test.ts`           | `an options update restarts only that instance`                                                                                                                                                            |
| D3  | `tests/D-options.test.ts`           | `an options update is an action tooling can observe, veto or replace`                                                                                                                                      |
| E1  | `tests/E-middleware-events.test.ts` | `middleware can rewrite the input, rewrite the result, or stop the action`                                                                                                                                 |
| E2  | `tests/E-middleware-events.test.ts` | `middleware runs in registration order, first goes to the front, and removal is clean`                                                                                                                     |
| E3  | `tests/E-middleware-events.test.ts` | `a listener observes an event and a throwing listener is contained`                                                                                                                                        |
| E4  | `tests/E-middleware-events.test.ts` | `dispatch is fire-and-forget or awaited according to the event definition`                                                                                                                                 |
| F1  | `tests/F-plugin-list.test.ts`       | `the plugin list is a store and reconciling only touches entries that changed`                                                                                                                             |
| F2  | `tests/F-plugin-list.test.ts`       | `enabled false is equivalent to removal and enabling restores the instance`                                                                                                                                |
| F3  | `tests/F-plugin-list.test.ts`       | `a reconcile that fails leaves the client in the previous consistent state`                                                                                                                                |
| F4  | `tests/F-plugin-list.test.ts`       | `overlapping list edits are serialised and apply in order`                                                                                                                                                 |
| F5  | `tests/F-plugin-list.test.ts`       | `a plugin can edit the plugin list it belongs to, including disabling itself` / `settles an edit a plugin makes once it is running, so it can report what it did`                                          |
| G1  | `tests/G-inspection.test.ts`        | `every instance is listed with id, plugin, status, missing deps and error`                                                                                                                                 |
| G2  | `tests/G-inspection.test.ts`        | `the resource tree of an instance labels every held registration`                                                                                                                                          |
| G3  | `tests/G-inspection.test.ts`        | `status changes are observable through a store, with no polling`                                                                                                                                           |
| H1  | `tests/H-types.test-d.ts`           | `reading context is typed from the declared deps`                                                                                                                                                          |
| H2  | `tests/H-types.test-d.ts`           | `payloads, action input and result, and options are inferred from the builders`                                                                                                                            |
| H3  | `tests/H-types.test-d.ts`           | `a plugin authored in another package keeps full types with value imports only`                                                                                                                            |
| I1  | `tests/I-runtime.test.ts`           | `the core has no framework dependencies and no runtime-specific imports`                                                                                                                                   |
| I2  | `tests/I-runtime.test.ts`           | `two copies of the package loaded at once interoperate`                                                                                                                                                    |
| I3  | `tests/I-runtime.test.ts`           | `the core uses no Proxy on hot paths` / `the core stays within its 6 kB min+gzip size budget`                                                                                                              |
| I4  | `tests/I-runtime.test.ts`           | `every public export has JSDoc and DESIGN.md maps every criterion`                                                                                                                                         |
| J1  | `tests/J-end-to-end.test.ts`        | `assembles a client, swaps a provider, and edits its own plugin list`                                                                                                                                      |

### Upstream `docs/acceptance/hosts.md` §A

| Id  | Test file                             | `it()` title                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `tests/hosts/contract.test.ts`        | `starts entries only in the host they name` / `refuses a source entry that omits its host`                                                                                                                                                                                                                                                                     |
| A2  | `tests/hosts/instance-parity.test.ts` | every title under `plugin source in-process`, from `tests/helpers/instance-contract.ts`                                                                                                                                                                                                                                                                        |
| A3  | `tests/hosts/contract.test.ts`        | `restarts the instance in the new host when an entry changes host` / `leaves an entry naming a host the client does not have in error`                                                                                                                                                                                                                         |
| A4  | `tests/hosts/contract.test.ts`        | `hands a hosted plugin exactly the stubs its entry was granted` / `takes deps and provides for a hosted entry from the stubs it was granted`                                                                                                                                                                                                                   |
| A5  | `tests/hosts/contract.test.ts`        | `carries only structured-clone-safe values across the boundary, in both directions`                                                                                                                                                                                                                                                                            |
| A6  | `tests/hosts/contract.test.ts`        | `attaches the calling instance id to every stub call, where middleware sees it` / `cannot be told a different caller by the plugin it hosts`                                                                                                                                                                                                                   |
| A7  | `tests/hosts/termination.test.ts`     | `stops but does not destroy a host when an entry restarts` / `stops then destroys a stateful host when the entry is removed` / `stops between two calls, so calls after it fail and the code is released` / `revokes the stubs of a removed instance before the client reports done` / `does not report removal done until the host has released the instance` |

The host-local `storage` and `schedule` oracle is covered by
`tests/hosts/stateful-grants.test.ts`: state survives options/source restarts,
removal destroys it, and an alarm invokes a named export with no request in
flight.

### Upstream `docs/acceptance/self-modification.md` §D — the parts core owns

| Id  | Test file                             | `it()` title                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `tests/hosts/instance-parity.test.ts` | every title under `plugin source in-process`                                                                                                                                                                                                                                                                                    |
| D2  | `tests/hosts/contract.test.ts`        | `hands a hosted plugin exactly the stubs its entry was granted`                                                                                                                                                                                                                                                                 |
| D4  | `tests/hosts/errors.test.ts`          | the four `leaves the entry in error …` titles, plus `reports every failure in one shape, so one recovery loop covers them all`                                                                                                                                                                                                  |
| D9  | `tests/hosts/errors.test.ts`          | `starts source as written when no checker is provided` / `checks every source entry regardless of plugin-list position` / `starts what the checker returns, not what was written` / `does not ask the host to start source the checker rejected` / `checks against the declarations of exactly the stubs the entry was granted` |

The checker itself, and the tools that write and rewrite source, belong to the
self-modification slice; core ships the seam and, in the tests, a reference
checker that proves it.

### Notes on coverage

- **I1 runs under Bun here.** `bun run --filter @frockbot/compose-core test`
  runs the suite. Upstream's jsdom and workerd arms rode on Vitest and were not
  vendored with the copy (see
  [ADR-0038](../../docs/adr/0038-frockbot-compose-is-a-vendored-copy.md)), so the
  environment-independence criterion is met here by the static checks in
  `tests/I-runtime.test.ts` rather than by running the suite three times.
- **I3 — size** is a test in `tests/I-runtime.test.ts`: a rolldown bundle of
  `src/index.ts`, minified and gzipped, with `@tanstack/store` external. The
  kernel, with the host contract and generic in-process host in it, is measured
  against the 6 kB min+gzip budget. Grant, catalog, typed-base, and generation
  subpaths are separate entries and are not part of that measurement.

## Typed bases and generations (slice 9)

Slice 9 adds two deliberately separate subpath modules. Neither is re-exported
from the kernel entry, so an application that only creates a client pays for
neither and the 6 kB hot-path budget is unchanged.

`@frockbot/compose-core/base` owns `defineGrant` and `defineBase`. A method-shaped
grant keeps its method names as runtime data and its method functions as a
phantom type surface. `defineGrant` compiles the methods to the existing
`createStub` seam: the host sends `{ method, args }`, the handler appends the
trusted `StubCall` context and invokes that method, and an unknown method throws
`"<grant>" has no method "<method>"`. Methods may have zero or more authored
arguments; the final handler argument is always the trusted context and is the
one declaration generation removes. This is the smallest generalisation that
makes both `data.rows()` and `actions.wrap(name, options)` ordinary calls while
retaining one wire shape.

The bound callable in `HostStartRequest.stubs` carries the optional method-name
array. Each host builds a frozen, null-prototype object with one function per
name; each function sends the same `{ method, args }` through the bound callable.
It is metadata on the existing stub seam, not a second host operation, and no
`Proxy` is used.

`defineBase` preserves the exact inferred records supplied as `keys`, `actions`,
`slots`, `grants`, and `plugins`, and exposes `plugins` again as `catalog` for
plugin-list resolution. The duplicate reference is intentional: the base is a
typed inventory, not a registry with its own lifecycle.

`@frockbot/compose-core/generations` is a pure reducer over a generic generation log.
A generation stores a full entry list, `n`, `parent`, `at`, `baseVersion`, and a
one-way outcome (`pending` to `good` or `bad`). Finalising the single pending
head replaces that value in the returned immutable array; settled history is
never changed. A revert appends a new pending generation containing a copied
earlier list but the head's current base version, so reverting source cannot
pretend to revert the deployed base. `lastKnownGood` searches newest-first.

The client itself only gains `baseVersion` as immutable checker infrastructure.
Every source check receives it. Generation persistence remains outside the
kernel, in the owner of the durable plugin list.

Slice 9's method dispatch and inferred catalog are covered by
`tests/K-base.test.ts`; the append, outcome, last-known-good, and revert reducer
behavior is covered by `tests/L-generations.test.ts`.

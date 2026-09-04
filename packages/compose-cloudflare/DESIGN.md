# `@frockbot/compose-cloudflare` — design

A **host** that runs **plugin source** in a Cloudflare Dynamic Worker and
presents it to the client as an ordinary **plugin instance**. It meets
upstream `docs/acceptance/hosts.md` §B, §D and §E, under the contract core owns
(upstream ADR-0004) and the transport upstream ADR-0005 fixed. Neither document
was vendored with the code; see
[ADR-0038](../../docs/adr/0038-frockbot-compose-is-a-vendored-copy.md). The in-process host in core is the oracle; nothing here changes how a
plugin is written.

## The shape of the thing

```ts
const client = createClient({
  hosts: {
    cloudflare: createCloudflareHost({
      loader: env.LOADER,
      compatibilityDate: "2026-05-01",
    }),
  },
  plugins: [{ id: "adder", source, host: "cloudflare", stubs: [toolsStub] }],
});
```

Three moving parts, and no more:

| Part                      | Runs in            | Job                                                                 |
| ------------------------- | ------------------ | ------------------------------------------------------------------- |
| `createCloudflareHost`    | the loader Worker  | load an isolate per instance, call into it, hold it to a clock      |
| `ComposeStubLoopback`     | the loader Worker  | be a stub, called from inside an isolate                            |
| the generated **wrapper** | the Dynamic Worker | build `stubs` from `env`, run the written module, answer the client |

The client, the kernel, every stub handler and every middleware run in the
loader Worker (D5). The written module is the only thing in the isolate that
anyone wrote.

## Transport

`env.LOADER.get(id, () => code)` returns a `WorkerStub` synchronously;
`worker.getEntrypoint('ComposeHostedPlugin', { props, limits })` returns an RPC
handle to the wrapper. `setup`, `call` and `stop` are three RPC methods on it,
which is the whole of `HostInstance`.

**Every method answers with an envelope**, `{ ok, value }` or
`{ ok, phase, message }`, rather than throwing across the wire. RPC carries an
exception's message but not the properties hung on it, and the **phase** a
failure belongs to is exactly the part the client has to keep. The loopback
answers the same way for the same reason: a revoked or refused stub call becomes
an exception where the plugin's own `try` can catch it, and never an RPC-level
rejection that the runtime also reports on its own.

A rejection therefore means one thing: the isolate never got as far as running
the wrapper. That is the load failure, and it is read for a phase and a place.

## Stubs, and how a loopback finds the client

For each granted stub the host mints one loopback from the loader Worker's own
exports and puts it in the isolate's `env`:

```ts
env[stub] = exports.ComposeStubLoopback({
  props: { hostId, instanceId, stub },
});
```

`env` holds these and nothing else (D4): no bindings, no loader, no raw
resources. The props are read by the loader Worker, never by the isolate, so
the plugin can neither read nor forge the identity its calls arrive under. A
plugin that passes `{ instanceId: 'someone-else' }` as stub _input_ is answered
under its real id, and the middleware on `stubCallAction` sees the real id
first.

**The loopback finds the client through a module-level table** keyed by
`hostId` then `instanceId` (`src/registry.ts`). `createCloudflareHost` writes an
entry when it starts an instance and deletes it when it stops one; the loopback
reads `ctx.props` and looks the pair up.

Why this, and not something larger:

- The loopback runs in the loader Worker's isolate — the same isolate the client
  and the kernel run in, because the host was constructed there. Module state is
  the shortest path between two things already in one isolate, and it needs no
  serialization, no extra binding and no round trip.
- It is a table, not a global client: two clients in one Worker (a client per
  request is the ordinary shape) each register their own instances, under their
  own `hostId` if they want, and a lookup can only ever return the callables the
  kernel bound for that one instance.
- Revocation is a delete, which is what makes B3 mean something.

With `createCloudflareHost`, a loopback call reaches the client in a different
I/O context from the request that created it. Plain JavaScript is fine across
that line, but a handler must not capture a request-scoped platform object. The
served shape avoids that restriction: its client and registry live in one
Durable Object and `createFacetHost` mounts each written instance as that
object's facet.

## Durable Object facets

`createFacetHost({ ctx, self, loader, compatibilityDate, ... })` has the same
`Host` surface and limit options as `createCloudflareHost`. It loads the
generated facet wrapper as a Dynamic Worker, obtains its Durable Object class
with `getDurableObjectClass`, and mounts it with:

```ts
ctx.facets.get(instanceId, () => ({ class: facetClass }));
```

The facet name is exactly the instance id. The Dynamic Worker cache id still
contains the content hash, so aborting and starting after an options or source
change constructs that named facet from the new class while retaining its
facet storage.

The facet wrapper imports `plugin.js` in its constructor path and calls its
default export with exactly `{ id, options, stubs }`. Its `env` contains the
loopback stubs minted for ordinary grants and the host-provided `schedule`
loopback. `storage` alone stays inside the facet:

- `storage` prefixes keys in the facet's `ctx.storage` and implements `get`,
  `set`, `delete`, and prefix `list` with the Durable Object KV API;
- `schedule` calls back to the facet host, which stores one descriptor per
  instance under `\0compose:schedule:<instanceId>` in the parent Durable
  Object. The host arms the parent's single alarm for the earliest descriptor,
  dispatches every due descriptor through the facet's ordinary `call` path,
  then removes a one-shot or advances a recurring descriptor.

A loopback handler is not inside the Durable Object request that created the
host. It must not touch that object's storage: the schedule loopback calls
`self.composeSchedule(operation)`, and that RPC delegates to `host.schedule`
only after it has re-entered the parent object. `FacetHost.schedule()` and
`FacetHost.alarm()` are therefore object-internal entrypoints. Facet-local
`storage` is unaffected because its operations execute inside the facet's own
request, and the parent's alarm may call a facet because that is an RPC into a
different object rather than captured request I/O.

The parent owns scheduling because SQLite-backed facets in local workerd cannot
set alarms (`setAlarm` rejects with "alarms are not yet implemented for
SQLite-backed Durable Objects"). It also multiplexes all written instances onto
one alarm per tenant, which is cheaper than one alarm per facet. A schedule is
therefore retained when a facet stops for an options or source change and is
deleted only by `schedule.cancel()` or when the entry is removed.

The facet constructor starts the written module and stores that promise, and
every RPC awaits it. It must not pass that start promise to
`ctx.blockConcurrencyWhile`: local workerd deadlocks the facet's first RPC when
construction blocks concurrency on work which that RPC must drive.

These operations throw their own capability messages inside the wrapper. If a
product call ultimately rejects, the source detail retains that message and
the host diagnostic remains available as the outer `cause` after the Start
boundary unwraps it.

`HostInstance.stop()` revokes loopbacks and calls `ctx.facets.abort(name, ...)`:
the activation is gone, while facet storage and the parent's schedule descriptor
remain. `destroy()` deletes the parent descriptor, re-arms the parent's alarm,
and calls `ctx.facets.delete(name)`, which removes the facet and its storage.
Core invokes the latter only after stop and only when the entry id leaves the plugin list.
Options changes, source rewrites, disable, and client destruction are stop-only.
If setup itself fails, `start` cannot return a `HostInstance` whose destroy
callback the kernel could retain, so the host deletes that failed facet and any
partial setup state immediately. Successful rewrites retain storage; a failed
rewrite is fail-closed and starts empty when repaired.

The installed `@cloudflare/workers-types` 5.20260830.1 exposes
`DurableObjectState.facets`, `get`, `abort`, and `delete`, and the installed
Worker Loader type exposes `getDurableObjectClass`. The implementation uses
those APIs directly; only the generated facet's RPC handle is narrowed to the
wrapper methods that this package itself generated.

## The wrapper module

Method-shaped grants are additive metadata on the same loopback seam. The host
passes each granted stub's optional method names into the generated wrapper;
the wrapper exposes either the existing callable or a frozen null-prototype
object with one function per declared method. A method function sends
`{ method, args }` through the same loopback, so identity, limits, revocation,
re-entry, and error handling remain unchanged. No `Proxy` or extra binding is
introduced, and `storage` and `schedule` retain their host-local implementations.
Upstream's `tests/loopback.test.ts` exercised that generated method object in a
Dynamic Worker, and its showcase workerd suite exercised the same shape through
a facet; neither was vendored with this copy.

Generated per instance from the granted stub names, loaded as the isolate's
`mainModule` beside the written module as `plugin.js`. It is the only code in
the isolate the plugin author did not write, and it does three things.

```js
const stubs = Object.create(null);
for (const name of stubNames) {
  const loopback = env[name];
  stubs[name] = async (input) => {
    const answer = await loopback.stubCall(input);
    if (!answer.ok) throw new Error(answer.message);
    return answer.value;
  };
}
```

The written module is imported **dynamically**, inside a `try`. A static import
would make a throw in the plugin's top level a failure to load the whole
isolate, before anything could name which phase it belonged to; dynamically, the
wrapper catches it and reports `load` (or `parse`, if the runtime called it a
`SyntaxError`).

What crosses into the written module is `{ id, options, stubs }` and nothing
else (D6). `env`, `ctx`, the loopbacks and the wrapper's own state are closed
over in the wrapper's module scope, which is not the plugin's module scope.

**What D6 cannot mean here.** A module in the isolate may `import
'cloudflare:workers'` and read `env`, and may import the wrapper module itself.
Neither is an escape: `env` holds only that instance's own loopbacks, and the
wrapper class holds no authority it did not take from that same `env`. The
honest statement is the one the criterion makes — the wrapper exposes no
reference to `env`, `ctx` or the loader — and the tests assert what is actually
reachable rather than a stronger claim.

**Wrapper state is keyed per start, not per isolate.** An isolate is cached by
content (below), so the same isolate serves a restart of the same instance. A
`run` token minted per `host.start` and carried in `props` is what makes the
restart run setup again and register its cleanups again, exactly as a cold
isolate would. Without it, a restart lands on a warm isolate that has already
run setup and quietly registers nothing — which is what the kernel's parity
suite caught.

The platform does not guarantee that two calls reach the same isolate. If an
evicted isolate is re-created, its `runs` table is empty and the next `call`
runs setup again before answering; that is the only way the instance keeps
working, and it means a plugin's setup can run more than once over an
instance's life.

## Isolate identity

```
`${instanceId}:${sha256(hostId + code + options + sorted grant names)}`
```

Everything that decides what the isolate would do is in the hash, including the
`hostId` carried by its loopbacks; the instance id is in the key so two
instances of the same source never share one. Re-adding
an unchanged plugin lands on the same id and the load callback does not run
again; changing the source, the options or the grants produces a new id and a
new isolate (D2). A content hash, not a counter: a counter would make a
re-added plugin pay for a cold isolate and would make the cache key depend on
history rather than on content.

## Limits and timeouts

`globalOutbound: null` on every load, not configurable (D1). The default is
_open_ — an omitted field means the isolate inherits the loader's egress — so
this is the one option the host refuses to take from its caller.

`limits: { cpuMs: 200, subRequests: 50 }` by default, set on the load **and** on
the entrypoint, overridable through `limits` (D3). A stub call is a subrequest,
so the subrequest budget is what bounds how much a plugin can ask of the client
in one invocation.

The loopback refuses an input or result whose JSON encoding is larger than
1,048,576 bytes. The limit is checked on both sides of the stub handler and is
reported as ordinary `{ ok: false, message }` data, so written code may catch
it. This is a wire budget in addition to structured-clone validation.

`callTimeoutMs` defaults to 5000 and wraps every `setup`, `call` and `stop` in a
client-side wall clock, independent of anything the platform enforces. A `setup`
that runs out of clock fails the start, so the instance ends in `error` naming
the limit and the rest of the client keeps working (B2). A `call` that runs out
rejects; the kernel promotes only the _first_ call to the instance's status, so
a plugin that has already answered once stays `active`.

The timeout error carries no `SourceError`: the limit is the host's, not a fault
in the written source, and `sourceErrorOf` says so by returning nothing.

The standalone Dynamic Worker host has no platform abort: a timed-out call is
abandoned, the instance is revoked and stopped, and the runtime lets the
isolate go when nothing is holding it. The facet host does have a platform
abort and uses it for every `stop`.

The standalone-host B2 suite uses code that hangs rather than a busy loop. A plugin whose
`setup` never returns is what the wall clock is for, and the suite uses one that
waits on a long timer. A busy loop is deliberately not tested: the local runtime
does not enforce `cpuMs`, and a `while (true)` inside a Dynamic Worker wedges it
permanently — not the call, the whole runtime, for the rest of the run. The
criterion is about the client-side limit, which a polite hang exercises exactly;
the platform limit is set on every load and is the platform's to enforce.
The showcase's facet-host gallery separately uses a true `while (true)` fixture:
the supervisor's 250 ms wall clock aborts that facet, while its platform CPU
limit is set higher so the named product limit is the observed one.

## Teardown

`stop()` revokes first, then stops:

1. **revoke** — delete the registry entry. Every loopback for that instance
   answers `{ ok: false }` from then on, including one already held inside the
   isolate, and a stub call after revocation fails rather than lands.
2. **stop** — the wrapper drops the run and awaits the cleanup the module's
   setup returned.

This is the order core's in-process host uses, and it is the order an aborted
isolate would impose anyway: a remote host that kills an isolate never gets to
run the module's cleanup either. So a written plugin's cleanup releases what
the module itself holds and nothing outside it; anything it registered through a
stub is released by the kernel cleanup the handler registered.

`stop` is itself under the wall clock, and a `stop` that fails or times out is
swallowed: the removal that asked for it must not be held up by an isolate that
is being let go regardless.

## Error mapping

| Failure                     | `phase` | Caught by                      | Place? |
| --------------------------- | ------- | ------------------------------ | ------ |
| source does not parse       | `parse` | the load rejecting `setup`     | yes    |
| module throws on evaluation | `load`  | the wrapper's dynamic `import` | no     |
| no default export           | `load`  | the wrapper                    | no     |
| setup throws                | `setup` | the wrapper                    | no     |
| first call throws           | `call`  | the wrapper                    | no     |

Each reaches the client as an `Error` carrying the `SourceError` detail
`sourceErrorOf` reads, with the original message.

**`line` is absent rather than wrong.** A child isolate reports an exception's
message; the stack that comes back belongs to the loader's bundle, not to the
written module, so there is no line of the source to point at and none is
invented. The exception is a module that does not parse: the runtime names it
(`at plugin.js:1:27`), that place is real, and the host reads `line` and
`column` out of it.

Tail Workers are not the error channel. They are asynchronous, they are not
available under `wrangler dev`, and an error the client has to attach to an
instance's status cannot wait for a log to arrive.

## What B5 covers, and what it cannot

Upstream ran core's `runInstanceContract` against the standalone Dynamic Worker
host (`tests/parity.test.ts`) and the same source arm against `createFacetHost`
inside `runInDurableObject` (`tests/facet-parity.test.ts`), importing the shared
helper across the package boundary by path so all three implementations used one
contract. Both arms need workerd and were not vendored with this copy, so the
in-process host in `@frockbot/compose-core` is the only implementation the
contract is run against here.

What it does not reach:

- **Anything about a plugin's identity as a value.** The kernel's criteria about
  replacing an entry's `plugin` reference do not apply to an entry that carries
  source; the source arm covers the equivalent (source, options and grants
  decide a restart) and core's own files cover the rest.
- **Synchronous observation.** Every arm is already asynchronous, but this one
  is asynchronous _and_ remote; a criterion phrased about what is true
  immediately after a synchronous call is not one this arm can be asked.
- **Type inference.** `@frockbot/compose-core`'s `tests/H-types.test-d.ts` is about what a builder infers,
  which is a client-side question a host has no part in.

## Named grant providers

Both hosts accept the base's HTTP service policy plus optional Workers AI and
R2 bindings; the served application uses `createFacetHost`. The generated
wrapper turns the standard grant names into their declared object APIs, but
each operation traverses its loopback and therefore `stubCallAction` before a
binding is used. HTTP policy maps a service name to one origin and an optional
`{ header, value }` credential. A path may not change the origin, and the
configured header overrides source-supplied headers. AI runs
`@cf/zai-org/glm-5.3-flash` and returns the answer's text, whether the model
answers `{ response }` or, as glm-5.3-flash does, OpenAI-shaped `choices`.

Files use R2 with `${entryId}/` prepended in the host. `get` materializes the
body as an `ArrayBuffer`; `list` follows every cursor page. Removing an entry
deletes every object under its prefix, while stopping or rewriting retains
them. A setup failure removes partial files alongside the failed facet state.
Facet storage and parent-object scheduling otherwise keep the slice 2 semantics
unchanged.

## Local and CI

`bun test tests` runs this package's suite: the pure protocol, frames, HTTP
grant boundary, and Workers AI provider tests, which need no Cloudflare runtime.
Upstream's in-workerd suite rode on `@cloudflare/vitest-pool-workers` and was
not vendored with the copy (see
[ADR-0038](../../docs/adr/0038-frockbot-compose-is-a-vendored-copy.md)), so the
isolate and facet behavior it proved — storage retained across an options or
source restart, cleared on remove, an alarm calling a named export with no
request in flight, and the parity arms — is not exercised here. `dev/worker.ts`
and `dev/facet-test-object.ts` are still the `wrangler dev` entry and its test
supervisor, and `wrangler.jsonc` still declares `worker_loaders` and points
`main` at that Worker, whose `ComposeStubLoopback` re-export the loopbacks are
minted from.

**The compatibility date is 2026-05-01**, which is lower than the repo's
elsewhere. The workerd bundled with the wrangler in this workspace refuses
anything later than 2026-05-25 locally. Production supports later dates; raise
it when the bundled runtime does.

## Workers AI

The **host** above is one half of what this package is for. The other is a
structural **model provider**: a Worker that already holds an `AI` binding can
stream model output with no credential anywhere. A binding is authority the
platform hands the Worker. Registration into a model registry belongs to the
example or application, so this package has no dependency on an agent loop.

Two things ship, because a browser cannot hold a binding:

| Export                  | Who uses it                                        |
| ----------------------- | -------------------------------------------------- |
| `createWorkersAiModel`  | an application or example runtime in the Worker    |
| `handleChatCompletions` | a route that client's browser counterpart talks to |

### Input

One step becomes one `binding.run(model, inputs, { signal })`. `inputs` is
`{ messages, tools, stream: true }` plus the provider's `options` and the
request's own options, the request's values winning.

Messages are the ones the **session** derived (B2), in the shape a
text-generation model reads: the assembled **prompt sections** as one `system`
message, then user, assistant and tool messages in order. An assistant message
that made calls carries `tool_calls`; a tool result carries `tool_call_id`, which
is what makes the next step a reply to the call rather than a fresh question.
Tools go over in the `{ type: 'function', function: { … } }` form — Workers AI
documents both that and a flat `{ name, description, parameters }`, and the one
that matches the tool registry's own shape is the one with less to go wrong.

**The default model is `@cf/zai-org/glm-5.3-flash`.** An agent loop
needs two things of a model — streaming, so E1 has chunks to append, and function
calling, so a **tool** can be called at all. Provider and request options are
passed through untouched.

### Output, and assembling a tool call

The answer is a `ReadableStream` of server-sent events, `[DONE]` last. What is
inside a `data:` line is **not specified by the platform** — the published schema
for a streamed body says only `text/event-stream` — and two shapes are live: the
native `{ "response": "…", "tool_calls": [{ "name", "arguments" }] }` that
llama-3.x answers with, and the chat-completions
`{ "choices": [{ "delta": … }] }` that the newer models answer with.
`src/frames.ts` reads both, and both are covered by tests, because which one a
model uses is the model's business and not the agent's. (Cloudflare's own
provider handles the same pair, which is the best evidence there is:
[`workers-ai-provider/src/streaming.ts`](https://github.com/cloudflare/ai/blob/main/packages/workers-ai-provider/src/streaming.ts).)

Text is yielded as it arrives, so a caller can record it chunk by chunk (E1).
**Tool calls are yielded after the stream ends**, because a chat-completions
delta splits one call across frames: the id and name arrive in one, then the
arguments in as many pieces as the model felt like. So calls are keyed by their
delta `index` in a map, the argument text is concatenated, and the whole thing is
parsed once at the end — a call is either issued complete or not at all, and the
tool's validator never sees half a JSON object. A native frame carries a whole
call already and is folded into the same map past whatever indexes the deltas
took, which keeps one ordering for both shapes.

A model that ignores `stream: true` and answers with an object instead is read as
a single frame rather than treated as a failure. The turn is worse — one long
chunk instead of many — and it works.

### Failure and cancellation

A `data:` frame carrying an `error` throws, which the loop turns into an error
entry and a closed step (E1, D5). That is the only channel available once
streaming has begun: the status line went out with the first byte.

Cancellation is the reader's. The generator holds the body's reader, listens for
the turn's `AbortSignal`, and cancels the body — so a cancelled turn stops
Workers AI generating, rather than just stopping listening to it. The `finally`
runs on every exit, including the loop breaking out of its `for await` when it
sees the signal, so there is no path that leaves a body open. The suite asserts
the count of cancelled bodies, which is the only way to tell the two apart.

### Why a route exists

The browser POC has a client in the page, and a page cannot be given a binding
without being given the account. Its example-local OpenAI-compatible provider
points at the same origin with no key, and `handleChatCompletions` answers out
of the binding on the server side. Nothing about the agent in the page knows
Workers AI exists.

It is deliberately the smallest thing that is honestly the protocol: it takes the
body that provider sends, forwards the messages and tools to the binding
unchanged, and re-frames the answer into chunks that provider parses, ending with
`finish_reason` and `[DONE]`. A mid-stream failure is re-framed as an `error`
event for the same reason the provider throws on one. A request that did not ask
to stream is answered with a single completion object, assembled the same way.

**This is the seed of the served server.** The route is where a browser client's
requests will arrive when the agent is served rather than embedded, and the shape
it has now — one handler, a binding, no state — is the shape that grows a session
and a plugin list under it.

CORS is off unless `cors: true` asks for it. Same-origin is the ordinary case and
needs none, and a route that hands itself to every origin is a route anyone can
spend the account's inference through.

### Local development and the suite

There is no local simulation of Workers AI: inference always runs on Cloudflare
([local development](https://developers.cloudflare.com/workers/local-development/)).
So `wrangler dev` needs a logged-in account for `/ask` and
`/ai/chat/completions`, and those requests spend the account's allocation —
$0.011 per 1,000 neurons, with 10,000 neurons a day free
([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)).

That has one consequence for the suite. An `ai` binding is _always_ a remote
binding, so any test that used the declared `env.AI` would need an account.
Every test therefore drives a **fake binding** instead — `fakeAi` in
`tests/helpers/ai.ts`, a `run` that answers with a scripted stream — and no test
in this package touches a real model. Upstream's opt-in smoke test against the
real binding rode on the Vitest pool and was not vendored with the copy.

`self` is a factory, not a stub: an RPC stub is bound to the request that minted it, and the schedule loopback runs in
the facet's request, so the host mints a fresh stub per operation (`options.self()`).

## Loopbacks re-enter the object

A loopback (`ComposeStubLoopback`) runs in the loader Worker's own request. For the facet host every stub handler
may touch the object — `schedule` writes its storage, `server` calls back into another facet through `ctx.facets` —
and workerd refuses I/O on an object's `ctx` from any request the object is not handling. So the facet host registers
a re-entry for its host id (`registerStubReentry`): the loopback mints a stub to the object (`options.self()`, per
call, because a stub is bound to the request that minted it) and asks `composeStubCall(props, input)`, which the
object's class forwards to `host.stubCall` — the ordinary registry dispatch, now inside the object. The facet stub
itself is likewise obtained per use (`ctx.facets.get` is idempotent). The isolate host has no object and dispatches
in the loopback directly.

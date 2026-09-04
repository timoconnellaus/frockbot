# `@frockbot/compose-core`

> Vendored from `tanstack-compose` commit `69163be` on 2026-09-05. FrockBot
> keeps this copy intentionally close to upstream so it can be reviewed and
> migrated independently.

The framework-agnostic kernel of FrockBot Compose: the **client**, **plugins**,
**context** and **deps**, **cleanup**, **status**, **options**, **middleware**
and **events**, **plugin list** reconciliation, and the **host** contract with
the in-process host.

An application is a plugin list. Editing that list while the application runs —
adding, removing, replacing or reconfiguring an entry — is how the application
changes shape, and the client makes sure nothing is left behind when it does.

## Installation

```sh
npm install @frockbot/compose-core
```

## A plugin that provides something

A **context key** carries the type of its value, so nothing has to be declared
globally. A plugin declares the keys it `provides` and the keys it needs as
`deps`, and every registration it makes is undone when its instance is removed.

```ts
import { createContextKey, createPlugin } from "@frockbot/compose-core";

export const loggerKey = createContextKey<{ log: (message: string) => void }>(
  "logger",
);

export const consoleLogger = createPlugin({
  name: "console-logger",
  provides: [loggerKey],
  setup(instance) {
    instance.provide(loggerKey, { log: (message) => console.log(message) });
  },
});
```

## A plugin that depends on one

`instance.context.get` is typed from `deps`, so it can only read what the plugin
declared — and the value is always there, because an instance with an unmet dep
stays `pending` instead of starting.

```ts
const heartbeat = createPlugin({
  name: "heartbeat",
  deps: [loggerKey],
  setup(instance) {
    const logger = instance.context.get(loggerKey);
    const handle = setInterval(() => logger.log("alive"), 1000);
    // Cleanups run in reverse order when the instance is removed.
    instance.cleanup(() => clearInterval(handle), "heartbeat interval");

    // Any key can be read without declaring it; absent keys read as undefined.
    const maybe = instance.context.peek(someOtherKey);
  },
});
```

## Running a client

```ts
import { createClient } from "@frockbot/compose-core";

const client = createClient({
  plugins: [
    { id: "logger", plugin: consoleLogger },
    { id: "heartbeat", plugin: heartbeat },
  ],
});
await client.settled();
```

Editing the plugin list reconciles by `id`; only entries that changed are
started, stopped or restarted, and every edit resolves once the client is
quiescent.

```ts
await client.setEnabled("logger", false); // heartbeat is cleaned up, back to pending
await client.setEnabled("logger", true); // heartbeat starts again, fresh
await client.addPlugin({
  id: "timer",
  plugin: timerPlugin,
  options: { every: 5 },
});
await client.removePlugin("heartbeat");
```

Swapping a provider for a different implementation of the same key restarts
every dependent against the new one, without any dependent knowing:

```ts
await client.setPluginList(
  client.pluginList.state.map((entry) =>
    entry.id === "logger" ? { ...entry, plugin: bufferLogger } : entry,
  ),
);
```

## Options

Options are validated and defaulted by a **validator** — any
[Standard Schema](https://standardschema.dev) — before the instance starts, and
their type flows into `setup`. Invalid options put the instance in `error` with
a path-annotated message; it never starts.

```ts
import * as v from "valibot";

const timerPlugin = createPlugin({
  name: "timer",
  validator: v.object({ every: v.optional(v.number(), 1000) }),
  setup(instance, options) {
    const handle = setInterval(() => {}, options.every); // options: { every: number }
    instance.cleanup(() => clearInterval(handle));
  },
});

// Updating options restarts only this instance.
await client.setOptions("timer", { every: 250 });
```

## Actions and middleware

An **action** is a named operation a plugin exposes so other plugins can wrap it
with **middleware**. Middleware can change the input, change the result, or stop
the action by not calling `next` — and the action's owner cannot tell which.

```ts
import { createAction } from "@frockbot/compose-core";

const callTool = createAction<{ name: string; args: string }, string>(
  "tools.call",
);

const tools = createPlugin({
  name: "tools",
  setup(instance) {
    instance.defineAction(callTool, ({ name, args }) => `${name}:${args}`);
  },
});

const shouting = createPlugin({
  name: "shouting",
  setup(instance) {
    instance.use(callTool, ({ input, next }) =>
      next({ ...input, args: input.args.toUpperCase() }),
    );
  },
});

await client.dispatch(callTool, { name: "echo", args: "hi" }); // 'echo:HI'
```

## Events

An **event** is a typed notification; **listeners** observe it and cannot alter
it. A listener that throws is contained and reported, and affects neither the
emitter nor the other listeners. Whether `emit` waits for its listeners is part
of the event's definition and shows up in its type.

```ts
import { createEvent } from "@frockbot/compose-core";

const toolCalled = createEvent<{ name: string }>("tools.called");
const drained = createEvent<void>("tools.drained", { awaited: true });

instance.on(toolCalled, (payload) => console.log(payload.name));

instance.emit(toolCalled, { name: "echo" }); // void
await instance.emit(drained, undefined); // Promise<void>
```

## Plugins from source

A plugin entry can carry **plugin source** — a string — instead of a plugin
reference. The client starts it through a **host**: the in-process one that
ships here by default, or the one the entry names. A hosted plugin is an
ordinary instance, with an id, a status, options, cleanup and everything else on
this page.

Source is an ES module. Its default export is the setup function; its other
named exports are handlers the client can call. The only thing it can reach is
the **stubs** it was granted — async in both directions, carrying plain data
only, so the same source runs unchanged in-process and in an isolate.

```js
export default async function setup({ id, options, stubs }) {
  await stubs.log(`starting ${options.label}`);
  await stubs.tools.register({ name: "add", handler: "add" });
  return () => {
    /* release anything this module holds */
  };
}

export async function add({ a, b }) {
  return a + b;
}
```

The operator decides which stubs an entry gets. A stub is authored once by
whoever owns the capability, together with the `.d.ts` text a written plugin is
checked against and shown:

```ts
import { createStub } from "@frockbot/compose-core";

const toolsStub = createStub({
  name: "tools",
  declarations: `declare const tools: {
    register(tool: { name: string; handler: string }): Promise<void>
  }`,
  deps: [toolsKey],
  handler: ({ input, instance, call }) => {
    const remove = instance.context.get(toolsKey).add({
      name: input.name,
      // Call back into the plugin's named export, through its host.
      run: (args) => call(input.handler, args),
    });
    instance.cleanup(remove, `tool(${input.name})`);
  },
});

await client.addPlugin({
  id: "greeter",
  source,
  host: "in-process",
  stubs: [logStub, toolsStub],
  options: { label: "greeter" },
});
```

Source entries must name a host. Omitting `host` is a refused activation; use
`host: "in-process"` only when running that code in the client process is an
explicitly reviewed choice.

Every stub call is a dispatch of `stubCallAction` carrying the calling
instance's id, attached where the plugin's code cannot read or forge it, so
middleware approves, logs or refuses per instance:

```ts
client.use(stubCallAction, ({ input, next }) => {
  if (!allowed(input.instanceId, input.stub)) throw new Error("refused");
  return next(input);
});
```

`client.callSource(id, name, input)` calls a source entry's named exports from
the client side, through its host — the same door `call` opens for a stub
handler, for when one plugin has to reach another entry's handlers. It gives
hosted code no new authority: source still reaches only what a grant hands it.

Removing the entry revokes its stubs, stops its code, and resolves only once the
host has released it. Source that fails to parse, fails to load, throws in setup
or throws on the first call leaves the entry in `error`; `sourceErrorOf(error)`
gives the phase, the message and, where available, the line.

Pass a `SourceChecker` to `createClient({ checker })` and it is consulted before
a host is asked to start anything, against the declarations of exactly that
entry's grants — so it is a type checker and a compiler in one seam. Without it,
source is started as written. A checker that compiles more than the grant text —
a base declaration file, a synthesized `stubs` type — publishes what it compiles
as `declarations(grants)`, so whoever shows an author the declarations shows the
ones the check uses. A checker may also implement `exports({ source, grants })`,
which reports a module's named exports with the type of each: that is how one
written module is described to another that calls it.

> The in-process host runs plugin source in your own process: it is the
> reference other hosts are measured against, not an isolation boundary. In
> workerd, where a module cannot be built from a string, a source entry lands in
> `error` saying so.

## Inspection

Everything the client knows is readable, and observable through
[`@tanstack/store`](https://tanstack.com/store) stores, so adapters and devtools
render live without polling.

```ts
client.inspect();
// [{ id: 'timer', plugin: 'timer', status: 'pending', missing: ['logger'] }, …]

client.resources("timer");
// { label: 'timer (timer)', children: [{ label: 'timer interval', children: [] }] }

client.instances.subscribe((snapshot) => render(snapshot));
client.pluginList.subscribe((list) => renderComposer(list));
```

A plugin may edit the plugin list it belongs to — including disabling itself —
through `instance.client`, which is how an application changes its own shape.

## Learn more

- [`DESIGN.md`](./DESIGN.md) — the kernel's lifecycle, reconciliation and inspection model
- [`CONTEXT.md`](../../CONTEXT.md) — the glossary these terms come from
- [`docs/acceptance/kernel.md`](../../docs/acceptance/kernel.md) — the contract, criterion by criterion
- [`docs/acceptance/hosts.md`](../../docs/acceptance/hosts.md) — what a host must do

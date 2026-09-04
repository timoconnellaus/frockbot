# `@frockbot/compose-typescript`

> Vendored from `tanstack-compose` commit `69163be` on 2026-09-05. FrockBot
> keeps this copy intentionally close to upstream so it can be reviewed and
> migrated independently.

The **source checker** for written plugins. A plugin entry can carry **plugin
source** — TypeScript in a string, typically written by an agent — instead of a
plugin reference. This package type-checks that source against the declarations
derived from exactly the **stubs** the entry was granted, and hands the **host**
the plain JavaScript it produced.

What type-checks against those declarations is what runs. A plugin cannot even
name a capability it was not granted, because the type environment _is_ the
entry's authority.

## Installation

```sh
npm install @frockbot/compose-core @frockbot/compose-typescript
```

## Usage

Create it with `createTypeScriptChecker()` and pass it to the client. A client
without it starts plugin source as written; a client with it checks the same way
for every host and every plugin-list position, because the check happens
client-side before any host is asked to start anything.

```ts
import { createClient, createStub } from "@frockbot/compose-core";
import { createTypeScriptChecker } from "@frockbot/compose-typescript";

const toolsStub = createStub({
  name: "tools",
  declarations: `/** Offer one of this module's named exports as a tool. */
declare const tools: (tool: { name: string; handler: string }) => Promise<void>`,
  deps: [toolsKey],
  handler: async ({ input, instance, call }) => {
    const remove = instance.context
      .get(toolsKey)
      .add(input.name, (args) => call(input.handler, args));
    instance.cleanup(remove, `tool(${input.name})`);
  },
});

const client = createClient({
  checker: createTypeScriptChecker(),
  plugins: [
    { id: "tools", plugin: toolsPlugin },
    { id: "adder", source, host: "in-process", stubs: [toolsStub] },
  ],
});
await client.settled();
```

`source` is an ES module. Its default export is `setup`; every other named
export is a handler the client can call by name:

```ts
const setup: Setup = async ({ id, stubs }) => {
  await stubs.tools({ name: id, handler: "add" });
};
export default setup;

export async function add(input: { a: number; b: number }) {
  return input.a + input.b;
}
```

Annotate the default export with `Setup` and the argument is typed for you —
`stubs` has exactly the granted names on it and nothing else.

## When it fails

Source that does not type-check is not started. The entry is left in `error`,
and the failure reads the same way as a parse, load or setup failure, so an
agent has one recovery loop for all of them:

```ts
import { sourceErrorOf } from "@frockbot/compose-core";

const snapshot = client.inspect().find((one) => one.id === "adder");
const failure = sourceErrorOf(snapshot?.error);

failure?.phase; // 'check'
failure?.diagnostics;
// [{ message: "Property 'log' does not exist on type 'Stubs'.", line: 2, column: 15 }]
```

Diagnostics are ordered by position, carry 1-based `line` and `column`, and
carry TypeScript's own sentence.

## Showing the model what it is checked against

`pluginDeclarations` returns the exact text the checker compiles against for a
given grant list. Hand it to the model and what it writes against that text is
what runs.

```ts
import { pluginDeclarations } from "@frockbot/compose-typescript";

const declarations = pluginDeclarations([
  { name: "tools", declarations: toolsStub.declarations },
]);
```

The returned checker's `SourceChecker.declarations` is the same function, so a
composer holding the checker gets this text without importing this package —
`@frockbot/compose-tools` shows it on `list_plugins` and `read_plugin`, and an
agent writing against it is writing against the check.

It is the base declarations — the module shape, `Setup`, `SetupArgument`,
`Cleanup`, `Handler` — then each grant's own `.d.ts` text in grant order, then a
`Stubs` interface synthesized from the grant names. There is no `any` in it.

## What a written plugin can reach

The compilation has the ES2022 built-ins, the declarations above, and nothing
else: **no DOM, no `console`, no `process`, no filesystem, and nothing to
import**. That is not a policy this package invented — it is the set of globals
every host we intend to run a written plugin in agrees on, from an in-process
`import()` in Node to a hardened Compartment in a Web Worker. `document.title`
in plugin source is a type error here rather than a crash in an isolate later.

## API

```ts
function createTypeScriptChecker(): SourceChecker;

function pluginDeclarations(
  grants: ReadonlyArray<{ name: string; declarations: string }>,
): string;

const baseDeclarations: string;
```

`createTypeScriptChecker()` also implements the seam's optional
`exports({ source, grants })`, which asynchronously returns a module's named
exports with the type of each where it can be recovered. That is how a **view** is checked
against the named exports of the plugin it belongs to: the caller turns the
result into declarations, so nothing here knows what a view is.

## Where it runs, and what it costs

The suite runs under Node, jsdom, and workerd in CI; the checker was also run by
hand under Bun 1.3, with the same results and the same latency.

|                                                            |             |
| ---------------------------------------------------------- | ----------- |
| Bundle, min+gzip, tree-shaken as a consumer imports it     | **0.97 MB** |
| First check, cold (the declaration library is parsed once) | **~200 ms** |
| Each check after, ~30 lines, warm                          | **~15 ms**  |

Measured by `tests/budget.test.ts`, which fails if either drifts.

Importing or creating the checker does not evaluate TypeScript. The compiler is
loaded as a separate chunk on the first check, keeping its roughly 9 MB of
module evaluation out of a Worker's startup CPU budget. Under `nodejs_compat`,
the package supplies the two CommonJS path globals TypeScript expects while its
Node system initializes; checking itself uses only the package's in-memory host
and generated declaration library.

`typescript` is a regular dependency of this package, and of this package only.
Core has no compiler and must not gain one.

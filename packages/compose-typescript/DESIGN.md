# `@frockbot/compose-typescript` — design

The source checker for written plugins: it type-checks **plugin source** against
the **plugin declarations** derived from the entry's granted **stubs**, and
returns the JavaScript the **host** starts. It meets
[`docs/acceptance/self-modification.md`](../../docs/acceptance/self-modification.md)
D7, D8 and D9. It is client infrastructure outside core — a client without it
starts source unchecked (D9), while a client created with it checks the same way
for every host and every plugin-list position.

Core owns the seam ([`compose/DESIGN.md` §The type-check seam](../compose/DESIGN.md));
this package is one implementation of it. Nothing here changes how a plugin is
written, and nothing in core knows this package exists.

## The runtime primitive

```ts
function createTypeScriptChecker(options?: {
  baseDeclarations?: string;
  baseVersion?: string;
}): SourceChecker;
```

One factory is passed to `createClient({ checker })`. Its only options install a
generated product base and the version used for export inspection; the compiler
language itself is fixed. The other runtime export exists so a composer can
show the model what the checker will check against:

```ts
function pluginDeclarations(
  grants: ReadonlyArray<{ name: string; declarations: string }>,
  productBase?: string,
): string;
```

`pluginDeclarations` is not a description of the check — it _is_ the check's
declaration file. `check` calls it and compiles against exactly what it returns,
so D8's "the declarations a written plugin is checked against are the ones the
model is shown" is true by construction rather than by discipline. The `check`
request's `declarations` string is ignored for that reason: two producers of the
same text is one too many, and only `grants` carries the names the `stubs`
object type needs.

The checker exposes the same function as `SourceChecker.declarations`, the
seam's optional member, so a composer can ask the checker in front of it what a
grant set compiles to rather than falling back to core's `stubDeclarations` —
which is the grant text alone, without the base declarations or the `Stubs`
interface, and therefore not what this checker checks. It is the same function
object `check` calls: there is one producer, and both callers reach it.

### Generated product bases (slice 9)

Slice 9 adds a build-time entry, `@frockbot/compose-typescript/generate`, with
two more primitives:

```ts
generateDeclarations({ entry, exportName, tsconfig? }): {
  text: string
  version: string
}
composeDeclarations({ entry, exportName, tsconfig?, id? }): Plugin
```

`generateDeclarations` builds a TypeScript program from the base module, reads
the exported `defineBase` value's `grants` property, and emits one ambient const
per grant. The final trusted handler parameter is omitted; every authored
parameter remains, and every result is awaited then wrapped in `Promise`.
Anonymous types use `NoTruncation`. Named source types are discovered by walking
their type symbols and emitted in the same file as `type` aliases, so no source
module import can drift or become visible to written code. Declarations keep
the base record's property order and the base version is lowercase SHA-256 of
the exact text.

The Vite adapter serves `compose:declarations` by default, invalidates it for a
changed watched file, and regenerates on the next load. An optional `id` permits
one build to carry two explicitly named base versions without changing the
default interface. The CLI is the same generator plus one file write; it has no
independent declaration logic.

Vite is an optional peer and a development dependency. The generated API can
therefore return Vite's real `Plugin` type when Vite is present, while the CLI
path for non-Vite consumers installs no second declaration implementation.

`createTypeScriptChecker({ baseDeclarations? })` prepends generated product-base
text between the universal written-module shape and per-entry low-level grant
text. The generated file may name every base grant, but `Stubs` is still
synthesised only from the request's grants; the existing bare-global diagnostic
also prevents reaching an ungranted ambient const directly. Low-level
hand-authored declarations remain supported for hosts and tests.

Language-service sessions are keyed by the pair `(baseVersion, grant-derived
declarations)`. The request version, not checker construction time, selects the
session, so a redeploy cannot reuse a program from the prior base even if grant
names happen to be unchanged.

## The declaration file

Three parts, concatenated in this order. This is the whole world the module is
compiled in.

**1. The base declarations** — the written plugin shape, shipped by this
package and identical for every entry:

```ts
/**
 * A written plugin is an ES module. Its default export is `setup`, which the
 * client runs once when the instance starts; every other named export is a
 * handler the client can call by name.
 *
 * This file is the whole of the environment the module is compiled in: the
 * ES2022 built-ins, these declarations, and nothing else. There is no DOM, no
 * `console`, no `process`, no filesystem, and no module to import. If a written
 * plugin can do it, a stub was granted for it.
 *
 * Values only cross the boundary as structured-clone-safe data — plain objects,
 * arrays, and primitives. A function, a class instance or a live handle passed
 * to a stub or returned from a handler fails at the boundary, in every host.
 */

/** Undoes what the module itself holds. The client runs it when the instance is removed. */
type Cleanup = () => void | Promise<void>;

/** What `setup` is handed. */
interface SetupArgument {
  /** This instance's id, as it appears in the plugin list. */
  readonly id: string;
  /** The instance's validated options. Narrow it before you use it. */
  readonly options: unknown;
  /** Exactly the stubs this entry was granted, and nothing else. */
  readonly stubs: Stubs;
}

/**
 * The module's default export. Annotate it — `const setup: Setup = …` — and the
 * argument is typed for you.
 */
type Setup = (
  argument: SetupArgument,
) => void | Cleanup | Promise<void | Cleanup>;

/**
 * Every named export of the module is a handler. The client calls it by name
 * with one structured-clone-safe argument and clones the result back. (`never`
 * as the parameter type is how this rule says "declare whatever input your
 * handler expects"; it does not mean the handler takes nothing.)
 */
type Handler = (input: never) => unknown;
```

**2. The grants**, in grant order, each one the `.d.ts` text its `createStub`
carries, under a comment naming it.

**3. The `stubs` object type**, synthesized from the grant names:

```ts
/** The stubs this entry was granted. */
interface Stubs {
  readonly tools: typeof tools;
  readonly log: typeof log;
}
```

Three decisions worth stating.

**`typeof` a declared const, not a re-printed type.** A grant's declaration text
is written by whoever owns the capability and is opaque to us. Synthesizing
`Stubs` by naming `typeof tools` means we never parse, re-print or paraphrase
that text — whatever the grant author wrote is exactly what `stubs.tools` has.
An entry with no grants gets `interface Stubs {}`, so naming any stub is
"Property 'x' does not exist on type 'Stubs'". That is D7's real content: the
type environment is the entry's authority, so a plugin cannot name a capability
it was not granted.

**The grant consts stay reachable, and that is a diagnostic, not a hole.**
Because the grant text is `declare const tools: …` at global scope, `tools` is
also a bare global inside the module — but at runtime there is no such global,
only `stubs.tools`. So after type-checking, the checker asks the type checker
which identifiers in the source resolve to a value declared in the declaration
file, and reports each one:

> `"tools" is a stub: reach it through the setup argument, as stubs.tools`

Resolving through the type checker rather than matching text means a local
`const tools = 1` shadowing the grant is correctly left alone. The alternative —
putting the grants in a separate module file and importing their types — would
have made the D8 text two files with an import between them, and D8 wants one
text a composer can hand the model.

**No `any` anywhere in the base.** `options` is `unknown`, so the author narrows
it. `Handler`'s parameter is `never`, which is what makes any declared input
type assignable to it under `strictFunctionTypes` without `any`'s bivariance —
an `any` there would silently accept a handler whose input is wrong.

## The check

`ts.createLanguageService` over an in-memory file set: the declaration library,
`/declarations.d.ts` (the text above), `/plugin.ts` (the source as written, byte
for byte, so every line and column in a diagnostic is the author's), and
`/shape.ts`.

**`/shape.ts` is what makes the module-shape rules real rather than documented.**
It is generated per check from the source's own exports, one assertion per line:

```ts
import * as plugin from "./plugin";
const setup: Setup = plugin.default;
const handler1: Handler = plugin["add"];
```

Line _n_ is the assertion about one export, so a diagnostic in it maps back to
the position that export is written at in `/plugin.ts` — the model is told where
its own code is wrong, never where a file it cannot see is. The shape file is
only consulted when the source itself has no diagnostics: it would otherwise
complain about a module TypeScript has already said it does not understand.

Compiler options are `strict` plus `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules: true`,
`types: []`, `module: ESNext`, `target: ES2022`, `lib: ['lib.es2022.d.ts']`.
`noUnusedLocals` is off: a model's draft often has one, and it is not a reason
to refuse to start.

`isolatedModules` is on so the check and the transpile agree: anything
`transpileModule` cannot compile file-at-a-time is a diagnostic rather than a
silent miscompile. `types: []` and a `resolveModuleNameLiterals` that resolves
exactly one specifier — the shape file's reference to the plugin — are what make
"there is nothing to import" true; every other specifier is unresolved.

### The library, and why ES2022 with no DOM

A written plugin has to run unchanged in every host (hosts.md A5): in-process in
Node, Bun or a browser tab; in a Web Worker inside a hardened Compartment; in a
Dynamic Worker on workerd. The set of globals all of those agree on is the
ECMAScript built-ins and nothing else. `console` is not in it — a hardened
Compartment does not have to provide one. `document`, `window`, `fetch`,
`process`, `Buffer` and `setTimeout` are not in it either.

So the library is `lib.es2022.d.ts` and the 56 files it references, and there
are no `@types` packages: `types: []`. ES2022 rather than ES2023 because
workerd, the oldest engine we intend to target, is the constraint, and because
`Array.prototype.findLast`'s absence is a better failure than a plugin that
type-checks here and throws in a Dynamic Worker. `document.title` in plugin
source is a type error, which is the point — the check is a statement about
where the code will run, not just about whether it is well-typed.

The library text is **generated into `src/generated/lib.ts`** by
`scripts/generate-lib.mjs` and shipped with the package rather than read from
`node_modules` at run time. Reading from disk would mean the checker behaves
differently in a browser than in Node, and would make the answer depend on which
TypeScript the consumer happens to have installed. It costs ~50 kB gzipped, on
top of a compiler that costs far more, and it buys the same answer everywhere.
Regenerate it with `node scripts/generate-lib.mjs` after a TypeScript bump.

### Diagnostics

Syntactic and semantic diagnostics for `/plugin.ts`, plus the stub-reachability
ones, merged and **sorted by position**, each mapped to
`{ message, line, column }` with 1-based line and column and TypeScript's
flattened message text — the sentence, not the code number. A syntax error is a
diagnostic like any other, which is what makes D4's "one recovery loop" true:
the model cannot tell from the shape of the result whether it mistyped a brace
or misused a stub.

`check` returns `code` only when there are none. When there are, it returns
diagnostics and no `code`, core turns that into a `SourceError` with
`phase: 'check'`, and the entry is left in `error` without the host ever being
asked to start anything.

Diagnostics from the declaration file itself are reported too, prefixed with
`the declarations for this entry are not valid TypeScript:`. That is an operator
bug in a grant's `.d.ts` text, not the model's, and it should not look like the
model's.

### Transpile, not emit

On success, `ts.transpileModule` on the same source: one file, no program, no
type information, types stripped and nothing else changed. It is the cheap half
of the pass — the program already exists and has already answered the question
that matters — and it produces a plain ES module with the same statements and
the same line count, which the in-process host can `import()` directly.

Emitting from the program would produce the same JavaScript more slowly and
would tie the output to the program's file layout for no gain.

## Describing one module to another (`exports`)

A **view** is checked against the named exports of the plugin's server half, so
that a view calling a handler the plugin does not export is a diagnostic rather
than a failure on the page (`ui.md` D2). What that needs from a checker is one
thing: the names of a module's exports, with the type of each where it can be
recovered.

`SourceChecker.exports({ source, grants })` is that, and it is deliberately not
about views. It compiles the source in the same language service `check` uses
for those grants, walks the module symbol's exports, and prints each one's type
with `typeToString`. Whoever asked turns the result into declarations —
the caller can build `interface ServerHandlers { … }` and hang a `server` stub
off it — so this package never learns what a view is, and any
other pairing of two written modules gets the same answer for free.

Two rules keep the printed text honest in a file that is _not_ the module it
came from:

- **The default export is not listed.** It is the setup function, and it is not
  callable by name.
- **A type that names something the module declares itself is dropped**, and the
  export comes back with a name and no type. `export function f(a: Args)` prints
  as `(a: Args) => void`, and `Args` means nothing in the other module's
  declaration file; a dangling name there would read to the model as a mistake
  in the view rather than a limit of the recovery. Whoever asked falls back to
  the permissive signature, which is what the boundary enforces anyway.

The member is optional on the seam: a checker without it costs the caller
nothing but precision.

## Loading and caching

Creating or importing the checker does not import TypeScript. The compiler is
roughly 9 MB before compression, and evaluating it while a Worker is loading
spends the Worker's small startup CPU budget even when no written entry needs a
check. The first `check` (or `exports`, which needs the same compiler) starts one
cached `import('typescript')`; concurrent callers await that promise, and a
consumer bundler can keep the literal dynamic import as its own chunk. This is
part of the package implementation, not a `define` or alias a particular
consumer must remember to configure.

TypeScript 6.0.2 decides that workerd is Node-like under `nodejs_compat` and
constructs `ts.sys` while its module evaluates. Workerd supplies `process`,
`require`, and the `fs`, `path`, `os`, `crypto`, and `perf_hooks` built-ins that
path probes. It does not supply CommonJS's lexical `__filename` and `__dirname`,
so the loader temporarily adds those two global names as `/typescript.js` and
`/` before the dynamic import and removes them once evaluation settles. The
shim lives in this package and therefore works with any Worker bundler.

The checker never reads `ts.sys`: every program operation goes through its
explicit in-memory `LanguageServiceHost`, including current directory, file
existence, file reads, module resolution, and the generated declaration
library. `ts.sys` only has to initialise safely because TypeScript constructs it
as an import-time side effect.

Per-edit latency is the thing being optimised: a model rewrites a 30-line plugin
several times in a turn, and each rewrite is a check.

- **One `ts.DocumentRegistry` for the whole checker.** The 57 library files are
  parsed once and shared by every language service, which is where nearly all of
  the first check's cost is.
- **One language service per base version and declaration file.** Declarations
  are a function of the generated base plus the grant set, so entries checked
  against the same base and grants share a service. Either a base-version or
  grant change gets a new one. The cache holds eight, evicted
  least-recently-used, and each disposes its service on eviction.
- **The source is a versioned script.** A re-check of the same entry bumps
  `/plugin.ts`'s version and asks the same service again; TypeScript reparses one
  small file and reuses every other `SourceFile` in the program.

Script versions come from a single counter shared by every session, not from a
per-file one. The document registry keys a parsed file by path _and_ version, and
every session calls its source `/plugin.ts`; two sessions that both started at
version 1 would be handed each other's syntax tree. A number that only ever goes
up means a given path never reuses a version for different text — and because
`write` leaves the version alone when the text has not changed, re-checking an
unchanged source is still a registry hit.

The instance id is deliberately not part of the key. Two entries with the same
grants are the same compilation environment, and keying by id would multiply the
cost of the thing the cache exists to avoid.

## Where it runs, and what it costs

`tests/budget.test.ts` measures both and fails if they drift, and the numbers
are in the README.

|                                                            |         |
| ---------------------------------------------------------- | ------- |
| Bundle, min+gzip, tree-shaken as a consumer imports it     | 0.97 MB |
| First check, cold (the declaration library is parsed once) | ~200 ms |
| Each check after, ~30 lines, warm                          | ~15 ms  |

The suite runs under `node`, `jsdom`, and workerd in CI. The workerd arm uses
the same `nodejs_compat` and `2026-05-01` compatibility date as the Cloudflare
host and checks passing and failing source against a real grant declaration.
Bun is not a CI runner here, but the checker was run by hand under Bun 1.3 and
gave the same answers at the same cost.

On workerd the checker compiles source in the tenant Worker; the separate
Cloudflare host still starts the returned JavaScript in a Dynamic Worker. The
compiler's size is paid as a separate lazy chunk and its evaluation is paid on
the first actual check, not when the tenant Worker starts.

`typescript` is a **regular dependency**, not a peer. The declarations the model
is shown and the diagnostics it is given are this package's contract, and both
change with the compiler version; a peer dependency would make the consumer's
choice of TypeScript part of a contract they did not know they were making. It
is also a run-time dependency here, not a build-time one — a peer would be
lying about that. Only this package depends on it; core does not, and must not.

## Criterion → test

| Criterion                                                                                               | Test                                                     |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D7 — source is checked before it is started; a failure leaves the entry as it was, with line and column | `tests/checking.test.ts`                                 |
| D7 — checked against exactly the granted stubs                                                          | `tests/checking.test.ts` ("a stub that was not granted") |
| D8 — the declarations shown are the declarations checked                                                | `tests/declarations.test.ts`, `tests/composer.test.ts`   |
| D9 — a client checker; the checked output runs in the in-process host                                   | `tests/running.test.ts`                                  |
| D4 — a syntax error is a diagnostic, in the same shape as every other failure                           | `tests/checking.test.ts`                                 |
| The module shape the declarations describe is enforced, not just documented                             | `tests/checking.test.ts`                                 |
| Budget — size and per-check latency                                                                     | `tests/budget.test.ts`                                   |
| The whole agent loop against this checker, end to end                                                   | `tests/composer.test.ts`                                 |
| `ui.md` D2 — a view is checked against its plugin's named exports                                       | `tests/views.test.ts`                                    |
| The exports of one module, with the type of each                                                        | `tests/views.test.ts`                                    |
| Import/factory stay cheap; the first check evaluates TypeScript                                         | `tests/loading.test.ts`                                  |
| TypeScript evaluates and checks source under workerd                                                    | `tests/workerd/checker.test.ts`                          |
| Generated method declarations, named aliases, stable hashes, and source checks                          | `tests/generate.test.ts`                                 |

## What was decided here

- **The model annotates its default export.** `const setup: Setup = …` rather
  than a bare `export default function setup({ stubs }) {}`. TypeScript has no
  way to give a default export a contextual type from an ambient declaration, so
  the alternatives were an annotation, rewriting the source before checking it
  (which breaks the line numbers D7 asks for), or turning `noImplicitAny` off
  (which would make `stubs.anythingAtAll` legal and delete the point of the
  package). One annotation, stated in the declarations the model is shown, is
  the smallest of the three.
- **Named exports are checked against `Handler`.** The rule "named exports are
  the callable handlers" is enforced, not just documented: an exported constant
  is a diagnostic at the export's own position.
- **`exports` prints types; it does not synthesize declarations.** The caller
  owns the shape of what it declares — the interface name, the call signature,
  the doc comments the model reads. This package owns only what TypeScript can
  recover, which keeps the seam free of anything view-shaped.
- **No compiler options.** Which lib and which strictness apply are part of
  "what type-checks is what runs"; making them configurable would make that
  sentence depend on operator configuration. Product declarations and their
  base version are inputs because the base is product-owned, not changes to the
  checker language.

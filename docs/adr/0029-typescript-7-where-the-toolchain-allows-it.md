---
status: proposed
---

# TypeScript 7 everywhere the toolchain allows, and a bounded typecheck

Every package whose typechecking is a plain `tsc` invocation is on TypeScript
7's native compiler. The packages held back are held back by a named tool that
cannot run on it, not by preference. `bun run typecheck` runs the packages
through a bounded pool instead of starting all of them at once, and the editor
language server is TypeScript 7's own, not a `tsserver` from a global install.

## What was wrong

Two separate problems that happened to share a cause.

The repo was already half-migrated with no record of where the line was. 46
packages declared `^7.0.2` and 28 declared `5.9.3`, and nothing said which of
those 28 were waiting on a blocker and which had simply been missed. Anyone
bumping one at random would hit the blocker and have no way to know whether they
had found a real wall or their own mistake.

Meanwhile `bun run typecheck` ran `bun run --filter '*' typecheck`, which starts
every package at once — 73 of them — and bun 1.3 offers no way to cap that.
Each one loads its own TypeScript program over the same `node_modules` type
graph. On a 10-core machine that is not parallelism, it is paging. The move to
TypeScript 7 makes it worse rather than better: the native compiler is itself
multithreaded, so N native processes each try to claim the whole box.

The root `tsconfig.json` also listed `references` to six projects. Project
references require `composite: true`, and no tsconfig in the repo sets it, so
`tsc -b` against that file fails. Nothing invoked it, so the breakage was
invisible — it simply sat there looking like a working solution build.

## The decision

**A package moves to TypeScript 7 unless a tool it depends on embeds the
TypeScript compiler API.** TypeScript 7's published package exports no compiler
API: its main export is `lib/version.cjs`, a version string. Anything that does
`import ts from "typescript"` and expects `ts.createProgram` or `ts.sys` cannot
run on it. That single rule decides every case, and each holdout names its
blocker:

- **15 packages** typecheck through `vue-tsc`, which embeds the API via Volar.
  `client-ui`, thirteen `plugin-*` packages, and `apps/cloudflare`'s client
  config.
- **`packages/applet-sdk`** does `import ts from "typescript"` in
  `src/cli/check.ts` and imports `typescript-eslint` in `src/lint/index.ts`.
- **The workspace root** keeps `typescript` at `5.9.3` because
  `scripts/generate-isolate-context-catalog.ts` imports the compiler API, and
  that script runs as part of `bun run typecheck`.

Everything else — 57 of 73 packages — is on 7.0.2.

This is expected to be temporary. TypeScript 7.1 is scoped to ship the stable
programmatic API that Volar and the other template typecheckers need. When it
lands, the Vue tier moves in one commit and this ADR's list shrinks to the root
scripts.

**Typechecking is bounded, not fanned out.** `scripts/typecheck.ts` runs the
packages through a pool capped at `min(4, cores/2)`, overridable with
`TYPECHECK_CONCURRENCY`. This costs nothing: measured on a 10-core machine, the
suite takes 30.3s at concurrency 2, 29.0s at 4, and 31.8s at 8, with CPU pinned
near 370% throughout — one TypeScript 7 process already uses about 3.7 cores, so
extra processes add memory pressure and no throughput.

**The editor uses TypeScript 7's own language server.** TypeScript 7 ships no
`tsserver`; the server lives in the native binary behind `tsc --lsp --stdio`.
`scripts/ts-lsp.ts` launches it, resolving the per-platform binary the way
TypeScript's own `getExePath` does. Without this, editors silently fall back to
whatever `tsserver` they can find — in practice a globally installed TypeScript
5.x, which is both the wrong version and unbounded in memory.

## What was rejected

**Project references and `tsc --build`.** They require `composite: true`, which
requires declaration emit. 66 packages here export `./src/*.ts` directly and
have no build step. Adopting references would mean emitting `.d.ts` for all of
them and rewriting every export map — remaking the repo's source-first shape to
buy incrementality that CI, which starts cold, would mostly not collect. The
dead `references` in the root `tsconfig.json` are removed rather than repaired.

**Merging same-option packages into one program.** 24 packages have
byte-identical compiler options, and checking them as one program instead of 24
would cut the redundant re-parsing that shows up as 105s of user time behind a
30s wall. It was built, measured, and rejected on evidence:

- The merged program reported an error in `plugin-mcp` that the package does not
  have on its own. `@types/bun` is not uniform — 62 packages declare `1.4.0` and
  9 declare `1.3.6`. `plugin-mcp` is on 1.3.6; merged, it resolves 1.4.0, whose
  `toEqual<X = T>(expected: NoInfer<X>)` rejects code that 1.3.6 accepts. The
  diagnostic is an artifact of the merge.
- The merged program pulled in 521 files where the 24 packages hold 204. Because
  packages export their sources, importing one drags its `src` into the program,
  so unrelated packages get checked under this cohort's `lib` and `types` —
  including packages that need `WebWorker` rather than `DOM`.

Both faults come from the same source-first design that rules out project
references. A single program is only safe where every package resolves the same
types, and this repo does not. Unifying `@types/bun` first would make the
question worth reopening; it is not a prerequisite for anything here.

Package boundaries were not among the reasons. Cross-package imports resolve
through each package's `exports` map via `node_modules`, so sharing a program
does not open a path to another package's internals.

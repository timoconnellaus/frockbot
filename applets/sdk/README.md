# @frockbot/applet-sdk

What a FrockBot Plugin is written against, and the build that turns a
Plugin's source into the module and manifest a publish stores (ADR 0026).

## Entry points

| Import                              | For                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `@frockbot/applet-sdk/plugin`       | types only: `PluginModule`, `PluginContext` and the rest — a Plugin's `plugin.ts`          |
| `@frockbot/applet-sdk/build/plugin` | `runPluginBuildV1` — the four stages, for the build service and the seeded Plugins' script |

## A Plugin

A Plugin is a directory: a `plugin.json` descriptor, a `plugin.ts` module,
and any `.ts` files beside it that the module imports. `plugin.ts` has no
default export. It exports `tools` and `execute` by name, and may export
`hooks`, `services`, `triggers`, `views`, `cards` and `modelProviders`
(`PluginModule`). `tools` may be empty: a Plugin that only serves hooks
builds.

`@frockbot/applet-sdk/plugin` is declarations only, so it is imported with
`import type`; a value import of it fails the bundle stage.
`app/plugins/sdk-types.test.ts` pins its `PluginContext`, hook events, grants
and hook payloads to the kernel's own types, so a Plugin that type-checks
here sees the `ctx` the kernel builds.

A model provider (`PluginModelProvider`, ADR 0032) answers a normalized model
request with normalized stream events, and makes its one upstream call
through `ctx.modelTransport`. The deployment serves a provider only from the
artifact its own provider catalog names, so this is not a way for a
Bot-written Plugin to reach a provider.

`plugin/template/` is the scaffold a new Plugin starts as, with
`__PLUGIN_ID__` and `__PLUGIN_NAME__` for `plugin_create` to fill in.
`scripts/build-applets-assets.ts` carries it into the Worker as
`app/plugins/template.generated.ts`, and carries `plugin/index.d.ts` into the
Plugins Skill as `app/plugins/skills/plugins/references/types.md`.

## The build

`runPluginBuildV1(directory, { mode, id })` is four named stages over one
directory. A stage that fails stops the run and names itself, with a list of
`{file, line, column, message, severity}` diagnostics. `check` stops after
the type checker; `build` goes on to the module and its manifest.

1. `descriptor`: `plugin.json` is a JSON object whose `id` matches
   `/^[a-z][a-z0-9-]{0,63}$/` and, when the caller passes `id`, is that id.
   The build reads nothing else from it. The app Worker decodes the full
   descriptor and refuses a publish whose descriptor and manifest disagree
   (`pluginManifestDisagreementV1` in `app/plugins/authoring.ts`).
2. `typecheck`: every `.ts` file in the directory, strict, against ES2022
   and the DOM lib for `fetch`, `Request` and `Response`, with
   `@frockbot/applet-sdk/plugin` resolved to `plugin/index.d.ts`. The
   directory must hold a `plugin.ts`. Only errors fail the stage.
3. `bundle`: esbuild makes one unminified ESM module with every import
   inlined. Nothing is external, so a specifier the bundler cannot inline
   fails here, not at mount. `module-paths.ts` rewrites esbuild's module-path
   comments relative to the Plugin's directory, so the same source builds to
   the same bytes wherever it is built.
4. `describe`: the bundle runs in Miniflare beside a describing Worker, with
   no bindings and no outbound network: every `fetch` is answered with a 403.
   Import-time code runs inside workerd, never in the build's own process.
   What the module exports is the manifest. `tools` must be an array and
   `execute` a function; each tool needs a name matching
   `/^[a-z][a-z0-9_]{0,63}$/` and a description; `hooks`, `triggers` and
   `views` hold functions, `services` any values, each card a `render` and
   each model provider a `stream`. A Plugin declares at most 64 tools, each
   name once.

Each describe spawns its own workerd, and both ends of its life are bounded
so a build answers rather than hangs: a runtime not ready within
`BOOT_DEADLINE_MS` (30 seconds) fails the stage with that as its diagnostic,
and the teardown, awaited on every path, gets `DISPOSE_DEADLINE_MS`
(10 seconds).

A build answers the module text and its manifest:
`{ contract: 1, tools, hooks, services, triggers, views, cards, modelProviders, hashes: { module } }`,
where `hashes.module` is the SHA-256 of the module.

Two callers run it. The build service in `apps/applet-build` runs `check`
for `plugin_check` and `build` for `plugin_publish`.
`scripts/build-seeded-plugins.ts` builds each Plugin under
`app/plugins/seeded/` into the Worker bundle through the same stages.

## Tests

```sh
bun run test
```

`test/plugin-build.test.ts` runs `runPluginBuildV1` over the real template,
which `test/plugin-scaffold.ts` fills in and writes to a temporary directory.
It covers each stage's failure and diagnostics, identical module bytes from
different and symlinked roots, and the manifest read off each kind of export.
Every build test boots workerd through Miniflare, so a run needs to bind a
local port. The root `bun test` runs this file too.

# @frockbot/applet-sdk

The SDK a FrockBot Applet is written against: a schema-first Durable Object
server, a TanStack DB client over one real-time socket, a precompiled component
kit on the theme tokens, a linter, and the build pipeline the cloud build
service runs.

An Applet is authored with the `applet_*` tools, built by `apps/applet-build`,
and mounted as a Durable Object facet from an immutable artifact. There is no
CLI: nothing outside the service builds an Applet, and no Computer is involved
at any point.

## Entry points

| Import                              | For                                                                  |
| ----------------------------------- | -------------------------------------------------------------------- |
| `@frockbot/applet-sdk/server`       | `Applet`, `table`, `t` — the Applet's `server.ts`                    |
| `@frockbot/applet-sdk/client`       | `createApplet`, `mount`, `newId` — the Applet's `ui.tsx`             |
| `@frockbot/applet-sdk/kit`          | the fourteen components (`src/kit/README.md`)                        |
| `@frockbot/applet-sdk/lint`         | the flat ESLint config and the five custom rules                     |
| `@frockbot/applet-sdk/protocol`     | wire protocol v1, for the kernel and for tests                       |
| `@frockbot/applet-sdk/build`        | `runAppletBuildV1` — the five stages, for the service                |
| `@frockbot/applet-sdk/plugin`       | types only: `PluginModule`, `PluginContext` — a Plugin's `plugin.ts` |
| `@frockbot/applet-sdk/build/plugin` | `runPluginBuildV1` — the four Plugin stages, for the service         |

## The build

`runAppletBuildV1(directory, { mode })` is five named stages over one
directory: `descriptor`, `typecheck`, `lint`, `bundle`, `describe`. `check`
stops after the linter; `build` goes on to the artifacts. A stage that fails
stops the run and names itself, and every failure is a list of
`{file, line, column, message, severity}`.

`manifest.json`'s tool declarations are derived by mounting the built
`server.js` in Miniflare and calling `health()` — the same question the kernel
asks the facet before it admits a generation, so the manifest cannot disagree
with the code.

`template/` is the scaffold a new Applet starts as.
`scripts/build-applets-assets.ts` turns it into `applets/template.generated.ts`,
which `applet_create` writes through the Workspace.

## Plugins

A Plugin (ADR 0026) is written against `@frockbot/applet-sdk/plugin`, which
is declarations only: `plugin.ts` exports `tools` and `execute`, and may
export `hooks`, `services` and `triggers`, beside a `plugin.json` descriptor.
`runPluginBuildV1(directory, { mode, id })` is four stages — `descriptor`,
`typecheck`, `bundle`, `describe` — with no lint stage, because a Plugin's
reach is a grant the descriptor declares and the kernel enforces. The bundle
is one ESM module with every import inlined, and the manifest is read by
running that module in Miniflare with no outbound network. `plugin/template/`
is the scaffold a new Plugin starts as. `PluginContext` is held to the
kernel's own `ctx` keys by `app/plugins/sdk-types.test.ts`.

## What runs where

`server.ts` becomes a single ESM file whose only import is `cloudflare:workers`,
loaded by the kernel's `APPLETS` Worker Loader with no outbound network, and
mounted as a facet under `AppletState`. `ui.tsx` becomes one self-contained HTML
page served from the anonymous artifact origin into a sandboxed iframe, which
receives its theme tokens and a short-lived viewer token through the host's
`init` message and opens exactly one WebSocket back to the facet.

The Cloudflare programming model is not hidden: an Applet is a Durable Object
with SQLite and hibernating sockets. What the SDK does hide is every binding
name — an author sees `tables`, `tools`, and `this.db`.

## Wire protocol

JSON frames, at most 64 KB each, decoded by `src/protocol/` at both ends;
an unknown type, field, or table fails closed. Two versions are spoken on the
same server, told apart by the socket URL: a page built against v2 opens with
`v=2`, and a page built before it opens with nothing and is spoken to in v1.

| Direction       | Frame      | Carries                                                                                     |
| --------------- | ---------- | ------------------------------------------------------------------------------------------- |
| server → client | `hello`    | contract, generationId, viewer, tables, revision, cursor — and in v2, the `snapshot` itself |
| client → server | `hello`    | contract, optional `since` cursor for catch-up; in v2 only on a resume or when asked        |
| server → client | `snapshot` | every row of every table, plus the cursor                                                   |
| server → client | `changes`  | ordered row changes, optionally tagged with a client txn id                                 |
| client → server | `mutate`   | one client transaction: insert/update/delete                                                |
| server → client | `ack`      | the resulting rows for that txn                                                             |
| server → client | `reject`   | why the txn was refused (the client rolls back)                                             |

The host hands the page its credential in an `init` postMessage, and a fresh
credential later in a `refresh` of the same shape; the page reconnects in
place rather than being reloaded, and with its cursor on the URL that is the
`changes` path.

A v2 page's first render waits on one frame: the server's `hello` carries the
snapshot when the URL named no `since` cursor, and the page marks its
collections ready on it. A reconnect puts `since` on the URL, gets a plain
`hello`, and asks for `changes` as v1 does. A snapshot that would not fit the
frame is left out of the hello and the v1 exchange follows.

## Tests

```sh
bun test test spike
```

Pure modules and the client are tested in `bun test`: the store runs against
`bun:sqlite`, and `test/loopback.ts` joins the real protocol server to the real
client transport through a pair of fake sockets. `test/build.test.ts` and
`spike/` run the real pipeline and the built Applet in Miniflare.

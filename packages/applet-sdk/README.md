# @frockbot/applet-sdk

The SDK a FrockBot Applet is written against: a schema-first Durable Object
server, a TanStack DB client over one real-time socket, a precompiled component
kit on the theme tokens, a linter, and the `applet` CLI.

See [ADR 0022](../../docs/adr/0022-applets-as-instance-packages.md) for why an
Applet's state is a Durable Object facet the kernel owns the lifecycle of, and
`docs/plans/applets.md` §8 for this package's place in the build.

## Entry points

| Import                          | For                                                      |
| ------------------------------- | -------------------------------------------------------- |
| `@frockbot/applet-sdk/server`   | `Applet`, `table`, `t` — the Applet's `server.ts`        |
| `@frockbot/applet-sdk/client`   | `createApplet`, `mount`, `newId` — the Applet's `ui.tsx` |
| `@frockbot/applet-sdk/kit`      | the fourteen components (`src/kit/README.md`)            |
| `@frockbot/applet-sdk/lint`     | the flat ESLint config and the five custom rules         |
| `@frockbot/applet-sdk/protocol` | wire protocol v1, for the kernel and for tests           |

## The CLI

```sh
applet new "Weekly Todos" # scaffold from template/
applet check              # tsc + lint; path:line:col message; non-zero on error
applet build              # dist/{server.js,ui.html,manifest.json}
applet dev                # Miniflare on a local port; prints a URL, opens nothing
```

`applet build` derives `manifest.json`'s tool declarations by mounting the built
`dist/server.js` in Miniflare and calling `health()` — the same question the
kernel asks the facet before it admits a generation, so the manifest cannot
disagree with the code.

**The published CLI runs under Node.** `prepublishOnly` bundles
`src/cli/main.ts` to `dist/cli.mjs`, and the package's `bin` points there. The
Computer's `applets` provisioning phase installs this package and its runtime
once under the shared Computer runtime; an in-place runtime update repairs that
installation when it is missing. An Applet project deliberately has no
`node_modules` of its own. The checker and bundler resolve SDK, React, and
TanStack imports from the shared installation, while project dependency trees
remain reproducible scratch and never enter the durable-root sync.

## What runs where

`server.ts` becomes a single ESM file whose only import is `cloudflare:workers`,
loaded by the kernel's `APPLETS` Worker Loader with no outbound network, and
mounted as a facet under `AppletState`. `ui.tsx` becomes one self-contained HTML
page served from the anonymous artifact origin into a sandboxed iframe, which
receives its theme tokens and a short-lived viewer token through the host's
`init` message and opens exactly one WebSocket back to the facet.

The Cloudflare programming model is not hidden and ADR 0022 says so: an Applet
is a Durable Object with SQLite and hibernating sockets. What the SDK does hide
is every binding name — an author sees `tables`, `tools`, and `this.db`.

## Wire protocol v1

JSON frames, at most 64 KB each, decoded by `src/protocol/` at both ends;
an unknown type, field, or table fails closed.

| Direction       | Frame      | Carries                                                     |
| --------------- | ---------- | ----------------------------------------------------------- |
| server → client | `hello`    | contract, generationId, viewer, tables, revision, cursor    |
| client → server | `hello`    | contract, optional `since` cursor for catch-up              |
| server → client | `snapshot` | every row of every table, plus the cursor                   |
| server → client | `changes`  | ordered row changes, optionally tagged with a client txn id |
| client → server | `mutate`   | one client transaction: insert/update/delete                |
| server → client | `ack`      | the resulting rows for that txn                             |
| server → client | `reject`   | why the txn was refused (the client rolls back)             |

## Tests

```sh
bun test test spike
```

Pure modules and the client are tested in `bun test`: the store runs against
`bun:sqlite`, and `test/loopback.ts` joins the real protocol server to the real
client transport through a pair of fake sockets. `test/cli.test.ts` and
`spike/` run the built Applet in Miniflare for real.

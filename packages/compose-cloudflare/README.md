# `@frockbot/compose-cloudflare`

> Vendored from `tanstack-compose` commit `69163be` on 2026-09-05. FrockBot
> keeps this copy intentionally close to upstream so it can be reviewed and
> migrated independently.

A **host** for [`@frockbot/compose-core`](../compose-core) that runs **plugin source** in a
Cloudflare Dynamic Worker. The client sees an ordinary **plugin instance**; the
written code sees its **stubs** and nothing else — no network, no bindings, no
loader.

Use it when an agent writes plugins and you would rather not run what it wrote
in the same isolate as everything else.

It also ships a **model provider** over a Workers AI binding, and a
chat-completions route for browser clients, so an agent on Cloudflare has a real
model and holds no **credential** to get it. See
[A model, with no credential](#a-model-with-no-credential).

## Installation

```sh
npm install @frockbot/compose-core @frockbot/compose-cloudflare
```

It runs in a Cloudflare Worker on a paid plan and locally under `wrangler dev`.
The pure protocol tests run with Bun; isolate/facet behavior remains covered by
FrockBot's Cloudflare architecture checks.

## Three steps

### 1. Bind a Worker Loader

```jsonc
// wrangler.jsonc
{
  "compatibility_date": "2026-05-01",
  "worker_loaders": [{ "binding": "LOADER" }],
}
```

### 2. Re-export the loopback entrypoint

Stubs reach a hosted plugin as loopback entrypoints minted from your Worker's
own exports, so your entry module has to export the class. One line:

```ts
// src/index.ts
export { ComposeStubLoopback } from "@frockbot/compose-cloudflare";
```

### 3. Name the host on the client

```ts
import { createClient, createStub } from "@frockbot/compose-core";
import { createCloudflareHost } from "@frockbot/compose-cloudflare";

export default {
  async fetch(request: Request, env: Env) {
    const client = createClient({
      hosts: {
        cloudflare: createCloudflareHost({
          loader: env.LOADER,
          compatibilityDate: "2026-05-01",
        }),
      },
      plugins: [{ id: "adder", source, host: "cloudflare", stubs: [logStub] }],
    });
    await client.settled();
    // …
  },
};
```

An entry that names `host: "cloudflare"` runs in an isolate of its own. Every
source entry must name its host; omission is refused rather than silently
falling back to in-process execution.

## What the written plugin sees

The same thing it sees in every host: a module whose default export is setup and
whose other named exports are handlers.

```js
export default async function setup({ id, options, stubs }) {
  await stubs.log(`up as ${id}`);
  return () => {
    /* release what this module holds */
  };
}

export async function add({ a, b }) {
  return a + b;
}
```

`stubs` has exactly the names the entry was granted. There is no `env`, no
`fetch`, no timer that can reach anything, and no way to name another plugin.

## Options

| Option                 | Default                           | What it is                                                     |
| ---------------------- | --------------------------------- | -------------------------------------------------------------- |
| `loader`               | —                                 | the Worker Loader binding                                      |
| `compatibilityDate`    | —                                 | the date every loaded isolate runs under                       |
| `compatibilityFlags`   | none                              | flags for every loaded isolate                                 |
| `limits`               | `{ cpuMs: 200, subRequests: 50 }` | the platform limits set on every load                          |
| `callTimeoutMs`        | `5000`                            | the client-side wall clock on every `setup`, `call` and `stop` |
| `httpTimeoutMs`        | `5000`                            | the wall-clock deadline for one HTTP grant call                |
| `httpResponseMaxBytes` | `1048576`                         | the maximum HTTP response body read through the grant          |
| `name`                 | `'cloudflare'`                    | the name entries use to ask for this host                      |
| `hostId`               | the name                          | which host a loopback belongs to, if you run more than one     |

Outbound network is off unconditionally and is not an option.

The `http` grant accepts only `method`, string-valued `headers`, and a string or
`ArrayBuffer` `body`. It pins requests to the configured service origin,
attaches the service credential inside the host, uses manual redirects and
refuses every redirect response so credentials never follow to another origin.

## A model, with no credential

The package also ships a **model provider** over a Workers AI binding, so an
agent on Cloudflare has a real model and nothing to configure. A binding is not a
secret: there is no key in the plugin list, no environment variable, and nothing
for the page to hold.

### Bind Workers AI

```jsonc
// wrangler.jsonc
{
  "ai": { "binding": "AI" },
}
```

### On the server: the host-level provider

```ts
import { createWorkersAiModel } from "@frockbot/compose-cloudflare";

const provider = createWorkersAiModel({
  binding: env.AI,
  options: { max_tokens: 1024 },
});
```

The provider has only `name` and `stream(request, signal)`. An agent runtime can
register that structural value in its own model registry; the host package has
no dependency on an agent loop. The deployed agent example supplies the small
plugin wrapper under `examples/shared/agent`.

| Option    | Default                     | What it is                                    |
| --------- | --------------------------- | --------------------------------------------- |
| `binding` | —                           | the `AI` binding from `env`                   |
| `model`   | `@cf/zai-org/glm-5.3-flash` | any model with streaming and function calling |
| `name`    | the model                   | the provider's structural name                |
| `options` | none                        | `max_tokens`, `temperature`, sent every step  |

The default model's own `max_tokens` is 256, which is short for an agent — pass
more, as above.

### In the browser: the same agent, over a route

A page cannot hold a binding, so the page's client runs the OpenAI-compatible
provider against your own origin, with no key at all, and the Worker answers it
out of the binding:

```ts
// the Worker
import { handleChatCompletions } from "@frockbot/compose-cloudflare";

if (new URL(request.url).pathname === "/ai/chat/completions") {
  return handleChatCompletions(request, env.AI);
}
```

```ts
// the page
import { openaiModelPlugin } from '@frockbot/compose-agent'

{
  id: 'model',
  plugin: openaiModelPlugin,
  // `credential: null`: this endpoint needs none from the browser.
  options: { model: 'workers-ai', baseUrl: '/ai', credential: null },
}
```

`handleChatCompletions(request, binding, options?)` takes `{ model, cors, stallMs }`.
`model` is the model to run when the body names none. `stallMs` (default 30 000)
is how long the binding may go quiet before the request fails, so a proxy that
loses its upstream cannot hold a turn open forever; `0` waits. `cors` is off by
default:
a page on the same origin needs none, and a route that hands itself to every
origin is a route anyone can spend your inference through.

### Local development

There is no local simulation of Workers AI — inference always runs on
Cloudflare — so `wrangler dev` needs a logged-in account for any route that uses
the binding, and those requests spend the account's allocation (10,000 neurons a
day are free).

## Running the example

```sh
bunx wrangler dev --config packages/compose-cloudflare/wrangler.jsonc
curl 'http://localhost:8787/?a=2&b=3'

# these two need `wrangler login`
curl 'http://localhost:8787/ask?q=say+pong'
curl -X POST http://localhost:8787/ai/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"say pong"}],"stream":true}'
```

`dev/worker.ts` is a loader Worker that starts one written plugin, calls the
handler it registered through a stub, and reports what the plugin logged. It
also exercises the structural provider at `/ask`, while
`/ai/chat/completions` is the route a browser client talks to.

The suite runs against a fake binding and needs no account. The one test that
runs a real model asks for itself by name:

```sh
bunx wrangler login
```

How it all fits together is in [`DESIGN.md`](./DESIGN.md).

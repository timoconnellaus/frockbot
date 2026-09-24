# Plugin build service

The cloud build for Plugins (ADR 0026): a Worker that authorizes and shards, fronting a Cloudflare Container that runs the Plugin SDK's own pipeline. Source in, one module and its manifest out.

```
frockbot-cloudflare (app Worker)
   │  service binding APPLET_BUILD, plus x-frockbot-applet-build-token
   ▼
src/index.ts → src/router.ts  →  shard = fnv1a(id) % APPLET_BUILD_SHARDS
   ▼                              (the Plugin's id, so a check and its publish land warm)
AppletBuildContainer  ×  max_instances 3, standard, sleepAfter 10m, no egress
   ▼  :8080
container/server.ts → container/build.ts → @frockbot/applet-sdk/build/plugin
   ▼
descriptor → typecheck → bundle → describe
```

## The contract

One route, `POST /build`, defined in [`@frockbot/applets/build-contract`](../../applets/build-contract.ts) and imported by both sides:

```
{ version: 1, effectId, id, mode: "check" | "build", files: [{ path, text }] }
→ { status: "built", manifest, module }         // one ESM module and what it exports
| { status: "built" }                           // a passing check
| { status: "failed", stage, diagnostics }      // stage names where it stopped
```

A Plugin is `plugin.ts` beside `plugin.json`, built by `runPluginBuildV1` into one module with no imports. Its manifest — tools, hooks, services, triggers, views, cards and model providers — is read by running the bundle in Miniflare with no outbound network, never by importing it into the container's own process, which holds the service token. The container does not decode `plugin.json` beyond its `id`: the app Worker holds the descriptor decoder and refuses a publish whose descriptor and manifest disagree. `container/build.ts` decodes the manifest before it believes it and holds the module and the manifest to the ceilings a publish stores.

`effectId` is carried, not journalled: a build is pure, so a retry under the same key re-derives the same bytes and the caller's own record is the only one that has to exist. The container holds no storage and no credential — the app Worker keeps the R2 write and the hash verification, so a compromised builder can only return bytes the app then refuses.

Two Turn verbs call it, through the `buildService` seam in `app/plugins/authoring-bot.ts`: `plugin_check` in `mode: "check"`, which stops after the type checker, and `plugin_publish` in `mode: "build"`, which stores the module and asks the User to approve it.

## The rule the hashes keep

There is **one** implementation of the pipeline, `runPluginBuildV1` in `applets/sdk/src/build/plugin.ts`. This service runs it for authored Plugins, and `scripts/build-seeded-plugins.ts` runs it for the Plugins the deployment seeds. A second derivation of the module or its manifest is exactly the thing that would pass its own tests and fail a publish.

For the module's hash to mean anything, the module has to be independent of where it was built. esbuild writes each bundled module's path into the unminified output as a comment, so identical source built in two directories would hash differently — a new R2 object on every publish of unchanged code. `stableModulePaths` (`applets/sdk/src/build/module-paths.ts`) rewrites those comments relative to the Plugin's own directory, and `applets/sdk/test/plugin-build.test.ts` builds the same source from different and symlinked roots to the same bytes.

## Layout

| Path                                                                         | What it is                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/router.ts`                                                              | Token check, decode, shard, forward. Decoding here means a malformed body never starts a container.      |
| `src/index.ts`                                                               | The Container Durable Object and the Worker entrypoint.                                                  |
| `container/build.ts`                                                         | One build: posted files into a temp directory, the Plugin pipeline over it, the ceilings as diagnostics. |
| `container/server.ts`                                                        | Node HTTP glue. Owns the second token check and the one-at-a-time queue.                                 |
| [`@frockbot/applets/build-contract`](../../applets/build-contract.ts)        | The v1 DTOs and decoders both sides import.                                                              |
| [`@frockbot/applet-sdk/build/plugin`](../../applets/sdk/src/build/plugin.ts) | The Plugin pipeline: four named stages over one directory.                                               |

## Checks

```sh
bun run --filter @frockbot/applet-build typecheck
bun run --filter @frockbot/applet-build test
bun run --filter @frockbot/applet-build test:workerd
```

The image is not built by those. To prove the container itself, from the repository root:

```sh
docker build -f apps/applet-build/Dockerfile -t frockbot-applet-build .
docker run --rm -p 8080:8080 -e APPLET_BUILD_TOKEN=local frockbot-applet-build
# then POST /build with the header x-frockbot-applet-build-token: local
```

## Local development

`bun run dev:native` starts this Worker under its own `wrangler dev`, because a service binding resolves only through the dev registry, and mints one `APPLET_BUILD_TOKEN` into both `apps/cloudflare/.dev.vars` and `apps/applet-build/.dev.vars`. `wrangler dev` builds and runs the container image, so it needs Docker; without it the binding reads `[not connected]`, which is what the dogfood stack and the browser end-to-end harness both see.

## Deployment

`release.yml` deploys this Worker on a version tag, **before** the app Worker, because the app's `APPLET_BUILD` binding must resolve. Secret: `APPLET_BUILD_TOKEN`, the same value on both sides. Containers require the Workers Paid plan, and `wrangler deploy` builds the image, so the runner needs Docker.

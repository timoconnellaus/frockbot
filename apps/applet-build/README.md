# Applet build service

The cloud build for Applets: a Worker that authorizes and shards, fronting a Cloudflare Container that runs the Applets SDK's own pipeline.

An Applet used to be built on the User's Computer — the SDK npm-installed on a Sprite, `applet check` and `applet build` run over a mirrored source root, `dist/` pulled back before a publish. That put a Linux VM, an unpinned `latest` install and a file sync on the critical path of "publish my Applet". This service replaced all of it, and the Computer half is now deleted: source in, artifacts out.

```
frockbot-cloudflare (app Worker)
   │  service binding APPLET_BUILD, plus x-frockbot-applet-build-token
   ▼
src/index.ts → src/router.ts  →  shard = fnv1a(id) % APPLET_BUILD_SHARDS
   ▼                              (the Applet's or Plugin's id, so a check and its publish land warm)
AppletBuildContainer  ×  max_instances 3, standard, sleepAfter 10m, no egress
   ▼  :8080
container/server.ts → container/build.ts → @frockbot/applet-sdk/build
   ▼
descriptor → typecheck → lint → bundle → describe        (kind: "applet")
descriptor → typecheck → bundle → describe               (kind: "plugin")
```

## The contract

One route, `POST /build`, defined in [`@frockbot/applets/build-contract`](../../applets/build-contract.ts) and imported by both sides:

```
{ version: 1, effectId, kind: "applet" | "plugin", id, mode: "check" | "build", files: [{ path, text }] }
→ { status: "built", manifest, server, ui }     // an Applet; artifacts absent for a passing check
| { status: "built", manifest, module }         // a Plugin: one ESM module and what it exports
| { status: "failed", stage, diagnostics }      // stage names where it stopped
```

A Plugin (ADR 0026) is `plugin.ts` beside `plugin.json`, built by `@frockbot/applet-sdk/build/plugin` into one module with no imports. Its manifest — tools, hooks, services, triggers — is read by running the bundle in Miniflare with no outbound network, never by importing it into the container's own process, which holds the service token. The container does not decode `plugin.json` beyond its `id`: the app Worker holds the descriptor decoder and refuses a publish whose descriptor and manifest disagree.

`effectId` is carried, not journalled: a build is pure, so a retry under the same key re-derives the same bytes and the caller's own record is the only one that has to exist. The container holds no storage and no credential — the app Worker keeps the R2 write and the hash verification, so a compromised builder can only return bytes the app then refuses.

Two Turn verbs call it, both in `mode: "build"` and both through the `buildService` seam on the Applets host (`app/applets-host/bot.ts`): `applet_check`, which stores the artifacts so its preview URL resolves but records no generation, and `applet_publish`, which goes on to record one. `check` mode carries no artifacts, so neither verb asks for it — a check that answered without a bundle could not offer a page to look at, and would leave the publish to discover a `describe` failure on its own.

## The rule the hashes keep

There is **one** implementation of the pipeline, `applets/sdk/src/build/`, and no second entry point onto it. A second derivation of the bundle — or of `this.tool(...)` by static analysis — is exactly the thing that would pass its own tests and fail a publish, because the kernel admits a generation by comparing the manifest to the mounted facet's own `health()`.

What `container/build.test.ts` asserts is the property that makes one implementation enough: the same source posted to the service and built beside it produces the same manifest hashes.

For that to hold anywhere, the artifact has to be independent of where it was built. esbuild writes each bundled module's path into the unminified output as a comment, so identical source built in two directories used to hash differently — a new R2 object on every publish of unchanged code. `stableModulePaths` in `applets/sdk/src/build/artifacts.ts` rewrites those comments to labels relative to the Applet root and the SDK root.

## Layout

| Path                                                                  | What it is                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/router.ts`                                                       | Token check, decode, shard, forward. Decoding here means a malformed body never starts a container.            |
| `src/index.ts`                                                        | The Container Durable Object and the Worker entrypoint.                                                        |
| `container/build.ts`                                                  | One build: posted files into a temp directory, the SDK pipeline over it, the artifact ceilings as diagnostics. |
| `container/server.ts`                                                 | Node HTTP glue. Owns the second token check and the one-at-a-time queue.                                       |
| [`@frockbot/applets/build-contract`](../../applets/build-contract.ts) | The v1 DTOs and decoders both sides import.                                                                    |
| [`@frockbot/applet-sdk/build`](../../applets/sdk/src/build)           | The pipeline: five named stages over one directory. Nothing else runs it.                                      |

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

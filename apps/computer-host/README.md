# Shared Computer host

The production Computer host of [ADR 0004](../../docs/adr/0004-host-fly-computer-in-cloudflare-containers.md), and the successor to `apps/fly-host-prototype`.

A Bot Durable Object cannot drive a Fly Sprite itself. This Worker is where the Sprites SDK, `SPRITES_TOKEN`, and the WebSocket exec transport live, behind a versioned protocol the Durable Object speaks and a service binding nothing public can reach.

```
frockbot-cloudflare (app Worker)
   │  service binding COMPUTER_HOST, plus x-frockbot-host-token
   ▼
src/index.ts  →  shardKey = fnv1a(userId) % COMPUTER_HOST_SHARDS
   ▼            (userId, never botId: one Computer per User, ADR 0012)
FlyHostContainer  ×  max_instances 3, basic, sleepAfter 10m
   ▼  :8080
container/server.ts  →  container/computer.ts  →  @fly/sprites 0.1.0
   ▼  WebSocket spawn("bash", ["-s"]) + stdin  /  filesystem API
Fly Sprite  frockbot-<sha256(["user", userId])[0..12]>
```

## The rule the 431 taught

The SDK puts a command's argv **and** its environment into the request URL, and Fly answers a ~2.5 KB query with HTTP 431. So nothing large ever travels there: every command is `bash -s`, the script arrives on stdin, `cwd` and `env` are compiled into that script, and file bytes use the filesystem API and no shell at all. The live test proves it with a 19 KB script against a real Sprite.

## Layout

| Path                                                                        | What it is                                                                                                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router.ts`                                                             | Token check, decode, shard, forward. Decoding here means a malformed body never starts a container.                                                         |
| `src/index.ts`                                                              | The Container Durable Object and the Worker entrypoint. Also carries forward the prototype's `ComputerEffectJournal` and its `/v1/effects` route unchanged. |
| `container/computer.ts`                                                     | The whole protocol over one Sprites client: open, exec, files, control, viewer, services, cancel.                                                           |
| `container/server.ts`                                                       | Node HTTP glue. Owns cancellation: `req.on("close")` aborts the effect.                                                                                     |
| `container/fake-sprites.ts`                                                 | The fake `SpritesClient` the tests drive, including chunk-split output.                                                                                     |
| [`@frockbot/computer-host-protocol`](../../packages/computer-host-protocol) | The v1 DTOs and decoders both sides import.                                                                                                                 |
| [`@frockbot/computer-host-runtime`](../../packages/computer-host-runtime)   | The Computer's on-Sprite layout and shell scripts, shared with `@frockbot/plugin-fly-sprite`.                                                               |

## Checks

```sh
bun run --filter @frockbot/computer-host typecheck
bun run --filter @frockbot/computer-host test
```

The live test needs Docker and `SPRITES_TOKEN` in a gitignored `apps/computer-host/.dev.vars` or `apps/cloudflare/.dev.vars`. It builds the production image, runs it, and drives a real disposable `frockbot-test-<runId>-…` Sprite, asserting the large-script regression, streaming, cancellation, a filesystem round-trip, and reconstruction after a container restart. The Sprite is deleted in a `finally` and every leftover `frockbot-test-` Sprite is swept:

```sh
bun run --filter @frockbot/computer-host test:live
```

## Deployment

`release.yml` deploys this Worker on a version tag, after the bundler and **before** the app Worker, because the app's `COMPUTER_HOST` binding must resolve and a stale host must not serve a current app. Secrets: `SPRITES_TOKEN` and `COMPUTER_HOST_TOKEN`. Containers require the Workers Paid plan, and `wrangler deploy` builds the image, so the runner needs Docker.

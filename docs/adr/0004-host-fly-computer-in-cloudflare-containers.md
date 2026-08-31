---
status: accepted
---

# Host the Fly Computer adapter in shared Cloudflare Containers

FrockBot will run the Fly Sprites Computer adapter as a shared, non-authoritative backend service in Cloudflare Containers rather than inside each Bot Durable Object. A real Workerd compatibility test proved that bounded command execution works but file I/O through `@fly/sprites` fails because its HTTP exec protocol relies on response chunk boundaries that Workerd does not preserve; a Node-based container retains the Cloudflare operational boundary while providing a general-purpose runtime for the SDK.

## Considered options

- **Per-Bot Durable Object:** keeps the adapter beside orchestration, but cannot reliably support the provider-neutral Computer interface with the current Sprites HTTP protocol.
- **Per-Bot container:** maximizes isolation but duplicates cold starts and cost even though untrusted execution is already isolated in each Bot's Sprite.
- **One permanent global container:** is sufficient for a prototype but creates a bottleneck and broad failure domain.
- **Shared container service:** chosen. One logical service may use a single container initially and shard or scale its containers later without changing the Computer interface.

## Status

Implemented and now the production path, on both sides of the seam. `apps/computer-host` is the host. `packages/computer-host-protocol` is the versioned seam both sides decode, and `packages/computer-host-runtime` holds the Computer's on-Sprite layout and scripts once, shared with `@frockbot/plugin-fly-sprite`.

`@frockbot/plugin-fly-sprite` is now a thin client of that host: `ComputerHostClient` speaks the v1 protocol over the app Worker's `COMPUTER_HOST` service binding, and `FlySpriteComputer` holds no Sprites SDK, no token, and no provisioning sequence. `SPRITES_TOKEN` survives on the app Worker as one thing only — the answer to "has this deployment a Computer at all" — and with it unset the Computer card still reads "Set SPRITES_TOKEN to attach a computer". A viewer session and the human-takeover lease are reachable from a Bot Durable Object for the first time, because both need the Sprite's URL and its `flock` and neither was reachable from workerd.

`apps/fly-host-prototype` is deleted. It ran the provider _inside_ its container against the SDK — the arrangement this ADR replaced — so it could not survive the provider becoming a client. What it proved is recorded below and in `apps/computer-host/live-test.ts`, which drives the same claims against a real disposable Sprite from the production image.

## Consequences

Each Bot Durable Object remains authoritative for admission, ordering, cancellation, durable effect intent, idempotency, and reconciliation. It calls the internal service through narrow versioned DTOs carrying Bot identity, assignment generation, operation data, and an effect identifier. A host-side Durable Object journals intent and normalized outcomes so a retried effect replays or remains explicitly unresolved instead of executing twice. The container resolves `SPRITES_TOKEN` server-side, holds no canonical Bot state, and treats process loss or restart as normal. The production host and its live test cover command execution, streaming, file operations, cancellation, adapter reconstruction, and cleanup without changing the Bot Agent loop.

## What the live measurements changed

Two failures were measured against real infrastructure, and together they decide the shape of the host rather than merely its location.

**HTTP 431, and it is not a Workerd problem.** A live probe with a real token reached `FlySpriteComputer.provisionRuntime` and failed with `APIError: API error (status 431)` — Request Header Fields Too Large. `execFileHTTP` appends every argv element to the request URL as `cmd=`, and the ~1.9 KB provisioning script (~2.7 KB base64-encoded) exceeds Fly's limit. Measured directly against the Sprite with curl: a short `cmd` answers 200, a ~2.5 KB `cmd` answers 200, the provisioning script answers 431. This is a server-side limit and is independent of the runtime making the call, so **the provisioning path could not have worked from any runtime as written** — not from Workerd, not from Node, not from a laptop. The Sprites SDK's WebSocket `spawn` puts the command's environment into the same URL, so environment variables are bounded by the same limit.

The consequence is a rule, not a workaround: **nothing large travels on a command's argv or environment.** Every command the host runs is `bash -s` with a two-element argv, the script arrives on the command's stdin, and a requested `cwd` and `env` are compiled into that script as `cd` and `export` lines. File bytes never pass through a shell at all; they use the Sprites filesystem API. The host's live test sends a 19 KB script over stdin to a real disposable Sprite and asserts exit 0, so the regression has a standing proof.

**The chunk-boundary framing bug is real but was never reached.** `execFileHTTP` parses one `reader.read()` chunk as one protocol frame and throws when a transport coalesces or re-splits the body. It sits one layer behind the 431 and was therefore never exercised by the product. It is also now unreachable: the host uses the SDK's WebSocket `exec`, which is available from Node and not from Workerd, and its own answers are NDJSON, where the frame boundary is a newline the reader finds and a transport chunk means nothing.

## Pins and the standing bill

A third defect in the same 0.x, measured on 2026-08-31 against a real Sprite from the production image: `WSCommand`'s keepalive declares a healthy connection dead after 45 seconds without an **inbound message**, and it never sends a ping of its own — the code says so ("the server-side handles keepalive; we just track activity"). A command that is merely quiet is therefore indistinguishable from a command whose connection died. `/v1/computer/open` runs the provisioning document, whose `apt-get` phase is silent for minutes, so a first `open` on a cold Computer fails reproducibly with `provider-unavailable: Computer command failed: WebSocket keepalive timeout`. Nothing else is affected: the host's live test — a 19,633-byte script over stdin, streaming, cancellation, a filesystem round-trip, and container restart with adoption — passes end to end, because none of it is silent for 45 seconds. The fix belongs to the host's provisioning path (a heartbeat on the wire while a long phase runs), not to the protocol or the client, and is not yet made.

`@fly/sprites` is pinned to exactly `0.1.0` — a 0.x with the framing bug above — and is loaded in exactly two places, `apps/computer-host` and `packages/computer-host-runtime`. Containers require the Workers Paid plan; the host runs `basic` instances with `max_instances: 3`, `sleepAfter: "10m"`, and two warm shards, so a first call after an idle period pays a cold start rather than the account paying for permanent warmth. Requests are routed by **userId** (ADR 0012), so every Bot of one User reaches the one container that holds that Computer's display-slot registry and `flock`-serialized takeover lease. The host Worker must be deployed before the app Worker on every release, or the app's `COMPUTER_HOST` service binding resolves to a stale image.

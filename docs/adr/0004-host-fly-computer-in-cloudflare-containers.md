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

## Consequences

Each Bot Durable Object remains authoritative for admission, ordering, cancellation, durable effect intent, idempotency, and reconciliation. It calls the internal service through narrow versioned DTOs carrying Bot identity, assignment generation, operation data, and an effect identifier. A host-side Durable Object journals intent and normalized outcomes so a retried effect replays or remains explicitly unresolved instead of executing twice. The container resolves `SPRITES_TOKEN` server-side, holds no canonical Bot state, and treats process loss or restart as normal. The production host and its live smoke cover command execution, streaming, file operations, cancellation, adapter reconstruction, and cleanup without changing the Bot Agent loop.

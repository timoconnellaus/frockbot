---
status: accepted
---

# Separate Bot registration from Bot materialization

A Bot exists when the Flock Package atomically registers it in the User Durable Object, while its Bot Durable Object settings and sheep identity materialize idempotently from that immutable registration seed on first use. This rejects arbitrary `?bot=` lazy creation, keeps User ownership enumerable and authoritative, avoids a distributed creation transaction, and lets every Bot-scoped path prove membership before writing Bot state.

## Considered options

- **Keep lazy Bot creation:** rejected because any syntactically valid URL can create durable state and there is no authoritative Bot list.
- **Provision User and Bot Durable Objects synchronously:** rejected because it creates a distributed transaction and recovery saga despite creation having no external effect.
- **Register first, materialize from a seed:** chosen because directory admission is atomic, duplicate-safe, and survives disconnect or eviction while Bot-local state remains authoritative after materialization.

## Consequences

The User directory stores bounded registration seeds and receipts, not mutable Bot projections. Bot profile and sheep updates remain Bot-owned. Every Bot operation must resolve User membership before touching Bot storage, and clients must carry an explicit Bot ID rather than relying on hidden transport state.

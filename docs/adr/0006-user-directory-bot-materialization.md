---
status: accepted
---

# Separate Bot registration from Bot materialization

A Bot exists when the Flock Package atomically registers it in the User Durable Object. Its Bot Durable Object settings and sheep identity materialize idempotently from that immutable registration seed on first use. Mutable active/archived state is not added to the seed: the Flock User Contribution stores a separate directory lifecycle projection and coordinates archive/restore, while the Bot owns its lifecycle marker and command receipts.

## Considered options

- **Keep lazy Bot creation:** rejected because any syntactically valid URL can create durable state and there is no authoritative Bot list.
- **Mutate or remove registration records on archive:** rejected because it would conflate immutable creation input with lifecycle state and make restore lossy.
- **Keep an immutable seed plus separate lifecycle projections:** chosen because creation stays atomic and duplicate-safe while archive/restore can reconcile across User and Bot authorities.

## Consequences

The registration seed continues to snapshot only initial profile, model, and sheep identity. Archive first records durable User intent, asks the Bot to apply an idempotent lifecycle command, reads the Bot marker after an uncertain response, and then updates the User projection; alarms resume unfinished operations. Archived Bots remain registered and preserve history, settings, and Assignments, but reject new work and mutations. Archive waits for active and reconciling work to settle. Every Bot operation still proves User membership before touching Bot storage.

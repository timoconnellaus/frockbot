---
status: accepted
---

# Record `catalog` as a third Package provenance

A Package admitted from the remote Catalog records provenance `catalog`, distinct from `first-party` (compiled into the running application) and the User and Bot provenances of authored Packages. A Catalog entry may name either a reviewed Package that ships with FrockBot or an immutable, hash-addressed bundle published by a User from authored code.

## Consequences

Provenance names where availability came from; the entry form decides the execution host. A reviewed first-party entry still resolves to compiled-in code. A code-carrying `catalog` entry stores an exact content hash and Bot-isolate manifest and therefore runs in a Dynamic Worker, because its recorded provenance is not first-party. `catalog` is not a fourth host.

The User Durable Object records the Catalog generation and exact bundle hash on installation, while the Bot Durable Object records the bundle as a `catalog` Composition member with its artifact reference. Both refuse a mismatch. An installation with no recorded provenance remains `first-party`, so every row written before the Catalog existed keeps its meaning.

This extends the original Slice 1 decision, which allowed only the reviewed-first-party entry form. Delisting affects the mutable platform pointer only and cannot revoke an already-installed immutable member.

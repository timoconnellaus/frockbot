---
status: accepted
---

# Record `catalog` as a third Package provenance

A Package admitted from the remote Catalog records provenance `catalog`, distinct from `first-party` (compiled into the running application) and the User and Bot provenances of authored Packages: its metadata is remote and immutable, while the code it names is still a reviewed Package that ships with FrockBot.

## Consequences

The isolate rule is untouched, because a Catalog entry carries no code: it is manifest-shaped data pinned to an immutable, content-addressed generation, and its executing Package remains first-party. Provenance therefore stays honest — an installation names where its availability came from — without `catalog` becoming a fourth execution host. An installation with no recorded provenance is `first-party`, so every row written before the Catalog existed keeps its meaning.

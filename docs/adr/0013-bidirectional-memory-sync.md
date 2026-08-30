---
status: proposed
---

# Synchronize durable Workspace roots with object storage, with Memory single-writer

FrockBot will synchronize every declared durable root of the Workspace bidirectionally with object storage (R2) through a FUSE mount on the Computer: a write on the Computer becomes an object generation, and a write to object storage becomes visible on the Computer. Memory roots are the exception: the Memory Package is their only writer, it writes object storage directly, and the Computer sees Memory read-only, so the Agent loop never needs the Computer awake to use Memory and Memory never has write conflicts. This matches GrokBot, where memory is mutated only through `update_state`.

## Considered options

- **Object storage canonical, Workspace is a cache:** never blocks a Turn, but ordinary file edits on the Computer are second-class and can be lost if the cache is evicted before upload.
- **Workspace canonical, object storage a mirror:** natural for shell work, but a Turn that needs fresh memory must wake the Computer, and mirror lag serves stale memory.
- **Durable Object SQLite canonical, files a projection:** strongest transactions, but memory stops being files the Bot and User can read with ordinary tools.
- **Bidirectional for durable roots, single-writer for Memory:** chosen. The Bot's file tools and the Memory Package see one set of files; Skills and working files can be edited from either side with every write a durable generation; Memory has one writer and therefore no conflicts.

## Consequences

Bidirectional sync of non-Memory roots has no single writer, so the constitution requires that writes be segregated by writer, that every write produce a generation, and that a write which would overwrite a generation its writer has not seen be preserved as a conflicting generation and surfaced; last-writer-wins is prohibited. The concrete mechanism is object-storage conditional writes (`If-Match` on the object's ETag) from the Memory Package and from the Computer-side sync agent, with a losing write stored under a conflict suffix and recorded in the Bot's Durable Object; it must be proven under concurrent Computer and Package writes before Memory ships. Memory has a Bot root per Bot and a User root shared by the User's Bots. Indexes and embeddings are derived from the files and rebuildable. Prior art in zerobsai proves the R2 memory layout with hash sidecars and the tigrisfs FUSE mount separately; joining them is new work, and FUSE latency means bundlers and installers must not run against the mount.

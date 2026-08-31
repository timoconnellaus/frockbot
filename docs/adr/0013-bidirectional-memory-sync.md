---
status: proposed
---

# Synchronize durable Workspace roots with object storage, with Memory single-writer

FrockBot will synchronize every declared durable root of the Workspace bidirectionally with object storage (R2): a write on the Computer becomes an object generation, and a write to object storage becomes visible on the Computer. The transport is a backend sync agent driving the Computer through the provider, not a FUSE mount on the Computer — see **Mechanism** for why a mount cannot satisfy the writer, conflict, and secret rules this ADR is written to keep. The FUSE alternative was studied against a working Cloudflare demo in `docs/research/fuse-on-r2.md` and set aside on 2026-08-31. Memory roots are the exception: the Memory Package is their only writer, it writes object storage directly, and the Computer sees Memory read-only, so the Agent loop never needs the Computer awake to use Memory and Memory never has write conflicts. This matches GrokBot, where memory is mutated only through `update_state`.

## Considered options

- **Object storage canonical, Workspace is a cache:** never blocks a Turn, but ordinary file edits on the Computer are second-class and can be lost if the cache is evicted before upload.
- **Workspace canonical, object storage a mirror:** natural for shell work, but a Turn that needs fresh memory must wake the Computer, and mirror lag serves stale memory.
- **Durable Object SQLite canonical, files a projection:** strongest transactions, but memory stops being files the Bot and User can read with ordinary tools.
- **A FUSE mount of the bucket on the Computer:** the shape the prior art has, and the shape this ADR first proposed. Rejected once implemented against the rules: it needs a bucket credential on the Workspace, it cannot record a writer, and it is last-writer-wins.
- **Bidirectional for durable roots, single-writer for Memory:** chosen. The Bot's file tools and the Memory Package see one set of files; Skills and working files can be edited from either side with every write a durable generation; Memory has one writer and therefore no conflicts.

## Mechanism

**Object storage.** Implemented in `packages/workspace-store` as
`createObjectWorkspaceFilesV1`, with the generation ledger in the owning
Durable Object (`packages/kernel-do/src/workspace-generations.ts`). A
durable-root file is the object
`workspace/<workspaceRootKeyV1(root)>/<relative>`. Every write is conditional:
the caller's `expectedGenerationId` is mapped to the ETag the Durable Object
recorded for that generation and sent as `If-Match`, and
`expectedGenerationId: null` — the writer asserting the file does not exist —
is sent as `If-None-Match: *`. A write whose precondition fails is not retried
and not merged: its bytes are stored under
`workspace/<rootKey>/<relative>.conflict/<generationId>`, its generation is
recorded in the Durable Object with `conflictsWith` naming the generation that
holds the file, and the caller receives `{ status: "conflict", current,
preserved }`. Deleting a file removes the object and records a tombstone
generation, because object storage forgets a deleted key and the tombstone is
then the only durable evidence of who removed it. The store has three surfaces
and nothing accepts two of them: `"kernel"` refuses every Memory root,
`"memory"` is the Memory Package's single-writer seam, and `"sync"` belongs to
the Computer-side agent below.

**The Computer side is an agent, not a FUSE mount.** The prior art
(`docs/research/zerobsai-memory-sandbox.md`) mounts R2 into the sandbox with
tigrisfs; FrockBot does not, for three reasons that are constitutional rather
than aesthetic. A mount needs object-storage credentials inside the Computer,
and "No secret lives on the Workspace except the User's browser profile". A
`write(2)` carries no writer, so a mount cannot satisfy "every write to a
durable root records its writer". And a filesystem write has no `If-Match` and
no losing-writer branch, so a mount is last-writer-wins by construction —
the one rule this ADR names as prohibited. FUSE latency, which forbids running
bundlers and installers against the mount, is then a fourth reason rather than
the deciding one.

**The agent.** `packages/plugin-fly-sprite/src/sync.ts` implements
`createWorkspaceRootSyncV1`, which reconciles each declared root through two
narrow seams: `WorkspaceFilesV1` for object storage (surface `"sync"`), and
`ComputerSyncSurfaceV1` for the Computer, implemented over the Sprite's storage
exec path by `FlySpriteSyncSurface`. It runs in the backend, where the
credentials and the generation ledger already are, so the object-storage side
keeps serving Memory and Skills with the Computer hibernated. Per root it
pushes, then pulls. A file whose bytes no longer match its generation sidecar —
or which has no sidecar, because a shell wrote it — is pushed with
`expectedGenerationId` set to the generation that sidecar last saw, so the
store's conditional write decides it; a loser is preserved by the store under
its conflict key, kept on the Computer under `.frockbot-sync/conflicts/`, and
returned in the sync report. A store generation the Computer has not got is
materialized at its mount path with its sidecar, so `generationOf` there
answers with the writer the store recorded rather than `unattributed`. Memory
roots are pull-only: a Memory file changed or removed on the Computer is never
pushed, it is restored. A delete on either side becomes a recorded removal on
the other: a Computer-side delete leaves `.frockbot-sync/tombstones/<rel>`
naming the generation it superseded, and a store-side delete removes the file
and leaves the same record, so neither side ever reads an absence as a file it
never had.

**Writer attribution and effects.** A file with no sidecar is pushed with the
writer the Computer session recorded for that tenant — the tenant's Bot, during
that Bot's Turn — and `{ kind: "unattributed" }` otherwise. The `"sync"`
surface is the only one that accepts an `unattributed` writer, and never on a
Memory root: the alternative is losing a durable-root file at the next image
rebuild, and the mirrored file carries no authority, because
`isLoadableSkillSourceV1` refuses it. Every push records intent against a
deterministic effect id before the write — in the Bot's Durable Object through
the injected `WorkspaceSyncEffectsV1` where one is reachable, and otherwise in
the Workspace, which § Durable effects allows. Connections to the Computer drop
on every pause, so a push that never reported back is ordinary: the next run
finds the unsettled intent, reads what the store actually holds, and adopts
that generation instead of writing a second one.

**On the Sprite.** One provider-declared service,
`frockbot-workspace-sync`, holds no credential and makes no network call: it
watches the durable roots and bumps a change signal, so the agent can tell
"something changed while I was away" from "nothing to do". It is a declared
service because "Only Computer-provider-declared services may be reattached;
other processes are assumed dead after a cold pause."

## Consequences

Bidirectional sync of non-Memory roots has no single writer, so the constitution requires that writes be segregated by writer, that every write produce a generation, and that a write which would overwrite a generation its writer has not seen be preserved as a conflicting generation and surfaced; last-writer-wins is prohibited. The concrete mechanism is object-storage conditional writes (`If-Match` on the object's ETag) from the Memory Package and from the Computer-side sync agent, with a losing write stored under a conflict suffix and recorded in the Bot's Durable Object; it must be proven under concurrent Computer and Package writes before Memory ships. Memory has a Bot root per Bot, a User root shared by the User's Bots, and a Project root per joined Project; the shared roots are sharded per writing Bot (`by-agent/<botId>/` as in GrokBot) so single-writer holds per file even though the tier is shared. Indexes and embeddings are derived from the files and rebuildable. Prior art in zerobsai proves the R2 memory layout with hash sidecars and the tigrisfs FUSE mount separately. The mount is not what FrockBot built — see **Mechanism** — so the FUSE latency rule survives only as a general one: nothing `node_modules`-shaped belongs on a network-backed durable root.

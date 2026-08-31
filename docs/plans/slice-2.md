# Plan: Slice 2 — Computer per User, Skills, Memory

## Status

steps 0, 1, 2, 3a, 3b and 3 landed (the shared Workspace contract; one
Computer per User; the Skills loader; the object-storage Workspace store; the
Computer-side durable-root sync; the Memory Package). What remains of slice 2
is wiring the sync to a production caller and deleting the retired
`memoryWriter` seam.

## Resolved decisions

- **W1** the shared Workspace file-access contract lives in
  `packages/kernel-contracts/src/workspace.ts` and is landed **before** any of
  the three steps below, so no step invents its own root, path, writer, or
  generation type.
- **W2** a durable root is identified by kind and owner (`WorkspaceRootV1`),
  never by an absolute path on the Computer. Mount paths are a Computer
  Package concern and appear only in `WorkspaceLayoutV1`.
- **W3** writer provenance for a durable-root write reuses the constitution's
  one provenance vocabulary — first-party, User, Bot — as `WorkspaceWriterV1`.
  It is not a second provenance type; `PackageProvenanceV1` in
  `@frockbot/kernel-composition` names the same kinds for a Package artifact
  and cannot be imported into `kernel-contracts` (the dependency runs the other
  way). The two must stay in step.
- **W4** a generation carries both identifiers the kernel already uses: a
  DO-minted, sortable `generationId` and a sha-256 `contentHash`. Ordering
  needs the first; conflict detection and rebuildable indexes need the second.
- **W5** Memory roots reach the kernel only as `WorkspaceMemoryProjectionV1`
  (`= WorkspaceReadsV1`). There is no write method to call and no flag to flip.
- **W6** each step keeps its `plugin-shell` backend changes in its own
  `backend-<area>.ts` — `backend-computer.ts`, `backend-skills.ts`,
  `backend-memory.ts` — and **not** in `backend.ts`. Three parallel steps
  editing one 2500-line file is the one merge conflict this plan can avoid by
  construction.

## Step 0 — the shared contract (landed)

**Goal.** One contract every later step consumes, so the three can proceed in
parallel.

**Owns.** `packages/kernel-contracts/src/workspace.ts` (+ its test),
`packages/computer-core/src/core.ts` types only.

**Exports.** `WorkspaceRootV1`, `WorkspacePathV1`, `WorkspaceWriterV1`,
`WorkspaceGenerationV1`, `WorkspaceReadsV1`, `WorkspaceFilesV1`,
`WorkspaceMemoryProjectionV1`, `SkillSourceV1`, `isLoadableSkillSourceV1`, and
their decoders; `ComputerIdentityV1`, `ComputerTenantV1`, `WorkspaceLayoutV1`.

---

## Step 1 — Computer per User (landed)

**Goal.** One Computer is provisioned per User, with each Bot a tenant on it,
per ADR 0012. Replaces the per-Bot Sprite and the separate User storage Sprite.

**Consumes.** `ComputerIdentityV1` and `ComputerTenantV1` as the provisioning
key and the caller; `WorkspaceLayoutV1` and `WorkspaceRootDeclarationV1` to
declare the durable roots the provider guarantees; `WorkspaceRootV1` to name
each declared root; `WorkspaceFilesV1` as the shape the Computer's file surface
must satisfy for non-Memory roots.

**Owns.** `packages/plugin-fly-sprite/src/*` (provisioning, the Sprite name
derivation, the `/home/box` layout, per-Bot directories and displays),
`packages/computer-core/src/core.ts` beyond the types Step 0 added — in
particular splitting `ComputerRegistry.assign`/`open` and
`ComputerProvider.open` along `ComputerIdentityV1` + `ComputerTenantV1`, and
retiring the deprecated `ComputerTarget` alias — plus
`packages/plugin-computer/src/*` and `packages/plugin-shell/src/backend-computer.ts`.

**Per-Bot assumptions unpicked** (all were function-signature-level, so Step 0
left them alone; Step 1 removed all four):

- `ComputerRegistry.assign/assignment/open` take a `ComputerTarget` and key the
  assignment map by `userId:botId`, so two Bots of one User get two
  assignments and two generations.
- `ComputerProvider.open(target, …)` receives the Bot, so a provider cannot
  distinguish "provision the Computer" from "attach this tenant".
- `flySpriteNameForTarget` (`packages/plugin-fly-sprite/src/provider.ts`)
  derives one Sprite name per (User, Bot) pair.
- `ComputerWorkspace.openDirectory({ namespace, scope, durability })` names a
  root by an untyped `namespace` string plus a `"bot" | "user"` scope, which is
  the pre-contract spelling of `WorkspaceRootV1`.

**What each became.**

- `ComputerRegistry.assign/assignment/open` take `ComputerIdentityV1` and, for
  `open`, a `ComputerTenantV1`. The assignment map is keyed by User alone.
- `ComputerProvider.open(identity, tenant, assignment, options)` — the provider
  can tell "provision the Computer" from "attach this tenant".
- `flySpriteNameForTarget` and `flySpriteNameForUserStorage` are gone, replaced
  by `flySpriteNameForComputer(identity)`: one Sprite per User, no separate User
  storage Sprite. The browser profile is the shared `/home/box/chrome-profile`.
- `openDirectory` is deleted. `ComputerWorkspace` now _is_ `WorkspaceFilesV1`
  plus its `WorkspaceLayoutV1`; `ComputerTarget` and `ComputerTargetV1` are
  deleted with it.

**Deliberately left for Step 3.** The Workspace presents Memory roots read-only
through the kernel-consumed surface, but the ADR 0013 durable-root R2 sync did
not exist, so the Memory Package still wrote the Computer directly through one
named seam, `ComputerWorkspace.memoryWriter`. Step 3b retired it: it refuses
every call, and it is deleted once nothing names it.

**Where constitution and code still disagree.** "Every write to a durable root
records its writer" holds for every write that goes _through_ the Workspace
file surface, which records a generation sidecar beside the file. A shell
command on the Computer — `computer_exec`, an installer, the Bot's own editor —
can still create a file in a durable root without touching that surface, so no
sidecar exists and nothing recorded who wrote it. Such a file is answered as
`{ kind: "unattributed" }`: it is visible, listable and readable data, it can
be overwritten by an authorized writer, and it is never loaded as an
instruction, because `isLoadableSkillSourceV1` refuses it. It was previously
attributed to the User whose Computer it is, which was a claim the Computer
could not support and a hole in the instruction boundary — the User is a writer
whose Skills _are_ loadable, so any Bot with a shell could drop a `SKILL.md`
into another Bot's instruction root and have it loaded. `unattributed` is a
reader's answer only: a `write` or a `delete` that names it is refused. Closing
the gap properly — recording a writer for every file however it arrives — is
the Computer-side sync agent's job under ADR 0013.

**Tests that gate.** Two Bots of one User resolve to one Computer and one
provider Sprite; each tenant sees its own directory and display; a Bot reads
another Bot's Workspace file (organizational separation, not a boundary); an
instruction root and a Memory root of a _different_ Bot are refused a write;
`plugin-fly-sprite`'s existing tests still pass.

---

## Step 2 — Skills loader

**Goal.** The kernel loads a Bot's Skills as instructions, and only those.
Turns the `it.todo` in `packages/architecture-checks/src/turn-boundaries.test.ts`
into a real test.

**Consumes.** `SkillSourceV1`, `LoadableSkillSourceV1`,
`isLoadableSkillSourceV1`, `WorkspaceInstructionPathV1`, `WorkspaceReadsV1`
(the loader reads; it never writes), `WorkspaceGenerationV1` (the exact Skill
generation each Turn used must be reconstructable).

**Owns.** the Skills Package (`packages/plugin-skills/`), the prompt-assembly
wiring in `packages/plugin-prompt/`,
`packages/plugin-shell/src/backend-skills.ts`, and the conversion of the
`it.todo` in `turn-boundaries.test.ts`.

**Does not own.** `isLoadableSkillSourceV1` itself, or any second opinion about
which roots are loadable. A Skill that the predicate refuses is not loaded, and
the loader has no override.

**Tests that gate.** A Skill under the Bot's own instruction root written by
the Bot or its User is loaded; one written by a first-party Package, by another
Bot, or by another User is not; a file under a Memory or Package-declared root
is never loaded even when its name looks like a Skill; the session event log
records the Skill generation the Turn used; an edit is visible on the next
admitted Turn and not before.

### Landed

`packages/plugin-skills` is a first-party Package with one runtime
Contribution. What it does:

- **Format.** GrokBot's `SKILL.md` (`docs/research/grokbot-computer.md` §2.8):
  a `---` frontmatter fence carrying `name` and `description`, then a Markdown
  body. `packages/plugin-skills/src/skill-md.ts` reads a deliberately minimal
  frontmatter grammar — flat `key: value` lines, optionally quoted, no nesting
  — and refuses anything else rather than partially parsing untrusted content
  into a system prompt. Unknown keys (`license`, `metadata`, …) are read and
  ignored, so a pi or Claude Skill directory is portable in either direction.
  Bounds: 64 KiB per file, 64-character `name`, 1024-character `description`,
  200 Skills per catalog.
- **Loading.** `loadSkillCatalogV1` enumerates the Bot's `bot-instructions`
  root through the injected `WorkspaceReadsV1`, treats any `*/SKILL.md` as a
  candidate, and filters with `isLoadableSkillSourceV1`. The writer of record
  is the one the _generation_ carries, never one a caller supplies. A refusal
  is a declared variant on the catalog, never a throw.
- **Prompt shape.** Progressive disclosure, as GrokBot and pi do it: the
  catalog goes into the system prompt each Turn as `<agent_skills>` with each
  Skill's path and description; bodies never do. `skill_load` discloses one
  body on demand, and only for a Skill _this Turn_ actually loaded.
- **Self-modification.** `skill_write` renders a `SKILL.md` into
  `skills/<slug>/SKILL.md` under the Bot's own instruction root through
  `WorkspaceFilesV1`, with `{ kind: "bot", botId, sessionId, turnId, runId }`
  provenance, recording `skill/write-intent` before the write and
  `skill/written` after it.
- **Durable visibility.** Three new session events —`skill/injected`,
  `skill/write-intent`, `skill/written` — with decoders in
  `packages/kernel-contracts/src/types.ts`. `skill/injected` names every loaded
  Skill with its `generationId` and `contentHash`, and every refusal with its
  reason, once per Turn at its first step.
- **Hibernation seam.** The loader reaches the Workspace only through
  `WorkspaceReadsV1`/`WorkspaceFilesV1`; it holds no Computer type and makes no
  Computer call. `packages/plugin-shell/src/backend-skills.ts` is the Durable
  Object's half: it builds the host from a `WORKSPACE_FILES` binding and
  returns `undefined` when that binding is absent, so the Package is simply not
  mounted rather than reading instructions from a second store it invented.
  **That binding does not exist yet** — Step 1 owns the Workspace file surface
  and Step 3 owns the durable-root sync that backs it from object storage — so
  no production Turn loads a Skill until one of them lands.

**Quota, decided.** `plugin-authoring`'s `AuthoringQuotaConfigV1` does not fit:
its limits are artifact source size, retained _Composition_ generations, and a
daily authored-generation rate reserved in the User Durable Object against an
authoring `effectId`. A Skill produces no artifact and no Composition
generation, and reserving a daily unit for editing a Markdown file would lock a
Bot out of its own instruction root for the rest of the day. What bounds a
Skill is Workspace disk, so `packages/plugin-skills/src/quota.ts` declares two
limits — 200 Skills per Bot, 64 KiB per Skill — checked against what the root
already holds, which makes a resumed Turn that rewrites the same Skill free.
They live in the Package rather than in durable per-User configuration until
the durable-root sync exists to make Workspace disk measurable; that gap is
recorded in the **Open** list of `docs/architecture-checks.md`.

---

## Step 3 — Memory Package

**Goal.** The Memory Package is the single writer of Memory roots, writing
object storage directly, per ADR 0013. Memory works while the Computer is
hibernated.

**Consumes.** `WorkspaceMemoryRootV1` to name the two Memory roots;
`WorkspaceMemoryProjectionV1` for what the kernel and the Computer see;
`WorkspaceWriterV1` and `WorkspaceGenerationV1` for every write it records;
`workspaceRootAcceptsKernelWriteV1` for the refusal at the Workspace seam.

**Owns.** `packages/plugin-memory/src/*` (the object-storage writer, the
generation records in the owning Durable Object, conditional `If-Match`
writes and conflict preservation) and
`packages/plugin-shell/src/backend-memory.ts`.

**Does not own.** The rule that Memory contains no secrets and no credential
references — that is this Package's policy to enforce, and it is _only_ here:
`kernel-contracts` deliberately declares nothing about it, because the kernel's
file contract carries bytes and cannot classify them.

**Tests that gate.** Memory is readable and writable with no Computer interface
call; a Workspace write into a Memory root is rejected at runtime; conflicting
Workspace and object-storage writes to a non-Memory durable root both survive
as generations and are surfaced; indexes rebuild from the files.

### Step 3a — object-storage Workspace store (landed)

**Status.** Landed, ahead of the rest of Step 3, as the shared foundation the
Memory Package and the Computer-side durable-root sync both consume.

**What it is.** `packages/workspace-store` implements `WorkspaceFilesV1` over
object storage. It is not kernel code — it is an implementation, and it imports
`@frockbot/kernel-contracts` and nothing else.

- `createObjectWorkspaceFilesV1({ bucket, generations, clock, owner, surface })`
  → `WorkspaceFilesV1`.
- `bucket` is `ObjectBucketV1`, a structural interface over R2 declared in the
  package (`get`/`head`/`put`/`delete`/`list`, with `onlyIf` conditional
  semantics on `put` and a `null` answer for a failed precondition). A Bun test
  uses `createInMemoryObjectBucketV1`; workerd uses the real R2 adapter in
  `apps/cloudflare/src/workspace.ts`.
- `generations` is `WorkspaceGenerationsV1`, declared in `kernel-contracts` and
  implemented by the owning Durable Object:
  `packages/kernel-do/src/workspace-generations.ts`
  (`DurableWorkspaceGenerations`) over the `workspace:` storage keys.
- `surface` mirrors the Fly implementation exactly: `"kernel"` refuses every
  Memory root write, `"memory"` serves Memory roots and nothing else.

**Object-key and conflict-key scheme.**

```
file      workspace/<workspaceRootKeyV1(root)>/<relative>
conflict  workspace/<workspaceRootKeyV1(root)>/<relative>.conflict/<generationId>
```

Every `put` is conditional. `expectedGenerationId` is mapped to the ETag the
Durable Object recorded for that generation and sent as `If-Match`; `null` is
sent as `If-None-Match: *` (the R2 adapter sends `uploadedBefore: epoch`
alongside, so "create only if absent" holds even where a wildcard etag would be
compared literally). A losing write is written to its conflict key, recorded in
the ledger as a conflicting generation with `conflictsWith` set, and returned
as `{ status: "conflict", current, preserved }` — preserved, surfaced, never
merged or dropped. A delete removes the object and records a durable tombstone,
which is the only evidence that survives, because object storage forgets the
key.

**Contract additions** (`packages/kernel-contracts/src/workspace.ts`), all
consumed by the two steps below: a fifth root kind `project-memory`
`{ kind, userId, projectId }` with a bounded slug; `WorkspaceMemoryRootV1`
covering all three tiers and `WorkspaceSharedMemoryRootV1` covering the two
shared ones; `WorkspaceShardV1` with `memoryShardPrefixV1`,
`memoryShardPathV1`, `workspaceMemoryShardV1` and `memoryShardOwnerV1`
(`by-agent/<botId>/`, empty for `bot-memory`); `writerOwnsMemoryPathV1`, true
only when a Bot writes its own shard, a User writes any shard of their own
root, and never for first-party or `unattributed`; `WorkspaceConflictV1` with
`isWorkspaceConflictV1`; and `WorkspaceGenerationsV1` /
`WorkspaceGenerationRecordV1` with their decoders.
`isLoadableSkillSourceV1` is unchanged.

**The seam the two later steps consume.**

- **Memory Package.** Construct the store with `surface: "memory"` and the
  User's or Bot's ledger, write through `memoryShardPathV1`, and hand the
  kernel `workspaceMemoryProjectionV1` of it. It replaces
  `packages/plugin-memory/src/workspace-storage.ts` and deletes
  `ComputerWorkspace.memoryWriter`.
- **Computer sync.** Landed as Step 3b below. The same object keys and the same
  conditional-write rules are what the sync agent obeys, through the store's
  `"sync"` surface; `WorkspaceGenerationsV1` is where its writes are recorded. A
  file it mirrors with no recorded writer reads back as `unattributed`, exactly
  as a shell-written file does on the Computer.

**Wiring.** `apps/cloudflare/src/workspace.ts` exports
`createR2ObjectBucketV1` and `createDurableWorkspaceFilesV1`. `BotState`
constructs the store over the existing `MEMORY_FILES` bucket and passes it to
the Shell Package as `WORKSPACE_FILES`, so the Skills loader is now mounted in
production and reads Skills from object storage without waking the Computer.
The bucket binding was reused rather than renamed: `WORKSPACE_FILES` is a
`WorkspaceFilesV1` on the Durable Object environment, not an R2 bucket, so the
two names must stay distinct. Durable-root objects live under the `workspace/`
prefix and never collide with the Memory Package's existing keys.

**Known disagreement, recorded rather than hidden.** `AGENTS.md` § Authorities
gives the User's Durable Object "the generation records of User Memory roots";
only the Bot object's ledger is wired today. Nothing writes a shared root in
production yet, so nothing is wrong at runtime — the Memory step closes it by
routing shared roots to the User object through the same interface. It is in
the **Open** list of `docs/architecture-checks.md`.

### Landed

`packages/plugin-memory` is a first-party Package with one runtime
Contribution, mounted like Skills: only for a Turn whose Memory roots the host
can reach. The old Package — `agent`/`global` scopes, an R2 bucket of its own,
a Vectorize index, `workspace-storage.ts` over the Computer's `memoryWriter`
seam — is deleted, not kept alongside.

- **Storage.** Every read and write goes through `WorkspaceFilesV1` from
  `@frockbot/workspace-store` with `surface: "memory"`, to the three Memory
  roots. Bot Memory root: `profile.md` + `log/YYYY-MM.md`. User and Project
  roots: the writing Bot's shard `by-agent/<botId>/{profile.md,log/…}` through
  `memoryShardPathV1`, never another Bot's. Every write carries Bot (or, for
  the Project descriptor, User) provenance and produces a generation.
- **Ledger ownership.** `apps/cloudflare/src/memory.ts` routes a _shared_ root
  — `user-memory`, `project-memory` — to the **User** Durable Object over RPC
  (`createUserWorkspaceGenerationsV1`), and everything else to the Bot's own
  ledger. `WorkspaceGenerationsV1.mint` gained a `root` parameter so the ids
  that order a shared root's generations are minted by the authority that
  holds them; without it two Bots would mint from two counters and
  "newest wins" would have no answer. The production store is now constructed
  with the `owner` guard, in `BotState.bindSurfaces`, which is the first point
  a Bot Durable Object knows which User it serves.
- **Tools.** `memory_write({scope, project?, tier, fact})`,
  `memory_forget({scope, project?, fact})`, `memory_search`,
  `memory_rebuild_index`, and `project_create` / `project_join` /
  `project_leave`. Each mutation records `memory/write-intent` (or
  `memory/project-intent`) with an effect identifier before the effect and
  `memory/written` / `memory/project-changed` after it, mirroring
  `plugin-skills`. Project membership is durable state in the **User** Durable
  Object (`memory:projects` catalogue plus a joined list per Bot); the Project
  descriptor is `projects/<slug>/project.md` in the Project's Memory root,
  written with User provenance because it sits outside every `by-agent/` shard
  and `writerOwnsMemoryPathV1` allows no Bot writer there — which is right:
  creating a Project is a User-scoped act.
- **Forgetting.** A fact this Bot recorded is removed from its own file. A
  shared fact another Bot recorded is never edited: a `[forgotten] <fact>`
  retraction goes into this Bot's own log, and newest-wins suppresses the fact
  at read time in every Bot's view.
- **Injection.** One block per Turn, user → project → own, labelled paragraphs
  rather than headings, `- (learned YYYY-MM-DD) [via <bot>] <fact>` lines with
  `[via …]` omitted on own facts. Precedence own > project > user is applied
  before rendering, so a fact the Bot holds itself appears once. GrokBot's caps
  exactly: own recall(30) / 4000 chars / 500 per fact; user 50/15 + 4000/2000;
  project at most 3 joined, 25/10 + 2500/1500. `memory/injected` records every
  file generation read, every fact injected, and every omission.
- **Compaction-epoch freeze: deliberately not implemented.** GrokBot's
  `resolveFrozenMemoryPrompt` reuses the rendered block for as long as
  `compactionEpoch` holds, and that freeze is its own best explanation for the
  divergence we observed (§3.6): own profile facts on disk while the injected
  block said "No facts recorded yet". Rendering fresh each Turn costs one
  listing; the constitutional requirement is that what was injected is
  _recorded_, which `memory/injected` satisfies, not that it is cached. Parity
  register row 13c is therefore a deliberate divergence, not a gap.
- **Indexes.** `chunker` is unchanged; `indexer` and `searcher` are rebuilt
  over the files. `buildMemoryIndexV1(documents)` and
  `updateMemoryIndexV1(previous, documents)` must answer the same index for
  the same documents, and a test proves it; `memory_rebuild_index` throws the
  derived half away. Embeddings and a vector index are optional bindings —
  Memory is complete without them and searches lexically.
- **Package policy: no secrets.** `packages/plugin-memory/src/secrets.ts`
  refuses a fact matching a bounded list of obvious credential shapes: PEM
  blocks, `sk-…`, GitHub and Slack tokens, AWS access key ids, bearer tokens,
  JWTs, and `api_key`/`password`/`secret` assignments. It is deliberately
  shallow and says so: the rule it enforces is "do not write the API key into
  Memory", not "prove this string holds no entropy". The refusal is a value the
  tool reports, never a throw and never a silent redaction.
- **Electron.** `apps/agent-runtime` no longer mounts Memory. It used to, over
  the Computer's `memoryWriter` seam, which meant the Computer had to be awake
  for a Bot to read its own Memory. The hosted backend is the production path
  and supplies the Durable Object binding; the Electron utility runtime is a
  platform shell with no such binding, so it mounts no Memory Package rather
  than reaching a second store.

**Left over.** `ComputerWorkspace.memoryWriter` is retired but still declared
in `packages/computer-core` and `packages/plugin-fly-sprite`; nothing calls it.
ADR 0013 stays **proposed** until the sync of Step 3b has a production caller.

### Step 3b — Computer sync (landed)

**Status.** Landed. The Computer-side half of ADR 0013: the Workspace on the
Computer and the object-storage Workspace are one set of files. Not yet wired
to a production caller — see the **Open** list of `docs/architecture-checks.md`.

**Mechanism, decided.** A backend sync agent, not a FUSE mount. A mount needs a
bucket credential on the Workspace, cannot record a writer, and is
last-writer-wins; all three are things the constitution forbids, so FUSE
latency was never the deciding argument. The full reasoning is in ADR 0013's
**Mechanism** paragraph and at the top of
`packages/plugin-fly-sprite/src/sync.ts`.

**What landed.**

- `packages/plugin-fly-sprite/src/sync.ts` —
  `createWorkspaceRootSyncV1({ store, computer, roots, sessionWriter, effects,
generations })`, the reconciliation itself, over two seams:
  `WorkspaceFilesV1` for object storage and `ComputerSyncSurfaceV1` for the
  Computer. `FlySpriteSyncSurface` implements the second over the Sprite's
  storage exec path; `createFlySpriteSyncV1` wires both to one Sprite, and
  `declaredWorkspaceRootsV1` derives the roots from the provider's
  `WorkspaceLayoutV1`.
- A `"sync"` surface on `packages/workspace-store`: it reads every root, writes
  no Memory root, and is the only surface that accepts an `unattributed`
  writer, and only on a non-Memory root. That is the one place this step widens
  a rule — the alternative is losing a shell-written durable-root file at the
  next image rebuild, and the mirrored file carries no authority because
  `isLoadableSkillSourceV1` refuses it.
- `WORKSPACE_SYNC_SERVICE` (`frockbot-workspace-sync`), declared beside the
  viewer gateway in the provider's service list so a cold pause brings it back.
  It holds no credential and makes no network call: it watches the durable
  roots and bumps a change signal.
- A durable Computer-side tombstone. `FlyWorkspaceFiles.delete` now records
  `.frockbot-sync/tombstones/<rel>`, holding the generation the removal
  superseded and the writer that performed it, instead of deleting the sidecar
  and leaving the removal unaccountable. A shell `rm` is detected the same way,
  by a sidecar with no file.
- Effect identifiers on every push: intent recorded before the write, against a
  deterministic effect id, in the Bot's Durable Object through
  `WorkspaceSyncEffectsV1` where one is injected and in the Workspace otherwise.
  An unsettled intent is reconciled by reading the store, never by repeating
  the write.

**Step 1 disagreements this step closes.**

- `ComputerWorkspace.memoryWriter` is retired: it refuses every call, because
  the Memory Package writes object storage and the sync presents Memory roots
  read-only. It is not deleted yet — `apps/agent-runtime` still names it while
  the Memory Package's own step lands, so the property stays until nothing
  does.
- Shell-written files are no longer merely visible-but-unattributed on the
  Computer: they become durable generations in object storage, attributed to
  the tenant's Bot when the session recorded one and `unattributed` otherwise.
- The Computer side now has a durable tombstone, so a removal is recorded on
  both sides rather than inferred from an absence.

**Tests that gate** (`packages/plugin-fly-sprite/src/sync.test.ts`, with the
in-memory bucket and ledger from `@frockbot/workspace-store/testing` and a
Sprite double that interprets the emitted shell): concurrent Computer and store
writes to one non-Memory path leave both generations alive, one preserved as a
surfaced conflict; a Memory file changed or removed on the Computer is never
pushed and is restored; a push interrupted mid-flight resumes without writing a
second generation; a cold start with an empty disk repopulates every declared
root; a Skill written through the store lands under the Bot's instruction root
with the writer the store recorded; deletes cross in both directions, recorded;
a paused Sprite answers `unavailable` and the next run completes the work; the
watcher is a provider-declared service.

**Left for the caller.** Running the sync — on wake, on the watcher's change
signal, and around a Turn that uses the Computer — and the Durable Object
implementation of `WorkspaceSyncEffectsV1`. Both belong to whoever owns the
Bot's Computer lifecycle, not to the provider Package.

### Parity facts

From `docs/research/grokbot-computer.md` (§4.1a–b, GrokBot's own injected
prompt and its harness renderers). These are observations about the system we
are matching, not a change to the Step 3 scope above; they are recorded here
because they bear on the Memory root layout this step lands.

- GrokBot has **three** memory scopes, not two: own (Bot), **project**, and
  user, in injected order user → project → own. AGENTS.md § Memory names only a
  Bot Memory root and a User Memory root, and `plugin-memory` today has tiers
  `agent` and `global` — no project tier, no membership.
- **User memory is sharded by writer**: `user-memory/by-agent/<agent-uuid>/`,
  one `profile.md` + `log/` per writing Bot, _"so every file has a single
  writer"_; a Bot corrects another's shared fact by writing the correction into
  its own shard, and newest wins. Project memory shards identically. Our
  `user-memory` root is currently one prefix per owner
  (`plugin-memory/src/scopes.ts`), so "writes are segregated by writer" in
  AGENTS.md is satisfied by generation records rather than by path.
- Precedence is own > project > user, newest-wins within a shared tier.
- What is injected is capped and then **frozen per compaction epoch**
  (`resolveFrozenMemoryPrompt`), which is GrokBot's own best explanation for
  own-profile facts sitting on disk and never reaching the prompt. AGENTS.md
  already requires the session event log to record exactly what was injected,
  _"so an injection gap is visible in durable state"_ — this is the concrete
  failure that rule is for.
- On-disk fact lines are `- (YYYY-MM-DD) <fact>`; injected lines are
  `- (learned YYYY-MM-DD) [via <assistant>] <fact>`. Notes and episodes are a
  `[note] ` / `[episode] ` prefix on the fact text, not separate files.

---

## Parallelism and the one shared file

Steps 1, 2, and 3 are independent given Step 0. They touch exactly one file in
common: `docs/architecture-checks.md`, where each step adds its own rows and
removes its own entry from the **Open** list. Append rows in step order (1, 2, 3) to keep the conflict trivial when two land close together.

Step 2 and Step 3 both read Workspace files, and neither writes through the
other's surface: the Skills loader is read-only, the Memory Package writes only
Memory roots. Step 1 is the only step that changes `computer-core`.

---

## What could go wrong

- **`ComputerTarget` retirement lands mid-flight.** Step 1 removes the
  deprecated alias; Steps 2 and 3 must not reference it. They consume
  `kernel-contracts` types only, so this holds by construction — check it in
  review rather than assuming it.
- **Two spellings of a root.** `ComputerWorkspace.openDirectory`'s
  `namespace` + `scope` pair and `WorkspaceRootV1` describe the same thing.
  Step 1 must delete the first, not adapt between them, or Step 3 will decode a
  root two ways.
- **The Skills `todo` converted too early.** It is a real test only once a
  loader exists; converting it in Step 0 or 1 makes the check pass against
  nothing.

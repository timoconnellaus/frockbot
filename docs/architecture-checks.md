# Architecture checks

`AGENTS.md` § Architecture checks lists the constitutional rules that can be
enforced mechanically. Each row below maps one rule to the test that proves it.
Every row is a real, named test run by CI: Bun tests by `bun test`, workerd
tests by `bun run --filter @frockbot/cloudflare test:workerd` and
`bun run --filter @frockbot/cloudflare-bundler test:workerd`, and the two
source-graph linters by `bun run typecheck` and `bun run lint:ui-styles`.

| Constitutional check                                                                                          | File                                                         | Test name                                                                                                                                                   | Runner  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| the kernel imports no Package                                                                                 | `packages/architecture-checks/src/kernel-boundaries.test.ts` | `the kernel imports no Package` (runs `scripts/check-kernel-imports.ts`, also wired into `typecheck`)                                                       | Bun     |
| two provider Packages satisfy the model interface with no kernel diff                                         | `packages/architecture-checks/src/model-interface.test.ts`   | `two provider Packages satisfy the model interface with no kernel diff`                                                                                     | Bun     |
| — its source half                                                                                             | `packages/architecture-checks/src/kernel-boundaries.test.ts` | `no kernel source names a model provider Package`                                                                                                           | Bun     |
| a Turn that does not use the Computer makes no Computer interface call                                        | `packages/architecture-checks/src/turn-boundaries.test.ts`   | `a Turn that does not use the Computer makes no Computer interface call`                                                                                    | Bun     |
| a non-first-party Package loads with `globalOutbound` disabled and Assignment-derived bindings                | `apps/cloudflare/test/bot-isolate.workerd.ts`                | `a non-first-party Package loads with globalOutbound disabled and Assignment-derived bindings only`                                                         | workerd |
| — its bindings derive only from Assignments                                                                   | `apps/cloudflare/test/bot-isolate.workerd.ts`                | `list reports only the Assignment-derived capabilities`                                                                                                     | workerd |
| — an authority-widening request produces a pending decision                                                   | `apps/cloudflare/test/bot-isolate.workerd.ts`                | `requestAuthority returns a pending decision and records it durably`                                                                                        | workerd |
| a broken Bot-authored generation leaves the last known-good Composition running and records a visible failure | `apps/cloudflare/test/composition.workerd.ts`                | `a broken Bot-authored generation leaves the last known-good Composition running and records a visible failure`                                             | workerd |
| — the same rule at the record level, plus quarantine                                                          | `packages/kernel-do/src/composition-failures.test.ts`        | `fail-closed Composition activation` (7 tests)                                                                                                              | Bun     |
| — three consecutive failures quarantine, per generation                                                       | `apps/cloudflare/test/composition.workerd.ts`                | `three consecutive failures quarantine the generation and the fourth Turn does not attempt it`                                                              | workerd |
| reverting a Bot-authored change restores the prior generation                                                 | `apps/cloudflare/test/composition.workerd.ts`                | `a revert records a new generation the next admitted Turn activates`                                                                                        | workerd |
| a Skill written outside the Bot's own authority is not loaded as an instruction                               | `packages/architecture-checks/src/turn-boundaries.test.ts`   | `a Skill written outside the Bot's own authority is not loaded as an instruction — …` (end to end through a real Turn's model request)                      | Bun     |
| — its contract half: a Workspace path rejects traversal and every other escape                                | `packages/kernel-contracts/src/workspace.test.ts`            | `rejects traversal, absolute paths, and every other escape`                                                                                                 | Bun     |
| — its contract half: no non-instruction root is ever a Skill source                                           | `packages/kernel-contracts/src/workspace.test.ts`            | `no other root kind is ever a Skill source`, `a writer that is neither the Bot nor its User is refused`                                                     | Bun     |
| — its contract half: a file with no recorded writer is never a Skill source                                   | `packages/kernel-contracts/src/workspace.test.ts`            | `a file with no recorded writer is never a Skill source`, `no write may name an unattributed writer, whatever the root`                                     | Bun     |
| a Workspace write into a Memory root is rejected                                                              | `packages/kernel-contracts/src/workspace.test.ts`            | `no Memory root accepts a write through the kernel-consumed interface`, `the Memory projection of a full file interface exposes no write path`              | Bun     |
| an operation exceeding a durable per-User quota is refused and records a visible failure                      | `apps/cloudflare/test/authoring.workerd.ts`                  | `a quota breach is a visible failure, not a throw`                                                                                                          | workerd |
| client bundles and protocols contain no secrets                                                               | `packages/architecture-checks/src/kernel-boundaries.test.ts` | `client bundles and protocols contain no secrets`                                                                                                           | Bun     |
| core runtime code has no Electron dependency                                                                  | `packages/architecture-checks/src/kernel-boundaries.test.ts` | `core runtime code has no Electron dependency`                                                                                                              | Bun     |
| a reconstructed Bot Durable Object remounts its pinned Composition **and resumes from its durable cursor**    | `apps/cloudflare/test/composition.workerd.ts`                | `the pinned generation is stable across Durable Object eviction` — remount half only; see Open                                                              | workerd |
| admitted work survives **client shutdown and** Durable Object restart                                         | `apps/cloudflare/test/fly-compatibility.workerd.ts`          | `persists session events in sequence across eviction` — restart half only; see Open                                                                         | workerd |
| cancellation is explicit and durable                                                                          | `packages/kernel-agent-loop/src/index.test.ts`               | `cancels an active stream and closes its step and turn`, `settles remaining tool occurrences before closing a cancelled turn` — durable half only; see Open | Bun     |
| duplicate delivery does not duplicate effects                                                                 | `apps/cloudflare/test/authoring.workerd.ts`                  | `a duplicate effect id after eviction does not bundle twice`                                                                                                | workerd |

## Skills

Rows for the Skills loader (`packages/plugin-skills`), which the Skills step of
`docs/plans/slice-2.md` added.

| Constitutional check                                                                                | File                                               | Test name                                                                                                                 | Runner |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| only Skills under the Bot's own instruction root, written by the Bot or its User, are loaded        | `packages/plugin-skills/src/catalog.test.ts`       | `loads only Skills the Bot or its User wrote under its own root`                                                          | Bun    |
| — a file outside that root is never loaded, however it is named or listed                           | `packages/plugin-skills/src/catalog.test.ts`       | `never loads a file outside the instruction root, however it is named`                                                    | Bun    |
| — a file whose writer was never recorded is refused, with the reason recorded                       | `packages/plugin-skills/src/catalog.test.ts`       | `refuses a Skill whose writer was never recorded`                                                                         | Bun    |
| a refused or malformed candidate is recorded, not thrown, and does not fail the Turn                | `packages/plugin-skills/src/catalog.test.ts`       | `refuses a malformed Skill without failing the load`, `an unreadable instruction root yields no instructions and says so` | Bun    |
| injection is visible in durable state: the exact Skill generation each Turn used is reconstructable | `packages/plugin-skills/src/agent.test.ts`         | `records exactly what it injected on the Turn`                                                                            | Bun    |
| a Bot-authored Skill records intent before the effect, with Bot provenance                          | `packages/plugin-skills/src/agent.test.ts`         | `records intent, writes with Bot provenance, then records the generation`                                                 | Bun    |
| an operation exceeding the bounded per-Bot Skill quota is refused visibly                           | `packages/plugin-skills/src/agent.test.ts`         | `refuses a breach of the bounded per-Bot Skill quota, visibly`                                                            | Bun    |
| Skills function while the Computer is hibernated: the seam reaches the Workspace and nothing else   | `packages/plugin-shell/src/backend-skills.test.ts` | `binds the Bot's own root and its Turn provenance when it is bound`                                                       | Bun    |

## Computer

Rows for `docs/plans/slice-2.md` Step 1 — one Computer per User (ADR 0012) and
the Workspace file surface the Computer provider implements.

| Constitutional check                                                                                                                                                    | File                                               | Test name                                                                        | Runner |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| one Computer serves all of a User's Bots (assignment keyed per User)                                                                                                    | `packages/computer-core/src/index.test.ts`         | `keys the Computer assignment per User, so a User's Bots share one Computer`     | Bun    |
| — one provider Sprite per User, with one shared browser profile                                                                                                         | `packages/plugin-fly-sprite/src/computer.test.ts`  | `puts two Bots of one User on one Sprite with one browser profile`               | Bun    |
| — each Bot receives its own directories and desktop on it                                                                                                               | `packages/computer-core/src/index.test.ts`         | `keys the Computer assignment per User, so a User's Bots share one Computer`     | Bun    |
| durable roots are declared by the Computer Package's Workspace layout, named by kind and owner                                                                          | `packages/plugin-fly-sprite/src/workspace.test.ts` | `declares instruction, Memory, and Package roots with Memory read-only`          | Bun    |
| — a root resolves to a mount path only inside the Computer Package                                                                                                      | `packages/computer-core/src/index.test.ts`         | `resolves a declared root to its mount path and refuses an undeclared one`       | Bun    |
| every write to a durable root records its writer                                                                                                                        | `packages/plugin-fly-sprite/src/workspace.test.ts` | `records the writer of every durable-root write and answers with the generation` | Bun    |
| — a file written around the Workspace surface (a shell command) records no writer, so it is answered as `unattributed`: visible and readable data, never an instruction | `packages/plugin-fly-sprite/src/workspace.test.ts` | `attributes a file with no recorded writer as unattributed`                      | Bun    |
| — `unattributed` is a reader's answer, never a writer a caller may name on a write or a delete                                                                          | `packages/plugin-fly-sprite/src/workspace.test.ts` | `refuses a write or a delete that names an unattributed writer`                  | Bun    |
| a Bot's instruction root and Bot Memory root are writable only by that Bot or its User                                                                                  | `packages/plugin-fly-sprite/src/workspace.test.ts` | `refuses a write to another Bot's instruction root and a first-party writer`     | Bun    |
| a Workspace write into a Memory root is rejected — **runtime half**                                                                                                     | `packages/plugin-fly-sprite/src/workspace.test.ts` | `refuses a write to either Memory root through the kernel-consumed surface`      | Bun    |
| Bots of one User may read each other's Workspace files (separation is organizational)                                                                                   | `packages/plugin-fly-sprite/src/workspace.test.ts` | `a Bot reads another Bot of the same User's Workspace file`                      | Bun    |
| a losing conditional write is a conflict, never a silent overwrite                                                                                                      | `packages/plugin-fly-sprite/src/workspace.test.ts` | `answers conflict when the expected generation is not the current one`           | Bun    |
| Computer connections drop on every pause; a dropped connection is an outcome, not a failure                                                                             | `packages/plugin-fly-sprite/src/workspace.test.ts` | `answers unavailable rather than throwing when the Sprite is paused`             | Bun    |

## Workspace store

Rows for `docs/plans/slice-2.md` Step 3a — `WorkspaceFilesV1` over object
storage (`packages/workspace-store`), its generation ledger in the owning
Durable Object (`packages/kernel-do/src/workspace-generations.ts`), and the
`WORKSPACE_FILES` binding that mounts the Skills loader in production
(`apps/cloudflare/src/workspace.ts`).

| Constitutional check                                                                                                    | File                                                   | Test name                                                                                 | Runner  |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------- |
| Skills function while the Computer is hibernated: a Skill written to object storage is loaded on the next admitted Turn | `apps/cloudflare/test/workspace.workerd.ts`            | `a Skill written through the store is loaded on the next admitted Turn`                   | workerd |
| — the exact Skill generation each Turn used is reconstructable from durable state                                       | `apps/cloudflare/test/workspace.workerd.ts`            | `a Skill written through the store is loaded on the next admitted Turn`                   | workerd |
| a write that would overwrite a generation its writer has not seen is preserved as a conflicting generation and surfaced | `apps/cloudflare/test/workspace.workerd.ts`            | `a stale expected generation conflicts, and both generations survive`                     | workerd |
| — its record half: the losing write survives in the Durable Object ledger across eviction                               | `apps/cloudflare/test/workspace.workerd.ts`            | `a stale expected generation conflicts, and both generations survive`                     | workerd |
| — a create that asserts absence never becomes a silent overwrite on real R2                                             | `apps/cloudflare/test/workspace.workerd.ts`            | `asserting absence over an existing object conflicts, never overwrites`                   | workerd |
| — the same rules against an in-memory object store, including the conflict key layout                                   | `packages/workspace-store/src/store.test.ts`           | `a stale expected generation conflicts and both generations survive`                      | Bun     |
| every write to a durable root records its writer, and a delete leaves a durable tombstone                               | `apps/cloudflare/test/workspace.workerd.ts`            | `a delete leaves a tombstone the Durable Object still holds after eviction`               | workerd |
| — its record half: mint, record, tombstone, conflict, and their decoders                                                | `packages/kernel-do/src/workspace-generations.test.ts` | `the generation ledger` (4 tests)                                                         | Bun     |
| — generation ids stay sortable and strictly increasing across eviction                                                  | `packages/kernel-do/src/workspace-generations.test.ts` | `minted generation ids` (3 tests)                                                         | Bun     |
| a Skill written outside the Bot's own authority is refused at the store, not merely unloaded                            | `apps/cloudflare/test/workspace.workerd.ts`            | `a Skill another Bot wrote is refused at the store, not merely unloaded`                  | workerd |
| — `unattributed` writers, first-party writers, and other Bots are refused on instruction and Memory roots               | `packages/workspace-store/src/store.test.ts`           | `who may write` (7 tests)                                                                 | Bun     |
| Memory is Markdown under three tiers, and shared tiers are sharded per writing Bot so every file has exactly one writer | `packages/kernel-contracts/src/workspace.test.ts`      | `the three Memory tiers` (4 tests), `shared Memory tiers are sharded per writing Bot` (6) | Bun     |
| — its runtime half: a Bot writes only its own shard, and a listing with no shard merges every Bot's                     | `packages/workspace-store/src/store.test.ts`           | `shared Memory tiers are sharded per writing Bot` (5 tests)                               | Bun     |
| a Workspace write into a Memory root is rejected — **object-storage half**                                              | `packages/workspace-store/src/store.test.ts`           | `the kernel surface refuses every Memory root and the Memory surface refuses every other` | Bun     |

## Sync

Rows for `docs/plans/slice-2.md` Step 3b — the Computer-side durable-root sync
of [ADR 0013](adr/0013-bidirectional-memory-sync.md)
(`packages/plugin-fly-sprite/src/sync.ts`) and the on-Sprite watcher service it
drives (`WORKSPACE_SYNC_SERVICE` in `packages/plugin-fly-sprite/src/computer.ts`).

| Constitutional check                                                                                                      | File                                            | Test name                                                                                 | Runner  |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------- |
| conflicting Workspace and object-storage writes to a non-Memory durable root both survive as generations and are surfaced | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a Computer write and a store write to one path both survive, one as a surfaced conflict` | Bun     |
| the Workspace presents Memory roots read-only through the durable-root sync                                               | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a Memory file changed on the Computer is never pushed and is restored`                   | Bun     |
| — its removal half: a Memory file removed on the Computer is restored, never deleted in the store                         | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a Memory file removed on the Computer is restored, never deleted in the store`           | Bun     |
| — its store half: the sync surface reads every root and writes no Memory root                                             | `packages/workspace-store/src/store.test.ts`    | `the sync surface reads every root and writes no Memory root`                             | Bun     |
| durable roots survive cold start: an empty disk is repopulated from object storage                                        | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a cold start with an empty disk repopulates every declared root`                         | Bun     |
| a Skill written through the store reaches the Bot's instruction root with the writer the store recorded                   | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a Skill written through the store appears under the instruction root with its writer`    | Bun     |
| a file that reaches a durable root outside the Workspace file surface is mirrored with an `unattributed` writer           | `packages/plugin-fly-sprite/src/sync.test.ts`   | `pushes a shell-written file as unattributed, never loadable`                             | Bun     |
| — its store half: only the sync surface may mirror an `unattributed` file                                                 | `packages/workspace-store/src/store.test.ts`    | `the sync surface mirrors an unattributed file, and no other surface may`                 | Bun     |
| a delete is recorded on both sides and never a silent overwrite                                                           | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a delete in the store becomes a recorded removal on the Computer`                        | Bun     |
| — the other direction, recorded in the ledger as an unattributed removal                                                  | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a removal on the Computer becomes a delete in the store, recorded`                       | Bun     |
| recovery never silently duplicates a Computer effect: a push interrupted mid-flight resumes                               | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a push interrupted by a pause resumes without writing a second generation`               | Bun     |
| connections drop on every pause; a Computer client resumes rather than treating a drop as failure                         | `packages/plugin-fly-sprite/src/sync.test.ts`   | `a paused Sprite answers unavailable and the next run completes the sync`                 | Bun     |
| only Computer-provider-declared services may be reattached                                                                | `packages/plugin-fly-sprite/src/sync.test.ts`   | `is declared as a provider service so a cold pause brings it back`                        | Bun     |
| the sync has a production caller: the pull lands before the Turn's first Computer tool call                               | `packages/plugin-computer/src/sync.test.ts`     | `pulls before the Turn's first Computer tool call and pushes after the Turn`              | Bun     |
| — and the push lands after a Turn that used the Computer, on the Computer that Turn already had open                      | `packages/plugin-computer/src/sync.test.ts`     | `pulls before the Turn's first Computer tool call and pushes after the Turn`              | Bun     |
| — a Turn that does not use the Computer syncs nothing, so no sync ever wakes a Computer                                   | `packages/plugin-computer/src/sync.test.ts`     | `a Turn that never uses the Computer never syncs, so nothing wakes`                       | Bun     |
| — a mid-Turn sync happens only on the watcher's change signal                                                             | `packages/plugin-computer/src/sync.test.ts`     | `syncs again inside a Turn only when the watcher's change signal moved`                   | Bun     |
| a failed or unavailable sync is a recorded outcome on the Turn, never a thrown error and never a failed Turn              | `packages/plugin-computer/src/sync.test.ts`     | `an unavailable sync is recorded on the Turn and never fails it`                          | Bun     |
| the sync reaches the Bot only through the provider-neutral Computer interface, and pulls the store's roots onto the disk  | `packages/plugin-fly-sprite/src/sync.test.ts`   | `pulls the store's durable roots onto the Computer before the Bot's first use`            | Bun     |
| — intent is recorded before the push and settled after, and an open Turn still does not attribute a shell write           | `packages/plugin-fly-sprite/src/sync.test.ts`   | `pushes a shell write after the Turn, recording its intent before the write`              | Bun     |
| — a paused Computer answers `unavailable` through that interface too                                                      | `packages/plugin-fly-sprite/src/sync.test.ts`   | `answers unavailable rather than throwing when the Sprite is paused`                      | Bun     |
| — a host with no object-storage side gets no sync at all, rather than one with nowhere to record                          | `packages/plugin-fly-sprite/src/sync.test.ts`   | `carries no sync at all when the host supplies no object-storage side`                    | Bun     |
| a push records intent and an effect identifier in the Bot's Durable Object before it runs, and it survives eviction       | `apps/cloudflare/test/computer-sync.workerd.ts` | `a push records its intent in the Bot Durable Object, and it survives eviction`           | workerd |
| — recovery reads that outcome instead of repeating the effect                                                             | `apps/cloudflare/test/computer-sync.workerd.ts` | `an interrupted push is adopted after eviction, never written twice`                      | workerd |
| — the deployed push mirrors a shell-written file unattributed, inside an admitted Turn                                    | `apps/cloudflare/test/computer-sync.workerd.ts` | `a Turn's push writes the Bot's own instruction root, unattributed`                       | workerd |

## Memory

Rows for `docs/plans/slice-2.md` Step 3 — the Memory Package
(`packages/plugin-memory`) over the object-storage Workspace store, its shared
roots' generation ledger in the User Durable Object, and the injected block.

| Constitutional check                                                                                 | File                                                         | Test name                                                                                                                                                    | Runner  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Memory is readable and writable with no Computer interface call                                      | `packages/architecture-checks/src/memory-boundaries.test.ts` | `Memory is readable and writable with no Computer interface call`                                                                                            | Bun     |
| — its seam half: the Memory host carries a Workspace file surface and no Computer                    | `packages/plugin-memory/src/agent.test.ts`                   | `makes no Computer interface call — nothing on the path holds one`                                                                                           | Bun     |
| the Memory Package is the single writer of Memory roots, and writes only the writing Bot's own shard | `packages/plugin-memory/src/store.test.ts`                   | `writes a shared fact into the writing Bot's own shard only`                                                                                                 | Bun     |
| — its deployed half: another Bot's shard is refused against real R2                                  | `apps/cloudflare/test/memory.workerd.ts`                     | `a Bot may not write another Bot's shard of a shared Memory root`                                                                                            | workerd |
| readers merge shards, newest fact wins, and every shared fact records which Bot learned it           | `packages/plugin-memory/src/store.test.ts`                   | `merges shards and tags every shared fact with the Bot that learned it`                                                                                      | Bun     |
| — correcting a shared fact is a write into your own shard, never an edit of another's                | `packages/plugin-memory/src/store.test.ts`                   | `retracts another Bot's shared fact in this Bot's own shard, never editing theirs`                                                                           | Bun     |
| the User Durable Object holds the generation records of User Memory roots                            | `apps/cloudflare/test/memory.workerd.ts`                     | `a user-scope write records its generation in the User Durable Object, and another Bot of the same User is told who learned it`                              | workerd |
| — and survives eviction of that object                                                               | `apps/cloudflare/test/memory.workerd.ts`                     | same test (`evictDurableObject` before the ledger is read)                                                                                                   | workerd |
| what Memory enters a model request is recorded, so an injection gap is visible in durable state      | `packages/plugin-memory/src/agent.test.ts`                   | `records exactly what it injected, generations included`                                                                                                     | Bun     |
| — a tier a cap or a failure cut short is recorded as an omission, not silently dropped               | `packages/plugin-memory/src/render.test.ts`                  | `records a tier it could not read as an omission rather than staying silent`, `applies GrokBot's caps: 3 projects, 50/15 user, 25/10 project, 30 own recent` | Bun     |
| — its deployed half: the injected block and its record on a real Turn of a second Bot                | `apps/cloudflare/test/memory.workerd.ts`                     | `a user-scope write records its generation in the User Durable Object, and another Bot of the same User is told who learned it`                              | workerd |
| on conflict between tiers the most specific wins: Bot, then Project, then User                       | `packages/plugin-memory/src/render.test.ts`                  | `own memory wins over project, and project over user, on the same fact`                                                                                      | Bun     |
| indexes and embeddings are derived from Memory files and always rebuildable from them                | `packages/plugin-memory/src/indexer.test.ts`                 | `a rebuilt index equals an incrementally updated one`, `drops the chunks of a document that is gone`                                                         | Bun     |
| Memory contains no secrets and no credential references                                              | `packages/plugin-memory/src/store.test.ts`                   | `refuses a fact that looks like a credential`                                                                                                                | Bun     |
| — its tool half: the refusal is a visible outcome, and the attempt is still recorded                 | `packages/plugin-memory/src/agent.test.ts`                   | `refuses a credential-shaped fact, visibly, and writes nothing`                                                                                              | Bun     |
| a Memory change records durable intent with an effect identifier before the effect                   | `packages/plugin-memory/src/agent.test.ts`                   | `records intent before the effect, then the generation it produced`                                                                                          | Bun     |
| — and Project membership does the same                                                               | `packages/plugin-memory/src/agent.test.ts`                   | `create is join, and membership reaches durable state through the authority`                                                                                 | Bun     |
| Memory functions while the Computer is hibernated: the seam reaches the Workspace and nothing else   | `packages/plugin-shell/src/backend-memory.ts`                | covered by the architecture check above; the seam holds no Computer type by construction                                                                     | Bun     |

## Review fixes — Computer

Rows added by the Computer review pass over `packages/plugin-fly-sprite`: the
generation sidecar's binding to the bytes it describes, the Fly Workspace
handle's tenant, and the sync's writer attribution under ADR 0013.

| Constitutional check                                                                                                    | File                                               | Test name                                                                       | Runner |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| a Skill overwritten by a shell is not loaded as an instruction: a sidecar is believed only while it describes the bytes | `packages/plugin-fly-sprite/src/workspace.test.ts` | `answers unattributed when the sidecar does not describe the bytes`             | Bun    |
| — and a sidecar that does not decode at the seam is no sidecar at all                                                   | `packages/plugin-fly-sprite/src/workspace.test.ts` | `answers unattributed when the sidecar does not decode`                         | Bun    |
| every write to a durable root records its writer: the handle's tenant decides the writer, never the request's claim     | `packages/plugin-fly-sprite/src/workspace.test.ts` | `refuses a write naming a Bot that is not the handle's tenant`                  | Bun    |
| — a Bot may not write as its User, so it cannot author itself a loadable Skill under an authority it does not hold      | `packages/plugin-fly-sprite/src/workspace.test.ts` | `refuses a user writer from a handle opened for a Bot`                          | Bun    |
| a Computer-side removal is pushed as an unattributed delete, on non-Memory roots only                                   | `packages/plugin-fly-sprite/src/sync.test.ts`      | `pushes a Computer-side tombstone's removal as an unattributed delete`          | Bun    |
| — the generation a tombstone names is still the conditional delete's precondition, so a stale removal is surfaced       | `packages/plugin-fly-sprite/src/sync.test.ts`      | `refuses a removal that supersedes a generation the store no longer holds`      | Bun    |
| recovery never silently duplicates an effect: a push is settled only once its sidecar lands, so the next run adopts     | `packages/plugin-fly-sprite/src/sync.test.ts`      | `a push interrupted before its sidecar produces one generation and no conflict` | Bun    |

## Open

Rules in `AGENTS.md` § Architecture checks that no named test proves yet. They
are listed rather than omitted, because a rule with no row and no entry here
reads as covered when it is not.

- **Cancellation is explicit.** The durable half is covered by the rows above:
  a cancelled Turn closes its step and Turn and settles its tool occurrences.
  The _explicit_ half — "client disconnect, refresh, or shutdown detaches an
  observer; only an explicit authenticated command cancels work" — has no
  end-to-end check that a dropped observer leaves an admitted Turn running.
- **Admitted work survives client shutdown.** Only Durable Object restart is
  proven. Nothing yet drops a client mid-Turn and shows the Turn completing.
- **A reconstructed Bot resumes from its durable cursor.** The remount half is
  proven above. Resumption is exercised at the Agent-loop level
  (`packages/kernel-agent-loop/src/index.test.ts`: `resumes an explicitly
reconciled turn without admitting input twice`, `resumes inside a durable
step start awaiting its model request`) but never across a real workerd
  eviction of a Bot object mid-Turn.
- **Browser and native shells use the same backend execution path.** No check.
  The desktop and mobile hosts have their own tests, but nothing asserts that
  both reach the same backend protocol and Agent runtime.
- **The Memory rules.** All three constitutional Memory checks now have rows:
  a Workspace write into a Memory root is rejected (contract and runtime, under
  **Computer**); Memory is readable and writable with no Computer interface
  call (under **Memory**); and conflicting Workspace and object-storage writes
  to another durable root both survive as generations and are surfaced (under
  **Sync**, against the in-memory bucket and Sprite double, and on real R2 for
  the object-storage side in `apps/cloudflare/test/workspace.workerd.ts`). ADR
  0013 is accepted: the sync's production caller is the Computer Package
  (`packages/plugin-computer/src/agent.ts`), with rows under **Sync**.
- **Computer tools operate without a desktop client.** No check. The Computer
  Package's tests exercise provider routing, not the absence of a desktop
  shell.
- **Skills, the parts the loader cannot yet reach.** The binding gap is closed:
  `apps/cloudflare/src/workspace.ts` binds `WORKSPACE_FILES` over R2, and the
  **Workspace store** rows above prove a production Turn loading a Skill from
  object storage. Two smaller gaps remain. First, the per-Bot Skill quota is
  Package-local rather than durable per-User configuration, so no check ties it
  to the User Durable Object the way authoring's does. Second, Workspace disk
  is still not measurable as a per-User quota.
- **Where the generation ledger lives — closed.** `AGENTS.md` § Authorities
  gives the User's Durable Object "the generation records of User Memory
  roots". `apps/cloudflare/src/memory.ts` now routes a shared Memory root's
  mint, record, tombstone and conflict calls to the User object over RPC, and
  the workerd row above proves the record lands there and not in the writing
  Bot's object. `WorkspaceGenerationsV1.mint` gained a `root` parameter so the
  id that orders a shared root's generations is minted by the authority that
  holds them.
- **UI style contract** (`scripts/check-ui-styles.ts`) and the **kernel import
  contract** (`scripts/check-kernel-imports.ts`) remain standalone linters as
  well as tests, because `bun run typecheck` must fail on them before any test
  runs.

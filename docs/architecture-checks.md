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
- **The Memory rules.** `packages/plugin-memory/src/agent.test.ts` proves the
  storage and recall behaviour, and the row above proves the _contract_ half of
  one of the three constitutional Memory checks: the kernel-consumed interface
  for a Memory root has no write. The runtime rejection now has a row under
  **Computer** above. Two behavioural halves still have no test: Memory
  readable and writable with no Computer interface call, and conflicting
  Workspace and object-storage writes to another durable root both surviving
  as generations and surfaced. The durable-root sync named in ADR 0013 does
  not exist yet, so the Memory Package still writes Memory roots through the
  Computer's named `memoryWriter` seam rather than object storage.
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
- **Where the generation ledger lives.** `AGENTS.md` § Authorities gives the
  User's Durable Object "the generation records of User Memory roots", but the
  only ledger wired today is the Bot object's, so a shared Memory root written
  from two Bots would record its generations in two places. Nothing writes a
  shared root in production yet — the Memory Package still writes the
  Computer's `memoryWriter` seam — so the disagreement is latent, and the
  Memory step closes it by routing shared roots to the User object through the
  same `WorkspaceGenerationsV1` interface.
- **UI style contract** (`scripts/check-ui-styles.ts`) and the **kernel import
  contract** (`scripts/check-kernel-imports.ts`) remain standalone linters as
  well as tests, because `bun run typecheck` must fail on them before any test
  runs.

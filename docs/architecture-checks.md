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
| a refused or malformed candidate is recorded, not thrown, and does not fail the Turn                | `packages/plugin-skills/src/catalog.test.ts`       | `refuses a malformed Skill without failing the load`, `an unreadable instruction root yields no instructions and says so` | Bun    |
| injection is visible in durable state: the exact Skill generation each Turn used is reconstructable | `packages/plugin-skills/src/agent.test.ts`         | `records exactly what it injected on the Turn`                                                                            | Bun    |
| a Bot-authored Skill records intent before the effect, with Bot provenance                          | `packages/plugin-skills/src/agent.test.ts`         | `records intent, writes with Bot provenance, then records the generation`                                                 | Bun    |
| an operation exceeding the bounded per-Bot Skill quota is refused visibly                           | `packages/plugin-skills/src/agent.test.ts`         | `refuses a breach of the bounded per-Bot Skill quota, visibly`                                                            | Bun    |
| Skills function while the Computer is hibernated: the seam reaches the Workspace and nothing else   | `packages/plugin-shell/src/backend-skills.test.ts` | `binds the Bot's own root and its Turn provenance when it is bound`                                                       | Bun    |

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
  for a Memory root has no write. The behavioural halves have no test yet:
  Memory readable and writable with no Computer interface call; a Workspace
  write into a Memory root rejected at runtime; conflicting Workspace and
  object-storage writes to another durable root both surviving as generations
  and surfaced. The durable-root sync named in ADR 0013 does not exist yet.
- **Computer tools operate without a desktop client.** No check. The Computer
  Package's tests exercise provider routing, not the absence of a desktop
  shell.
- **Skills, the parts the loader cannot yet reach.** The loader and its checks
  are real (see the **Skills** subsection below), but nothing binds a
  `WorkspaceFilesV1` into the Bot Durable Object yet, so no production Turn
  loads a Skill: `packages/plugin-shell/src/backend-skills.ts` returns
  `undefined` and the Package is not mounted. Two consequences have no check.
  First, "an edit is visible to the Bot on its next admitted Turn" is proven
  only against an in-memory Workspace, not across a real durable-root sync.
  Second, the per-Bot Skill quota is Package-local rather than durable per-User
  configuration, so no check ties it to the User Durable Object the way
  authoring's does. Both close when the Computer and Memory steps of
  `docs/plans/slice-2.md` land the Workspace file surface.
- **UI style contract** (`scripts/check-ui-styles.ts`) and the **kernel import
  contract** (`scripts/check-kernel-imports.ts`) remain standalone linters as
  well as tests, because `bun run typecheck` must fail on them before any test
  runs.

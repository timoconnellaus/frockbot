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
| a Skill written outside the Bot's own authority is not loaded as an instruction                               | `packages/architecture-checks/src/turn-boundaries.test.ts`   | `it.todo` — quoted verbatim; **no Skills loader exists yet**                                                                                                | Bun     |
| an operation exceeding a durable per-User quota is refused and records a visible failure                      | `apps/cloudflare/test/authoring.workerd.ts`                  | `a quota breach is a visible failure, not a throw`                                                                                                          | workerd |
| client bundles and protocols contain no secrets                                                               | `packages/architecture-checks/src/kernel-boundaries.test.ts` | `client bundles and protocols contain no secrets`                                                                                                           | Bun     |
| core runtime code has no Electron dependency                                                                  | `packages/architecture-checks/src/kernel-boundaries.test.ts` | `core runtime code has no Electron dependency`                                                                                                              | Bun     |
| a reconstructed Bot Durable Object remounts its pinned Composition **and resumes from its durable cursor**    | `apps/cloudflare/test/composition.workerd.ts`                | `the pinned generation is stable across Durable Object eviction` — remount half only; see Open                                                              | workerd |
| admitted work survives **client shutdown and** Durable Object restart                                         | `apps/cloudflare/test/fly-compatibility.workerd.ts`          | `persists session events in sequence across eviction` — restart half only; see Open                                                                         | workerd |
| cancellation is explicit and durable                                                                          | `packages/kernel-agent-loop/src/index.test.ts`               | `cancels an active stream and closes its step and turn`, `settles remaining tool occurrences before closing a cancelled turn` — durable half only; see Open | Bun     |
| duplicate delivery does not duplicate effects                                                                 | `apps/cloudflare/test/authoring.workerd.ts`                  | `a duplicate effect id after eviction does not bundle twice`                                                                                                | workerd |

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
  storage and recall behaviour, but none of the three constitutional Memory
  checks has a test: Memory readable and writable with no Computer interface
  call; a Workspace write into a Memory root rejected; conflicting Workspace
  and object-storage writes to another durable root both surviving as
  generations and surfaced. The durable-root sync named in ADR 0013 does not
  exist yet.
- **Computer tools operate without a desktop client.** No check. The Computer
  Package's tests exercise provider routing, not the absence of a desktop
  shell.
- **Skills.** The one `todo` above. There is no Skills loader, so there is
  nothing to check yet; the row exists so the gap is visible rather than absent.
- **UI style contract** (`scripts/check-ui-styles.ts`) and the **kernel import
  contract** (`scripts/check-kernel-imports.ts`) remain standalone linters as
  well as tests, because `bun run typecheck` must fail on them before any test
  runs.

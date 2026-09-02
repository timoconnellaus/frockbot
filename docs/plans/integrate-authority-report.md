# Final integration report: Slice 1 authority

Integrated `lane/authority` into `lane/integrate-authority` from integrated
HEAD `af38a3a`. The merge commit is `f013334`; focused reconciliation commits
are `4b49ac6`, `064014b`, `e31989e`, and `0052b21`. Nothing was pushed.

## Textual conflicts

- `apps/cloudflare/src/bot-state.ts`: kept the iframe direct-tool decoder and
  added every per-Bot capability request decoder; removed the obsolete isolate
  authority-request import.
- `apps/cloudflare/test/authoring-probe.ts`: kept Catalog-aware undo and
  authoring hosts, replaced the Assignment fixture with the ready-Connection
  snapshot, and retained the authority binding digest.
- `docs/architecture-checks.md`: retained every integrated Slice 2–5 row and
  replaced the Assignment/request rows with the three Slice 1 checks: Bot-held
  bindings, unavailable missing authority, and Connection-driven identity.
- `docs/architecture.md`: combined Slice 1's per-Bot snapshot, generation-pinned
  leases, and binding digest with Slice 4 hooks, Slice 2 self-inspection, Slice
  3 hash-pinned Catalog bundles, and Slice 5 iframe/direct-tool admission.
- `packages/kernel-composition/src/isolate-wrapper.test.ts`: kept hook entrypoint
  and hook-health assertions beside the durable scheduling forwarder assertion.
- `packages/kernel-composition/src/isolate-wrapper.ts`: kept wrapper v4 and hook
  declaration/dispatch, then generated the complete per-Bot context instead of
  retaining either lane's obsolete partial context.
- `packages/plugin-shell/src/backend.ts`: kept the active mounted Composition,
  generation, turn type, role, and signal required by capability/direct-tool
  calls, while preserving controller abort plus Agent cancellation for durable
  Stop.

## Semantic reconciliation

- `packages/kernel-contracts/src/isolate.ts` now combines isolate contract v3
  hook DTOs with Slice 1's Connection/model/tool/Memory/Workspace/notification/
  scheduling DTOs. `IsolatePendingDecisionV1`, authority requests, and the old
  flat context methods do not survive.
- `packages/kernel-composition/src/isolate-wrapper.ts` generates the nested
  authority context below for both tools and hooks. The wrapper remains v4.
  `bun scripts/generate-isolate-context-catalog.ts` regenerated
  `isolate-context-catalog.generated.ts`, and the wrapper drift test passes.
- `packages/kernel-composition/src/isolate-host.ts` requires `bindingDigest`,
  folds it into the module-set hash, checks manifest tools and hooks, registers
  isolate hooks on the mounted loop root, records hook failures, and retains
  the stored-manifest plumbing used by self-inspection.
- `packages/plugin-shell/src/backend-isolate.ts` remains the snapshot/digest
  root. `packages/plugin-shell/src/backend.ts` resolves all ready User
  Connections and the effective model once per mount, gives every member the
  same snapshot, and routes tool, schedule, Memory, Workspace, Connection,
  notification, and model calls through active-Composition checks. Slice 2
  undo/inspect, Slice 3 Catalog, Slice 4 hooks, and Slice 5 iframe direct tools
  all layer on that root; no Assignment store is present.
- The iframe direct-tool path rechecks the pinned generation, non-first-party
  member, stored manifest, iframe contribution, and declared tool before using
  the ordinary durable tool Turn path. It references no removed authority DTO.
- `apps/cloudflare/test/bot-isolate-probe.ts` had a textually clean but stale
  stored manifest that still named deleted authority-request tools. Its tools
  now exactly match the authority, hook, schedule, and runtime context probes.
- Bot settings still mounts `PackageIframeSettings.vue` in
  `frockbot.bot-settings-sections`; the Assignment catalog and assign/replace/
  unassign controls remain deleted.
- Authoring help now names `ctx.model.invoke` and the configured model binding.
  Other current comments describe direct Connection state, not an Assignment.
- Durable Slice 1 facts moved into `docs/plans/bot-driven-change.md`; the
  lane-only `docs/plans/slice-1-authority-report.md` was deleted because its
  gate transcript and cross-lane instructions became stale after integration.

`ctx.tools.guard` remains the first-party-only Cordis registration seam defined
by `ToolRegistration`; it is intentionally not exposed to non-first-party
Package code. Package `ctx.tools.invoke` traverses the trusted active registry
and its deny-only guards. Isolate `tools/pre-execute` hooks retain the bounded,
monotonic deny path from Slice 4.

## Final generated Package context

```ts
interface BotPackageContextV1 {
  readonly tool?: string;
  readonly event?: BotIsolateHookEventNameV1;
  readonly botId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly packageId: string;
  readonly deadlineMs: number;
  readonly bindings: string[];
  readonly capabilities: {
    list(): Promise<IsolateCapabilityListOutcomeV1>;
  };
  readonly model: {
    invoke(request: NormalizedModelRequest): Promise<BotPackageModelOutcomeV1>;
  };
  readonly tools: {
    invoke(request: IsolateToolRequestV1): Promise<IsolateToolOutcomeV1>;
  };
  readonly memory: {
    read(request: IsolateMemoryReadRequestV1): Promise<IsolateMemoryOutcomeV1>;
    write(request: IsolateMemoryWriteRequestV1): Promise<IsolateMemoryOutcomeV1>;
    forget(request: IsolateMemoryWriteRequestV1): Promise<IsolateMemoryOutcomeV1>;
  };
  readonly workspace: {
    read(path: IsolateWorkspacePathV1): Promise<IsolateWorkspaceOutcomeV1>;
    list(request: IsolateWorkspaceListRequestV1): Promise<IsolateWorkspaceOutcomeV1>;
    stat(path: IsolateWorkspacePathV1): Promise<IsolateWorkspaceOutcomeV1>;
    write(request: IsolateWorkspaceWriteRequestV1): Promise<IsolateWorkspaceOutcomeV1>;
    delete(request: IsolateWorkspaceDeleteRequestV1): Promise<IsolateWorkspaceOutcomeV1>;
  };
  connection(connectionId: string): Promise<IsolateConnectionOutcomeV1>;
  notify(request: IsolateNotificationRequestV1): Promise<IsolateNotificationOutcomeV1>;
  schedule(request: IsolateScheduleRequestV1): Promise<IsolateScheduleOutcomeV1>;
}

interface BotPackageExecutionContextV1 extends BotPackageContextV1 {
  readonly tool: string;
  readonly event?: never;
}

interface BotPackageHookContextV1 extends BotPackageContextV1 {
  readonly tool?: never;
  readonly event: BotIsolateHookEventNameV1;
}
```

## Catalog missing-Connection proof

`apps/cloudflare/test/package-catalog-bot.workerd.ts` no longer calls the
deleted flat `ctx.listCapabilities()`. The installed bundle calls
`ctx.capabilities.list()` and, when its requested Connection is absent,
`ctx.connection(id)`, which returns the declared `unavailable` outcome. The
proof then supplies the ready User-created Connection snapshot on the next
Turn, asserts the Package becomes usable without a grant step, and asserts the
new loader id differs before undoing the installation. Thus “inert until
connected” is now a Connection/binding-identity transition, not Assignment or
pending-decision state.

## Isolate identity

`isolateBindingDigestV1` hashes canonical JSON containing:

- the mounted Composition generation id;
- ready Connections projected to sorted `(connectionId, generation)` pairs;
- the resolved model binding, or `null`.

`botIsolateModuleSetHashV1` then hashes wrapper version, wrapper hash, Package
artifact hash, and that binding digest. The loader id remains
`bot-package:<userId>:<botId>:<moduleSetHash>`. Package id is attribution only
and is deliberately absent from the authority digest.

## Tests changed

- Added the workerd runtime-context-key assertion against the generated
  self-inspection catalog.
- Expanded the Catalog workerd proof with unavailable-before, ready-after, and
  changed-loader-id assertions.
- Corrected the isolate probe's stored manifest to include the authority,
  schedule, hook, and context-key tools it actually exports.
- Retained the Slice 1 authority/identity, Slice 2 authoring/inspect/undo, Slice
  4 hook/failure, and Slice 5 iframe/direct-tool tests.
- The Slice 1 merge removed obsolete tests whose product paths were deleted:
  `backend-assignment.test.ts`, `plugin-mcp/connect-card.test.ts`, Composio's
  `connection-recovery.test.ts` and `dependency-coordination.test.ts`, and the
  old Assignment-oriented Settings client `index.test.ts`.

## Gates

- `bun run typecheck`: exit 0. Kernel import contract passed (37 files),
  Computer-host import contract passed (921 files / 70 manifests), generated
  isolate catalog fresh, and every workspace typecheck passed. This includes
  Cloudflare source, workerd tests, E2E TypeScript, and Vue.
- `bun test`: 2,824 passed, 1 failed, 9,699 expectations across 278 files. The
  only failure is the pre-existing
  `scripts/app-icons.test.ts` macOS `iconutil` “Invalid Iconset” failure.
- `cd apps/cloudflare && bun run test`: Bun half passed, 104 tests / 398
  expectations. Workerd stopped before collecting tests at
  `listen EPERM 127.0.0.1`, as expected in this sandbox.
- `bun run lint:ui-styles`: passed.
- `git diff --check`: passed.
- Focused checks: 75 contract/wrapper/host tests passed; 30
  Catalog/isolate/wrapper tests passed.

## Left undone

- Workerd suites were not executable because the sandbox refuses the loopback
  listener. The changed workerd files
  `apps/cloudflare/test/bot-isolate.workerd.ts` and
  `apps/cloudflare/test/package-catalog-bot.workerd.ts`, plus the retained
  authoring and iframe workerd coverage, do typecheck.
- Playwright was not run because its Wrangler/browser servers require the same
  forbidden loopback bind. All E2E files typecheck.
- The known `scripts/app-icons.test.ts` `iconutil` failure remains unchanged.
- No push was performed and no other worktree was touched.

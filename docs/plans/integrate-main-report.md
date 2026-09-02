# `origin/main` integration report

Status: complete on `lane/integrate-main`; not pushed.

This report records the integration of `origin/main` at `449bcf7` into the
bot-driven-change branch. The merge commit is `dab8dec`; the reconciliation is
recorded by `a780e78` through `78092ba`, followed by this report.

## Decision-by-decision resolution

### 1. Account-wide enablement is the base

Main's account-wide Package and Connection enablement, dependency ledger,
Package-setting model resolution, Custom models Package, and platform Flock
model remain the authoritative implementation. Conflicts in the overlapping
configuration and provider sweep were resolved around main's structure,
including:

- `packages/configuration-core/src/index.ts`
- `packages/plugin-settings/src/user.ts`
- `packages/plugin-shell/src/backend-configuration.ts`
- `packages/plugin-bot-template/`
- `applications/foundation/src/runtime.ts`
- `apps/cloudflare/src/bot-state.ts`
- `apps/cloudflare/src/user-configuration.ts`
- the MCP, Composio, web, Ollama, Flock, routines, and subagent Packages

Slice 1's competing per-Bot assignment/model path was not restored. The
bot-driven work retained from that slice is the `capabilities.list()` snapshot,
declared `unavailable` outcomes, and the no-authority-request invariant.

### 2. Bot-driven change is ADR 0020

`docs/adr/0019-bot-driven-change.md` became
`docs/adr/0020-bot-driven-change.md`. References were updated in:

- `AGENTS.md`
- `docs/architecture.md`
- `docs/architecture-checks.md`
- `docs/plans/bot-driven-change.md`
- code and test comments found by the repository-wide reference scan

ADR 0020 now states its relationship to ADR 0019: account-wide enablement is
the authority model, and ADR 0020 makes conversation with the Bot the primary
path for changes made on top of that authority.

### 3. There is no authority-request path

The authority-request and pending-decision contract was removed from:

- `packages/kernel-contracts/src/isolate.ts`
- `packages/plugin-shell/src/backend-isolate.ts`
- `packages/plugin-shell/src/backend.ts`
- `apps/cloudflare/src/bot-state.ts`
- `apps/cloudflare/src/bot-capabilities.ts`
- the MCP lifecycle command and tool surfaces

A missing, disabled, revoked, or mismatched capability returns
`{ status: "unavailable", reason }`. If a Connection becomes unavailable after
admission, the host also records a durable, visible notification whose stable
identifier begins
`package-connection-unavailable:<run>:<package>:<connection>`.

The identity-in-loader-digest correction from main remains. The digest binds
the User identity, Bot identity, Composition generation, sorted Connection
identity/generation set, and resolved model binding.

The MCP `pendingAuthorization` projection was retained only for an already
existing User-created Connection that enters `needs-auth` after an upstream 401. A Bot cannot create that record, receive an authorization URL, or turn it
into authority. It is a User reconnect state on `ConnectionsSurface.vue`, not
the removed isolate pending-decision mechanism. General action approval cards
also remain, but cannot create Connections or widen authority.

### 4. Both constitutional amendments survive

Main's Configuration shape section remains verbatim. Main's durable migration
and one-production-path rules also remain. Bot-driven additions were reapplied
without replacing main's equivalent account-wide-enablement language:

- Connections are made only by the User on Connections; no Bot output leads
  to one.
- A Bot may author, install from the catalog, change, inspect, and revert its
  own setup above the kernel.
- The required first-party core cannot be removed or replaced.
- Declared loop policy can execute in the isolate, while the Durable Object
  retains the durable loop skeleton.
- A failed activation reaches the Bot as durable input on its next Turn.
- Revert never establishes last-known-good; only a successful mount does.
- Non-first-party bindings expose exactly what the Bot holds and never widen
  authority.

The final delta relative to main is excerpted below:

```diff
 Package availability and Connections are User-level, and enabling them is the grant.
+A Bot's authority is exactly that account-wide grant, never a narrower per-Package grant. Connecting is a User act performed out of band on the Connections surface; a Bot never requests, prompts for, or renders a way to make a Connection...
-Composition fails closed... quarantined until a User acts.
+Composition fails closed... A failure is delivered to the Bot as durable input on its next admitted Turn...
+A kernel-declared required core set ... is present in every generation with first-party provenance.
-...only the capability bindings its User's enabled Packages and Connections grant...
+...only the bindings that expose what the Bot holds — its resolved model, enabled tools, Memory, Workspace, and its User's enabled Connections as opaque leases...
-A Bot may author or change anything above the kernel...
+A Bot may author, install from the catalog, or change anything above the kernel...
+Loop policy ... may execute in a loaded isolate through the loop's declared events...
-Activation... The User can ... revert any Bot-authored change...
+Activation... A Bot may revert its own setup generations... last known-good is set only by a successful mount, never by a revert.
-Self-modification... a request for more becomes a durable pending decision...
+Self-modification... there is no path by which a Bot requests more, and a capability the Bot does not hold is unavailable...
-Connections ... never Package enablement.
+Connections ... A Connection is made only here, by the User; no Bot output leads to it.
-...an authority-widening request produces a pending decision record rather than a grant;
+...a missing, disabled, or revoked Connection is an `unavailable` outcome recorded as a visible, repairable failure; no request widens authority;
```

### 5. Model resolution is main's

`packages/plugin-shell/src/backend-configuration.ts` resolves the Bot's model
through main's `role: "model"` Package settings in bot-scoped, account-scoped,
then platform order. The platform Flock model runs when the User has configured
nothing, without creating a per-Bot model record. The resolved binding is what
the isolate sees in `capabilities.list().model`; Slice 1's retained
`ModelAssignment` path is gone.

`packages/plugin-shell/src/backend-configuration.test.ts` proves both the
unconfigured platform-model Turn and the platform binding projected into the
isolate list.

### 6. Slices 2–5 were re-homed on main's shell

The smaller backend introduced by main remains; the old monolithic backend was
not resurrected. The retained capabilities were placed behind the new seams:

- Slice 2 authoring, `package_undo`, `package_inspect_self`, and the generated
  isolate-context catalog live in `packages/plugin-authoring/`,
  `packages/plugin-shell/src/backend-authoring.ts`,
  `packages/plugin-shell/src/isolate-context-catalog.generated.ts`, and
  `scripts/generate-isolate-context-catalog.ts`.
- Slice 3's hash-pinned catalog bundles and install tools live in
  `packages/catalog-core/`, `packages/plugin-package-catalog/`,
  `packages/plugin-shell/src/backend-package-catalog.ts`, and the Application
  Foundation Package graph. Catalog installs retain the exact `contentHash`.
- Slice 4's loop event contract, hook declarations, wrapper dispatch, and
  `package/hook-failed` behavior live in
  `packages/kernel-contracts/src/loop-events.ts`, the isolate wrapper and host,
  and `packages/plugin-shell/src/backend-composition.ts`.
- Slice 5's iframe contract and hosted UI live in
  `packages/kernel-contracts/src/iframe-ui.ts`,
  `apps/cloudflare/ui/src/components/PackageIframeHost.vue`, the UI artifact
  route on `ui.<host>`, `apps/cloudflare/src/user-application.ts`, and the
  direct durable-tool route in `apps/cloudflare/src/backend-runner.ts`.

`docs/plans/integrate-authority-report.md` was deleted after its durable facts
were folded into `docs/plans/bot-driven-change.md` and the architecture docs.

## Final isolate `ctx` surface

The generated authoring catalog and the TypeScript contract agree on this
surface:

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
    write(
      request: IsolateMemoryWriteRequestV1,
    ): Promise<IsolateMemoryOutcomeV1>;
    forget(
      request: IsolateMemoryWriteRequestV1,
    ): Promise<IsolateMemoryOutcomeV1>;
  };
  readonly workspace: {
    read(path: IsolateWorkspacePathV1): Promise<IsolateWorkspaceOutcomeV1>;
    list(
      request: IsolateWorkspaceListRequestV1,
    ): Promise<IsolateWorkspaceOutcomeV1>;
    stat(path: IsolateWorkspacePathV1): Promise<IsolateWorkspaceOutcomeV1>;
    write(
      request: IsolateWorkspaceWriteRequestV1,
    ): Promise<IsolateWorkspaceOutcomeV1>;
    delete(
      request: IsolateWorkspaceDeleteRequestV1,
    ): Promise<IsolateWorkspaceOutcomeV1>;
  };
  connection(connectionId: string): Promise<IsolateConnectionOutcomeV1>;
  notify(
    request: IsolateNotificationRequestV1,
  ): Promise<IsolateNotificationOutcomeV1>;
  schedule(
    request: IsolateScheduleRequestV1,
  ): Promise<IsolateScheduleOutcomeV1>;
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

`ctx.tools.guard` is a trusted first-party Cordis seam and is not exposed to
non-first-party Package code. `ctx.tools.invoke` traverses the trusted registry,
active-Composition check, and deny guards.

## Replacement tests for pending decisions

Main's pending-decision expectations were replaced by tests of the closed
authority union:

- `packages/kernel-contracts/src/isolate.test.ts` rejects authority fields
  outside the Bot authority contract and decodes only declared `unavailable`
  failures.
- `packages/plugin-shell/src/backend-isolate.test.ts` proves an unconfigured or
  mismatched model is unavailable, never a pending decision, and retains the
  identity/digest assertions.
- `packages/plugin-shell/src/backend-configuration.test.ts` proves the platform
  model fallback and proves that a Connection disabled after admission is
  unavailable and records a visible failure.
- `apps/cloudflare/test/bot-isolate.workerd.ts` proves `list()` reports exactly
  the Bot's authority, absent capabilities are unavailable, and Connection
  changes select a new isolate.
- `apps/cloudflare/test/package-catalog-bot.workerd.ts` proves hash-pinned
  installation, unavailable-before-Connection behavior, remount after the User
  connects, and Bot-callable undo.

The current source scan finds no `requestAuthority`,
`mcp/request-authorization`, or `pending-user-decision` production surface. The
sole `requestAuthority` match is the historical sentence in ADR 0020 saying it
was removed.

## Fly compatibility finding

The named workerd test remains
`apps/cloudflare/test/fly-compatibility.workerd.ts`:
`persists session events in sequence across eviction`.

Comparing both merge parents found no main-side Bot Durable Object persistence
change that explains the previously reported zero-event result. Main's relevant
test edit changes the expected fresh Bot configuration revision from positive
to zero; it does not remove session persistence.

The current persistence chain is intact:

1. `BotDurableAuthority.executeAcceptedRun` supplies `persistSessionEvents`.
2. `ShellBotBackendContribution.executeTurn` forwards it through
   `packages/plugin-shell/src/backend.ts`.
3. `createShellCompositionHost` forwards it through
   `packages/plugin-shell/src/backend-composition.ts` to
   `createFoundationRuntime` and `SessionStore`.
4. `kernel-do/authority.ts` writes both `run:<id>.events` and `latest-events`.

A Bun-level regression assertion was added to the platform-model Turn in
`packages/plugin-shell/src/backend-configuration.test.ts`. It observes a
non-empty `latest-events` record with contiguous sequence numbers and passes.
That proves the reconciled Shell/authority call path, but it does not execute a
real Durable Object eviction. The exact workerd boundary remains for the
integrator because this sandbox cannot bind loopback; run
`cd apps/cloudflare && bun run test:workerd` and inspect this named test.

## Gate results

- `bun run typecheck`: passed. This includes the kernel import contract,
  Computer-host manifest checks, generated isolate-context catalog freshness,
  Cloudflare source, workerd/integration/e2e TypeScript, and Vue typechecking.
- `bun test`: `2917 pass`, `1 skip`, `0 fail`, `10041 expect()` calls across
  `2918` tests in `289` files. The noted macOS `iconutil` failure did not
  reproduce.
- `cd apps/cloudflare && bun run test`: Bun half passed with `106 pass`,
  `0 fail`, and `405` expectations across `14` files. The workerd half could
  not collect tests because Node failed with
  `listen EPERM: operation not permitted 127.0.0.1`.
- `bun run lint:ui-styles`: passed.
- `bun run format:check`: passed.
- `git diff --check`: passed.

Workerd, integration, and Playwright suites were not executed because this
sandbox forbids their loopback listeners. Their `*.workerd.ts`,
`*.integration.ts`, and `*.e2e.ts` sources all passed the repository typecheck.

## Constitutional review and remaining work

The final rule-by-rule review found no unresolved constitutional conflict:

- User Durable Object state remains authoritative for account enablement,
  Connections, and Package settings; the Bot Durable Object remains
  authoritative for admitted work, pinned Composition, effects, and event
  history.
- There is no per-Package grant, grant envelope, effect class, pending
  authority decision, or authority-request command under another name.
- Non-first-party backend code runs in the isolate with `globalOutbound`
  disabled; non-first-party hosted UI runs in the constrained iframe.
- Required core, fail-closed activation, last-known-good, undo, durable effect,
  configuration-shape, and one-production-path invariants remain represented in
  the merged constitution and checks.

The only item left undone is runtime execution of the loopback-dependent
workerd, integration, and Playwright suites, for the exact sandbox reason above.
No source or typecheck failure is being deferred. Nothing was pushed and no
other worktree was touched.

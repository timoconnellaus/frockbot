# Slice 1 report: authority is the Bot's Connections

## Outcome

Slice 1 is implemented on `lane/authority`, beginning with checkpoint
`d6730ad Collapse Bot authority to Connections` and completed by the follow-up
commit containing this report.

A Bot's isolate authority is now one per-Bot snapshot:

- every ready User Connection, projected without credentials;
- the Bot's effective model setting, if it resolves through a ready Connection;
- the current Composition's guarded tool registry;
- Memory and Workspace availability;
- notifications; and
- the existing durable Routine scheduling surface.

Every Package mounted for the Bot receives the same snapshot. Package identity
is retained for attribution only and does not narrow authority. The
per-Package Assignment store, operation state machine, dependency claims,
settings controls, authority-request RPC, and isolate pending-decision records
were removed.

The two interrupted edits inherited in
`packages/plugin-flock/src/shared.ts` and
`packages/plugin-flock/src/user.ts` were retained deliberately. Together they
omit `initialModel` instead of materializing an `undefined` property and
describe new-Bot registration as a profile/model-setting seed, consistent with
the collapsed authority model.

## Isolate capability contract

The service binding in
`packages/kernel-contracts/src/isolate.ts` has this TypeScript surface:

```ts
interface BotCapabilitiesStub {
  list(): Promise<
    | {
        status: "available";
        connections: IsolateConnectionV1[];
        model?: IsolateModelBindingV1;
        tools: true;
        memory: boolean;
        workspace: boolean;
        notify: true;
        schedule: true;
      }
    | IsolateCapabilityFailureV1
  >;

  invokeModel(request: NormalizedModelRequest): Promise<IsolateModelOutcomeV1>;
  invokeTool(request: IsolateToolRequestV1): Promise<IsolateToolOutcomeV1>;

  memoryRead(
    request: IsolateMemoryReadRequestV1,
  ): Promise<IsolateMemoryOutcomeV1>;
  memoryWrite(
    request: IsolateMemoryWriteRequestV1,
  ): Promise<IsolateMemoryOutcomeV1>;
  memoryForget(
    request: IsolateMemoryWriteRequestV1,
  ): Promise<IsolateMemoryOutcomeV1>;

  workspaceRead(
    path: IsolateWorkspacePathV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceList(
    request: IsolateWorkspaceListRequestV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceStat(
    path: IsolateWorkspacePathV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceWrite(
    request: IsolateWorkspaceWriteRequestV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceDelete(
    request: IsolateWorkspaceDeleteRequestV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;

  connection(connectionId: string): Promise<IsolateConnectionOutcomeV1>;
  notify(
    request: IsolateNotificationRequestV1,
  ): Promise<IsolateNotificationOutcomeV1>;
  schedule(
    request: IsolateScheduleRequestV1,
  ): Promise<IsolateScheduleOutcomeV1>;
}

interface IsolateCapabilityFailureV1 {
  status: "unavailable";
  reason: string;
}
```

The generated wrapper presents those calls to Package code as
`ctx.capabilities.list()`, `ctx.model.invoke()`, `ctx.tools.invoke()`,
`ctx.memory.{read,write,forget}()`,
`ctx.workspace.{read,list,stat,write,delete}()`, `ctx.connection(id)`,
`ctx.notify()`, and `ctx.schedule()`.

`schedule()` forwards to the existing `routine_manage` tool through the same
active-Composition check, deny-only guards, `package/tool-call` intent, and
`package/tool-result` record as `tools.invoke()`. No second scheduling
authority was introduced.

## Binding digest and loader identity

`isolateBindingDigestV1` computes:

```ts
sha256(
  JSON.stringify({
    compositionGenerationId,
    connections: connections
      .map(({ connectionId, generation }) => ({ connectionId, generation }))
      .sort((left, right) =>
        left.connectionId.localeCompare(right.connectionId),
      ),
    model: model ?? null,
  }),
);
```

The digest has no Package id and no Assignment input. It is folded into
`botIsolateModuleSetHashV1` beside the wrapper version/hash and Package
artifact hash. The loader id remains
`bot-package:<userId>:<botId>:<moduleSetHash>`. Adding, removing, or
regenerating a Connection, changing the resolved model, or changing the pinned
Composition therefore changes the isolate identity.

The loopback stub additionally checks every lease against the exact
`connectionId` and `generation` in its admitted props. Model calls have
their admitted model binding injected by the trusted stub and are refused if
the current Connection or catalog generation no longer matches. A cached old
isolate therefore cannot acquire authority added or regenerated after it was
loaded.

## Unavailable outcomes

All missing authority is a declared
`{ status: "unavailable", reason: string }` outcome:

- `connection(id)` rejects ids absent from the admitted Connection snapshot
  before calling the Bot Durable Object, and rejects a returned lease whose id
  or generation differs.
- `invokeModel()` returns unavailable when the admitted snapshot has no model,
  the requested provider/model differs, or the current resolved binding no
  longer matches the admitted Connection and catalog generations.
- inactive Compositions, missing Sessions, missing Memory/Workspace bindings,
  absent notification hosts, and failed capability RPCs are normalized to the
  same variant at their seams.

There is no `requestAuthority`, `IsolateAuthorityRequestV1`,
`IsolatePendingDecisionV1`, `ISOLATE_DECISION_PREFIX`, or
`pendingDecisions()` in production code.

MCP's `ConnectionView.pendingAuthorization` remains intentionally. It is a
URL-free, User-owned repair projection for an already-created Connection whose
provider entered `needs-auth`; only the User can act on it from Connections.
The deleted `mcp/request-authorization` command means a Bot or Package cannot
create that projection or prompt for a new Connection.

`decodeBotSettingsViewV1` temporarily accepts and discards stored
`assignments` and `assignmentOperations` fields so old durable v1 records
can be read. They are never returned to a client and confer no authority.

## Settings, templates, and integrations

- Bot settings no longer projects a Capability Assignment catalog or
  assign/replace/unassign controls. The stable client `ModelAssignment` DTO
  name remains because the brief forbids needless wire churn; it is treated as
  the Bot's model setting everywhere user-facing.
- Plugins still controls installation and enablement only. Uninstalling a
  Package does not remove User Connections or the Bot's model setting.
- Connections remains the only place a User creates, repairs, enables,
  disables, or removes a Connection. A hosted-client scan found no Bot-facing
  connect control; only negative E2E assertions for the removed “Capability
  Assignments” heading remain.
- Bot templates copy no Assignment or Connection authority. Imports can list
  Connections the recipient must create independently but never create one.
- MCP, Web, Composio, Ollama, catalog, audit, and package-settings fixtures now
  prove direct availability from ready Connections without a grant command.
- The MCP Bot-requested authorization command and its lifecycle/tests were
  deleted. Provider-detected repair of an existing Connection remains.

## Tests added or replaced

- Strict isolate contract tests cover the per-Bot list, `schedule: true`,
  schedule request decoding, unknown fields, and unavailable outcomes.
- Shell tests prove two Packages see identical authority, missing/mismatched
  models are unavailable, admitted model and Connection generations cannot be
  widened, and the digest changes for Connection add/remove/regeneration,
  model changes, and Composition changes while remaining order-independent.
- Isolate host tests prove the binding digest is required and changes the
  loader id.
- Wrapper tests prove forwarding for every capability, including schedule.
- Workerd tests were rewritten to cover the exact per-Bot capability list,
  unavailable Connection/model calls, schedule exposure, disabled
  `globalOutbound`, and a different isolate identity after Connection
  add/remove.
- Hosted and integration tests now assert direct ready-Connection authority,
  no Assignment UI, no grant step, and no imported authority.

Focused validation after the final authority-pinning change:

```text
78 pass
0 fail
128 expect() calls
Ran 78 tests across 4 files. [76.00ms]
```

The earlier broader focused sweep also completed:

```text
154 pass
0 fail
667 expect() calls
Ran 154 tests across 10 files. [214.00ms]
```

## Required gates

### `bun run typecheck`

Exit 0 after the final changes. The output begins:

```text
$ bun scripts/check-kernel-imports.ts && bun scripts/check-computer-host-imports.ts && bun run --filter '*' typecheck
Kernel import contract passed (34 files checked)
Computer host import contract passed (892 files, 69 manifests checked)
```

All workspace package typechecks completed, including
`@frockbot/cloudflare`'s source, test, E2E, and Vue projects. This is also the
successful compile check for the workerd probe and test files.

### `bun test`

The final run produced exactly the known unrelated macOS icon failure:

```text
/var/folders/6s/vscvcyfj07s9678t93ky4b5w0000gn/T/tmp.THHqvgoPhU/FrockBot.iconset:Invalid Iconset.
/var/folders/6s/vscvcyfj07s9678t93ky4b5w0000gn/T/tmp.THHqvgoPhU/FrockBot.iconset:Invalid Iconset.

2753 pass
1 fail
9471 expect() calls
Ran 2754 tests across 266 files. [25.23s]
```

The sole failure is
`scripts/app-icons.test.ts > generated app icons > the repeatable generator recreates the committed artifact tree from only the canonical marketing sheep icon`.
No Slice 1 test failed.

### `cd apps/cloudflare && bun run test`

The Bun half passed:

```text
102 pass
0 fail
391 expect() calls
Ran 102 tests across 13 files. [593.00ms]
```

The workerd half then stopped before collecting tests because this sandbox
cannot bind loopback:

```text
Error: listen EPERM: operation not permitted 127.0.0.1
  code: 'EPERM',
  syscall: 'listen',
  address: '127.0.0.1'
error: script "test:workerd" exited with code 1
error: script "test" exited with code 1
```

Per the resume instruction, workerd was not retried. After the final model
pinning edit, `cd apps/cloudflare && bun test src` passed again:

```text
102 pass
0 fail
391 expect() calls
Ran 102 tests across 13 files. [508.00ms]
```

The optional `no-mistakes` gate could not be used because this worktree has
not been initialized for it:

```text
error: repo not initialized (run 'no-mistakes init' first)
help[1]: Run `no-mistakes init` to set up the gate in this repository
```

No initialization files were added; the brief's explicit gates were run
directly.

## Cross-lane reconciliation

These are all ten files named by the integrator as shared with other lanes.
Slice 4 introduces isolate contract v3 / wrapper v4 with `hooks` and
`package/hook-failed`; Slice 2 introduces the `package_inspect_self`
catalog. Preserve both lanes' additions while carrying forward the authority
rules below.

- `packages/kernel-contracts/src/isolate.ts` — removes Assignment/request and
  pending-decision DTOs; defines the per-Bot Connection/model capability
  outcomes plus durable schedule. Merge into Slice 4's v3 contract without
  dropping its hook DTOs, and retain any Slice 2 self-catalog DTOs.
- `packages/kernel-contracts/src/isolate.test.ts` — proves strict per-Bot
  capability and schedule decoding and that old authority fields are rejected.
  Keep these beside Slice 4's v3 hook tests and Slice 2's catalog tests.
- `packages/kernel-composition/src/isolate-host.ts` — requires the
  per-Bot binding digest and folds it into the module-set hash/loader id.
  Preserve that hash input while adding Slice 4 hook registration and Slice 2
  self-inspection plumbing.
- `packages/kernel-composition/src/isolate-wrapper.ts` — wrapper
  `wrapper-v3-authority` exposes the per-Bot list, model, tools, Memory,
  Workspace, Connection, notify, and schedule calls. Slice 4's wrapper v4
  version should win, but its generated context must retain all these
  forwarders while adding `hooks`; compose Slice 2's self-catalog access
  rather than reintroducing a grant path.
- `packages/plugin-shell/src/backend.ts` — resolves all ready User
  Connections and the effective model setting once per isolate mount, mints
  identical Package snapshots, routes tools/schedule through durable
  package-attributed logging, and returns unavailable at missing seams. Layer
  Slice 4's hook dispatch and `package/hook-failed` records and Slice 2's
  `package_inspect_self` catalog onto this root without restoring Assignment
  state.
- `packages/plugin-shell/src/backend-isolate.ts` — owns the snapshot shape,
  model/Connection-generation checks, unavailable model behavior, and
  Connection/model/Composition digest. Retain these when accepting Slice 4 hook
  descriptors and Slice 2 catalog inspection.
- `apps/cloudflare/test/bot-isolate-probe.ts` — seeds the per-Bot snapshot,
  records loader ids, and exposes list/model/Connection/schedule probe tools.
  Extend this probe with Slice 4 hooks and Slice 2 self-inspection instead of
  replacing the authority probes.
- `apps/cloudflare/test/bot-isolate.workerd.ts` — proves exact authority,
  unavailable missing capabilities, disabled outbound access, schedule
  exposure, and Connection-driven isolate identity. Keep these cases beside
  Slice 4 hook-bridging/failure cases and Slice 2 self-catalog cases.
- `docs/architecture.md` — replaces Assignment-derived binding prose with the
  per-Bot Connection snapshot, digest, unavailable outcomes, pinned leases, and
  guarded schedule path. Merge in the hook bridge and self-catalog narrative
  without weakening this authority description.
- `docs/architecture-checks.md` — rows 17–19 now map to Bot-held bindings,
  unavailable missing authority, and Connection-driven isolate identity. Add
  Slice 4 and Slice 2 rows independently; do not overwrite these three.

## Left undone or intentionally retained

- Workerd execution is unverified in this sandbox because of the loopback
  `EPERM`; its files do typecheck.
- The known `iconutil` failure remains unrelated and unchanged.
- The brief explicitly excluded `plugin-authoring`. Its
  `packages/plugin-authoring/src/shared.ts` comment still says an authored
  model is callable where an enabled model “Assignment” matches. The owning
  lane should rename that comment to the configured model binding; production
  behavior already uses the new authority path.
- Historical plans and ADRs that document the superseded design retain
  Assignment/request terminology as history. Current architecture,
  architecture checks, production code, and hosted surfaces describe only the
  accepted Connection authority model.
- No push was performed.

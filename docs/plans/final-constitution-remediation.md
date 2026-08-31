# Final constitution remediation

Status: approved scope; implementation plan for one PR with reviewable commits.

This plan completes the remaining audit work without compatibility paths. Every slice uses the hosted WebUI and production backend path. The PR preserves PR #30's exclusion of Composio.

## 1. One resident Bot Cordis root

- **Authority:** each resident Bot Durable Object is the sole composition owner.
- **Durable state:** configuration, assignments, event log, cursor, active run, cancellation, and lifecycle remain durable; the Cordis root is an ephemeral projection. Durable `desiredRuntimeGeneration`, `runtimeProjection` (`pending | applied | failed`), and a bounded observable failure record make projection failure recoverable rather than process-local.
- **Interface:** replace separate backend-root and per-turn runtime factories with one deep `BotResidentRuntime` interface that exposes backend command facades and resident execution handles. Shell receives execution capability and no longer imports foundation runtime package factories.
- **Active-run generations:** a run keeps its admitted configuration snapshot and resident runtime generation through termination. Configuration commits advance the desired generation but defer remount while a run is active. After abrupt eviction, reconstruction first mounts the active run's admitted generation; after terminal settlement it reconciles the latest desired generation. New admission fails closed until the desired generation is applied.
- **Disconnect/eviction:** disconnect has no lifecycle effect. Eviction abruptly loses the root; the next alarm/RPC rebuilds the exact Plugin tree from immutable declarations plus the correct durable generation and resumes from the cursor.
- **Retry/reconciliation:** construction is single-flight; rejected construction clears for retry; partial mounts roll back. Projection failure is durably visible, schedules retry, and blocks new run admission. No correctness depends on disposal.
- **Authority/trust:** backend and agent Contributions mount in compiled order in the Bot host; provider/Sprite implementations remain Plugins behind narrow interfaces.
- **Failures/tests:** prove one root per resident instance, no duplicate registrations/effects, cold reconstruction after an abrupt drop, active-run snapshot preservation, exact assignment remount, fail-closed projection errors, partial-start cleanup, and effect recovery. Remove the production per-turn compatibility path.

## 2. Durable Stop

- **Authority:** the target Bot Durable Object through its resident runtime execution handle.
- **Durable state:** exact v1 Stop command, idempotency receipt, orthogonal `stopRequestedAt`, terminal `cancelled` run lifecycle, and execution phase (`executing | reconciling`) while nonterminal. The active marker remains until terminal settlement.
- **Commands/events:** authenticated `stop` targets one run. For already-admitted input the execution record uses cancelled `step/end` and `turn/end`; `input/cancelled` remains only for queued input.
- **Transition model:** Stop durably records an accepted receipt and stop intent before signalling the resident Agent. A run with no uncertain effect proceeds to terminal `cancelled` and clears its active marker. A run with an uncertain effect remains nonterminal in `reconciling` with stop intent; reconciliation journals the original outcome, then terminates cancelled without starting another model/tool effect. Stop acknowledgement is not a claim of terminal cancellation.
- **Archive relationship:** archive is eligible only after the active marker is gone and no effect reconciliation remains. A stopped-but-reconciling run therefore still blocks archive.
- **Disconnect/eviction:** disconnect only detaches the observer. A reconstructed Bot observes stop intent before resuming and never starts a new effect after cancellation.
- **Retry/reconciliation:** repeated identical commands replay; identifier collisions reject. Provider abort is advisory and never erases uncertain-effect state.
- **Authority/trust:** the hosted gateway authenticates and strictly decodes; the Bot revalidates identity.
- **Hosted projection:** Stop sends the durable command and projects accepted, reconciling, then terminal state; switching Bots or closing the client only detaches.
- **Failures/tests:** expose not-found, already-terminal, collision, uncertain-effect, and cancellation failures. Test strict DTOs, durable ordering, resident cancellation, eviction, transition matrix, retry, HTTP/RPC transport, and hosted behavior.

## 3. Capability Assignment management

- **Authority:** Bot settings in the Bot Durable Object own Assignments. Each Connection-owning backend Contribution owns its dependency records. `UserConfiguration` is the production-neutral router/coordinator that selects that Contribution from the durable Connection's Package identity; it does not implement provider behavior. No Composio production path is restored.
- **Durable state:** exact Assignment operation record (`assigning | replacing | unassigning`), Bot receipt, and Connection-owner claim/release receipt. Bot settings project the stable Assignment separately from its pending operation.
- **Commands/events:** assign, atomic replace, and unassign. Replace claims the new dependency, commits the new Assignment generation, acknowledges it, then releases the old dependency. Unassign commits intent before release and only removes the stable Assignment after definitive release. Every Connection Contribution implements exact versioned claim/read/acknowledge/release/reconcile DTOs behind the router seam; absent providers cannot fabricate availability.
- **Disconnect/eviction:** UI detaches without affecting the saga; Bot alarm reconstruction resumes the pending operation, while the User Contribution durably reconciles its own dependency receipts.
- **Retry/reconciliation:** exact replay returns the receipt; command collisions reject; uncertain cross-DO claim/release is read and reconciled before advancement. No client-side assign-then-unassign sequence represents Replace.
- **Authority/trust:** immutable catalog and ready Connection checks remain backend-owned. The pending operation is projected explicitly so the UI can show `retrying` without overloading Assignment availability state.
- **Hosted projection:** Bot settings list available capabilities, ready Connections, stable active/unavailable Assignments, pending operations, and Assign, Replace, and Unassign controls. Empty production catalogs render honestly.
- **Failures/tests:** surface unavailable packages/connections, claim/release races, provider absence, and retrying state. Test fake provider-neutral Connection Contributions, exact router DTOs, sagas, gateway, client interface, and settings behavior.

## 4. Hosted sign-out

- **Authority:** Better Auth through the auth Plugin and hosted auth route.
- **Durable state:** Better Auth session/cookie only; no client-owned canonical auth state.
- **Command:** auth Plugin exposes one narrow sign-out action; browser uses Better Auth, desktop uses its existing trusted bridge.
- **Development identity:** sign-out is explicitly unavailable for `as_user` / `frockbot_dev_user` development sessions because they are a separate opt-in authentication mode, not Better Auth state. The profile action explains this rather than pretending to clear authority.
- **Disconnect/eviction:** ordinary auth semantics; sign-out does not cancel Bot work.
- **Retry/reconciliation:** repeated sign-out is safe; failure leaves the current authenticated projection and is visible.
- **Authority/trust:** settings/profile UI invokes the auth-owned interface and never imports the auth adapter.
- **Hosted projection:** profile menu offers Sign out for Better Auth sessions, disables while pending, updates AuthGate state, and reports failure.
- **Failures/tests:** browser, desktop, repeated, pending, failure, and explicitly unavailable development behavior are tested at the auth Plugin interface.

## 5. Bot archive and restore

- **Authority:** the Flock User backend Contribution in the User Durable Object is the sole archive saga coordinator; target Bot Durable Object owns whether that Bot may admit work. `UserConfiguration.alarm()` only dispatches durable scheduling to declared User Contributions and does not become a second coordinator.
- **Durable state:** the immutable registration seed from ADR 0006 remains unchanged. Separate exact archive/restore command receipts and lifecycle projection live beside it; the Bot stores its lifecycle marker and idempotent lifecycle receipt. Existing runs/history/settings remain intact.
- **Commands/events:** Flock first records User intent and schedules recovery, then invokes an idempotent Bot lifecycle command, reads the Bot marker after uncertain responses, and finally updates User directory lifecycle projection. Restore performs the inverse. Archive rejects while an active marker or effect reconciliation exists; the user must durably Stop and await terminal settlement first.
- **Disconnect/eviction:** the User coordinator alarm resumes the saga; the Bot only replays/reads its own marker and receipt. An archived Bot remains non-admitting after reconstruction.
- **Retry/reconciliation:** command replay is idempotent; collisions reject; uncertain cross-DO calls reconcile by reading authoritative Bot lifecycle state.
- **Authority/trust:** authenticated User may manage only registered Bots. Archive preserves Assignment/configuration state for restoration and does not fabricate cleanup of external effects.
- **Hosted projection:** active directory hides archived Bots by default; management UI can show archived Bots, archive with confirmation, restore, and choose a deterministic active-Bot fallback.
- **Failures/tests:** active-run rejection, admission race, crash at every saga boundary, User alarm recovery, replay, restore, URL selection cleanup, unchanged registration seed, and preserved history/configuration are tested.

## 6. Thin mobile shell

- **Authority:** the hosted WebUI and normal backend protocol remain the only product path.
- **Durable state:** backend sessions and Bot state only. The shell owns no product state or Agent runtime.
- **Interface:** Capacitor loads the configured hosted application directly. Remove `mobile_shell=1`, the general-purpose API `postMessage` proxy, and local Vue auth/product UI. Retain a minimal mobile Contribution host solely for application-declared native enhancements; it mounts declared mobile Plugins in compiled order against narrow Capacitor adapters and cannot route product/backend commands or own canonical state.
- **Plugin composition:** native clipboard, notification, share, auth handoff, deep-link, and future adapters are reachable only through declared mobile-shell Contributions. Direct `server.url` navigation exposes no undeclared adapter to arbitrary hosted code. The configured hosted origin and application declaration gate mounting.
- **Disconnect/eviction:** WebView lifecycle detaches observers only. Missing/denied Contribution or adapter startup failure does not block hosted startup or Agent execution.
- **Retry/reconciliation:** native adapter calls use exact request/result/error/availability/cancellation DTOs and bounded lifetimes; durable backend-triggered effects remain backend-owned. Local user gestures may return explicit retryable errors.
- **Authority/trust:** hosted auth is canonical. Native Plugins receive only decoded capability requests from the configured hosted origin; no credentials or arbitrary API proxy cross the seam.
- **Hosted projection:** browser and mobile bootstrap the same ClientApplication, connections, Turn transport, and auth UI. Hosted policy feature-detects declared optional native capabilities and retains Web fallbacks.
- **Failures/tests:** prove identical backend transport, direct hosted navigation, declared Plugin mounting, trusted-origin native dispatch, malformed-request rejection, cancellation, missing-capability fallback, and absence of local product authority. Add a new accepted ADR that explicitly supersedes ADR 0005's rejection of direct `server.url`.

## Documentation

- Update `docs/architecture.md` for the resident root, orthogonal Stop model, Assignment operations, archive coordinator, hosted sign-out, and direct mobile path.
- Update ADR 0003 for production-neutral dependency release and atomic Replace consequences.
- Update ADR 0006 to keep immutable registration seeds while adding separate lifecycle projection and User-coordinated archive saga.
- Add a new accepted ADR that supersedes ADR 0005 and records direct hosted navigation plus declared mobile Contribution mounting.

## Delivery order inside one PR

1. Resident Bot root cutover and durable runtime-generation projection.
2. Durable Stop over the resident execution handle.
3. Production-neutral Assignment dependency operations and Assignment UI.
4. Hosted sign-out.
5. Bot archive/restore.
6. Direct hosted mobile cutover with declared mobile Contribution host.
7. Documentation listed above.
8. Rule-by-rule constitutional review, full checks, no-mistakes, current-head CI, and configured-bot review.

Each step lands as a distinct commit after behavior-level red/green tests at its public seam. A discovered constitutional conflict stops implementation and returns this plan to review.

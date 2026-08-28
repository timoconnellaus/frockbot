# Settings and Connections Plan

## Status

In implementation. Product decisions were confirmed on 2026-08-28. Slices 0–5 and the application-settings shell are implemented in this branch; Codex model integration waits for its separate worktree to land on `main`, and final extensibility hardening remains.

## Goal

Give FrockBot three clear configuration surfaces backed by one durable cloud architecture:

1. **Bot settings** from the selected Bot's gear.
2. **Plugins** from the bottom of the left sidebar, focused on adding external connections and capabilities to Bots.
3. **Application settings** from the User profile menu, including model-provider connections such as Codex.

Browser, desktop, and mobile use the same hosted UI and backend commands. Native clients may only enhance OAuth handoff, notifications, or other platform capabilities.

## Review of the current implementation

The existing controls are visual placeholders in `packages/plugin-shell/src/client/FrockBotApp.vue`:

- Plugins, profile, and Bot settings buttons have no navigation or commands.
- The shell only exposes `frockbot.computer` and `frockbot.right-panel` feature outlets.
- `packages/plugin-catalog` stores package state in process-local maps; it is a Cordis activation projection, not durable User state.
- Manifest v2 cannot declare settings, connection types, capabilities, migrations, or connection health.
- `apps/cloudflare/src/bot-state.ts` persists run data but no Bot configuration or assignments.
- `apps/cloudflare/src/user-application.ts` creates and runs the Agent outside the Bot Durable Object. This conflicts with the project constitution and is a blocker for settings-dependent execution.
- Raw model API keys currently enter runtime construction through `RuntimeModelConfig`; no backend credential broker exists.
- The authenticated User is not projected into the shell for a real profile menu.

Production settings must not be layered directly onto these temporary paths.

## Product model

### Durable ownership

| State                                                                                  | Authoritative owner                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Package artifacts, manifests, provenance, and versions                                 | Backend package registry                                    |
| User Package installations                                                             | User configuration owner                                    |
| Authorized Connections and safe metadata                                               | User configuration owner                                    |
| Credential material                                                                    | Backend secret vault/broker                                 |
| User preferences and new-Bot defaults                                                  | User configuration owner                                    |
| Bot identity, instructions, notifications, model selection, and capability assignments | That Bot's Durable Object                                   |
| Live Contributions mounted as Plugins                                                  | Reconstructable in-process projection in the owning runtime |
| Navigation, open dialogs, and form drafts                                              | Hosted client only                                          |

### New domain distinctions

The domain model should add these terms before implementation:

- **Connection Type:** a Package-declared kind of external authorization, such as Gmail, Composio, or Codex.
- **Connection:** a durable User-owned authorization for one external account. Credential material remains backend-only.
- **Capability:** Package-declared behavior made available by an installed Package, such as a model, tool set, memory provider, or notification adapter.
- **Assignment:** a Bot-owned, explicit grant selecting a Capability and, when required, a User-owned Connection.

A Package may declare multiple Connection Types. For example, a Composio Package may project Gmail and Google Calendar as separate catalog items. Therefore the Plugins UI does not need to expose one card per npm/package artifact.

Installing a Package makes its capabilities available to the User. It does not grant every Bot access. A User authorizes an account once and assigns it explicitly to one or more Bots.

A User default model is only a template for newly created Bots. Every existing Bot keeps an explicit model Assignment; changing the default never silently changes running Bots.

## UX information architecture

### Selected Bot gear

The gear is anchored at the top-right of the selected Bot workspace/right rail and always names the Bot being edited.

Initial sections:

- **Profile:** icon, name, optional label, description/instructions.
- **Model:** choose from the User's ready model Connections and supported models.
- **Notifications:** backend-owned completion/failure policy with platform availability shown separately.
- **Connections:** summary of assigned capabilities with a link to Plugins for management.

Saving uses explicit commands with revision checks. Unsaved drafts are client-only. Closing the client does not cancel an accepted save operation.

### Plugins

The bottom-left Plugins button opens a full-width modal or route with:

- searchable catalog of Connection Types and capabilities;
- categories supplied as safe Package metadata;
- installed/available state;
- connection health and authorized account count;
- detail pages for authorization, revocation, account naming, tool selection, and Bot assignment.

The screenshots' “Accounts”, “Tools”, and “Connectors” sections map to:

- **Accounts:** User-owned Connections;
- **Tools:** capabilities exposed by the Package and enabled through Bot Assignments;
- **Connectors:** Package-specific resources, represented through typed Package settings rather than core-owned arbitrary JSON.

OAuth/API-key entry is initiated here, but secrets never return in a client DTO. API keys are write-only after submission.

### Profile → Settings

The profile button opens a menu containing Settings. Application settings contain:

- User profile;
- model-provider Connections, including Codex and other model Packages;
- new-Bot model template;
- general notification preferences;
- Package installation/security views;
- authorized Connections and revocation history.

Model provider Packages contribute Connection Types, health, model discovery, and optional bespoke authorization views. The shell owns the route and navigation.

## Recommended module seams

### Hosted configuration module

Expose one deep command/query interface to HTTP, Durable Object RPC, desktop, and mobile adapters:

```ts
interface ConfigurationApplication {
  read(
    principal: UserPrincipal,
    query: ConfigurationQueryV1,
  ): Promise<ConfigurationViewV1>;
  execute(
    principal: UserPrincipal,
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1>;
  resolveBot(
    authority: BotAuthority,
    query: ResolveBotConfigurationV1,
  ): Promise<BotExecutionPlanV1>;
}
```

The discriminated query and command DTOs are versioned and decoded at every inbound seam. The authenticated `userId` is derived from server authority, never trusted from request JSON.

The interface hides:

- User and Bot Durable Object coordination;
- package and manifest resolution;
- optimistic concurrency;
- command deduplication;
- OAuth and API-key operations;
- credential storage and refresh;
- connection health;
- assignment validation;
- safe client projections;
- runtime mount-plan construction.

Avoid a universal key/value settings interface. Core concepts such as model selection, Connection state, Assignment authority, and notification policy remain typed. Package-owned settings may use a bounded JSON Schema subset.

### Backend-only internal seams

- **Package registry adapter:** immutable artifact/manifest lookup by digest.
- **Secret vault adapter:** write, rotate, lease, and destroy secrets; no generic client-visible `getSecret` operation.
- **Connection driver:** Package-owned authorize, exchange, refresh, revoke, health, and request-signing behavior.
- **User configuration port:** remote-owned port used from a Bot Durable Object to resolve a Connection and reserve an effect grant.
- **Cordis mount adapter:** reconstructs live Plugins from a resolved Bot execution plan.

Production and in-memory adapters justify these seams and allow recovery tests through the same module interface.

## Manifest evolution

Introduce manifest v3; do not reinterpret manifest v2.

Manifest v3 adds declarative, bounded definitions for:

- User- and Bot-scoped setting schemas;
- Connection Types and authorization kind (`oauth2`, `api-key`, or custom backend driver);
- Capabilities and required Connection ports;
- safe catalog metadata and categories;
- optional trusted or sandboxed client view identifiers;
- configuration schema versions and migration identifiers;
- backend User and Bot Contributions.

Executable OAuth, health, migration, and request-signing behavior remains in backend Contributions. Reject remote schema references, executable formats, secret defaults, unsupported keywords, oversized documents, and excessive nesting at manifest decode.

Legacy `runtime` Contributions migrate to backend Bot Contributions without making v2 Packages configurable automatically.

## Durable commands and state

### User commands

At minimum:

- install, update, disable, and uninstall Package;
- start, complete, cancel, and reconcile authorization;
- store or rotate a write-only credential;
- rename, validate, refresh, revoke, and remove Connection;
- update User profile/preferences/new-Bot template.

### Bot commands

At minimum:

- update Bot profile/instructions;
- update notification policy;
- assign, configure, disable, and remove Capability;
- select explicit model Assignment;
- reconcile assignments after Package or Connection changes.

Every command includes a stable command ID and expected revision. The backend returns the same receipt for duplicate delivery. Conflicting revisions produce a typed conflict response and refreshed projection.

### Observable states

External operations expose durable states such as:

- `pending`, `ready`, `failed`, `cancelling`, `cancelled`;
- `revoking`, `revoked`;
- `reconciliation-required`;
- Assignment `enabled`, `disabled`, or `unavailable`.

Revoking a Connection immediately makes new effect resolution fail closed. Dependent Bot Assignments remain visible as unavailable tombstones rather than being silently deleted or rebound.

## Execution and recovery rules

- Move Agent admission, scheduling, execution, terminalization, and alarms into the Bot Durable Object before consuming settings.
- A Turn captures a Bot configuration revision when admitted. Settings changed during a Turn apply to the next Turn.
- The Bot reconstructs its Cordis runtime and mounted Plugins from durable desired state after eviction.
- Record authorization, exchange, refresh, revocation, installation, model, and tool effect intent before external I/O.
- Each driver declares idempotency or an explicit reconciliation policy.
- OAuth state is signed, single-use, bound to User/operation, and durably admitted before redirect.
- Client disconnect detaches observation only.
- Explicit durable commands perform cancellation.
- Credentials, provider response bodies containing secrets, and secret references are excluded from client DTOs, logs, artifacts, session events, and normalized model requests.
- There is no implicit fallback to another Connection when an Assignment becomes unavailable.

## Hosted client contribution seams

The shell should own route/dialog selection and expose stable outlets:

- `frockbot.plugins.catalog-item`
- `frockbot.plugins.detail`
- `frockbot.connection.detail`
- `frockbot.settings.user-section`
- `frockbot.settings.bot-section`

Generic forms render the supported schema subset. Reviewed first-party client Contributions may supply a bespoke view by registered view ID. Untrusted/generated UI uses sandbox-view Contributions and a narrow command protocol.

These outlets augment shell-owned core sections; Packages cannot replace identity, authority, revision/conflict handling, or secret redaction.

## Vertical implementation slices

### Slice 0 — Domain and decision records

1. Add Connection Type, Connection, Capability, and Assignment to `CONTEXT.md`.
2. Clarify that User Package installation is shared availability while Bot Assignment is explicit authority.
3. Record an ADR for split User/Bot ownership, unavailable assignment tombstones, and cross-Durable-Object reconciliation.
4. Update `docs/architecture.md` to describe the target only when implemented; until then, record migration status in this plan.

**Acceptance:** terminology has one meaning; constitutional ownership and trust review is approved before feature implementation.

### Slice 1 — Put the Agent loop in the Bot Durable Object

1. Move turn admission and runtime lifecycle behind Bot Durable Object commands.
2. Persist terminal/interrupted outcomes on all failure paths.
3. Add alarms/recovery for admitted work and runtime reconstruction.
4. Make the hosted gateway an authenticated protocol adapter only.

**Acceptance:** admitted work survives request/client termination and DO eviction; failed work cannot leave a Bot permanently busy; duplicate delivery does not duplicate model/tool effects.

### Slice 2 — Durable configuration spine

1. Add versioned DTOs, decoders, typed errors, revisions, command IDs, and receipts.
2. Add User configuration authority and Bot configuration state.
3. Implement in-memory and Cloudflare adapters through the deep module interface.
4. Project authenticated User and selected Bot state to the hosted client.

**Acceptance:** User/Bot isolation, stale revision handling, duplicate commands, eviction, and browser/native protocol parity pass automated tests.

### Slice 3 — Bot settings vertical slice

1. Wire the selected-Bot gear and route.
2. Implement profile/instructions and notification policy commands.
3. Add optimistic drafts, validation, conflict recovery, loading, failure, and offline states.
4. Reconstruct Bot runtime from the saved revision.

**Acceptance:** settings survive restart/eviction; changes during a Turn affect only the next Turn; the UI never claims success before durable acknowledgement.

### Slice 4 — Manifest v3 and Package installation

1. Add strict v3 decoding and compatibility tests.
2. Add durable User Package installation desired state.
3. Retain `PackageCatalog` as a mount/activation adapter with rollback.
4. Build catalog projections from immutable manifest metadata.

**Acceptance:** install/disable/update survives eviction, retries are idempotent, activation failure rolls back live Contributions while preserving an observable durable failure.

### Slice 5 — Connections with one reference integration

1. Add secret-vault and Connection-driver seams.
2. Implement authorization operations, health, refresh, revocation, and reconciliation.
3. Build Plugins catalog/detail/account UI.
4. Add explicit Bot Assignment and enabled-tool controls.
5. Use one integration as the reference vertical slice; Composio is preferred if its provider contract is selected, otherwise use a narrow first-party test connector before Gmail OAuth.

**Acceptance:** no secret reaches client/runtime DTOs; OAuth/API-key duplicate delivery is safe; revocation immediately blocks new use; dangling Assignments are visible and repairable; the integration works without a desktop process.

### Slice 6 — Model Connections and application settings

1. Wire profile menu and User Settings route.
2. Move OpenAI-compatible credentials behind the Connection broker.
3. Add model discovery/validation through provider Packages.
4. After the separately developed Codex Connection lands on `main`, integrate it as a model Package/Connection driver; do not duplicate that implementation in this worktree.
5. Add new-Bot model template and explicit per-Bot model selection.
6. Remove raw `RuntimeModelConfig.apiKey` from the generic runtime seam.

**Acceptance:** provider Packages are replaceable without Agent-loop branches; existing Bots do not change when User defaults change; credential rotation/revocation is observable and recoverable.

### Slice 7 — Extensibility and hardening

1. Add package-defined settings migrations and rollback policy.
2. Add trusted and sandboxed bespoke settings views.
3. Add package provenance, integrity, and trust-tier enforcement for remote catalogs.
4. Add audit views without secret-bearing logs.
5. Exercise mobile and desktop progressive enhancements through the same backend commands.

**Acceptance:** package upgrades have migration/recovery tests; untrusted UI cannot access host authority; security scans prove no secrets in bundles or protocols.

## Test matrix

Every production slice adds automated coverage for:

- authenticated User and Bot ownership rejection;
- malformed inbound DTO rejection;
- optimistic revision conflicts;
- duplicate command and callback delivery;
- client disconnect and Durable Object eviction at each intent/effect/completion boundary;
- cancellation versus completion races;
- package activation rollback;
- Connection revocation racing Bot execution;
- secret redaction in DTOs, logs, events, artifacts, and model requests;
- browser, desktop, and mobile use of the same hosted protocol;
- provider replacement without Agent-loop changes;
- runtime reconstruction from durable configuration;
- explicit unavailable/failure states and repair flows.

## Migration constraints

- Keep manifest v2 readable while v3 is introduced.
- Existing immutable foundation Packages remain installed defaults until durable User installations replace the default application hash path.
- Existing environment-variable model configuration remains development-only during migration and must not become a production settings adapter.
- The Codex Connection is being built in another worktree. This worktree must wait for it to land on `main`, then integrate the landed interface rather than creating a competing implementation.
- Do not render functional production settings controls before their commands and failure states exist; unfinished surfaces remain behind an explicit prototype or feature flag.
- Do not use Cordis Plugin state, browser storage, Electron storage, or client memory as canonical settings state.

## Confirmed product decisions

1. Packages and Connections are User-owned; Bot Assignments are explicit and Bot-owned.
2. The selected Bot gear remains in the workspace header.
3. The bottom-left UI label remains **Plugins**, while cards represent Package-declared Connection Types/capabilities rather than necessarily one Package each.
4. Provider connection happens in Profile → Settings; model selection happens in Bot settings.
5. User defaults initialize new Bots only.
6. Revocation leaves visible unavailable Assignments; there is no silent reassignment.
7. Manifest configuration evolves as v3.
8. Agent-loop ownership migration is a prerequisite, not incidental settings work.
9. Composio is the first real Connection vertical-slice proof.
10. The trailing `3/ cl` in the originating request was accidental and adds no requirement.

## Remaining architecture decision

Select the Cloudflare production secret-vault/KMS adapter and key-rotation policy during Slice 5 threat modeling. This does not change the product information architecture but blocks production credential storage.

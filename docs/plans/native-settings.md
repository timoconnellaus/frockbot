# Native Settings and Models implementation

This is the C1 working plan under the native-app plan, beyond renderer parity
for existing settings capabilities (parity rows 50–51). It does not promote a
native distribution or extension catalog.

The User Durable Object remains the owner of account settings, Connections,
model choice and configuration receipts. The Bot Durable Object owns justified
Bot overrides. A settings frame is a disposable, redacted projection of those
owners and the reviewed manifest declarations. Neither renderer assigns a
setting's home or decides whether a disabled override applies.

Application settings first extract the existing manifest-to-surface policy into
one shared function. The User owner builds the versioned SettingsFrame already
declared in the wire schema. Both renderers submit stable configuration commands
to the existing receipt/revision boundary; reconnect re-reads the projection and
replays the retained command identity after uncertain delivery. Closing a screen
does not cancel a recorded write. No Computer, provider SDK, credential store or
Agent loop is involved. Model provider credentials stay on a trusted backend
authorization surface, never in a declarative Package field or Dart state.

Native pages use the shared theme, safe insets, large-text layouts, finite
feedback, named controls and explicit loading/empty/refusal/retry states. Browser
components use the same settings frame and owner commands. Package controls have
one home and disappear while disabled; their captured values remain durable.

Models now owns the permanent account choice. Custom models retains only the
justified Bot override. Provider choice is the configuration-shape rule's
explicit opt-in and installs its declared dependencies in the User owner;
Models has no generic Package enable/disable control. Plugins retains generic
Package lifecycle controls. Provider credentials stay on Models, reached from
native through a five-minute, same-User backend browser handoff.

Verification includes shared TypeScript/Dart fixtures and decoder freshness,
paired browser/native scenarios against the same User owner, duplicate and stale
commands, disabled control/override behavior, refusal containment, owner restart,
and a dependency/import review. Physical evidence and budgets are recorded in
the dated native acceptance ledger. C1 is not ready for a PR until Models and
the renderer paths form a complete slice and all required checks pass.

The chosen Models design projects `accountModel` from a separate versioned
`user-account-model:v1` record in the same User Durable Object. The existing
stored settings DTO keeps its previous exact shape; account choice, settings
revision and receipt commit in one transaction. The first write retains a
recovery checkpoint. The additional record is schema 1, and the pre-existing settings record keeps
schema 1. The previous released DTO can still decode that record; a literal
previous model resolver exercises the bounded previous RPC projection. Absence follows `platformModel`; the Custom models
Package retains only its Bot override. A forward migration promotes the old
active account choice and drops the removed Package field. Previously disabled
account choices are not activated by the migration. Bot overrides are retained
and remain inert while their Package is disabled. Runtime resolution reads this
single account value after an enabled Bot override.

The existing `/api/settings` browser projection retains its prior shape during
the client window; new settings frames project the account choice. An old client
attempting the removed account-model Package command receives an update response
before admission. The platform default remains backend-only. Choosing a provider
on Models installs its declared dependencies through one User transaction; its
credential flow opens the trusted backend authorization surface, tied to the
same User. No provider credential enters Dart. This is an extraction of existing
User authority, not a second settings store or a new Agent runtime.

Pinned RPC readers omit `view` and receive the previous exact response. Current
readers request view 2. Browser settings reads likewise select `?view=2`. This
keeps old in-flight code readable: the previous response’s fallback slot
projects the valid effective account fallback, without restoring a removed
Package field or control. New readers see separate account and platform fields; no migration runs on the Computer.

Each SettingsChangeCommand includes its frame's ownerId. Both the gateway and
User owner refuse a mismatch before admission, so a retained save cannot cross
an account switch. Native protected storage and browser account-scoped local
storage retain the exact command before dispatch; neither retries with a new id.

The recovery checkpoint, account record, settings revision and receipt commit
atomically. A fault after the account-key write rolls the entire transaction
back to the prior record; restarting and replaying commits once. These checks
qualify this settings seam, not the full generation activation/revert and
forced-eviction gates in the native-app plan.

## Constitutional review for C1

| Rule family | Implementation and verification |
| --- | --- |
| Product intent and feature rule | Existing settings rows 50–51, with native rendering explicitly beyond parity; this document defines owner, state, commands, disconnection, authority and failures. No distribution/catalog qualification is claimed. |
| Authorities and durable effects | The User owner commits configuration, account choice and receipt atomically. Commands retain their id and observed owner through lost replies. Paired workerd tests evict the owner and replay the same receipt; injected write failure preserves the prior generation. |
| One production path and explicit seams | Vue and Dart consume generated, bounded settings DTOs and use the same gateway/User methods. Real Chromium and native controller/widget scenarios complement the paired gateway suite. The local visual adapter changes only transport to the production Worker harness. |
| Configuration shape and settings surfaces | Permanent account model choice is effective with the Bot override Package disabled. Choosing a provider is the explicit model-provider opt-in; generic Package enable/disable controls stay in Plugins. Manifest facts determine each configuration home. Credentials stay on Models; non-secret provider fields use the same frame in both renderers. |
| Minimal kernel and Package composition | No C1 kernel change or provider import. Settings remains reviewed base behavior through the existing required compiled contribution. Provider dependency resolution uses manifests. Removed account-model Package state has a forward migration only; no old control is restored. |
| Self-modification and trust | No Bot authority or grant changes. Host-owned settings chrome renders reviewed declarations; unavailable fields fail in their region. Native account setup opens a same-User, expiring backend navigation intent, and never renders credentials or a Connection prompt from Bot output. |
| Computer, Workspace and Memory | No Computer call, file mutation or Memory dependency is introduced. User settings work with the Computer hibernated; this does not qualify the separate live Applet hibernation gate. |
| Integrations and secrets | Provider validation/OAuth and credential storage remain backend implementations. Dart settings imports only Flutter/UI, typed transport, protected local command storage and the system URL launcher. Its only credential-related value is a scoped navigation URL from the backend. |
| Storage and client windows | The account key is versioned separately; the previous exact settings DTO remains readable. The old model resolver is exercised against the bounded previous projection. Invalid view versions and the removed old client command receive update responses. Migration/checkpoint tests are scoped to this seam; full generation revert/activation qualification remains in the native plan. |
| Failure and recovery | Designed loading/offline, stale revision, uncertain save, invalid receipt, unavailable provider and unsupported-field states retain a next action. User failures are safe copy; durable command refusals remain inspectable. |
| Landing and rollout | Required checks, release screenshots and the dated acceptance ledger gate the C1 PR. Pixel evidence is awaiting an unlocked phone. The orchestrator owns release tags; production macOS verified sign-in remains gated by provisioning. |

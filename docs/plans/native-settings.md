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

Models needs a further extraction before it can ship: the current Custom models
Package owns both account choice and Bot overrides, but the constitution makes
account model choice permanent base behavior. The final design must keep one
account value effective with the override Package disabled, migrate previous
stored choices forward, make provider choice the installation opt-in, and keep
provider authorization on Models. Copying the existing two-step enablement flow
into Flutter would not satisfy that rule. This portion remains under design;
Application settings extraction can proceed independently.

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
recovery checkpoint. The storage window remains [1, 1]: previous code preserves
the new key without reading it, and its settings DTO remains readable. Absence follows `platformModel`; the Custom models
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
keeps old in-flight code readable while new admissions use the new account
policy; no migration runs on the Computer.

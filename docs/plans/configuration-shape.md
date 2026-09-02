# Configuration Shape Plan

## Status

Proposed, awaiting human acceptance. This plan carries the amendment to `AGENTS.md` (§ Configuration shape, § Package composition, the Feature rule, and the check list), the retirement of the Assignment term in `CONTEXT.md`, and [ADR 0019](../adr/0019-account-wide-enablement.md). No production code changes until the amendment is accepted; the constitutional gate blocks implementation while a conflict stands.

On acceptance, flip ADR 0003's front matter to `superseded by ADR-0019` and drop its `note:` line.

## What the amendment decides

- User enablement is the only grant. A Package or Connection a User enables reaches every Bot that User owns at its next admitted Turn.
- Per-Bot Capability Assignments are removed from the product, protocol, and durable model.
- Configuration only some Users need is a Package, disabled by default, and its per-Bot values are overrides of an authoritative account-level value.

## Surfaces after the change

Much of the target shape already exists on `main`: `PluginsSurface.vue` is already enablement-only, `ConnectionsSurface.vue` already owns account authorization, `ModelsSurface.vue` already owns a User-level default model, and `PackageCatalogSurface.vue` already owns Catalog browse and install. What is left is placement, the per-Bot override, and the Assignment removal.

| Surface                                                                      | Owns                                                       | Change                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connectors (sidebar slot `frockbot.sidebar-actions`, above the user profile) | Authorize, credential, enable, rename, revoke Connections  | The sidebar trigger points at the existing `connections` surface instead of `plugins`, and the surface is titled Connectors. A Connection Type with `authorizationKind: none` renders as a toggle, not a Connect button. |
| Settings → Plugins                                                           | Enable and disable Packages                                | Already enablement-only. Reached from the user settings surface and the profile menu, not from the sidebar button.                                                                                                       |
| Models, only with Custom models enabled                                      | The account model and model-provider accounts              | Contributed by the Custom models Package. Without it the platform model runs and there is nothing to configure.                                                                                                          |
| Bot settings                                                                 | Avatar, name, label, description, notifications, approvals | Loses the `bot-capabilities` Capability Assignments section entirely, and loses the `bot-model` section to the Custom models Package.                                                                                    |
| Bot settings, only with Custom models enabled                                | Model override for this Bot                                | Contributed into the `frockbot.bot-settings-sections` outlet as a Bot-scoped Package setting. Absent override means inherit. The exact-model-ID escape hatch is cut.                                                     |
| Bot versions/history                                                         | Composition generations, diffs, revert                     | Moved out of settings; it is the self-modification revert surface, not configuration.                                                                                                                                    |

`bot-capabilities` is removed from `SETTINGS_ANCHORS_V1` in `packages/plugin-shell/src/settings-links.ts`; `bot-model` moves to the override Package or is removed with it.

Capabilities enabled at signup with no credential and no cost are on by default. Workers AI already does this through its own `UserConfigurationReadBootstrap`, separate from `installByDefault`; that pattern stays.

## Model resolution after the change

The platform chooses the model. Choosing one is opt-in.

- **Flock AI** is the built-in provider (the renamed `provider-workers-ai` Package). It is first-party, present and enabled for every User from their first configuration read, with one ambient Connection. It has two modes. **Auto** is the platform default: model id `@flock/auto`, which the runtime sends to Cloudflare AI Gateway as the dynamic route `dynamic/<route>` (route name from Worker configuration, default `flock-auto`; the route's target — GLM 5.3 Flash — is gateway configuration, not code). **Manual** offers the Workers AI catalog with every `@cf/` id presented as `@flock/`, sent through the same gateway as `workers-ai/@cf/...`. Both go through the `AI` binding's `gateway(...)` method; no gateway token is stored.
- **`UserSettingsViewV1.platformModel`** (renamed from `newBotModelTemplate`; `newBotModelTemplateSource` is deleted) is the value the platform set. Only a provider bootstrap writes it; a User never does. Flock AI's bootstrap sets it to `@flock/auto`.
- **Custom models** is a new first-party Package, disabled by default, and the one switch that unlocks choosing a model. It declares two settings, both bound to the model role: `model` with `scopes: ["user"]` (the account model) and `model` with `scopes: ["bot"]` (a per-Bot override). Its client Contribution renders the Models surface content (account model picker, provider accounts) and the per-Bot override section in Bot settings. Model-provider Packages other than Flock AI (Ollama Cloud) declare a dependency on it, and enabling a Package whose declared dependency is not enabled is refused with a visible message: to connect Ollama you first switch on Custom models.
- **Resolution** is one generic core function, `resolveEffectiveBotModelV1`: the Bot-scoped model-role setting of an enabled Package, else the User-scoped model-role setting of an enabled Package, else `platformModel`. `source` is `"bot" | "account" | "platform" | "none"`. A Package setting schema may carry `role: "model"`; at most one enabled Package may declare it per scope, and the kernel never names the Package. Disabling Custom models therefore makes both its values inert without deleting them, as a property of enablement.
- **Bot-scoped Package setting values** need plumbing that does not exist: `BotSettingsViewV1.packageValues` keyed by Package id, written by a new `bot/set-package-settings` command that validates against the manifest schema exactly as `user/set-package-settings` does. `BotSettingsViewV1.model` and `bot/select-model` are deleted.
- The composer's "Choose a model" prompt and the model-setup call to action go away by default: the platform model is always ready.

## Copy

The word "durable" is an architecture term and leaves every User-facing string: status messages in the shell client, Flock's identity copy, Bot settings hints. Tool descriptions the model reads are not UI and keep their vocabulary.

## Slices

1. **Amendment** (this plan): `AGENTS.md`, `CONTEXT.md`, ADR 0019. Docs only.
2. **Remove Assignments.** Delete the per-Bot Assignment records, the `bot/assign-capability` command family, and the User-side dependency saga: claims, sequence-fenced acknowledgements, acknowledged releases, pending compensation, superseded-generation compaction, and the rule that a Connection with remaining dependents cannot be disconnected. Bot isolate bindings and `CAPABILITIES.list` derive from the User's enabled set. Resolution fails closed on a missing, disabled, or revoked Connection with a visible, repairable failure. Pre-user system: delete rather than migrate.
3. **Platform model and generic resolution.** Rename `newBotModelTemplate` to `platformModel`, delete its source flag, delete `BotSettingsViewV1.model` and `bot/select-model`, add `role: "model"` to setting schemas, add Bot-scoped Package setting values and `bot/set-package-settings`, and make `resolveEffectiveBotModelV1` resolve Bot setting, then User setting, then platform. Delete the dead `initialModel` / `initialModelBinding` / `claimInitialModelBinding` seeding paths.
4. **Flock AI.** Rename `provider-workers-ai` to `provider-flock-ai`, display name Flock AI, ids `@flock/…`, `@flock/auto` as the platform default, both modes through AI Gateway via the `AI` binding.
5. **Custom models.** New first-party Package, disabled by default. Requires new machinery: `installByDefault` hard-codes `state: "installed"` and no command can install a Package disabled, so enablement gains a declared default state, and enabling a Package refuses when a declared dependency is not enabled. Ollama Cloud declares the dependency.
6. **Surfaces.** Repoint the sidebar trigger at Connectors; strip the Capability Assignments and model sections from bot settings; drop `bot-capabilities` and `bot-model` from the deep-link anchors; the Models surface renders only what Custom models contributes; remove "durable" from User-facing copy; move Composition history to its own view.

## Checks the implementing slices add

The two new bullets in the `AGENTS.md` check list need rows in `docs/architecture-checks.md` pointing at real tests, added by the slice that implements them:

- a Connection enabled at account level is usable by every Bot of that User at its next admitted Turn, and one revoked at account level is unavailable to every Bot at its next admitted Turn;
- with a per-Bot override Package disabled, every Bot resolves the account-level value, and the overrides it captured survive re-enabling.

The existing row "— its bindings derive only from Assignments" is rewritten to derive from the User's enabled set in slice 2.

## Constraints

- Pre-user system: no migration, compatibility, fallback, dual-path, or historical-data behavior unless a current fixture requires it.
- Revocation and enablement remain durable, idempotent, and reconcilable; duplicate delivery returns the existing receipt.
- Credentials and secret references stay out of client DTOs, artifacts, session events, logs, and normalized model requests.

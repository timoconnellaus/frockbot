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
| Models                                                                       | The one model all of the User's Bots use                   | Already exists as `user-default-model`. Its meaning becomes authoritative account model rather than new-Bot template, and its copy follows.                                                                              |
| Bot settings                                                                 | Avatar, name, label, description, notifications, approvals | Loses the `bot-capabilities` Capability Assignments section entirely, and loses the `bot-model` section to the override Package below.                                                                                   |
| Bot settings, only with the per-Bot Model Package enabled                    | Model override for this Bot                                | Contributed into the `frockbot.bot-settings-sections` outlet. Absent override means inherit the account model. The exact-model-ID escape hatch goes with it.                                                             |
| Bot versions/history                                                         | Composition generations, diffs, revert                     | Moved out of settings; it is the self-modification revert surface, not configuration.                                                                                                                                    |

`bot-capabilities` is removed from `SETTINGS_ANCHORS_V1` in `packages/plugin-shell/src/settings-links.ts`; `bot-model` moves to the override Package or is removed with it.

Capabilities enabled at signup with no credential and no cost are on by default. Workers AI already does this through its own `UserConfigurationReadBootstrap`, separate from `installByDefault`; that pattern stays.

## Slices

1. **Amendment** (this plan): `AGENTS.md`, `CONTEXT.md`, ADR 0019. Docs only.
2. **Remove Assignments.** Delete the per-Bot Assignment records, the `bot/assign-capability` command family, and the User-side dependency saga: claims, sequence-fenced acknowledgements, acknowledged releases, pending compensation, superseded-generation compaction, and the rule that a Connection with remaining dependents cannot be disconnected. Bot isolate bindings and `CAPABILITIES.list` derive from the User's enabled set. Resolution fails closed on a missing, disabled, or revoked Connection with a visible, repairable failure. Pre-user system: delete rather than migrate.
3. **Account-level model.** `UserSettingsViewV1.newBotModelTemplate` already resolves dynamically for any Bot without its own model, so this is a meaning change, not a new store: it becomes the authoritative account model, `newBotModelTemplateSource` keeps its sticky `user` / `auto` behavior, and the dead `initialModel` / `initialModelBinding` / `claimInitialModelBinding` seeding paths are deleted.
4. **Per-bot model Package.** First-party, disabled by default, contributing the `bot-model` control into `frockbot.bot-settings-sections`. Requires new machinery: `installByDefault` hard-codes `state: "installed"` and no command can install a Package disabled, so enablement gains a declared default state. Disabling the Package leaves captured overrides inert but intact; re-enabling restores them.
5. **Surfaces.** Repoint the sidebar trigger at Connectors; strip the Capability Assignments section and the model section from bot settings; drop `bot-capabilities` from the deep-link anchors; move Composition history to its own view.

## Checks the implementing slices add

The two new bullets in the `AGENTS.md` check list need rows in `docs/architecture-checks.md` pointing at real tests, added by the slice that implements them:

- a Connection enabled at account level is usable by every Bot of that User at its next admitted Turn, and one revoked at account level is unavailable to every Bot at its next admitted Turn;
- with a per-Bot override Package disabled, every Bot resolves the account-level value, and the overrides it captured survive re-enabling.

The existing row "— its bindings derive only from Assignments" is rewritten to derive from the User's enabled set in slice 2.

## Constraints

- Pre-user system: no migration, compatibility, fallback, dual-path, or historical-data behavior unless a current fixture requires it.
- Revocation and enablement remain durable, idempotent, and reconcilable; duplicate delivery returns the existing receipt.
- Credentials and secret references stay out of client DTOs, artifacts, session events, logs, and normalized model requests.

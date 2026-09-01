# Configuration Shape Plan

## Status

Proposed, awaiting human acceptance. This plan carries the amendment to `AGENTS.md` (§ Configuration shape, § Package composition, the Feature rule, and the check list), the retirement of the Assignment term in `CONTEXT.md`, and [ADR 0014](../adr/0014-account-wide-enablement.md). No production code changes until the amendment is accepted; the constitutional gate blocks implementation while a conflict stands.

On acceptance, flip ADR 0003's front matter to `superseded by ADR-0014` and drop its `note:` line.

## What the amendment decides

- User enablement is the only grant. A Package or Connection a User enables reaches every Bot that User owns at its next admitted Turn.
- Per-Bot Capability Assignments are removed from the product, protocol, and durable model.
- Configuration only some Users need is a Package, disabled by default, and its per-Bot values are overrides of an authoritative account-level value.

## Surfaces after the change

| Surface | Owns | Notes |
| --- | --- | --- |
| Connectors (button above the user profile) | Authorize, credential, enable, rename, revoke Connections | Replaces the Plugins button in that position. A Connection Type with `authorizationKind: none` renders as a toggle, not a Connect button. |
| Settings → Plugins | Enable and disable Packages | Enable/disable only. No credentials, no catalog cards that also connect. |
| Settings → Model | The one model all of the User's Bots use | Account-level and authoritative. |
| Bot settings | Name, label, description, notifications | Loses Capability Assignments. Loses the exact-model-ID control. |
| Bot settings, only with the per-Bot Model Package enabled | Model override for this Bot | Absent override means inherit the account model. |
| Bot versions/history | Composition generations, diffs, revert | Moved out of settings; it is the self-modification revert surface, not configuration. |

Today's `PluginsSurface.vue` is both catalog and connected-accounts manager. It splits: the connect/credential/revoke half becomes Connectors, the install half becomes the enable/disable list in Settings → Plugins.

Capabilities enabled at signup with no credential and no cost are on by default (Workers AI is the first). This is a signup-time default, not a new concept.

## Slices

1. **Amendment** (this plan): `AGENTS.md`, `CONTEXT.md`, ADR 0014. Docs only.
2. **Remove Assignments.** Delete the per-Bot Assignment records, the `bot/assign-capability` command family, and the User-side dependency saga: claims, sequence-fenced acknowledgements, acknowledged releases, pending compensation, superseded-generation compaction, and the rule that a Connection with remaining dependents cannot be disconnected. Bot isolate bindings and `CAPABILITIES.list` derive from the User's enabled set. Resolution fails closed on a missing, disabled, or revoked Connection with a visible, repairable failure. Pre-user system: delete rather than migrate.
3. **Account-level model.** Move the authoritative model binding to the User. New Bots stop snapshotting a per-Bot model default.
4. **Per-bot model Package.** First-party, disabled by default, contributing one Bot settings control. Disabling it leaves captured overrides inert but intact; re-enabling restores them.
5. **Surfaces.** Connectors and Settings → Plugins as tabled above; strip bot settings; move Composition history to its own view.

## Checks the implementing slices add

The two new bullets in the `AGENTS.md` check list need rows in `docs/architecture-checks.md` pointing at real tests, added by the slice that implements them:

- a Connection enabled at account level is usable by every Bot of that User at its next admitted Turn, and one revoked at account level is unavailable to every Bot at its next admitted Turn;
- with a per-Bot override Package disabled, every Bot resolves the account-level value, and the overrides it captured survive re-enabling.

The existing row "— its bindings derive only from Assignments" is rewritten to derive from the User's enabled set in slice 2.

## Constraints

- Pre-user system: no migration, compatibility, fallback, dual-path, or historical-data behavior unless a current fixture requires it.
- Revocation and enablement remain durable, idempotent, and reconcilable; duplicate delivery returns the existing receipt.
- Credentials and secret references stay out of client DTOs, artifacts, session events, logs, and normalized model requests.

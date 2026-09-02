---
status: accepted
---

# The Bot is the primary path for changing its own setup

Accepted by the owner on 2026-09-02.

FrockBot will make conversation with a Bot the primary — and for most Users the only — way its setup changes: the Bot authors, installs, revises, and undoes its own Packages, Skills, and settings, immediately and without approval, and the User's whole share of the model is to connect accounts, chat, and say "undo". This follows DeepSeek Harness's experience (`docs/research/deepseek-harness-extension.md`) while closing the hole it leaves open: there, agent-authored host code runs with the process's full ambient authority and no durable record; here, every non-first-party Package runs in an isolate with only the Bot's own bindings, and every change is a recorded, revertible generation.

Authority is deliberately one-dimensional. A Bot's authority is exactly the set of Connections its User has made; a Package the Bot authors or installs holds exactly the Bot's authority, never more and never a narrower per-Package grant. Connecting is a User act performed out of band on the Connections surface; the Bot does not request, prompt for, or render a way to connect anything — it discovers a capability only after the User has connected it. A Package may make a service *connectable* (it ships the integration and a Connection Type); the User still connects it.

Relationship to ADR 0019: account-wide enablement is the authority model; this ADR adds the Bot as the primary path for change on top of it.

## Considered options

- **Per-Package capability grants with an approval card in the conversation:** narrows the blast radius of a bad Package or a prompt-injected Bot, but introduces a permission vocabulary a non-technical User must read and answer, and grant fatigue makes the answers meaningless. Rejected: the product's point is that nothing needs explaining.
- **Effect classes on tools with a User-only confirmation guard, and a scoped Computer connection:** enforceable "ask before you send", and a bounded desktop. Rejected for now for the same reason; "confirm before an irreversible external action" is a system-prompt behaviour, and the Computer connection is whole. Both can be tightened later without changing the model.
- **Approval before activation:** the safest gate and the one DeepSeek's browser half uses; removes the autonomy that makes self-modification useful. Already rejected in ADR 0011.
- **Change is free; authority is the invariant:** chosen. The Bot may change anything above the kernel for itself at will; what a change may *reach* is bounded by the Bot's Connections, which only the User can change and the Bot cannot ask for.

## Consequences

Assignments collapse from (Package, capability, Connection) to (Bot, Connection): a Package mounted for a Bot is bound to what the Bot has. The isolate's `requestAuthority` and its pending-decision records leave the Bot-facing surface; a missing Connection is `unavailable`, not a request. A Bot may install Packages from the catalog by hash under the same rules as authoring, and may revert its own setup generations; both are Bot tools. A kernel-declared required core set — the chat surface, settings and undo, the audit view, the authoring tools, and the deny-only guards — is present in every generation with first-party provenance and can never be replaced by a Bot- or User-provenance member, so the Bot cannot cut its own leash. Loop policy may execute in a loaded isolate; the loop's durable skeleton stays in the Durable Object.

Accepted trade-offs, recorded so they are not mistaken for oversights: a prompt-injected Bot or a malicious installed Package can misuse any connected account; trust in ecosystem Packages rests on catalog curation and delisting, not on a User-side wall; Bots of one User share a Computer and can read each other's files; the browser profile on the Workspace is readable by installed code. The mitigations are the isolate boundary (no credential ever reaches Package code — leases only; no network except through the Bot's own tools and Connections), fail-closed composition, quarantine, per-User quotas, hash-pinned artifacts, the required core set, full provenance in the session log, and undo. Where the log later shows a boundary is needed, it is added as an invisible platform rule, never as a question to the User.

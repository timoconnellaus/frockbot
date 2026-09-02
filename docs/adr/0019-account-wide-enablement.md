---
status: proposed
supersedes: 0003-split-account-connections-from-bot-assignments
---

# Account-Wide Enablement Replaces Per-Bot Assignments

FrockBot will make User enablement the only grant. Enabling a Package or authorizing a Connection makes it available to every Bot that User owns, at each Bot's next admitted Turn; disabling or revoking removes it from every Bot the same way. The per-Bot Capability Assignment — a second, explicit decision selecting a Capability and its Connection for one Bot — is removed from the product, the protocol, and the durable model.

This reverses [ADR 0003](0003-split-account-connections-from-bot-assignments.md), which chose shared installation plus explicit per-Bot Assignments and rejected inheritance as granting "ambient authority."

## Considered options

- **Keep Assignments, hide the UI:** the smallest change; the bot settings surface stops rendering Capability rows and enablement materializes Assignments for every Bot automatically. Rejected: it keeps the entire claim/acknowledge/release/compensate saga, the dependent-Connection lock, and a durable concept no User can see, name, or repair — complexity with no remaining reader.
- **Keep Assignments as an opt-in Package:** per-Bot least privilege becomes an advanced feature, off by default. Rejected for now: least privilege between a single User's Bots is not a boundary this system offers anywhere else, so the feature would promise isolation it cannot deliver. Reconsider only alongside multi-user or shared Bots.
- **Account-wide enablement as the only grant:** chosen. One decision, one surface, one durable record.

## Why the isolation was not real

The constitution already states that separation between a User's Bots is organizational, not a security boundary: one Computer serves all of a User's Bots, they may read each other's Workspace files, and they share the User's browser profile and User Memory root. A Bot denied an Assignment for a Connection could still reach that account's data through the shared Computer and browser profile. Per-Bot Assignments therefore bought configuration surface rather than containment. The trust boundary is, and remains, the User.

## Consequences

- Authority stays durable and inspectable without being a User decision. Every admitted Turn records the enabled Package and Connection set it ran under as part of its Composition generation, so what a Turn was allowed to do is still reconstructable after the fact.
- Bot isolate authority derives from the User's enabled set, so all Bots of one User receive the same account-wide grant. They do not share an isolate instance: `IDENTITY` and the `CAPABILITIES` props bind the User, Bot, Composition generation, and enabled set into the loader digest, and any change creates a different loader identity. Identical artifacts reuse an isolate only when those bindings are also identical.
- Enablement and revocation no longer need a distributed transaction between User and Bot authorities. The Assignment dependency saga — claims, sequence-fenced acknowledgements, acknowledged releases, pending compensation, superseded-generation compaction — is removed, along with the rule that a Connection with remaining dependents cannot be disconnected. A User may now disconnect any Connection at any time; Bots that were using it fail closed at resolution with a visible, repairable failure at their next Turn.
- Losing per-Bot least privilege is the accepted cost. A connected account is reachable by every Bot the User owns. A Bot that should not touch an account cannot be arranged by configuration; the User declines to enable that Connection, or accepts that all their Bots hold it.
- The sharpest form of that cost: a Bot-authored Package running in a non-first-party isolate now receives bindings for every Connection the User has enabled anywhere, not only what one Bot was granted. Self-modification still never widens authority beyond what the User enabled, but the blast radius of one buggy or prompt-injected Bot-authored Package is the whole account. This is accepted with eyes open, and it is why the isolate's `globalOutbound` stays disabled and no authority-request surface exists.
- Self-modification is unaffected. Bot-authored code runs with what its User enabled; a missing, disabled, or revoked Connection is unavailable and records a visible, repairable failure rather than creating a request for more.
- Per-Bot model selection survives as an opt-in Package, disabled by default, under the Configuration shape rules in `AGENTS.md`: the User picks one account-level model, and only a User who enables that Package sees a per-Bot model control. Disabling it leaves captured overrides inert but intact.
- Assignment surfaces and code are deleted rather than retained for compatibility. Existing durable records migrate forward at their read seams by dropping the removed Assignment, model, model-template, and dependency-ledger fields; the next write persists only the current shape.

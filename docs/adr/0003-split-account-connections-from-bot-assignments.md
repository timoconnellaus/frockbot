---
status: accepted
---

# Split Account Connections from Bot Assignments

FrockBot will make Package installations and Connections account-owned while each Bot owns explicit Assignments selecting the Capabilities and Connections it may use. “Connection” does not imply credentials: a Package may declare `none`, `api-key`, `ambient-native`, or `grant` authorization. Installing a Package creates shared availability, not ambient Bot authority; changing an account default only initializes new Bots, and revocation leaves dependent Assignments visibly unavailable rather than silently deleting or rebinding them.

Connection-owning backend Contributions implement the same exact dependency protocol: claim, read, acknowledge, release, and reconcile. The production-neutral User coordinator routes each operation from the durable Connection's Package identity; it neither branches on providers nor fabricates availability when an owning Contribution is absent.

## Considered options

- **Inherit all User configuration into every Bot:** simple to project, but grants ambient authority and lets User-level changes silently alter existing Bot execution.
- **Duplicate Packages and credentials per Bot:** makes authority explicit, but duplicates OAuth grants and secret lifecycle while obscuring the User's ownership of external accounts.
- **Share account installations and Connections with explicit Bot Assignments:** chosen because it keeps authorization and credential lifecycle local to the account while making every Bot's executable authority durable and inspectable.

A Connection has an immutable opaque ID and an editable presentation label. Provider and Package identifiers never double as Connection identity, so one account can create multiple work, personal, or organization Connections of the same type.

## Consequences

User and Bot authorities cannot commit one distributed transaction, so the Bot durably coordinates Assign, Replace, and Unassign as resumable sagas with idempotent receipts and a separately projected pending operation. Atomic Replace claims the new dependency, commits one local Assignment swap, and attempts to settle acknowledgment before releasing the old dependency. A definitive acknowledgment failure marks the new Assignment unavailable but still proceeds with the old release. This deliberately permits temporary dual claims, but never exposes an intermediate missing stable Assignment; a delayed old release remains visibly retrying. Connection revocation and Package disablement fail closed at resolution time and preserve unavailable Assignment tombstones for repair. Live Cordis Plugins remain reconstructable projections of durable desired state rather than configuration authority.

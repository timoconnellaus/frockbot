---
status: accepted
---

# Split User Connections from Bot Assignments

FrockBot makes Package installations and authorized Connections User-owned while each Bot owns explicit Assignments selecting the Capabilities and Connections it may use. Installing a Package creates shared availability, not ambient Bot authority; changing a User default only initializes new Bots, and revocation leaves dependent Assignments visibly unavailable rather than silently deleting or rebinding them.

Connection-owning backend Contributions implement the same exact dependency protocol: claim, read, acknowledge, release, and reconcile. The production-neutral User coordinator routes each operation from the durable Connection's Package identity; it neither branches on providers nor fabricates availability when an owning Contribution is absent.

## Considered options

- **Inherit all User configuration into every Bot:** rejected because it grants ambient authority and lets User changes silently alter existing Bot execution.
- **Duplicate Packages and credentials per Bot:** rejected because it duplicates authorization and secret lifecycle.
- **Share User Connections through explicit Bot Assignments and provider-neutral dependency claims:** chosen because Bot authority stays durable and inspectable while each integration retains its own dependency records and reconciliation.

## Consequences

User and Bot authorities cannot commit one distributed transaction, so the Bot durably coordinates Assign, Replace, and Unassign as resumable sagas with idempotent receipts and a separately projected pending operation. Atomic Replace claims the new dependency, commits one local Assignment swap, and attempts to settle acknowledgment before releasing the old dependency. A definitive acknowledgment failure marks the new Assignment unavailable but still proceeds with the old release. This deliberately permits temporary dual claims, but never exposes an intermediate missing stable Assignment; a delayed old release remains visibly retrying. Connection revocation and Package disablement fail closed and preserve unavailable Assignments for repair. Live Cordis Plugins remain reconstructable projections of durable desired state.

---
status: accepted
---

# Split Account Connections from Bot Assignments

FrockBot will make Package installations and Connections account-owned while each Bot owns explicit Assignments selecting the Capabilities and Connections it may use. “Connection” does not imply credentials: a Package may declare `none`, `api-key`, `ambient-native`, or `grant` authorization. Installing a Package creates shared availability, not ambient Bot authority; changing an account default only initializes new Bots, and revocation leaves dependent Assignments visibly unavailable rather than silently deleting or rebinding them.

## Considered options

- **Inherit all User configuration into every Bot:** simple to project, but grants ambient authority and lets User-level changes silently alter existing Bot execution.
- **Duplicate Packages and credentials per Bot:** makes authority explicit, but duplicates OAuth grants and secret lifecycle while obscuring the User's ownership of external accounts.
- **Share account installations and Connections with explicit Bot Assignments:** chosen because it keeps authorization and credential lifecycle local to the account while making every Bot's executable authority durable and inspectable.

A Connection has an immutable opaque ID and an editable presentation label. Provider and Package identifiers never double as Connection identity, so one account can create multiple work, personal, or organization Connections of the same type.

## Consequences

User and Bot authorities cannot commit one distributed transaction. Connection revocation and Package disablement therefore fail closed at resolution time and preserve unavailable Assignment tombstones for repair. Live Cordis Plugins remain reconstructable projections of durable desired state rather than configuration authority.

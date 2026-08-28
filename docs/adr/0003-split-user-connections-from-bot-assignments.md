---
status: accepted
---

# Split User Connections from Bot Assignments

FrockBot will make Package installations and authorized Connections User-owned while each Bot owns explicit Assignments selecting the Capabilities and Connections it may use. Installing a Package creates shared availability, not ambient Bot authority; changing a User default only initializes new Bots, and revocation leaves dependent Assignments visibly unavailable rather than silently deleting or rebinding them.

## Considered options

- **Inherit all User configuration into every Bot:** simple to project, but grants ambient authority and lets User-level changes silently alter existing Bot execution.
- **Duplicate Packages and credentials per Bot:** makes authority explicit, but duplicates OAuth grants and secret lifecycle while obscuring the User's ownership of external accounts.
- **Share User installations and Connections with explicit Bot Assignments:** chosen because it keeps authorization and credential lifecycle local to the User while making every Bot's executable authority durable and inspectable.

## Consequences

User and Bot authorities cannot commit one distributed transaction. Connection revocation and Package disablement therefore fail closed at resolution time and preserve unavailable Assignment tombstones for repair. Live Cordis Plugins remain reconstructable projections of durable desired state rather than configuration authority.

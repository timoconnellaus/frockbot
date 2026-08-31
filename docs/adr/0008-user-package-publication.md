---
status: accepted
---

# Publish immutable User application revisions through durable User authority

A Bot may publish a tested source snapshot and exact hosted application artifact through the built-in Package Publisher Contribution. The User Durable Object records publication intent before R2 writes or Worker Loader verification, activates only the exact content-hashed artifact after an isolated health check, and owns revision history and rollback receipts; the Sprite Git workspace remains an authoring mechanism rather than production authority.

## Consequences

Every Bot receives list, publish, and rollback tools for its User's shared application, and the hosted UI exposes the same rollback operation. Publication changes the User's active Worker Loader application hash for all Bots, while existing Bot Durable Object Agent execution remains on the compiled foundation runtime; loading user-authored Bot-runtime Contributions is a separate vertical slice and must preserve Bot-owned admission, event logging, cursors, and durable effects.

---
status: accepted
---

# Keep deployment policy in one singleton Durable Object

Deployment-wide product policy is authoritative in one `DeploymentPolicy` Durable Object addressed by the fixed name `frockbot-deployment-policy`. Its first record is `DeploymentPolicyV1`, with signups closed, and every update replaces that record with an incremented optimistic revision plus `updatedAt` and `updatedBy` provenance.

The alternative was KV. KV would make a cheap global read, but its eventual consistency cannot arbitrate two owners changing the admission policy at once. The singleton Durable Object serializes those rare commands, gives stale clients an explicit revision conflict, and keeps policy failures visible. The trade-off is one global coordination point; that is acceptable for low-volume administrative writes and small policy reads, not a precedent for routing ordinary User or Bot work through a singleton.

This state is not per-User because it answers whether a previously unknown identity may become a User at all. Putting the switch in an owner's User Durable Object would make deployment admission depend on the existence, availability, or deletion of one ordinary User and would mis-scope product policy as User data. User Durable Objects remain authoritative only for their own provisioning records; the gateway reads those records to exempt existing Users before consulting this deployment authority.

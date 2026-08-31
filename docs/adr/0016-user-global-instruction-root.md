---
status: accepted
---

# Add a User-global instruction root shared by a User's Bots

Accepted by the owner on 2026-09-01. FrockBot will give each User one `user-instructions` root at `users/<id>/skills/`, shared by every Bot that User owns, alongside each Bot's own instruction root. A Bot loads Skills from both roots. Every write to the root records its writer, as every durable-root write does. The root is written only by the Skills Package writing object storage directly, and the Computer sees it read-only — the same hibernation exception ADR 0013 grants Memory, for the same reason: a Turn that needs a Skill must not have to wake the Computer, and a single writer has no conflicts to resolve. The loadable-skill predicate accepts the owning User and that User's Bots as writers, and refuses `first-party`, `unattributed`, and any writer belonging to another User.

## Considered options

- **Copy a Skill into each Bot's own instruction root:** no new root and no new predicate, but the User maintains N copies and a Bot's own root stops meaning "what this Bot authored".
- **One instruction root shared by every Bot, writable from the Computer:** the fewest moving parts, but a shell write on the Computer is `unattributed` by construction, so a Skill authored that way could never be loaded — the root would be write-only in practice.
- **A User root with the Bot roots' bidirectional sync:** symmetric with the other durable roots, but a shared root with many writers reintroduces exactly the conflicts ADR 0013 removed from Memory, and does it on the one kind of file that carries authority.
- **A single-writer User-global root, read-only on the Computer:** chosen. It matches GrokBot, where a User's instructions apply to all of their agents, and it reuses ADR 0013's Memory rule rather than inventing a second one.

## Consequences

A Bot has instruction roots, plural, and the kernel's rule is stated over both: AGENTS.md now loads Skills from "a Bot's instruction roots — its own and its User's — written under the Bot's own authority or its User's". Authority does not widen: a Skill in the User root is loadable only because its recorded writer is the owning User or one of that User's Bots, so a Bot writing there is still writing under authority it already holds, and a Bot of another User is refused even though the Catalog may make its Packages available. The Computer's read-only view means a User editing a Skill through a shell edits nothing durable; authoring goes through `skill_write`, which passes the Workspace file surface and records real provenance. Because the Skills Package is the root's only writer, the root keeps serving Skills with the Computer hibernated, and it needs no conditional-write conflict branch.

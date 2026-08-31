---
status: accepted
date: 2026-09-01
---

# Run concurrent child Turns in Subagent Durable Objects

FrockBot will run a Bot's conversational Turns in that Bot's Durable Object, and each concurrent child Turn in a Subagent Durable Object of the same Bot. A Subagent Durable Object is the same `BotState` class addressed at `idFromName("<userId>:<botId>#task:<taskId>")`. It holds no authority: the Bot Durable Object admits the child Turn, pins the Composition generation it runs on, and records its lifecycle and terminal result. The Subagent Durable Object executes exactly one admitted `subagent` Turn per task, on the generation the parent pinned, and owns only its own Session events.

## Considered options

- **Run child Turns in the Bot's Durable Object:** no new address and no new lifecycle, but the Bot Durable Object's single-active-run invariant cannot express concurrent background children — either the invariant goes, taking the serialization the event log and cursor depend on with it, or the children are not concurrent.
- **Mint an ephemeral Bot per child Turn:** reuses the whole Bot machinery, but an ephemeral Bot mints directory identity and Assignments for what GrokBot models as a Turn, so the User's Bot list, quotas, and Assignment grants all acquire rows that are not Bots.
- **Run child Turns in a loaded isolate:** already the host for Bot-authored code, but an isolate is a cache with no durable cursor, so a child Turn could not survive eviction or be resumed.
- **A Subagent Durable Object of the same Bot, holding no authority:** chosen. The invariant stays one active run per object; the parent keeps admission, Composition pinning, and the terminal record; and nothing new appears in the directory.

## Consequences

Authority is unchanged: a Subagent Durable Object admits nothing, grants nothing, and cannot widen what its parent holds, so "The Bot's Durable Object is the authority for everything Bot-scoped" still reads true. Because a child runs on the generation the parent pinned, a Composition activated mid-flight does not reach a running child, matching the rule that an in-flight Turn completes on its pinned Composition. A Subagent Durable Object owns only its own Session events; the parent's log records the child's admission, lifecycle, and terminal result, so the parent's session stays sufficient to reconstruct what the Bot did without absorbing the child's step-by-step transcript. The address is derived, not stored, so a parent can reach a child after eviction by recomputing it from the task id.

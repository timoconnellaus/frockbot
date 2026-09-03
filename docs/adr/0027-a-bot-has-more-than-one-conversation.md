---
status: accepted
---

# A Bot has more than one conversation, and one request carries a bounded part of it

Until now a Bot had exactly one Session for its whole life. Its id was `<userId>:<botId>`, minted at the gateway on every Turn; `session/created` was appended once, when the durable event log was empty; and nothing anywhere ended a Session or started another. Three consequences followed, and testing hit all three.

The Journey 6 step "start a new conversation with the same Bot" could not be performed at all. The memory-recall proof it exists to make was confounded even when it appeared to pass: the fact the Bot "remembered" was still sitting in message history, because `deriveMessages()` re-sends every `user/message`, `assistant/message` and `tool/result` in the log on every step, and `turnScopedMessagesV1` — the Package policy that narrows a request — filtered by turn type and truncated nothing. And the log itself is one Durable Object value that `persistRunEvents` rewrites in full on every flush, so a long-lived Bot gets quadratically slower and eventually hits the 2 MiB per-value ceiling, at which point every Turn on that Bot fails permanently with no repair.

## Considered options

- **Compact the one Session in place** — summarise old Turns into a preamble and drop them. Rejected as the primary move: it is a good thing to have later and a bad thing to have only. It does not give the User the action they are asking for ("start fresh"), it makes the durable log lossy, and a summary the User never asked for and cannot see is exactly the kind of silent behaviour change the session-event log exists to prevent.
- **Delete the log on "new conversation."** Rejected: the earlier conversation is the User's, and the audit view and the Turn record are built on those events. Nothing durable is deleted by a UI action.
- **A separate Session Durable Object per conversation.** Rejected as far more than the problem needs: the Bot object is already the authority for admission, the event log, and the run index, and a conversation is a boundary within them, not a new object.
- **Number the Session, keep every Turn.** Chosen.

## Decision

**The Bot Durable Object owns which conversation its chat Session is on.** A durable `conversation` record holds an ordinal, starting at 1. The Session id a chat Turn records is the base id for conversation 1 and `<base>#<ordinal>` after that. The first conversation is deliberately the bare id: every Session already on disk is conversation 1 and nothing has to be migrated for it to be one.

**The client does not name the conversation.** The gateway keeps sending `<userId>:<botId>`, exactly as it did; the object rewrites that one id — and only that one — from its own durable state before admission. A Routine's `routine:<id>` and a subagent's Session are not conversations and are never rewritten.

**Starting a new conversation empties the log the next Turn derives from, and deletes nothing.** The `latest-events` value is reset; `run:<id>` still holds every event of every Turn, and the run index still holds every run. The boundary is recorded in a bounded conversation index, so a conversation is listable even when its runs have aged out of a page. `session/created` is appended again by the ordinary path — the log is empty, which is what that event has always meant.

**It is refused while a Turn is admitted.** The log a running Turn is appending to is not something a click may pull out from under it. The refusal names the reason and the composer's button is disabled while a Turn runs, so this is a guard, not a race the User can lose.

**The transcript is one conversation.** `listRuns` filters by the Session id of the conversation the Bot is on, or of the conversation the caller names. Because the run index is ordered by admission time and the boundary is a point in it, the current conversation's runs are contiguous at its head: filtering ends a page, it never strands one.

**Memory is untouched, and that is the point.** A new conversation is what makes the Memory claim provable: the facts come back through the injected Memory block on a Turn whose history contains nothing, rather than through message history that was never trimmed.

**One request carries a bounded amount of history.** `turnScopedMessagesV1` — already the single choke point, and already where "what enters a model request is Package policy" lives — now takes a character budget, defaulting to 150k. The current Turn is always carried whole; older Turns are added newest-first until the budget is spent. Eviction is **by whole Turn**: a tool result whose call has been dropped is a malformed request to every provider, and a Turn is the smallest unit that always holds both. When any Turn is dropped, a plain notice stands where they were, saying how many are missing and that they are not summarised — a model that cannot see the start of a conversation and is not told so will answer as though it could.

The budget is in characters, not tokens, on purpose. Its job is to stop a request growing without bound; it does not need to agree with any provider's tokenizer to do that, and a tokenizer in the loop would be a provider detail leaking out of the provider Package.

## Consequences

- A Bot's context and its per-Turn write amplification are bounded by the conversation, not by its lifetime. The 2 MiB wedge is now reachable only within one conversation, and the budget makes reaching it far slower.
- An old conversation stays readable and is named by its Session id. The client ships the action and the current conversation; a fuller history picker is a UI addition on the same list, not another decision.
- The exact history each Turn ran on remains reconstructable: the narrowing is deterministic from the durable log, and the `model/request` event still records the exact normalized request.
- A conversation ordinal past 1 changes the Session id a Turn records, so a reader that assumed `sessionId === "<userId>:<botId>"` now sees a suffixed id. Nothing durable is rewritten by the change.

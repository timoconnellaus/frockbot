---
status: proposed
---

# A Running Turn Is Observed, Not Held Open

The Bot-state channel carries a second topic, `runs`, appended whenever a durable write lands on a run record. A browser that receives one re-reads `GET /api/bots/:bot/turns`. Every client also observes a non-terminal run it holds to its terminal state, whether or not it has a socket.

## What was wrong

A Turn's transcript reached the browser as the body of one long-lived `POST /api/bots/:bot/turns`. That reply is one client's copy of the answer, and nothing else carried it. So a reload mid-Turn, a second tab, or a dropped request meant the reply never appeared: the durable run completed, `activeRunId` cleared server-side, and the page sat on a spinner until somebody reloaded a second time. The tab that sent the message could not even offer Stop, because nothing told it the run had started.

The live channel that would have carried this already existed — durable append, bounded replay, hibernation-safe sockets, a reconnecting browser client — and carried exactly one topic, `computer`, consumed by one Package.

## The decision

`BotStateTopicV1` becomes `"computer" | "runs"`. Frames stay what [the channel already is](../../apps/cloudflare/src/bot-state-channel.ts): **invalidations, not authority**. A `runs` frame says only that this Bot's run records moved; the client's answer is to read the projection it already reads on load. No transcript content crosses the socket, so there is no second copy of a Turn to keep consistent and the one-bubble-per-send contract is untouched.

The authority is not told it is observed. The Durable Object hands it `BotStateChannel.observeRuns(state)` in place of its raw state, a facade that notices committed writes to `run:`, `run-index:`, `active-run` and `pending-run` and appends one coalesced invalidation after them. The kernel keeps writing storage the way it always did.

The notice is deliberately **outside** the caller's transaction, unlike the Computer topic's. An observer notice must never be able to fail an authoritative write. The price is that a rolled-back transaction can still emit one, which costs a client one redundant read — the same cost as its next poll.

## Considered options

- **Stream the transcript over the socket.** Rejected for now: it makes the socket a second authority for conversation content, and every reconnect then needs a consistency story the invalidation model does not.
- **Poll only, no channel.** Kept, but as the floor rather than the ceiling: a client with no socket still converges, at a 250 ms → 5 s backoff. On its own it is slow and it is load the channel does not need.
- **Push run state from the kernel.** Rejected: the kernel would have to know about observers. The facade keeps that knowledge in the Durable Object where the channel already lives.

## Consequences

- A client older than this change rejects a `runs` frame as an invalid frame and falls back to polling. It still converges; it is only slower. Client and Worker ship together, so this is a rollback property, not a steady state.
- Run writes are frequent — admission, every session flush, settlement — so notices are coalesced: one in flight at a time, with the burst behind it collapsed into a single follow-up. The channel's retention of 64 events is unchanged, and a client that falls behind it is reset and re-reads, which is the same answer it already had.
- Partial assistant text still does not stream. `responseText` is written only when a run completes, so a running Turn shows the animated avatar, the user's message, and a chip per tool call — which is the durable run's own event journal — and the text arrives when the Turn settles. Streaming text requires accumulating `assistant/chunk` onto the non-terminal run record, which is a change to the run record's shape and is deliberately not in this one.

  **This last point no longer holds, and it needed no new run-record field.** Every `assistant/chunk` the kernel appends already lands on the run record, so the words were durable all along and only the projection was withholding them: a running run now projects `ClientRunV1.partialText`, the same accumulation an interrupted Turn's outcome text is read from, and the thread draws it in the bubble the settled answer will occupy. Nothing about this channel changed — a `runs` frame is still an invalidation and still carries no transcript content — except that the burst is now spread to at most one notice per 250 ms after the first, because a streaming answer writes the run record once per token and an observer only ever needed to know that it should read again.

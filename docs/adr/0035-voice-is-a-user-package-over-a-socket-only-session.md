---
status: accepted
---

# Voice Is a User Package over a Socket-Only Session

FrockBot has two voice capabilities: composer dictation and an app-wide live
assistant. They share a per-User `VoiceSession` Durable Object and the
platform's realtime provider transport, but they do not share product
authority. Dictation produces an ordinary editable chat draft. The assistant
is a first-party, User-scoped **Voice Package**, not a Bot and not another
Agent loop.

This records decisions D1–D10 from the accepted Voice plan. Slice A landed the
dictation half, B0 landed the agent lane, and B1 lands the Voice Package core.
B2 remains the effectful ask-and-deliver workflow.

## Authority and durable state

The User Durable Object owns the assistant's durable ledger, on/off state,
pending answers, per-Bot briefing cursors, and the per-User cost budget. Its
ledger records text and tool calls, never audio. The intended commands are
`voice/ask`, `voice/answered`, and `voice/briefed`; intent is written before an
agent Turn is dispatched, and a stable ledger id is the idempotency key.

The Bot Durable Object remains the only authority for a Bot-scoped Turn. A
Voice question is an `agent` Turn in that Bot, pinned to a Composition and
recorded in its ordinary Session. It queues behind `user` work and never
supersedes it. The first `send_to_user` text from that Turn is the answer and
the transcript exposes the question with a `via Voice` marker. B0 establishes
the same route for `bot_message`, using a `via <Bot>` marker, so B2 adds no
second execution path.

The `VoiceSession` Durable Object owns no product state and no authority. Its
browser leg is a hibernatable socket proxy and its server-side upstream leg
connects to Gemini Live. It may hold sockets, timers, and transient audio
buffers, and may relay a resumption handle; the durable handle itself is in the
User Durable Object. Every durable fact is written through that object. This
is the Subagent Durable Object rule from ADR 0017 applied to transport: losing
the proxy can lose a live audio moment, but cannot lose a question, an answer,
an entitlement, or a budget decision.

## Provider and credential path

OpenAI and Google realtime sessions use server-side platform credentials. The
transport prefers the direct `OPENAI_API_KEY` or `GEMINI_API_KEY` Worker secret,
then uses the platform's `flock` AI Gateway BYOK key and
`cf-aig-authorization`. Cloudflare's current realtime routes are `/openai` and
`/google`; the accepted plan's `/google-ai-studio` name is the provider-native
REST route, not the documented realtime WebSocket route. No provider credential
or opaque credential lease reaches a browser, a Bot, or the Computer.
Browser-direct tokens are not an allowed second product path. A User-supplied
provider override, if wanted later, is a separate disabled-by-default Package
and does not turn the ambient provider into a Connection prompt.

Dictation uses an OpenAI Realtime transcription session with
`gpt-live-transcribe`, because it streams transcript deltas and `whisper-1`
does not. The assistant uses `gemini-3.1-flash-live-preview`, PCM16 mono input
at 16 kHz, PCM16 mono output at 24 kHz, Gemini VAD, barge-in,
context-window compression, and session resumption. A `goAway` opens a
replacement upstream socket using the latest User-owned resumption handle. The
gateway routes still require a real deployed smoke test before either upstream
claim is treated as proven.

Cost is bounded in authoritative User state. Dictation has one 60-minute daily
allowance; the assistant has one 60-minute monthly allowance. Neither has a
setting. Both meters charge idempotently by cumulative session total rather
than repeated deltas. Each new total settles quota KV and the Billing SQL row
inside one User Durable Object `transactionSync`. Dictation keeps its published
OpenAI duration price. Gemini bills live audio in tokens, not elapsed seconds,
so B1 records exact assistant seconds under
`google-ai-studio/gemini-3.1-flash-live-preview` with `unknownPrice: true` and
zero guessed cost. A later token receipt can price it without moving authority
into the socket object.

## Product behaviour

Dictation is draft input, not a conversation of its own. Transcript deltas go
through `ComposerDraftStore`, remain editable, and survive a refused send. Bin
discards the draft. Send commits the audio buffer, waits for transcription
completion, then invokes the ordinary chat send; if a Bot is working, ADR
0024's explicit `supersedes` command applies exactly as it does to typed text.

The assistant is one live session per User. The newest device wins; observer
sockets are deferred. An explicit shell-chrome toggle starts and stops it, and
two minutes of silence takes it offline automatically. A disconnect detaches
the browser observer without cancelling the live upstream. The B1 kickoff asks
Gemini to check the durable pending-answer table first. B2 will fill that table
and add notification plus live-session delivery when a Bot answers.

The B1 assistant tools are read-only `list_bots`, `bot_activity`,
`memory_search`, and `pending_answers`. `bot_activity` and Memory reads are
bounded projections of durable state and wake no Computer. The transport calls
a table-driven tool seam; B2 extends that table with `ask_bot`, the one
effectful tool, which writes the User ledger first and may address only a Bot in
that User's Flock. Routines and Computer captures are deferred.

The Voice surface renders current-session history, plain-language tool use,
quota, and visible failures from the User-owned ledger. The Voice Package fills
one declared shell slot for the global toggle. Dictation stays in the composer
owned by the Shell Package. There is no per-Bot voice control and no duplicated
setting. Browser is the complete path; Android `RECORD_AUDIO` and iOS
`NSMicrophoneUsageDescription` let their hosted WebViews request the same
browser microphone path.

## Failure, retry, and recovery

Quota exhaustion, upstream refusal, and failed resumption settle the B1 session
as durable visible outcomes, not socket logs. In B2, unanswered questions and
failed answer delivery join that ledger, and a retried `ask_bot` reuses its
ledger key and deterministic agent run id. Bot
execution uses the existing durable cursor, effect admissions, cancellation,
and reconciliation rules. Agent-lane admission is bounded to eight outstanding
Turns per User and a FIFO of 32 pending agent Turns per target Bot; the former
is a User Durable Object lease and the latter is Bot Durable Object state.

Turning Voice off is an explicit command. It closes or idles the socket but
does not cancel a Bot Turn. A User may still stop a visible Bot Turn through
the Bot's ordinary authenticated control. Neither a browser refresh nor a
`VoiceSession` eviction implies cancellation.

## Consequences

- The live assistant cannot write Memory in v1 and cannot silently acquire a
  Bot's broader tool authority. It reads durable projections and asks a Bot
  when Agent work is required.
- Voice does not add a second model loop to the kernel. The Gemini session is
  Package-owned realtime orchestration; text-model Turns stay in Bot Durable
  Objects.
- Questions asked on a User's behalf are visible in the target Bot's thread.
  Convenience never creates hidden instructions.
- The Computer remains hibernated for Voice, Memory lookup, activity lookup,
  and Bot questions unless the Bot itself chooses a Computer tool during its
  admitted Turn.
- Both voice capabilities are beyond GrokBot parity. Bot-to-Bot messaging is
  the reinstated parity subset of register row 57f; Voice's use of the same
  lane is beyond parity.

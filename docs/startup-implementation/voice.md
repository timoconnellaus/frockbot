# Voice recovery and opening

Read the [common rules](README.md). S3's voice work owns bounded recovery; S6 owns opening, readiness, buffering and resumption. Keep `VoiceAssistant extends Agent`, its public scheduler, Gemini Live and the existing Bot delegation interface.

## S3: Voice recovery

**Entry points:** `onStart`, `startCall`, `releaseCall`, `abandonVoiceCall`, `beginMemoryFinalization` and `deliverCallTranscript` in [voice-assistant.ts](../../apps/cloudflare/src/voice-assistant.ts); [ledger.ts](../../app/voice/ledger.ts) and [memory.ts](../../app/voice/memory.ts).

Extend the voice storage adapter with transactions and bounded ordered lists. Implement rollback in its test adapter. Store point records and indexes, not growing arrays:

```text
work:<kind>:<id> -> domain record ref, callId, botId, state,
                  nextAt, attempts, claimActivation, lastError
pending:<padded due time>:<kind>:<id> -> work key
active:<paid-work-kind>:<id> -> call/job/request ID, activation
call-turn:<callId>:<padded sequence> -> turn record
activation -> current activation UUID
```

Use one active slot only where the code enforces one in-flight operation; otherwise use a bounded active index. Domain payloads remain on their owning records. Update pending/active index entries in the transaction that changes the record. Index nonterminal delegations and source pins as well as Memory jobs.

1. Make `onStart` read only current ownership, indexed active paid work and required admission state. Fence uncertain work from the previous activation before a scheduler/new execution can act. New-activation work must not be marked abandoned by delayed old recovery. No historical enumeration or Bot RPC belongs here.
2. For call end/replacement, atomically seal the final sequence and stable `endedAt`, create transcript and Memory finalization obligations, pin the source and clear/replace current ownership. A projection of old history is not needed to make these intents durable.
3. Deliver transcript using the same call ID and sealed source range. Preserve the Bot receiver's call-ID deduplication. Acknowledge completion and release the source pin only after receipt; lost acknowledgement leads to the same keyed delivery. Retention waits for both transcript and Memory consumers.
4. Process retention, delegation reconciliation and delivery through due indexes in bounded batches. Preserve existing Memory chunk/time/spend limits. A paid request found uncertain is recorded as such; it is not retried as if no request happened.
5. Preserve main's 60-second live and rolling 24-hour paused rejoin windows. Schedule abandonment from the record's actual deadline, with fresh ownership/last-seen checks when it fires. Keep daily quota rollover independent of rejoin expiry. Paused re-admission remains Gemini-asleep.

### Crash-safe SDK scheduling

Use public `this.schedule`; preserve SDK alarm ownership and avoid writing its internal tables. The application's durable pending records say what is owed. An SDK callback supplies a future attempt to drain them.

Use **pre-armed callbacks** because application KV and SDK schedule rows are not one transaction:

1. Under a short local producer/drain-claim mutex, await scheduling a future drain with a unique wake token.
2. Commit the obligation and associated call transition atomically.
3. Release the mutex. A callback that arrived early waits for that section, then reads pending work. It must not finish on an empty queue between steps 1 and 2.
4. Under the same mutex, stop without a successor only when there are no pending, future-due or claimed unfinished obligations. Otherwise pre-arm a distinct successor before claiming work, using the earliest due/recovery deadline. Claimed external work retains a recovery deadline even if a callback fires while it is still running. Perform external operations after releasing the mutex. A successor finding no remaining obligations stops the chain; do not keep an empty account awake indefinitely.
5. Recheck activation/claim and source revision before applying a result. A callback for an obsolete call cannot clear or mutate its replacement.

A crash before the mutation leaves a harmless callback; a crash after it leaves a durable wakeup. Test both sides and scheduler callback consumption. Never deduplicate a successor onto the schedule row currently being consumed. If the pinned public SDK cannot preserve this ordering in a workerd test, report the exact failing sequence for review; do not replace it with an untracked post-commit schedule.

Engineering defaults: at most eight local due records and one external operation per invocation, then yield; local reduction budget 100 ms; immediate continuation after two seconds; delivery backoff 2, 4, 8… seconds capped at 300 seconds. Keep failed required deliveries pending with visible error state and retained source. These constants govern fair scheduling, not startup latency promises. Memory model failures use their existing effect policy, not this delivery retry loop.

**Done when:** startup reads do not grow with historical backlogs; eviction around schedule/commit/claim/RPC/acknowledgement loses neither transcript nor wakeup; duplicate delivery creates one transcript; old claims cannot affect new calls; bounded maintenance progresses without a user request. Test empty-queue quiescence and eviction while a slow operation outlives its successor callback.

## S6: Opening lifecycle

**Entry points:** `onMessage`, `onCustomMessage`, `startCall`, `openSession`, `wakeSession`, `applySwitch`, `onSessionClosed` and `GeminiSessionV1` in [voice-assistant.ts](../../apps/cloudflare/src/voice-assistant.ts); [voice shared protocol](../../app/voice/shared.ts), [Gemini encoder/decoder](../../app/voice/gemini-live.ts), [upstream socket helper](../../apps/cloudflare/src/voice-dictation.ts); Flutter [assistant](../../apps/native/lib/voice/assistant.dart), [protocol](../../apps/native/lib/voice/protocol.dart), speech gate and player.

### Opening attempt and controls

Introduce one attempt owner for initial open, wake, rejoin, handover and server-initiated rotation. Allocate its slot synchronously before the first await:

```text
OpeningAttempt
  id, connectionId, owningCallId?, botId
  phase: admitting | preparing | configuring | ready | closed
  cancelled, AbortController, shared completion promise, session?
```

Use an atomic opening command carrying target and current pause/mute intent, instead of relying on a target frame racing ahead of `start_call`. Recommended assistant-specific protocol:

```text
voice/open       {attemptId, mode:start|wake|rejoin|control, botId, callId?, paused, muted}
voice/admitted   {attemptId, callId, paused, muted}
voice/ready      {attemptId, callId}
voice/open-failed{attemptId, code}
voice/control   {attemptId, sequence, action:pause|mute|end, muted?}
voice/control-ack{attemptId, sequence}
```

Keep welcome/status/transcript display messages. Update TypeScript and Dart decoders/tests together and retire replaced assistant admission paths. Dictation's separate protocol is outside this change; avoid modifying its shared codecs accidentally.

- `admitted` means durable ownership; `ready` means this attempt's Gemini setup acknowledged. `listening` can describe a paused call with no Gemini, and “frame sent” is not a server acknowledgement.
- Duplicate commands for the same attempt join its promise. A newer accepted attempt cancels its predecessor. Recheck identity/ownership after every await and in every provider callback.
- Accept pause/mute/end against the pending attempt before `LiveCall` exists. Mark cancellation immediately; serialize the durable control outcome with admission, without awaiting prompt/provider setup. Keep only the latest control sequence/state needed for idempotency; ordinary mute does not need a general external-effect journal. Acknowledge durable state, not receipt of a frame.
- End retains a bounded terminal outcome/call receipt so control-only reconnection can acknowledge an already ended call. That path never creates a replacement conversation or paid session. Preserve the existing hang-up retry when the OS dropped a paused socket.
- A server-initiated new attempt is announced to the client before readiness. Old close/setup/failure callbacks cannot clear or revive a newer session. Keep inbound and outbound PCM tied to the correct attempt.

### Preparation, connection and cancellation

Split `GeminiSessionV1.start` into transport establishment and setup. After safe admission/target resolution and release of any displaced upstream, prepare the complete prompt and establish the transport concurrently. Attach error/close handlers immediately; send setup once both finish. Send audio, text and tool responses only after setup acknowledgement.

Use a named overall server opening deadline, initially 10 seconds, kept below the existing client startup timeout. It covers preparation, connection and setup together. Inject clock/timers in tests. Add cancellation to the assistant's upstream socket call and close a late socket even if upgrade cancellation cannot stop its arrival. Paused/muted/control-only rejoin can be admitted without opening Gemini.

The provider must accept a bounded wait between socket establishment and setup. Verify that contract against the pinned bridge and official protocol during implementation. If unsupported, retain serial transport setup while keeping the rest of this lifecycle; report that specific deviation. Readiness/cancellation cannot depend on an assumed unlimited pre-setup wait.

### Audio ordering

Retain processed outbound speech on the client until its matching `voice/ready`. Include wake pre-roll and unsent opening/rejoin audio under one bound. Keep the current ten-second PCM16 opening budget (320,000 bytes at the current input format), derived from format constants rather than duplicated magic numbers. Apply pause/mute/echo policy before enqueueing.

On readiness, drain in order before live frames. On cancellation, discard that attempt's queue. On overflow, cancel the opening and present an explicit retry outcome; never silently remove the first words. Keep the server's setup buffer only as bounded defense.

Use an assistant-only binary envelope for PCM in both directions: format version, 16-byte attempt UUID, unsigned 32-bit sequence, then PCM bytes. Specify byte order and validate alignment/length. Drop wrong-attempt/duplicate frames before metering or playback; a sequence gap produces a defined interruption/retry outcome. Reset counters per attempt and start a fresh attempt before wrap. This guards already-in-flight audio around handover. Never replay audio already transmitted upstream after reconnect.

### Durable Gemini resumption

Store a call-owned record with `callId`, Bot/model identity, stable setup fingerprint, latest handle, `resumable`, updated time and last settled voice-Turn sequence. The fingerprint covers semantic setup identity/tool/instruction policy and destructive Memory invalidation, not incidental clock strings. Persist the provider's `resumable:false` updates as well as new handles; the current decoder must be extended to retain that signal.

Offer a handle only for matching call/setup ownership and reconciled effect state. Keep tool/delegation identities durable before dispatch. If the provider might replay an exchange whose outcome cannot be reconstructed safely, discard the handle and use bounded ledger continuity with explicit uncertainty. A handle alone proves no effect outcome.

Retain eligibility across transient socket loss and pause; invalidate on end, supersession, Bot/model/semantic setup mismatch or withdrawn injected Memory. Missing/rejected handles get one fresh opening with bounded continuity. Paused rejoin waits for wake. Use the existing call windows; do not invent a provider handle TTL. Handles remain server-side and out of logs/client state.

### Acceptance and preservation

Implement S3 durable indexing/outbox first; then attempt/control protocol, client/server buffering, parallel transport, and durable resumption. Use controlled fakes in voice ledger/Memory tests, `apps/cloudflare/test/voice-assistant.workerd.ts`, native protocol/assistant tests and `voice_start_replace_test.dart`.

Delay admission, prompt, transport and setup independently. Exercise immediate speech, Resume/mute/pause/end during each wait; duplicate opens; control-only hang-up; old callbacks/PCM; overflow; replacement; disconnect/eviction; valid, rejected and unsafe handles; paused expiry and no-metered-upstream rejoin. Verify a committed response Turn still precedes forwarding its first output audio.

Preserve Silero's asynchronous preparation, fallback/reset/disposal, existing pre-roll, AEC-dependent barge-in, continuous awake streaming, route-before-device setup and chunked playback. Preserve the once-per-call local connection chime and realtime composer hang-up. The chime is not first model response evidence.

**Done when:** every opening path uses the same attempt contract, speech is retained through readiness, cancelled work cannot open a late paid session, controls survive opening races, and rejoin/resumption respects ownership and uncertain effects. Required protocol/stored-state cleanup and native release coordination belong to the task report.

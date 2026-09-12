# Voice

Two voice features, two transports, one credential rule: provider keys never
leave the Worker.

| Feature                                 | Route                                | Server                                                                    | Providers                                                                                                                   |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Composer dictation (one Bot's composer) | `GET /api/voice/dictation` WebSocket | Worker-level relay, `apps/cloudflare/src/voice-dictation.ts`              | OpenAI Realtime transcription, model `gpt-live-transcribe`                                                                  |
| Continuous voice session (all Bots)     | `GET /api/voice/assistant` WebSocket | `VoiceAssistant` Durable Object, `apps/cloudflare/src/voice-assistant.ts` | OpenAI Realtime transcription, model `gpt-transcribe` with server VAD → Frock AI gateway (chat) → ElevenLabs Flash v2.5 TTS |
| Capability probe                        | `GET /api/voice/capabilities`        | Gateway                                                                   | —                                                                                                                           |

Both WebSocket routes are authenticated exactly like `/api/bots/:id/state-channel`:
the browser's better-auth cookie, or the native app's `Authorization: Bearer
frockbot-native.…` header on the upgrade request. The gateway resolves the User
and forwards the upgrade with `x-frockbot-user-id` set by itself; nothing below
the gateway re-verifies and nothing below it is reachable another way. There is
no `/agents/*` route.

The pure parts — protocol decoders, the durable ledger, the speech gate, the
context assembly, the realtime upstream vocabulary and both transcription
adapters — live in `app/voice/` and
import no Cloudflare SDK. The two Worker modules above are the adapters.

## Capabilities

`GET /api/voice/capabilities` → `{schemaVersion: 1, dictation: boolean, assistant: boolean}`.

- `dictation` is true when `OPENAI_API_KEY` (or the test override
  `VOICE_DICTATION_UPSTREAM_URL`) is set.
- `assistant` is true when `ELEVENLABS_API_KEY` is set and the `AI` binding
  exists.

Both keys are **required production secrets**: a release without them fails
the secrets gate, because the hosted product must work with zero User
configuration. The controls are always shown. In a deployment where a key is
absent (a local stack without `.dev.vars` entries), pressing a control shows a
one-line actionable message — "Voice isn't set up on this deployment" — rather
than hiding the agreed UI. Clients read the probe once after sign-in so that
message appears on press without a failed socket.

## Dictation protocol (v1)

Client connects, then sends one text frame before any audio:

```json
{ "schemaVersion": 1, "type": "start", "sampleRate": 24000 }
```

Then binary frames: PCM16 little-endian, mono, 24 kHz, any frame size (the
web client sends 32 ms = 1536 bytes). Audio sent before the server says `ready`
is buffered server-side in order (bounded at 30 s; older audio is dropped
oldest-first and the drop is reported once as `notice`) and forwarded once the
upstream session is open, so the first words are never lost.

Client control frames:

```json
{ "schemaVersion": 1, "type": "stop" }
```

`stop` commits the capture upstream — the only thing that produces a
transcript — waits for it (bounded at 6 s), then the server sends `final` and
closes. Closing the socket without `stop` abandons the capture: nothing is
committed, so nothing is transcribed, however long the person spoke.

Server frames:

| Frame                                          | Meaning                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `{schemaVersion:1,type:"ready"}`               | Upstream accepted the session; buffered audio has been forwarded.                         |
| `{schemaVersion:1,type:"delta",text}`          | Interim text so far, about half a second behind the speaker. Replaces the previous delta. |
| `{schemaVersion:1,type:"segment",text}`        | The transcript of a committed item — in practice one per capture, at `stop`.              |
| `{schemaVersion:1,type:"final"}`               | Everything captured before `stop` has been transcribed. The server closes after it.       |
| `{schemaVersion:1,type:"notice",message}`      | Non-fatal: opening audio was truncated, and similar.                                      |
| `{schemaVersion:1,type:"error",message,code?}` | Fatal; the server closes. `code` ∈ `unconfigured`, `upstream`, `timeout`, `limit`.        |

The composer draft is `segments.join(" ") + " " + delta`. Stop flushes into an
editable draft and never sends. The draft belongs to the Bot the capture started
on: the client binds the capture to the composer context at start and writes
only to that context's draft, so switching Bots mid-capture never writes into
another Bot's draft.

A capture is one upstream item: deltas accumulate against it while the person
speaks and the relay's commit at `stop` closes it, so the ordinary capture
produces exactly one `segment` and then `final`. The relay still hands
segments over in committed order and waits for every committed item, which
costs nothing and holds if a provider ever commits more than one. A provider
failure after `stop`, or a stop the provider cannot finish within 6 s, is
reported as `error` (`upstream` or `timeout`) with the words that did arrive
already in the draft; the one refusal that is not a failure is the provider
saying the final commit had nothing in it.

Bounds: after 5 minutes the server ends the capture the way a `stop` does —
the commit, then the segment, so the draft keeps everything captured — and
closes on `error` with code `limit` ("Dictation stopped after five minutes.
Press the microphone to continue.") in place of `final`, which is what the
person sees. A commit the provider cannot finish within the 6 s final timeout
is still reported as `timeout`. An upstream that has
not accepted within 10 s is reported as `timeout`. Before the provider is
opened the relay takes the account's dictation lease from the voice object:
one capture at a time per account, 60 s of provider time booked ahead and
renewed every 30 s while the capture runs, refunded for the part not used on
release, and refused (`error` with code `limit`) when the day's 120 minutes
are spent or another capture holds the lease.

The model is `gpt-live-transcribe` and `turn_detection` is `null`, and neither
half is a preference. The streaming transcription models — this one and the
`gpt-realtime-whisper` dictation used to ask for — refuse any turn detection
with "Turn detection is not supported for this transcription model." and the
session ends there; that is why no capture in production ever reached `ready`.
The models that accept VAD (`gpt-transcribe`, `gpt-4o-transcribe`) hold their
deltas until the turn commits and then send them all at once, and live text as
the person speaks is the point here. The field is
sent explicitly because the server otherwise defaults it to `server_vad`.
Upstream session shape (verified against the live OpenAI endpoint,
2026-09-11):

```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "noise_reduction": { "type": "near_field" },
        "transcription": { "model": "gpt-live-transcribe" },
        "turn_detection": null
      }
    }
  }
}
```

Audio goes up as `{type:"input_audio_buffer.append", audio:<base64 pcm16>}`,
`stop` sends `input_audio_buffer.commit` — answered by
`input_audio_buffer.committed` and then the item's `.completed` within about
half a second — and the relay maps
`conversation.item.input_audio_transcription.delta` → `delta`,
`…completed` → `segment`, `error` → `error`. The upstream URL is
`wss://api.openai.com/v1/realtime?intent=transcription` with
`Authorization: Bearer $OPENAI_API_KEY`.

## Assistant protocol (v1)

The server is a Cloudflare Agents SDK `withVoice(Agent)` class, so the wire is
the `@cloudflare/voice` protocol version 1 plus a handful of custom JSON
messages the SDK passes through. Everything below is what a client implements;
the browser client and the Flutter client implement it directly (no SDK on the
client), so both speak the same frames.

### Handshake

1. Connect. Server sends `{type:"welcome",protocol_version:1}` then
   `{type:"status",status:"idle"}`.
2. Client sends `{type:"hello",protocol_version:1}` then
   `{type:"start_call",preferred_format:"pcm16"}`.
3. Server answers `{type:"audio_config",format:"pcm16",sampleRate:24000}` then,
   once speech recognition is ready, `{type:"status",status:"listening"}`.
   Or `{type:"error",message,code?,retryable?}` followed by `status: idle` when
   the call was refused or failed to start.

Before `start_call` is accepted the server may send a custom refusal so the
client can say why:

```json
{ "type": "voice/refusal", "schemaVersion": 1, "code": "exclusive" | "quota" | "unconfigured", "message": "…" }
```

`exclusive`: another device holds this account's session. The newer call wins:
the server ends the older call (that client sees `status: idle` and a
`voice/refusal` with code `superseded`) and admits the new one.

### Audio up

Binary frames: PCM16 little-endian, mono, **16 kHz**. Frame size is the
client's choice; 40 ms (1280 bytes) is what both clients send. Audio sent
between `start_call` and `listening` is buffered by the SDK (bounded, 960 KB)
and fed to the transcriber in order. The server resamples every frame to the
24 kHz the upstream insists on (`app/voice/pcm-resample.ts`); the clients never
change rate.

### Audio down

Binary frames: PCM16 little-endian, mono, **24 kHz**, arbitrary chunk
boundaries (a chunk may end on an odd byte; carry the byte). The client plays
them in order and measures amplitude from what it is playing.

### Status

`{type:"status",status}` with `idle | listening | thinking | speaking`.
`{type:"playback_interrupt"}` means drop every queued chunk and stop the
speaker now. Transcript frames (`transcript`, `transcript_interim`,
`transcript_start/delta/end`) arrive too; the footer shows none of them.

### Barge-in

Two detectors, both stop playback:

- Server: the upstream's `input_audio_buffer.speech_started` — its own VAD
  hearing someone — aborts the reply and sends `playback_interrupt`.
- Client: the local energy gate sees a sustained onset (stricter than the
  wake onset) while `status` is `speaking` → stop the speaker immediately and
  send `{type:"interrupt"}`. Background noise below the adapted floor does not
  trip it; this is an energy heuristic, not verified speech detection.

An interrupt stops audio and the assistant's own reply. It never cancels a Bot
Turn the assistant already delegated: that work is durable in the Bot.

### Sleep and wake (cost control)

The SDK forwards every audio frame to the transcriber, and the upstream bills
every second it hears, silence included. It also needs the silence _after_
speech to decide a turn has ended (700 ms of it, `silence_duration_ms`), so a
client must never cut audio a few hundred milliseconds after a phrase. The
policy:

- The client runs an energy gate on every frame: an adaptive noise floor, an
  onset that needs several consecutive loud frames, and a 500 ms pre-roll
  ring. It is an energy gate, not verified speech detection; it decides only
  when to **wake** a sleeping upstream and when to **barge in**.
- While the upstream is awake the client sends **every** frame, speech and
  silence alike, through pauses inside a sentence and while the assistant is
  thinking or speaking. Turn boundaries are the server's to find.
- When `status` is `listening` (no reply in flight) and the gate has been
  closed for **20 s** continuously, the client stops sending frames and sends
  `{type:"voice/sleep",schemaVersion:1}`. The server closes the upstream STT
  session. Capture continues locally.
- On the next onset the client sends `{type:"voice/wake",schemaVersion:1}`,
  then the last **500 ms** of audio from its pre-roll ring, then live frames.
  The server opens a new STT session, buffers frames until it is ready, and
  drains them in order. No syllable is lost.
- The server also sleeps on its own after 30 s without an audio frame while
  awake, so a client that never says `voice/sleep` still stops the meter.
- Server reports `{type:"voice/state",schemaVersion:1,upstream:"awake"|"asleep"|"starting",muted:boolean}`.

Between `voice/sleep` and `voice/wake` the client sends no audio. While
asleep, `status` stays `listening` on both sides; the footer keeps animating
from the local microphone.

### Mute

`{type:"voice/mute",schemaVersion:1,muted:true}`: the client stops sending
frames; the server sleeps the STT session at once. `muted:false` resumes gating;
the next speech onset wakes the upstream as above. Mute does not end the call
and does not stop playback of a reply already in flight.

A client keeps two inputs apart: the person's own mute toggle, and a
temporary hold while dictation borrows the microphone. What goes on the wire
is the effective value (either one), so the billed transcriber sleeps for the
whole of a dictation, and releasing the hold restores the person's own choice
rather than unmuting them.

### End

`{type:"end_call"}` then close. The server closes the STT session, aborts any
reply in flight, releases keep-alive, and answers `status: idle`. Closing the
socket without `end_call` does the same. A Bot Turn the assistant already
admitted keeps running; its answer is spoken on the next call or dropped after
24 h.

The client closes with a code and a reason that name the path that ended the
call, because the server's log is the only record of it: `1000` with
`end-button` or `lifecycle:<state>` when the person or the app ended it, `1000`
`server-closed` when the server's end of the socket finished first (mostly
inert — the peer has already closed, so the frame rarely reaches it), `4001`
with the failure sentence when the client failed on its own, `4002` `disposed`
when the controller was torn down mid-call, `4003` `abandoned-connect` when a
socket that finished connecting is no longer wanted — either the call ended
while it was connecting, or the connect attempt timed out and the client had
already moved on, so the server sees `connected` followed by `4003` with no
`hello`. A reason longer than 120 UTF-8 bytes is cut on a character boundary
to stay inside the wire's 123-byte limit. The server closes with `4403` when
the socket is not the account's.

### Tracing a call

The object writes one `voice assistant {json}` line per step, readable in
`wrangler tail` and Workers Logs: `connected`, `refused-identity` (the socket
was not the account's and was closed with `4403`), `call-admitted`, `upstream`
(`starting` | `awake` | `asleep`), `listening`, `listening-without-call` (the
SDK started listening with no call record, so nothing was booked), `utterance`
(length and whether it reached the model, never the words), `turn`,
`turn-dropped` (a transcript arrived with no identity or no call record and was
never given to the model — the reason says which), `turn-settled` (the outcome,
the delegation count and the answer's length, or a failure classification —
never a provider's error sentence), `speech-suppressed` (the speech allowance is
used up, so a sentence of the reply was never turned into audio — the cap and
the sentence's length, never its words), `refused` (with the code and sentence
the client was sent), `stt-failed`, `speech-started` (the transcription
service's own voice detector heard someone), `interrupted` (the SDK stopped
the reply in flight: preceded by `speech-started`, the upstream's detector cut
it; on its own, the phone's local energy gate sent `interrupt`), `audio` (the
first synthesized chunk of each sentence reached the socket — the sentence's
length in characters, the chunk's bytes and the running chunk count; a reply
with a `turn-settled` but no `audio` never became sound), `call-ended` (with
the call's total synthesized chunks, bytes and sentences) and `closed` (the
client's code and reason). Every line carries the connection id, and — once
`onConnect` accepted the socket — the device key; `refused-identity` carries
the device key from the header it just rejected, and the `closed` line for a
refused socket has none. Once admitted, every line also carries the call id
and elapsed milliseconds. A call that reaches `listening` and then `closed`
with no `utterance` in between means nothing reached transcription; read the
`upstream` lines first. No `awake` line (with or without `stt-failed`) means the STT
socket never became ready — the connect stalled or was refused — and the
`closed` code and reason then say who gave up. An `awake` line and still no
`utterance` means the upstream heard nothing it would transcribe, or the client
left before the turn detector committed a transcript. Only the `closed` code
and reason say which side closed the socket.

### Text turns

`{type:"text_message",text}` runs a turn without STT. Not used by the footer;
kept for tests.

## Durable ledger

`VoiceAssistant` is one Durable Object per User (`getAgentByName(env.VOICE_ASSISTANTS, userId)`),
`new_sqlite_classes` migration `v7`. It records, before any external call:

- `session:<callId>` — call start, device, caps consumed.
- `turn:<turnId>` — each admitted utterance with its idempotency key
  `voice-turn:<userId>:<callId>:<sequence>` and its outcome. A turn that was
  admitted but never answered (eviction mid-model-call) is marked `abandoned`
  on the next start; a model call is never replayed without its key.
- `delegation:<runId>` — a Bot delegation: target Bot, text, `runId` derived
  as `sha256(userId, callId, turnId, botId)` (so a retried tool call admits
  the same Bot Turn once), state `admitted | settled | spoken | expired`.

Delegations use the Bot's ordinary user-lane `run` door with that `runId`, so
the Turn appears in the Bot's own thread, survives the voice socket, and can be
cancelled only through the explicit `stopRun` command the Bot already honours.
The assistant's `cancel_bot` tool requires the caller to name the Bot and is
recorded before the stop command is sent.

Settlement is durable scheduling, not `waitUntil`: after admitting a
delegation the object calls `this.schedule(…)` to look the run up with
`lookupRun(runId)`; a settled answer is stored on the delegation record and,
if a call is live, spoken. A look-up that finds the Bot never admitted the
run — the dispatch was lost, or the Bot was busy and refused it — sends the
same intent again under the same run id (never within 30 s of the last
send), on a backoff that widens to five minutes, until the Bot takes it or
the fortieth look-up settles it as an explicit failure the person hears.
Recovery on `onStart` re-schedules any delegation still `admitted`. A spoken
turn's own settlement is written before its generator returns, so the SDK's
history and the ledger never disagree.

Conversation context is bounded: the SDK's own history table is capped at 40
messages and the prompt carries the newest 12; the User Memory profile and
the last 30 days of its log are read at call start through `MemoryStore` over
the User Durable Object's generation ledger (so retractions and shards resolve
as they do for Bots), and Project memory is read on demand through the same
store when the assistant's `recall_project` tool asks for it. Live Bot
directory and run status are read from `UserConfiguration.listBots` and
`lookupRun`, never from memory.

Caps meter what costs money, never how long the footer has been open: a
session may stay open silently for hours because a sleeping upstream costs
nothing. What is counted per account, durably, per UTC day:

- upstream STT seconds — the time an STT session is awake, booked in 60 s
  windows the moment the upstream starts opening, renewed while it stays awake,
  and refunded for the unused part when it sleeps (bounded at 240 min/day; a
  window past the cap shuts the upstream for the day and tells the client);
- dictation seconds, booked and renewed the same way (bounded at 120 min/day);
- TTS characters sent to ElevenLabs (bounded at 200k/day);
- model turns (bounded at 600/day) and Bot delegations (bounded at 8 per turn burst, 200/day).

Exceeding a cap answers `voice/refusal` with `quota` on the next upstream wake
or turn and leaves the footer open; the day rolls at UTC midnight. One live
call per account: a second device supersedes the first. Transport rotation
(a socket that is replaced by a newer one from the same device within 60 s,
for instance after a network change) rejoins the same durable call record
rather than opening a new one. Raw audio is never stored anywhere.

## Credentials

| Name                           | Where             | Required | What it enables                                                                                                    |
| ------------------------------ | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`               | Worker secret     | optional | All listening: composer dictation and the continuous session's STT. Absent: both report that voice is unavailable. |
| `ELEVENLABS_API_KEY`           | Worker secret     | optional | The continuous voice session's speech. Absent: starting a session reports that voice is unavailable.               |
| `ELEVENLABS_VOICE_ID`          | Worker var        | optional | Voice id; default is ElevenLabs "George" (`JBFqnCBsd6RMkjVDRZzb`).                                                 |
| `VOICE_DICTATION_UPSTREAM_URL` | test harness only | —        | Points dictation at a local fake; never set in production.                                                         |

Declared in `apps/cloudflare/src/production-secrets.ts`, carried by the release
workflow, listed in `.dev.vars.example`. The `AI` binding is still required
for the continuous session — it is the Frock AI gateway transport for the chat
model — but nothing is transcribed through it any more.

What listening costs, from OpenAI's pricing page on 2026-09-11:
`gpt-transcribe` is $0.0045 per minute of audio and `gpt-live-transcribe`,
which dictation needs for its live deltas, is $0.017. The assistant meters
_awake_ seconds rather than seconds of speech, because a session that is awake
is being charged whether or not anyone is talking; the 240 min/day cap is
therefore about $1.08 a day at most.

## Clients

### Flutter on web, Android and macOS

`apps/native/lib/voice/` implements both protocols over the same
authenticated upgrade `NativeApi.socket()` uses (`connectSocketV1` with the
bearer header). `record` 7.1.1 captures streaming PCM16 with echo
cancellation, noise suppression and automatic gain, and requests the
microphone permission itself; `flutter_pcm_sound` 3.3.3 plays the 24 kHz PCM
(its `interrupt()` is a release-and-setup because the plugin has no clear, see
`docs/known-issues.md` 46). Android declares `RECORD_AUDIO` and
`MODIFY_AUDIO_SETTINGS`; macOS carries the microphone usage description and
entitlement. `AppShell`'s lifecycle observer ends capture and playback when
the app leaves the foreground; navigation inside the app leaves the footer
alone.

### SDK frames a client must ignore

Beside the messages above, the Agents SDK sends `cf_agent_identity`,
`cf_agent_mcp_servers`, `diagnostic`, `metrics`, `turn_metrics` and
`completion_outcome` text frames. Both clients drop any type they do not
know rather than ending the call over it.

## Verification

What was run on 2026-09-10 in the crew worktree, with the results as they
came back. Except for the live run recorded directly below, nothing here
involved a real microphone or a real provider.

### The live endpoint, 2026-09-11

`gpt-live-transcribe` was driven against
`wss://api.openai.com/v1/realtime?intent=transcription` with the session frame
above, and then the relay itself was driven end to end — a local Worker
(`wrangler dev --env development`) with the real key, a client socket sending
`start`, 5.5 s of 24 kHz PCM16 speech and `stop`:

```
+1.20s {"schemaVersion":1,"type":"ready"}
+1.91s {"schemaVersion":1,"type":"delta","text":" Hello"}
  … deltas about half a second behind the speaker, each extending the last …
+5.75s client sends stop
+6.90s {"schemaVersion":1,"type":"segment","text":"Hello, this is a dictation test for the composer. Please transcribe these words accurately:"}
+6.90s {"schemaVersion":1,"type":"final"}
```

Upstream, the same capture is one item: `session.updated` echoing
`"turn_detection": null`, then
`conversation.item.input_audio_transcription.delta` frames all carrying the
same `item_id`, then — only after the relay's `input_audio_buffer.commit` —
`input_audio_buffer.committed` and `.completed` within ~0.7 s. Asking the same
endpoint for `server_vad` or `semantic_vad` instead answers
`{"type":"error","error":{"code":"invalid_value","param":"session.audio.input.turn_detection","message":"Turn detection is not supported for this transcription model."}}`,
and a 73-second capture that is never committed produces no transcript at all.
Still unverified: a real microphone, a browser, and the Flutter client.

The continuous session listens through the same endpoint but the other way
round: `gpt-transcribe` with server VAD, which finds turn boundaries itself
and says nothing until it has. Its session frame, verified the same day:

```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "noise_reduction": { "type": "far_field" },
        "transcription": { "model": "gpt-transcribe" },
        "turn_detection": {
          "type": "server_vad",
          "threshold": 0.5,
          "prefix_padding_ms": 300,
          "silence_duration_ms": 700
        }
      }
    }
  }
}
```

Driving the adapter against it with 3.9 s of speech in 40 ms frames, then
silence: `session.created` → `session.updated` →
`input_audio_buffer.speech_started {audio_start_ms:0}` (this is barge-in) →
`speech_stopped {audio_end_ms:3872}` → `committed` → `conversation.item.added`
/ `done` → transcription deltas in a burst → `.completed` with the sentence,
about 0.6 s after the speech stopped. The `audio_end_ms` matching the real
length of the clip is also what proves the 16 → 24 kHz resampling: at the
wrong rate the endpoint would hear the same words over a different span. A
pause of about a second mid-sentence produces two items, and therefore two
Turns; that is accepted.

Then the object itself, under `wrangler dev --env development` on port 8799
with the real key (`?as_user=development`): `welcome`, `hello`, `start_call` →
`voice/state upstream:"starting"` → `status:"listening"` → `voice/state
upstream:"awake"` → the same speech up as 40 ms frames →
`transcript_interim` frames → `transcript role:"user"` with the sentence →
`status:"thinking"` → the model's `transcript_delta`/`transcript_end` →
`status:"listening"`. No audio came back, because the local `.dev.vars` holds
no ElevenLabs key; the reply's speech is the one leg of the cascade that is
still unverified live.

| Check                                                                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck` (client protocol, layer imports, applet assets, 13 packages)                                                          | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bun test` (whole repository)                                                                                                             | 3960 passed, 0 failed, 332 files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bun run format:check`, `bun run lint:ui-styles`                                                                                          | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/cloudflare`: `vitest run test/voice-assistant.workerd.ts test/voice-dictation.workerd.ts`                                           | 25 passed: ownership refusal, sleep/wake frame order, mute, ledgered turn with metered speech, other-device takeover and same-device rejoin ending the earlier socket, transcription booked in windows and reconciled and kept across eviction, a used-up day shutting the upstream during continuous audio, delegation across eviction, dedup, lost dispatch resent under the same run id, a never-accepted delegation settled as a spoken failure; relay opening-audio order, stop-before-ready, every committed item awaited with segments in committed order, out-of-order completions, empty final commit, provider failure after stop reported as incomplete, stop timeout reported, failed item as a notice, unconfigured, protocol error, connect timeout, refusal and drop, lease acquired before the provider and renewed and released, refused lease and refused renewal |
| `apps/cloudflare`: `bun run test:workerd` (whole suite)                                                                                   | 181 passed, 20 failed in 7 files (`applets-feature`, `approvals`, `machine-approval`, `machine-messages`, `subagents`, `subagents-lifecycle`, `subagents-roles`); none voice. The same suites fail identically on a pristine copy of `HEAD` in this environment (10 of 10 in the four re-run), so they are baseline failures, not this change. Run before the review corrections; the voice suites were re-run after them                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/cloudflare`: `bun run artifact:build` then `vitest run --config vitest.integration.config.ts test/integration/voice.integration.ts` | 4 passed: probe, dictation relay through the real gateway, the voice object reached for its owner and refusing without a key, anonymous upgrades refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/cloudflare`: `wrangler deploy --dry-run` (bundles the Worker with the Agents SDK)                                                   | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/native`: `flutter analyze`, `flutter test`, `scripts/check-native-pins.py`                                                          | no issues; 556 passed; pins match                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/native`: `flutter build apk --debug` (by the native specialist; nothing installed)                                                  | built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Browser (Vite dev server, no backend): footer at 1280 and 390 wide                                                                        | footer 52 px tall, meter 140 px at both widths, mute and X on the right, error state, idle AI row as a faint line — screenshots under `~/voice-screenshots/` (superseded 2026-09-11 by the pink slab: 84 pt, one lobed meter on a stage that fills the width beside the controls on a phone and stops at 420 pt centred on a desktop; measured by `apps/native/test/voice_footer_test.dart`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Unit coverage in bun, all with fakes: the wire decoders, the OpenAI
transcription vocabulary, the assistant's OpenAI transcriber against a fake
socket (the session it asks for, readiness only after `session.updated`,
audio before that dropped, a frame too short to resample sending nothing,
speech start and interim text and the utterance, an empty or failed item,
errors and closes and throwing sends all fatal exactly once, connect and
handshake timeouts), the 16 → 24 kHz upsampler (three samples for two, true
interpolation, phase and an odd trailing byte carried across frames), the
sleeping transcriber (open on first frame,
drain in order, sleep, idle bound, bounded hold, startup failure, stale
readiness), the ledger (exclusive call, rejoin, sequential keys, stale
connection, caps, delegation dedup by run id, settlement idempotence,
recovery abandoning turns and expiring old delegations, daily meters), the
turn loop (streamed text, tool round trip, throwing tool, last step without
tools, per-turn delegation bound, abort, answer bound, history bound), the
browser speech gate and session (continuous streaming through pauses, sleep
after 20 s quiet in `listening`, wake with pre-roll in order, mute, barge-in
only on the stricter detector while speaking, refusal ends the call), the
dictation controller (opening audio in order after `ready`, stop before
ready, text after a Bot switch to the original draft, error keeps the draft,
final timeout), microphone ownership, and the Flutter equivalents of each.

**Not verified.** Any live ElevenLabs session;
any real microphone or speaker on any platform; Android runtime permission
and macOS TCC prompts; acoustic echo cancellation between a device's speaker
and its microphone; the composer's microphone button and capture animation
in a browser (no backend was running under the Vite dev server, so no Bot and
no composer rendered). The live steps are in `docs/voice-live-checklist.md`.

### Final review refinements

The relay waits for the initial `session.updated` before draining opening audio.
On Stop it commits directly: turn detection is already off, so there is no
automatic commit to guard against and no round trip to spend. Incremental
OpenAI deltas are accumulated per item before publishing the composer's
cumulative interim text. Regression tests cover configuration acknowledgment,
repeated deltas, and an upstream that refuses turn detection the way the real
one does.

Client regression tests also cover Stop during a pending microphone permission,
dictation failure returning microphone ownership through the shell, and stale
server state never undoing a local mute or temporary dictation hold.

Independent integration verification (2026-09-10): all 13 package typechecks,
3,989 Bun tests, 26 voice Worker tests and 578 Flutter tests passed. Flutter
analyze passed. The Android debug APK built with versionName 1.2.0 and
versionCode 1789019500 using the existing signer. It has not been installed
or released: real provider/audio verification still requires secure access
to the platform OpenAI and ElevenLabs keys. The published production
GitHub secret-name list was also checked and contains neither name.

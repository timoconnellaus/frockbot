# Voice

Two voice features, two transports, one credential rule: provider keys never
leave the Worker.

| Feature                                 | Route                                | Server                                                                    | Providers                                                                                                            |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Composer dictation (one Bot's composer) | `GET /api/voice/dictation` WebSocket | Worker-level relay, `apps/cloudflare/src/voice-dictation.ts`              | OpenAI Realtime transcription, model `gpt-live-transcribe`                                                           |
| Continuous voice session (all Bots)     | `GET /api/voice/assistant` WebSocket | `VoiceAssistant` Durable Object, `apps/cloudflare/src/voice-assistant.ts` | ElevenLabs Scribe v2 Realtime (streaming partials, VAD commit) → Frock AI gateway (chat) → ElevenLabs Flash v2.5 TTS |
| Capability probe                        | `GET /api/voice/capabilities`        | Gateway                                                                   | —                                                                                                                    |

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
- `assistant` is true when `ELEVENLABS_API_KEY` is set, the `AI` binding
  exists, and the chosen STT provider's key is present (see "Ears": that is
  the same ElevenLabs key by default, `OPENAI_API_KEY` under
  `VOICE_ASSISTANT_STT=openai`).

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

### Ears

The session listens through ElevenLabs Scribe v2 Realtime: the adapter is
`ElevenLabsSTT` from `@cloudflare/voice-elevenlabs`, and
`app/voice/scribe-transcriber.ts` holds the assistant's settings for it —
`pcm_16000` as both clients send it (nothing is resampled),
`commit_strategy=vad` with `vad_silence_threshold_secs` 0.5, provider logging
off. Partial transcripts stream while the person is still speaking (the SDK
forwards them as `transcript_interim`, which the footer ignores), the first
partial of a segment is the speech-start the SDK's barge-in hangs on, and the
committed segment is the turn — so the model can be reading the words before
the sentence is over, and the turn begins about half a second after it is.
`VOICE_ASSISTANT_STT=openai` switches back to OpenAI `gpt-transcribe` with
server VAD (700 ms of silence, and no text at all before the commit), which
then needs `OPENAI_API_KEY`; the capability probe reports the assistant only
when the chosen provider's key and the ElevenLabs key are both present.

### Barge-in

Two detectors, both stop playback:

- Server: the transcriber's speech-start — Scribe's first partial of a new
  segment; OpenAI's `input_audio_buffer.speech_started` when listening
  through it — aborts the reply and sends `playback_interrupt`.
- Client: the local energy gate sees a sustained onset (stricter than the
  wake onset) while the reply is playing (`status` is `speaking`, or the
  speaker still has audio after the server moved on) → stop the speaker
  immediately and send `{type:"interrupt"}`. Background noise below the
  adapted floor does not trip it; this is an energy heuristic, not verified
  speech detection.

While the reply plays the client sends **silent** frames at the usual cadence
and holds the last 500 ms of real audio, so the upstream's detector never
hears the speaker's own echo and takes it for the person. On a client barge-in
the interrupt goes first, then the held audio, then live frames — so the
server's `speech-started` follows the client's `interrupted`, and the person's
words are transcribed from their first syllable.

An interrupt stops audio and the assistant's own reply, including a tool step
the model had not reached yet — an interrupt during the acknowledgment settles
the turn without delegating. It never cancels a Bot Turn the assistant already
delegated: that work is durable in the Bot.

### The turn stays thin

Everything between the end of the person's words and the first sound is
what they wait through, so the turn does as little as it can in that gap.
The Bot activity look-ups behind the system prompt and `list_bots` go to
every Bot's object together, not one after another; a Bot lookup for
`bot_status`, `ask_bot` and `cancel_bot` is one directory read. When the
model goes to a tool without having said anything, the session speaks
`"One second."` before running it (`VOICE_TURN_BRIDGE_V1`). The same
acknowledgment starts after one second if the first output is still pending,
including while initial context loads or the model connects. It is emitted
at most once per turn; a quick answer goes straight to speech. The prompt
also asks the model to acknowledge checks and delegations briefly. The
bridge is spoken, not answered, so a turn that ends in the bridge alone still
settles as `no_output`. `VOICE_ASSISTANT_MODEL` pins a
gateway model for voice turns (`workers-ai/@cf/...` or a provider the gateway
holds a key for) instead of the platform's Auto route; the `turn` trace line
says which was used, and `model-first-text` says how long the model took to
say its first word — the bridge is timed separately on `turn-bridge`, so a
tool-first turn never reads as a fast first token.

The call loads the User's Profile timezone with its memory and Bot directory.
Every turn renders a fresh clock in the system prompt: the full UTC instant
and the local date, time and UTC offset, including daylight saving. An unset
timezone defaults to UTC. Relative dates such as "today" use that local
clock, and time-sensitive delegations must carry the resolved dates and zone.

### A reply that fails

A turn that produces no text, or a sentence the speech provider answers with
nothing (a refused key, a spent quota), reaches the client as the SDK's
`{type:"error",message}` followed by `status: listening`. The server is still
listening, so the client shows the sentence on the footer for four seconds and
keeps the call; it does **not** hang up. The provider is wrapped so that a
sentence with no audio throws rather than returns (`app/voice/tts-guard.ts`);
without that the turn settles as answered and the silence has no record.

The one turn that produces no answer and yet carries no error frame is the
bridge-only turn: once `"One second."` has been spoken the SDK has seen text,
so it treats the turn as a success even though the ledger settles it as
`no_output`. The person hears the bridge and then nothing, and the call goes
back to listening with no footer message; only the `turn` trace line records
the dead end.

An error frame that carries a `code` is a different thing: the SDK sends one
only when the call itself has failed — speech recognition lost, a startup that
never worked — and has already torn the call down behind it. The client ends
the call and shows the failure, rather than leaving a live-looking footer over
a socket nobody is listening on.

A Bot answer that settles while a reply is being produced or, for six seconds
after, still being heard is held rather than read out over it (`speak` would
abort the reply in flight); it is read out once that window has passed.

### Sleep and wake (cost control)

The SDK forwards every audio frame to the transcriber, and the upstream bills
every second it hears, silence included. It also needs the silence _after_
speech to decide a turn has ended (half a second of it,
`vad_silence_threshold_secs`; 700 ms, `silence_duration_ms`, through OpenAI),
so a client must never cut audio a few hundred milliseconds after a phrase.
The policy:

- The client runs an energy gate on every frame: an adaptive noise floor, an
  onset that needs several consecutive loud frames, and a 500 ms pre-roll
  ring. It is an energy gate, not verified speech detection; it decides only
  when to **wake** a sleeping upstream and when to **barge in**.
- While the upstream is awake the client sends a frame every 40 ms, speech
  and silence alike, through pauses inside a sentence and while the assistant
  is thinking. While the reply plays the frames are silent ones (see
  Barge-in). Turn boundaries are the server's to find.
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
socket without `end_call` closes the STT session and settles its meter the
same way, but does **not** end the call: the call record survives the 60 s
rejoin window so a client back from a network change continues the same
conversation, and an alarm ends it if nobody comes back (see "Session
memory"). A Bot Turn the assistant already admitted keeps running; its answer
is spoken on the next call or dropped after 24 h.

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
never given to the model — the reason says which), `model-first-text` (the
model's first word, with `ms` since the turn began: everything before it is
what the person waited through in silence), `turn-bridge` (the turn said
`"One second."` before a tool step or while the first output was still
pending, with `ms` since the turn began — filler, not the model's own
words), `turn-settled` (the outcome, the
delegation count and the answer's length, or a failure classification — never
a provider's error sentence — and `ms`, the turn's whole model time),
`speech-suppressed` (the speech allowance is used up, so a sentence of the
reply was never turned into audio — the cap and the sentence's length, never
its words), `tts-failed` (the speech provider answered a sentence with no
audio — the sentence's length; the SDK has told the client and moved on),
`refused` (with the code and sentence the client was sent), `stt-failed`,
`speech-started` (the transcription service's own voice detector heard
someone), `interrupted` (the SDK stopped the reply in flight: preceded by
`speech-started`, the upstream's detector cut it; on its own, the phone's
local energy gate sent `interrupt` — and since the phone sends silence while
the reply plays, a `speech-started` _after_ it is the person's own barge-in
being heard), `delegation-held` (a Bot answer settled mid-reply and waits for
it to finish), `audio` (the first synthesized chunk of each sentence reached
the socket — the sentence's length in characters, the chunk's bytes, the
running chunk count, the turn and `sinceTurnMs`, how long after the turn began
this sentence's sound left; the first `audio` of a turn is its time to first
word; a reply with a `turn-settled` but no `audio` and no `tts-failed` never
became sound), `call-ended` (with the call's total synthesized chunks, bytes
and sentences) and `closed` (the client's code and reason). Every line carries the connection id, and — once
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
if a call is live and no reply is in flight, spoken — otherwise it is held
and rescheduled, see "A reply that fails". A look-up that finds the Bot never
admitted the run — the dispatch was lost, or the Bot was busy and refused it —
sends the same intent again under the same run id (never within 30 s of the last
send), on a backoff that widens to five minutes, until the Bot takes it or
the fortieth look-up settles it as an explicit failure the person hears.
Recovery on `onStart` re-schedules any delegation still `admitted`. A spoken
turn's own settlement is written before its generator returns, so the SDK's
history and the ledger never disagree.

Conversation context is bounded and **call-scoped**: the prompt carries the
newest 12 messages of _this call_, built from the ledger's own `turn:` records
rather than the SDK's `cf_voice_messages` table, which is per User and would
otherwise carry the last conversation — and a Bot answer that settles late —
into the next one as if it had just been said. The SDK's table is still
written (`saveMessage` is the mixin's own bookkeeping) and simply not read.
The User Memory profile and the last 30 days of its log are read at call start
through `MemoryStore` over the User Durable Object's generation ledger (so
retractions and shards resolve as they do for Bots), and Project memory is
read on demand through the same store when the assistant's `recall_project`
tool asks for it. Live Bot directory and run status are read from
`UserConfiguration.listBots` and `lookupRun`, never from memory.

## Session memory

The voice session keeps its own memory, separate from the account Memory every
Bot reads and writes. "Keep your answers short" is a fact about talking to the
assistant, not a fact about the account, so it does not go into every Bot's
Memory. It lives in the voice object's own storage
(`voice:memory:record`, `app/voice/memory.ts`) and holds three kinds:

| Kind        | What it is                                                                      | When it goes                                                                |
| ----------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **durable** | Preferences and facts that stay true: how they want spoken conversations to go. | Only when the person corrects or drops it. Never expired, never evicted.    |
| **ongoing** | An open question, an undecided thing, work left unfinished.                     | When it resolves, is cancelled, or is superseded.                           |
| **recent**  | The handover, and anything asked for within a timeframe.                        | At its own expiry, or after 14 days, or past 30 lines — whichever is first. |

Everything stored is rendered into the prompt. The bounds (60 durable, 30
ongoing) are on _writing_: past one, the new fact is refused and the refusal is
spoken, because a preference that is stored but never shown would be
remembered and never acted on.

**Provenance and order.** Every change names the ledger turn it came from and
takes that turn's own admission time, so a model cannot date a fact and
re-reading an old conversation cannot make what it held look like today. Each
entry carries a stamp of `(call start, turn number)`, and every removal leaves
a tombstone carrying the same. A write is refused when something newer already
stands where it would go, so a summary that arrives after the conversation
that corrected it cannot undo the correction, and re-reading an old
conversation cannot resurrect a fact the person has since dropped. The
tombstones are counted, but a tombstone is only ever dropped when it sits
before every call whose turns nothing has finished reading: while an
unfinished job could still summarise the conversation that stated the fact,
the fence that would refuse it is kept however many corrections follow. That
makes the count a soft one, so the tombstones are not kept in the record at
all: each lives in its own record under `voice:memory:forgotten:<kind>:<id>`,
holding the latest removal of that one thing, and a write puts the fences
before the record and deletes the ones the new list no longer holds after it.
A backlog of protected fences therefore costs storage keys rather than growing
one value until memory can no longer be written. Because a fence is keyed by
what it fences rather than by a position in a list, a write that fails part
way through cannot destroy a fence that was already committed — the only value
it could have replaced is the same fact's own older fence. A failure between
the two steps leaves a removal fenced but its entry still present, which the
person hears as a failed write and says again.

That refusal is exact, and it needs both sides to name the same thing. When
the fact is already remembered it has an id, and the id is what the removal
and any later write both carry, so the order is decided in code. When the
person corrects something no conversation has been summarised for yet, there
is no id anyone has seen: the correction leaves a fence under the slug of
their own words, which only bites if the later summary picks that same name
for the fact. Nothing tries to match wording to wording — a fuzzy match would
drop things nobody asked to drop — so this case rests on the end-of-call
instruction, which dates everything already remembered, lists what has been
dropped since, and tells the model that reading an older conversation is never
a reason to write a remembered fact back.

### During the call

The system prompt tells the assistant that it remembers this person, and that
what they ask it to remember, correct or forget is acted on. It acknowledges
in ordinary words — "Noted. I'll remember that", "Got it", "Of course" — and
is told never to describe the mechanism: no summaries, storage, notes,
records, background work, context or resetting. With nowhere to write (the
record could not be read) the rule inverts and it says plainly that it cannot
hold on to anything right now, rather than promising.

Two tools write it, so an explicit request takes effect at once rather than at
the end of the call:

- `remember(text, kind, replaces?, until?)` — `kind` is `preference`
  (durable), `open` (ongoing) or `temporary` (recent, with an end). `replaces`
  names the id this one supersedes — an id only, never wording, because a
  correction deletes and matching on wording would take unrelated facts with
  it — so a corrected preference leaves one answer and not two. An id the
  record does not hold is fenced under its own slug in all three kinds. `until` is `today` or `week`; the _host_ works out the
  date from the person's own timezone, because "just for today" has to stop
  tomorrow and a model cannot be trusted with a clock.
- `forget(text)` — matched by id or by their own words, literally; nothing
  matching is an ordinary answer the assistant says out loud.

The session's memory is re-read for every turn's system prompt (the Bot
directory, account memory and timezone stay in the call-start snapshot), so
something remembered thirty seconds ago is in front of the model now, long
after it has left the 12-message history window.

A credential is refused at both doors — the tool and the end-of-call update —
by the same `refuseMemorySecretV1` the Memory Package uses.

### After the call

Ending a call queues one durable job (`voice:memory:job:<callId>`) and a
`finalizeVoiceMemory` scheduled task. The job holds no source: the ledger's
`turn:` records are the source, and a call whose job is not `applied` keeps its
turns out of the ledger's retention sweep. So a call of any length costs one
small record, nothing that was said is copied or clipped, and a call long
enough to exceed a storage value cannot exist.

The task claims the job (`pending` → `spending`, inside the memory ledger's
serializing chain — that transition _is_ the claim, so a duplicate end
notification finds nothing to claim and makes no second model call), asks the
configured chat model for a JSON update, and applies it. A call longer than 40
turns is read in as many requests as it takes, each advancing a durable
cursor, so a request made in the tenth minute is read exactly like one made in
the first.

End-of-call and recovery scheduling deduplicate the initial callback. A running
callback queues continuations and retries with a fresh scheduler row: reusing
its own row would lose the continuation when the scheduler deletes that row
on return. The durable job claim still prevents duplicate model requests.

The request is the call's own last system message, then the conversation, then
the instruction. **Only the system message is shared with the call's own
requests** — the turns below it are the whole conversation rather than the
twelve the live prompt carried, and that system message itself carries a
per-turn clock — so a provider that caches prompt prefixes can match that much
and no more. The cache hit is a bonus; nothing depends on one. An eviction
mid-call loses the captured system message and the request then goes without a
prefix, which costs the hint and nothing else.

The instruction lists everything currently in memory — durable, ongoing and
the handover with its expiries — read at the moment the request is made rather
than at the call's start, so the model corrects what is actually there and
does not record the same thing twice.

**Timeframes are words, never dates.** A request with its own timeframe is
`recent/add` with `"until":"today"` or `"until":"week"`, and the instruction
forbids recording one as `durable/add`. Any other value is dropped rather than
interpreted, and a date the model invents is not carried at all: the _applier_
works out when, from the source turn's own admission time and the person's
timezone. That is the same policy the spoken `remember` tool goes through, so
a preference said aloud and the same preference read back at the end of the
call expire identically — and a "just for today" the person asked for in a
call nobody ever answered still gets its end from the turn they said it in.

### What ends a call, and what does not

| Event                                | What happens                                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `end_call`                           | The job is written, _then_ the call record is deleted, then the finalization is scheduled.                                                                                                                                  |
| The socket closes with no `end_call` | The upstream closes and its meter settles, but the call record **stays**: a client back inside the 60 s rejoin window continues the same conversation. An `abandonVoiceCall` alarm is scheduled for the end of that window. |
| Nobody comes back                    | The alarm ends the call and queues its memory. Nothing waits for a future request to notice it.                                                                                                                             |
| Another device takes over            | The displaced call's job is written _before_ the record naming it is replaced.                                                                                                                                              |
| Eviction                             | `onStart` ends a call already past the rejoin window and queues it; inside the window it schedules the alarm instead.                                                                                                       |

The job is written before the call record is deleted in every one of these,
because the record is the only place the call id was: the other order leaves a
call nothing remembers has to be read.

### Spend, and what is never repeated

A gateway model request carries no idempotency key, so a memory update that
was dispatched is never issued again:

- **Dispatched, no complete answer** — a failed request, a stream cut by the
  60 s deadline or by the 20k-character output bound, or an eviction between
  the request and the answer (found as `spending` on the next `onStart`). The
  job is marked `failed`, its turns stay in the ledger, and the _next_ call's
  finalization reads them. It is never re-claimed, however many attempts it
  has left.
- **A complete answer that is not an update** — the call is known to have
  finished, so asking again is a new request rather than a possible second
  payment. Bounded at three attempts, after which it is `failed` and carried
  the same way.

A finalization also reads up to two earlier `failed` calls alongside its own,
taking the newest of them first and ordering the turns it reads oldest first.
A call that finishes leaves the `failed` set, so the backlog still drains
completely. A call still `pending` is left alone — it has its own scheduled
path, and reading it here too would put two finalizations over one call's
source. Carried cursors advance to the highest turn actually covered, never by
a count added to whatever the cursor says, so two readers that overlap settle
on the same place instead of stepping over source neither of them read.

Until a previous call's summary lands, the next conversation's prompt carries
the last six turns of it verbatim under `<last-conversation>`, with their own
dates. That is temporary continuity, not memory: it disappears the moment the
finalization applies. A new call never waits for a background summary to open.

**Limitation, stated honestly.** A job that keeps failing is never deleted,
and its call's turns stay out of the ledger's retention sweep until they have
actually been read. A model that is unavailable for a long time therefore
retains source rather than losing it; the daily turn cap (600) bounds how fast
that can grow. Losing what someone said is the worse failure, and this is the
side the design takes.

### Memory traces

Beside the per-call lines above, the object writes `memory-queued` (a call's
memory work recorded), `memory-updated` (status, operation and refusal
counts), `memory-write` and `memory-forget` (a spoken tool wrote or dropped
something — the kind and the turn, never the words), `memory-abandoned` (a
dispatched request that never answered; not repeated), `memory-malformed` (a
complete answer that was not an update, and whether it will be asked again),
`memory-uncertain` (found mid-request on waking), `memory-unreadable` (the
record could not be read, so the assistant promises nothing), `call-memory`
(this connection's `end_call` left the call's memory work behind it) and
`call-abandoned` (the rejoin window passed with nobody back).

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

| Name                           | Where             | Required | What it enables                                                                                                                                                                                     |
| ------------------------------ | ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`               | Worker secret     | optional | Composer dictation, and the continuous session's STT only when `VOICE_ASSISTANT_STT=openai`. Absent: dictation reports that voice is unavailable.                                                   |
| `ELEVENLABS_API_KEY`           | Worker secret     | optional | The continuous voice session's ears (Scribe v2 Realtime) and speech, so it needs speech-to-text as well as text-to-speech permission. Absent: starting a session reports that voice is unavailable. |
| `VOICE_ASSISTANT_STT`          | Worker var        | optional | `openai` listens through `gpt-transcribe`; anything else (and unset) is Scribe.                                                                                                                     |
| `ELEVENLABS_VOICE_ID`          | Worker var        | optional | Voice id; default is ElevenLabs "George" (`JBFqnCBsd6RMkjVDRZzb`).                                                                                                                                  |
| `VOICE_ASSISTANT_MODEL`        | Worker var        | optional | Pins a gateway model for voice turns (e.g. `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`); unset, turns take the platform's Auto route.                                                     |
| `VOICE_DICTATION_UPSTREAM_URL` | test harness only | —        | Points dictation at a local fake; never set in production.                                                                                                                                          |

Declared in `apps/cloudflare/src/production-secrets.ts`, carried by the release
workflow, listed in `.dev.vars.example`. The `AI` binding is still required
for the continuous session — it is the Frock AI gateway transport for the chat
model — but nothing is transcribed through it any more.

What listening costs: from OpenAI's pricing page on 2026-09-11,
`gpt-live-transcribe`, which dictation needs for its live deltas, is $0.017
per minute of audio, and `gpt-transcribe` — the assistant's ears only under
`VOICE_ASSISTANT_STT=openai` — is $0.0045, which puts the assistant's
240 min/day cap at about $1.08 a day through that path. By default the
assistant's listening bills ElevenLabs for Scribe v2 Realtime instead; that
rate is not recorded here, so size the cap against the ElevenLabs plan's
realtime speech-to-text price. The assistant meters _awake_ seconds rather
than seconds of speech, because a session that is awake is being charged
whether or not anyone is talking.

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

### Voice controls and motion

Dictation replaces the message field with a text-free dock spanning the chat
width and meeting the bottom edge. Its waveform and 48-point Stop control share
one row with 24-point internal padding; only the top corners are rounded.
Starting, listening and finishing are announced through live semantics and
control tooltips. Real errors remain visible. Stop commits to the editable
draft without sending; the finishing control is disabled until transcription
ends. The realtime footer spans the whole shell with the same inset controls,
reserved waveform space and background covering the bottom system inset.
Both docks open and close with coordinated size, slide and fade transitions.
The complete controls paint throughout the transition without a shrinking clip.
Closing begins microphone and playback teardown immediately and keeps the
outgoing visual mounted only through its exit. Bottom system insets
transfer back to the conversation without a final layout jump. While that
teardown finishes, the sidebar's start control says the session is ending and
cannot be pressed, because a start in that window would be dropped.

Both meters use the same continuous ribbons, driven only by audio levels.
A time-based envelope uses a 65 ms attack and 220 ms release; microphone and
playback levels ease separately so the speaker tint does not flicker.
The painter repaints on display frames without rebuilding controls, stops its
ticker in silence, and follows Flutter's ticker lifecycle. Reduced motion
shows a static level shape and makes transitions immediate. Controls keep
48-point touch targets in both themes.

### SDK frames a client must ignore

Beside the messages above, the Agents SDK sends `cf_agent_identity`,
`cf_agent_mcp_servers`, `diagnostic`, `metrics`, `turn_metrics` and
`completion_outcome` text frames. Both clients drop any type they do not
know rather than ending the call over it.

## Verification

What was run on 2026-09-10 in the crew worktree, with the results as they
came back. Except for the live run recorded directly below, nothing here
involved a real microphone or a real provider.

The counts and scenario lists in this section are that evidence, unchanged:
they predate the reply-failure and latency work described under "A reply that
fails", which adds bun tests for the speech guard, two voice workerd scenarios
(a sentence that never becomes sound; a Bot answer held over one reply and
over two) and Flutter tests for the silent frames sent while the reply plays,
barge-in ordering, the playback tail, a feed the device rejects, the
device-setup retry and the error-frame notice. They also predate the swap of
the assistant's ears to ElevenLabs Scribe v2 Realtime described under "Ears",
which adds bun tests for the provider and key resolution and for the Scribe
options. They also predate session memory, which adds bun tests for the
memory record, its ordering fences and the finalization job, and workerd
scenarios driving the scheduler through a long call, a malformed answer and
an abandoned call. The numbers below are therefore understated; the next run of the suites should replace them wholesale rather
than add to them.

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

Until 2026-09-12 the continuous session listened through the same endpoint
the other way round, and `VOICE_ASSISTANT_STT=openai` still does:
`gpt-transcribe` with server VAD, which finds turn boundaries itself and says
nothing until it has. Its session frame, verified the same day:

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
| Browser (Vite dev server, no backend): footer at 1280 and 390 wide                                                                        | footer 52 px tall, meter 140 px at both widths, mute and X on the right, error state, idle AI row as a faint line — screenshots under `~/voice-screenshots/` (superseded 2026-09-11 by the pink slab: 84 pt, one lobed meter on a stage that fills the width beside the controls on a phone and stops at 420 pt centred on a desktop; superseded again on 2026-09-12 by the bottom-attached dock described under "Voice controls and motion": 96 pt over the system inset; both measured by `apps/native/test/voice_footer_test.dart`)                                                                                                                                                                                                                                                                                                                                              |

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
speech guard (audio passed through untouched, a sentence answered with no
audio throwing after the host is told, an aborted request staying quiet, a
provider without streaming left without it), the browser speech gate and
session (continuous streaming through pauses, sleep
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

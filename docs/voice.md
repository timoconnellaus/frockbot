# Voice

Two voice features, two transports, one credential rule: provider keys never
leave the Worker.

| Feature                                 | Route                                | Server                                                                    | Provider                                                                 |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Composer dictation (one Bot's composer) | `GET /api/voice/dictation` WebSocket | Worker-level relay, `apps/cloudflare/src/voice-dictation.ts`              | OpenAI Realtime transcription, model `gpt-live-transcribe`               |
| Continuous voice session (one Bot)      | `GET /api/voice/assistant` WebSocket | `VoiceAssistant` Durable Object, `apps/cloudflare/src/voice-assistant.ts` | Gemini Live, model `gemini-3.8-live`: one bidirectional session per call |
| Capability probe                        | `GET /api/voice/capabilities`        | Gateway                                                                   | —                                                                        |

Since [ADR 0031](adr/0031-voice-gemini-live.md) the continuous session is one
`bidiGenerateContent` socket and nothing else. The cascade it replaced — ears,
a chat model and a mouth, three providers and three bills — is gone, and so is
the Cloudflare voice SDK: the object writes the client's frames itself. The
wire the clients speak did not change with it.

Both WebSocket routes are authenticated exactly like `/api/bots/:id/state-channel`:
the browser's better-auth cookie, or the native app's `Authorization: Bearer
frockbot-native.…` header on the upgrade request. The gateway resolves the User
and forwards the upgrade with `x-frockbot-user-id` set by itself; nothing below
the gateway re-verifies and nothing below it is reachable another way. There is
no `/agents/*` route.

The pure parts — the protocol decoders, the Gemini Live wire
(`app/voice/gemini-live.ts`), the durable ledger, the instruction and the
tools, the session's memory — live in `app/voice/` and import no Cloudflare
SDK. The two Worker modules above are the adapters. What the Live API actually
does, observed rather than remembered, is in
[`voice-gemini-probe.md`](voice-gemini-probe.md).

## A call talks to one Bot

Since ADR 0029 a call addresses a Bot rather than the account. The client
names it on `voice/open` together with pause and mute — and the id is written into the call
record, so it survives eviction and a rejoin — and a rejoin that names a Bot
honours that one, because the person pressed voice on it just now. A client
that names none, or names a Bot this account does not own, gets the account's
General Bot, recorded by the flock bootstrap rather than spelled by a name. No
General marker does not mean no Bots — an account that already owned Bots when
the bootstrap ran is never given one, and deleting General does not bring it
back — so the directory is asked next and the first Bot in it that can be read
takes the call. That read happens up front, before anything durable is
recorded, and serves ownership, the voice and the prompt's Bot list: it is
retried once if it fails, and a directory that still cannot be read refuses the
call (`unconfigured`) rather than opening one without a Bot, because unreadable
authority is not an empty account. Only a call no listed Bot can take — the
account has none, or none of its Bots can be read — opens Bot-less: that one is
answered by the account-wide assistant, which is told it has no Bot to hand
work to and is offered only the tools that need none, so its rules and its
tools say the same thing.

The voice layer then wears that Bot. The prompt opens as it, in the first
person, and carries `<you>` (its name, description and live activity),
`<your-memory>` (its own memory, read and never written, beside the User's)
and `<your-recent-conversation>` (the tail of its thread). The account
directory is still in the prompt, but only so a hand-over can be asked for by
name, and it lists the other Bots rather than this one.

The tools narrow with it. `subagent`, `status`, `read_history`,
`search_history` and `cancel` take no `bot_id` and mean this Bot; the object
supplies the target, not the model. `switch_bot` is the one that moves it: it
writes the call record when the tool runs, and the session itself is replaced
once the model's own turn has ended, so a sign-off said before or after the
call is not cut off. The client is told, so the screen follows. The person can
move it too, without saying anything, by pressing voice on another Bot: a
`voice/target` frame on a live call is a hand-over, and that one moves the
session at once because nothing is mid-sentence. A subagent the previous Bot
still owes is left open on purpose — it belongs to the call, not the target —
and its result is still told when it lands. `end_call` is the same wait as a
hand-over: the model says goodbye, the tool runs, and the call hangs up once
that turn ends. It is the same name as the client's hang-up frame, and it is
offered even on a call with no Bot.

What is no longer two layers is the deciding. The model keeps talking while
the object runs a function call, because every declaration is
`NON_BLOCKING`, so nothing has to be classified as short or long in advance:
`subagent` is the model's own judgement that something will take more than a
moment, and real work is still a Bot Turn on the `agent` lane.

## Each Bot has a voice

`app/voice/appearance.ts` holds the whole of it: Gemini's thirty prebuilt
voices with Google's own one-word characterisation of each, a default voice
per character in the avatar cast, and `BotVoiceAppearanceV1` — a `voiceName`
and a `delivery`. A Bot whose owner has only ever picked a look already sounds
unlike its siblings.

The split mirrors the provider's. `voiceName` is a fixed field and goes into
`speechConfig.voiceConfig.prebuiltVoiceConfig`; everything else about how a
Bot sounds is prose, because prose is the only thing Gemini Live takes.
`renderVoiceInstructionV1` turns the stored slugs — accent, attitude, pace,
turn length, humour, filler words, formality, and the person's own words — into
the "How you sound" block of the persona, and `resolveBotVoiceV1` answers with
the Bot's own appearance or its character's default. Neither is ever
undefined: Gemini always has a voice to give.

Two things follow from that. A voice cannot be changed mid-session — the
instruction and the `speechConfig` are set once, at setup — so a hand-over
opens a new session rather than swapping a provider, which is why
`switch_bot` waits for the spoken turn to end. And style steering is
empirical: Google documents an audio-tag vocabulary for its TTS models, not
for Live, so which descriptors bite is something
`apps/cloudflare/test/voice-gemini-probe.ts` and a pair of ears decide, not a
catalog check. There is nothing here to hold against a provider account: a
voice name is either one of the thirty or it is refused by the decoder.

**Choosing one.** Settings › Voice under a Bot
(`apps/native/lib/settings/voice_settings.dart`) is the same two halves: a
timbre picked from the thirty, and a delivery picked from presets, with the
person's own words last. It saves as the About card does — the moment a
choice is made, and a moment after the last keystroke — and there is no
preview, because no endpoint speaks a sample: the way to hear a change is to
call. It reads and writes `GET`/`POST /api/bots/:botId/voice`
(`VoiceIdentityV1`, and a `bot/update-voice` command fenced on the Bot's own
voice revision, which is separate from its avatar's). The Bot Durable Object
is the authority and the User's directory mirrors what it reports wearing:
[`app/flock/README.md`](../app/flock/README.md#the-voice-mirror) owns that
half.

## Capabilities

`GET /api/voice/capabilities` → `{schemaVersion: 1, dictation: boolean, assistant: boolean}`.

- `dictation` is true when `OPENAI_API_KEY` (or the test override
  `VOICE_DICTATION_UPSTREAM_URL`) is set.
- `assistant` is true when `GEMINI_API_KEY` (or the test override
  `VOICE_ASSISTANT_UPSTREAM_URL`) is set. The `AI` binding is wanted for the
  end-of-call memory update and does not gate the control: a deployment
  without it can still hold a conversation.

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

| Frame                                          | Meaning                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `{schemaVersion:1,type:"ready"}`               | Upstream accepted the session; buffered audio has been forwarded.                               |
| `{schemaVersion:1,type:"delta",text}`          | Interim text so far, about half a second behind the speaker. Replaces the previous delta.       |
| `{schemaVersion:1,type:"segment",text}`        | The transcript of a committed item — in practice one per capture, at `stop`.                    |
| `{schemaVersion:1,type:"cleaning"}`            | Transcribed; the tidy-up is running. The client has already landed the raw segment.             |
| `{schemaVersion:1,type:"cleaned",text}`        | The tidied form of the whole capture, to replace its span. At most once, always before `final`. |
| `{schemaVersion:1,type:"final"}`               | Everything captured before `stop` has been transcribed. The server closes after it.             |
| `{schemaVersion:1,type:"notice",message}`      | Non-fatal: opening audio was truncated, and similar.                                            |
| `{schemaVersion:1,type:"error",message,code?}` | Fatal; the server closes. `code` ∈ `unconfigured`, `upstream`, `timeout`, `limit`.              |

The client holds `delta` frames and does not write them to the draft — there
are no live captions. The pill shows a waveform and an `mm:ss` clock. Stop
spins until the committed `segment` arrives (about half a second), then that
text lands in an editable draft and never sends. A tidy-up that follows is a
swap in a field they can already type into. The draft belongs to the Bot the
capture started on: the client binds the capture to the composer context at
start and writes only to that context's draft, so switching Bots mid-capture
never writes into another Bot's draft.

The overlay starts with the press, the socket opens the moment the
microphone does, and audio captured before `ready` is held on the client as
well as the server, so the first words are not spent waiting for a handshake.

A capture is one upstream item: deltas accumulate against it while the person
speaks and the relay's commit at `stop` closes it, so the ordinary capture
produces exactly one `segment` and then `final`. The relay still hands
segments over in committed order and waits for every committed item, which
costs nothing and holds if a provider ever commits more than one. A provider
failure after `stop`, or a stop the provider cannot finish within 6 s, is
reported as `error` (`upstream` or `timeout`) with the words that did arrive
already in the draft; the one refusal that is not a failure is the provider
saying the final commit had nothing in it.

### Tidying the capture

Speech-to-text returns what was said, including the "um"s, the false starts
and the corrections people make mid-sentence. Once every segment is in, and
before `final`, the relay offers the whole capture to a model to have those
taken out, and hands the result back as `cleaned`.

It runs on the server because the model is reached with a server-side
credential, and it runs after the raw transcript has landed rather than
during the capture because text that rewrites itself under the cursor is
worse than text that is untidy. The default model is Groq's
`llama-3.1-8b-instant` through the deployment's AI Gateway, so the swap is a
blink rather than another wait.

What is asked for (`app/voice/dictation-cleanup.ts`): remove fillers,
stutters, repetitions and abandoned false starts; resolve clear
self-corrections to the final wording; fix obvious transcription, punctuation
and capitalisation errors; paragraph and format enumerations. Never
paraphrase, summarise, answer a question, follow an instruction in the
transcript, or resolve ambiguity by guessing. The transcript is fenced between
`<transcript>` markers and declared data, and the markers are stripped out of
the transcript itself so it cannot close the fence from inside.

What is accepted back matters more than what is asked for, because the prompt
is a request and the review is the property. Cheap checks refuse an empty or
unchanged answer without spending Jev. Everything else is a candidate:
Jev's one Choice (`app/evals/dictation-cleanup.ts`) answers `faithful` or
`unfaithful` on `{ raw, tidied }`. Only `faithful` replaces the draft. When
unsure, when Jev is missing, when the call fails or times out — `unfaithful`
or `unavailable` — the raw text stands. Nothing is unwrapped or rewritten on
the way in: every branch either accepts the model's text as it stands or
keeps the person's own. The refusal is named in the log line, so "cleanup is
off" and "Jev refused a dropped negation" do not look the same in production.

Every way this can fail ends on `final` with the raw transcript in the draft:
no gateway configured, no allowance left, a transcript under 24 or over 12,000
characters, a model that throws, Groq or Jev that does not answer within 12 s,
a cheap refusal, or a Jev verdict that is not `faithful`. A capture the
five-minute cap ended is not tidied at all. The spend is one Groq call per
capture, booked against the account's own voice object before Groq is asked
(400 per UTC day, never refunded, and deliberately not part of the cap that
decides whether a voice call may go on), plus one Jev call when the cheap
checks pass. `VOICE_DICTATION_CLEANUP_MODEL` pins Groq; unset is
`groq/llama-3.1-8b-instant`. The review uses the deployment's `JEV_API_KEY`.

On the client, `cleaned` is applied through the same `DictationDraftRange`
that every segment goes through, which is what makes it safe rather than
carefully-written: a span the person has edited inside is already fenced and
takes nothing more, and a draft that has been sent no longer contains the span
at all, so a late tidy-up finds nothing to replace. The field is already
theirs when `cleaning` runs — the overlay left with the committed segment.
Afterwards the composer offers "Use what I said",
which puts the raw transcript back through the same path. That offer is a
question asked of the draft as it stands, on every composer rebuild, rather
than a flag set when the tidy-up landed: it is withdrawn the moment the span
can no longer be replaced — an edit inside the tidied text, or a Send that
empties the composer — while typing around the span keeps it, because the
range re-anchors and the revert would still land. A button that reverts
nothing is its own defect.

The cheap checks are tested against hand-written answers. Jev's Choice is
labeled in `app/evals/dictation-cleanup.fixtures.ts` and run with
`bun run eval:dictation-cleanup`. Which refusals fire in production, and how
often, is what the named log line is for.

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

The wire is protocol version 1 — the frames the Cloudflare voice SDK used to
write — plus a handful of custom JSON messages of ours. Since ADR 0031 the
Durable Object writes them itself; the browser client and the Flutter client
implement the same frames directly, and none of the three shares code with the
others. `app/voice/shared.ts` is where a frame is spelled once.

### Handshake

1. Connect. Server sends `{type:"welcome",protocol_version:1}` then
   `{type:"status",status:"idle"}`.
2. Client sends `{type:"hello",protocol_version:1}`, then one opening attempt:
   `{"type":"voice/open","schemaVersion":1,"attemptId":"<uuid>","mode":"start"|"wake"|"rejoin"|"control","botId"?,"callId"?,"paused":false,"muted":false}`.
   Mid-call retarget is still `voice/target` on an already admitted call.
3. Server answers `voice/admitted` once the call is owned, then
   `{type:"audio_config",format:"pcm16",sampleRate:24000}`. `voice/ready`
   follows when this attempt's Gemini setup is acknowledged. A paused or muted
   rejoin is admitted and `listening` without opening Gemini. Then
   `{type:"status",status:"listening"}`.
   It also sends `voice/target` back — on admission and again on every hand-over
   — naming the Bot the call is actually on, which is the only authority on
   that; a client that guessed could name a Bot the audio never reached.
   Or `voice/open-failed` / `{type:"error",message,code?,retryable?}` when
   the call was refused or failed to start.

The first `listening` of a call plays a short confirm
(`assets/voice/connect.wav`). A later `listening` — a wake, a rejoin — does
not.

Assistant PCM in both directions is a binary envelope: version 1, a 16-byte
attempt UUID, a little-endian unsigned 32-bit sequence, then PCM16. The client
holds opening audio until `voice/ready` for this attempt.

The Gemini setup enables both session resumption and sliding-window context
compression. Resumption carries a call across a closed or replaced socket;
compression keeps a long audio conversation within Gemini's context window.
Neither replaces the durable call ledger.

Before `voice/open` is accepted the server may send a custom refusal so the
client can say why:

```json
{ "type": "voice/refusal", "schemaVersion": 1, "code": "exclusive" | "quota" | "unconfigured", "message": "…" }
```

`exclusive`: another device holds this account's session. The newer call wins:
the server ends the older call (that client sees `status: idle` and a
`voice/refusal` with code `superseded`) and admits the new one.

### Audio up

Binary frames: a version-1 envelope (16-byte attempt UUID, little-endian
unsigned 32-bit sequence) then PCM16 little-endian, mono, **16 kHz**. Frame
size is the client's choice; 40 ms (1280 bytes of PCM) is what both clients
send. Each payload is base64'd into one `realtimeInput.audio` message at
`audio/pcm;rate=16000`, which is the rate Gemini Live wants, so nothing is
resampled anywhere. The client holds opening audio until `voice/ready` for
this attempt. The server's own setup buffer is only bounded defense.

### Audio down

Binary frames: the same envelope, then PCM16 little-endian, mono, **24 kHz**,
arbitrary chunk boundaries (a chunk may end on an odd byte; carry the byte).
This is Gemini's own output rate, sent on as it arrives. The client plays them
in order and measures amplitude from what it is playing.

`voice/delegation` (`botId`, `botName`, `runId`, `state` ∈ `asked |
answering | finished`) tells the voice surface where a request to a Bot is:
asked, its answer being put into words, done. `runId` is the Turn the request
became, so the activity slot opens that Work. Chrome only; nothing durable
turns on it.
`voice/speech` reports actual playback. The clients still send it and the
server still accepts it, but nothing turns on it any more: deciding when a
late answer may be spoken is the session's own job now, which is what
`scheduling: "WHEN_IDLE"` asks for.

### Status

`{type:"status",status}` with `idle | listening | thinking | speaking`.
`{type:"playback_interrupt"}` means drop every queued chunk and stop the
speaker now. Transcript frames (`transcript`, `transcript_interim`,
`transcript_start/delta/end`) arrive too; the footer shows none of them.

### Ears

There is no transcriber. The session hears the audio itself, decides where a
turn ends with its own voice detector, and answers in its own voice. Both
directions ask for SMART transcription: finals are cleaned, and
`interimInputTranscription` becomes `transcript_interim` on the client
wire without touching the ledger. The
`inputTranscription` and `outputTranscription` it returns are what the client's
transcript frames carry and what the ledger's turn records are built from.
Input transcription usually arrives _after_ the model has started answering,
which is why a turn's transcript is written again when the turn settles: the
fullest text there will ever be is the one at the end.

### Barge-in

The model's own detector is the one that matters. When it hears the person
over a reply the session sends `serverContent.interrupted`, and the object
answers the client with `{type:"playback_interrupt"}` and stops forwarding
what is left of that turn — audio already queued is for a moment that has
passed.

On a capture path with effective acoustic echo cancellation, the client sends
the cleaned microphone continuously while playback is audible. Its local
speech gate may stop the speaker immediately on a sustained onset and send
`{type:"interrupt"}` as a latency optimisation, but it does not gate the
audio Gemini hears. Gemini's automatic activity detector is authoritative:
its `serverContent.interrupted` confirms the interruption upstream.

On a capture path without effective echo cancellation, the client sends
silence while playback is audible and disables local barge-in. Speaker output
is otherwise indistinguishable from the person to the local gate or to
Gemini, and sending it created self-interrupting reply loops. These surfaces
therefore require the person to wait until playback finishes. Native Android,
iOS and macOS label each frame with Silero v6 (ONNX) so a slammed door is
not an onset; the browser, and a native runtime that failed to load the
model, keep the energy heuristic. Timing — 120 ms onset, 900 ms hangover,
500 ms pre-roll — is the same on every path. The gate still does not decide
which frames an awake session sends.

An interrupt never cancels a Bot Turn the session already started with
`subagent`: that work is durable in the Bot.

### A turn is the model's own

There is no turn loop here any more, and nothing to fill a silence with: the
model hears the person and starts speaking, and what used to be the gap — a
transcriber committing, a chat model connecting, a first token — is inside one
session that was already open. The bridges, the acknowledgment delay and the
`model-first-text` timing went with the cascade.

What the object still does on a turn is bookkeeping, and it does it in order:
the first sound or word of a model turn admits a ledger turn (which is what
the day's allowance counts and what memory reads), the turn is settled when
the session says the turn is over, and the transcript is written again with
it.

A function call runs while the model keeps talking. Every declaration is
`NON_BLOCKING`, the object runs the call and answers it with
`scheduling: "WHEN_IDLE"`, so the result is spoken at the next pause rather
than over whatever is being said now. A call the model withdraws
(`toolCallCancellation`) is dropped rather than answered.

The instruction is rendered once, at setup, because a Live session cannot be
re-instructed: everything the model will need for the whole call goes in then
— who it is, how it sounds, its memory, the tail of its thread, the account's
directory, the person's timezone and the clock. It is ordered the way Google's
Live guidance asks: **who you are**, then **how this conversation goes**, then
**rules you do not break**. Relative dates such as "today" use the person's
local clock, and time-sensitive work handed to `subagent` carries the resolved
dates and zone.

### A reply that fails

A turn that makes no sound at all reaches the client as
`{type:"error",message}` and the call goes on — the client shows the sentence
for four seconds and does **not** hang up. Two things produce it: a turn that
has said nothing eight seconds after it began, and a turn that reaches its end
having bridged no audio. Whichever surface the call is on says it: voice mode
carries it in the activity slot where the call's other output goes, and a call
with another Bot carries it on the account-wide footer, both with the same
precedence — a failure first, then a call that has ended, then a notice — so
the two cannot disagree about what is being said.

The old speech-provider wrapper (`tts-guard.ts`) was the same guard in the
only place that could see it then; this is the only place that can see it now.

A session that closes on its own is the other failure. The object tells the
client one sentence, keeps the call, and leaves the person able to speak
again; the one close it treats specially is **1008**, which is the Live API's
answer to a resumption handle it has forgotten (see Sleep and wake).

An error frame that carries a `code` still means the call itself has failed
and has been torn down behind it; the client ends the call and shows the
failure rather than leaving a live-looking surface over a socket nobody is
listening on.

A `subagent` result that settles while the call is live goes back to the
session as that function call's own late response, scheduled `WHEN_IDLE`, and
the model decides what to say with it — one or two sentences, or nothing. If
Gemini is asleep from quiet, the object wakes it first so the person hears
the answer without speaking. A Pause the person started does not: that waits
for Resume, and a muted call waits for unmute. Hang-up still writes the
answer into chat. It is told in one of two shapes. Work the Bot on the call started is its own and
comes back with no name and an instruction to speak in the first person —
"Done, the flights are booked", not "Sunny answered about the flights". An
answer from a Bot the call has since handed over from keeps its name, because
there the person really is being told about somebody else. Either way the
words are marked as quoted data rather than instructions.

If the session that made the call has been replaced since — a wake, a
hand-over — there is no function call left to answer, and the result goes in as
a turn of the conversation instead, saying in its own words that it is a Bot's
answer quoted as data. A later live call is told the same way. With no live
session at all the Bot writes the answer into chat. A socket that drops without
`end_call` keeps the call inside the rejoin window, and an answer arriving
then waits for the same device to come back to the same conversation.

### Sleep and wake (cost control)

A Live session bills the audio that crosses it, in both directions, and output
costs about 3.6x input. So the session is closed when nobody is talking, and
nothing at all is spent in between — no listening, no deliberating, no
subagent admitted.

- The client runs a speech gate on every frame: an onset that needs several
  consecutive speech frames, a 900 ms hangover, and a 500 ms pre-roll ring.
  Native Android, iOS and macOS label a frame with Silero v6 over the PCM
  capture already owns — the plugin never opens a second microphone. The
  browser, and a native runtime that cannot load the model, compare energy
  to an adaptive floor. The gate decides when to **wake** a closed session
  and, only with effective AEC, when to stop its own speaker early. It is
  not a turn detector and does not decide which frames an awake session
  sends.
- While the session is open the client sends a frame every 40 ms, speech and
  silence alike, through pauses inside a sentence. While the model is
  answering, AEC surfaces keep sending the cleaned microphone so Gemini owns
  barge-in; surfaces without AEC preserve cadence with silent frames until
  playback drains. Turn boundaries are the session's to find.
- When `status` is `listening` and the gate has been closed for **2 min**
  continuously, the client stops sending frames and sends
  `{type:"voice/sleep",schemaVersion:1}`. The object closes the Live socket
  (Gemini is gone, no billing) and keeps its newest resumption handle. Capture
  continues locally. A `subagent` that settles in that window wakes Gemini
  again so the person hears the answer without speaking first.
- On the next onset the client sends `voice/open` with `mode:"wake"`,
  holds the last **500 ms** of audio from its pre-roll ring until `voice/ready`,
  then drains it and live frames.
  The pre-roll obeys the same rule as any other frame: on a capture without
  AEC, a wake that happens while the speaker is still audible replays silence
  rather than what the microphone heard of the speaker.
  The object reopens the session with the handle, buffers frames until the
  setup is acknowledged, and drains them in order. No syllable is lost, and
  the model remembers the conversation: a resumed session answered a question
  about a fact established only in the session before it.
- A handle the server no longer knows closes the socket with **1008**. That is
  the only signal that the window has passed, so the object reopens fresh and
  carries the tail of the call into the new instruction under
  `<where-we-were>` — the person is not asked to start again.
  `VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1` stays our own policy about a device
  coming back, not a guess at Google's window, because Google states none.
- `goAway` — the server saying it is about to close — reconnects with the
  handle immediately rather than letting the person hear the drop.
- The object also sleeps on its own after 30 s without an audio frame, so a
  client that never says `voice/sleep` still stops the meter.
- **Pause** is the person doing the same thing deliberately: the client sends
  `voice/control` with `action:"pause"`, stops the reply that is playing, and —
  unlike the gate's own sleep — wakes for nothing but Resume, which sends
  `voice/open` with `mode:"wake"`. Pause starts nothing and cancels nothing: a `subagent` Turn
  already admitted is the Bot's work, not this socket's, so it carries on, and
  what finishes meanwhile is counted on the Resume control rather than
  unhibernating Gemini. The call record is marked paused, so a socket that
  then dies keeps the long rejoin window rather than the 60 s one.
- **Leaving the app** is Pause for the background: `hidden` and `paused`
  send the same `voice/control` pause, release the microphone,
  and keep the client socket. Coming back wakes it. A Pause the person
  already started stays paused. `detached` still hangs up — the view is
  gone. A socket the OS kills without hang-up is not a hang-up: the
  surface stays up, and coming back opens a new socket onto the same
  durable call. The record lasts twenty-four hours from that Pause, not
  60 s. A live conversation that drops without pausing is still the 60 s
  window, as it always was.
- Server reports `{type:"voice/state",schemaVersion:1,upstream:"awake"|"asleep"|"starting",muted:boolean}`.

Between idle `voice/sleep` and a wake `voice/open` the client sends no audio. While
asleep, `status` stays `listening` on both sides; the footer keeps animating
from the local microphone.

A search the model was running dies with the socket: grounding runs inside the
session. Acceptable, and stated so in ADR 0031 — the person asks again.

### Mute

`voice/control` with `action:"mute"` and `muted:true`: the client stops sending
frames; the server closes the Live session at once. `muted:false` resumes
gating; the next speech onset reopens it as above. Mute does not end the call
and does not stop playback of a reply already in flight.

A client keeps two inputs apart: the person's own mute toggle, and a
temporary hold while dictation borrows the microphone. What goes on the wire
is the effective value (either one), so the billed transcriber sleeps for the
whole of a dictation, and releasing the hold restores the person's own choice
rather than unmuting them.

### End

`voice/control` with `action:"end"`, then close. The model can also call `end_call` as a
Live function when the person says they are done; hang-up waits for that
spoken turn, then the object does the same as the client's hang-up and closes
the socket so the surface says the call ended. The server closes the Live session, settles
its meters, and answers `status: idle`. Closing the
socket without `end_call` closes the Live session and settles its meters the
same way, but does **not** end the call: the call record survives the rejoin
window so a client back from a network change continues the same
conversation, and an alarm ends it if nobody comes back (see "Session
memory"). A live drop has 60 s; a Pause, or the app leaving the screen, has
twenty-four hours. A Bot Turn the assistant already admitted keeps running; its answer
is told on this call if the same device rejoins it in time, on a later call
if one is already up, and written into chat if nobody is listening. Hang-up
also writes the call's spoken turns onto that Bot's thread as one collapsible
**Voice chat** section, keyed by the call id so a hang-up and the
abandoned-call alarm do not write two. A call that never said anything writes
nothing. The work the call started stays as "Message from Voice" markers; the
accordion is the spoken dialogue, not those Turns.

The client closes with a code and a reason that name the path that ended the
call, because the server's log is the only record of it: `1000` with
`end-button` or `lifecycle:detached` when the person or the view ended it, `1000`
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
was not the account's and was closed with `4403`), `call-admitted` (with the
Bot and the voice it opened on), `upstream` (`starting` | `awake` | `asleep`,
and whether this one is a resume and how many lines of handover it carried),
`upstream-failed` (the session could not be opened at all), `upstream-closed`
(the session went on its own, with the code — `1008` is a handle the server
has forgotten), `upstream-goaway` (the server is about to close it), `listening`,
`turn` (a model turn admitted, and how many characters of the person's words
had been transcribed by then — never the words), `turn-settled` (its
milliseconds, the answer's length and the audio bridged for it; an answer of
zero bytes is a turn that never became sound), `turn-silent` (a turn that had
said nothing after the guard's window, so the client was told), `tool` (a
function call, by name and id, never its arguments), `tool-cancelled`,
`interrupted` (with `source`: `model` when the session's own detector heard
someone, `client` when the phone's speech gate did), `call-switched` (with the
Bot and voice the session reopened as), `answer-told` (a subagent result went
back, under its own call id, as a turn, or as a chat message after hang-up),
`usage` (the session's own token counts at a turn's end),
`refused` (with the code and sentence the client was sent), `call-ended` (with
the call's total audio chunks, bytes and turns), `call-memory` and `closed`
(the client's code and reason). Every line carries the connection id, and —
once `onConnect` accepted the socket — the device key; `refused-identity`
carries the device key from the header it just rejected, and the `closed` line
for a refused socket has none. Once admitted, every line also carries the call
id and elapsed milliseconds.

A call that reaches `listening` and then `closed` with no `turn` in between
means nothing the person said ever produced an answer; read the `upstream`
lines first. No `awake` line means the session never acknowledged its setup —
the connect stalled or was refused — and `upstream-failed` or `upstream-closed`
then says why. Only the `closed` code and reason say which side closed the
client's socket.

No trace line carries the words. What a person said, what each Bot answered
and what became of each request are readable afterwards from the ledger
itself, through the token-gated operator read `GET
/api/debug/voice?userId=<id>` — a read of storage that ends no call and
expires no delegation. The fields are documented in
`.claude/skills/frockbot-debug/SKILL.md`.

### Timing a slow call (opt-in)

A call that takes too long to answer is slow somewhere, and the ordinary trace
above cannot say where: it starts at `connected`, by which point the press, the
permission prompt, the audio session, the upgrade and this deployment's
authentication have all already happened. The diagnostics are the answer to
that one question and nothing else.

They are off. A client build turns them on for itself with
`--dart-define FROCKBOT_VOICE_DIAGNOSTICS=true`; every shipped build compiles
them out (`apps/native/lib/voice/diagnostics.dart`). In this repository the one
build that sets it is the development desktop app, built with
`bun run update:desktop --voice-diagnostics`
([`apps/native/README.md`](../apps/native/README.md), "macOS"). A build that
opted in generates one random v4 UUID per call, puts it on the assistant socket
as `?trace=`, and writes a line per milestone under it. Native diagnostic
builds additionally write `voice timing {json}` lines to `events.jsonl` inside
a fresh `frockbot-voice-timings-*` directory in the app's system temporary
directory (`$TMPDIR`). This captures normally launched macOS apps whose stdout
is not available in unified logs. File writes add a small amount of diagnostic
overhead; they run only in opt-in builds. Remove these temporary diagnostic
directories when finished. The server writes its own lines under the same id —
but only when the value is a UUID. Anything else enables nothing and is never
echoed anywhere.

The trace is not a credential and grants nothing: the bearer header still
decides who may open the socket, the id names nobody, is never stored in the
durable call ledger, is
dropped when the socket closes, and is regenerated by the next call. No line
on either side carries a word anyone said, a prompt, a header, a URL or a key
— ids, counts, booleans and short tokens only.

Every line is `voice timing {json}` with `trace`, `side`, `event`, `elapsedMs`,
`at` and the named fields for that milestone. There are three sides, and
**their clocks are three different clocks**: `client` is monotonic from the
press, `edge` from the entry Worker receiving the upgrade, `server` from the
voice object accepting the socket. Read the three sequences beside each other;
never subtract one side's elapsed from another's.

- **`client`** (`apps/native/lib/voice/assistant.dart`, where each is
  documented): `controller.start`, `route.begin`/`route.ready`,
  `capture.open`/`capture.ready` (the permission prompt is inside this one),
  `socket.open`/`socket.ready` per attempt, `socket.welcome`,
  `call.start-sent`, `microphone.first-frame` (with `silent`, so a device
  handing over zeros is told from one that never opened),
  `microphone.first-signal`, `microphone.first-speech` (the gate's speech
  decision, not a transcript), `upstream.asleep`/`upstream.starting`/
  `upstream.awake`, `call.listening`, `audio.first-down`, `player.first-feed`,
  `player.first-played`, and `call.end`/`call.ended`/`call.failed`. Read the
  names per milestone rather than as one order: the socket attempt runs beside
  the route and the capture, so `socket.open` precedes `route.begin` and
  `socket.ready`, `socket.welcome`, `upstream.*`, `call.listening` and
  `audio.first-down` land whenever the attempt and its frames arrive,
  interleaved with the capture opening. The two player lines are the speaker
  seam and **neither is an audible start**: a feed is audio handed to the
  platform, a receipt is one buffer past the playback head, and the room's own
  latency is not observable from the process.
- **`edge`** (`apps/cloudflare/src/index.ts`, `gateway.ts`): `edge-fetch`,
  `edge-backend-ready`, `edge-auth-start`, `edge-auth-ready`,
  `edge-assistant-forward`, `edge-assistant-upgraded`, `edge-answered`.
- **`server`** (`apps/cloudflare/src/voice-assistant.ts`): `connected`,
  `start-call` (written before the first awaited read, so the gap to the next
  line is storage), `cap-checked`, `ledger-checked`, `call-admitted`,
  `target-resolved`, then the prompt the session is instructed with —
  `prompt-context-start`, one line per constituent read
  (`prompt-directory`, `prompt-user-memory`, `prompt-timezone`,
  `prompt-voice-memory`, `prompt-bot-identity` (the actual identity-read
  duration reused from target admission), `prompt-bot-memory`,
  `prompt-bot-history`, each with its `durationMs`),
  `prompt-context-ready`, and `prompt-context-awaited` where the session
  actually waited on it, followed by the fresh `session-voice-memory` read
  with its own duration — then `upstream-open-start`, `upstream-socket-open`,
  `upstream-setup-sent`, `upstream-setup-ack`, `listening`,
  `client-audio-first` (the first frame this session received, which is not the
  microphone's own first frame), `upstream-audio-held`/`upstream-audio-sent`
  (with `buffered`: audio that waited for the setup), `upstream-audio-first` and
  `client-audio-out-first` (received from Google, then handed to the client,
  with this object's own turn admission between them),
  `delegation-dispatched`/`delegation-answered`, `refused`,
  `upstream-failed` and `closed`.

The hand-off lines carry the run id but the Bot's Turn does not carry the
trace: a Turn's payload is durable, and a diagnostic id has no business in a
durable shape. The correlation for a delegation is this object's own two
lines around it.

### Text turns

`{type:"text_message",text}` sends the words to the session as a whole turn
(`clientContent` with `turnComplete`), so the model answers them aloud without
anyone speaking. Not used by the footer; kept for tests.

## Durable ledger

`VoiceAssistant` is one Durable Object per User (`get(idFromName(userId))` on
the upgrade; `getAgentByName` is reserved for RPC such as the dictation
lease, because it waits for `onStart` before returning a stub),
`new_sqlite_classes` migration `v7`. It records, before any external call:

- `session:<callId>` — call start, device, caps consumed.
- `turn:<turnId>` — each model turn, admitted the moment the model starts
  answering, with its key `voice-turn:<userId>:<callId>:<sequence>` and its
  outcome. Its `transcript` is what the session had transcribed of the person
  by then, written again when the turn settles because the fuller text
  usually arrives while the model is already speaking; its `answer` is the
  session's own output transcription. A turn admitted and never settled (an
  eviction, a session that dropped) is marked `abandoned` on the next start.
  Hang-up copies those spoken turns onto the Bot's announcement log as a
  `voice/call` event, drawn in the thread as a collapsible Voice chat section.
- `delegation:<runId>` — a Bot delegation: target Bot, text, `runId` derived
  as `sha256` over `userId`, `callId`, `turnId`, `botId` and `text` joined by
  NUL (so a retried tool call admits the same Bot Turn once), and state
  `admitted | settled | spoken | cancelled | expired` — `spoken` is told to
  the assistant or written into chat; `cancelled` is an explicit stop, not a
  hang-up.

A `subagent` call uses the Bot's `runVoice` door and the existing agent lane.
The command records the call, voice Turn and request IDs before dispatch;
the target Bot admits the same `runId` once. Active conversations and Routines
finish normally, then queued voice requests run in FIFO order with User work
prioritised. A voice request never makes existing work yield. Ending or
interrupting the voice call does not cancel accepted Bot work. The `cancel` tool requires an explicit request to stop the call's own Bot and
records intent before sending its authenticated stop command.

The Bot receives `reply_to_request`, whose `reply/to-caller` event addresses
this voice request. This is a separate delivery from `send_to_user`: an
explicit message to the User may still be sent, but cannot substitute for
the required caller reply. The thread marks the request with one centred
"Message from Voice" line rather than a user bubble, and the request and its
answer are read on the exchange view that line opens — the same convention a
message from another Bot follows. The reply itself creates no ordinary User
message or notification. Private model text is never used as the answer.

A terminal Bot Turn records a completion outbox entry in the same durable
transaction. That wake tells the owning voice object which request to look
up; the voice object reads the correlated run instead of trusting copied
answer text. Scheduled `checkDelegation` look-ups remain as recovery for a
lost dispatch or wake. A callback schedules its next check without deduping
onto its own executing schedule row, which the scheduler will delete. A
lookup that finds no admitted run resends the same recorded intent under the
same ID, with bounded retries and an explicit failure when exhausted.
`onStart` recreates pending checks from the ledger. Ending a call does not
cancel accepted work: an unspoken answer is told to the next live session, or
written into the Bot's thread if nobody is listening.

A settled answer goes back to a live session as that function call's own
late response (`announceDelegation`), scheduled `WHEN_IDLE` so the model says
it at the next pause and decides for itself whether it is worth saying. The
delegation is marked `spoken` the moment it is handed over — told once,
whatever is then said. A later call that is already up is told the same way.
With no live session the Bot writes the answer into chat as an ordinary
message on the request's own run. A new call is told silently about work
that is still running (`<running-tasks>`), and does not announce it.
The User Memory profile and the last 30 days of its log are read at call start
through `MemoryStore` over the User Durable Object's generation ledger (so
retractions and shards resolve as they do for Bots), and Project memory is
read on demand through the same store when the assistant's `recall_project`
tool asks for it. Live Bot directory and run status are read from
`UserConfiguration.listBots` and the Bot's run projection, never from
memory.

### Reading a Bot without asking it

`read_history` reads recent visible conversation directly from the Bot's
run projection. `search_history` queries the existing account transcript
index for that Bot, then reads the matching runs to retain the actual
speaker. Neither tool takes a Bot ID: the loop supplies the call's own Bot,
already checked against the User's directory when the call was admitted. They
admit no Bot Turn, call no Bot model, and leave running
work alone. `status` reads authoritative running, queued and terminal
state plus the most recent explicit reply; it never quotes partial model
text or a private model outcome.

History and search default to six messages or excerpts, accept at most eight,
and bound each text to 320 characters and the encoded result to 3,900
characters. Results keep speaker roles, run references and available message
references; voice and other-Bot requests are not labelled as User messages.
Timestamps are explicitly labelled as Turn admission times, the timestamps
available in the public projection. The search query is bounded to 256
characters and only requests User/assistant conversation rows, excluding
private tool output. Search reports its index state and may lag unsettled
work; current-progress questions use `status` instead. Returned excerpts
are quoted data, not instructions for the voice assistant to follow.

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
enough to exceed a storage value cannot exist. The turns that told the
assistant a Bot's answer are left out: a Bot answering is not something the
person said, and what the assistant made of it is not theirs either. They are
still in the call's own history, so later turns know what was told.

The task claims the job (`pending` → `spending`, inside the memory ledger's
serializing chain — that transition _is_ the claim, so a duplicate end
notification finds nothing to claim and makes no second model call), asks the
configured chat model for a JSON update, and applies it. A call longer than 40
turns is read in as many requests as it takes, each advancing a durable
cursor, so a request made in the tenth minute is read exactly like one made in
the first. The cursor is a turn ordinal in the ledger's own sequence, not a
count of what was read — the excluded turns leave gaps in it, and an in-call
memory write stamps the same numbers, so the two order against each other.

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

| Event                                | What happens                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `end_call`                           | The job is written, _then_ the call record is deleted, then the finalization is scheduled.                                                                                                                                                                                   |
| The socket closes with no `end_call` | The upstream closes and its meter settles, but the call record **stays**: a client back inside the rejoin window continues the same conversation. An `abandonVoiceCall` alarm is scheduled for the end of that window — 60 s for a live drop, twenty-four hours for a Pause. |
| Nobody comes back                    | The alarm ends the call and queues its memory. Nothing waits for a future request to notice it.                                                                                                                                                                              |
| Another device takes over            | The displaced call's job is written _before_ the record naming it is replaced.                                                                                                                                                                                               |
| Eviction                             | `onStart` ends a call already past the rejoin window and queues it; inside the window it schedules the alarm instead.                                                                                                                                                        |

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
session may stay open silently for hours because a closed Live socket costs
nothing. What is counted per account, durably, per UTC day:

- **audio seconds in** — the person's own audio actually bridged to the
  session, at 32 000 B/s (16 kHz PCM16), bounded at 240 min/day;
- **audio seconds out** — the model's audio actually bridged to the client, at
  48 000 B/s (24 kHz PCM16), bounded at 240 min/day and capped separately
  because output costs about 3.6x input;
- dictation seconds, booked in 60 s windows and refunded on release (bounded
  at 120 min/day);
- dictation tidy-ups, one Groq call per capture, booked before Groq is
  asked and never refunded (bounded at 400/day); Jev reviews a candidate
  tidy and is bounded by that same cap;
- model turns (bounded at 600/day), and Bot delegations (bounded at 8 per
  burst, 200/day).

The two audio meters are written in five-second blocks rather than per frame:
every frame would be a storage write forty times a second in each direction,
and a block keeps the day's arithmetic honest to within one block. Whatever is
left in a part-block is written when the session sleeps or the call ends.
Exceeding a cap shuts the session, answers `voice/refusal` with `quota` and
leaves the footer open; the day rolls at UTC midnight. One live
call per account: a second device supersedes the first. Transport rotation
(a socket that is replaced by a newer one from the same device within 60 s,
for instance after a network change) rejoins the same durable call record
rather than opening a new one. A Pause, or the app leaving the screen, keeps
that record for twenty-four hours, and a new socket from the same device
continues it without opening Gemini until Resume. Raw audio is never stored
anywhere.

## Credentials

| Name                            | Where             | Required | What it enables                                                                                                                                    |
| ------------------------------- | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                | Worker secret     | yes      | Composer dictation. Absent: dictation reports that voice is unavailable.                                                                           |
| `GEMINI_API_KEY`                | Worker secret     | yes      | The continuous voice session: one Gemini Live socket per call, ears, words and voice together. Absent: starting a session is refused.              |
| `VOICE_ASSISTANT_MODEL`         | Worker var        | optional | Pins the gateway model the end-of-call memory update is asked; the platform's Auto route when unset. The call has no chat model.                   |
| `VOICE_DICTATION_CLEANUP_MODEL` | Worker var        | optional | The model that tidies a dictated transcript. Unset is `groq/llama-3.1-8b-instant`; no `AI` binding means no tidying and the raw transcript stands. |
| `JEV_API_KEY`                   | Worker secret     | optional | Reviews a Groq tidy before it replaces the draft. Absent or a failed call keeps the raw transcript.                                                |
| `VOICE_DICTATION_UPSTREAM_URL`  | test harness only | —        | Points dictation at a local fake; never set in production.                                                                                         |
| `VOICE_ASSISTANT_UPSTREAM_URL`  | test harness only | —        | Points the voice session at a local fake; never set in production.                                                                                 |

Declared in `apps/cloudflare/src/production-secrets.ts`, carried by the release
workflow, listed in `.dev.vars.example`. The release gate refuses to find
either harness door live. The `AI` binding is still wanted — it is the Frock AI
gateway transport for the end-of-call memory update — but it no longer gates
the control: a deployment without it can hold a conversation and simply
remembers nothing afterwards.

The key never leaves the Worker. A browser-style WebSocket carries no headers
of ours, so the Live endpoint takes the key on its query string, which is why
the Durable Object is the only thing that ever builds that URL.

What talking costs: Gemini Live is billed per minute of audio in each
direction, and at the 2026-09-15 GA prices output is about 3.6x input, which
is why the two meters are separate and why the session is closed the moment
nobody is talking. The cascade it replaced billed three providers for the same
minute.

## Clients

### Flutter on web, Android and macOS

`apps/native/lib/voice/` implements both protocols over the same
authenticated upgrade `NativeApi.socket()` uses (`connectSocketV1` with the
bearer header). `record` 7.1.1 captures streaming PCM16, asking for echo
cancellation, noise suppression and automatic gain wherever
`voiceCaptureProcessingV1` grants them — nowhere on the desktop, whose
processing unit silences the microphone (see "Desktop echo boundary" below) —
and requests the microphone permission itself; the app's own speaker plays the
24 kHz PCM over the `com.frockbot/pcm` channel, acknowledging a chunk only once
the device reports it played (Android's `AudioTrack` playback head, macOS's
`dataPlayedBack` completion). One device exists at a time, owned by the epoch
of the most recent `setup`, and `feed` and `release` both name the epoch they
serve: a superseded player's delayed close, or a feed from a call that has
already ended, is ignored rather than stopping the current call's speaker, and
a disposed session issues no further speaker commands while its teardown
finishes. Android declares `RECORD_AUDIO` and
`MODIFY_AUDIO_SETTINGS`; macOS carries the microphone usage description and
entitlement. `AppShell`'s lifecycle observer sleeps a live call when the
app leaves the screen — Gemini closes, the microphone is released, the
socket stays — and resumes it on return; `detached` still hangs up, and
navigation inside the app leaves the call alone. Dictation still stops
when the app is away.

**A call that is up and deaf.** A working microphone picks up a room; one
that is open and delivering nothing but zeros — what the macOS voice
processing unit does when asked for echo cancellation with nothing rendering
through the same engine (`voiceCaptureProcessingV1` in
`apps/native/lib/voice/capture.dart`) — leaves the call live with a flat
meter. Ten seconds of a live call that has never carried a single frame at or
above the room's own level — `voiceRoomToneLevelV1` in
`apps/native/lib/voice/speech_gate.dart`, far below the gate's floor, which is
where words start — says so once, as a notice on whichever surface is drawing
the call: `FrockBot isn’t hearing anything. Check the microphone in your
device settings.` It is a notice and not an error — the call is fine and the
microphone is the problem — it fires only when the call has never carried
signal at all rather than after speech stops, a quiet room being signal and so
never an occasion for it, it is not said while the call is paused or muted,
where the silence is the person's own choice, and it never ends the call.

**Desktop echo boundary.** The shipped macOS capture and playback paths do
not share an audio engine: the `record` plugin owns capture, while
`PcmSpeaker` owns a separate `AVAudioEngine` for output. Enabling the
recorder's voice-processing unit in that topology produced a silent input,
because its output side had no playback reference. Until capture and
`PcmSpeaker` are deliberately replaced by one native voice-processing graph,
`VoiceCapture.cancelsPlaybackEcho` is false on macOS, Windows and Linux. Those
clients suppress captured audio during playback and offer no barge-in; web,
Android and iOS keep processed capture, continuous microphone streaming and
Gemini-owned interruption.

**The call's audio session (Android).** A realtime call is a call to the
operating system — communication mode is where Android attaches its echo
canceller and how a Bluetooth microphone gets used — but not to the person,
who is not holding the phone to their ear. `VoiceAudioRoute`
(`apps/native/lib/voice/route.dart`, `com.frockbot/audio-route`, Kotlin
`VoiceAudioRoute.kt`) therefore holds the session the way a VoIP app does,
for exactly the length of the call: transient audio focus with
voice-communication attributes, `MODE_IN_COMMUNICATION`, and the output route
chosen in this order — Bluetooth LE or SCO headset, wired or USB headset,
loudspeaker. The earpiece is never chosen on its own. On API 31+ that is
`setCommunicationDevice`; below it, `startBluetoothSco` and the speakerphone
flag. Devices that connect or disconnect mid-call re-run the choice, and the
route in use is reported to Dart. The speaker's `AudioTrack` plays with
`USAGE_VOICE_COMMUNICATION`: in communication mode a media track is routed
like the call but metered like music — the earpiece at music volume, which is
what the footer sounded like before — while a voice-communication track
follows the communication device, rides the call volume the hardware keys
adjust, and is the reference the echo canceller listens for. For the call the
`record` plugin is told to leave the session alone (`modeNormal`,
`manageBluetooth: false`, no focus request) and to read the smallest buffer
the platform allows (`AudioRecord.getMinBufferSize`, never below one 40 ms
frame), because the plugin reads a whole buffer at a time and that buffer is
the meter's latency. Dictation keeps the plugin's own session handling. The speaker is fed the
way a VoIP stack feeds one: from `setup` until `release` a pump thread writes
a 20 ms period every period, silence when nothing is queued. A track written
only when a reply is playing underruns while the Bot thinks; on the VoIP
output path Android then drops it from the mixer's active list, a writer
blocked on it never returns, the playback head stays at zero and no receipt
is ever sent — and a client that believes it is still playing sends silence
upstream, so nothing said after the first reply is heard. Receipts still
follow the playback head and only audio earns them. Because a receipt means
played, everything inside the device buffer is still in flight, so the Dart
player keeps fifteen chunks (half a second) outstanding against a 100 ms
device buffer; a narrower window lets the pump pad a sentence with silence
whenever a chunk is late. A
transient focus loss — a ringtone, a navigation prompt — holds the call's
microphone the way dictation borrows it and stops the reply; a permanent loss
ends the call with a sentence. macOS routes on its own and gets the no-op
route. An A2DP-only Bluetooth speaker (no hands-free profile) cannot be a
communication device on Android, so during a call the loudspeaker is used
instead; an output picker over the reported route is the next step if that
matters.

**A Bot answering a voice request.** The Turn is admitted with a `voice`
origin and gets `reply_to_request`, which is the one answer the call is owed:
it goes back to the voice object, mints no message and wakes no device. If the
call has ended by then the voice object writes that reply into chat as an
ordinary message on the request's own run. It is
an `agent` Turn, the same kind a Bot-to-Bot question runs as, and which tools
an `agent` Turn admits is the kernel's rule, in `docs/architecture.md` §4
(tool exposure). Before that admission existed a Bot on a call was refused its
own apps and told the caller the app had been disconnected.
The prompt says to say the answer once and not to write it, or a version of
it, into the conversation as well; `send_to_user` on such a Turn is for a brief
progress note on work longer than a minute and for material that cannot be
spoken (a link, a table, code). A send the Bot makes anyway still lands in
the thread and counts as unread, but carries `notify: false`
(`app/notifications/messages.ts`): the person asked out loud and is on the
call, and a buzz for what they are being told aloud is noise.

**Where a call starts, and voice mode.** Since ADR 0029 the way in is the
voice control at the far right of the Bot's composer, its own fixed control
beside the one that morphs between dictate, send and stop — voice is not a
mode of the draft, and a target that moved under the thumb would be pressed by
accident. It starts the call on that Bot, and pressed on a different Bot while
a call is up it moves the call rather than ending it. It is the only way in:
the sidebar's list-root control — the last botless entry, which opened a call
on the account's General — is gone, and the shell's start takes the Bot as a
required argument, so a call always names one. It never ends one either: while
the call is with the Bot whose page is open, voice mode is drawn where the
composer was and the control is not there to press, so a call ends from the
surface drawing it — voice mode's own End, or the footer's End for a call with
another Bot. While a call is on the Bot on screen the page is
in **voice mode**: the desktop sidebar collapses so the Bot fills the window,
and Back disappears — including the Android system gesture, which ends the
call instead of leaving a page with a call running behind it. A hand-over
moves the page to the new Bot, but only when the call was the thing on screen,
so somebody who walked to another Bot while the call carried on is not dragged
out of it.

**The voice surface.** The thread and composer stay. A live call sits in the
conversation header as a compact cluster (`apps/native/lib/voice/call_chrome.dart`);
hang-up is there, and the composer's voice control turns the Bot's primary
colour while this Bot's session is up. After hang-up the spoken turns land
in the thread as a collapsible **Voice chat** section — the durable
`voice/call` announcement on that Bot, not captions during the call. A call
with a Bot other than the one on screen keeps the small account-wide footer
instead, which is why that footer still carries mute, End and the meter.

Every band of the surface has a fixed height, so nothing moves as the state
changes: the character in its ring, the Bot's name, and one word under it —
`Listening`, `Speaking`, `Paused`, which is all a paused call says, or
`Call failed` and `Call ended`, which are what the word says instead of
claiming a call that is over: the first for a call that failed, the second for
one the server closed first, which is over without anything having gone wrong.
Under that is the activity slot, itself fixed. It holds the line the
call is saying about itself — a failure that ended it, the end itself, or a
notice borrowing the slot for its four seconds — and otherwise one chip per
`subagent` hand-off
the call has made: `Working` while the Turn runs, and `Work` once it settles,
which opens the Turn the hand-off became — the `voice/delegation` frame names
the `runId`, so that is the only Turn a chip can open. The bottom bar is
Pause, the meter and End, and while paused it is a wide Resume — badged
with how many hand-offs finished while nobody was listening — and End. An
on-page mute is still not built: Pause is the control that stops the line.
The bar above keeps the Bot's name, a `Voice` mark saying why the thread is
gone, and the Computer; every other door leads out of a call that has no way
out but ending it.

**Starting.** The call's surface is on screen in the frame of the press —
voice mode on the Bot whose page it is, the footer below the shell for a call
with another Bot — because the shell opens the call in the same synchronous
step, before it awaits anything. Every
AudioManager call runs on the route's own thread — choosing the
communication device is a synchronous call into the audio server of several
hundred milliseconds, and on the platform main thread it held every frame of
the footer's entrance. Measured on a Pixel 9a: the
capability probe is read once at sign-in rather than on the press, the
controller is created and shown before anything is awaited, and the socket
upgrade runs concurrently with the audio session and the microphone (the
permission prompt is the slow part). The upgrade is forwarded to the voice
object without waiting for its Agent `onStart` RPC; recovery still runs as
that fetch starts the object. One connect attempt is given ten seconds — a
cold object can spend most of that starting — and a timeout is not retried,
because a second upgrade would only race the first. A refused socket is
retried once. A socket that dies while paused, or while the app is off
screen, is not a hang-up: the surface stays, and coming back opens a new
socket onto the same durable call. `hello`/`voice/open` — which wake a
metered upstream — wait for both the server's `welcome` and an open
microphone, so a person still answering the permission prompt is not billed.

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
teardown finishes the Bot's composer is back with its voice control held —
drawn as held, and refusing the press, until the session has finished ending.
One call has one teardown, whichever path reaches it — End, a failure, the
server closing first, the shell disposing the session that is over — so a
superseded session can never close the capture or the audio session a second
time, and a session disposed before it started has nothing to give back: it
never begins the audio session, and the platform is never asked to stop a
recorder that never opened.
The capture and the Android audio session are the shell's, lent to one call at
a time: the next call's press waits on `AssistantSessionController.released`
before it opens them. Nothing is queued: the control says so, and the person
presses again.

Both meters are the same five pills (`apps/native/lib/voice/waveform.dart`):
one object whose motion source changes with the call, the way the shipped
assistants do it (Gemini's bars, ChatGPT's orb, Alexa's ring). Sound from the
person raises the pills in white; sound from the Bot raises them in the deep
rose; and every state with no sound to show is told by how the pills move
rather than by a label — a slow breath together while the call connects, a
regular chase while the Bot thinks, still dots while it listens and hears
nothing, dim dots asleep or muted. Regular motion is the machine's own;
irregular motion is somebody's voice. A time-based envelope per pill (about
20 ms attack, 200 ms release, the middle pill fastest) is fed by the
microphone RMS every 40 ms frame and the playback RMS per fed chunk;
the person/Bot tint and the dimming ease on their own envelopes so nothing
flickers. Audio events only set targets; a `Ticker` integrates them once per
display frame and the painter repaints through its `repaint` listenable —
no build, no layout, no `setState` on the audio path, a `RepaintBoundary`
around the meter, five `drawRRect` calls on one reused `Paint`, no path
built and nothing allocated per frame. The ticker stops once every pill is at
rest and follows Flutter's ticker lifecycle. Reduced motion snaps to the
level and state without the machine's own motion. Controls keep 48-point
touch targets in both themes.

The composer's dictation strip is a scrolling history, not those five pills.
Each bar is the peak of 60 ms, then peak-hold automatic gain
(`VoicePeakGain`) maps it onto the recent talking volume so a whisper and a
shout both bounce to the top of the pill. The ceiling attacks instantly and
falls with a 1.6 s time constant; a new capture resets it.

### Frames a client must ignore

The Cloudflare voice SDK used to send `cf_agent_identity`,
`cf_agent_mcp_servers`, `diagnostic`, `metrics`, `turn_metrics` and
`completion_outcome` text frames. Nothing sends them now, and both clients
still know the names: the rule that matters is that a client drops any type it
does not know rather than ending the call over it, which is what lets the
server's frames change without a client release.

## Verification

What was run on 2026-09-10 in the crew worktree, with the results as they
came back. Except for the live run recorded directly below, nothing here
involved a real microphone or a real provider.

Read the whole section as history. It describes the cascade, and ADR 0031
replaced it on 2026-09-17; the suites it counts were rewritten with it, and
what runs now is the bun tests over `app/voice/gemini-live.ts`, the assistant's
instruction and tools, and the workerd suite driving a whole call against a
scripted Live upstream. The counts and scenario lists below are the evidence as
it stood:
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
an abandoned call. They also predate the per-Bot call of ADR 0029, which adds
bun tests for the voice catalog, the narrowed tools and the first-person
read-out, workerd scenarios for the targeted call, a durable hand-over and a
borrowed voice, and Flutter tests for voice mode collapsing the desk sidebar
and taking the system back gesture. They also predate the tidy-up after a
capture described under "Tidying the capture", which adds bun tests for the
cheap checks and the Jev Choice (run with no live model), workerd scenarios
for the frame order and for each way the tidy-up can fail leaving the raw
transcript, Flutter tests for the span replacement, the revert and a late
result after Send, and composer widget tests for the offer. The
numbers below are therefore understated, and they now also predate the Gemini
Live session itself; the next run of the suites should replace them wholesale
rather than add to them.

### The live endpoint, 2026-09-11 (historical)

Everything in this section is the cascade: ElevenLabs Scribe listening,
`gpt-transcribe` under the old `VOICE_ASSISTANT_STT=openai`, and a chat model
between them. ADR 0031 replaced all three with one Gemini Live session on
2026-09-17, so the frames below are a record of what was once proven and not a
description of what runs. The Live API's own observed shapes are in
[`voice-gemini-probe.md`](voice-gemini-probe.md).

#### What was seen then

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
with the real key (`?as_user=development`): `welcome`, `hello`, `voice/open` →
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
after 2 min quiet in `listening`, wake with pre-roll in order, mute, barge-in
only on the stricter detector while speaking, refusal ends the call), the
dictation controller (opening audio in order after `ready`, microphone and
socket in parallel, live captions held until the committed segment, stop
before ready, text after a Bot switch to the original draft, error keeps the
draft, final timeout), microphone ownership, and the Flutter equivalents of
each.

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
OpenAI deltas are accumulated per item so a `stop` can land one committed
segment rather than a live caption. Regression tests cover configuration acknowledgment,
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

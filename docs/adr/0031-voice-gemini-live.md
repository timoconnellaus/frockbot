# ADR 0031: Voice is a Gemini Live mode

Status: accepted, 2026-09-17. Decisions are Tim's from the 2026-09-17
discussion. Supersedes the cascade, the ElevenLabs voices and the
"thread still readable" parts of [ADR 0029](0029-voice-per-bot.md); the
rest of 0029 — one Bot per call, `switch_bot`, first-person read-out, the
composer's voice control — stands.

> **Note, 2026-09-25.** Bot templates were removed, so decision 6's "templates
> carry the setting" no longer applies. They will return as "Share a Bot", a
> link from the Bot itself.

## Context

Voice was a cascade: the phone's PCM to a `VoiceAssistant` Durable Object,
ElevenLabs Scribe for ears, a thin chat model for the words, ElevenLabs
Flash for the mouth, with the Bot as the voice layer's worker on its `agent`
lane so the person never waited on a Bot Turn. The cascade was chosen over
speech-to-speech for cost and lock-in (`docs/` latency plan, 2026-09-12).

Gemini 3.8 Live (GA 2026-09-15) changes both. It is one bidirectional audio
session at $0.005/min in and $0.018/min out; function calling is
non-blocking by default, so the model keeps talking while our server runs a
tool; Google Search grounding is a built-in the session runs itself; and
the voice is a fixed field plus prose, so a Bot's voice can be described.

## Decision

**Voice is a different mode of the Bot, on Gemini Live, with the Bot's
context and one extra tool — a subagent. It does not share the thread.**

1. **One session replaces the cascade.** The `VoiceAssistant` object opens
   one `bidiGenerateContent` socket per call: the Bot's rendered system
   instruction, `speechConfig.voiceName`, the voice tools as function
   declarations (non-blocking), `googleSearch` as a built-in. Audio is
   bridged both ways; the client wire (`docs/voice.md`, 16 kHz up, 24 kHz
   down, the same frames) does not change. Affective dialog is not sent: the
   3.8 Live model accepts the field at setup and then closes the socket on
   the first content frame, so delivery goes through the prose alone.
   `languageCode` is never sent either — the model does take it, but the
   language is pinned in prose beside the accent, and one place is enough.
2. **The model decides what is long.** Its tools are the Bot-scoped reads
   and memory tools it already had, `switch_bot`, and `subagent`: hand off
   anything that will take more than a moment and carry on. A subagent is a
   Turn on the Bot's `agent` lane through the existing `runVoice` path; its
   result returns as a late function response, or waits if the call is
   paused. Nothing is classified by us. **The same `subagent` tool is in a
   Bot's text Turns** (`app/flock/subagent.ts`): a chat reply can come back
   before the work does, the hand-off is a Turn of the same Bot with a
   `handoff` origin one level deep, and the person sees it on the Work views
   like any other Turn. Voice and text delegate the same way.
3. **Pause closes the session and starts nothing.** Sleep stops the socket
   (no audio, no billing). Subagents already admitted finish as any Turn
   would and their results queue; Resume reopens with the session's
   resumption handle when inside its window, else fresh with a handover
   line. Nothing listens or deliberates in between.
4. **Voice does not share the thread.** Entering voice replaces the thread
   with the voice surface; nothing said in a call becomes a message. Voice
   reads the Bot's thread and memory going in and writes to Memory — never
   the thread — coming out: durable facts to the shared Memory, conversational
   preferences to the voice session's own record. The only durable trace of a
   call is the work it started, on the Work views.
5. **`switch_bot` is honoured after the spoken turn ends.** The object waits
   for the model's current audio turn to complete before swapping voice and
   instruction, so the model may say its sign-off and call the tool in either
   order. `ask` stays on the line and reads the other Bot's answer in this
   Bot's voice; the instruction says in the person's own phrasing which is
   which.
6. **A Bot's voice is a name plus described delivery.** `BotVoiceAppearanceV1`
   (`app/voice/appearance.ts`) beside `AvatarAppearanceV1`: `voiceName`
   from Gemini's thirty, and `delivery` — accent, attitude, pace, turn
   length, humour, filler words, formality, and the person's own words —
   stored as slugs and rendered into the persona block at call start. Each
   character carries a default voice; templates carry the setting.
7. **The meters are minutes.** The ledger's STT-seconds and TTS-characters
   become audio seconds in and out, capped separately because output costs
   3.6× input. Turns and subagents stay counted.
8. **No fallback.** ElevenLabs, its voices, the Scribe and OpenAI assistant
   transcribers, the TTS guard and `VOICE_ASSISTANT_STT` go. `OPENAI_API_KEY`
   stays for composer dictation, which is unchanged.

## Why

- **The model does what the delegation lane did.** Non-blocking function
  calling is the feature the two-layer design was standing in for; keeping
  the lane's plumbing on top of it would be two answers to one question.
- **Coherent identity.** One voice per Bot from a fixed list plus prose is
  the same shape Google offers, so nothing is invented that the provider
  cannot honour.
- **Cheaper, simpler, better.** One socket instead of three, one bill instead
  of three, and the leaderboard's best speech-to-speech model.

## Consequences

- **The Bot's Package tools are not yet exposed to Live directly.** A tool
  runs inside a Turn's runtime today (`runtime.tools.register` in the Package
  agents); there is no seam that executes one tool outside a Turn with
  approvals. Until there is, the subagent covers every capability at Turn
  latency. Building that seam is the next step, not this one.
- **Style steering is empirical.** The audio-tag vocabulary Google documents
  is for the TTS models; for Live, delivery goes through the instruction and
  Google does not enumerate which descriptors bite. The probe in
  `apps/cloudflare/test/voice-gemini-probe.ts` is how a preset earns its place.
- **What the probe found** (`docs/voice-gemini-probe.md`, 2026-09-17), which
  the object is built on: the only error channel is a 1007 close with a
  reason; `clientContent.turns[].role` is required; bare `{}` frames arrive
  constantly and mean nothing; output is always `audio/pcm;rate=24000`;
  `generationComplete` and `turnComplete` are separate frames and either can
  be missing from an interrupted turn, so `switch_bot` waits for whichever
  lands first; `usageMetadata` is tokens at turn end, not seconds, so the
  meters count bridged bytes; `NON_BLOCKING` declarations and `WHEN_IDLE`
  responses work, and a late response after the turn produced a fresh spoken
  turn; resumption carries context, and a handle the server has forgotten
  closes **1008**, which is the real "start fresh with a handover" signal —
  `VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1` stays our own device-rejoin policy.
  `goAway` and `toolCallCancellation` are decoded but were never produced.
- **A search in flight dies with the socket.** Grounding runs inside the
  session; Pause loses it. Acceptable: the person asks again.
- **Session limits are Google's.** The resumption window and the session
  length are read from the API, not chosen; `VOICE_ASSISTANT_REJOIN_WINDOW_MS_V1`
  is reconciled against them.
- **Kept unchanged:** the dictation relay, `memory.ts`, `history.ts`, the
  `runVoice` path and its outbox, the native capture, player and audio-route
  stack, and every client frame.

## Later

- Execute a Bot's tools outside a Turn, with approvals, so Live can call them
  directly and only hand off what is genuinely long.
- The chat model to `gemini-3.8-flash` with search grounding, as its own
  change: it touches the gateway, the hosted model rate table and per-Bot models.
- Dictation to `gemini-3.5-transcribe-live`, dropping `OPENAI_API_KEY`.

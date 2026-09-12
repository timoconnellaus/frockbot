# Voice live checklist

What has to be exercised against real providers and real microphones before
voice is called working. As of 2026-09-11 two things on this list have been:
the dictation upstream and the continuous session's listening, both driven end
to end against OpenAI through the real Worker with synthesized speech rather
than a microphone (the frames are in `docs/voice.md` under "The live
endpoint"). Everything else below — every microphone, every client, and the
whole ElevenLabs path — is still untested end to end. The deterministic checks that _have_ run are listed in
`docs/voice.md` under "Verification".

## Prerequisites

- `apps/cloudflare/.dev.vars` with `OPENAI_API_KEY` and `ELEVENLABS_API_KEY`
  (see `.dev.vars.example`). Both are required production secrets, so the
  same names go into the repository's production environment before a
  release.
- The `AI` binding reaching Workers AI, which is the Frock AI gateway
  transport for the assistant's chat model — `wrangler dev` with the account's
  remote binding, or the deployed staging Worker. Nothing is transcribed
  through it; `OPENAI_API_KEY` is what the assistant listens with.
- A browser with a microphone (Chrome and Safari), and an Android device
  for the Flutter app.

## Dictation

1. Open a Bot, press the microphone with an empty composer, start speaking
   immediately. Expect: the message field gives way to the recording dock
   (opening audio is buffered while the socket connects), its meter follows
   your voice, no words are shown while you speak, and nothing is sent.
2. Press Stop mid-sentence. Expect: the dock closes and the capture's
   transcript is in the draft within ~1 s (bounded at 6 s), the draft stays
   editable, nothing is sent until you press Send. There is no upstream turn
   detection, so Stop is the only thing that transcribes: a capture without
   Stop leaves nothing behind.
3. Start dictating, switch to another Bot in the sidebar. Expect: dictation
   stops and its words are in the first Bot's draft, not the second's.
4. Deny the microphone permission. Expect: one actionable line beside the
   composer, no socket opened.
5. Kill the network mid-dictation. Expect: the words received so far remain in
   the draft, one short error line, no reconnect loop.
6. Dictate for more than five minutes. Expect: the capture finalises the way a
   Stop does first — the transcript segment lands in the draft, so it keeps
   everything captured — and then one error line saying dictation stopped after
   five minutes and to press the microphone to continue.
7. Confirm in the OpenAI dashboard that the session used
   `gpt-live-transcribe` and was billed per audio minute, not per token.

## Continuous session

1. Press the waveform button. Expect: the footer slides up from the bottom
   edge immediately, the meter's lobes bloom white and pale pink from the
   microphone before the server says `listening`, the call starts within ~2 s.
2. Ask "what bots do I have". Expect: the reply is spoken from ElevenLabs
   (George, Flash v2.5, PCM 24 kHz), the same meter blooms deep rose from the
   playback, the reply names the live Bots.
3. Interrupt the reply by speaking. Expect: playback stops within ~200 ms and
   the assistant listens; a cough or a door closing does not stop it.
4. Ask a Bot to do something substantial ("ask Remy to plan my week").
   Expect: the assistant says it has asked; the request appears in Remy's own
   thread as an ordinary user message; when Remy finishes, the answer is read
   out. Close the tab before Remy finishes, reopen and start voice again:
   the answer is read out first.
5. Stay silent for 25 s. Expect: `voice/state` reports `asleep` (visible in
   the network tab), no audio frames go up, the footer keeps animating from the
   microphone. Speak: the first syllable is transcribed (pre-roll).
6. Mute, speak, unmute, speak. Expect: nothing is transcribed while muted; the
   first phrase after unmuting is.
7. Open the same account on a second device and start voice there. Expect:
   the first device's footer shows "moved to another device"; the second
   works. Reload the second device within a minute: it rejoins the same call.
8. Background the app (switch tabs on the phone, switch apps on Android).
   Expect: capture and playback stop and the footer closes. Navigate between
   Bots and pages in the app: the footer stays.
9. Leave the footer open in a quiet room for an hour. Expect: the OpenAI and
   ElevenLabs dashboards show no spend for that hour.
10. Check the ElevenLabs dashboard for character counts against the meter
    (`voice:meter:<day>` in the object's storage, readable through the
    `/api/debug` snapshot once that route is extended) and the OpenAI usage
    page for `gpt-transcribe` minutes.

## Flutter

1. Android: first press requests `RECORD_AUDIO`; denial shows the actionable
   line; grant and the same eight checks above hold.
2. macOS: the microphone prompt appears (usage description present); the
   entitlement admits capture in a release build.
3. Playback and capture at once on Android with echo cancellation: the
   assistant does not interrupt itself with its own voice through the speaker.

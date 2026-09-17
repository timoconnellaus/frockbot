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
   Stop leaves nothing behind. The finishing state then holds a moment longer
   while the transcript is tidied (bounded at 8 s).
3. Dictate a sentence with an "um", a false start and a self-correction
   ("Check Thursday — sorry, Friday's flights"), then Stop. Expect: the raw
   words appear first, are replaced once by the tidied span, and "Use what I
   said" appears beside the composer and puts the raw transcript back. Typing
   after the tidied text keeps that offer; editing inside it, or pressing
   Send, withdraws it. Dictate something exploratory or negated ("maybe we
   should change the model") and check the Worker log: either the wording
   survives or the tidy-up was refused by name.
4. Start dictating, switch to another Bot in the sidebar. Expect: dictation
   stops and its words are in the first Bot's draft, not the second's.
5. Deny the microphone permission. Expect: one actionable line beside the
   composer, no socket opened.
6. Kill the network mid-dictation. Expect: the words received so far remain in
   the draft, one short error line, no reconnect loop.
7. Dictate for more than five minutes. Expect: the capture finalises the way a
   Stop does first — the transcript segment lands in the draft, so it keeps
   everything captured — and then one error line saying dictation stopped after
   five minutes and to press the microphone to continue.
8. Confirm in the OpenAI dashboard that the session used
   `gpt-live-transcribe` and was billed per audio minute, not per token.

## Continuous session

1. Open a Bot and press the voice control at the far right of its composer.
   Expect: the footer slides up from the bottom edge immediately, the meter's
   lobes bloom white and pale pink from the microphone before the server says
   `listening`, the call starts within ~2 s, and the call is with that Bot —
   the control reads as pressed and Back is gone. The sidebar control still
   starts a call with the account's General.
2. Ask "what bots do I have". Expect: the reply is spoken from ElevenLabs
   (Flash v2.5, PCM 24 kHz) in **this Bot's** voice, the same meter blooms
   deep rose from the playback, the reply names the other Bots.
3. **Every voice in the catalog, audited by ear.** Reachability is already
   machine-proven before each staging deploy (`docs/voice.md`, "Each Bot has
   a voice"), so what is left here is the judgement only listening can make.
   Make a Bot on each character in turn, or set the fallback, and hear every
   one speak: judge whether the voice suits its character. Two Bots must not
   sound the same.
4. Ask this Bot to hand you over ("let me talk to Remy"). Expect: the audio
   stays up, the next sentence is in Remy's voice, the page moves to Remy and
   the composer control there reads as pressed. Pressing voice on a third
   Bot's composer moves the call again rather than hanging up.
5. Interrupt the reply by speaking. Expect: playback stops within ~200 ms and
   the assistant listens; a cough or a door closing does not stop it.
6. On a call with Remy, ask for something substantial ("plan my week").
   Expect: it says it has started it, as its own work; the request appears in
   Remy's own thread as a centred "Message from Voice" marker rather than an
   ordinary user message, and tapping it opens the view-only "Remy ⇄ Voice"
   chat with the request and, once given, Remy's reply, with no ordinary user
   notification; when Remy finishes, the answer is told in a sentence or two
   in the first person and without a name ("done, your week is planned"), at
   the next pause. Hand over to another Bot before Remy finishes and the same
   answer keeps Remy's name and is spoken in Remy's voice, after which the
   call goes back to its own. Hang up before Remy finishes, then start voice
   again: nothing is said unasked. The new call opens listening, and Remy's reply is in the "Remy ⇄
   Voice" chat for you to read.
7. Stay silent for 25 s. Expect: `voice/state` reports `asleep` (visible in
   the network tab), no audio frames go up, the footer keeps animating from the
   microphone. Speak: the first syllable is transcribed (pre-roll).
8. Mute, speak, unmute, speak. Expect: nothing is transcribed while muted; the
   first phrase after unmuting is.
9. Open the same account on a second device and start voice there. Expect:
   the first device's footer shows "moved to another device"; the second
   works. Reload the second device within a minute: it rejoins the same call.
10. Background the app (switch tabs on the phone, switch apps on Android).
    Expect: capture and playback stop and the footer closes. Navigate between
    Bots and pages in the app: the footer stays.
11. Leave the footer open in a quiet room for an hour. Expect: the OpenAI and
    ElevenLabs dashboards show no spend for that hour.
12. Check the ElevenLabs dashboard for character counts against the meter
    (`voice:meter:<day>` in the object's storage, which the
    `GET /api/debug/voice` read does not yet include) and the OpenAI usage
    page for `gpt-transcribe` minutes.

## Flutter

1. Android: first press requests `RECORD_AUDIO`; denial shows the actionable
   line; grant and the same checks above hold.
2. macOS: the microphone prompt appears (usage description present); the
   entitlement admits capture in a release build.
3. Playback and capture at once on Android with echo cancellation: the
   assistant does not interrupt itself with its own voice through the speaker.

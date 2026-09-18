# Voice live checklist

What has to be exercised against the real provider and real microphones before
voice is called working. As of 2026-09-17 one thing on this list has been: the
Gemini Live API itself, probed frame by frame through
`apps/cloudflare/test/voice-gemini-probe.ts`, with the shapes it returned
written down in [`voice-gemini-probe.md`](voice-gemini-probe.md). That probe
proves the wire; it proves nothing about a microphone, a speaker or a person.
On 2026-09-18 the way into a call, a call that fails, and a microphone the
call can hear and one it cannot were driven too — in the repo's own browser
harness (`bun e2e/serve.ts` in `apps/cloudflare`), the real client and Worker,
with the Live upstream and the capture device substituted (a fake upstream,
and a WAV of zeros where a microphone would be). The steps below marked driven
are that drive's record. The Worker's own upstream socket — the `fetch` upgrade
in `fetchVoiceUpstreamSocketV1` the object opens a session with, not the
hand-run probe — was driven against the real Live API the same day: setup
completed and the model's audio came back, and what that path must do about the
API's binary frames is in
[`voice-gemini-probe.md`](voice-gemini-probe.md#framing). No call has yet been
made against the real provider or through a real microphone, so the real
devices behind all of it, and anything the drive did not reach, remain
untested end to end. The
deterministic checks that _have_ run are in [`voice.md`](voice.md) under
"Verification".

## Prerequisites

- `apps/cloudflare/.dev.vars` with `OPENAI_API_KEY` (dictation) and
  `GEMINI_API_KEY` (the session) — see `.dev.vars.example`. Both are required
  production secrets, so the same names go into the repository's production
  environment before a release.
- The `AI` binding reaching Workers AI, which is the Frock AI gateway
  transport for the end-of-call memory update. The call itself does not use
  it: a stack without it holds a conversation and remembers nothing
  afterwards, which is worth seeing once on purpose.
- A browser with a microphone (Chrome and Safari), and an Android device for
  the Flutter app.

## Dictation

Unchanged by ADR 0031 — the relay is still OpenAI Realtime — so this half of
the list stands as it was.

1. Open a Bot, press the microphone with an empty composer, start speaking
   immediately. Expect: the message field gives way to the recording dock
   (opening audio is buffered while the socket connects), its meter follows
   your voice, no words are shown while you speak, and nothing is sent.
2. Press Stop mid-sentence. Expect: the dock closes and the capture's
   transcript is in the draft within ~1 s (bounded at 6 s), the draft stays
   editable, nothing is sent until you press Send. There is no upstream turn
   detection, so Stop is the only thing that transcribes. The finishing state
   then holds a moment longer while the transcript is tidied (bounded at 8 s).
3. Dictate a sentence with an "um", a false start and a self-correction
   ("Check Thursday — sorry, Friday's flights"), then Stop. Expect: the raw
   words appear first, are replaced once by the tidied span, and "Use what I
   said" appears beside the composer and puts the raw transcript back.
4. Start dictating, switch to another Bot in the sidebar. Expect: dictation
   stops and its words are in the first Bot's draft, not the second's.
5. Deny the microphone permission. Expect: one actionable line beside the
   composer, no socket opened.
6. Kill the network mid-dictation. Expect: the words received so far remain in
   the draft, one short error line, no reconnect loop.
7. Dictate for more than five minutes. Expect: the capture finalises the way a
   Stop does first, then one error line saying dictation stopped after five
   minutes.
8. Confirm in the OpenAI dashboard that the session used
   `gpt-live-transcribe` and was billed per audio minute, not per token.

## The voice session

1. Open a Bot and press the voice control at the far right of its composer.
   Expect: the page goes into voice mode immediately — the character where the
   thread was — the meter's lobes bloom white and pale pink from the
   microphone before the server says `listening`, the call starts within ~2 s,
   and the call is with that Bot; Back is gone. The composer is the only way
   in: the sidebar's list-root row carries no voice control, so there is no
   entry that starts a call without naming a Bot. Driven 2026-09-18 in the
   browser, for the way in alone: no `voice-start` control was anywhere on the
   page, and a press on the composer's control opened voice mode on that Bot.
2. Ask "what bots do I have". Expect: the reply is spoken in **this Bot's**
   voice, the same meter blooms deep rose from the playback, the reply names
   the other Bots. Listen for the gap before the first word: one session
   should answer noticeably sooner than the cascade did, and that is the whole
   point of ADR 0031.
3. **Every voice, audited by ear.** Nothing machine-checks a Gemini voice
   name against an account — the thirty are a fixed list — so what is left is
   the judgement only listening can make. Make a Bot on each character in
   turn, hear every one speak, and judge whether the voice suits its
   character. Two Bots must not sound the same.
4. **Delivery, which is the empirical part.** Set a Bot's accent, attitude,
   pace, turn length, humour, filler words and formality in turn and listen
   for each. Google documents its audio-tag vocabulary for the TTS models, not
   for Live, so which of these descriptors actually bite is a question only
   this step answers. Write down which ones did and which ones the model
   ignored; a preset nobody can hear should be removed rather than kept.
5. Say something in the middle of a long answer. Expect: playback stops within
   ~200 ms, the model stops with it, and the call carries on. A cough or a
   door closing must not stop it. Do the same over a Bluetooth headset and
   over the phone's own speaker, which are different echo paths.
6. Ask for something substantial ("plan my week"). Expect: the model says it
   has started it **without going silent to do so** — the non-blocking call is
   the thing to listen for — and the request appears in the Bot's own thread
   as a centred "Message from Voice" marker rather than an ordinary user
   message, opening the view-only exchange view. When the Bot finishes, the
   answer is told at the next pause in a sentence or two, in the first person
   and without a name ("done, your week is planned"). Hang up before it
   finishes, then start voice again: nothing is said unasked, and the reply is
   in the exchange view to read.
7. Ask to be put through to another Bot ("let me talk to Remy") while it is
   mid-sentence. Expect: it finishes its sign-off, the next voice is Remy's,
   and the page moves to Remy — voice mode on its page now, with its name
   under the character. Pressing voice on a third Bot's composer moves the
   call again rather than hanging up. Then ask the first Bot to _get something
   done_ by another Bot: that must stay on the line as `subagent`, not hand
   the conversation over.
8. Ask something that needs today's facts ("what's the weather in Sydney
   right now"). Expect: it answers from Google Search grounding without
   saying how, and without handing off.
9. Stay silent for 25 s. Expect: `voice/state` reports `asleep` (visible in
   the network tab), no audio frames go up, the footer keeps animating from
   the microphone. Speak: the first syllable is transcribed (pre-roll), and
   **the model still knows what you were talking about** — that is the
   resumption handle working. Pause long enough for the handle to expire (the
   window is Google's and undocumented; leave it an hour), then speak again:
   it should pick the conversation up from the handover rather than asking you
   to start over.
10. Mute, speak, unmute, speak. Expect: nothing reaches the session while
    muted; the first phrase after unmuting does.
11. Open the same account on a second device and start voice there. Expect:
    the first device says "Voice moved to another device." — in voice mode
    where the call was on screen, on the footer otherwise; the second works.
    Reload the second device within a minute: it rejoins the same call.
12. Background the app (switch tabs on the phone, switch apps on Android).
    Expect: capture and playback stop and the footer closes. Navigate between
    Bots and pages in the app: the footer stays.
13. Leave the footer open in a quiet room for an hour. Expect: the Google AI
    Studio dashboard shows no spend for that hour.
14. Check that dashboard's audio minutes, in each direction, against the
    meter (`voice:meter:<day>` in the object's storage): `audioInSeconds` and
    `audioOutSeconds` should track the billed minutes to within a block or
    two. A large gap either way means the bridge is counting something it did
    not send, or sending something it did not count.
15. Make a call fail before it starts — deny the microphone, cut the network
    between the press and the socket, or point the deployment at a
    `GEMINI_API_KEY` that is not a key. Expect: the word under the Bot's name
    is `Call failed`, never left saying `Listening` over a dead meter, with
    the sentence that explains it in the activity slot ("Voice didn’t
    start. Try again." for a start that never started). Driven 2026-09-18 in
    the browser against a bad voice key: the surface settled on `Call failed`
    with that sentence rather than staying on `Listening`.
16. Have the server's end of the socket finish first, with nothing having gone
    wrong — a Worker restarted behind a live call, or the connection dropped
    without a frame saying why. Expect: the word becomes `Call ended` and the
    activity slot says `The call ended.` — an end, not a failure, so never
    `Call failed`, and never `Listening` over a socket that is gone. With the
    call on another Bot's page the footer says the same line. Covered by the
    Flutter suite; not yet driven live.
17. Put a live call behind a microphone that never carries anything: the macOS
    voice-processing failure described under "A call that is up and deaf" in
    [`voice.md`](voice.md), or any capture device handing over nothing but
    zeros. Expect: ten seconds in, the surface says "FrockBot isn’t hearing
    anything. Check the microphone in your device settings." once, in the
    activity slot, while the word beside it still says `Listening` — a notice,
    not an error — and the call goes on; a pause or a mute starts the ten
    seconds again, the silence being the person's own. A microphone that
    carries anything at all, the room's own tone included, must never trip it,
    so a quiet person in a quiet room is not this. Driven 2026-09-18 in the
    browser with the capture device substituted: a WAV of zeros said it once
    and the call stayed live, and a fake device playing a tone never said it
    in thirty seconds.

## Flutter

1. Android: first press requests `RECORD_AUDIO`; denial shows the actionable
   line; grant and the same checks above hold.
2. macOS: the microphone prompt appears (usage description present); the
   entitlement admits capture in a release build.
3. Playback and capture at once on Android with echo cancellation: the session
   does not interrupt itself with its own voice through the speaker. This is
   the check most changed by ADR 0031 — the client no longer sends silence
   while a reply plays, so the device's own cancellation and the model's
   detector are the only things between the speaker and a false barge-in.

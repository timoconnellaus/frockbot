# ADR 0029: Voice talks to one Bot

Status: accepted, 2026-09-17. Decisions are Tim's from the 2026-09-17
discussion. Built in the same pull request, except where noted below.

**What is built:** decisions 1 to 6, 8 and 9, and the first parts of 7 —
the call addresses one Bot and wears it, the tools narrow to it,
`switch_bot` hands the conversation over, each Bot speaks in its
character's voice, the read-out is first person, and the composer carries
the voice control while the Bot page becomes a focused voice mode.

**What is not, yet:**

- The `voiceId` **setting**. Every Bot already has a distinct voice from
  its character and the resolution path takes a per-Bot override, but the
  stored choice and its picker are not built. `resolveVoiceIdV1`'s
  `chosen` argument is the seam.
- The curated voice ids in `app/voice/voices.ts` are ElevenLabs' public
  premade voices and have **not been played against this account**. They
  need listening to before a release ships them.
- Decision 7's **enlarged character and on-page mute**, and with them the
  retirement of the account-wide footer. The footer still carries mute,
  End and the meter.
- Decision 7 says the sidebar `voice-start` is removed, but decision 1
  says a call started "from the list root" opens with General. Those pull
  against each other — the sidebar control _is_ the list-root entry — so
  it has been left in place pending a decision.

Decision 9 was overtaken before it was built: PR #534 made every call
fresh, so answers that settle while nobody is listening are no longer
carried into the next call at all. There is nothing left to scope.

## Context

Voice today is an **account-wide assistant** (`docs/voice.md`,
`app/voice/assistant.ts`): one `VoiceAssistant` Durable Object per User runs a
thin, fast model loop with its own prompt and tools — `list_bots`,
`bot_status`, `read_bot_history`, `search_bot_history`, `ask_bot`,
`cancel_bot`, `remember`, `forget`, `recall_project` — and delegates real work
to whichever Bot it picks, on that Bot's `agent` lane, so the person is never
blocked on a Bot Turn. Answers return through a durable outbox and are read
out by the assistant: "Sunny answered about the flights: …". It speaks with
one voice for every Bot. The client is account-wide chrome: a `voice-start`
button in the sidebar and a footer under the navigation.

Tim's observation: "the way people work is they talk to a single bot. Now that
bot might communicate with others as normal. This way we always know who we're
talking to." Today's shape hides that twice: the narrator sits between the
person and every Bot, and every Bot sounds the same.

A first draft of this ADR made the Bot itself run the spoken Turn. Tim kept
the two layers instead: a full Bot Turn is 11.7 s median with the model over
90% of it (`docs/` latency profile, 2026-09-16), and the whole point of the
voice layer is that the person is never waiting on one. The Bot is the voice
layer's worker.

## Decision

**Two layers stay. The voice layer is scoped to one Bot at a time, wears that
Bot's context and speaks in that Bot's voice; the Bot is its worker.**

1. **A call addresses one Bot.** `start_call` carries a `botId`; the call
   record holds the current Bot. Pressing voice on a Bot's page starts the
   call with that Bot; from the list root it starts with General. The voice
   layer's prompt is rendered from that Bot: its name and description, its
   memory (`botMemoryRootV1`) beside the User's, its recent thread through
   the existing history reader, and its live activity. The account-wide
   `<bots>` directory is kept in the prompt only so a switch can be asked for
   by name.
2. **The tools narrow to the current Bot.** `ask`, `status`, `read_history`,
   `search_history` and `cancel` take no `bot_id`: they mean this Bot. The
   memory tools are unchanged. Cross-Bot work is the Bot's own `bot_message`,
   as now; the voice layer never relays between Bots itself.
3. **Switching is a tool, and only a tool, to begin with.** `switch_bot`
   retargets the call: the prompt is re-rendered from the new Bot, its voice
   takes over, and the call record is updated. The audio stays up. A
   delegation still owed by the previous Bot is not cancelled; when it lands
   it is read out in _that_ Bot's voice, with its name. No switching UI ships
   with this ADR — you ask.
4. **Each Bot has a voice.** A Bot setting, `voiceId`, beside its appearance
   (`AvatarAppearanceV1`: `characterId`, `primary`), chosen from a curated
   list of ElevenLabs voices in the Bot's settings. Every character in the
   cast carries a default voice so two Bots never sound the same without
   anyone choosing; the deployment's `ELEVENLABS_VOICE_ID` becomes the
   fallback for a Bot whose character has none. The call builds one TTS
   provider per voice it has spoken as (`createTts` takes the voice id) and
   speaks each sentence in the current Bot's; a Bot's answer arriving from a
   delegation is spoken in the answering Bot's.
5. **The read-out is first person.** With the voice and context the Bot's
   own, "Sunny answered about the flights: booked" becomes "Done — the
   flights are booked." The narrator wording goes; the name is said only
   when the answer comes from a Bot other than the current one.
6. **Lanes and barge-in are unchanged.** A delegation is still an `agent`
   lane Turn that queues behind the person's own chat and never supersedes
   it; an interrupt stops the voice layer's reply and never cancels the
   Bot's work. This is what keeps the person unblocked.
7. **The button lives on the Bot, at the far right of the composer, and
   voice is a focused mode of the Bot page.** Option A from the discussion:
   a fixed voice control to the right of the existing mic / send / stop
   morph (`apps/native/lib/shell/composer.dart`, `_actionButton`). It never
   morphs, so it is always the same target under the thumb. Dictation stays
   beside it. Pressing it puts the Bot page into **voice mode**: the current
   Bot's character large, the thread still readable, mute on the screen, and
   the corner control now End. The page's back control disappears — to leave
   the Bot you end voice first — and on desktop the sidebar collapses so the
   Bot fills the window. A system back gesture on Android ends voice rather
   than being swallowed, so the gesture people reach for does the one thing
   that is allowed. `switch_bot` moves the view to the new Bot's page without
   leaving voice mode: same screen, new character, new voice, new thread. The
   sidebar `voice-start` and the account-wide footer are removed.
8. **Session memory stays per User.** "Keep spoken answers short" is a fact
   about talking to voice, whichever Bot; the record, its fences and its
   finalization jobs are untouched. Anything Bot-specific the voice layer
   should know comes from the Bot's own memory in the prompt.
9. **Unspoken answers are scoped.** Answers that settled while nobody was
   listening are mentioned first, as now; those from the current Bot without
   a name, those from another with one, each in its own voice.

## Why

- **Identity through context and voice, not through the loop.** What tells
  the person who they are talking to is the voice they hear, the name on
  the screen and answers that know this Bot's thread — none of which needs
  the Bot's own model to be on the line.
- **Never blocked.** The voice layer answers in a second or two from what it
  already holds; the Bot works for as long as the work takes and is read out
  when it lands. Putting the Bot's Turn on the line would trade that for
  seconds of dead air on every question.
- **Small change to what exists.** The ledger, the delegation outbox, the
  scheduled look-ups, the memory subsystem, the STT / TTS adapters and the
  native stack all stay. What changes is the prompt's scope, the tools'
  implicit target, one new tool, one Bot setting, one TTS provider per
  voice, and the client's entry point.

## Consequences

- **Two brains per Bot, stated honestly.** The voice layer's light answers
  come from a fast model reading the Bot's context, not from the Bot
  thinking. The rule that it does only light work itself — answer from what
  it holds, summarise, report status — and delegates anything substantial is
  what bounds the drift, and it is kept. A Bot's memory rendered into the
  voice prompt is read, never written, by the voice layer.
- **Prompt size grows per Bot.** Bot memory and a thread tail are more
  context than the account directory was. Bounded like the rest of the
  prompt (`VOICE_PROMPT_*` limits); measured on `model-first-text` before the
  bounds are widened.
- **A per-voice TTS provider is a cheap object,** but the first sentence in
  a new voice may pay a connection; the bridge covers it.
- **Voices are a curated list, not free text.** A Bot setting that takes any
  ElevenLabs voice id is a way to bill the account for a voice nobody
  vetted; the list is the deployment's.
- **`bot_message` from the Bot still returns as that Bot's tool result**, so
  what the person hears about another Bot is the current Bot's account of
  it, in the current Bot's voice — the same as reading its thread. Only a
  delegation the voice layer itself still owes speaks in the other voice.
- **Dictation is kept, for now.** Option B — the mic _is_ the call and
  in-app dictation is removed — is revisited once per-Bot voice ships and
  dictation use can be seen.
- **Kept unchanged:** the composer dictation relay, `ledger.ts` and its
  meters, `memory.ts`, `history.ts`, the delegation path
  (`BotState.runVoice`, `reply/to-caller`, the outbox drain), the "Message
  from Voice" exchange marker, `sleeping-transcriber.ts`, `speech-gate.ts`,
  `tts-guard.ts`, `pcm-resample.ts`, and the native capture, player and
  audio-route stack.

## Later

- A switching UI (a Bot picker on the voice screen) once asking by name has
  been lived with.
- Option B for the composer corner.
- A cheap `bot_status` read in the Flock Package so a Bot can answer "what
  is Bob doing?" without a `bot_message`.

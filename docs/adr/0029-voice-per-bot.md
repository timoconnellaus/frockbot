# ADR 0029: Voice is a call with one Bot

Status: proposed, 2026-09-17. The decision and the composer placement are
Tim's from the 2026-09-17 discussion; the two items under _Open_ are still his
to make. Nothing here is built.

## Context

Voice today is an **assistant that is not a Bot** (`docs/voice.md`,
`app/voice/assistant.ts`). One `VoiceAssistant` Durable Object per User runs a
thin model loop with its own prompt, its own tools — `list_bots`, `bot_status`,
`read_bot_history`, `search_bot_history`, `ask_bot`, `cancel_bot`, `remember`,
`forget`, `recall_project` — its own memory tier (`app/voice/memory.ts`) and
its own view of Bot history (`app/voice/history.ts`). Bots are things it
delegates to on the `agent` lane; their answers come back through a durable
outbox and are read out in the assistant's voice
(`composeVoiceDelegationSpeechV1`). In a Bot's thread the exchange shows as a
counterpart, "Message from Voice", answered with `reply/to-caller`. The client
is account-wide chrome: one `voice-start` button in the sidebar and one footer
under the navigation.

Tim's observation: "the way people work is they talk to a single bot. Now that
bot might communicate with others as normal. This way we always know who we're
talking to." The intermediary hides exactly that. When the assistant says
"Sunny answered about the flights: …" the person is not talking to Sunny; they
are hearing a narrator who read Sunny's thread.

## Decision

Voice stops being a _who_ and becomes a _how_. **The call is transport; the
Bot is the speaker.**

1. **A spoken turn is the Bot's own Turn, on the `user` lane.** What the person
   says is a User message to that Bot with source `voice`; what the Bot says
   back is `send_to_user` text, spoken. Same Session, same transcript, same
   memory (`botMemoryRootV1`), same tools and Composition. Voice and chat are
   one conversation the person can move between mid-stream, on any device.
2. **Barge-in is supersede.** Speaking over the Bot is what typing mid-Turn
   already is: the running Turn is superseded and its background work carries
   on (CONTEXT.md, _Supersede_). Playback stops the moment speech starts, as
   today. There is no second rule for voice.
3. **The assistant's tools go; `bot_message` is the cross-Bot path.** "Ask
   Bob" is the Bot deciding to message Bob in its own words and telling the
   person what came back. The voice layer does not know other Bots exist.
4. **The voice memory tier is deleted.** The Session is the history, so the
   `<last-conversation>` handover, the summaries, the tombstones and the
   finalization jobs have no job left. "Keep spoken answers short" is a fact
   about talking to that Bot and lives in its memory like any other.
5. **One call object per User stays, addressing one Bot at a time.**
   `VoiceAssistant` is renamed `VoiceCall`. It keeps the Cloudflare Agents SDK
   `withVoice` transport, Scribe STT, ElevenLabs TTS, the sleeping
   transcriber, the TTS guard, barge-in, playback receipts, rejoin, the
   one-device exclusivity rule and the day's meters — spend is per account
   whichever Bot is talking. `start_call` carries a `botId`. The prompt, the
   tools, the delegation read-out, the delegation ledger rows and their
   scheduled look-ups, and the memory come out of it.
6. **Voice is a message attribute, not a counterpart.** The "Message from
   Voice" marker, its view-only pair chat and `reply/to-caller` for caller
   `voice` are removed; a spoken User message carries `via: voice` and the
   transcript draws it with a mic glyph. The Bot ⇄ Bot exchange marker is
   unchanged.
7. **The button lives on the Bot, at the far right of the composer.** Option
   A from the discussion: a fixed voice control to the right of the existing
   mic / send / stop morph (`apps/native/lib/shell/composer.dart`,
   `_actionButton`). It never morphs, so it is always the same target under
   the thumb. Dictation stays beside it. In a call the Bot page becomes the
   voice screen — the character large, mute on the screen — and the corner
   control becomes End. The sidebar `voice-start` and the account-wide footer
   are removed. From the list root, voice targets General, so a person with
   one Bot still has one button.
8. **Away and pause.** Sends the Bot makes while the call is paused are unread
   messages in that Bot's thread, badged as any unread is. Unpausing speaks the
   unread sends since the call began. There is no separate "unspoken answers"
   queue.

### The spoken Turn

The thin assistant existed because a full Bot Turn is slow: 11.7 s median,
11.1 s to the first bubble, the model over 90% of it at about 39 output tokens
a second, and steps rather than tokens are what cost time. Voice wants the
first word inside about 1.5 s. So a spoken Turn is a **turn type**, `voice`,
that changes how the Bot answers and nothing about who it is:

- A spoken-style addendum to the prompt: prose only, no markdown, lists or
  code; one short sentence _before_ any tool call; then work; then the next
  sentence when it lands. This is the `send_to_user(disposition: "continue")`
  contract the Bot already has, used the way voice needs it.
- The first `send/to-user` of the Turn streams to TTS as it is produced. Each
  send in a voice-origin Turn pokes the call object through the existing
  outbox pattern, per send rather than per settlement. The loop's
  `assistantText` hook, raised for words the model addressed to the person
  but never sent, is the seam for a step that wrote and then went to a tool.
- The bridge (`VOICE_TURN_BRIDGES_V1`, 2.5 s) stays, for the stall past the
  first sentence.
- A widget, approval, applet or attachment the Bot sends is drawn on the
  Bot page the person is already looking at, not spoken around.

## Why

- **Identity.** The person always knows who they are talking to because the
  voice, the memory, the tools and the thread are one Bot's. The narrator
  layer — and the "read out in the assistant's voice" problem it created —
  disappears rather than being polished.
- **One set of rules.** Supersede, unread, exchange markers and turn budgets
  already exist for chat. Voice reuses each instead of carrying a parallel
  version (its own lane semantics, its own away-queue, its own memory with its
  own provenance fences).
- **Less to hold.** `assistant.ts`, `memory.ts`, `history.ts`, the delegation
  half of the ledger and the read-out prompts are roughly four thousand lines
  whose only purpose was being a Bot without being one.

## Consequences

- **Cost.** Voice minutes become Bot minutes: real Compositions, real tools,
  real turn budgets, billed as Bot Turns. The daily STT, TTS and turn meters
  stay per User; the delegation meter goes.
- **Latency is the risk to measure, not assume.** A Bot with a large
  Composition has seconds of time-to-first-token that the pinned small voice
  model never had. Before the assistant is deleted, `model-first-text` is
  measured on real Bots with the `voice` turn type, and the first-sentence
  contract is proven in the transcript, not the prompt.
- **A Bot that will not speak first** is the failure mode. The `assistantText`
  hook and the bridge cover the model that writes and then works; a model that
  goes straight to a tool with no words is silence until the bridge, then the
  tool's result. The prompt contract has to hold on the models Bots actually
  run.
- **`bot_status` has no cheap equivalent.** "What is Bob doing?" is a
  `bot_message` today. A read-only status tool in the Flock Package is a small
  follow-up if it is missed.
- **Dictation is kept, for now.** Option B — the mic _is_ the call and
  in-app dictation is removed — is revisited once per-Bot voice ships and
  dictation use can be seen. Deleting it unmeasured is the mistake this ADR
  avoids elsewhere.
- **The Durable Object migration** renames a `new_sqlite_classes` entry; that
  is a `renamed_classes` migration, and the SDK's `cf_voice_messages` and
  jobs tables come with the object.
- **Kept unchanged:** composer dictation and its relay, the STT and TTS
  adapters, `sleeping-transcriber.ts`, `speech-gate.ts`, `tts-guard.ts`,
  `pcm-resample.ts`, the call / turn / meter rows of the ledger, and the
  native capture, player and audio-route stack.

## Open

Two decisions are Tim's and are not made here:

1. **A faster model for spoken Turns.** Whether a Bot may bind a different,
   faster model to its `voice` turn type (the way `VOICE_ASSISTANT_MODEL` pins
   the assistant's today) or every Turn of a Bot runs on its one model.
   Recommendation: allow it as a Bot setting; the model is a runtime choice,
   the identity is the Bot. Decide after the latency measurement above.
2. **Switching Bots mid-call.** Either the call retargets (`voice/switch`,
   audio stays up, the previous Bot's Turn is left to finish) or a call ends
   and a new one starts. Recommendation: switch.

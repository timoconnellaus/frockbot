# Plan: Voice — composer dictation and an app-wide Gemini Live assistant

## Status

Design accepted in conversation on 2026-09-04; tracked in [issue #179](https://github.com/timoconnellaus/frockbot/issues/179). Nothing is implemented. Both capabilities are **beyond parity** (Feature rule 8): the parity register has only a "microphone" settings row (`docs/research/grokbot-computer.md`, §Per-user settings).

Everything below was verified against `main` at `b359d096`. Line numbers drift; verify before relying on them.

## The two capabilities

1. **Dictation in the composer.** When the draft is empty the send button becomes a voice-wave button. Pressing it streams speech-to-text into the textarea in real time, with a bin (discard) and a send control and a capture animation. Sending behaves exactly like a typed message; the Bot replies in text.
2. **App-wide voice assistant** on Gemini 3.1 Flash Live. A User-scoped voice session, toggled on and off, with read-only tools over durable state (Memory, what each Bot has been doing). When it needs an answer it asks a Bot. It is seamless across on and off: an answer that arrives while voice is off is known the next time it is on, and "what have my Bots been doing?" is answered from durable state without messaging any Bot.

## Decisions (accepted in conversation, 2026-09-04)

- **D1 Platform-ambient keys.** FrockBot's OpenAI and Google keys are stored BYOK on the `flock` AI Gateway. Both realtime APIs are reached over AI Gateway's realtime WebSockets (`wss://gateway.ai.cloudflare.com/v1/<account>/flock/{openai|google-ai-studio}`) with `cf-aig-authorization`. A durable per-User voice-minutes quota bounds cost. _Why:_ "works out of the box", one Models surface, no new Connection Types, no credential ever reaches a client. User BYOK is a later override Package.
- **D2 One transport for both: a per-User `VoiceSession` Durable Object proxy.** Browser ↔ hibernatable socket ↔ DO ↔ AI Gateway. The DO holds sockets and **no authority**; every durable fact goes to the User DO by RPC, the same rule Subagent Durable Objects follow (ADR 0017). _Why:_ a Bot's answer can be pushed into the live session by RPC; resumption, `goAway`, and idle-offline are server-owned and survive a refresh; one session across devices; browser-direct would need ephemeral tokens and cannot use AI Gateway.
- **D3 Dictation uses OpenAI Realtime transcription sessions** (`gpt-live-transcribe`; `conversation.item.input_audio_transcription.delta` / `.completed`). `whisper-1` cannot stream deltas. _Why:_ best dictation quality; the transport is shared anyway.
- **D4 Dictation streams into the textarea** as the draft, through `ComposerDraftStore`, so it is editable and a rejected send restores it. Bin discards the draft; Send commits the audio buffer, waits for `.completed`, then calls the ordinary `sendMessage` (mid-Turn it supersedes, ADR 0024). The wave button shows only while `draft === ""`; while recording, bin + send replace it. _Why:_ reuses the existing send/stop slot switch and draft persistence.
- **D5 The voice assistant is not a Bot.** It is a first-party, User-scoped **Voice Package**: no Agent loop, no Memory writes in v1, its own durable ledger in the User DO. _Why:_ a Bot DO is the text-model Agent loop; Gemini Live does not belong inside it.
- **D6 Asking a Bot rides the `agent` lane from #151**: a Turn that waits behind `user` Turns and never supersedes. The Bot's reply is its `send_to_user` in that Turn (#153). The exchange is recorded in the Bot's Session and **shown in the thread with a "via voice" marker**. _Why:_ a `user`-lane message would interrupt the Bot's running work when you ask how it is going; hiding the exchange would hide what was asked on your behalf.
- **D7 Answer delivery while offline: both** — `showClientNotificationV1` when voice is off, and on the next connect the kickoff text lists pending answers so the assistant speaks first. _Why:_ seamlessness is a property of the durable ledger, not of the socket.
- **D8 v1 tools:** `list_bots`; `bot_activity(bot, since)` (runs, partial text, running Tasks, pending inbox — read-only, wakes nothing); `memory_search` over the User tier and each Bot tier; `ask_bot`; `pending_answers`. Routines and Computer captures are deferred. _Why:_ all readable from durable state with the Computer hibernated.
- **D9 Open mic with Gemini VAD**, an explicit on/off toggle in shell chrome (a shell slot the Package fills), auto-offline after 2 minutes of silence, barge-in enabled, resumption on the next toggle. _Why:_ bounds cost without making the User manage a session.
- **D10 One live session per User**, newest device wins. Observer sockets later.

## Verify before slice A

These gate D1 and D3. Each is a short spike, not a design question.

- [ ] AI Gateway's OpenAI realtime path accepts a **transcription-only** session (`session.update` with `type: "transcription"`, model `gpt-live-transcribe`). The docs show only `gpt-4o-realtime` models. If it does not, dictation falls back to the `VoiceSession` DO opening `wss://api.openai.com/v1/realtime` directly with an `OPENAI_API_KEY` Worker secret — which must then be added to the release workflow's `--secrets-file` list, because that flag replaces the Worker's whole secret set (ADR 0025).
- [ ] AI Gateway's Google AI Studio realtime path carries `gemini-3.1-flash-live-preview` with a BYOK key (the documented pattern passes `?api_key=`). Fallback is the same shape: DO → `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=…`, as zerobsai did.
- [ ] Choose the per-User voice-minutes quota default (undecided; 60 minutes per day is a reasonable start).

## Constraints discovered

- **Gemini 3.1 Flash Live has no asynchronous (`NON_BLOCKING`) function calls**; only 2.5 Flash Live does. `ask_bot` returns immediately ("asked X; I'll tell you when they answer") and the answer is pushed later as `realtimeInput.text`. Only the socket holder can be pushed to — this is what forces D2.
- **Audio-only sessions are capped at 15 minutes.** Handle `goAway` by opening a fresh socket and resuming with `sessionResumption.handle` (zerobsai `onGoAway` → `replaceTransport`). Use `contextWindowCompression.slidingWindow`.
- Use `realtimeInput.text` after the first turn, never `clientContent` (3.1 accepts `clientContent` only for seeding history). Set `binaryType = "arraybuffer"` on the workerd upstream socket or frames are silently dropped. `speechConfig.languageCode` does not steer accent on native-audio models; the system instruction does.
- **Record intent before effect.** `ask_bot` writes the ledger entry in the User DO before dispatching the agent-lane Turn, with an idempotency key; a retried tool call never asks twice.
- The voice transcript (text and tool calls, **never audio**) is durable and readable on a Voice surface; that surface also carries the "answers waiting" badge.
- Native shells: Capacitor needs `NSMicrophoneUsageDescription` / `RECORD_AUDIO`; Electron's sandboxed window needs a media permission handler. These are progressive enhancements — the web path works today (the app Worker sets no restrictive `permissions-policy`; only the marketing site does). iOS Safari ignores `AudioContext({ sampleRate: 16000 })`; resample in the worklet.
- Feature styles must use `--frock-*` tokens (`scripts/check-ui-styles.ts`); the wave animation is level-driven from an `AnalyserNode`.
- e2e fakes providers, never the app: a fake Gemini Live / OpenAI transcription WebSocket service is required. zerobsai's `gemini-live.ts` fake is the start.
- Cloudflare AI Gateway realtime WebSockets support OpenAI and Google AI Studio, with BYOK keys stored on the gateway and `cf-aig-authorization` auth; browser clients would authenticate via `sec-websocket-protocol`, which is why the DO (not the browser) holds the upstream leg.

## Feature rule

1. **Authoritative owner.** The User Durable Object (`UserConfiguration`): the voice ledger (questions, answers, a per-Bot "last briefed" cursor), the quota, and the on/off state. `VoiceSession` DO: sockets only, no authority. Bot DO: the agent-lane Turn, as today.
2. **Durable state, commands, events.** `VoiceLedgerV1` in the User DO; commands `voice/ask`, `voice/answered` (from the Bot DO), `voice/briefed`; the Bot's Session records the `agent`-lane Turn and its `send_to_user`. Voice transcripts are durable text.
3. **Disconnect, eviction, hibernation.** Browser disconnect ends the live session (or leaves it to the idle timer) and loses nothing durable; `VoiceSession` eviction is recovered by the resumption handle; nothing wakes the Computer.
4. **Cancellation, retry, idempotency, reconciliation.** `ask_bot` is idempotent on a ledger key; the agent-lane Turn follows the Bot DO's existing admission and reconciliation; toggling off is an explicit command.
5. **Authority, credentials, trust.** No new authority; keys live on AI Gateway; the client receives no credential; voice tools are read-only except `ask_bot`, which reaches only Bots the User owns.
6. **UI.** Dictation controls in the composer (`plugin-shell`); the voice toggle is a shell slot the Voice Package fills; the Voice surface lists sessions and transcripts. No per-Bot control.
7. **Observable failures.** Quota refusals, gateway and upstream failures, and an unanswered question all live in the ledger and render on the Voice surface.
8. **Parity.** Beyond parity.

## Slices

- **A — Dictation.** AI Gateway OpenAI realtime WS through a minimal `VoiceSession` DO; composer wave / bin / send states; worklet and animation; e2e with a fake transcription service. Proves the gateway WebSocket path.
- **B0 — ADR + #151.** An ADR for the Voice Package and the `VoiceSession` DO seam (check `origin/main` and open PRs before numbering it); land the `agent` lane from #151.
- **B1 — Voice Package core.** Gemini Live via the DO proxy, the ledger in the User DO, read-only tools (`list_bots`, `bot_activity`, `memory_search`, `pending_answers`), the shell toggle, the Voice surface, the quota, the e2e fake.
- **B2 — Ask a Bot.** `ask_bot` on the agent lane, answer push into the live session, offline notification, connect-time briefing, the "via voice" marker in the thread.

Depends on #151 and #153.

## Repo map

| Concern                                                                               | Where                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer form, send/stop slot switch                                                  | `packages/plugin-shell/src/client/FrockBotApp.vue` (`<form class="composer">` ~:1116–1214; `showStop`, `canSend`, `isRunning`, `sendMessage`)                                                                                                            |
| Draft persistence (dictation must write through this)                                 | `packages/plugin-shell/src/client/composer-draft.ts` (`ComposerDraftStore`, `begin` / `reject`)                                                                                                                                                          |
| Client plugin and transport calls                                                     | `packages/plugin-shell/src/client/index.ts` (`shellClientPlugin`, `observeRunUntilTerminal`)                                                                                                                                                             |
| Transport seam (the only interface a client plugin talks to)                          | `packages/client-core/src/index.ts` (`AgentTransport`); browser implementation `apps/cloudflare/src/client/index.ts`                                                                                                                                     |
| Reference for a second browser WebSocket (reconnect, backoff, visibility gating)      | `apps/cloudflare/src/client/bot-state-channel.ts` (`BrowserBotStateChannel`)                                                                                                                                                                             |
| Cookie-authed socket route                                                            | `apps/cloudflare/src/gateway.ts` (`/api/bots/:bot/state-channel`, after authentication)                                                                                                                                                                  |
| Token-authed socket route ahead of authentication (template if ever out-of-origin)    | `apps/cloudflare/src/gateway.ts` (`routeAppletSocket`, `verifyAppletViewerTokenV1`)                                                                                                                                                                      |
| Hibernatable socket handling in a Durable Object                                      | `apps/cloudflare/src/bot-state.ts` (`webSocketMessage` handlers); `apps/cloudflare/src/applet-state.ts` (`fetch` door — a 101 with `webSocket` only crosses a stub boundary on the HTTP door)                                                            |
| `/api/bots/*` lives inside the per-User immutable application Worker, not the gateway | `apps/cloudflare/src/user-application.ts` (turns route); `USER_APPLICATIONS` Worker Loader binding                                                                                                                                                       |
| User DO (ledger, quota, and on/off state go here)                                     | `apps/cloudflare/src/user-configuration.ts` (`UserConfiguration`; quota precedent `reserveSubagentSlot`; credential leases `leaseModelCredential` / `leaseToolCredential`)                                                                               |
| DO bindings and migrations                                                            | `apps/cloudflare/wrangler.jsonc` `durable_objects.bindings`                                                                                                                                                                                              |
| AI Gateway HTTP precedent (headers, timeouts, fallback to the `AI` binding)           | `apps/cloudflare/src/flock-ai.ts`; vars `FLOCK_AI_ACCOUNT_ID`, `FLOCK_AI_GATEWAY_ID = "flock"`; secret `FLOCK_AI_GATEWAY_TOKEN`                                                                                                                          |
| Tool contract and registry                                                            | `packages/kernel-contracts/src/tool-execution.ts` (`ToolDefinition`, `ToolExecution`, `ToolRegistration`); `packages/plugin-tools/src/tools.ts` (`ToolRegistry`)                                                                                         |
| Existing outside-the-loop tool caller (the shape for voice → Bot RPC)                 | `POST /api/bots/:bot/package-ui/tools` → `apps/cloudflare/src/bot-state.ts` (`runPackageUiTool`), decoded by `packages/kernel-contracts/src/iframe-ui.ts`                                                                                                |
| Memory read without waking the Computer                                               | `packages/plugin-memory/src/searcher.ts` (`searchMemoryV1`, `formatMemoryResultsV1`); tiers `src/roots.ts`; tools `src/agent.ts` (`memory_write`, `memory_forget`, `memory_search`)                                                                      |
| Bot activity ground truth                                                             | run index via `GET /api/bots/:bot/turns`; `ClientRunV1.partialText` (PR #176, `packages/plugin-shell/src/run-protocol.ts`); `packages/plugin-shell/src/unread.ts` (`UnreadStateV1`); inbox `packages/plugin-routines/src/inbox.ts` (`PendingBotInputV1`) |
| Tasks / subagents                                                                     | `packages/plugin-subagents/src/agent.ts` (`Task`, `task_check`, `task_message`, `task_stop`, `task_resume`)                                                                                                                                              |
| `send_to_user` contract                                                               | `packages/plugin-shell/src/agent.ts`; `packages/kernel-contracts/src/send-to-user.ts`; rendered by `packages/plugin-shell/src/client/SendPayloadView.vue`                                                                                                |
| Client notifications                                                                  | `showClientNotificationV1` (plugin-shell client)                                                                                                                                                                                                         |
| Icons (an unused `mic` is already drawn)                                              | `packages/client-ui/src/icons.ts`                                                                                                                                                                                                                        |
| UI style gate (no literal colours or sizes)                                           | `scripts/check-ui-styles.ts`; `bun run lint:ui-styles`                                                                                                                                                                                                   |
| Kernel import gate; rule → test map                                                   | `scripts/check-kernel-imports.ts`; `docs/architecture-checks.md`                                                                                                                                                                                         |
| e2e (providers faked, app unmodified)                                                 | `apps/cloudflare/e2e/harness.ts`, `fixtures.ts`, `flock-ai-fake-worker.ts`; the `e2e` env comment in `wrangler.jsonc`                                                                                                                                    |
| Dogfood stack                                                                         | `docs/dogfood/dev-stack.md`; `bun run dogfood:dev` (needs `apps/cloudflare/.dev.vars`)                                                                                                                                                                   |
| Debug surface for raw session events                                                  | the `frockbot-debug` skill → `/api/debug/*` (`apps/cloudflare/src/debug.ts`)                                                                                                                                                                             |

Relevant ADRs: 0007 (UI design system), 0013 (Memory), 0017 (Subagent Durable Objects hold no authority — the model for `VoiceSession`), 0021 (Models surface), 0023 (progressive tool disclosure), 0024 (supersede), 0025 (AI Gateway over HTTP), 0026 (the runs socket is an invalidation, not content), 0027 (conversations). Constitution `AGENTS.md`: Authorities, Configuration shape, Feature rule.

## Prior art: zerobsai

`~/repos/zerobsai` shipped a full Gemini Live implementation from May to August 2026 and deleted it wholesale on 2026-08-25 (`fea4c259`, a product teardown, not a voice decision). `86a86770` is the last commit with it. It used `gemini-3.1-flash-live-preview` behind a Durable Object proxy; the day-one prototype (`f94768d5`) used ephemeral tokens and browser-direct and was abandoned the next day.

```
git show 86a86770:apps/web/public/voice/capture-worklet.js              # PCM16 worklet (16 lines, verbatim)
git show 86a86770:apps/web/src/lib/voice-call/client.ts                 # capture, gapless PcmPlayer, barge-in flush, VAD wake, reconnect
git show 86a86770:packages/client-core/src/voice/protocol.ts            # control envelope riding the same socket as Gemini frames
git show 86a86770:apps/web/src/lib/voice-call/voice-chat-session.ts     # sendSetup, frame switch, toolResponse
git show 86a86770:apps/web/src/lib/voice-call/receptionist-session.ts   # the cleanest handleUpstreamFrame
git show 86a86770:apps/web/src/lib/voice-call/voice-chat-do.ts          # DO: openUpstream, goOffline/wakeUpstream, RESUME_KEY, goAway → replaceTransport
git show 86a86770:apps/web/src/lib/voice-call/live-transport.ts         # LiveTransport seam (mockable)
git show 86a86770:apps/web/src/components/app/voice-chat/VoiceWave.tsx  # level-driven bar animation (port to Vue + --frock-* tokens)
git show 86a86770:apps/web/src/components/app/voice-chat/VoiceChatProvider.tsx  # client state machine incl. PTT debounce, observer socket
git show 86a86770:apps/web/src/lib/CLAUDE.md                            # §voice: architecture rationale
git show 86a86770:apps/web/tests/e2e/fake-services/gemini-live.ts       # e2e Gemini Live WebSocket fake
git show 86a86770:apps/web/test/evals/helpers/mock-live-transport.ts    # cassette replay
git show f94768d5:src/lib/server/voice-live.ts                          # ephemeral-token mint (only if browser-direct is ever needed)
```

The setup message that worked (`voice-chat-session.ts`, `sendSetup`): `model: "models/gemini-3.1-flash-live-preview"`, `generationConfig.responseModalities: ["AUDIO"]`, `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`, `systemInstruction`, `inputAudioTranscription: {}`, `outputAudioTranscription: {}`, `tools: [...]`, `contextWindowCompression: { slidingWindow: {}, triggerTokens: "16000" }`, and `sessionResumption: { handle }` on resume. Audio goes up as `realtimeInput.audio { data: <base64>, mimeType: "audio/pcm;rate=16000" }`; output is PCM16 at 24 kHz. Handle `serverContent.interrupted` (flush playback), `sessionResumptionUpdate { newHandle, resumable }`, `goAway { timeLeft }`, and `toolCall.functionCalls` → `toolResponse.functionResponses`.

## External references

- Gemini Live capabilities (session limits, VAD keys, transcription keys, no asynchronous tools on 3.1): https://ai.google.dev/gemini-api/docs/live-api/capabilities
- Gemini 3.1 Flash Live announcement: https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-live/
- Gemini ephemeral tokens (fallback only): https://ai.google.dev/gemini-api/docs/ephemeral-tokens
- OpenAI realtime transcription (`gpt-live-transcribe`, delta/completed events, `turn_detection`): https://developers.openai.com/api/docs/guides/realtime-transcription
- Cloudflare AI Gateway realtime WebSockets (providers, URL pattern, `cf-aig-authorization`, BYOK): https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/

## Process

Work in a worktree off `origin/main`; ship each slice as its own pull request and watch it to a terminal state with `bun scripts/ci-watch.ts`; run `bun test`, `bun run lint:ui-styles`, and the e2e suite before opening.

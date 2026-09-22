# FrockBot startup maps

Source-based maps of the current implementation at `0d2c2d3b457ce26468e3bd4a6e9db35b5e02b17c`. They show dependencies, not measured durations. Product code and deployed services were not changed.

Snapshot note: the worktree was subsequently rebased to `4a1bdd9ea`. The HTML/specification artifacts remain unchanged. Main now supports paused/backgrounded voice rejoin, asynchronous Silero classification, a connection chime and improved transcript row measurement. In particular, a paused rejoin can report `listening` without opening Gemini; the fresh unpaused opening path shown here is not the whole reconnect protocol. See the [upstream review](../startup-upstream-voice-overlap.md) and [completed checks](../chat-voice-startup.md#final-checks-and-rebase) for the current analysis.

- [Chat — before the first reply](chat.html)
- [Voice — before the first sound](voice.html)

Both HTML files are self-contained. Use the three numbered views to focus on one part of the path, or select a node to inspect its connections. The viewer also supports zoom, light/dark themes and export.

## Chat

`BotState` extends Cloudflare's raw `DurableObject`. Each Bot owns its ordered Turns and durable log.

Read arrows from **Send message** to **Render reply**. A stage must complete before the following stage starts, except for concurrency inside a summarized stage. `Admit the Turn` groups prior-run recovery, account settings, Session hydration and durable admission. If work is already active, an admitted Turn may queue; the next stage begins when it becomes active.

The important startup dependencies are the retained historical model requests read during admission, repeated configuration/runtime preparation, and Memory/Skills reads before model dispatch. Some independent reads already run concurrently inside these stages. The cold constructor's cleanup occurs before the Bot can handle a request.

The lower-level model stream is not what the User sees. The model invokes `send_to_user`; committed visible content causes an invalidation notice, then Flutter re-fetches the conversation. A Turn can include several model/tool steps before or after a visible send. The simplified diagram omits this loop, failures, cancellation and retries.

Sources:

- Gateway/isolate route: `apps/cloudflare/src/gateway.ts:503`
- Cold construction: `apps/cloudflare/src/bot-state.ts:575`
- Bot materialization and entry: `apps/cloudflare/src/bot-state.ts:1099`, `:1681`
- Composition and Turn execution: `app/shell/turn.ts:102`, `:206`
- Recovery and admission: `core/durable/authority.ts:302`, `:1520`
- Historical payload reads: `core/durable/session-event-log.ts:290`, `:598`
- Runtime and context: `app/shell/runtime-mount.ts:183`, `app/memory/agent.ts:1397`, `app/skills/agent.ts:875`
- Model effect fence: `core/agent-loop/model-request.ts:116`
- Invalidation and client refresh: `apps/cloudflare/src/bot-state-channel.ts:360`, `apps/native/lib/client/state_channel.dart:123`

## Voice

`VoiceAssistant` already extends Cloudflare's Agents SDK `Agent`. There is one voice coordinator per User; a call selects one Bot. It opens a separate Gemini Live audio session and delegates longer work to ordinary Bot Turns.

The first fork is real concurrency: **Open microphone** runs alongside **Authenticate socket → Activate voice Agent**. **Send start_call** waits for both microphone readiness and server welcome. On cold activation the pinned SDK awaits `onStart` before upgrading the socket; that hook includes ledger recovery and historical delivery work. A warm object does not rerun all cold startup work for each call.

After call admission and selected-Bot identity resolution, prompt preparation fans out into three branches: selected Bot context, the directory/activity of every Bot, and shared context. Gemini opens after all three complete. `Shared context` groups User Memory, voice-session Memory and the clock; the initial session Memory is also read again when opening Gemini.

**Listening** on the fresh unpaused path shown means Gemini acknowledged setup. Main's paused rejoin also emits that status without Gemini, so the status alone cannot serve as a universal audio-readiness signal. A spoken reply follows the person's input and model response, passes durable turn admission, and reaches the client player. The diagram groups these output steps; it does not equate player receipt with a measured audible start. Permission prompts and prior-call teardown may also affect entry, and tool delegation/interrupt/pause/rejoin paths are outside this startup map.

Sources:

- Client entry/parallel setup: `apps/native/lib/voice/assistant.dart:341`, `:806`
- Gateway: `apps/cloudflare/src/gateway.ts:676`
- Agent and recovery: `apps/cloudflare/src/voice-assistant.ts:727`, `:887`
- Call admission: `apps/cloudflare/src/voice-assistant.ts:1580`
- Prompt and all-Bot reads: `apps/cloudflare/src/voice-assistant.ts:3581`, `:3448`
- Gemini opening/setup: `apps/cloudflare/src/voice-assistant.ts:1750`, `:513`
- Output admission: `apps/cloudflare/src/voice-assistant.ts:2070`
- [Pinned SDK lifecycle: startup precedes upgrade](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/lifecycle/durable-object-lifecycle.ts#L515)

Further context: [startup assessment](../chat-voice-startup.md), [SDK assessment](../agents-sdk-startup-assessment.md).

Unlabelled arrows indicate ordinary completion dependencies already stated by their endpoints. Labels are retained for cross-boundary RPC, join conditions, setup acknowledgement and reply delivery. Layout length has no relationship to elapsed time.

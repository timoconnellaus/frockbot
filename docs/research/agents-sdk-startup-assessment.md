# Cloudflare Agents SDK and FrockBot startup

Research date: 2026-09-22. Scope: architecture and source inspection; no production measurements, model calls, dependency changes, or implementation. Statements about speed below are hypotheses unless explicitly described as source behavior.

The later [concrete reuse review](sdk-reuse-decision-review.md) completes this assessment against rebased main. It recommends keeping the current Bot superclass for startup work, reusing existing voice SDK facilities and selecting narrower protocol reuse for MCP. No benchmark is a prerequisite; the recommendations below reflect that completed review.

## Finding

**Voice already uses the Agents SDK. Chat uses a plain Durable Object. Changing the chat base class to `Agent` would not by itself remove the work delaying startup.** The useful architectural question is how little work each object must do before showing a conversation, admitting input, or accepting audio.

The repository pins `agents` to **0.23.0** in [the Cloudflare package](../../apps/cloudflare/package.json) and `bun.lock`. [VoiceAssistant](../../apps/cloudflare/src/voice-assistant.ts), line 727, extends `Agent`; [BotState](../../apps/cloudflare/src/bot-state.ts), line 492, extends `DurableObject`. The retired `VoiceSession` name remains in migration history, not the running voice implementation. `@cloudflare/ai-chat` and `@cloudflare/voice` are not current dependencies of the Cloudflare app.

## A startup assumption in the current code is incorrect

The voice upgrade route in [index.ts](../../apps/cloudflare/src/index.ts), line 2036, bypasses `getAgentByName` and says this prevents ledger recovery from holding up the HTTP 101 response. The pinned SDK source does not support that claim:

1. `getAgentByName` explicitly awaits the object's initialization RPC before returning its stub. Using a direct stub removes that extra RPC. [Tagged routing source](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/agent-routing.ts#L393).
2. The SDK's `Lifecycle.fetch` **also awaits initialization before attempting the WebSocket upgrade**. Initialization awaits capability startup and the host's `onStart`, inside `blockConcurrencyWhile`. [Tagged lifecycle source](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/lifecycle/durable-object-lifecycle.ts#L515).

Therefore, on a cold activation, the complete `VoiceAssistant.onStart` still sits before the WebSocket upgrade. That hook, line 887, recovers memory jobs, handles stale calls, can deliver a transcript to a Bot, scans the voice ledger, books delegation checks, announces results, and schedules pending memory work. [VoiceLedger.recover](../../app/voice/ledger.ts), line 917, also scans and prunes turns, delegations, and meters. These operations are source-confirmed prerequisites; their milliseconds and contribution to observed startup remain unmeasured.

The strongest SDK-related change to investigate is a **small startup hook with durable, scheduled recovery**: restore only the current ownership/admission facts needed to safely start a call, and record a scheduled path for unrelated retention, transcript delivery, memory finalization, and old delegation processing. Do not just launch an untracked promise or defer checks that prevent concurrent calls or duplicate spending. This changes the critical path while keeping `Agent`.

## What the SDK can replace

| Layer         | Useful SDK functionality                                                                  | FrockBot responsibility that remains                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`       | WebSocket lifecycle, client RPC, state synchronization, scheduling, queues, observability | Authentication, User/Bot ownership, admission policy, budgets, model selection, Plugin authority, prompt assembly, effect ledger |
| `AIChatAgent` | SQLite-backed `UIMessage` history, streamed responses, reconnect/recovery handling        | FrockBot's Turn semantics, `send_to_user` presentation, audit/undo, approvals, durable external-effect policy                    |
| Fibers        | Durable acceptance/checkpoints and hooks after interrupted execution                      | Safe replay or compensation for each effect; provider idempotency; recovery decisions                                            |
| Voice mixins  | An STT/LLM/TTS voice pipeline and clients                                                 | Gemini Live's native audio session, FrockBot's budgets, account-wide call ownership and Bot delegation                           |

`Agent` runs on the same Durable Objects platform. It is reusable application infrastructure, not a different runtime with an independently established cold-start advantage. The SDK's public API describes those facilities but supplies no FrockBot-specific startup benchmark. [Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/).

The 0.23.0 source performs schema initialization and framework recovery, then awaits the application startup hook. Existing schemas skip most DDL, but adopting the SDK still introduces framework work; moving the same application initialization into `onStart` cannot make that work disappear. The pin already includes `runFiber` and `startFiber`, so those are not hypothetical future upgrades. [Tagged Agent implementation](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/index.ts).

For chat, `AIChatAgent` would be a substantial model/persistence/protocol migration. Its messages are AI SDK `UIMessage`s, and its recovery can issue another model call; the documented hook permits disabling continuation when unsafe. Its `maxPersistedMessages` deletes old stored messages rather than merely reducing prompt context. These behaviors need explicit adaptation to FrockBot's durable log and presentation contract. [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/).

## Durability and authority are not automatic

`runFiber` persists a task and a checkpoint, keeps execution alive, and calls application recovery after interruption. It cannot serialize/replay the original closure. `startFiber` adds retained status, idempotent acceptance, and cooperative cancellation. Neither API establishes whether a third-party request succeeded between the request and the next checkpoint. A checkpoint after an external write does not make that write safe to repeat. [Durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/).

That distinction matters here: [the voice ledger](../../app/voice/ledger.ts) deliberately abandons uncertain model work while reconciling Bot delegations through durable run IDs. The same policy must survive any SDK adoption. The SDK can own wakeups and task bookkeeping while the application keeps the effect identity and outcome records.

SDK schedules support delayed, fixed-date, cron, and interval callbacks, with creation deduplication and retry controls. That can replace bespoke scheduler plumbing, but schedule deduplication is not downstream effect deduplication. Any Bot migration must give one scheduler custody of the object's alarm and port all current deadlines/outboxes; wrapping the existing alarm logic beside another scheduler would leave two owners. [Scheduling API](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/); [current Bot alarm](../../apps/cloudflare/src/bot-state.ts), line 3003.

State synchronization must preserve the cloud as authority. SDK readonly connections and state-validation hooks provide controls, but FrockBot should expose commands and projections rather than accept arbitrary client replacements for authoritative state. Readonly state synchronization also does not substitute for authorization inside custom RPC methods. [Readonly connections](https://developers.cloudflare.com/agents/runtime/communication/readonly-connections/).

## Voice and hibernation

Current official voice documentation labels `@cloudflare/voice` **Beta**, whereas the locally supplied skill calls it experimental. Its documented path is continuous STT → application `onTurn` → sentence-chunked TTS, over WebSockets; clients are JavaScript/React. The page does not document a Gemini Live native speech-to-speech adapter. Using it here would change the provider pipeline, not just the DO superclass. There is no measured reason to expect that change to improve this startup path. [Voice documentation](https://developers.cloudflare.com/agents/communication-channels/voice/).

FrockBot deliberately replaced that cascade with Gemini Live in [ADR 0031](../adr/0031-voice-gemini-live.md). The existing [Flutter voice protocol](../../apps/native/lib/voice/protocol.dart) and [socket implementation](../../apps/native/lib/voice/socket.dart) already speak the retained protocol without the JavaScript client. Flutter is compatible with an SDK-backed server through a wire protocol, but adopting React hooks cannot remove Flutter's microphone/player initialization or its handshake dependencies.

Hibernation keeps accepted client WebSockets connected while discarding object memory; the constructor runs again on wake. Cloudflare explicitly recommends minimizing constructor work. This applies to plain DOs and SDK Agents alike. [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

An active outbound Gemini WebSocket prevents hibernation and currently defers idle eviction for up to 15 minutes per outbound connection; deployment/runtime resets can still interrupt it. Keeping an upstream session warm has duration/provider costs and must respect the existing sleep policy. An open observer socket is not proof the object stays warm. [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

## Recommendation for the architecture discussion

1. **Keep the existing SDK base for voice; make readiness depend on bounded admission and session setup.** Move unrelated durable maintenance out of startup using the existing scheduler. The source finding justifies changing the dependencies; it does not establish a numerical time saving.
2. **For chat, separate lightweight reads/admission from execution initialization before choosing a superclass.** Keep the Bot as the single authority, maintain a bounded current-state projection and prompt snapshot, and load capability machinery when a Turn needs it. This can be done within one DO; adding another DO first would add a network hop and consistency work.
3. **Keep BotState's current base for this work.** The concrete review found that replacing socket/alarm plumbing leaves the domain recovery, Routine and publication policies intact, while requiring an ownership migration. Use the existing seams for the agreed startup changes. `AIChatAgent` adoption needs a separate semantic justification.
4. **Keep modular SDK lifecycle composition as a separate option.** The pinned package exports `agents/lifecycle`, `agents/websockets`, and `agents/schedules`, allowing a thinner composition than the full Agent, but these capabilities are experimental. A later maintenance proposal should identify the infrastructure it actually deletes and transfer alarm/transport ownership explicitly. [Tagged package exports](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/package.json), [Lifecycle source](https://github.com/cloudflare/agents/blob/agents%400.23.0/packages/agents/src/lifecycle/durable-object-lifecycle.ts#L164).

Version caution: current docs are not an exact specification of 0.23.0. For example, the [internals page](https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/) still describes a `partyserver` superclass, while the tagged `Agent` source directly extends `DurableObject` and installs `Lifecycle`. Lifecycle ordering above was checked against the pinned tag, whose package manifest declares 0.23.0. Retrieval used web browsing for official docs and tagged source, plus read-only `curl` downloads of the public tagged `index.ts`, `agent-routing.ts`, `lifecycle/durable-object-lifecycle.ts`, and `package.json` into temporary files. No local dependency install or live timing run was performed.

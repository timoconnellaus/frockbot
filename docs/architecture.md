# FrockBot Architecture

## Status

Current implemented system shape. The custom durable Agent loop, resident Bot runtime, Cordis WebUI/Vue product, and thin hosted desktop and mobile shells pass through the same backend path.

## Decision summary

FrockBot is a Cordis-first hosted application. Every capability beyond a deliberately small host bootstrap is mounted as a Cordis Plugin from a declared Package Contribution. FrockBot owns a custom Agent loop, uses pinned upstream Cordis rather than the DeepSeek Harness fork, and renders its hosted interface with Cordis WebUI and Vue. Browser, Electron, and direct-hosted Capacitor clients use the same hosted client, backend protocols, and Bot Durable Object Agent runtime.

The original Pi-backed React prototype remains available at Git commit `0d5a41e` as a rollback point. The current application has cut over to the custom Cordis runtime and Cordis WebUI after reaching prompt, streaming, tool, cancellation, restart, and screenshot-smoke parity.

Exact upstream pins and compatibility risks are recorded in [`research/cordis-foundation.md`](./research/cordis-foundation.md).

## Architectural principles

1. **Everything beyond bootstrap is a plugin.** Process entry, root-context creation, and last-resort crash reporting form the boot kernel. Transport bridge plugins own protocol decoding. Product behavior does not.
2. **A context is runtime-local.** Backend hosts, the hosted WebUI, and optional native shells each own independent Cordis roots. Cordis services are never transparently proxied across a runtime seam.
3. **Cross-process communication is explicit.** Narrow, versioned DTOs cross Electron IPC, `MessagePort`, HTTP, or WebSocket transports. Every inbound value is decoded at the seam.
4. **Definitions are separate from providers and consumers.** Contract packages declare stable service interfaces and events. Provider plugins implement them. Consumer plugins depend only on definitions.
5. **The session log is authoritative.** Every model-visible fact and every fact required for UI replay is represented by a durable session event.
6. **Ownership is structural.** Every plugin-owned listener, timer, process, socket, registration, and agent has one disposal path. Reload and shutdown wait for quiescence.
7. **Isolation is not security.** Cordis contexts and `ctx.isolate()` alter service resolution, not OS authority. Process, container, and frame boundaries enforce trust.
8. **Published artifacts are pinned.** FrockBot tests the exact npm tarballs recorded in `bun.lock`; repository `main` is not treated as evidence for shipped behavior.

## Process topology

```text
Browser, sandboxed Electron renderer, or Capacitor WebView
┌─────────────────────────────────────────────────────────┐
│ Hosted Cordis WebUI client root + Vue                   │
│   ├── FrockBot shell plugin                             │
│   ├── settings and Connections plugins                  │
│   ├── conversation and Computer plugins                 │
│   └── authenticated, versioned backend client           │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTPS hosted protocol
                           ▼
Cloudflare application gateway
┌─────────────────────────────────────────────────────────┐
│ Authentication, immutable User application, DTO routing │
│   ├── User Durable Object authority/storage/scheduling  │
│   │   └── application revision ledger + rollback        │
│   └── Bot Durable Object authority/storage/scheduling   │
│       └── declared backend runtime Contributions        │
│           ├── session + custom Agent-loop plugins       │
│           ├── model and tool provider plugins           │
│           └── durable settings and Connection plugins   │
└─────────────────────────────────────────────────────────┘

Electron main + preload
┌─────────────────────────────────────────────────────────┐
│ Hosted URL window, auth handoff, and decoded optional   │
│ platform adapters; no local WebUI or Agent runtime      │
└─────────────────────────────────────────────────────────┘

Capacitor native shell
┌─────────────────────────────────────────────────────────┐
│ Direct server.url navigation + optional declared mobile │
│ Contribution host; no local product UI or API proxy     │
└─────────────────────────────────────────────────────────┘
```

Desktop configuration supplies both `FROCKBOT_APPLICATION_URL`, loaded by the sandboxed window, and `FROCKBOT_AUTH_BASE_URL`, used for authenticated API and authorization handoff. Its strictly decoded hosted API bridge admits the provider-neutral Connection command and receipt lookup routes used by the shared WebUI. A deployment missing either origin is invalid. Optional native capabilities cross narrow preload DTOs and progressively enhance the hosted application; they do not own chat, settings, Connections, or Agent execution.

Capacitor navigates directly to the required `FROCKBOT_HOSTED_APP_URL` through `server.url`; it has no local authentication UI, hosted frame, bearer/API proxy, Bot projection, Turn admission, or product shell. The hosted page therefore uses the same authentication and backend client as the browser. A small optional native host constructs a separate Cordis root and mounts only mobile Contributions present in the immutable compiled application, in declaration order. Mounting is gated by the configured hosted origin and matching application deployment hash. It exposes only bounded, decoded capability invocation with cancellation and timeouts; missing declarations, denied adapters, or startup failure leave the hosted WebUI running with Web fallbacks.

## Boot kernel

Each runtime entry may do only the following before loading its root bundle:

1. install fatal error reporting;
2. construct the Cordis root context;
3. mount the process's first-party root bundle;
4. await readiness;
5. dispose the root during shutdown.

The boot kernel must not contain bot, session, model, tool, package, window-layout, or product-policy logic.

## Cordis foundations

FrockBot pins:

| Purpose         | Package                   | Version      |
| --------------- | ------------------------- | ------------ |
| Core            | `cordis`                  | `4.0.0-rc.8` |
| Dynamic loader  | `@cordisjs/plugin-loader` | `1.0.0-rc.5` |
| HTTP/WebSocket  | `@cordisjs/plugin-server` | `1.7.0`      |
| WebUI host      | `@cordisjs/plugin-webui`  | `0.8.2`      |
| WebUI client    | `@cordisjs/client`        | `0.8.2`      |
| Vue             | `vue`                     | `3.5.41`     |
| Vite            | `vite`                    | `8.2.2`      |
| Vue Vite plugin | `@vitejs/plugin-vue`      | `6.0.8`      |

`@cordisjs/schema` is prohibited because it belongs to the Cordis 3 package topology. `schemastery` is added only where a FrockBot package directly authors a compatible schema.

FrockBot wraps dynamic loader mutation behind its own package-catalog interface. Product modules must not directly edit loader rows. This localizes release-candidate churn and gives package activation one transactional coordinator.

The wrapper does not equate a resolved loader write with successful activation. With loader rc.5, a failed dynamic import is logged and can leave an entry without a fiber rather than reject the write; configuration updates also require awaiting the affected entry fiber, not only `loader.await()`. The wrapper verifies that a fiber exists, awaits that exact fiber, checks its final state, and rolls back otherwise.

FrockBot plugin factories use arrow functions or explicit `{ apply }` objects. Constructible function declarations are avoided because Cordis intentionally interprets constructible callbacks as plugin classes; a function declaration can therefore run as a constructor and lose its returned disposer.

Cordis services expose context-specific proxy objects that inherit from the provider instance. Service state therefore uses ordinary TypeScript-private properties or external state, never ECMAScript `#private` fields, which reject proxy receivers. Every consumer plugin explicitly declares its injected services; ambient service access is treated as an error.

## Module map

### Desktop shell

**Desktop window** owns Electron windows, hosted-origin navigation policy, sandboxing, and application lifecycle integration. It requires the hosted application URL before creating a window.

**Hosted API and authentication adapters** broker authenticated requests and native authorization handoff across decoded preload DTOs. Optional notification, clipboard, file-selection, and deep-link adapters belong at this seam. Their absence cannot prevent core hosted workflows.

### Mobile shell

**Direct hosted navigation** is configured by Capacitor `server.url` from one required HTTPS origin, with loopback HTTP allowed only for development. The local bundle is a fallback notice rather than a product runtime.

**Optional mobile Contribution host** mounts the compiled application's declared mobile Plugins against private Capacitor notification and clipboard adapters. The loaded hosted origin and immutable application hash gate availability. Hosted code can list and invoke only registered commands through exact bounded DTOs; shell teardown cancels outstanding calls and disposes the root.

### Backend Agent runtime

The kernel is `@frockbot/kernel-contracts` (session events plus the declared `ToolExecution`, `ModelInvocation`, and prompt-assembly interfaces), `@frockbot/kernel-agent-loop` (the loop and the Agent registry), `@frockbot/kernel-composition` (Package manifests, activation, and application compilation), and `@frockbot/kernel-do` (the Bot Durable Object authority). It imports no Package. The registries below are Packages that implement those interfaces: `@frockbot/plugin-tools`, `@frockbot/plugin-models`, and `@frockbot/plugin-prompt`. The `@frockbot/agent-core`, `@frockbot/agent-loop`, `@frockbot/plugin-catalog`, and `@frockbot/application-compiler` re-export shims that eased the extraction have been deleted; every dependant imports the real package. `@frockbot/architecture-checks` holds the automated checks for the constitutional rules that can be enforced mechanically (see `docs/architecture-checks.md`).

**Session store** owns append-only session events, atomic event batches, interrupted-work reconciliation, and model-history derivation. It persists the exact normalized request sent to each model after all prompt, schema, provider, and request middleware has run. The Bot Durable Object supplies durable persistence through the same narrow interface.

**System-prompt registry** accepts scoped prompt sections, variables, and tool-schema presentation. It assembles a prompt for one proposed step.

**LLM registry** selects a provider adapter and streams normalized response chunks. A separate optional reconciliation capability retrieves an original result by its durable provider effect ID; adapters without a provider-guaranteed retrieval path return reconciliation unavailable. Provider SDK choice is internal to each adapter and does not enter the agent-loop interface. The generic `@frockbot/provider-openai-compatible` adapter normalizes messages and tools, parses streamed SSE text and fragmented tool calls under per-event and cumulative byte bounds, rejects terminal streams without any valid choice, bounds HTTP errors, and receives credentials only inside its backend provider Plugin, but does not claim idempotency or repeat an uncertain request.

**Tool registry** owns tool definitions, per-agent visibility, input decoding, execution policy, and result finalization.

**Agent registry** exposes live agents, creation and disposal, inbox delivery, cancellation, status, and live agent events. Consumers do not import the concrete loop.

**Agent-loop provider** is the only module containing the concrete model/tool repetition algorithm. It registers as the agent factory and depends on sessions, prompts, LLMs, tools, and the agent registry.

**Resident Bot runtime** is the Bot Durable Object's sole Agent-runtime seam. While resident, one Cordis root contains the declared Bot backend Contributions, stable Agent services, and the dynamic Plugins selected by the Bot's durable configuration generation. `desiredGeneration` and a durable `pending | applied | failed` runtime projection make remount progress and bounded failures observable. A running Turn retains its admitted settings snapshot and applied generation; later configuration advances the desired generation but cannot remount active work. After terminal settlement, or after eviction and reconstruction, alarms apply the required generation before new admission. Construction is single-flight, failed construction is retryable, and partial mounts roll back.

### WebUI

The browser uses the Cordis WebUI client root and Vue. First-party and reviewed UI contributions mount as ordinary client plugins. The FrockBot shell provides stable slots and owns application geometry; feature plugins register triggers and content rather than editing the shell or positioning global overlays. `@frockbot/plugin-ui-theme` is the sole global visual authority and publishes semantic `--frock-*` aliases. `@frockbot/client-ui` is a Cordis-free Vue primitive library, including the lifecycle-neutral sidebar overlay and its surface registry interface. `@frockbot/plugin-settings` registers Bot settings, Plugins, and User settings as feature surfaces; the shell renders the selected registration in one non-modal overlay over the sidebar. Client providers are installed and consumed through lifecycle-owned typed keys, so a feature plugin unload removes its surface registration. Brand typography remains a same-origin stylesheet, `@frockbot/client-core/fonts.css`, without an external font request.

Feature styles are scoped, consume semantic theme aliases, and cannot define literal colors or another global theme. Every Package with a hosted client Contribution declares a dependency on `ui-theme`; CI checks both rules. Direct client plugins are trusted same-origin code. Untrusted or generated rich UI cannot be imported into the WebUI context. It must use a FrockBot sandbox-view contribution rendered in a separately permissioned frame with a narrow message protocol.

The auth Plugin owns the hosted session projection and narrow sign-out action. Browser sessions sign out through Better Auth; Electron sessions use the trusted desktop bridge. The settings profile menu consumes only that Plugin interface, disables the action while pending, and keeps failures visible without clearing the authenticated projection. URL-selected `as_user` / `frockbot_dev_user` development identity is a separate opt-in mode, so the UI explicitly reports sign-out as unavailable rather than pretending to revoke Better Auth state. Signing out detaches the client and does not cancel Bot work.

## Agent-loop contract

### Durable session events

The initial event vocabulary is:

```text
session/created
input/queued
input/admitted
input/cancelled
turn/start
turn/admission
step/start
user/message
model/request
assistant/chunk
assistant/message
tool/call
tool/result
step/end
turn/end
session/disposed
```

The inbox is a projection of durable input events. Starting a turn atomically appends `turn/start` and `input/admitted` before the claimed input disappears from that projection. A rejected proposal still closes a turn with a blocked outcome; it never leaves an empty or open turn.

`model/request` records the exact normalized provider, model, system prompt, messages, tool schemas, and request options after all live waterfalls and immediately before external I/O. It carries stable source-event identifiers so replay can audit how the request was assembled even after plugins or configuration change.

`assistant/chunk` preserves streaming and replay fidelity. `assistant/message` records the normalized completed provider response and request identifier. Tool calls and results are paired by a stable call identifier. Turn and step endings always record a typed outcome, including completion, cancellation, blocking, interruption, model failure, and tool failure.

### Live agent events

```text
agent/created
agent/disposed
agent/status
agent/inbox/inserted
agent/inbox/claimed
agent/pre-step
agent/request
agent/request-error
agent/turn-stopping
agent/cancel-requested
agent/error
```

Cordis dispatch modes are deliberate:

- waterfall for `agent/pre-step`, `agent/request`, `agent/request-error`, and guarded tool execution;
- serial for terminal checkpoints such as `agent/turn-stopping`;
- emit for lifecycle, inbox, status, and error observations;
- parallel only for checkpoints where every independent listener must settle, such as a persistence flush.

### Turn flow

```text
input/queued wakes agent
  → atomically append turn/start + input/admitted
  → agent/pre-step waterfall
  → if rejected: append turn/end(blocked)
  → append step/start and user/message for newly admitted input
  → assemble system prompt and tool schemas
  → derive model history from session log
  → agent/request waterfall
  → append the final normalized model/request
  → stream through the selected LLM provider
  → append assistant/chunk events
  → append assistant/message
  → journal and execute any guarded tool calls
  → append step/end in a finally path
  → repeat from agent/pre-step while work remains
  → run agent/turn-stopping
  → append turn/end in a finally path
  → return to idle
```

Every started step receives exactly one `step/end` before another step starts, and every started turn receives exactly one `turn/end`, except while an uncertain provider effect is durably `model/reconciliation-required`. That state deliberately keeps the current step and turn open until provider-bound retrieval succeeds. Atomic session batches and `finally` paths enforce terminal pairing during ordinary errors and cancellation.

Bot Durable Objects persist each run's identity, command fingerprint, session identity, acceptance time, input, events, status, execution phase, pinned Composition generation, admitted configuration snapshot, and prior-event boundary. Every admitted Turn pins the Bot's current Composition generation in the same transaction that writes the active-run marker, and execution and recovery read that pin from the durable run rather than recomputing it, so activating a new generation takes effect at the next admitted Turn and never moves one in flight. Composition generations are durable records under `composition:current`, `composition:generation:<id>`, `composition:index:<createdAt>:<id>`, and `composition:last-known-good`: first use materializes the first-party bootstrap generation idempotently, proposing and committing appends and supersedes rather than mutating a recorded generation, and the Agent loop records the pin as a `composition/pinned` session event at `turn/start`. Reverting is itself a recorded generation: `CompositionStore.revert` proposes a new pending generation carrying the target's members, parented on the generation that is current at the time, and refuses an unknown id or the current one, so the next admitted Turn activates it and no recorded generation is ever mutated. The Settings Package's gateway Contribution owns `GET /api/bots/:botId/composition/generations`, `GET .../generations/:id`, and `POST .../composition/revert`, each carried to the Bot Durable Object's `listCompositionGenerations`, `getCompositionGeneration`, and `revertComposition` RPCs, which prove directory membership and answer with the redacted `CompositionGenerationViewV1` — provenance, status, timestamps, and per-member version and content hash, never artifact bytes — while the hosted Composition section lists generations newest first, diffs a selected generation against the current one member by member, and reverts through a `commandId`-idempotent command whose `expectedGenerationId` is its optimistic check. Ambiguous absent-run lookups retain up to 256 permanent admission fences in one bounded durable index; further distinct fences fail visibly instead of evicting authority, and Turn admission rechecks the index in its commit transaction. One exact stored-run decoder rejects invalid identifiers, missing admission data, unknown fields, inconsistent status-specific completion or failure fields, and every malformed discriminator-specific session event, including its normalized model request, before branching or persistence. Malformed durable state preserves the active-run marker for explicit repair rather than reopening admission. Recovery restarts only work that has not recorded an external effect intent, finalizes already-durable completion, and moves uncertain model or tool outcomes into durable reconciliation instead of duplicating the effect. If the selected provider cannot retrieve the original model effect, the run remains active, scheduled, and visibly `reconciliation-required`; recovery never calls the provider's streaming creation path again.

The Durable Object bindings remain authority, transactional storage, and scheduler hosts. Each gateway request and each resident User/Bot Durable Object owns one Cordis root that mounts every declared backend Contribution as a Plugin in compiled order; partial startup and explicit gateway teardown dispose that root. Durable Object eviction drops the resident root with its object, and backend Plugins retain no authority outside durable storage. `@frockbot/kernel-do` owns the Bot Durable Object authority: command admission, the append-only event log, the resumable execution cursor, idempotency records, cancellation, and durable scheduling. The Shell Package's declared Bot backend Contribution owns configuration policy, the hosted run projection, and the composition of the Packages a Turn runs on, and supplies them to the kernel authority through narrow injected hooks. The Bot Durable Object constructs the kernel authority and mounts the Package against it. Provider-neutral User Connection Contributions own Connection state and orchestration; the Ollama Cloud Package is the active account-scoped provider implementation, while Composio remains dormant and absent from the production application. The Bot root also owns the stable Agent services and generation-selected runtime Contributions used by its resident Agent, so one resident Cordis root serves every Turn the object admits; reconstruction after eviction remounts from durable registration, settings, runtime projection, active-run snapshot, events, and cursor. Hosted Bot runtimes currently mount the declared Fly provider and provider-neutral Computer consumer before assigned Connection runtime Contributions, so browser and native shells observe one backend execution path. This direct mount is a known divergence from Bot-owned Cordis-root composition and is not corrected by the compatibility prototype; [ADR 0004](adr/0004-host-fly-computer-in-cloudflare-containers.md) records the accepted non-authoritative shared-host boundary for Fly Computer execution.

Bundling Bot-authored Package source into an immutable module runs outside the Durable Object, in the dedicated `apps/cloudflare-bundler` Worker reached through the `PACKAGE_BUNDLER` service binding. That Worker has no bindings at all: it accepts exactly one 256 KB `package.ts`, refuses a `package.json` and any surviving import specifier so Bot-authored text can never drive a network subrequest, and never throws across the binding — every rejection is a decoded `status: "failed"` result with diagnostics. It returns the module bytes and a content-addressed `ArtifactRefV1` rather than writing storage itself, so the Durable Object keeps ownership of the durable effect: it records its authorship intent, calls the bundler, then writes `packages/<contentHash>.mjs` to the artifact bucket, whose reader verifies the hash before the bytes are used.

A Composition member that carries an artifact is mounted in a Bot isolate rather than the kernel isolate. `BotIsolateContributionHost` in `@frockbot/kernel-composition` reads the hash-verified module from the artifact bucket, loads it through the Bot Durable Object's second `worker_loaders` binding `BOT_PACKAGES` with `globalOutbound: null`, a CPU and subrequest limit, and a two-entry module map — the kernel-generated wrapper `index.js` and the Package's `package.js` — and calls `health()` inside the same guarded phase, because `.get()` is lazy and a broken artifact only fails on the first RPC. The loader id is `bot-package:<userId>:<botId>:<hash>`, where the hash content-addresses the wrapper text, the Package artifact, and the digest of the Assignment-derived bindings together: a loader id is served from cache, so anything baked into the isolate must change the id or a stale isolate would keep answering. Each `health().tools` entry becomes one `ToolDefinition` whose `execute` RPCs into the isolate with a `deadlineMs` and a Durable-Object-side race, since an `AbortSignal` cannot cross the boundary. Bot code sees exactly two bindings: `IDENTITY`, a plain object, and `CAPABILITIES`, a loopback service binding minted with `ctx.exports.BotCapabilities({ props })` — an `RpcTarget` placed in a loaded Worker's `env` is rejected by workerd, so per-invocation narrowed objects are returned from the stub's methods instead. `list` is Assignment-derived, `requestAuthority` always records a durable pending decision and never grants, and `invokeModel` refuses with a pending decision unless an enabled model Assignment matches; when one does, the Bot Durable Object records the normalized request and streams the completion back through the mounted provider path as an NDJSON byte stream, the only stream shape workerd RPC carries. `verify()` surfaces an isolate member that failed to resolve, mount, or answer `health()`, tagging each with the load site it failed at.

Composition fails closed at the next admitted Turn. `activateCompositionV1` in `@frockbot/kernel-composition` reads the pin, mounts it, and verifies it — every isolate member answering `health()` with `contractVersion: 1` and a non-empty tool list inside a deadline — then commits it, records it as the new last known good, and supersedes its parent; on failure it records a `CompositionFailureV1` naming the phase (`resolve` for the artifact read, `bundle` for the authoring-time site, `mount` for `LOADER.get` and the first RPC, `health` for a mounted isolate that failed its declared check), marks the generation `failed`, mounts the last known good, raises a notification on the Bot's existing visible-failure channel, re-pins the admitted run to what it actually ran under, and admits the Turn anyway. The third consecutive failure of one generation writes `composition:quarantine:<generationId>`, marks it `quarantined`, and moves `composition:current` back to the last known good, so it is never retried until a User reverts or the Bot authors a new generation. Quarantine is per generation, not per Bot: a later, unrelated generation activates normally. `DurableCompositionFailureLog` in `@frockbot/kernel-do` owns `composition:failure:<generationId>:<attempt>`, `composition:failure-count:<generationId>`, and the quarantine record; a generation that finally activates clears its consecutive count while its recorded failures survive as repair history, and both reach the hosted client through `CompositionGenerationViewV1` with diagnostics stripped.

A Bot authors a Package through the first-party Authoring Package's one tool, `package_author`, which takes a `packageId`, a display name, a tool declaration, one TypeScript `package.ts`, and optionally a model Contribution that forwards to `CAPABILITIES.invokeModel`. The Package itself holds no authority: it decodes the input at its seam, appends `package/author-intent` to the session log, and hands the work to the authoring seam the Bot Durable Object gives it, which reserves one unit of the durable per-User authoring quota in the User Durable Object (`quota:generations:<yyyy-mm-dd>`, defaulting to 50 retained generations per Bot, 100 authored per User per day, and 256 KB of source), writes `authorship:intent:<effectId>`, calls `PACKAGE_BUNDLER`, writes `artifact:<contentHash>` beside the module in the artifact bucket, builds a `provenance.kind: "bot"` member naming the Bot, Session, Turn, and run, and proposes a `pending` generation whose origin is `bot-authored` and whose parent is the current one, before `package/authored` is appended. The proposal is pinned forward, not activated: the authoring Turn finishes on the generation it was admitted under, and the next admitted Turn pins the proposal, mounts it, and commits it, which supersedes the parent. Re-authoring the same `packageId` appends the next version and supersedes the previous member inside a new generation; neither a recorded generation nor a recorded artifact is ever edited. The effect id is deterministic in the admitted run and the exact source, so a Turn resumed after eviction lands on the same effect: a recorded outcome replays without a second bundle, and an intent with no recorded outcome is classified unknown and reported rather than bundled again. A quota breach, a bundler refusal, and an unknown effect all become an `authorship:failure:<id>` record and a tool result the model can read, never a thrown Turn.

Effect admission is part of the resident execution handle. Immediately before a provider or tool effect, the Agent loop presents its exact effect identity to the Bot Durable Object; the Bot transaction records or verifies intent and refuses admission if durable Stop intent fences the run. Provider abort remains advisory. After an uncertain response, the run retains its active marker and moves from `executing` to `reconciling`; recovery reads or reconciles the original effect and never starts a replacement effect.

Stop is an exact authenticated v1 command targeting one admitted run. The Bot Durable Object stores its fingerprinted idempotency receipt and orthogonal `stopRequestedAt` before signalling the exact resident Agent. The acknowledgement projects accepted durable state, not terminal cancellation. If no effect is uncertain, the run appends cancelled `step/end` and `turn/end`, becomes terminal `cancelled`, and clears its active marker. If an effect is uncertain, Stop remains visible while reconciliation journals the original outcome and only then terminates cancelled. Repeated identical commands replay, command-ID collisions and terminal targets reject, and disconnect merely detaches the observer. `input/cancelled` remains reserved for input that was still queued rather than admitted.

Before a restarted runtime accepts work, the session store scans for unmatched starts and execution intents. Structural repair appends interrupted `tool/result`, `step/end`, and `turn/end` events in dependency order only for work without an admitted uncertain effect. Queued input that was never admitted remains eligible to run. Once a model or tool effect has durable intent and admission, the active run remains reconciling: an idempotent tool may retry with the same `effectId`, while other effects use provider-neutral reconciliation. If reconciliation is unavailable, the run remains resumable.

## Tool execution

Tool execution is a pipeline rather than a direct function call:

```text
tools/pre-execute
  → validate permission and arguments
  → append durable tool/call execution intent
  → tools/execute
  → tools/post-execute
  → definition-owned finalization
  → append durable tool/result
  → tools/result observation
```

No side-effecting tool implementation runs before its `tool/call` intent is durable. A crash before effect admission is structurally repaired as interrupted. After admission, an uncertain tool effect remains reconciling: an idempotent tool may retry with the same `effectId`, while other tools use provider-neutral reconciliation and remain resumable when the outcome is unavailable.

A tool definition declares whether calls may run concurrently, which resources they mutate, and whether it supports idempotent retry. The loop may use bounded parallelism only when definitions and policy allow it. Permission prompts and sandbox selection are plugins at the tool seam, not branches in the loop.

### Turn admission

Every Turn is admitted as one **turn type** — `chat`, `automation`, `subagent`, or `channel` — and the tool catalog is trimmed to what that turn type admits. This is the parity register's row 57: in GrokBot the user-facing tools exist only on chat turns, the hand-off tool only on automation and subagent turns, and work tools on both.

The kernel carries the value and holds no opinion about it. `AgentOptions.turnType` defaults to `chat`, the loop records `turn/admission { turn, turnType }` beside `composition/pinned`, and it passes the turn type into `ToolExecution.schemas({ turnType })` and into every `ToolExecutionContext`. Which tools a turn type admits is entirely Package policy.

Admission is declared at two levels, a ceiling and a narrowing inside it:

1. **Manifest, the durable ceiling.** Manifest `schemaVersion: 4` adds `CapabilityDefinition.admission: { turnTypes }`. It is part of the immutable artifact set, so it is inspectable, quota-bounded, and Assignment-checkable, and a Contribution may never offer a tool on a turn type its manifest does not list. Manifest v4 is v3 plus this one field; v1, v2, and v3 bodies decode exactly as before.
2. **Registration, per tool.** `ToolDefinition.admission: { turnTypes }` narrows within the ceiling. A tool that declares nothing is offered on every turn type — every tool shipped today is a work tool — and fail-closed lives at the manifest, where a Package must name a turn type explicitly. A Bot isolate declares the same field on its tool descriptors under isolate contract version 2; a version 1 isolate declares none and its tools stay on every turn type.

`ToolRegistry` resolves the intersection once at registration, so the catalog the model saw and the call the loop admits can never disagree. `prepare` then denies an out-of-admission call with a `tool/result` denial rather than executing it — defence in depth, so a hallucinated chat-only name on an automation turn is refused, not run.

Reconstructibility needs nothing new. `model/request` already persists the whole normalized request including its tool schemas, so the trimmed catalog **is** the recorded request; `turn/admission` records the input that produced it. A Turn recorded before turn admission existed carries no `turn/admission` event and replays as `chat`.

The turn type reaches the loop as `BotTurnCommand.turnType`, and the Bot Durable Object records it so the catalog survives eviction. `StoredRunV1.admission` is `{ schemaVersion: 1, turnType, origin? }`, where `origin` names what produced a Turn that was not a person speaking to the Bot — today only `{ kind: "routine", routineId, fireId, trigger }`. It is an optional field written **only** when there is something to say: a chat Turn with no origin records no `admission` key at all, so a record written before turn admission existed and a chat record written after it are byte-for-byte the same, and an absent `admission` decodes as `chat`. The decoder is exact on both objects: an unknown turn type, an unknown origin kind or trigger, or any extra field is a rejected record rather than an ignored one. Recovery and reconciliation rebuild the command from the durable record, so a Turn resumed after eviction re-mounts its Agent on the same turn type and offers the same trimmed catalog.

The command fingerprint follows the same rule. A chat Turn with no origin keeps the exact `bot-turn-command-v1:` bytes, so idempotency records for runs in flight across the deploy still match; a Turn that names a turn type or an origin — neither of which any producer could have written before — emits `bot-turn-command-v2:`, where both are part of the identity of the command, so two firings of the same Routine text are two different commands.

Only an in-Durable-Object producer may admit anything but a chat Turn. The hosted Turn path admits `chat` and cannot do otherwise: `decodeClientTurnCommandV1` accepts exact keys, and the Bot Durable Object's run RPC accepts exact keys too, so neither a client nor the gateway can name a turn type or an origin, and absence means `chat`.

The manifest ceiling reaches the registry where the Composition registers a Package's tools. `BotIsolateContributionHost` reads it from the mounted Package's manifest — the union over its `kind: "tool"` Capabilities, because a tool descriptor names no Capability, so a Package bounds its tools only when every tool Capability it declares bounds them — and passes it as `ToolRegistration.register`'s `admissionCeiling`. A manifest that declares no bound registers none, which is every Package shipped today.

### Ending a Turn from a tool

`ToolExecutionResult.endsTurn` lets one tool result close the Turn: after `#executeTools`, the loop closes the step and ends the Turn `completed` with no further `model/request`, on both the fresh and the resume path. It is declared per _result_, not per definition, because the same tool can end a Turn for one payload and not another — GrokBot's question widget is a send payload that ends the turn, while an ordinary text send does not, and its hand-off tool always does. Nothing new is persisted: the log already shows `tool/result` then `turn/end { outcome: "completed" }` with no request after it, which replays identically.

## Routines

A **Routine** is a standing instruction a Bot runs on its own: a schedule, or a delivered webhook, and a prompt. `@frockbot/plugin-routines` owns it, and the Bot Durable Object is its authority — `AGENTS.md` names Routines in the same sentence as durable scheduling and Assignments, so the records live in that object's storage under keys the Package exports (`routine:<routineId>`, `routine-run:<routineId>:<seq>`, `routine-receipt:<commandId>`) rather than in the kernel.

`RoutineRecordV1` carries the name, the prompt, exactly one of `schedule` and `trigger`, the timezone, `enabled`, the writer of the creating write and of the latest one, the timestamps, and `lastRunAt`. The schedule-XOR-trigger rule is enforced in the codec, not at a call site, because the whole firing model rests on it. Every codec is strict, versioned, and exact-field; there are no migrations. A webhook Routine records the trigger **kind** and nothing else: no key, no digest, no URL. Beside each record sits a bounded 50-entry `RoutineRunEntryV1` log whose statuses are `running`, `ok`, `failed`, `skipped`, and `cancelled`. That log holds no authority — every entry names its `runId`, and the stored run carries `admission.origin.routineId`, so the log is rebuildable from the run index and trimming loses index rows, never facts.

A write is validated for syntax at write time and never at firing time. `croner` parses the five-field cron expression; `plugin-routines/src/cron.ts` owns the normalization `croner` does not do — a `CRON_TZ=<zone>` prefix, the `@hourly`/`@daily`/`@weekly`/`@monthly` aliases, and `@every <duration>` as a fixed interval — and `Intl.DateTimeFormat` validates the timezone. A bad expression or an unknown zone is a rejected command with its reason, not a dead alarm.

Every write goes through one command path. `RoutineCommandV1` is `routine/create`, `routine/update`, `routine/pause`, `routine/resume`, or `routine/delete`; `routine/update` is partial, so an absent key leaves the durable field exactly as it was, and naming a schedule clears a trigger and the reverse. Each command carries its own idempotency key, and the durable receipt is fingerprinted with the same canonicalization `configurationCommandFingerprintV1` uses, under its own namespace: a retry replays the recorded receipt and a reused key carrying different bytes is refused. Routine commands deliberately carry no `expectedRevision` — a Routine is its own durable record rather than a field of the Bot settings view, so an unrelated profile edit must not make a Routine write conflict.

Two callers reach that path, and they differ only in the writer they record. The hosted client `POST`s to `/api/bots/:botId/routines` (with `GET` there for the list and `GET /api/bots/:botId/routines/:routineId/runs` for the log), authenticated beside `/api/bots/:id/settings`, and the record's writer is `{ kind: "user" }`. The Bot calls the `routine_manage` tool, mounted only inside an admitted Turn, and the writer is `{ kind: "bot", botId, sessionId, turnId }` — the Session and Turn that produced the write, exactly as a Skill write records them. `RoutineViewV1` narrows a Bot writer to its `botId`, so no Session identifier and no key material reaches a browser. The tool declares no admission of its own, and its Capability (`routine-tools`, manifest v4) names all four turn types, so it is a work tool available on chat and automation Turns alike.

**Nothing fires yet.** There is no scheduler, no alarm hook, no cron evaluation beyond the write-time syntax check, no webhook route and no key store. Those are the next PRs: the scheduler on the Bot Durable Object's single `alarm()` alongside the Assignment sagas, then the webhook door on the gateway's `publicRoute` seam with a signed token at the edge and an authoritative key digest in the Bot Durable Object. Until then a Routine is a durable, editable, auditable record whose run log is empty, and the hosted surface says so: `RoutinesSection.vue` in the Bot settings surface leaves "next run" blank rather than showing a time no authority has promised.

## Package model

A Package is the installable unit. A Contribution is one runtime-specific entry in that Package. A Plugin is the live Cordis instance created from a Contribution.

Manifest v3 backend Contributions declare their backend host explicitly. The hosted gateway, User Durable Object, and Bot Durable Object resolve the compiled entries into Plugins and mount them through the same owned Cordis-root lifecycle; adapters do not directly construct product Contributions. Provider routes, callback policy, and external-system coordinators stay in the owning Package. The gateway supplies authenticated User authority and platform context without branching on provider identity.

A Package manifest has a versioned FrockBot section that declares identity, compatibility, dependencies, permissions, and runtime Contributions. Manifest v3 may additionally declare bounded setting schemas, Connection Types, and Capabilities. Contributions are scoped to backend hosts, the Bot Agent runtime, the hosted client, the desktop shell, or the mobile shell.

`@frockbot/plugin-clock` is the reference Package for this contract. Its manifest declares one runtime Contribution that registers and invokes a `current_time` tool, one trusted desktop-main Contribution, and one hosted client Contribution that fills the shell's `frockbot.right-panel` slot. Each host activates only the Contribution kinds it owns.

`@frockbot/plugin-flock` is the built-in Bot lifecycle and visual-identity Package. Its gateway Contribution owns exact authenticated Bot directory, sheep, and lifecycle routes. Its User Contribution atomically admits bounded Bot registrations and replayable create receipts, stores lifecycle projections separately from immutable registration seeds, and coordinates durable archive/restore sagas. It records intent before an idempotent Bot lifecycle RPC, reads the authoritative Bot marker after an uncertain response, and commits the User projection only after settlement; the generic User host merely dispatches alarms to resume declared Contributions. Its Bot Contribution materializes sheep identity and an authoritative active/archived marker, rejects archive while active or reconciling work remains, and fences archived mutations and admission. Its hosted client Contribution hides archived Bots from the active flock by default, offers archive confirmation and archived management/restore controls, and deterministically repairs selection when the active URL target is archived. Archive preserves history, settings, Assignments, and the registration seed. Package-owned 256px WebPs are inlined into the immutable hosted stylesheet, so browser and native shells render one same-origin asset path without runtime access to prototype artifacts.

One Package may contribute to several runtimes, but Cordis does not make that activation atomic. The Package catalog coordinates prepare, mount, commit, and rollback across roots. Disabling a Package first blocks new work, then drains and disposes Contributions in reverse dependency order.

`@frockbot/plugin-package-publisher` is the first User-owned publication vertical slice. Every Bot mounts its runtime Contribution and may list, publish, or roll back the User's shared immutable application revisions. The Bot edits by whatever Computer mechanism is available in the fixed `/home/box/setup` Git repository; publication archives committed `HEAD`, reads `dist/application.mjs`, and carries that source snapshot, exact built application artifact, and required-check results in the durable command. The User Durable Object records a pending publication and durable recovery alarm before writing content-addressed source and artifact objects to R2, then loads those exact bytes through Worker Loader and requires a matching `/app-manifest` plus non-empty HTML, JavaScript, and CSS responses with their expected content types before changing the active hash. Failed checks or verification preserve the current active revision; command IDs replay durable receipts, and rollback changes the User-wide active revision through the same authenticated backend protocol used by the hosted and desktop clients. File-editing tools and editor choice are deliberately outside this Package.

`@frockbot/plugin-fly-sprite` is the first Computer provider Package. The Bot Durable Object mounts it behind the provider-neutral Computer interface, and it owns the Sprites SDK, `SPRITES_TOKEN`, the Workspace file surface, and the durable-root sync. It maps persistent User identity to one Computer and each Bot tenant to a deterministic private workspace, Package-data directories, Chromium profile, X display, CDP port, VNC port, and `flock`-serialized takeover lease. Strong isolation depends on the provider's VM and network enforcement rather than Cordis or directory naming. Beside it, `@frockbot/plugin-computer/shared-provider` registers the `shared-computer` provider, which sends exact, versioned, effect-identified DTOs through the `COMPUTER_HOST` service binding to the replaceable non-authoritative Computer host of [ADR 0004](adr/0004-host-fly-computer-in-cloudflare-containers.md); that host journals each effect identity before execution, replays durable outcomes, and reports an unresolved result instead of duplicating an uncertain effect. `apps/computer-host` is that host, and it is now the production path: an internal Worker with no public route that shards each request by **userId** onto a bounded pool of Cloudflare Containers (`basic`, `max_instances: 3`, `sleepAfter: "10m"`, two warm shards), so every Bot of one User reaches the one container holding that Computer's display-slot registry and takeover lease. `packages/computer-host-protocol` is the v1 seam both sides decode — `open`, `exec`, `file/{read,write,list,stat,delete}`, `control`, `viewer`, `service`, `cancel`, each carrying `version`, `effectId`, `identity`, `tenant`, and an opaque `credentialRef` — with exec answering either one buffered result or a stream of NDJSON frames. `packages/computer-host-runtime` holds the Computer's on-Sprite layout and shell scripts once, imported by both the host and `@frockbot/plugin-fly-sprite`. The host is where `SPRITES_TOKEN` is used and the only place the Sprites SDK runs; the Durable Object sends `credentialRef` and never a credential. Two measurements shape it: Fly answers a command whose argv or environment exceeds roughly 2.5 KB with HTTP 431, so every script reaches the Sprite on stdin and file bytes use the filesystem API rather than a shell; and the SDK's HTTP exec parses one transport chunk as one protocol frame, so the host uses the WebSocket exec available only outside Workerd and frames its own answers by newline. The container holds no canonical state: on restart it re-derives a Computer from the Sprite, adopting a provisioned one rather than provisioning it again, and an in-flight exec dies into a declared retryable failure the Durable Object reconciles. Load is shed rather than queued at thirty-two in-flight effects per container and four per User.

The current slice changes the User's hosted Dynamic Worker application, including its UI and gateway Contributions. It does not dynamically import user-authored Agent Contributions into the Bot Durable Object; Bot admission, session state, Agent execution, and runtime composition remain on the compiled foundation revision. Extending publication to Bot-runtime code must retain those authorities and add an enforceable trust boundary rather than moving the Agent loop into the Dynamic Worker.

Computer behavior is split across three modules. `@frockbot/computer-core` defines the provider registry, the Workspace file surface and its declared layout, and the process, browser, viewer, and control interfaces. `@frockbot/plugin-computer` owns provider-neutral tools, prompt policy, reactive state, and the trusted viewer UI. Provider Packages register adapters; consumers resolve the selected provider using persistent User and Bot identity and never import provider SDKs.

[ADR 0012](adr/0012-one-computer-per-user.md) and [ADR 0013](adr/0013-bidirectional-memory-sync.md) are implemented. A Computer is provisioned and keyed per User (`ComputerIdentityV1`), and each Bot attaches to it as a tenant (`ComputerTenantV1`) with its own directories and desktop slot. The durable-root synchronization with object storage exists: `packages/workspace-store` implements `WorkspaceFilesV1` over an object bucket with every write conditional (`If-Match` on the object's ETag, `If-None-Match: *` for an asserted absence) and every generation recorded in the Durable Object that owns the root, `apps/cloudflare/src/workspace.ts` binds it over R2, and `packages/plugin-fly-sprite/src/sync.ts` reconciles each declared root between object storage and the Computer as a backend agent driving the Sprite through the provider — not a mount, and holding no bucket credential on the Workspace. The Memory Package no longer writes Memory roots on the Computer: it writes object storage directly, so Memory works while the Computer is hibernated, and the Computer sees Memory roots read-only, materialized there by the sync. Every other durable root synchronizes both ways: a losing conditional write is preserved under its conflict key and recorded as a conflicting generation on both sides, and a file a shell wrote on the Computer is mirrored with an `unattributed` writer, which `isLoadableSkillSourceV1` refuses as an instruction. The Computer Package (`packages/plugin-computer/src/agent.ts`) is the production caller: it pulls before a Turn's first Computer tool call, again mid-Turn only when the Sprite's declared watcher service signals a change, and pushes after a Turn that used the Computer; a sync that cannot run is a `computer/sync` outcome in the session event log rather than a failed Turn. [ADR 0011](adr/0011-minimal-kernel-and-self-modification.md) is not yet fully implemented. The paragraphs below describe what is implemented today.

`@frockbot/plugin-fly-sprite` is the first Computer provider Package. One Sprite backs one User's Computer; the Sprite name is derived from the User and nothing else. Each Bot tenant on it receives a deterministic directory key, an on-demand X display slot, a CDP port, a VNC port, and a `flock`-serialized takeover lease; all tenants share one Chromium profile at `/home/box/chrome-profile`, so logins are a User-level asset. The provider declares its `WorkspaceLayoutV1` — `bot-instructions` at `agent-data/agents/<key>/skills`, `bot-memory` at `agent-data/agents/<key>/memory`, `user-memory` at `agent-data/user-memory`, and Package-declared roots under `agent-data/user-packages/<package>/<root>` — and implements `WorkspaceFilesV1` over it. A write mints its generation from the owning Durable Object's ledger, records it there, and leaves a sidecar naming it beside the file; a read answers with an attributed writer only when that ledger still holds the same generation and content hash for those bytes, because the Workspace holds files and never authority. Everything else — a file a shell wrote, a sidecar it forged, any file at all where no ledger is injected — is `unattributed`. Memory roots are read-only through that surface. Generic process and browser calls cross the Computer interface; file access does not wake the desktop and is not blocked by human takeover. A tenant-local websockify `TokenFile` gateway routes opaque viewer tokens to loopback VNC ports. The Sprites token remains provider-local. Separation between tenants is organizational, not a security boundary: the User's Computer is the trust boundary. Heartbeat loss re-shields the viewer, and expired leases can be atomically reclaimed after a crash. Display slots are bounded at a hundred and reclaimed only from a tenant the provider's own registry shows idle — no `last-seen` stamp inside the declared threshold and no fresh takeover lease — and when every slot belongs to a live tenant the new tenant is refused with a declared unavailable outcome rather than sharing a screen.

Computer assignments are keyed by `userId`, so two Bots of one User resolve to one assignment, one generation, and one Sprite. A provider change increments the assignment generation so handles can reject stale work. Memory has one store on every platform: the Memory Package writes object storage through `WorkspaceFilesV1`, on desktop as in the cloud, and the Computer never writes a Memory root. Vector indexes are derived from that canonical Markdown and are rebuildable from it.

## Configuration and Connections

The cloud gateway owns the authenticated production settings transport, decodes every User and Bot configuration view and receipt returned across Durable Object RPC seams, and rejects mutating API requests carrying an Origin other than the request origin or a configured native-client origin; production explicitly permits the two mobile shell origins `capacitor://localhost` and `frockbot://localhost`. `@frockbot/configuration-core` defines exact versioned User and Bot queries, commands, RPC authority envelopes, views, revisions, and receipts, including their nested profiles, models, Assignments, and dependency requirements. A Bot exists only after the Flock User Contribution registers it; arbitrary query parameters are selection hints and cannot create Bot state. Every Bot-scoped RPC proves directory membership before its Bot Durable Object writes identity, settings, run fences, notifications, or sheep state. The immutable registration seed snapshots its initial profile, model default, and legal sheep recipe; first use idempotently materializes those values without an external effect. Every exported RPC on the `UserConfiguration` and `BotState` Durable Objects and the `UserBotState` worker entrypoint accepts an exact v1 authority envelope and decodes caller-controlled values before mounting a Contribution or accessing durable state. The immutable Foundation application owns the User Contribution factory registry and dependency wiring; the User Durable Object supplies storage and a secret-reader capability without branching on concrete Package specifiers. Notification reads and acknowledgements validate durable identity through a read-only check, so observation cannot reconcile configuration or advance its revision. Declared gateway, User, and Bot backend Contributions own configuration policy, route shapes, and orchestration; the gateway and the Durable Objects provide their authenticated User authority, platform context, storage, scheduling, and narrow RPC adapters without branching on provider identity. The Settings Package's gateway Contribution owns the exact authenticated `/api/connections` and `/api/connection-commands` routes, and its User Contribution adjudicates which provider Package owns a Connection command from the durable Connection projection and the registered Connection command owners. Commands carry stable IDs and expected revisions, so duplicate delivery returns the existing receipt and stale writes fail explicitly. Connection command admission and hosted receipt lookup share one bounded public command-ID decoder, ensuring every admitted operation remains addressable by recovery.

Manifest v3 lets a Package declare bounded User/Bot setting schemas, Connection Types, and Capabilities. Manifest decoding rejects undeclared fields at every object boundary, along with remote schema references, excessive nesting, and oversized schemas. The hosted Plugins surface loads the immutable Package catalog during authenticated startup, derives provider presentation from Package catalog metadata, serializes Bot settings hydration after the catalog-backed User projection, preserves independent load failures, rejects disabled-Package model options, and accepts only the exact owned version of the application-manifest response before projecting those declarations; installing a Package records durable User availability but does not grant a Bot authority. Bot model onboarding claims the selected Connection dependency before atomically committing its Capability Assignment and exact provider model in one Bot command. New-Bot creation atomically records a pending dependency for the User's default model, snapshots the exact Assignment in the registration, and acknowledges it only after Bot Durable Object materialization commits and still retains that Assignment. Switching model Connections through either binding command records the exact enabled superseded model Assignment generation, durably acknowledges the replacement when needed, and releases only that model dependency before completing its saga. Superseded and same-Capability historical Assignments and generation records are removed during the atomic Bot transition, bounding repeated model switching, while an existing Assignment ID cannot change its Package Capability authority. Explicit model unbinding, including an unavailable current Assignment, atomically removes the model authority and durably releases its acknowledged Connection dependency before returning. Notification list and acknowledgement responses use exact shared v1 envelopes; `@frockbot/connection-core` owns provider-neutral Connection transport result contracts.

The Settings User Contribution owns durable User profile, package-installation, Connection projection, Assignment dependency coordination, and default-model state behind the versioned configuration interface. Assignment claims, sequence-fenced acknowledgements, acknowledged releases, and pending compensation are provider-neutral transactional mutations exposed through exact User Durable Object RPCs; a rejected acknowledgement compensates and releases its exact claim before the Bot saga terminalizes, and every terminal model switch releases its superseded dependency. Acknowledging a reassignment atomically releases the Bot's previous dependency for that Package Capability, and Connections with remaining dependents cannot be disconnected. Active Connections are bounded, and revoked projections are compacted when a replacement is created; the User Durable Object can still route a replay through the unique provider-owned retained command receipt after its Connection projection is gone. Flock reads a transaction-local snapshot from that Contribution when registering a Bot, so generic User authority does not depend on any external integration Package.

`@frockbot/plugin-credentials` owns the account-scoped encrypted credential store and the Bot-runtime lease opener; Shell passes only a secret-reader capability while provider Plugins receive opaque leases and never receive the keyring. Settings and public Connection DTOs contain only opaque generations and redacted descriptors; versioned AES-GCM envelopes are authenticated to account, Connection, Package, and credential generation, and keyring decoding uses an own-property-only null-prototype key map. Every provider operation that crosses credential custody, including staged-generation validation and model execution, acquires an idempotent, expiring lease keyed by its durable effect ID. Rotation atomically promotes a validated pending generation, admitted effects retain the old generation, and retired ciphertext is purged only after dependent leases settle. Each Connection credential generation owns a bounded expiry ledger that rejects delayed active- or pending-generation lease replay without consuming another Connection's capacity; discarding a pending generation sweeps its indexed expiry tombstones, and reaching one active generation's capacity requires rotating only that Connection. An account-wide paged recovery queue expires at most 64 leases per alarm and durably reschedules unfinished pages, while settlement verifies the account, Connection, and Package authority that issued the lease and clears a matching expiry tombstone when a delayed durable outcome arrives. Disconnect purges the active generation's expiry ledger when local custody ends. Production setup fails closed unless a generated keyring is durably stored before its only in-process copy is discarded.

`@frockbot/plugin-provider-ollama-cloud` contributes the Ollama account authorizer in the User Durable Object and the `ollama-cloud` LLM adapter in the Bot runtime. Each ready Connection owns an advisory normalized model catalog with durable generation, freshness, and refresh scheduling; oversized provider catalogs are deduplicated and truncated before bounded detail enrichment, refresh and disconnect terminal projection commits are transactionally sequenced, reconciliation-required revocation cannot be downgraded by a concurrent local disconnect, superseded refreshes return failed receipts, and each validation or catalog projection commits atomically with its durable credential-settlement cursor retained until settlement succeeds. A Bot model binding stores the exact Connection ID and provider model ID and is executable only while an enabled matching model Capability Assignment grants authority to that Connection; the hosted ready projection applies the same declared-capability check. Runtime construction rejects unavailable bindings and provider IDs inconsistent with the selected Package runtime, mounts the selected provider Package, and records Connection and catalog generations in normalized model requests. Catalog absence triggers exact provider resolution rather than fallback. The hosted client reconciles ambiguous credential rotations through an authenticated durable command-receipt lookup before reusing an operation identity, so a lost response cannot revive an older rotation. Admission bounds pending commands at 64, recovery alarms resume at most one pending command and refresh at most one due Connection per invocation, and remaining work is durably rescheduled. Validation and catalog commands durably declare their safe metadata-read retry policy before provider access; exact model resolution additionally journals pending and terminal outcomes before lease settlement, so recovery either reuses an outcome or knowingly retries a side-effect-free metadata read. Manual command fingerprints and receipts are retained in 256 detailed records plus 128 compact tombstones so delayed duplicate delivery cannot repeat an effect; admission fails visibly when the bounded permanent history is full. Disconnect atomically terminalizes pending create and rotation commands, discards their staged generations, removes active local custody, and projects credentials as unconfigured. Ollama cannot retrieve an uncertain provider response, so automatic recovery preserves that run for an authenticated user decision; an explicit reconciliation attempt that remains uncertain terminalizes the run as failed and releases the Bot for later Turns. Credential settlement routes through the owning provider Contribution so primary, exact-resolution, validation, and catalog lease obligations remain provider-owned. Provider credentials and Ollama wire types never enter the generic Agent loop.

Bot settings own stable Capability Assignments, generation receipts, and a separate projected Assignment operation (`assigning | replacing | unassigning`, `pending | retrying`). Assign, Replace, and Unassign are exact revision-checked commands coordinated as durable Bot sagas. For a Connection-backed target, `UserConfiguration` selects the owning backend Contribution from the durable Connection's Package identity and forwards exact provider-neutral claim, read, acknowledge, release, and reconcile DTOs. Missing owners report unavailable rather than fabricating a claim. Replace claims the new generation, atomically swaps the stable Assignment in Bot storage, and attempts to settle acknowledgment before releasing the old generation. A definitive acknowledgment failure marks the new Assignment unavailable but still proceeds with the old release. Unassign removes the stable Assignment only after definitive release. Alarms resume uncertain cross-Durable-Object steps, and command replay returns the same receipt while collisions reject.

The hosted Bot settings surface derives candidates from the immutable Package catalog and installed User Packages, offers only ready compatible Connections, and exposes Assign, atomic Replace, Unassign, unavailable stable Assignments, and retrying operations. An empty production catalog renders as empty rather than implying an unavailable provider exists.

Composio is temporarily absent from the compiled foundation application and production dependency graph while its integration is redesigned around Composio Connect MCP. The dormant package source is not mounted, advertised, configured, or bundled by the hosted production path; CI and the setup wizard require and forward no Composio credentials. Reintroduction requires a complete backend-owned Connection and Agent-runtime vertical slice rather than a second product path.

Bot admission, Agent execution, session-event persistence, recovery alarms, and runtime reconstruction now run in the Bot Durable Object. Session persistence is asynchronous internally but exposes an explicit flush seam; the Agent loop flushes admission, `model/request`, `tool/call`, assistant completion, and terminal events before crossing their relevant effect or completion boundaries. A durably committed assistant or no-effect event remains the settlement cursor: settlement failure keeps the Turn resumable, and recovery preserves the current snapshot-authorized assigned runtime Packages while reconstructing that already-admitted provider from its durable request binding, independent of later Package disablement, until it idempotently settles the model lease and any derived exact-resolution lease. A Bot with notifications enabled records a durable notification intent before any browser or mobile adapter displays it; unacknowledged intents replay after disconnect, and adapters acknowledge only after display or when the visible conversation already delivered the result.

## Trust model

| Trust tier              | Desktop contribution                 | Backend contribution                                 | WebUI contribution                                          |
| ----------------------- | ------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------- |
| Built-in                | Electron main or preload adapter     | Bot or User Durable Object runtime                   | Direct hosted client plugin                                 |
| Reviewed third-party    | Separate host process where possible | Dedicated runtime/container according to permissions | Direct only when explicitly trusted; otherwise sandbox view |
| Generated or unreviewed | Never                                | Quarantine process/container only                    | Sandbox view only                                           |

A permission manifest improves review and routing but is not enforcement. Enforcement requires the selected process, container, operating-system, credential-broker, and frame policies to deny undeclared actions. Published User application artifacts run in per-hash Worker Loader isolates with only the injected deployment identity and User-scoped Bot-state binding; publication health verification does not promote their code into the Bot Durable Object. Public network egress is intentionally available to these application artifacts, while platform secrets are not injected into their module map.

Cordis `ctx.isolate()` is not used as a security boundary. Until upstream issue #72 is resolved or excluded by a regression test, FrockBot also avoids relying on bare isolated-context disposal for critical ownership.

## Repository shape

The current workspace separates hosted applications, backend runtime composition, platform shells, and shared Plugin contracts:

```text
apps/
  cloudflare/              Hosted application gateway and Durable Object adapters
  cloudflare-bundler/      Package bundler Worker (no bindings, no egress)
  desktop/                 Electron hosted-window shell and platform adapters
  mobile/                  Direct-hosted Capacitor shell and optional adapters
  agent-runtime/           Transport-neutral backend Agent composition
packages/
  kernel-contracts/        Session, model, prompt, and tool execution contracts
  kernel-agent-loop/       Concrete durable loop provider and Agent registry
  kernel-composition/      Package manifest, activation coordinator, and compiler
  kernel-do/               Bot Durable Object admission, log, cursor, and scheduling
  plugin-tools/            Tool registry Package
  plugin-models/           Model provider registry Package
  plugin-prompt/           System-prompt registry Package
  architecture-checks/     Automated checks for the mechanically enforceable rules
  configuration-core/      Versioned settings and Connection projections
  connection-core/         Credential, catalog, and Connection command DTOs
  plugin-credentials/      Encrypted account credential records and leases
  plugin-shell/            Hosted Vue shell and backend shell Contributions
  plugin-*/                First-party feature and provider Packages
  protocol/                Versioned cross-runtime DTOs and decoders
```

Package boundaries may be consolidated when two modules do not vary independently. The definitions/providers/consumers dependency rule matters more than maximizing workspace count.

## Startup and execution sequence

1. The browser loads the hosted application directly; Electron validates and opens its configured hosted origin; Capacitor uses its configured hosted origin as `server.url`.
2. The hosted client authenticates through the auth Plugin and exchanges only versioned DTOs with the Cloudflare gateway.
3. The gateway resolves the User's active immutable application hash, loads that application through Worker Loader, routes User configuration and publication work to the User Durable Object, and routes Bot work to the selected Bot Durable Object.
4. Each Durable Object mounts declared built-in backend Contributions in its host-owned Cordis root; the Bot root projects the required durable runtime generation, and published User application code remains outside those authoritative contexts.
5. The Bot host durably admits a Turn and each model or tool effect before the resident Agent-loop Plugin crosses the corresponding boundary.
6. Browser and native observers project the same durable run and session state; disconnecting an observer does not cancel the Turn.
7. Native authentication handoff, deep links, notifications, clipboard, and file selection remain optional declared enhancements at decoded platform seams.

## Validation gates

The production composition is accepted only when automated tests demonstrate:

- one resolved copy of every pinned Cordis/WebUI package;
- one resident Bot Cordis root, exact-once Plugin setup, and rollback across failed or repeated runtime reconstruction;
- active runs retaining their admitted generation while pending or failed desired projections remain durable and recoverable;
- admitted work surviving client shutdown and Durable Object reconstruction;
- hosted API authentication, exact DTO decoding, and origin rejection;
- WebUI operation with Node integration disabled;
- durable replay reproducing the exact normalized model request and visible chat output;
- every started step and turn receiving exactly one typed ending;
- model and tool effects being durably admitted, journaled before execution, fenced by Stop, and never implicitly duplicated after interruption;
- recovery resuming completed model journals while retaining genuinely uncertain effects for reconciliation;
- Stop intent and idempotency surviving eviction, including uncertain-effect reconciliation before terminal cancellation;
- explicit authenticated cancellation leaving no unmatched tool call or open turn;
- provider-neutral Assignment claim/read/acknowledge/release/reconcile sagas and atomic Replace recovery;
- immutable Bot registration seeds, archive/restore recovery at every saga boundary, and preserved Bot data;
- publication intent preceding artifact writes, exact-artifact health verification, active-revision preservation after failure, idempotent command replay, and authenticated User-wide rollback;
- browser, Electron, and direct-hosted Capacitor using the same hosted and backend paths;
- optional mobile Contributions mounting only from the compiled declaration and failing without blocking hosted startup;
- package activation rollback after failure in any Contribution;
- packaged Electron startup without Bun installed and clear failure when required hosted configuration is absent.

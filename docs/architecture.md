# FrockBot Architecture

## Status

Accepted direction. The pinned foundation proof, first custom event-sourced agent loop, and Cordis WebUI/Vue product slice pass end to end.

## Decision summary

FrockBot is a Cordis-first hosted application. Every capability beyond a deliberately small host bootstrap is mounted as a Cordis plugin from a declared Package Contribution. FrockBot owns a custom agent loop, uses pinned upstream Cordis rather than the DeepSeek Harness fork, and renders its hosted interface with Cordis WebUI and Vue. Browser, Electron, and mobile clients use the same backend protocols and Bot Durable Object Agent runtime.

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
Browser or sandboxed Electron renderer
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
│ Authentication, application artifact, and DTO routing   │
│   ├── User Durable Object authority/storage/scheduling  │
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
```

Desktop configuration supplies both `FROCKBOT_APPLICATION_URL`, loaded by the sandboxed window, and `FROCKBOT_AUTH_BASE_URL`, used for authenticated API and authorization handoff. Its strictly decoded hosted API bridge admits the provider-neutral Connection command and receipt lookup routes used by the shared WebUI. A deployment missing either origin is invalid. Optional native capabilities cross narrow preload DTOs and progressively enhance the hosted application; they do not own chat, settings, Connections, or Agent execution.

The Capacitor bundle is likewise a thin auth and capability host. After bearer authentication it frames the same hosted WebUI and proxies exact versioned API and mobile-command messages through a source- and origin-checked `postMessage` seam. The hosted frame never receives the persisted bearer token; the local shell owns authorized fetch and native adapters only. `capacitor://localhost` and `frockbot://localhost` are the only permitted non-Web frame ancestors. The previous local mobile Bot projection, Turn admission, and product shell were removed so Flock and every future hosted client Contribution have one UI implementation.

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

### Backend Agent runtime

The kernel is `@frockbot/kernel-contracts` (session events plus the declared `ToolExecution`, `ModelInvocation`, and prompt-assembly interfaces), `@frockbot/kernel-agent-loop` (the loop and the Agent registry), `@frockbot/kernel-composition` (Package manifests, activation, and application compilation), and `@frockbot/kernel-do` (the Bot Durable Object authority). It imports no Package. The registries below are Packages that implement those interfaces: `@frockbot/plugin-tools`, `@frockbot/plugin-models`, and `@frockbot/plugin-prompt`. `@frockbot/agent-core`, `@frockbot/agent-loop`, `@frockbot/plugin-catalog`, and `@frockbot/application-compiler` remain re-export shims over them.

**Session store** owns append-only session events, atomic event batches, interrupted-work reconciliation, and model-history derivation. It persists the exact normalized request sent to each model after all prompt, schema, provider, and request middleware has run. The Bot Durable Object supplies durable persistence through the same narrow interface.

**System-prompt registry** accepts scoped prompt sections, variables, and tool-schema presentation. It assembles a prompt for one proposed step.

**LLM registry** selects a provider adapter and streams normalized response chunks. A separate optional reconciliation capability retrieves an original result by its durable provider effect ID; adapters without a provider-guaranteed retrieval path return reconciliation unavailable. Provider SDK choice is internal to each adapter and does not enter the agent-loop interface. The generic `@frockbot/provider-openai-compatible` adapter normalizes messages and tools, parses streamed SSE text and fragmented tool calls under per-event and cumulative byte bounds, rejects terminal streams without any valid choice, bounds HTTP errors, and receives credentials only inside its backend provider Plugin, but does not claim idempotency or repeat an uncertain request.

**Tool registry** owns tool definitions, per-agent visibility, input decoding, execution policy, and result finalization.

**Agent registry** exposes live agents, creation and disposal, inbox delivery, cancellation, status, and live agent events. Consumers do not import the concrete loop.

**Agent-loop provider** is the only module containing the concrete model/tool repetition algorithm. It registers as the agent factory and depends on sessions, prompts, LLMs, tools, and the agent registry.

### WebUI

The browser uses the Cordis WebUI client root and Vue. First-party and reviewed UI contributions mount as ordinary client plugins. The FrockBot shell provides stable slots and owns application geometry; feature plugins register triggers and content rather than editing the shell or positioning global overlays. `@frockbot/plugin-ui-theme` is the sole global visual authority and publishes semantic `--frock-*` aliases. `@frockbot/client-ui` is a Cordis-free Vue primitive library, including the lifecycle-neutral sidebar overlay and its surface registry interface. `@frockbot/plugin-settings` registers Bot settings, Plugins, and User settings as feature surfaces; the shell renders the selected registration in one non-modal overlay over the sidebar. Client providers are installed and consumed through lifecycle-owned typed keys, so a feature plugin unload removes its surface registration. Brand typography remains a same-origin stylesheet, `@frockbot/client-core/fonts.css`, without an external font request.

Feature styles are scoped, consume semantic theme aliases, and cannot define literal colors or another global theme. Every Package with a hosted client Contribution declares a dependency on `ui-theme`; CI checks both rules. Direct client plugins are trusted same-origin code. Untrusted or generated rich UI cannot be imported into the WebUI context. It must use a FrockBot sandbox-view contribution rendered in a separately permissioned frame with a narrow message protocol.

## Agent-loop contract

### Durable session events

The initial event vocabulary is:

```text
session/created
input/queued
input/admitted
input/cancelled
turn/start
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

Bot Durable Objects persist each run's identity, command fingerprint, session identity, acceptance time, input, events, status, execution phase, pinned Composition generation, admitted configuration snapshot, and prior-event boundary. Every admitted Turn pins the Bot's current Composition generation in the same transaction that writes the active-run marker, and execution and recovery read that pin from the durable run rather than recomputing it, so activating a new generation takes effect at the next admitted Turn and never moves one in flight. Composition generations are durable records under `composition:current`, `composition:generation:<id>`, `composition:index:<createdAt>:<id>`, and `composition:last-known-good`: first use materializes the first-party bootstrap generation idempotently, proposing and committing appends and supersedes rather than mutating a recorded generation, and the Agent loop records the pin as a `composition/pinned` session event at `turn/start`. Ambiguous absent-run lookups retain up to 256 permanent admission fences in one bounded durable index; further distinct fences fail visibly instead of evicting authority, and Turn admission rechecks the index in its commit transaction. One exact stored-run decoder rejects invalid identifiers, missing admission data, unknown fields, inconsistent status-specific completion or failure fields, and every malformed discriminator-specific session event, including its normalized model request, before branching or persistence. Malformed durable state preserves the active-run marker for explicit repair rather than reopening admission. Recovery restarts only work that has not recorded an external effect intent, finalizes already-durable completion, and moves uncertain model or tool outcomes into durable reconciliation instead of duplicating the effect. If the selected provider cannot retrieve the original model effect, the run remains active, scheduled, and visibly `reconciliation-required`; recovery never calls the provider's streaming creation path again.

The Durable Object bindings remain authority, transactional storage, and scheduler hosts. Each gateway request and each resident User/Bot Durable Object owns one Cordis root that mounts every declared backend Contribution as a Plugin in compiled order; partial startup and explicit gateway teardown dispose that root. Durable Object eviction drops the resident root with its object, and backend Plugins retain no authority outside durable storage. `@frockbot/kernel-do` owns the Bot Durable Object authority: command admission, the append-only event log, the resumable execution cursor, idempotency records, cancellation, and durable scheduling. The Shell Package's declared Bot backend Contribution owns configuration policy, the hosted run projection, and the composition of the Packages a Turn runs on, and supplies them to the kernel authority through narrow injected hooks. The Bot Durable Object constructs the kernel authority and mounts the Package against it. Provider-neutral User Connection Contributions own Connection state and orchestration; the Ollama Cloud Package is the active account-scoped provider implementation, while Composio remains dormant and absent from the production application. Hosted Bot runtimes currently mount the declared Fly provider and provider-neutral Computer consumer before assigned Connection runtime Contributions, so browser and native shells observe one backend execution path. This direct mount is a known divergence from Bot-owned Cordis-root composition and is not corrected by the compatibility prototype; [ADR 0004](adr/0004-host-fly-computer-in-cloudflare-containers.md) records the accepted non-authoritative shared-host boundary for Fly Computer execution.

Bundling Bot-authored Package source into an immutable module runs outside the Durable Object, in the dedicated `apps/cloudflare-bundler` Worker reached through the `PACKAGE_BUNDLER` service binding. That Worker has no bindings at all: it accepts exactly one 256 KB `package.ts`, refuses a `package.json` and any surviving import specifier so Bot-authored text can never drive a network subrequest, and never throws across the binding — every rejection is a decoded `status: "failed"` result with diagnostics. It returns the module bytes and a content-addressed `ArtifactRefV1` rather than writing storage itself, so the Durable Object keeps ownership of the durable effect: it records its authorship intent, calls the bundler, then writes `packages/<contentHash>.mjs` to the artifact bucket, whose reader verifies the hash before the bytes are used.

A Composition member that carries an artifact is mounted in a Bot isolate rather than the kernel isolate. `BotIsolateContributionHost` in `@frockbot/kernel-composition` reads the hash-verified module from the artifact bucket, loads it through the Bot Durable Object's second `worker_loaders` binding `BOT_PACKAGES` with `globalOutbound: null`, a CPU and subrequest limit, and a two-entry module map — the kernel-generated wrapper `index.js` and the Package's `package.js` — and calls `health()` inside the same guarded phase, because `.get()` is lazy and a broken artifact only fails on the first RPC. The loader id is `bot-package:<userId>:<botId>:<hash>`, where the hash content-addresses the wrapper text, the Package artifact, and the digest of the Assignment-derived bindings together: a loader id is served from cache, so anything baked into the isolate must change the id or a stale isolate would keep answering. Each `health().tools` entry becomes one `ToolDefinition` whose `execute` RPCs into the isolate with a `deadlineMs` and a Durable-Object-side race, since an `AbortSignal` cannot cross the boundary. Bot code sees exactly two bindings: `IDENTITY`, a plain object, and `CAPABILITIES`, a loopback service binding minted with `ctx.exports.BotCapabilities({ props })` — an `RpcTarget` placed in a loaded Worker's `env` is rejected by workerd, so per-invocation narrowed objects are returned from the stub's methods instead. `list` is Assignment-derived, `requestAuthority` always records a durable pending decision and never grants, and `invokeModel` refuses with a pending decision unless an enabled model Assignment matches; when one does, the Bot Durable Object records the normalized request and streams the completion back through the mounted provider path as an NDJSON byte stream, the only stream shape workerd RPC carries. `verify()` surfaces an isolate member that failed to mount or answer `health()`; fail-closed activation on the last known-good generation is not yet implemented.

Cancellation uses an `AbortSignal` for the active turn and atomically appends `input/cancelled` for selected queued input. Teardown stops admission, cancels active work, waits for the driver and durability flush, detaches the agent, and only then detaches its session.

Before a restarted runtime accepts work, the session store scans for unmatched starts and execution intents. It appends interrupted `tool/result`, `step/end`, and `turn/end` events in dependency order and flushes them. Queued input that was never admitted remains eligible to run. Work after a durable `model/request` or `tool/call` is never retried automatically because the external side effect may have occurred; an explicit policy may retry only operations whose definition supplies an idempotency key and retry contract.

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

No side-effecting tool implementation runs before its `tool/call` intent is durable. A crash after the intent but before a result is reconciled as interrupted and is not silently repeated.

A tool definition declares whether calls may run concurrently, which resources they mutate, and whether it supports idempotent retry. The loop may use bounded parallelism only when definitions and policy allow it. Permission prompts and sandbox selection are plugins at the tool seam, not branches in the loop.

## Package model

A Package is the installable unit. A Contribution is one runtime-specific entry in that Package. A Plugin is the live Cordis instance created from a Contribution.

Manifest v3 backend Contributions declare their backend host explicitly. The hosted gateway, User Durable Object, and Bot Durable Object resolve the compiled entries into Plugins and mount them through the same owned Cordis-root lifecycle; adapters do not directly construct product Contributions. Provider routes, callback policy, and external-system coordinators stay in the owning Package. The gateway supplies authenticated User authority and platform context without branching on provider identity.

A Package manifest has a versioned FrockBot section that declares identity, compatibility, dependencies, permissions, and runtime Contributions. Manifest v3 may additionally declare bounded setting schemas, Connection Types, and Capabilities. Contributions are scoped to backend hosts, the Bot Agent runtime, the hosted client, the desktop shell, or the mobile shell.

`@frockbot/plugin-clock` is the reference Package for this contract. Its manifest declares one runtime Contribution that registers and invokes a `current_time` tool, one trusted desktop-main Contribution, and one hosted client Contribution that fills the shell's `frockbot.right-panel` slot. Each host activates only the Contribution kinds it owns.

`@frockbot/plugin-flock` is the built-in Bot lifecycle and visual-identity Package. Its gateway Contribution owns exact authenticated Bot directory and sheep routes; its User Contribution atomically admits bounded Bot registrations and replayable create receipts; its Bot Contribution materializes and updates durable sheep identity; and its hosted client Contribution owns the Bot list, creator, switcher, and picker in generic shell outlets. Package-owned 256px WebPs are inlined into the immutable hosted stylesheet, so browser and native shells render one same-origin asset path without runtime access to prototype artifacts.

One Package may contribute to several runtimes, but Cordis does not make that activation atomic. The Package catalog coordinates prepare, mount, commit, and rollback across roots. Disabling a Package first blocks new work, then drains and disposes Contributions in reverse dependency order.

Computer behavior is split across three modules. `@frockbot/computer-core` defines the provider registry, durable workspace, process, browser, viewer, and control interfaces. `@frockbot/plugin-computer` owns provider-neutral tools, prompt policy, reactive state, and the trusted viewer UI. Provider Packages register adapters; consumers resolve the selected provider using persistent User and Bot identity and never import provider SDKs.

[ADR 0011](adr/0011-minimal-kernel-and-self-modification.md), [ADR 0012](adr/0012-one-computer-per-user.md), and [ADR 0013](adr/0013-bidirectional-memory-sync.md) supersede the Computer and memory shape described in the next two paragraphs: one Computer per User shared by all Bots, a shared browser profile, Memory written only by the Memory Package and mirrored to the Workspace, and non-first-party Package code in Dynamic Worker isolates. The paragraphs below describe what is implemented today.

`@frockbot/plugin-fly-sprite` is the first Computer provider Package. It maps persistent Bot identity to a deterministic private workspace, Package-data directories, Chromium profile, X display, CDP port, VNC port, and `flock`-serialized takeover lease. Generic process and browser calls cross the Computer interface; memory uses the durable workspace interface and remains writable during human takeover. Each Bot receives a distinct Sprite; a separate non-viewer Sprite stores User-scoped Package files such as global memory. A Bot-local websockify `TokenFile` gateway routes opaque viewer tokens to loopback VNC ports. The Sprites token remains provider-local. Strong isolation depends on the provider's VM and network enforcement rather than Cordis or directory naming. Heartbeat loss re-shields the viewer, and expired leases can be atomically reclaimed after a crash.

Computer assignments are keyed by `botId`, not live `agentId`. A provider change increments an assignment generation so handles can reject stale work. Cloudflare memory retains its explicit R2 document adapter; desktop memory uses the selected Computer's workspace. Vector indexes are derived from canonical Markdown in either store.

## Configuration and Connections

The cloud gateway owns the authenticated production settings transport, decodes every User and Bot configuration view and receipt returned across Durable Object RPC seams, and rejects mutating API requests carrying an Origin other than the request origin or a configured native-client origin; production explicitly permits the two mobile shell origins `capacitor://localhost` and `frockbot://localhost`. `@frockbot/configuration-core` defines exact versioned User and Bot queries, commands, RPC authority envelopes, views, revisions, and receipts, including their nested profiles, models, Assignments, and dependency requirements. A Bot exists only after the Flock User Contribution registers it; arbitrary query parameters are selection hints and cannot create Bot state. Every Bot-scoped RPC proves directory membership before its Bot Durable Object writes identity, settings, run fences, notifications, or sheep state. The immutable registration seed snapshots its initial profile, model default, and legal sheep recipe; first use idempotently materializes those values without an external effect. Every exported RPC on the `UserConfiguration` and `BotState` Durable Objects and the `UserBotState` worker entrypoint accepts an exact v1 authority envelope and decodes caller-controlled values before mounting a Contribution or accessing durable state. The immutable Foundation application owns the User Contribution factory registry and dependency wiring; the User Durable Object supplies storage and a secret-reader capability without branching on concrete Package specifiers. Notification reads and acknowledgements validate durable identity through a read-only check, so observation cannot reconcile configuration or advance its revision. Declared gateway, User, and Bot backend Contributions own configuration policy, route shapes, and orchestration; the gateway and the Durable Objects provide their authenticated User authority, platform context, storage, scheduling, and narrow RPC adapters without branching on provider identity. The Settings Package's gateway Contribution owns the exact authenticated `/api/connections` and `/api/connection-commands` routes, and its User Contribution adjudicates which provider Package owns a Connection command from the durable Connection projection and the registered Connection command owners. Commands carry stable IDs and expected revisions, so duplicate delivery returns the existing receipt and stale writes fail explicitly. Connection command admission and hosted receipt lookup share one bounded public command-ID decoder, ensuring every admitted operation remains addressable by recovery.

Manifest v3 lets a Package declare bounded User/Bot setting schemas, Connection Types, and Capabilities. Manifest decoding rejects undeclared fields at every object boundary, along with remote schema references, excessive nesting, and oversized schemas. The hosted Plugins surface loads the immutable Package catalog during authenticated startup, derives provider presentation from Package catalog metadata, serializes Bot settings hydration after the catalog-backed User projection, preserves independent load failures, rejects disabled-Package model options, and accepts only the exact owned version of the application-manifest response before projecting those declarations; installing a Package records durable User availability but does not grant a Bot authority. Bot model onboarding claims the selected Connection dependency before atomically committing its Capability Assignment and exact provider model in one Bot command. New-Bot creation atomically records a pending dependency for the User's default model, snapshots the exact Assignment in the registration, and acknowledges it only after Bot Durable Object materialization commits and still retains that Assignment. Switching model Connections through either binding command records the exact enabled superseded model Assignment generation, durably acknowledges the replacement when needed, and releases only that model dependency before completing its saga. Superseded and same-Capability historical Assignments and generation records are removed during the atomic Bot transition, bounding repeated model switching, while an existing Assignment ID cannot change its Package Capability authority. Explicit model unbinding, including an unavailable current Assignment, atomically removes the model authority and durably releases its acknowledged Connection dependency before returning. Notification list and acknowledgement responses use exact shared v1 envelopes; `@frockbot/connection-core` owns provider-neutral Connection transport result contracts.

The Settings User Contribution owns durable User profile, package-installation, Connection projection, Assignment dependency coordination, and default-model state behind the versioned configuration interface. Assignment claims, sequence-fenced acknowledgements, acknowledged releases, and pending compensation are provider-neutral transactional mutations exposed through exact User Durable Object RPCs; a rejected acknowledgement compensates and releases its exact claim before the Bot saga terminalizes, and every terminal model switch releases its superseded dependency. Acknowledging a reassignment atomically releases the Bot's previous dependency for that Package Capability, and Connections with remaining dependents cannot be disconnected. Active Connections are bounded, and revoked projections are compacted when a replacement is created; the User Durable Object can still route a replay through the unique provider-owned retained command receipt after its Connection projection is gone. Flock reads a transaction-local snapshot from that Contribution when registering a Bot, so generic User authority does not depend on any external integration Package.

`@frockbot/plugin-credentials` owns the account-scoped encrypted credential store and the Bot-runtime lease opener; Shell passes only a secret-reader capability while provider Plugins receive opaque leases and never receive the keyring. Settings and public Connection DTOs contain only opaque generations and redacted descriptors; versioned AES-GCM envelopes are authenticated to account, Connection, Package, and credential generation, and keyring decoding uses an own-property-only null-prototype key map. Every provider operation that crosses credential custody, including staged-generation validation and model execution, acquires an idempotent, expiring lease keyed by its durable effect ID. Rotation atomically promotes a validated pending generation, admitted effects retain the old generation, and retired ciphertext is purged only after dependent leases settle. Each Connection credential generation owns a bounded expiry ledger that rejects delayed active- or pending-generation lease replay without consuming another Connection's capacity; discarding a pending generation sweeps its indexed expiry tombstones, and reaching one active generation's capacity requires rotating only that Connection. An account-wide paged recovery queue expires at most 64 leases per alarm and durably reschedules unfinished pages, while settlement verifies the account, Connection, and Package authority that issued the lease and clears a matching expiry tombstone when a delayed durable outcome arrives. Disconnect purges the active generation's expiry ledger when local custody ends. Production setup fails closed unless a generated keyring is durably stored before its only in-process copy is discarded.

`@frockbot/plugin-provider-ollama-cloud` contributes the Ollama account authorizer in the User Durable Object and the `ollama-cloud` LLM adapter in the Bot runtime. Each ready Connection owns an advisory normalized model catalog with durable generation, freshness, and refresh scheduling; oversized provider catalogs are deduplicated and truncated before bounded detail enrichment, refresh and disconnect terminal projection commits are transactionally sequenced, reconciliation-required revocation cannot be downgraded by a concurrent local disconnect, superseded refreshes return failed receipts, and each validation or catalog projection commits atomically with its durable credential-settlement cursor retained until settlement succeeds. A Bot model binding stores the exact Connection ID and provider model ID and is executable only while an enabled matching model Capability Assignment grants authority to that Connection; the hosted ready projection applies the same declared-capability check. Runtime construction rejects unavailable bindings and provider IDs inconsistent with the selected Package runtime, mounts the selected provider Package, and records Connection and catalog generations in normalized model requests. Catalog absence triggers exact provider resolution rather than fallback. The hosted client reconciles ambiguous credential rotations through an authenticated durable command-receipt lookup before reusing an operation identity, so a lost response cannot revive an older rotation. Admission bounds pending commands at 64, recovery alarms resume at most one pending command and refresh at most one due Connection per invocation, and remaining work is durably rescheduled. Validation and catalog commands durably declare their safe metadata-read retry policy before provider access; exact model resolution additionally journals pending and terminal outcomes before lease settlement, so recovery either reuses an outcome or knowingly retries a side-effect-free metadata read. Manual command fingerprints and receipts are retained in 256 detailed records plus 128 compact tombstones so delayed duplicate delivery cannot repeat an effect; admission fails visibly when the bounded permanent history is full. Disconnect atomically terminalizes pending create and rotation commands, discards their staged generations, removes active local custody, and projects credentials as unconfigured. Ollama cannot retrieve an uncertain provider response, so automatic recovery preserves that run for an authenticated user decision; an explicit reconciliation attempt that remains uncertain terminalizes the run as failed and releases the Bot for later Turns. Credential settlement routes through the owning provider Contribution so primary, exact-resolution, validation, and catalog lease obligations remain provider-owned. Provider credentials and Ollama wire types never enter the generic Agent loop.

Composio is temporarily absent from the compiled foundation application and production dependency graph while its integration is redesigned around Composio Connect MCP. The dormant package source is not mounted, advertised, configured, or bundled by the hosted production path; CI and the setup wizard require and forward no Composio credentials. Reintroduction requires a complete backend-owned Connection and Agent-runtime vertical slice rather than a second product path.

Bot admission, Agent execution, session-event persistence, recovery alarms, and runtime reconstruction now run in the Bot Durable Object. Session persistence is asynchronous internally but exposes an explicit flush seam; the Agent loop flushes admission, `model/request`, `tool/call`, assistant completion, and terminal events before crossing their relevant effect or completion boundaries. A durably committed assistant or no-effect event remains the settlement cursor: settlement failure keeps the Turn resumable, and recovery preserves the current snapshot-authorized assigned runtime Packages while reconstructing that already-admitted provider from its durable request binding, independent of later Package disablement, until it idempotently settles the model lease and any derived exact-resolution lease. A Bot with notifications enabled records a durable notification intent before any browser or mobile adapter displays it; unacknowledged intents replay after disconnect, and adapters acknowledge only after display or when the visible conversation already delivered the result.

## Trust model

| Trust tier              | Desktop contribution                 | Backend contribution                                 | WebUI contribution                                          |
| ----------------------- | ------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------- |
| Built-in                | Electron main or preload adapter     | Bot or User Durable Object runtime                   | Direct hosted client plugin                                 |
| Reviewed third-party    | Separate host process where possible | Dedicated runtime/container according to permissions | Direct only when explicitly trusted; otherwise sandbox view |
| Generated or unreviewed | Never                                | Quarantine process/container only                    | Sandbox view only                                           |

A permission manifest improves review and routing but is not enforcement. Enforcement requires the selected process, container, operating-system, credential-broker, and frame policies to deny undeclared actions.

Cordis `ctx.isolate()` is not used as a security boundary. Until upstream issue #72 is resolved or excluded by a regression test, FrockBot also avoids relying on bare isolated-context disposal for critical ownership.

## Repository shape

The current workspace separates hosted applications, backend runtime composition, platform shells, and shared Plugin contracts:

```text
apps/
  cloudflare/              Hosted application gateway and Durable Object adapters
  cloudflare-bundler/      Package bundler Worker (no bindings, no egress)
  desktop/                 Electron hosted-window shell and platform adapters
  mobile/                  Hosted mobile shell and platform adapters
  agent-runtime/           Transport-neutral backend Agent composition
packages/
  kernel-contracts/        Session, model, prompt, and tool execution contracts
  kernel-agent-loop/       Concrete durable loop provider and Agent registry
  kernel-composition/      Package manifest, activation coordinator, and compiler
  kernel-do/               Bot Durable Object admission, log, cursor, and scheduling
  plugin-tools/            Tool registry Package
  plugin-models/           Model provider registry Package
  plugin-prompt/           System-prompt registry Package
  agent-core/              Re-export barrel over the kernel and registry Packages
  configuration-core/      Versioned settings and Connection projections
  connection-core/         Credential, catalog, and Connection command DTOs
  plugin-catalog/          Re-export shim over kernel-composition
  plugin-credentials/      Encrypted account credential records and leases
  plugin-shell/            Hosted Vue shell and backend shell Contributions
  plugin-*/                First-party feature and provider Packages
  protocol/                Versioned cross-runtime DTOs and decoders
```

Package boundaries may be consolidated when two modules do not vary independently. The definitions/providers/consumers dependency rule matters more than maximizing workspace count.

## Startup and execution sequence

1. The browser loads the hosted application directly, or Electron validates the configured application origin before creating its sandboxed hosted window.
2. The hosted client authenticates against the configured auth origin and exchanges only versioned DTOs with the Cloudflare gateway.
3. The gateway routes User configuration work to the User Durable Object and Bot work to the selected Bot Durable Object.
4. Each Durable Object mounts declared backend Contributions in its host-owned runtime context.
5. The Bot host durably admits a Turn before its Agent-loop Plugin crosses a model or tool effect boundary.
6. Browser and native observers project the same durable run and session state; disconnecting an observer does not cancel the Turn.
7. Native authentication handoff, deep links, notifications, clipboard, and file selection remain optional enhancements at decoded platform seams.

## Validation gates

The production composition is accepted only when automated tests demonstrate:

- one resolved copy of every pinned Cordis/WebUI package;
- exact-once Plugin setup and cleanup across repeated runtime reconstruction;
- pending activation and recovery when dependencies appear or disappear;
- admitted work surviving client shutdown and Durable Object reconstruction;
- hosted API authentication, DTO decoding, and origin rejection;
- WebUI operation with Node integration disabled;
- durable replay reproducing the exact normalized model request and visible chat output;
- every started step and turn receiving exactly one typed ending;
- side-effecting tools being journaled before execution and never implicitly retried after interruption;
- recovery resuming completed model journals while retaining genuinely uncertain effects for reconciliation;
- explicit authenticated cancellation leaving no unmatched tool call or open turn;
- package activation rollback after failure in any contribution;
- packaged Electron startup without Bun installed and clear failure when required hosted configuration is absent.

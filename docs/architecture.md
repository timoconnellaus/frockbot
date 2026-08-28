# FrockBot Architecture

## Status

Accepted direction. The pinned foundation proof, first custom event-sourced agent loop, and Cordis WebUI/Vue product slice pass end to end.

## Decision summary

FrockBot is a Cordis-first application. Every capability beyond a deliberately small process bootstrap is mounted as a Cordis plugin. FrockBot owns a custom agent loop, uses pinned upstream Cordis rather than the DeepSeek Harness fork, and uses Cordis WebUI with Vue for the desktop interface.

The original Pi-backed React prototype remains available at Git commit `0d5a41e` as a rollback point. The current application has cut over to the custom Cordis runtime and Cordis WebUI after reaching prompt, streaming, tool, cancellation, restart, and screenshot-smoke parity.

Exact upstream pins and compatibility risks are recorded in [`research/cordis-foundation.md`](./research/cordis-foundation.md).

## Architectural principles

1. **Everything beyond bootstrap is a plugin.** Process entry, root-context creation, and last-resort crash reporting form the boot kernel. Transport bridge plugins own protocol decoding. Product behavior does not.
2. **A context is process-local.** Electron main, the agent utility process, and the WebUI renderer each own an independent Cordis root. Cordis services are never transparently proxied across a process seam.
3. **Cross-process communication is explicit.** Narrow, versioned DTOs cross Electron IPC, `MessagePort`, HTTP, or WebSocket transports. Every inbound value is decoded at the seam.
4. **Definitions are separate from providers and consumers.** Contract packages declare stable service interfaces and events. Provider plugins implement them. Consumer plugins depend only on definitions.
5. **The session log is authoritative.** Every model-visible fact and every fact required for UI replay is represented by a durable session event.
6. **Ownership is structural.** Every plugin-owned listener, timer, process, socket, registration, and agent has one disposal path. Reload and shutdown wait for quiescence.
7. **Isolation is not security.** Cordis contexts and `ctx.isolate()` alter service resolution, not OS authority. Process, container, and frame boundaries enforce trust.
8. **Published artifacts are pinned.** FrockBot tests the exact npm tarballs recorded in `bun.lock`; repository `main` is not treated as evidence for shipped behavior.

## Process topology

```text
Electron main process
┌─────────────────────────────────────────────────────────┐
│ Minimal bootstrap                                       │
│   └── Desktop Cordis root                               │
│       ├── package-catalog plugin                        │
│       ├── process-supervisor plugin                     │
│       ├── desktop-window plugin                         │
│       ├── server plugin                                 │
│       ├── WebUI host plugin                             │
│       └── desktop-runtime bridge plugin                 │
└──────────────────────────┬──────────────────────────────┘
                           │ typed MessagePort protocol
                           ▼
Electron utility process
┌─────────────────────────────────────────────────────────┐
│ Minimal bootstrap                                       │
│   └── Agent Cordis root                                 │
│       ├── session-store provider                        │
│       ├── system-prompt registry                        │
│       ├── LLM registry + provider plugins               │
│       ├── tool registry + tool plugins                  │
│       ├── agent registry                                │
│       ├── concrete agent-loop provider                  │
│       └── runtime bridge plugin                         │
└─────────────────────────────────────────────────────────┘

Sandboxed Electron renderer
┌─────────────────────────────────────────────────────────┐
│ Cordis WebUI client root + Vue                          │
│   ├── FrockBot shell plugin                             │
│   ├── bot-list plugin                                   │
│   ├── conversation plugin                               │
│   ├── computer plugin                                   │
│   ├── routines plugin                                   │
│   └── package-manager plugin                            │
└─────────────────────────────────────────────────────────┘
```

The WebUI server binds to loopback on an ephemeral port. The desktop window receives an unguessable per-launch credential, and both HTTP and WebSocket admission validate it. The server rejects arbitrary origins. Production CSP allows only the application origin, its authenticated WebSocket endpoint, and `data:` fonts for the brand typefaces inlined into the client bundle.

## Boot kernel

Each process entry may do only the following before loading its root bundle:

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
| Vue             | `vue`                     | `3.5.33`     |
| Vite            | `vite`                    | `7.3.2`      |
| Vue Vite plugin | `@vitejs/plugin-vue`      | `6.0.6`      |

`@cordisjs/schema` is prohibited because it belongs to the Cordis 3 package topology. `schemastery` is added only where a FrockBot package directly authors a compatible schema.

FrockBot wraps dynamic loader mutation behind its own package-catalog interface. Product modules must not directly edit loader rows. This localizes release-candidate churn and gives package activation one transactional coordinator.

The wrapper does not equate a resolved loader write with successful activation. With loader rc.5, a failed dynamic import is logged and can leave an entry without a fiber rather than reject the write; configuration updates also require awaiting the affected entry fiber, not only `loader.await()`. The wrapper verifies that a fiber exists, awaits that exact fiber, checks its final state, and rolls back otherwise.

FrockBot plugin factories use arrow functions or explicit `{ apply }` objects. Constructible function declarations are avoided because Cordis intentionally interprets constructible callbacks as plugin classes; a function declaration can therefore run as a constructor and lose its returned disposer.

Cordis services expose context-specific proxy objects that inherit from the provider instance. Service state therefore uses ordinary TypeScript-private properties or external state, never ECMAScript `#private` fields, which reject proxy receivers. Every consumer plugin explicitly declares its injected services; ambient service access is treated as an error.

## Module map

### Desktop host

**Package catalog** owns installed package metadata, enabled versions, contribution declarations, provenance, and activation state. It coordinates activation across processes and rolls back already-mounted contributions when a later contribution fails.

**Process supervisor** owns the agent utility process, handshake, health, restart policy, and graceful shutdown. A restarted process receives the currently enabled agent contribution set before accepting work.

**Desktop window** owns Electron windows, navigation policy, CSP, and application lifecycle integration. Other plugins request windows through its interface rather than importing Electron.

**WebUI host** mounts the Cordis server and WebUI plugins, authenticates local transport, and publishes trusted WebUI entries.

**Runtime bridge** translates desktop commands into the agent protocol and projects runtime events back into WebUI services.

### Agent runtime

**Session store** owns append-only session events, atomic event batches, interrupted-work reconciliation, and model-history derivation. It persists the exact normalized request sent to each model after all prompt, schema, provider, and request middleware has run. In-memory storage is the first adapter; persistence is a second adapter added through the same interface.

**System-prompt registry** accepts scoped prompt sections, variables, and tool-schema presentation. It assembles a prompt for one proposed step.

**LLM registry** selects a provider adapter and streams normalized response chunks. A separate optional reconciliation capability retrieves an original result by its durable provider effect ID; adapters without a provider-guaranteed retrieval path return reconciliation unavailable. Provider SDK choice is internal to each adapter and does not enter the agent-loop interface. The generic `@frockbot/provider-openai-compatible` adapter normalizes messages and tools, parses streamed SSE text and fragmented tool calls, bounds HTTP errors, and receives credentials only inside the utility process, but does not claim idempotency or repeat an uncertain request.

**Tool registry** owns tool definitions, per-agent visibility, input decoding, execution policy, and result finalization.

**Agent registry** exposes live agents, creation and disposal, inbox delivery, cancellation, status, and live agent events. Consumers do not import the concrete loop.

**Agent-loop provider** is the only module containing the concrete model/tool repetition algorithm. It registers as the agent factory and depends on sessions, prompts, LLMs, tools, and the agent registry.

### WebUI

The browser uses the Cordis WebUI client root and Vue. First-party and reviewed UI contributions mount as ordinary client plugins. The FrockBot shell provides stable slots and routes; feature plugins register into them rather than editing the shell. Brand typography is shared as one same-origin stylesheet, `@frockbot/client-core/fonts.css`, imported by every client entrypoint so hosted, desktop, and mobile shells render the same faces without an external font request.

Direct client plugins are trusted same-origin code. Untrusted or generated rich UI cannot be imported into the WebUI context. It must use a FrockBot sandbox-view contribution rendered in a separately permissioned frame with a narrow message protocol.

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

Bot Durable Objects persist the admitted configuration snapshot and execution phase with each run. Recovery restarts only work that has not recorded an external effect intent, finalizes already-durable completion, and moves uncertain model or tool outcomes into durable reconciliation instead of duplicating the effect. If the selected provider cannot retrieve the original model effect, the run remains active, scheduled, and visibly `reconciliation-required`; recovery never calls the provider's streaming creation path again.

The Durable Object bindings remain authority, transactional storage, and scheduler hosts. The shell's declared Bot backend Contribution owns admission, configuration, recovery, and runtime composition; Composio's declared backend Contribution owns the User Connection state machine and provider orchestration. Hosted Bot runtimes mount the declared Fly provider and provider-neutral Computer consumer before assigned Connection runtime Contributions, so browser and native shells observe one backend execution path.

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

A Package is the installable unit. A Contribution is one process-specific entry in that package. A Plugin is the live Cordis instance created from a contribution.

Manifest v3 backend Contributions declare their backend host explicitly. The hosted gateway mounts their narrow route handlers from the compiled application plan; provider routes, callback policy, and external-system coordinators stay in the owning Package. The gateway supplies authenticated User authority and platform context without branching on provider identity.

A package manifest has a versioned FrockBot section that can declare:

```text
identity and version
provenance and integrity
minimum FrockBot version
desktop contributions
agent contributions
trusted WebUI contributions
sandbox-view contributions
requested permissions
configuration schema
```

`@frockbot/plugin-clock` is the reference package for this contract. Its manifest declares one agent contribution that registers and invokes a `current_time` tool, one desktop contribution that publishes reactive state and RPC, and one built Cordis WebUI contribution that fills the shell's `frockbot.right-panel` slot. Each process installs the same decoded manifest into its scoped package catalog and activates only the contribution kinds it owns; the desktop contribution currently owns publication of the corresponding WebUI entry.

One package may contribute to several processes, but Cordis does not make that activation atomic. The package catalog coordinates prepare, mount, commit, and rollback across roots. Disabling a package first blocks new work, then drains and disposes contributions in reverse dependency order.

Computer behavior is split across three modules. `@frockbot/computer-core` defines the provider registry, durable workspace, process, browser, viewer, and control interfaces. `@frockbot/plugin-computer` owns provider-neutral tools, prompt policy, reactive state, and the trusted viewer UI. Provider Packages register adapters; consumers resolve the selected provider using persistent User and Bot identity and never import provider SDKs.

`@frockbot/plugin-fly-sprite` is the first Computer provider Package. It maps persistent Bot identity to a deterministic private workspace, Package-data directories, Chromium profile, X display, CDP port, VNC port, and `flock`-serialized takeover lease. Generic process and browser calls cross the Computer interface; memory uses the durable workspace interface and remains writable during human takeover. Each Bot receives a distinct Sprite; a separate non-viewer Sprite stores User-scoped Package files such as global memory. A Bot-local websockify `TokenFile` gateway routes opaque viewer tokens to loopback VNC ports. The Sprites token remains provider-local. Strong isolation depends on the provider's VM and network enforcement rather than Cordis or directory naming. Heartbeat loss re-shields the viewer, and expired leases can be atomically reclaimed after a crash.

Computer assignments are keyed by `botId`, not live `agentId`. A provider change increments an assignment generation so handles can reject stale work. Cloudflare memory retains its explicit R2 document adapter; desktop memory uses the selected Computer's workspace. Vector indexes are derived from canonical Markdown in either store.

## Configuration and Connections

The cloud gateway owns the authenticated production settings transport. `@frockbot/configuration-core` defines versioned User and Bot queries, commands, RPC authority envelopes, views, revisions, and receipts. Declared User and Bot backend Contributions decode those envelopes and own configuration policy and orchestration; `UserConfiguration` and `BotState` Durable Objects provide their authority, storage, scheduling, and narrow RPC adapters. Commands carry stable IDs and expected revisions, so duplicate delivery returns the existing receipt and stale writes fail explicitly.

Manifest v3 lets a Package declare bounded User/Bot setting schemas, Connection Types, and Capabilities. Remote schema references, excessive nesting, and oversized schemas are rejected at manifest decoding. The hosted Plugins surface projects those declarations from the immutable application manifest; installing a Package records durable User availability but does not grant a Bot authority.

`@frockbot/plugin-composio` is the first Connection Package. FrockBot records a durable User-owned Connection intent before asking Composio for a hosted Connect Link and uses the Connection ID as the provider alias so a lost response can be reconciled by a read instead of repeating the effect. Composio retains and refreshes external OAuth credentials; FrockBot keeps only safe metadata and opaque connected-account identifiers. Provider verification and the signed callback transition the Connection to ready in one conditional User Durable Object transaction without identifying or granting a Bot. A separate authenticated `bot/assign-capability` command validates the installed Package, declared Capability, and matching ready Connection Type before it claims a dependency and writes a receipt-backed Bot Assignment. Invalid assignments produce durable rejected receipts without changing Bot settings or Connection dependencies. Revocation derives Bot invalidation only from acknowledged explicit Assignment dependencies; historical metadata is considered only when it contains an exact assignment generation. It claims the Connection, records provider completion, retries failed invalidation by alarm, and automatically finalizes revoked only after every matching compensation is acknowledged. Alarms always schedule the earliest stored deadline, while retries preserve which operation needs reconciliation; uncertain provider outcomes are inspected but never automatically repeated. The hosted browser exposes this two-step authorization and assignment flow; mobile hides the Plugins control until its native OAuth/deep-link return adapter is implemented, rather than presenting a connection flow that cannot complete with bearer-token authentication.

A ready Composio Assignment reconstructs a Bot-local runtime Plugin exposing `composio_search_tools` and `composio_execute_tool`. The Agent must search for an exact provider tool slug before execution. As with every tool, the Bot session flushes `tool/call` intent durably before external execution. The Composio project key remains a gateway/Durable Object secret and never enters a client DTO, application artifact, or session event.

Bot admission, Agent execution, session-event persistence, recovery alarms, and runtime reconstruction now run in the Bot Durable Object. Session persistence is asynchronous internally but exposes an explicit flush seam; the Agent loop flushes admission, `model/request`, `tool/call`, assistant completion, and terminal events before crossing their relevant effect or completion boundaries. A Bot with notifications enabled records a durable notification intent before any browser or mobile adapter displays it; unacknowledged intents replay after disconnect, and adapters acknowledge only after display or when the visible conversation already delivered the result.

## Trust model

| Trust tier              | Desktop contribution                 | Agent contribution                                   | WebUI contribution                                          |
| ----------------------- | ------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------- |
| Built-in                | Electron main                        | Agent utility process                                | Direct WebUI client plugin                                  |
| Reviewed third-party    | Separate host process where possible | Dedicated runtime/container according to permissions | Direct only when explicitly trusted; otherwise sandbox view |
| Generated or unreviewed | Never                                | Quarantine process/container only                    | Sandbox view only                                           |

A permission manifest improves review and routing but is not enforcement. Enforcement requires the selected process, container, operating-system, credential-broker, and frame policies to deny undeclared actions.

Cordis `ctx.isolate()` is not used as a security boundary. Until upstream issue #72 is resolved or excluded by a regression test, FrockBot also avoids relying on bare isolated-context disposal for critical ownership.

## Repository direction

The target workspace shape is:

```text
apps/
  desktop/                 Electron bootstrap and desktop root bundle
  agent-runtime/           Utility-process bootstrap and agent root bundle
packages/
  protocol/                Cross-process DTOs and decoders
  core-session/            Session definition and default provider
  core-system-prompt/      Prompt registry
  core-llm/                LLM definition and registry
  core-tools/              Tool definition and registry
  core-agent/              Agent definition and registry
  core-agent-loop/         Concrete loop provider
  plugin-catalog/          Package manifest and activation coordinator
  webui-shell/             FrockBot Vue shell and stable contribution slots
  plugins/                 First-party feature/provider plugins
```

Package boundaries may be consolidated when two modules do not vary independently. The definitions/providers/consumers dependency rule matters more than maximizing workspace count.

## Implementation sequence

1. Prove the exact pinned Cordis packages under Bun and Electron.
2. Prove plugin mount, pending dependency, disposal, and reload in main and utility processes.
3. Prove Cordis server plus WebUI/client startup in a sandboxed Electron window.
4. Introduce session, LLM, tools, agent, and loop definitions with in-memory adapters.
5. Complete one streaming turn without tools.
6. Add one reference tool and the guarded repetition loop.
7. Add cancellation, process restart, and session replay.
8. Rebuild the current FrockBot interface as WebUI feature plugins.
9. Add the package catalog and one package spanning agent and WebUI contributions.
10. Cut over from the Pi prototype after parity and remove React/Pi dependencies.

## Validation gates

The Cordis foundation is accepted only when automated tests demonstrate:

- one resolved copy of every pinned Cordis/WebUI package;
- exact-once plugin setup and cleanup across repeated reloads;
- pending activation and recovery when dependencies appear or disappear;
- agent utility-process shutdown with no admitted work after disposal begins;
- loopback HTTP/WebSocket authentication and origin rejection;
- WebUI operation with Node integration disabled;
- durable replay reproducing the exact normalized model request and visible chat output;
- every started step and turn receiving exactly one typed ending;
- side-effecting tools being journaled before execution and never implicitly retried after interruption;
- restart reconciliation closing unmatched model, tool, step, and turn work before admission resumes;
- cancellation leaving no unmatched tool call or open turn;
- package activation rollback after failure in any contribution;
- packaged Electron startup without Bun installed.

# FrockBot Architecture

Paths are relative to the repository root.

---

## 1. Deployables

Four Workers, one container image, one Flutter app.

| Deployable                | Worker name                   | Config                                   | Serves                                                                                                                                                                                                            |
| ------------------------- | ----------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cloudflare`         | `frockbot-cloudflare`         | `apps/cloudflare/wrangler.jsonc`         | The product. Custom domains `bot.frockbot.com` and `ui.bot.frockbot.com`. `main: src/index.ts`, compatibility date `2026-08-27`, flag `nodejs_compat`.                                                            |
| `apps/cloudflare-bundler` | `frockbot-cloudflare-bundler` | `apps/cloudflare-bundler/wrangler.jsonc` | One RPC method, `PackageBundler.bundle()` (`apps/cloudflare-bundler/src/index.ts:13`). No bindings, no routes.                                                                                                    |
| `apps/computer-host`      | `frockbot-computer-host`      | `apps/computer-host/wrangler.jsonc`      | No routes; reached only through the app's `COMPUTER_HOST` service binding. Fronts a Cloudflare Container built from `apps/computer-host/Dockerfile` (`node:24-slim`, `instance_type: basic`, `max_instances: 3`). |
| `apps/marketing`          | `frockbot-marketing`          | `apps/marketing/wrangler.jsonc`          | `frockbot.com` and `www.frockbot.com`. Static `ASSETS` from `./public` with `run_worker_first: true`; the Worker is a canonical-host redirect plus security headers (`apps/marketing/src/index.ts:1-31`).         |
| `apps/native`             | `frockbot_native`             | `apps/native/pubspec.yaml`               | Flutter, Android and macOS. Not deployed by CI.                                                                                                                                                                   |

Named environments on the app Worker (`apps/cloudflare/wrangler.jsonc`):

- `development` (:159)
- `staging` (:269) — `frockbot-cloudflare-staging`, routes `staging-bot.frockbot.com` and `ui.staging-bot.frockbot.com`
- `e2e` (:386) — `"routes": []`, never deployed

Not deployed, though they carry wrangler configs: `packages/compose-cloudflare/wrangler.jsonc` and `packages/compose-typescript/wrangler.jsonc` (test fixtures, compatibility date `2026-05-01`), and `apps/cloudflare/e2e/frock-ai-fake.wrangler.jsonc` (bound as a service by the `e2e` env, run from the local wrangler dev registry).

`apps/agent-runtime` is a library consumed by `apps/cloudflare/src/bot-state.ts` and `packages/plugin-shell`. It is not a deployable.

No Fly configuration exists in the repository. Fly Sprites are rented at runtime over the Sprites HTTP API.

Deploy paths:

- `.github/workflows/ci.yml:367` `deploy-staging` — on push to `main`, deploys the app Worker to `staging`.
- `.github/workflows/release.yml` — on tag `v*.*.*`, deploys marketing (:255), the bundler (:469), the computer host (:478) and the app Worker (:307).

---

## 2. Durable Objects

Five classes in the app Worker, exported from `apps/cloudflare/src/index.ts:196-203`. `packages/kernel-do` defines no Durable Object class; it is the storage and authority library `BotState` delegates to.

### `BotState` — `apps/cloudflare/src/bot-state.ts:369`

- Binding `BOT_STATES`; id `idFromName("<userId>:<botId>")` (`apps/cloudflare/src/index.ts:456`, `:571`).
- Authoritative for all Bot-scoped state: identity, runs, admission fences, the pending and agent-lane queues, the session event log, notifications, conversations, Composition generations and pointers, Workspace file generations and conflicts, the memory vector purge journal. Keys are enumerated in `packages/kernel-do/src/storage-keys.ts:1-177`.
- Storage is key-value only — `ctx.storage.get/put/list/delete/transaction`. The class contains no `sql.exec`.
- Roughly 90 RPC methods (`bot-state.ts:920-2350`), each taking `input: unknown` and decoding through an envelope decoder. They include `run`/`runAgent`, the `isolate*` loopback surface, Composition reads and reverts, routines, tasks, approvals, notifications, `debugSnapshot` and `fenceRunAdmission`.
- `alarm()` at `:2359` drains the memory purge journal, then the mounted contribution's alarm, then the audit, usage and voice outboxes.
- `fetch()` at `:2420` serves one path: the state-channel WebSocket upgrade. Sockets use the hibernation API — `state.acceptWebSocket(server, [CHANNEL_TAG])` (`apps/cloudflare/src/bot-state-channel.ts:622`), with `webSocketMessage/Close/Error` forwarded from `bot-state.ts:2447-2466`.

### `UserConfiguration` — `apps/cloudflare/src/user-configuration.ts:221`

- Binding `USER_CONFIGURATIONS`; id `idFromName(userId)`.
- The only class that uses SQLite, and it does not own the tables. `ctx.storage.sql` is handed to three plugin stores: transcript search FTS5 (`packages/plugin-search/src/index-store.ts:143-177`), audit (`packages/plugin-audit/src/store.ts:166-175`), billing (`packages/plugin-billing/src/store.ts:91-114`). All other state is key-value.
- One `alarm()` at `:1739` serving credential leases, publisher and template recovery, flock sagas and archived-Bot sweeps.
- No `fetch()`, no WebSockets.

### `AppletState` — `apps/cloudflare/src/applet-state.ts:228`

- Binding `APPLET_STATES`; id `idFromName("<userId>:<appletId>")` (`packages/kernel-do/src/applets.ts:139`).
- Authoritative for one Applet instance's generation history, pointers, failures, mount input and trial record. Key-value storage.
- The Applet's own code and data live in a facet mounted from an R2 artifact through the `APPLETS` Worker Loader (`:245-289`).
- `fetch()` at `:872` forwards the Applet socket upgrade into the facet. `alarm()` at `:924` is scheduled only through `holdAlarmForFacet` (`:913`), because facets cannot set their own alarms.
- `AppletCapabilities` (`:182`) is a `WorkerEntrypoint`, not a Durable Object.

### `VoiceSession` — `apps/cloudflare/src/voice-session.ts:185`

- Binding `VOICE_SESSIONS`; id `idFromName(userId)`.
- Holds no durable state; the class contains no `ctx.storage` calls. Voice budget lives in `UserConfiguration`.
- Mixed socket model: dictation uses `server.accept()` (`:256`, not hibernatable); the assistant uses `ctx.acceptWebSocket(server, ["assistant"])` (`:299`) with attachment-based restore (`:518`). Upstream provider sockets use `accept()` (`:1227`).
- One RPC, `deliverVoiceAnswer` (`:911`). No alarm.

### `DeploymentPolicy` — `apps/cloudflare/src/deployment-policy.ts:23`

- Binding `DEPLOYMENT_POLICY`; singleton `getByName("frockbot-deployment-policy")` (`apps/cloudflare/src/index.ts:642`).
- One key, `deployment:policy:v1`, holding the signups-open flag under revision compare-and-swap. Two RPCs. No fetch, no alarm.

### In `apps/computer-host`

- `FlyHostContainer` — `apps/computer-host/src/index.ts:63`, `extends Container`, bound as both `COMPUTER_HOST_CONTAINER` and `FLY_HOST`.
- `ComputerEffectJournal` — `apps/computer-host/src/effect-journal.ts:46`. A plain class, not a `DurableObject` subclass. One `effect` key implementing claim, collision and unresolved idempotency.

---

## 3. Request path: one user message

1. **Client.** `packages/plugin-shell/src/client/FrockBotApp.vue` posts `{schemaVersion, commandId, text}` to `POST /api/bots/{botId}/turns`.

2. **Gateway.** `apps/cloudflare/src/gateway.ts`, the Worker's `fetch`. Order of dispatch in `createGateway` (`:706`): client-compatibility refusal, native-auth routes, `/api/auth/*` to better-auth, the Applet socket, the workspace seed, `/sign-out`, the debug route, public Package routes, then identity resolution — native bearer token, development identity, or a better-auth session — then the signup admission check (`:801-830`), then authenticated Package backend contributions.

3. **Per-user application isolate.** Unmatched requests fall through to `routeUserApplication` (`:612`). It resolves the user's `applicationHash`, then `dependencies.loader.get(workerId, ...)` loads that artifact from R2 into a Worker Loader isolate whose `env` holds `BOT_STATE` — a Durable Object stub already scoped to the user — plus `DEPLOYMENT` (`:633-646`). The client's `x-frockbot-user-id` header is deleted before forwarding (`:650`); the gateway sets `x-frockbot-deployment`, `x-frockbot-auth-session-v1` and `x-frockbot-is-admin-v1` itself. Authorization is established here and passed downward as capability; nothing below re-verifies it.

4. **Application.** `apps/cloudflare/src/user-application.ts:775` matches the turn route; `:1188` calls `env.BOT_STATE.run({schemaVersion, botId, command: {runId: commandId, sessionId: "<userId>:<botId>", acceptedAt, text, skills?, supersedes?}})`. The session id is derived server-side. The command decoder accepts exact keys only, so a client cannot name a turn type; an absent turn type means `chat`.

5. **Bot Durable Object.** `apps/cloudflare/src/bot-state.ts:1168` `run()` decodes the envelope, materializes the identity and calls `shell.run(...)`.

6. **Shell.** `packages/plugin-shell/src/backend.ts:1255` yields any in-flight compaction, calls `followDeploymentComposition()` and `resolveAppletComposition()`, then delegates to `BotDurableAuthority.run` (`packages/kernel-do/src/authority.ts:293`): recover whatever the object holds, check for a settled replay, then `acceptRun`. An accepted run executes inline; otherwise it is durably queued — one user-lane slot, FIFO agent lane — and promoted by `runQueuedRun` (`:332`).

7. **Mount.** `activateCompositionV1` reads the pin and builds a Cordis root for the Turn through `createShellCompositionHost` (`packages/plugin-shell/src/backend-composition.ts:274`).

8. **Loop.** `executeResidentBotTurn` (`packages/plugin-shell/src/backend-runner.ts:431`) calls `runtime.execute(...)`, then `agent.send({text, skills})` and awaits `whenIdle()`.

9. **Model.** Inside the loop, `ctx.llm.stream(request, signal)` dispatches to a provider, which issues the HTTP request (§7).

10. **Tools.** `ctx.tools.prepare` then `ctx.tools.executePrepared`.

11. **Return.** The POST returns the settled turn. Live updates arrive on a separate WebSocket, `GET /api/bots/{botId}/state-channel?version=1&cursor=N` (`apps/cloudflare/src/gateway.ts:894`). That channel carries invalidation notices, not content; the client re-reads over REST. Notices are coalesced and throttled per interval (`apps/cloudflare/src/bot-state-channel.ts:245-265`).

---

## 4. Agent loop — `packages/kernel-agent-loop/`

The Turn's state machine lives in `src/index.ts`; the external work it dispatches lives beside it, reached through the `LoopRuntime` seam in `src/runtime.ts`. `src/model-request.ts` owns provider dispatch and stream consumption, `src/tool-execution.ts` tool calls, `src/resume.ts` the replay of a durable log, `src/errors.ts` the classified failures.

### At-most-once by idempotency key

Every external effect that matters carries a key, and is retried **by that key** rather than investigated afterwards.

- A model call's key is its `NormalizedModelRequest.requestId`. A retry, and a re-issue after the object was evicted, send the same request object under the same id.
- A tool call's key is its `occurrenceId`, derived from the Turn, the step and the call's position, and handed to the tool as `ToolExecutionContext.effectId`.

The loop never asks a provider what became of a call it lost. It sends the call again. A provider that honours the key answers once; one that does not may run it twice, and that is the accepted trade — reconstructing the history of a lost dispatch is what used to wedge a Bot behind a question nobody could answer.

`admitEffect({kind, effectId})` still runs immediately before every dispatch, including a re-issue. Admissions are recorded per effect id, so re-admitting an effect returns its earlier outcome and a Stop or a supersede still fences a call the evicted Turn had already started.

### Turn lifecycle — `#runTurn`

Appends `turn/start`, `composition/pinned`, `turn/admission` and `input/admitted` as one batch, shifts the inbox before the flush, then runs through `#driveTurn`, which owns the deadline, the failure classification and the settlement. The body iterates `step = 1..maxSteps`:

- `agent/pre-step` waterfall; a `reject` decision ends the Turn as `blocked`.
- `step/start`, then a `user/message` per admitted input.
- `#callModel` — `requestModelV1`, then `assistant/message`, flush, `notifyModelOutcome`, `#announceAssistantText`.
- `#completeStep` — the step's tool calls through `executeToolsV1`, then the `agent/step-continuation` waterfall and `step/end`.

Exhausting the loop throws `StepLimitReachedError`, which settles the Turn as `interrupted` with `STEP_LIMIT_REASON_V1`.

### Deadlines and limits

- `TURN_DEADLINE_MS_V1` — 15 minutes, defined in `@frockbot/kernel-contracts` and re-exported here, because the Durable Object also reads it to decide whether a run still marked `running` can be running.
- The deadline aborts the same `AbortController` that Stop uses; `#turnDeadlineReached` distinguishes them, and its branch is evaluated first so a Turn the clock ended is reported as timed out rather than as one the person stopped.
- `MODEL_REQUEST_ATTEMPTS_V1 = 2` — first attempt plus one retry, for an unknown failure.

### Event log

Types written: `input/queued`, `turn/start`, `composition/pinned`, `turn/admission`, `input/admitted`, `step/start`, `user/message`, `model/request`, `model/usage`, `assistant/chunk`, `assistant/message`, `model/response-failed`, `model/response-format-note`, `model/retry`, `tool/call`, `tool/result`, `step/end`, `turn/end`.

One `model/request` is written per _dispatch_, all carrying the same request. The count of them under one `requestId` is the number of times that call was sent, and each one marks the point where the answer so far starts again — which is how a partial reply is projected after a re-issue.

Persistence is `SessionEventLog` (`packages/kernel-do/src/session-event-log.ts`) into Durable Object key-value storage: 256 KB pages, 16 KB inline threshold, 8 KB excerpts, payloads chunked at 128 KB.

### Resumption after eviction — `#resumeTurn`

`planResumptionV1` replays the log forward — pure, reading nothing else — for the open Turn, the latest step and its status, the latest `assistant/message`, and any `model/request` the log carries no answer to. Then:

- A durable `model/response-failed` for that request settles the Turn as `model-error`: the call answered, and what it said was unusable, so sending it again would only reproduce the failure.
- Otherwise the pending request is dispatched again under its own key.
- An open step whose assistant message is already durable resumes at its tool calls; an open tool occurrence is executed again under its occurrence id.

A Turn writes a `turn/end` on every path but one: a `ModelOutcomeSettlementRequiredError` — a listener on `agent/model-outcome-committed` that could not durably commit — leaves the Turn open, because that commitment is the Turn's own durable write and a resume re-announces the same request id.

### Model request — `requestModelV1`

Validates the settled tool-occurrence journal, assembles the system prompt through `ctx.systemPrompt.assemble` (session, provider, model, turn type, step budget, deadline), then builds one request: `session.deriveMessages()` through `agent/message-window`, `ctx.tools.schemas({turnType, subagentRole})` through `agent/tool-exposure`, and the assembled `NormalizedModelRequest` through `agent/request`. Per dispatch it journals `model/request`, flushes, calls `admitEffect` — a `false` throws `EffectAdmissionFencedError` — and consumes the stream.

On failure it flushes, releases the request id through `notifyModelOutcome`, and classifies: a `StructuredOutputValidationError` is terminal; a cancellation rethrows and lets the Turn settle; anything else is a retry candidate under `nextModelRetryV1`, classified `unknown` when the provider offered no classification of its own. The `agent/request-error` waterfall may refuse a planned retry or substitute a provider-owned fallback — a fallback is a different call and takes a new key.

### Stream consumption — `consumeStreamV1`

Iterates `ctx.llm.stream(request, signal)`, accumulating text, tool calls and usage, journaling `assistant/chunk` per text delta. Usage is recorded per dispatch, on every path except a `ModelProviderFailureError` with no partial data, because the provider says no billable call occurred.

### Tool execution — `executeToolsV1`

Sequential, not parallel. Per occurrence: validate the journal, skip if a result already exists, `ctx.tools.prepare`, journal `tool/call` if there is no intent yet, `admitEffect({kind: "tool"})`, `ctx.tools.executePrepared`, journal `tool/result`, flush.

- An occurrence with an intent and no result is dispatched again under the same effect id.
- A throw that is not a cancellation becomes an error result. For a tool not declared `idempotent` the content says the outcome is uncertain, because the loop does not know whether the work happened and does not try to find out.
- A result carrying `endsTurn: true` closes the Turn unless the `agent/step-continuation` waterfall overrides it.

### Usage accounting

Provider-reported token counts are used when present. Otherwise `estimateModelUsageV1` estimates at 4 bytes per token over the exact journaled request and assembled response, and the event marks the figure as estimated.

---

## 5. Composition

### Resolution and mounting

The application is a static selection: `applications/foundation/frockbot.application.json`, 35 packages, compiled by `compileFoundationApplication()` (`applications/foundation/src/runtime.ts:512`).

1. On first use the Bot Durable Object receives a bootstrap generation of every compiled member (`packages/plugin-shell/src/backend-composition.ts:47`; `packages/kernel-composition/src/generation.ts:737`).
2. Before a Turn is admitted, `resolveDeploymentCompositionV1` (`backend-composition.ts:95`) re-derives first-party members against the current deployment and pins a new generation if anything moved. Non-first-party and Applet members carry over verbatim.
3. At admission, `activateCompositionV1` (`packages/plugin-shell/src/backend.ts:1852`) reads the pin, mounts, verifies, commits and records last-known-good.
4. Mounting builds a Cordis root per Turn (`backend-composition.ts:274`). First-party members resolve from the compiled contribution table (`applications/foundation/src/contributions.ts`) through `LocalCordisContributionHost` (`packages/kernel-composition/src/index.ts:278`). Artifact-bearing members go through `BotIsolateContributionHost`. Applet members register as tools routed to `APPLET_STATES` (`backend-composition.ts:385-420`).

### Generation shape

`CompositionGenerationV1` — `packages/kernel-composition/src/generation.ts:136`:

```
{ schemaVersion: 1, generationId, artifactSetHash, parentGenerationId?,
  summary?, createdAt, origin, members[], applets?, status }
```

- `status ∈ pending | active | superseded | failed | quarantined` (`:133`).
- `origin ∈ bootstrap | bot-authored | bot-catalog | user-install | revert` (`:54`).
- `members[]` is `{packageId, specifier, version, manifestHash, provenance, artifact?}` (`:44`); `provenance ∈ first-party | catalog | user | bot` (`:8`).
- `artifactSetHash = sha256(canonicalJson(members sorted by packageId))`, or over `{members, applets}` when Applets exist (`:672-687`).
- `generationId = "<createdAt>:<artifactSetHash[0..16]>"` (`:706`).
- Caps: 512 members, 64 applets, 64 applet tools, 160-character summary (`:277-289`).

### Where the pin lives

`DurableCompositionStore` (`packages/kernel-do/src/composition-store.ts:74`) writes into the Bot Durable Object: `composition:current` (a `{generationId, artifactSetHash}` pin), `composition:generation:<id>`, `composition:index:<createdAt>:<id>`, `composition:last-known-good`, plus failure, failure-count and quarantine keys. Pinning is compare-and-swap; a lost race raises `CompositionPinConflictError` (`generation.ts:168`) and the caller re-reads and re-derives (retry helper at `:193`, four attempts).

An in-flight Turn keeps the generation it pinned. Activation takes effect at the next admitted Turn.

### Activation and failure — `packages/kernel-composition/src/activation.ts`

Failure phases are `resolve | bundle | mount | health` (`:22`). `activateCompositionV1` (`:318`) reads the pin, mounts and verifies, then commits and clears failures. On failure it records the attempt, marks the generation `failed` or `quarantined`, mounts last-known-good, notifies, and admits the Turn on the fallback. The quarantine threshold is three attempts (`:65`); a quarantined generation is never retried. If last-known-good is itself the failing generation, the error is rethrown (`:377-390`).

### Isolate loading — `packages/kernel-composition/src/isolate-host.ts`

- Loading uses the `BOT_PACKAGES` Worker Loader binding, typed structurally as `BotIsolateLoader` (`:72`). There is no dynamic `import()`.
- `loader.get(loaderId, () => ({compatibilityDate, mainModule, modules, globalOutbound: null, env: {IDENTITY, CAPABILITIES}, limits: {cpuMs: 5000, subRequests: 5}}))` (`:434-455`).
- The loader id is `isolateLoaderIdV1({userId, artifactSetHash: botIsolateModuleSetHashV1(artifactContentHash, bindingDigest)})` (`:273`). The module-set hash covers wrapper version, wrapper source hash, package hash and binding digest (`:146-158`), because a loader id is served from cache with the `env` it was first loaded with.
- Artifacts come from `createR2PackageArtifactStore` (`packages/plugin-shell/src/backend-isolate.ts:316`): R2 key `packages/<contentHash>.mjs`, falling back to artifacts compiled into the Worker, then sha-256 verified before load.
- `BotIsolateContributionHost.prepare` (`:266`) loads the artifact, mounts and calls `entrypoint.health()` as one guarded phase, then requires `health.ok`, non-empty tools, a matching `packageId`, and tool and hook names equal to the stored manifest's (`:305-345`). It also enforces the manifest's admission ceiling (`:162`).
- `BotCapabilities` (`apps/cloudflare/src/bot-capabilities.ts:68`), a `WorkerEntrypoint`, is the loopback through which an isolate reaches the kernel. It is minted per Turn at `packages/plugin-shell/src/backend.ts:2069-2125`.

### Bundling

Authoring calls the `PACKAGE_BUNDLER` service binding (`packages/plugin-shell/src/backend-authoring.ts:778`) → `apps/cloudflare-bundler/src/index.ts:12` → `bundle.ts` using `@cloudflare/worker-bundler@0.2.3`. The bundler Worker is stateless and holds no bindings; the Bot Durable Object writes the resulting R2 object and records the durable intent.

### Built-in versus dynamic

34 of the 35 members carry no `artifact` and resolve from the compiled contribution tables. `createFoundationRuntimeApplication` (`applications/foundation/src/runtime.ts:1152`) filters the runtime table to `pkg.artifact === undefined`, then removes 19 runtime ids that mount only inside an admitted Turn.

Exactly one member carries an `artifact`: `@frockbot/plugin-applets` (`frockbot.application.json:167`). Its bytes are checked in at `applications/foundation/generated/applets-artifact.ts` as `FIRST_PARTY_PACKAGE_ARTIFACTS_V1` and wired into the Durable Object at `apps/cloudflare/src/bot-state.ts:514`.

Bot-authored packages (`packages/plugin-authoring/src/agent.ts:156`) and catalog installs (`packages/plugin-shell/src/backend-package-catalog.ts:874`) both produce artifact-bearing members.

---

## 6. Clients

### Web client

The shipping client is Vue 3. Comments in `applications/foundation/src/client-contributions.ts:7` and elsewhere refer to React; they do not describe the code.

- Entry `apps/cloudflare/src/client/index.ts:394` constructs one `ClientApplication` transport object, installs plugins and calls `application.mount("#app")`.
- Vue 3.5.41; Vite 8.2.2 with `@vitejs/plugin-vue` (`apps/cloudflare/vite.config.ts`). Build options set `cssCodeSplit: false` and `assetsInlineLimit: Infinity`, producing one JS and one CSS payload.
- No router and no state library. Navigation is a surface registry (`packages/client-ui/src/surfaces.ts:6`, interfaces at `packages/client-core/src/index.ts:536-558`); state is `ref` and `shallowReactive` with `provide`/`inject`.
- The app Worker declares no `assets` binding. `apps/cloudflare/build-artifact.ts:25-52` inlines the Vite output into the Worker bundle as `__FROCKBOT_CLIENT_JS__`, `__FROCKBOT_CLIENT_CSS__` and `__FROCKBOT_CLIENT_ICON__`, emitting `foundation-v1.mjs`. That artifact is stored in R2 and loaded per request through the `USER_APPLICATIONS` Worker Loader. The document is generated by `appHtml()` (`apps/cloudflare/src/user-application.ts:125-141`), serving `/app.js` and `/app.css`.

Plugin UI mounts two ways.

1. **In-bundle Vue components, through slots and the surface registry.** `ClientApplication` (`packages/client-core/src/index.ts:585`) requires exactly one `root` slot and registers a global `<k-slot name="...">` outlet (`:624-643`). `packages/plugin-auth/src/client/index.ts:13` fills `root` with `AuthGate.vue`, which renders `<k-slot name="authenticated-root">` (`AuthGate.vue:157`); `packages/plugin-shell/src/client/index.ts:3374-3378` fills that with `FrockBotApp.vue`. The contribution table is `applications/foundation/src/client-contributions.ts:36-63` — 17 entries, mounted in order.
2. **Sandboxed iframes, for Bot-authored and user-installed package UI.** `packages/plugin-shell/src/client/index.ts:3159-3187` reads iframe entries from the Bot's Composition manifest and registers a sidebar trigger plus a surface per entry. Frames load from `ui.bot.frockbot.com/packages/<sha256>.html` (`apps/cloudflare/src/gateway.ts:1275`) and communicate through a versioned postMessage bridge (`packages/plugin-shell/src/client/PackageIframeHost.vue`). Package-supplied code does not execute in the app origin.

The chat view lives in `packages/plugin-shell/src/client/FrockBotApp.vue` (2108 lines). The transcript is a `v-for` at `:1520`; assistant text renders through `UiMarkdown` at `:1551`. Turn merge logic is `replaceTurnMessages()` (`packages/plugin-shell/src/client/index.ts:3405`). Data arrives over REST, with invalidation over the state channel (`apps/cloudflare/src/client/bot-state-channel.ts:147-170`).

`packages/plugin-settings/src/client/index.ts:23-94` registers six surfaces (`bot-settings`, `plugins`, `models`, `connections`, `package-catalog`, `user-settings`) and three slot fillers; other plugins mount into slots that settings declares.

### Flutter app

`apps/native/README.md:3` states that the Vue application is the production client and that the Flutter app does not claim acceptance. `apps/native/qualification.json:2` records `"status": "unqualified-prototype"`. `.github/workflows/native.yml:18` is advisory: analyze and test only, no APK or IPA build, no release job.

Screens (no router; `MaterialApp(home:)` plus `Navigator.push`):

- `FrockBotApp` — `lib/main.dart:31`, build at `:324`, `ThemeMode.dark` hardcoded at `:330`
- `SignInPage` — `lib/auth/sign_in_page.dart:5`
- Bot directory — inline `ListView`, `lib/main.dart:342-448`, responsive split at width ≥ 800 (`:449`)
- `ConversationView` `lib/main.dart:546` → `ChatPane` `:630`
- `ActivityPage` — `lib/activity/page.dart:9`
- `BotRecoveryPage` — `lib/recovery/page.dart:11`, detail with three tabs at `:202`
- `SettingsPage` — `lib/settings/page.dart:14`, `ModelPicker` at `lib/settings/model_picker.dart:10`
- `ConnectionsPage` — `lib/connections/page.dart:12`
- `AppletDirectoryPage` → `AppletPage` — `lib/extensions/fallback.dart:77`, `:157`
- `FormPreview` — `lib/main.dart:933`, reachable only under `--dart-define=NATIVE_ACCEPTANCE` (`:488`)

Transport is REST over `dart:io HttpClient` with the base URL hardcoded to `https://bot.frockbot.com` (`lib/client/transport.dart:10`), plus one read-only WebSocket at `/api/bots/{botId}/state-channel` (`:229`) with a strict `cursor + 1` contiguity rule (`lib/client/state_channel.dart:69-82`), a 4096-byte frame cap and 1–30 s backoff.

Auth is PKCE in the system browser (`lib/client/auth.dart:17`), returning over an App Link validated in `accept()` (`:60`). The session token lives in `flutter_secure_storage`; the directory, drafts, cached transcripts and cursors are plaintext JSON on disk (`lib/client/plain_store.dart:13`, `:97`).

`lib/protocol/client_wire.generated.dart` (987 lines) is generated by `scripts/generate-dart-protocol.ts:119` from `packages/protocol-schemas/schema/client-wire.schema.json`. Its classes wrap an opaque `Object? _json` and validate; they are not typed models, so call sites index by string.

WebView is used in one place, `AppletPage` (`lib/extensions/fallback.dart:157-465`), loading the anonymous bootstrap at `ui.bot.frockbot.com/native-fallback` (server side `apps/cloudflare/src/native-fallback.ts:34`). It never receives the native session.

**Capability gap.** Present in web, absent in native: Bot creation, starting a conversation, the package catalog, in-app connector authorize and revoke, model configuration, admin, search, flock and avatar editing, routines, Bot templates, billing, the package publisher, registered machines, the Computer overlay, voice dictation and assistant, and package iframe entries. Native settings are a generic server-described form renderer rather than plugin surfaces.

Present in native, absent in web: a durable offline store of directory, transcripts and drafts; inbox as a first-class screen; Bot archive, restore and delete UI with composition-generation and audit detail; deep-link-to-Bot; PKCE system-browser sign-in.

Both speak the same REST API and the same state-channel WebSocket. Native validates every payload against the shared schema; the web client uses hand-written decoders.

---

## 7. Model providers

`ctx.llm` is `LlmRegistry` — `packages/plugin-models/src/llm.ts:15-40`. It is a `Map<providerId, LlmProvider>` that dispatches on `request.provider`, wraps the call in the `llm/stream` waterfall, then validates structured output. The kernel-declared interfaces are `LlmProvider`, `ModelInvocation` and `ModelProviderRegistration` at `packages/kernel-contracts/src/model-invocation.ts:167-208`, merged onto `cordis.Context` at `:210-212`.

Stream events (`packages/kernel-contracts/src/types.ts:158-166`): `text-delta`, `tool-call`, `usage`, `response-format-note`, `structured-output-failure`, `finish`.

### Selection

- `resolveEffectiveBotModelV1` (`packages/configuration-core/src/index.ts:652-760`): a Bot-scoped Package setting with `role: "model"`, else a User-scoped one, else `user.platformModel`. Two enabled packages both declaring a model setting is a hard conflict. A broken choice falls back to the platform model and records `fallback.from`.
- `resolveBotModelBindingV1` (`:588-621`) yields `ready`, `requires-resolution` or `unavailable`.
- The Turn resolves the effective model, refuses if it changed mid-reply, and mounts the provider plugin itself as a runtime Package for that Turn (`packages/plugin-shell/src/backend.ts:4965-5090`). The resulting `modelSelection` flows through `backend.ts:1792` → `backend-composition.ts:297` → `apps/agent-runtime/src/runtime.ts:557-583`, where it overrides the default provider and model and becomes `AgentOptions.modelBinding`.
- Package-to-provider-type mapping is a two-entry map at `applications/foundation/src/runtime.ts:369-419`: `@frockbot/plugin-provider-ollama-cloud/runtime` → `ollama-cloud`, `@frockbot/plugin-provider-frock-ai/runtime` → `flock-ai`. Anything else resolves to `Bot model provider "X" is unavailable` (`:1084-1089`).

### Packages

**`packages/provider-openai-compatible`** — a shared transport library, not a plugin. `OpenAICompatibleProvider` (`src/index.ts:884-967`) issues `fetch` to `${baseUrl}/chat/completions` with `authorization: Bearer`. Request planning is `planOpenAICompatibleRequestV1` (`:367-455`): `stream: true` with `stream_options.include_usage`; tools as `{type: "function", function: {...}}`; `response_format` in an `openai` dialect and a `workers-ai` dialect, degrading to `json_object` and then to prompt-injected instructions, emitting a `response-format-note` at each step. The SSE decoder is at `:629-720`, with caps of 1 MiB per event and 16 MiB per response (`:458-459`). Tool calls are accumulated and emitted only after the stream terminates (`:696-708`). A missing terminal marker throws (`:690`). Deadlines are 120 s to first byte and 60 s idle (`packages/kernel-contracts/src/model-invocation.ts:88-131`), applied by `streamWithModelRequestDeadlinesV1` (`:852`).

**`packages/plugin-provider-frock-ai`** — package id `provider-flock-ai`, provider type `flock-ai`. Calls Cloudflare AI Gateway through one of two transports, chosen at `apps/cloudflare/src/frock-ai.ts:132`: with an account id and token, a raw fetch to `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions` with `cf-aig-authorization` (`:55-58`, `:163-180`); otherwise the `AI` binding's `gateway(id).run({provider: "compat", endpoint: "chat/completions"})` (`:195-207`). Only the compat transport accepts a `dynamic/<route>` model. Model ids are `@frock/*` with legacy `@flock/*` normalized (`src/catalog.ts:30-38`); `@frock/auto` maps to the `dynamic/flock-auto` route, a concrete id to `workers-ai/@cf/...`, and a structured-output request on Auto is pinned to `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` (`:21-22`, `:92-101`). The static catalog has two entries: `@frock/auto` and `@frock/deepseek-ai/deepseek-v4-flash-0731` (`:49-56`, `:104-124`). `src/user.ts:192-275` bootstraps an ambient `flock-ai-ambient` Connection and sets it as `platformModel` for every User, which is what lets a new Bot answer with no configuration. `src/runtime.ts:224-255` tags the Agent on a permanent failure and rewrites the next request to `@frock/auto`. `reconciliation.retrieve` returns `not-retrievable` (`:133-140`). Stored ids are `flock-*`; display strings are `Frock` (`catalog.ts:3-8`).

**`packages/plugin-provider-ollama-cloud`** — provider id `ollama-cloud`, `defaultEnablement: "disabled"`. Takes an API-key Connection and acquires a per-request credential lease against the User Durable Object before any bytes are sent (`src/runtime.ts:133-190`), settling it afterwards; a lease that does not match `connectionId` and `connectionGeneration` is a permanent failure. Base URL comes from the Connection setting `api-base-url`, default `https://ollama.com`, with `/v1` appended (`:74-77`). It delegates to `OpenAICompatibleProvider` (`:229-241`). Behavior forks on hostname: a non-`ollama.com` host uses native `/api/chat` with `format` for JSON Schema, while `ollama.com` reports `structuredOutput: "none"` (`:130-132`, `:278-289`). It also contributes an `ollama-cloud-web-search` tool Capability, so it is the one Package that mounts twice per Turn — handled by `mergeFoundationRuntimePackagesV1` (`applications/foundation/src/runtime.ts:1106-1145`).

**`packages/plugin-provider-foundation`** — provider id `foundation`, model `deterministic-v1` (`src/runtime.ts:8-9`). It echoes the last user message prefixed `"Cordis runtime: "`, or echoes tool output, and reports `structuredOutput: "none"`. It is the default in `agents.create` (`apps/agent-runtime/src/runtime.ts:409-410`) and is overridden by `modelSelection`.

**`packages/plugin-models`** — the registry service. Also implements `structured<T>()` by streaming with a `json_schema` response format and validating the accumulated text.

**`packages/plugin-custom-models`** — client-only, `defaultEnablement: "disabled"`. Contributes a Vue `BotModelSection` into slot `frockbot.bot-settings-sections` and declares the Bot-scoped `role: "model"` setting. It has no runtime and no provider; it is the model picker.

Adjacent, outside the loop: image generation uses Workers AI ids directly (`packages/plugin-image/src/model.ts:40-52`, default `@cf/black-forest-labs/flux-1-schnell`); voice dictation opens a WebSocket to OpenAI Realtime or the Gateway's `/openai` path (`apps/cloudflare/src/voice-upstream.ts:60-92`).

---

## 8. Applets

### Authoring

The Bot writes Applet code on the Computer with ordinary file tools. `packages/plugin-applets` exposes seven tools — `applet_list`, `applet_create`, `applet_publish`, `applet_revert`, `applet_delete`, `applet_focus`, `applet_generations` (`packages/plugin-applets/frockbot.json:49-143`, implementations at `src/package.ts:36-145` and `:307-394`). The Package mounts as a `bot-isolate` and reaches the kernel only through `ctx.applets`. `applet_create` scaffolds from templates into the durable root `applets/source/<appletId>/` (`src/root.ts:41-108`), mounted on the Sprite at `/home/box/agent-data/user-packages/applets/source`. Guidance ships at `packages/plugin-applets/skills/applets.md`.

### Build

esbuild, run by the SDK CLI on the Computer — `packages/applet-sdk/src/cli/build.ts:46-183`. The server bundle is ESM, `platform: neutral`, with `cloudflare:workers` external. The UI bundle is IIFE, minified and inlined into one self-contained HTML page. The tool manifest is derived by booting the built Durable Object in Miniflare 5 and calling `/health` and `/describe` (`:104-131`). `apps/cloudflare-bundler` is not involved; that service bundles Bot Packages.

### Storage

R2 `APPLICATION_ARTIFACTS`, content-addressed as `packages/<sha256>.mjs` and `.html`, written at `packages/plugin-shell/src/backend.ts:2506-2515` and hash-verified on read (`apps/cloudflare/src/applet-state.ts:276-290`). Generations, pointers and failures live in `AppletState`; the account directory lives in `UserConfiguration`.

### Execution

- **Server.** `env.APPLETS.get(...)` with `globalOutbound: null`, an env of exactly `IDENTITY` and `CAPABILITIES`, and `limits {cpuMs: 5000, subRequests: 10}` (`applet-state.ts:245-273`). The loaded class is mounted as a Durable Object facet (`:297-308`) under a snapshot, trial and commit publish protocol with `facets.clone` rollback (`:479-613`).
- **UI.** `ui.html` is served from the anonymous origin `ui.<host>` (`apps/cloudflare/src/gateway.ts:139-176`) and nested in an `<iframe sandbox="allow-scripts">` inside the Package's own `canvas.html`, handshaken by postMessage, then connected over a WebSocket gated by an HMAC viewer token (`gateway.ts:434-516`).

### SDK

`@frockbot/applet-sdk` exports `server`, `client`, `kit` and `lint`. The server API is an `Applet` base class with schema-first `tables`, `this.tool({description, input}, handler)` and an optional `migrate`. The client API is `createApplet<TServer>()` producing TanStack DB collections plus `useLiveQuery`. Wire protocol v1, JSON capped at 64 KB: `hello`, `snapshot`, `changes`, `ack`, `reject` downstream; `hello`, `mutate` upstream.

### Persistence

The facet's own SQLite inside the per-`<userId>:<appletId>` Durable Object, with additive `ALTER TABLE` migration and a 2000-row `_applet_changes` log (`packages/applet-sdk/src/server/store.ts:32-80`). Data is account-wide and shared across viewers, survives publish and revert, and is destroyed only by `applet_delete`.

---

## 9. Computer

### What it is

A persistent Linux desktop virtual machine per User, rented from Fly Sprites (`api.sprites.dev`, SDK `@fly/sprites@0.1.0`). `apps/computer-host` is a Worker that shards and authorizes, fronting a Cloudflare Container (`node:24-slim`, no desktop) that runs the Sprites SDK.

### Provisioning

`getSprite`, and on a miss `createSprite`, named `frockbot-<sha256(["user", userId])[0..12]>` (`packages/computer-host-runtime/src/runtime.ts:2718-2739`). The host then adopts an existing machine via a marker file, or provisions through a detached, resumable six-phase shell run — `layout`, `packages`, `runtime`, `browser`, `applets`, `reference` — bounded at 10 minutes, at most 8 relaunches, polled every 3 seconds. Egress is restricted to one host: `enableInternet: false, allowedHosts: ["api.sprites.dev"], interceptHttps: true` (`apps/computer-host/src/egress.ts:23-27`), with a WebSocket bridge for upgrades.

### Inside the Sprite

Ubuntu 25.10 running one `Xvfb :100 -screen 0 5120x720x24`; `fluxbox`; one Chromium — Playwright 1.55's build — on CDP port 9222 with a single shared `~/chrome-profile`; a per-Bot `x11vnc -clip 1280x720+<slot*1280>+0 -rfbport $((5900+slot))`; `websockify --web=~/.frockbot/viewer` on port 6080, the only public port; a browser watchdog; and a workspace sync service.

One Sprite, one browser and one screen per User; one slot — window plus clipped VNC port — per Bot. `DESKTOP_SLOTS = 4` and `SCREEN_WIDTH = SLOT_WIDTH * DESKTOP_SLOTS`. The single browser follows from Chromium's per-`user-data-dir` singleton lock.

### Protocol

`packages/computer-host-protocol/src/protocol.ts` — HTTP POST per operation with optional NDJSON streaming; not a WebSocket. The envelope is `{version: 1, effectId, identity: {userId}, tenant: {botId}, credentialRef}`. Eleven operation kinds: `open`, `exec`, `file/read`, `file/write`, `file/list`, `file/stat`, `file/delete`, `control`, `viewer`, `service`, `cancel`. Frames: `open` yields `progress | result | error`; `exec` yields `stdout | stderr | exit | error`. Requests shard to `computer-host-<fnv1a(userId) % 2>` (`apps/computer-host/src/router.ts:38-48`) and carry `x-frockbot-host-token`, checked in both the Worker and the container.

### Screenshots and live view

A screenshot is a guarded `exec` running `scrot`, clipped to the Bot's slot of the shared screen, followed by a `file/read` (`packages/plugin-fly-sprite/src/computer.ts:732-797`); the bytes are filed into the durable `screenshots` root and attached to the model turn. The live view is noVNC iframed directly at `https://<sprite>.sprites.app/...`, with no Worker proxy; CSP allows `frame-src https://*.sprites.app` (`apps/cloudflare/src/user-application.ts:178`). FrockBot ships its own viewer page because stock noVNC fixes `view_only` at construction.

### Tools

All from `packages/plugin-computer`; `packages/plugin-fly-sprite` registers none.

- `computer_exec` — `src/agent.ts:794`
- `computer_screenshot` — `:1309`
- `computer_doctor` — `:1507`
- `computer_process_check` / `computer_process_logs` / `computer_process_stop` — `:1579`, `:1609`, `:1648`
- `computer_browser` — `:1678`, actions `snapshot | navigate | click | fill | press | wait`, returning an accessibility snapshot over CDP

### Lifecycle

The container sets `sleepAfter: "10m"` with `max_instances: 3`. A renderer watchdog sends SIGKILL to Chromium renderer processes only, above 1.5 GiB RSS or when `MemAvailable` is under 512 MiB (`runtime.ts:601-677`). A service refresh that does not complete returns without writing the state digest, so the next `open` retries it. The Bot Durable Object arms a 60-second connect watchdog before each connect. Slots are reclaimed after 900 seconds idle unless a 90-second lease is held; with no free slot the process exits 75.

---

## 10. Storage

Bindings are declared in `apps/cloudflare/wrangler.jsonc`.

| Binding                                                                                               | Kind               | Contents                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USER_APPLICATIONS` (:20)                                                                             | Worker Loader      | The per-user foundation application artifact (`apps/cloudflare/src/index.ts:2229`, `src/user-configuration.ts:201`, `src/package-publication.ts:120`) |
| `BOT_PACKAGES` (:26)                                                                                  | Worker Loader      | Bot Package isolates, loaded with `globalOutbound` disabled (`packages/plugin-shell/src/backend.ts:2069`)                                             |
| `APPLETS` (:33)                                                                                       | Worker Loader      | Applet server artifacts, mounted as facets (`apps/cloudflare/src/applet-state.ts:94`, `:249`)                                                         |
| `PACKAGE_BUNDLER` (:42)                                                                               | Service            | `frockbot-cloudflare-bundler`                                                                                                                         |
| `COMPUTER_HOST` (:47)                                                                                 | Service            | `frockbot-computer-host` (`apps/cloudflare/src/bot-state.ts:465-474`)                                                                                 |
| `APPLICATION_ARTIFACTS` (:53)                                                                         | R2                 | Application, Package and Applet artifacts, content-addressed                                                                                          |
| `MEMORY_FILES` (:57)                                                                                  | R2                 | Memory and workspace file bodies (`apps/cloudflare/src/workspace.ts:126`, `:157`)                                                                     |
| `PACKAGE_CATALOG` (:64)                                                                               | R2                 | Immutable catalog generations plus a mutable `catalog/current` pointer, served at `/catalog/v1/*`                                                     |
| `AUTH_DB` (:70)                                                                                       | D1 `frockbot-auth` | better-auth only                                                                                                                                      |
| `MEMORY_INDEX` (:78)                                                                                  | Vectorize          | Memory embeddings; the app Worker uses the binding only for deletion (`bot-state.ts:820-825`)                                                         |
| `AI` (:83)                                                                                            | Workers AI         | Frock AI gateway transport and image generation                                                                                                       |
| `BOT_STATES`, `USER_CONFIGURATIONS`, `DEPLOYMENT_POLICY`, `APPLET_STATES`, `VOICE_SESSIONS` (:86-116) | Durable Objects    | §2                                                                                                                                                    |

D1 schema: `apps/cloudflare/migrations/` holds one file, `0001_better_auth.sql`, defining `user`, `session`, `account` and `verification` with their indexes. All other product state lives in Durable Objects.

Durable Object storage is key-value in every class. SQLite is used only inside `UserConfiguration`, and only by the search, audit and billing stores. All five classes are declared `new_sqlite_classes` in migrations v1–v5 (:117-138).

Not used anywhere in the repository: KV namespaces, Queues, Workflows, Hyperdrive, Browser Rendering, Analytics Engine, Pipelines. Containers appear only in `apps/computer-host`.

Top-level vars (:139-157): `NATIVE_SLICE_2_AUTH`, `DEFAULT_APPLICATION_HASH`, `FROCK_AI_GATEWAY_ID`, `FROCK_AI_ACCOUNT_ID`, `FROCK_AI_AUTO_ROUTE`, `ALLOWED_CLIENT_ORIGINS`, `UI_ARTIFACT_HOSTS`.

Secrets are declared in `apps/cloudflare/src/production-secrets.ts`. Required (`:60-103`): `FROCKBOT_AUTHORIZATION_STATE_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SPRITES_TOKEN`, `COMPUTER_HOST_TOKEN`, `CREDENTIAL_KEYRING`, `ROUTINE_HOOK_SECRET`, `MACHINE_TOKEN_SECRET`, `APPLET_VIEWER_SECRET`. Optional (`:116-151`): `COMPOSIO_WEBHOOK_SECRET`, `COMPOSIO_API_KEY`, `FROCKBOT_ADMIN_EMAILS`, `DEBUG_TOKEN`, `FROCK_AI_GATEWAY_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

---

## 11. Auth

better-auth 1.7.2, configured once at `apps/cloudflare/src/auth.ts:36-62`. Enabled plugins are `electron({clientID: "frockbot-desktop"})` and `bearer()`. There is no admin plugin, no organization plugin and no jwt plugin. `trustedOrigins` includes `com.frockbot.desktop:/`; `account.encryptOAuthTokens` is true. Missing secrets yield a stub that returns 503 for every route (`:64-97`).

Google is the only configured provider. The `verification` table and the `account.password` column are unused.

Session storage is D1 `AUTH_DB`. There is no `cookieCache` and no `secondaryStorage`, so each authenticated request performs a D1 lookup. Native sessions are separate: they live in the User Durable Object under `native:sessions:v1`, capped at 32 with a 7-day lifetime (`apps/cloudflare/src/native-sessions.ts:56-109`).

### Native sign-in

1. `POST /api/auth/native/start` (unauthenticated) mints an HMAC-signed 5-minute claim; `returnUri` is checked against a deployment-fixed allowlist (`apps/cloudflare/src/native-auth.ts:27-32`).
2. The app opens `/native/authorize` in the external browser. That route checks for a cookie session and otherwise runs Google sign-in with `callbackURL=/native/complete`.
3. Completion 302s to the Android App Link `bot.frockbot.com/native/return/android?code=&state=`.
4. `POST /api/auth/native/exchange` verifies `SHA-256(verifier)`, the state, the return URI and a byte-exact ClientHello, applies signup policy, commits in the User Durable Object, and returns `Bearer frockbot-native.<claims>.<sig>` with a 7-day lifetime.

The token is stored in the platform keystore through `flutter_secure_storage` (`apps/native/lib/client/plain_store.dart:110-176`).

### Admission and admin

Admin is membership of the comma-separated `FROCKBOT_ADMIN_EMAILS` secret (`apps/cloudflare/src/admin-identities.ts:7-28`), enforced at `apps/cloudflare/src/gateway.ts:801-810`. Signups default to closed (`apps/cloudflare/src/deployment-policy.ts:17`) and are toggled by `deployment/set-signups`. `accountIsAdmitted` (`apps/cloudflare/src/account-admission.ts:8`) admits when the caller is an admin, when the User Durable Object already exists, or when signups are open. That gate governs use of the product. Account creation is gated separately, in better-auth's `user.create.before` hook (`signupDatabaseHooksV1`, `apps/cloudflare/src/auth.ts`), because `/api/auth/*` is served ahead of it.

`ALLOW_DEVELOPMENT_AUTH` enables an identity bypass: `?as_user=` is accepted and persisted as the `frockbot_dev_user` cookie (`gateway.ts:342-362`, `:673-681`). It skips signup admission. `admin-identities.ts:20-21` treats the id `development` as admin unconditionally, and `:27` treats any development identity as admin when `FROCKBOT_ADMIN_EMAILS` is empty.

---

## 12. Tests and CI

### Test layers

1. **Bun unit** — root `bun test` (`package.json`), matching `*.test.ts` and `*.spec.ts` across every workspace. No `bunfig.toml`.
2. **Workerd, hermetic** — `apps/cloudflare/vitest.config.ts`, `test/**/*.workerd.ts`, entry `./test/fly-compatibility-worker.ts`, with Miniflare fakes for the Computer host, Frock AI and Vectorize. `fileParallelism: false`.
3. **Workerd, integration** — `apps/cloudflare/vitest.integration.config.ts`, `test/integration/**/*.integration.ts`, entry `./src/index.ts`, with the real gateway, the built artifact and D1 migrations via `readD1Migrations`.
4. **Bundler workerd** — `apps/cloudflare-bundler/vitest.config.ts`.
5. **Computer host** — `apps/computer-host/vitest.config.ts` plus `bun test src container`. Opt-in live suites `test:live` and `test:live:desktop` are not run by CI.
6. **Playwright** — `apps/cloudflare/e2e/playwright.config.ts`, `**/*.e2e.ts`, `fullyParallel: false`, `workers: 1`, 240 s timeout, 4-way CI sharding through `balanced-shard-reporter.ts`, `webServer` of `bun e2e/serve.ts`. Roughly 28 spec files.
7. **Flutter** — `apps/native/test/*.dart` (14 files) plus `integration_test/settings_screens.dart`, which is a screenshot runner.
8. **Gate scripts** — run under `typecheck`: `scripts/check-client-protocol.ts`, `scripts/check-kernel-imports.ts`, `scripts/check-computer-host-imports.ts`, `scripts/generate-isolate-context-catalog.ts --check`, `scripts/build-applets-package.ts --check`, then `scripts/typecheck.ts`. Plus `lint:ui-styles` (`scripts/check-ui-styles.ts`).

### `.github/workflows/ci.yml`

Triggers: push to `main`, all pull requests, `workflow_dispatch`.

- `changes` (:17) — classifies documentation-only runs through `scripts/docs-only.sh`, so ruleset-required checks report `skipped` rather than remaining pending.
- `docs` (:83) — install plus `format:check`.
- `validate` (:110) — Bun 1.3.6: `format:check`, `lint:ui-styles`, `typecheck`, `bun test`, app `test:workerd`, bundler `test:workerd`, app `test:integration`, computer-host `test` and `test:workerd`, `bun run build`.
- `e2e` (:179) — 4-shard matrix, `fail-fast: false`, Chromium install, `bun run test:e2e --shard=N/4`; uploads blob reports, failure diagnostics and wrangler logs.
- `e2e-gate` (:298) — aggregates the matrix into the ruleset-required check `Browser end-to-end`.
- `e2e-report` (:326) — merges blob reports into HTML on failure.
- `deploy-staging` (:367) — push to `main`, `needs: [validate, e2e]`, environment `staging`. Validates required env names, creates missing staging R2 buckets, the Vectorize index and D1, rewrites `wrangler.jsonc` in place to inject the staging `database_id` and replace `foundation-v1` with the artifact sha256, applies D1 migrations, uploads the artifact to R2, publishes the Package Catalog, then `wrangler deploy --env staging --secrets-file`.

### `.github/workflows/release.yml`

Trigger: push of a tag matching `v*.*.*`.

- `verify` (:16) — validates strict SemVer, then `typecheck`, `bun test`, `bun run build`.
- `publish-npm` (:84) — `build:webui`, rewrites every `packages/*/package.json` to the tag version and sets `private: false`, resolves `workspace:` ranges to literals, requires npm ≥ 11.5.1, then publishes all of `packages/*` concurrently with `npm publish --access public` (`--tag next` for prereleases) through OIDC trusted publishing. `EPUBLISHCONFLICT` is treated as success.
- `github-release` (:233) — `gh release create --generate-notes --verify-tag`.
- `deploy-marketing` (:255).
- `deploy-backend` (:307, environment `production`) — rewrites the production D1 id and artifact hash into `wrangler.jsonc`, applies D1 migrations remotely, uploads the artifact, publishes the Package Catalog, deploys the bundler and then the computer host with its own secrets file, runs `scripts/check-production-secrets.ts check --live` and `write-secrets-file`, then `wrangler deploy --secrets-file`.

### `.github/workflows/auto-merge.yml`

On pull request `opened`, `reopened` and `ready_for_review`. Skips drafts and forks; runs `gh pr merge --auto --merge`. The branch ruleset on `main`, requiring `Validate` and `Browser end-to-end`, is what holds the merge.

### `.github/workflows/native.yml`

On pull requests touching `apps/native/**`, `packages/protocol-schemas/**`, `scripts/*protocol*`, `scripts/*native*` or itself. Advisory (`continue-on-error: true`). Runs `scripts/check-native-pins.py`, then runs `flutter pub get --enforce-lockfile`, `flutter analyze` and `flutter test` only when Flutter is installed and its `frameworkRevision` equals `4cf24164269a5ebf0c16a028a00727d0e77bbb05`.

---

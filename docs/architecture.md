# FrockBot Architecture

Paths are relative to the repository root.

---

## 1. Deployables

Five Workers, two container images, one Flutter client — on the web and on the phone.

| Deployable           | Worker name              | Config                              | Serves                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cloudflare`    | `frockbot-cloudflare`    | `apps/cloudflare/wrangler.jsonc`    | The product. Custom domains `bot.frockbot.com` and `ui.bot.frockbot.com`. `main: src/index.ts`, compatibility date `2026-08-27`, flag `nodejs_compat`. Carries an `assets` payload (`:27`): the Flutter web client, uploaded with the deploy.                                                                                      |
| `apps/computer-host` | `frockbot-computer-host` | `apps/computer-host/wrangler.jsonc` | No routes; reached only through the app's `COMPUTER_HOST` service binding. Fronts a Cloudflare Container built from `apps/computer-host/Dockerfile` (`node:24-slim`, `instance_type: basic`, `max_instances: 3`).                                                                                                                  |
| `apps/applet-build`  | `frockbot-applet-build`  | `apps/applet-build/wrangler.jsonc`  | No routes; reached only through the app's `APPLET_BUILD` service binding. Fronts a Cloudflare Container built from `apps/applet-build/Dockerfile` (`node:24-slim`, `instance_type: standard`, `max_instances: 3`, no egress) that runs the Applets SDK's build pipeline. `applet_check` and `applet_publish` are its only callers. |
| `apps/marketing`     | `frockbot-marketing`     | `apps/marketing/wrangler.jsonc`     | `frockbot.com` and `www.frockbot.com`. Static `ASSETS` from `./public` with `run_worker_first: true`; the Worker is a canonical-host redirect plus security headers (`apps/marketing/src/index.ts:1-31`).                                                                                                                          |
| `apps/native`        | `frockbot_native`        | `apps/native/pubspec.yaml`          | The client. Its web build ships as the app Worker's `assets` payload, so `bot.frockbot.com` is deployed by `apps/cloudflare`. The Android and macOS builds are not deployed by CI.                                                                                                                                                 |

Named environments on the app Worker (`apps/cloudflare/wrangler.jsonc`):

- `development` (:162)
- `staging` (:279) — `frockbot-cloudflare-staging`, routes `staging-bot.frockbot.com` and `ui.staging-bot.frockbot.com`
- `e2e` (:401) — `"routes": []`, never deployed

The client's bytes are not in the Worker bundle and not in R2. `apps/cloudflare/build-flutter-web.ts` builds `apps/native` for the browser and stages it under `apps/cloudflare/dist/web/_flutter/<buildHash>/`, which is the `assets` directory; the asset router answers those URLs before the Worker runs. The Worker renders only the document that names them (§6).

Not deployed, though it carries a wrangler config: `apps/cloudflare/e2e/frock-ai-fake.wrangler.jsonc` (bound as a service by the `e2e` env, run from the local wrangler dev registry).

No Fly configuration exists in the repository. Fly Sprites are rented at runtime over the Sprites HTTP API.

Deploy paths:

- `.github/workflows/ci.yml:387` `deploy-staging` — on push to `main`, deploys the app Worker to `staging`.
- `.github/workflows/release.yml` — on tag `v*.*.*`, deploys marketing (:273), the computer host (:465), the Applet build service (:493) and the app Worker (:519).

---

## 2. Durable Objects

Four classes in the app Worker, exported from `apps/cloudflare/src/index.ts:178-182`. `core/durable` defines no Durable Object class; it is the storage and authority library `BotState` delegates to.

### `BotState` — `apps/cloudflare/src/bot-state.ts:369`

- Binding `BOT_STATES`; id `idFromName("<userId>:<botId>")` (`apps/cloudflare/src/index.ts:456`, `:571`).
- Authoritative for all Bot-scoped state: identity, runs, admission fences, the pending and agent-lane queues, the session event log, notifications, conversations, Composition generations and pointers, Workspace file generations and conflicts, the memory vector purge journal. Keys are enumerated in `core/durable/storage-keys.ts:1-177`.
- Storage is key-value only — `ctx.storage.get/put/list/delete/transaction`. The class contains no `sql.exec`.
- Roughly 90 RPC methods (`bot-state.ts:920-2350`), each taking `input: unknown` and decoding through an envelope decoder. They include `run`/`runAgent`, the `isolate*` loopback surface, Composition reads and reverts, routines, tasks, approvals, notifications, `debugSnapshot` and `fenceRunAdmission`.
- `alarm()` drains the memory purge journal, then the mounted contribution's alarm, then the audit outbox.
- `fetch()` at `:2420` serves one path: the state-channel WebSocket upgrade. Sockets use the hibernation API — `state.acceptWebSocket(server, [CHANNEL_TAG])` (`apps/cloudflare/src/bot-state-channel.ts:622`), with `webSocketMessage/Close/Error` forwarded from `bot-state.ts:2447-2466`.

### `UserConfiguration` — `apps/cloudflare/src/user-configuration.ts:221`

- Binding `USER_CONFIGURATIONS`; id `idFromName(userId)`.
- The only class that uses SQLite, and it does not own the tables. `ctx.storage.sql` is handed to two plugin stores: transcript search FTS5 (`app/search/index-store.ts:143-177`) and audit (`app/audit/store.ts:166-175`). All other state is key-value.
- One `alarm()` at `:1739` serving credential leases, publisher and template recovery, flock sagas and archived-Bot sweeps.
- No `fetch()`, no WebSockets.

### `AppletState` — `apps/cloudflare/src/applet-state.ts:228`

- Binding `APPLET_STATES`; id `idFromName("<userId>:<appletId>")` (`core/durable/applets.ts:139`).
- Authoritative for one Applet instance's generation history, pointers, failures, mount input and trial record. Key-value storage.
- The Applet's own code and data live in a facet mounted from an R2 artifact through the `APPLETS` Worker Loader (`:245-289`).
- `fetch()` at `:872` forwards the Applet socket upgrade into the facet. `alarm()` at `:924` is scheduled only through `holdAlarmForFacet` (`:913`), because facets cannot set their own alarms.
- `AppletCapabilities` (`:182`) is a `WorkerEntrypoint`, not a Durable Object.

### `DeploymentPolicy` — `apps/cloudflare/src/deployment-policy.ts:23`

- Binding `DEPLOYMENT_POLICY`; singleton `getByName("frockbot-deployment-policy")` (`apps/cloudflare/src/index.ts:642`).
- One key, `deployment:policy:v1`, holding the signups-open flag under revision compare-and-swap. Two RPCs. No fetch, no alarm.

### In `apps/computer-host`

- `FlyHostContainer` — `apps/computer-host/src/index.ts:63`, `extends Container`, bound as both `COMPUTER_HOST_CONTAINER` and `FLY_HOST`.
- `ComputerEffectJournal` — `apps/computer-host/src/effect-journal.ts:46`. A plain class, not a `DurableObject` subclass. One `effect` key implementing claim, collision and unresolved idempotency.

---

## 3. Request path: one user message

1. **Client.** `apps/native/lib/client/transport.dart:197` posts `{schemaVersion, commandId, text}` to `POST /api/bots/{botId}/turns`.

2. **Gateway.** `apps/cloudflare/src/gateway.ts`, the Worker's `fetch`. Order of dispatch in `createGateway` (`:706`): client-compatibility refusal, native-auth routes, `/api/auth/*` to better-auth, the Applet socket, `/sign-out`, the debug route, public Package routes, then identity resolution — native bearer token, development identity, or a better-auth session — then the signup admission check (`:801-830`), then authenticated Package backend contributions.

3. **Per-user application isolate.** Unmatched requests fall through to `routeUserApplication` (`:612`). It resolves the user's `applicationHash`, then `dependencies.loader.get(workerId, ...)` loads that artifact from R2 into a Worker Loader isolate whose `env` holds `BOT_STATE` — a Durable Object stub already scoped to the user — plus `DEPLOYMENT` (`:633-646`). The client's `x-frockbot-user-id` header is deleted before forwarding (`:650`); the gateway sets `x-frockbot-deployment`, `x-frockbot-auth-session-v1` and `x-frockbot-is-admin-v1` itself. Authorization is established here and passed downward as capability; nothing below re-verifies it.

4. **Application.** `apps/cloudflare/src/user-application.ts:719` matches the turn route; `:1093` calls `env.BOT_STATE.run({schemaVersion, botId, command: {runId: commandId, sessionId: "<userId>:<botId>", acceptedAt, text, skills?, supersedes?}})`. The session id is derived server-side. The command decoder accepts exact keys only, so a client cannot name a turn type; an absent turn type means `chat`.

5. **Bot Durable Object.** `apps/cloudflare/src/bot-state.ts:1168` `run()` decodes the envelope, materializes the identity and calls `shell.run(...)`.

6. **Shell.** `app/shell/turn.ts:88` `run()` yields any in-flight compaction, calls `followDeploymentComposition()` and `resolveAppletComposition()`, then delegates to `BotDurableAuthority.run` (`core/durable/authority.ts:293`): recover whatever the object holds, check for a settled replay, then `acceptRun`. An accepted run executes inline; otherwise it is durably queued — one user-lane slot, FIFO agent lane — and promoted by `runQueuedRun` (`:332`).

7. **Mount.** `activateCompositionV1` reads the pin and builds the Turn's runtime through `createShellCompositionHost` (`app/shell/backend-composition.ts:274`).

8. **Loop.** `executeResidentBotTurn` (`app/shell/backend-runner.ts:431`) calls `runtime.execute(...)`, then `agent.send({text, skills})` and awaits `whenIdle()`.

9. **Model.** Inside the loop, `ctx.llm.stream(request, signal)` dispatches to a provider, which issues the HTTP request (§7).

10. **Tools.** `ctx.tools.prepare` then `ctx.tools.executePrepared`.

11. **Return.** The POST returns the settled turn. Live updates arrive on a separate WebSocket, `GET /api/bots/{botId}/state-channel?version=1&cursor=N` (`apps/cloudflare/src/gateway.ts:894`). That channel carries invalidation notices, not content; the client re-reads over REST. Notices are coalesced and throttled per interval (`apps/cloudflare/src/bot-state-channel.ts:245-265`).

---

## 4. Agent loop — `core/agent-loop/`

The Turn's state machine lives in `index.ts`; the external work it dispatches lives beside it, reached through the `LoopRuntime` seam in `runtime.ts`. `model-request.ts` owns provider dispatch and stream consumption, `tool-execution.ts` tool calls, `resume.ts` the replay of a durable log, `errors.ts` the classified failures.

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

- `TURN_DEADLINE_MS_V1` — 15 minutes, defined in `@frockbot/core/contracts` and re-exported here, because the Durable Object also reads it to decide whether a run still marked `running` can be running.
- The deadline aborts the same `AbortController` that Stop uses; `#turnDeadlineReached` distinguishes them, and its branch is evaluated first so a Turn the clock ended is reported as timed out rather than as one the person stopped.
- `MODEL_REQUEST_ATTEMPTS_V1 = 2` — first attempt plus one retry, for an unknown failure.

### Event log

Types written: `input/queued`, `turn/start`, `composition/pinned`, `turn/admission`, `input/admitted`, `step/start`, `user/message`, `model/request`, `model/usage`, `assistant/chunk`, `assistant/message`, `model/response-failed`, `model/response-format-note`, `model/retry`, `tool/call`, `tool/result`, `step/end`, `turn/end`.

One `model/request` is written per _dispatch_, all carrying the same request. The count of them under one `requestId` is the number of times that call was sent, and each one marks the point where the answer so far starts again — which is how a partial reply is projected after a re-issue.

Persistence is `SessionEventLog` (`core/durable/session-event-log.ts`) into Durable Object key-value storage: 256 KB pages, 16 KB inline threshold, 8 KB excerpts, payloads chunked at 128 KB.

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

Composition is the untrusted layer and nothing else. First-party Packages are ordinary imports: `app/packages.ts` lists the 29 the deployment ships as `PackageDefinitionV1` records, and a Package that carries data (settings, Capabilities, Connection Types, durable roots, dependencies) exports its own definition from its own package. There is no manifest, no compiler and no application hash over a plan.

1. On first use the Bot Durable Object receives an empty bootstrap generation (`app/shell/backend-composition.ts`; `core/durable/composition/generation.ts`). A Bot that has installed and authored nothing composes nothing, which is why a release no longer has to rewrite every Bot's generation to follow the deploy.
2. At admission, `activateCompositionV1` (`app/shell/turn.ts:299`) reads the pin, mounts, verifies, commits and records last-known-good.
3. Mounting builds one runtime per Turn (`backend-composition.ts`): the registries, a `LoopHookListV1`, and the features the host lists, mounted in that order by `mountRuntimeFeaturesV1`. Neither the Shell nor `app/agent-runtime.ts` imports an application: the Shell's Bot host carries the deployment's `PackageDefinitionV1` list, its one Package version, and four factories — `base`, `hosted`, `enabled`, `model` — that turn a Package id into a mounted feature (`app/shell/backend-runtime.ts`). `app/runtime.ts` fills them in as `foundationShellApplicationV1`, and `apps/cloudflare/src/bot-state.ts` spreads that into the host. The base Packages — identity, the built-in model, the two demo tools and the Shell's own voice — are appended last, so a provider an earlier Package registered is already there. Every member goes through `BotIsolateContributionHost`, whose hooks are appended to the same list after the app's. Applet members register as tools routed to `APPLET_STATES`.

### Generation shape

`CompositionGenerationV1` — `core/durable/composition/generation.ts`:

```
{ schemaVersion: 1, generationId, artifactSetHash, parentGenerationId?,
  summary?, createdAt, origin, members[], applets?, status }
```

- `status ∈ pending | active | superseded | failed | quarantined`.
- `origin ∈ bootstrap | bot-authored | revert`.
- `members[]` is `{packageId, version, provenance, artifact, descriptor}`; `provenance ∈ user | bot`. Every member is untrusted, so the artifact and the Frock Compose descriptor are required, not optional.
- `artifactSetHash = sha256(canonicalJson(members sorted by packageId))`, or over `{members, applets}` when Applets exist.
- `generationId = "<createdAt>:<artifactSetHash[0..16]>"`.
- Caps: 64 members, 64 applets, 64 applet tools, 160-character summary.

### Where the pin lives

`DurableCompositionStore` (`core/durable/composition-store.ts:74`) writes into the Bot Durable Object: `composition:current` (a `{generationId, artifactSetHash}` pin), `composition:generation:<id>`, `composition:index:<createdAt>:<id>`, `composition:last-known-good`, plus failure, failure-count and quarantine keys. Pinning is compare-and-swap; a lost race raises `CompositionPinConflictError` and the caller re-reads and re-derives (four attempts).

An in-flight Turn keeps the generation it pinned. Activation takes effect at the next admitted Turn.

### Activation and failure — `core/durable/composition/activation.ts`

Failure phases are `resolve | bundle | mount | health`, declared beside the activation that records them (`core/durable/composition/failure.ts`) and raised by the host the app supplies. `activateCompositionV1` reads the pin, mounts and verifies, then commits and clears failures. On failure it records the attempt, marks the generation `failed` or `quarantined`, mounts last-known-good, notifies, and admits the Turn on the fallback. The quarantine threshold is three attempts; a quarantined generation is never retried. If last-known-good is itself the failing generation, the error is rethrown.

### Isolate loading — `frock-compose/isolate-host.ts`

- Loading uses the `BOT_PACKAGES` Worker Loader binding, typed structurally as `BotIsolateLoader` (`:72`). There is no dynamic `import()`.
- `loader.get(loaderId, () => ({compatibilityDate, mainModule, modules, globalOutbound: null, env: {IDENTITY, CAPABILITIES}, limits: {cpuMs: 5000, subRequests: 5}}))` (`:434-455`).
- The loader id is `isolateLoaderIdV1({userId, artifactSetHash: botIsolateModuleSetHashV1(artifactContentHash, bindingDigest, grants)})`. The module-set hash covers wrapper version, wrapper source hash, package hash, binding digest and the member's declared grants, because a loader id is served from cache with the `env` it was first loaded with.
- Artifacts come from `createR2PackageArtifactStore` (`app/isolates/capabilities.ts`): R2 key `packages/<contentHash>.mjs`, sha-256 verified before load.
- `BotIsolateContributionHost.prepare` first refuses a descriptor naming a grant, action or slot this deployment has not opened, then loads the artifact, mounts and calls `entrypoint.health()` as one guarded phase, requiring `health.ok`, non-empty tools, a matching `packageId`, and tool and hook names equal to the descriptor's. Per-tool turn admission comes from the isolate's own health report.
- `BotCapabilities` (`apps/cloudflare/src/bot-capabilities.ts:68`), a `WorkerEntrypoint`, is the loopback through which an isolate reaches the kernel. It is minted per Turn by `isolateMountOptions` (`app/isolates/bot.ts:99`).

### Built-in versus dynamic

First-party code is never a Composition member: it is imported, and `app/packages.ts` is the list that says it exists. A member is untrusted by definition and always carries an artifact and a descriptor.

Nothing produces a member today. The isolate host, the `BOT_PACKAGES` loader and the capability contract are all still here and still exercised by the Applet instance path and the isolate probe; a _Package_ artifact returns with the step 8 build service (`plan.md`).

---

## 6. Clients

There is one client. `apps/native` is a Flutter app; built for the browser it is
what `bot.frockbot.com` serves, and built for Android or macOS it is the same
Dart on a device. The two differ only at four conditional-import seams — the
HTTP client and the state-channel socket, the credential, the sign-in door and
the durable store — so what differs between the two is the platform's doing,
never the product's.

`apps/native/qualification.json:2` still records `"status": "unqualified-prototype"`,
and that is about the device: `.github/workflows/native.yml` is advisory
(`continue-on-error: true`), builds no APK or IPA and has no release job, and
`apps/native/android/app/build.gradle.kts` refuses a build without a value read
off a connected phone. The web build carries no such caveat.
`ci.yml`'s `validate` installs the pinned SDK and `bun run build` reaches
`flutter build web`, so a client that does not compile for the browser fails a
required check, and the browser end-to-end suite drives the same build.

### Served on the web

`apps/cloudflare/build-flutter-web.ts` runs
`flutter build web --release --pwa-strategy=none --no-web-resources-cdn` in
`apps/native`, drops what no
browser asks for (the engine's `.symbols` maps, Flutter's own `index.html`, the
PWA manifest and its icons, and the service worker `--pwa-strategy=none` leaves
empty), hashes every remaining file's path and contents into one build hash, and
stages the payload under `apps/cloudflare/dist/web/_flutter/<buildHash>/`. It
writes a `_headers` file marking everything under the prefix `immutable` for a
year, and records the hash in `apps/cloudflare/dist/flutter-web.json`.

That directory is the app Worker's `assets` binding
(`apps/cloudflare/wrangler.jsonc:27`, and again in `development` (:176),
`staging` (:300) and `e2e` (:415)). The payload is uploaded with the deploy and answered by the asset router before the
Worker runs, so it needs no route, no bucket and no seeding step, and the same
`wrangler dev` that runs the Worker locally serves it. `html_handling` and
`not_found_handling` are both `"none"`: the document is rendered per account, so
an asset directory that answered `/` or invented an index would answer for it.
`PUBLIC_ASSET_PATHS` (`apps/cloudflare/src/gateway.ts:52`) is `/` and
`/favicon.ico` only — no request for the client's own bytes ever reaches the
gateway.

The document is `appHtml()` (`apps/cloudflare/src/user-application.ts:117`).
`build-artifact.ts` defines `__FROCKBOT_FLUTTER_BUILD__` from `flutter-web.json`
and `__FROCKBOT_CLIENT_ICON__` from the brand icon; those two are all the
artifact carries of the client. The page is a
`<base href="/_flutter/<buildHash>/">`, four `data-frockbot-*` body attributes
and one `<script src="…/flutter_bootstrap.js" async>`. Every engine URL is relative to that base, so a new client build is a new path
rather than a new body at an old one, and the document is the only thing that
changes when the client does.

Identity is handed over in the document. A browser's session is a cookie it
cannot read, so the Worker stamps the account onto `<body>` —
`HOSTED_EMBEDDED_BODY_ATTRIBUTES_V1` (`user-application.ts:111`):
`data-frockbot-user-id`, `data-frockbot-auth-mode`, `data-frockbot-is-admin` —
and `bootstrapUserIdV1()` (`apps/native/lib/client/identity_web.dart`) reads
them on the first frame, so `restore()` (`apps/native/lib/main.dart:107`) paints
the shell instead of flashing the sign-in door at someone who is already signed in.
The `/api/identity` read still happens; the attributes are what it confirms.
`identity_io.dart` returns null, because the phone is handed no document.

The app origin's policy is `withSecurityHeaders` (`user-application.ts:147`).
Two relaxations belong to the engine and neither is avoidable:
`script-src 'wasm-unsafe-eval'`, because CanvasKit instantiates WebAssembly, and
`style-src 'unsafe-inline'`, because the engine injects a `<style>` element to
measure text.
`img-src` allows `data:` and `blob:` for what the app decodes itself, and
`base-uri` is `'self'` rather than `'none'` because the document sets a `<base
href>` of its own. All of this is the app origin's alone — the artifact origin,
where untrusted pages live, keeps `default-src 'none'` (`gateway.ts`) unchanged.
CanvasKit is built local (`--no-web-resources-cdn`) so `script-src 'self'` stays
true and no engine byte is fetched from gstatic.

There is no service worker. Every URL under the prefix is content-addressed and
served `immutable`, so a cache the page managed itself would duplicate the
browser's with a second staleness rule to get wrong.

### The app

`lib/main.dart` is the app entry and the sign-in door and nothing else: the
`MaterialApp`, the session, and the `?bot=` deep link, which it hands to the
shell through a `ValueNotifier` rather than acting on. Everything a person
looks at is `lib/shell/`.

**The shell layout.** `lib/shell/desktop_layout.dart` has three tiers at two
widths. Above 980 points the shell is three columns — the Bot list, the
conversation, and the right panel. At or below 980 the right panel becomes a
drawer over the conversation; at or below 640 the Bot list goes the same way and
the conversation has the window. A region is a column or a drawer, never both,
so nothing is built twice; a parked drawer is
inert to the pointer, to assistive technology and to its own tickers, and one
scrim serves whichever drawer is open.

**The slot registry.** `lib/shell/slots.dart` is where a feature reaches the
shell: three named regions — `right-panel`, `overlays`, `header-actions` — that
a feature registers a `WidgetBuilder` into and the shell draws where the region
belongs. An empty region draws nothing, so the layout reserves no space for a
feature that is not there. Trust chrome is never
a slot: the transcript, the composer and the Bot list are the shell's own.

**Semantics identifiers.** Flutter Web draws to a canvas, so a browser spec can
only select the engine's accessibility tree. Every interactive widget carries a
`Semantics(identifier:)` whose name is written once in
`lib/shell/semantics.dart`, and Playwright selects on
`[flt-semantics-identifier="chat-composer"]`.

Screens (no router; `MaterialApp(home:)` plus `Navigator.push`):

- `FrockBotApp` — `lib/main.dart:31`, `ThemeMode.dark` hardcoded
- `SignInPage` — `lib/auth/sign_in_page.dart:5`
- `AppShell` — `lib/shell/app_shell.dart`: the directory, the identities the
  sidebar groups by, the unread fan-out, the drawers and the slot registry
- `ShellSidebar` — `lib/shell/sidebar.dart`: pinned tiles in pin order, label
  groups, unread badges, hidden Bots, search, create and the profile sheet
- `ChatPane` / `ConversationView` — `lib/shell/chat_pane.dart` over
  `lib/shell/transcript.dart`, `composer.dart`, `markdown.dart`,
  `send_payload.dart` and `skill_menu.dart`
- `RunView` — `lib/shell/run_view.dart`: a Turn's tool receipts, on the right
  panel at wide widths and as a page on the phone. The thread never names a
  tool; it offers one control that opens this.
- `ActivityPage` — `lib/activity/page.dart:9`
- `BotRecoveryPage` — `lib/recovery/page.dart:11`, detail with three tabs at `:202`
- `SettingsPage` — `lib/settings/page.dart`: a host over `ViewDocumentView`,
  not a renderer of its own. `ModelPicker` at `lib/settings/model_picker.dart`
  is the host editor for the one field whose choices are a paged catalog.
- `BotSettingsView` — `lib/settings/bot_settings.dart`: one Bot's identity,
  notifications and model, in the `right-panel` slot at wide widths and a
  page on the phone
- `ConnectionsPage` — `lib/connections/page.dart`: a host over
  `ViewDocumentView` for the accounts a User authorizes once for every Bot
- `PluginsPage` — `lib/plugins/page.dart`: the same host over the Plugins
  document, plus the controller that carries enablement to the settings route
- `AdminPage` — `lib/admin/page.dart`: the deployment's signups switch, over
  `/api/admin/policy`
- `RoutinesView` — `lib/routines/page.dart`: what a Bot does on its own and
  what it left behind, in the `right-panel` slot beside Bot settings and a page
  on the phone. `RoutineRunsPage` (`lib/routines/runs.dart`) is one Routine's
  firings, and one firing opens on the Work view.
- `AuditPage` — `lib/audit/page.dart`: every effect a Bot performed, filtered
  by kind, with an audited effect's Turn opening on the Work view
- `SearchOverlay` — `lib/search/overlay.dart` over `lib/search/controller.dart`:
  the backend index across every Bot, debounced, with each of its four states
  named
- `CreateBotSheet` — `lib/flock/create.dart`: a sheep, a name and the first
  thing to say to the Bot, opened from the sidebar's own create gesture
- `MachinesPage` — `lib/machines/page.dart`: a host over `ViewDocumentView` for
  the computers a Bot may reach, plus the pairing code the host holds
- `TemplatesPage` — `lib/templates/page.dart`: the same host twice, a tab
  apiece — what this Bot is packed into, and what this account has imported
- `AppletCanvas` — `lib/applets/canvas.dart`: the Applet directory, its focus,
  the building states and the live Applet, in the `right-panel` slot beside Bot
  settings and a page on the phone
- `ComputerCard` → `ComputerViewerPage` — `lib/computer/card.dart`: the Bot's
  screen, live or as its last capture, and the full-window viewer it opens
- `PackagePageFrame` — `lib/packages/frame.dart`: a first-party or Bot-authored
  Package page, in Bot settings and behind a header entry
- `ViewSamplePage` — `lib/view/sample_page.dart:117`, reachable only from a `--dart-define=FROCKBOT_DEV_AUTH=true` build

The thread's rules were ported from the Vue shell without change and with its
tests, and are unchanged since: a Turn is ordered as a unit by its own user
message's stamp (`transcript_model.dart`), the working row says the previous
reply is being
stopped only while a supersede drains, a draft belongs to the Bot it was typed
for and survives a refusal (`composer.dart`), and readiness and the draft are
separate questions so Try again works with an empty composer.

Transport is REST over `package:http` behind a conditional import (`lib/client/transport.dart`, `transport_io.dart`, `transport_web.dart`). `--dart-define=FROCKBOT_ORIGIN` names the gateway; left unset it is `https://bot.frockbot.com` on the phone, which has no origin of its own, and `window.location.origin` in the browser, which is served by the gateway it talks to and may be on any port. There is one read-only WebSocket at `/api/bots/{botId}/state-channel` (`:167`) with a strict `cursor + 1` contiguity rule (`lib/client/state_channel.dart:69-82`), a 4096-byte frame cap and 1–30 s backoff.

On the phone, auth is PKCE in the system browser (`lib/client/auth.dart:17`), returning over an App Link validated in `accept()` (`:60`); the session token lives in `flutter_secure_storage`, and the directory, drafts, cached transcripts and cursors are plaintext JSON on disk (`lib/client/plain_store.dart:13`, `:97`). In the browser the same seams are the hosted better-auth Google redirect (`auth_web.dart`), a cookie the client never sees, and `localStorage` (`plain_store_web.dart`).

`lib/protocol/client_wire.generated.dart` (987 lines) is generated by `scripts/generate-dart-protocol.ts:119` from `core/protocol-schemas/schema/client-wire.schema.json`. Its classes wrap an opaque `Object? _json` and validate; they are not typed models, so call sites index by string.

A framed web page is `lib/view/host_frame.dart`, one seam over two implementations: on the web a platform view over an `<iframe>` sandboxed to `allow-scripts` (plus `allow-same-origin` only where the document must keep its origin), and on the phone a WebView with every one of those guarantees set by hand. Neither ever receives the app session; a page is loaded anonymously and told who it is by `postMessage` afterwards.

Every payload is validated against the shared schema (`lib/protocol/client_wire.generated.dart`), on both platforms, because there is no second decoder to disagree with.

**Settings, through the renderer.** The server describes settings as a
`SettingsFrame` and projects that frame as a `ViewDocument`
(`app/settings/settings-document.ts`), which the two settings routes return
when the request asks for `?as=document`. The frame is unchanged and still the
authority; the projection is a read of it. Two conventions carry the frame's
extra meaning through a vocabulary that has no room for it: a projected field
id is `f<section>.<id>`, or `j<section>.<id>` when the value travels
JSON-encoded, and an action's declared `input` names the section it saves and,
for a section action, its kind. `apps/native/lib/settings/document.dart` reads
both back, turning the action the renderer assembled into the
`SettingsChangeCommand` the route already takes — which is how
`ViewController.dispatch` reaches a real route. The projection stops at the
renderer's budgets rather than emitting a document the host would refuse: a
section past the 32-action cap renders read-only and says so.

A field whose `choiceSource` names a paged catalog is drawn by the host, not by
the document: `ViewScope.fields` maps a `choiceSource` to a host editor the way
`ViewScope.frames` maps an `embed` name to a host region, and the settings
surface is what supplies the model picker.

**Connectors and Plugins, the same way.** Two more projections in that family,
both reached with `?as=document`:

- `app/settings/connections-document.ts` over `ConnectionsFrame`
  (`/api/settings/connections`). The frame carries what the web surfaces
  assembled client-side from the catalog and the User's settings: a provider
  row per Connection Type — its authorization kind, whether another account may
  be connected, and the settings the type declares beside its credential — the
  accounts themselves with the line that says what their state means, and the
  "Model in use" line, written by `modelRuntimeLabel` where the settings live
  rather than in a client. A model provider's accounts and a connector
  Package's are one document, because the surface a person opens to connect
  something is one surface; `packageConfigurationHomeV1` still decides which,
  and travels as the row's `kind`.
- `app/settings/plugins-document.ts` over `PluginsFrame`
  (`/api/settings/plugins`), which is enablement and nothing else: a row says
  what a Package offers, whether it is on, and which surface configures it.

Every action on both declares a `kind` from a closed vocabulary, because an
action id is opaque to the renderer and the command a press means is not
derivable from its label. `apps/native/lib/connections/document.dart` and
`lib/plugins/document.dart` read those back; Connectors is the one surface
whose actions do not all land on one route — a Connection command goes to
`/api/connections`, a revocation to the Package's own route, and a hosted grant
is a `connection/start` whose answer is a URL the app opens after checking it.

`lib/view/surface.dart` is what both pages are: `ViewSurfaceController` is the
read and the dispatch, `ViewSurfacePage` is the chrome, the empty state, the
pull to refresh and the one `ViewController` per revision. A page is a
controller and a title.

**Secrets, through the renderer.** `SettingField` has a `secret` kind. The
document seeds it null, so a required key refuses by name before anything is
dispatched; the widget is `obscureText` and has no initial value, so it starts
empty however often it rebuilds; and the typed characters travel only on the
action input that carries them to the credential route, after which
`ViewController` drops them. Nothing about a credential is ever in a document
the server sent.

**Routines and Audit, the same way again.** Two more projections in that
family, both reached with `?as=document`:

- `app/routines/routines-document.ts` over a `RoutinesFrame`
  (`GET /api/bots/:botId/routines`, the one route in that group that takes a
  query parameter at all). The frame is one read where there were two —
  the Routines a Bot holds and the completion inbox the header badge counts —
  because a client that had to ask twice could show a list and a badge that
  disagreed. Five action kinds: three Routine commands the route already takes,
  the inbox command on the inbox route, and the run log, which
  is navigation and belongs to no route.
- `app/audit/audit-document.ts` over an `AuditFrame` (`GET /api/audit`). Four
  kinds: the filter and the page, which the host owns because the host owns
  the read; the rebuild command; and opening an audited effect's Turn on the
  Work view. The projection infers nothing — an effect whose outcome the
  durable log does not know is drawn as "Outcome unknown" in the same place a
  success would be.

Neither frame carries a revision the way `SettingsFrame` does, and neither
command fences on one: a Routine is its own durable record, so an unrelated
edit must not make a Routine write conflict, and an audit page is a projection
of facts the Bots already hold. Each projection derives a revision from its own
bytes instead — FNV-1a over what the document says — so `ViewSurfacePage`
adopts a fresh controller exactly when what it is showing has changed and keeps
the one it has when nothing did.

The `right-panel` region now shows one entry at a time rather than stacking
every registered builder: an entry registers with a label, the region draws a
selector over them, and `ViewSurfacePage`'s `chrome` flag is off inside it
because the region already carries the title. On the phone each entry is a page.

**The rest of PR 8.** The completions badge is `RoutineInboxBadge` in the
`header-actions` region: a Routine firing has no `send_to_user` and its Turn is
filtered out of the visible transcript, so a count is the only place a
completion becomes visible. "Mark all read" means the
entries the document carried — an empty `entryIds` on the wire acknowledges
everything, including a firing that landed a second ago and has never been on
screen.

Search is `lib/search/`, over `GET /api/search`, and replaces the Bot-list
`SearchDelegate` the shell cut left, which could only match a name the sidebar
already held. Every state is named — nothing typed, nothing found, rebuilding,
truncated — and a chosen hit opens its Bot and brings its Turn into view;
`ChatController.focusRunId` carries that as far as the loaded page reaches, and
a Turn further back is simply absent rather than pretended at.

Each Bot has one continuous chat Session, addressed by User and Bot id. Automatic
compaction bounds model context; there is no conversation creation or switching
API. Older extra conversations are no longer exposed. The owner accepted their
removal without migration on 2026-09-08.

The native header has two rows: Bot identity and direct Bot settings above,
Computer, Routines and the account-wide Applets directory below. Bot messages
have no avatar or tool-count row; the in-chat avatar is reserved for the working
indicator and its comet trails. Message long-press opens work details or records
“Mark unread from here”. That boundary names a validated chat message in the
Bot-owned unread record, is included in the command fingerprint and receipt,
and is projected to the native transcript after reconnect. An explicit mark-read
clears it. Applets and Computer continue through their existing backend surfaces;
header navigation adds no authority or credentials.

Session announcements such as rename and compaction remain system lines,
projected by `projectAnnouncements` and ordered by their recorded timestamps.

**PR 9: the Flock, and three more projections.**

`lib/flock/` is what a Bot looks like and what may be done to one.
`sheep.dart` draws the avatar from two bundled layers — a background and the
canonical sheep, the seven WebPs `apps/native/assets/sheep/` carries — and the
same sheep is drawn wherever a Bot is: the sidebar row, its pinned tile, the
thread, the working row and Bot settings, each from the `sheep.background` the
directory already returns. Wearables are deferred, so the background is the
whole of the choice a person makes and `defaultSheepRecipeV1` pins the other
three bands to the catalogue's neutral roots — a Bot this app creates is still
one the wardrobe can dress when they return.

`create.dart` is the sidebar's create gesture, which no longer hands off to
Manage Bots, and `SheepColourSheet` beside it is the wardrobe's edit half — the
one thing left of the wardrobe under the single-default-avatar rule — reached
by pressing the avatar in Bot settings and fenced on the sheep revision the read
just reported rather than one held since the sheet opened. The command is written to the durable store before it is sent and
cleared only once the authority has answered it, so a lost reply finishes the
Bot that was asked for rather than making a second one; a 409 is not a failure
but a re-fence on the revision it reported, under the same `commandId`. The
first message, when there is one, goes through the same `BotSession` the
conversation uses, so a new Bot's first Turn is admitted exactly as every other
one is.

`lifecycle.dart` is one retained `BotLifecycleCommand` per account, whichever
surface issued it — `BotDangerZone` inside Bot settings' Advanced, or Manage
Bots, which now shares it rather than keeping a second copy. The zone is
contributed by the Flock rather than rebuilt inside the settings surface,
because the directory a delete changes is the Flock's. The route answers
`pending` for a saga that has not settled, which is why the zone locks rather
than offering a second command.

Three more projections in the settings-document family:

- `app/machine/machines-document.ts` over the registry
  (`GET /api/machines?as=document`). Two kinds: registering a machine, and
  revoking one. A revoked machine says so rather than that it is connected —
  its next poll is a 401 — and is not counted among the registered.
- `app/bot-template/templates-document.ts`, two documents rather than one,
  because they are two surfaces: what this Bot is packed into is per-Bot and
  what this account has imported is not. Which Bot a pack is of is never in a
  document — the host is showing one and names it when it turns the press into
  a command, the same way the Routines host does. Import stays two-phase: a
  plan is a pure read whose `commandId` becomes the `importId` the apply names.
- The Routines document grows an editor. One form, seeded by the read — a new
  Routine, or the one `?edit=` names — because a form per Routine would be a
  second copy of every prompt in the document and would spend one of the
  thirty-two declared actions on each of them. Which form is open is
  navigation, so it is asked for on the read and written nowhere, and naming a
  different Routine moves the revision so the host adopts a controller whose
  field values are answers to the form now on screen. A webhook Routine also
  gets its two key controls, and only a webhook one: the route refuses a key
  for a scheduled Routine, so the control is absent rather than offered.

**A secret the authority minted once is never in a document.** A webhook key
and a pairing code are each signed once, stored only as a digest and answered
on a receipt; a document can be read twice, so neither can be in one.
`ViewSurfacePage` gained one seam for exactly this — a `banner` the host draws
above the document — and the two surfaces hold their secret there for as long
as the person is looking at it and nowhere else. It is the same reasoning
`SettingField.secret` already carried, from the other direction.

Creating a Bot and its danger zone are host chrome rather than projections, and
deliberately: the sheep is bundled art rather than an `embed`'s https image,
the create command fences on a directory revision `ViewController` has no way
to express, and the lifecycle receipt has a third state — `pending` — that a
view action's two do not.

**PR 10a: Applets, the Computer and Package pages.**

`lib/applets/` is the Applet canvas, over the Applet routes of §8. Two states
and the transition between them: the source as the Bot writes it, and the live
Applet arriving over it once a generation is active. `progress.dart` is the sentence in between — a projection
of the thread the client already holds, taking the furthest step it has evidence
for across every Turn rather than only the open one, and recognising the
`applet` CLI's own stated output rather than guessing at a command.
`failure.dart` classifies a caught read once, into a sentence and a retry
policy: a network that might come back is retried on a widening backoff, and a
deployment that cannot sign a viewer token is not retried at all.

`lib/computer/` is the Computer card and its full-window viewer: the
projection, one versioned command per action, and the two rules the card needs —
whether the desktop or its last photograph is on screen, and what to call that.
The card streams only a desktop that exists, to a card someone is looking at,
while the Bot is working or has just stopped; every other answer is the stored
capture, which costs nothing to hold. Taking control is two gestures, and only
the second reaches the Bot.

`lib/packages/` is the entry projection and the postMessage bridge.
`catalog.dart` is the entry read over `/api/bots/:botId/package-ui`;
`frame.dart` is the frame host — the handshake, the theme tokens, the
named state feeds, and a page's five messages back, each refused against what
its Package declared rather than trusted. On the phone the page is its own
`parent`, so what it posts raises a `message` event on the same window and a
forwarding listener carries it over a channel; the host's own messages are
dropped there rather than handed back as if a page had said them.

**Why these three are host chrome and not projections.** Each of them holds a
credential minted per reader — the Applet viewer token, the Computer's bearer
viewer URL — and a document can be read twice. That is the rule PR 9 arrived
at from the other direction, and it settles the shape here: the host holds the
credential, the host frames the page, and what a plugin may say about either is
the name of a region.

The Applet canvas frames the Applet's own page directly rather than nesting it
inside the Applets Package's `canvas` page as the browser does. The middle
document existed because the browser host had no way to reach across an origin
into a grandchild frame; a Flutter host is the frame's parent and hands the
`init` over itself, so the second document buys nothing.

**Deleted with this change.** `lib/extensions/fallback.dart`,
`apps/cloudflare/src/native-fallback.ts` and its gateway route, the
`/api/native/applets/:id/bootstrap` route and the `nativeAppletBootstrap` RPC
behind it, and `FallbackBootstrap` from the wire schema. The phone reaches an
Applet the way every other client does.

### ViewNode — how a plugin renders

A plugin does not ship UI. It returns a `ViewDocument` and the host draws it, which is what keeps trust chrome out of a plugin's reach.

`ViewNode` is a discriminated union on `type` in `core/protocol-schemas/schema/client-wire.schema.json`, over exactly six types:

| Type     | What it is                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `text`   | Prose, a heading, a label or a status line — `style ∈ body \| heading \| label \| status`                       |
| `group`  | A container: `orientation ∈ row \| column`, an optional title, an optional collapsed state, and children        |
| `field`  | One typed input bound to a key: the existing `SettingField`/`SettingChoice` shapes, unchanged                   |
| `action` | A button naming a declared action id, with an optional literal input map                                        |
| `list`   | Rows, each with an id, a child node, an optional action id and a selected state                                 |
| `embed`  | A host-owned region: `kind: image` with an https source, or `kind: frame` naming a region the host draws itself |

`ViewDocument` is `{schemaVersion, surfaceId, revision, root, actions}`, where `actions` is `{id, schema: ActionSchema}` pairs. An action's submitted input is the node's declared map overlaid with the current value of every `field` whose id the action's schema names; a key the schema does not declare never travels, and a missing required key refuses before dispatch.

`embed`'s frame names are the host's, not the plugin's: `applet-viewer` and `computer-viewer` (`apps/native/lib/view/embed.dart`). A `HostViewFrames` scope is what a host surface puts in one — the Applet canvas fills `applet-viewer`, the Computer card fills `computer-viewer` — so a region a plugin names is drawn by whichever host surface is above it and by nothing at all elsewhere, where it stays the trust-neutral reserved region. A name this host does not offer draws the unavailable one. `ui.bot.frockbot.com/packages/<sha256>.html` survives for the Applet's own arbitrary web page and for a Package's, both reached through a host frame.

**Budgets**, checked by `ViewDocumentView` before it builds a widget (`lib/view/budgets.dart`): 512 nodes, depth 16, 262,144 bytes. A document past any of them is refused whole rather than half-rendered. The schema's own shape caps are separate — 256 children per `group`, 256 rows per `list`, 32 declared actions.

**The plugin declaration.** `PluginDescriptorV1.views` is `{slot, surfaceId}[]` (`core/contracts/plugin-descriptor.ts`), account-scoped, with `PLUGIN_SLOTS_V1` as the slot vocabulary and at most 16 entries with distinct surface ids. Rendering is not wired into the isolate host yet; that lands with the surfaces that use it.

The renderer is `apps/native/lib/view/`: `budgets.dart`, `action.dart` (input assembly and the retained command envelope), `document.dart` (`ViewDocumentView`, `ViewScope`), `nodes.dart` (one widget per node type), `embed.dart` (the frame registry) and `sample_page.dart` (a development-only page, so the renderer can be looked at on a device before a plugin produces a document).

---

## 7. Model providers

`ctx.llm` is `LlmRegistry` — `core/models/llm.ts:15-40`. It is a `Map<providerId, LlmProvider>` that dispatches on `request.provider`, wraps the call in the `modelStream` hook, then validates structured output. The kernel-declared interfaces are `LlmProvider`, `ModelInvocation` and `ModelProviderRegistration` in `core/contracts/model-invocation.ts`.

Stream events (`core/contracts/types.ts:158-166`): `text-delta`, `tool-call`, `usage`, `response-format-note`, `structured-output-failure`, `finish`.

### Selection

- `resolveEffectiveBotModelV1` (`core/configuration/index.ts:652-760`): a Bot-scoped Package setting with `role: "model"`, else a User-scoped one, else `user.platformModel`. Two enabled packages both declaring a model setting is a hard conflict. A broken choice falls back to the platform model and records `fallback.from`.
- `resolveBotModelBindingV1` (`:588-621`) yields `ready`, `requires-resolution` or `unavailable`.
- The Turn resolves the effective model, refuses if it changed mid-reply, and mounts the provider plugin itself as a runtime Package for that Turn (`app/shell/runtime-mount.ts:476-530`). The resulting `modelSelection` flows through `app/shell/turn.ts:270` → `backend-composition.ts:297` → `app/agent-runtime.ts:557-583`, where it overrides the default provider and model and becomes `AgentOptions.modelBinding`.
- Package-to-provider-type mapping is a two-entry map at `app/runtime.ts:369-419`: `@frockbot/providers/ollama-cloud/runtime` → `ollama-cloud`, `@frockbot/providers/frock-ai/runtime` → `flock-ai`. Anything else resolves to `Bot model provider "X" is unavailable` (`:1084-1089`).

### Packages

**`providers/openai-compatible`** — a shared transport library, not a plugin. Response decoding — SSE framing, tool-call accumulation, finish reason and the non-streamed body — is the Vercel AI SDK's `OpenAICompatibleChatLanguageModel`, handed the already-open stream through a loopback `fetch`; request mapping, failure classification and the deadlines stay here, because the Frock AI gateway and Ollama's native endpoint reach this seam with a stream rather than a URL. `OpenAICompatibleProvider` (`index.ts:884-967`) issues `fetch` to `${baseUrl}/chat/completions` with `authorization: Bearer`. Request planning is `planOpenAICompatibleRequestV1` (`:367-455`): `stream: true` with `stream_options.include_usage`; tools as `{type: "function", function: {...}}`; `response_format` in an `openai` dialect and a `workers-ai` dialect, degrading to `json_object` and then to prompt-injected instructions, emitting a `response-format-note` at each step. Stream bytes are capped at 1 MiB per event and 16 MiB per response before they reach the decoder. Tool calls are emitted only after the stream terminates, and a stream that ends without a terminal marker throws. Deadlines are 120 s to first byte and 60 s idle (`core/contracts/model-invocation.ts:88-131`), applied by `streamWithModelRequestDeadlinesV1` (`:852`).

**`providers/frock-ai`** — package id `provider-flock-ai`, provider type `flock-ai`. Calls Cloudflare AI Gateway through one of two transports, chosen at `apps/cloudflare/src/frock-ai.ts:132`: with an account id and token, a raw fetch to `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions` with `cf-aig-authorization` (`:55-58`, `:163-180`); otherwise the `AI` binding's `gateway(id).run({provider: "compat", endpoint: "chat/completions"})` (`:195-207`). Only the compat transport accepts a `dynamic/<route>` model. Model ids are `@frock/*` with legacy `@flock/*` normalized (`catalog.ts:30-38`); `@frock/auto` maps to the `dynamic/flock-auto` route, a concrete id to `workers-ai/@cf/...`, and a structured-output request on Auto is pinned to `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` (`:21-22`, `:92-101`). The static catalog has two entries: `@frock/auto` and `@frock/deepseek-ai/deepseek-v4-flash-0731` (`:49-56`, `:104-124`). `user.ts:192-275` bootstraps an ambient `flock-ai-ambient` Connection and sets it as `platformModel` for every User, which is what lets a new Bot answer with no configuration. `runtime.ts:224-255` tags the Agent on a permanent failure and rewrites the next request to `@frock/auto`. `reconciliation.retrieve` returns `not-retrievable` (`:133-140`). Stored ids are `flock-*`; display strings are `Frock` (`catalog.ts:3-8`).

**`providers/ollama-cloud`** — provider id `ollama-cloud`, `defaultEnablement: "disabled"`. Takes an API-key Connection and acquires a per-request credential lease against the User Durable Object before any bytes are sent (`runtime.ts:133-190`), settling it afterwards; a lease that does not match `connectionId` and `connectionGeneration` is a permanent failure. Base URL comes from the Connection setting `api-base-url`, default `https://ollama.com`, with `/v1` appended (`:74-77`). It delegates to `OpenAICompatibleProvider` (`:229-241`). Behavior forks on hostname: a non-`ollama.com` host uses native `/api/chat` with `format` for JSON Schema, while `ollama.com` reports `structuredOutput: "none"` (`:130-132`, `:278-289`). It also contributes an `ollama-cloud-web-search` tool Capability, so it is the one Package that mounts twice per Turn — handled by `mergeFoundationRuntimePackagesV1` (`app/runtime.ts:1106-1145`).

**`providers/foundation`** — provider id `foundation`, model `deterministic-v1` (`runtime.ts:8-9`). It echoes the last user message prefixed `"Built-in model: "`, or echoes tool output, and reports `structuredOutput: "none"`. It is the default in `createFoundationRuntime` and is overridden by `modelSelection`.

**`core/models`** — the registry service. Also implements `structured<T>()` by streaming with a `json_schema` response format and validating the accumulated text.

**`app/custom-models`** — `defaultEnablement: "disabled"`, and nothing but the Bot-scoped `role: "model"` setting it declares (`app/custom-models/definition.ts`). It has no runtime and no provider: enabling it is what puts the model picker in Bot settings, which the client draws from the settings document.

Adjacent, outside the loop: image generation uses Workers AI ids directly (`app/image/model.ts:40-52`, default `@cf/black-forest-labs/flux-1-schnell`).

---

## 8. Applets

### Authoring

The Bot writes Applet code with the Applets tools; no Computer is in the path. `applets/` exposes eleven tools — `applet_list`, `applet_create`, `applet_files`, `applet_read_file`, `applet_write_file`, `applet_check`, `applet_publish`, `applet_revert`, `applet_delete`, `applet_focus`, `applet_generations` — as an ordinary first-party runtime feature, `createAppletsFeature` (`applets/feature.ts`), mounted for one admitted Turn beside Memory and Skills (`app/runtime.ts`). Its host is `createAppletCapabilityHostV1` (`app/applets-host/records.ts`), wired for one Bot by `app/applets-host/bot.ts`. Source lives in the durable root `applets/source/<appletId>/` (`applets/root.ts`): `applet_create` scaffolds the SDK template into it, `applet_write_file` supersedes one file's generation, and both read and write through the one Workspace surface the Bot Durable Object holds. That root is object storage and nothing else — the Applets Package declares no root to the Computer (`applets/definition.ts`), so nothing is mirrored onto a Sprite. Guidance ships at `applets/skills/applets.md`.

The loop is `applet_write_file` → `applet_check` → `applet_publish`. A check builds and stores the artifacts without recording a generation, and answers with the tools the built code declares and a preview URL — `https://ui.<host>/packages/<uiHash>.html`, the same anonymous artifact route a published page is served from, so the hash is the whole of the capability and the page reaches no data. A failure at either verb is the build's own diagnostics, `path:line:col message`, returned as the tool result.

### Build

One pipeline, `applets/sdk/src/build/`, in five named stages: `descriptor`, `typecheck`, `lint`, `bundle`, `describe` (`pipeline.ts`). The server bundle is ESM, `platform: neutral`, with `cloudflare:workers` external. The UI bundle is IIFE, minified and inlined into one self-contained HTML page. The tool declaration is derived by booting the built Durable Object in Miniflare 5 and calling `/health` and `/describe` (`artifacts.ts`) — never by reading the source, because the kernel admits a generation by comparing the manifest to the mounted facet's own `health()`. esbuild's module path comments are rewritten to labels relative to the Applet root and the SDK root (`stableModulePaths`), so the same source hashes the same wherever it is built.

One thing runs it: `apps/applet-build`, a Worker with no routes, reached through the app's `APPLET_BUILD` service binding, fronting a Cloudflare Container with no egress. The image copies `applets/sdk` out of the repository rather than installing it from npm, so the pipeline in the image is the pipeline in the commit. Its contract is `applets/build-contract.ts` — `POST /build` taking `{version, effectId, appletId, mode, files}` and answering `{status: "built", manifest, server, ui}` or `{status: "failed", stage, diagnostics}`, with the artifact ceilings enforced in the service as diagnostics. The container holds no storage and no credential; the app Worker keeps the R2 write and the hash verification. `container/build.test.ts` posts the SDK template and builds the same source beside the service, and holds the two to the same hashes.

`applet_check` and `applet_publish` both call it in `mode: "build"`: the host lists the Applet's source prefix, reads each file, posts them with the Turn's effect id as the idempotency key, and hash-verifies the artifacts that come back against the manifest the service derived by running them. `APPLET_BUILD_TOKEN` is a required production secret.

### Storage

Source is the durable root, in R2 through the Workspace store, keyed by `workspaceObjectKeyV1` (`core/workspace-store/keys.ts`). Artifacts are R2 `APPLICATION_ARTIFACTS`, content-addressed as `packages/<sha256>.mjs` and `.html`, written by the app Worker (`app/applets-host/bot.ts`) and hash-verified on read (`apps/cloudflare/src/applet-state.ts`). A content-addressed put is idempotent by its own key, so a check followed by a publish of unchanged source stores one pair of objects. Generations, pointers and failures live in `AppletState`; the account directory lives in `UserConfiguration`.

### Execution

- **Server.** `env.APPLETS.get(...)` with `globalOutbound: null`, an env of exactly `IDENTITY` and `CAPABILITIES`, and `limits {cpuMs: 5000, subRequests: 10}` (`applet-state.ts:245-273`). The loaded class is mounted as a Durable Object facet (`:297-308`) under a snapshot, trial and commit publish protocol with `facets.clone` rollback (`:479-613`).
- **UI.** `ui.html` is served from the anonymous origin `ui.<host>` (`apps/cloudflare/src/gateway.ts:139-176`) and nested in an `<iframe sandbox="allow-scripts">` inside the Applets Package's own `canvas.html`, handshaken by postMessage, then connected over a WebSocket gated by an HMAC viewer token (`gateway.ts:434-516`).

### First-party pages

`list.html` and `canvas.html` (`applets/pages/`) are declared by a static registry, `FIRST_PARTY_PACKAGE_UI_V1` (`applets/pages.ts`): page id, digest, html, the tool names that page may call, and where it mounts. `projectFirstPartyPackageIframeV1` (`app/shell/composition-views.ts`) reshapes it for the client and `requirePackageUiToolDeclarationV1` authorizes a page's tool command against it. There is no Composition generation in either: a first-party page ships in the deployment, so there is nothing for a generation to fence. The bridge protocol (`PACKAGE_IFRAME_HELPER_JS_V1`) is unchanged — it is the page contract a Bot-authored page will reuse.

### SDK

`@frockbot/applet-sdk` exports `server`, `client`, `kit`, `lint`, `protocol` and `build`. It has no CLI and no `bin`: the service is the only thing that builds an Applet, and nothing installs the SDK on a Computer. The server API is an `Applet` base class with schema-first `tables`, `this.tool({description, input}, handler)` and an optional `migrate`. The client API is `createApplet<TServer>()` producing TanStack DB collections plus `useLiveQuery`. Wire protocol v1, JSON capped at 64 KB: `hello`, `snapshot`, `changes`, `ack`, `reject` downstream; `hello`, `mutate` upstream.

### Persistence

The facet's own SQLite inside the per-`<userId>:<appletId>` Durable Object, with additive `ALTER TABLE` migration and a 2000-row `_applet_changes` log (`applets/sdk/src/server/store.ts:32-80`). Data is account-wide and shared across viewers, survives publish and revert, and is destroyed only by `applet_delete`.

---

## 9. Computer

### What it is

A persistent Linux desktop virtual machine per User, rented from Fly Sprites (`api.sprites.dev`, SDK `@fly/sprites@0.1.0`). `apps/computer-host` is a Worker that shards and authorizes, fronting a Cloudflare Container (`node:24-slim`, no desktop) that runs the Sprites SDK.

### Provisioning

`getSprite`, and on a miss `createSprite`, named `frockbot-<sha256(["user", userId])[0..12]>` (`computer/host-runtime/runtime.ts:2718-2739`). The host then adopts an existing machine via a marker file, or provisions through a detached, resumable five-phase shell run — `layout`, `packages`, `runtime`, `browser`, `reference` — bounded at 10 minutes, at most 8 relaunches, polled every 3 seconds. Egress is restricted to one host: `enableInternet: false, allowedHosts: ["api.sprites.dev"], interceptHttps: true` (`apps/computer-host/src/egress.ts:23-27`), with a WebSocket bridge for upgrades.

### Inside the Sprite

Ubuntu 25.10 running one `Xvfb :100 -screen 0 5120x720x24`; `fluxbox`; one Chromium — Playwright 1.55's build — on CDP port 9222 with a single shared `~/chrome-profile`; a per-Bot `x11vnc -clip 1280x720+<slot*1280>+0 -rfbport $((5900+slot))`; `websockify --web=~/.frockbot/viewer` on port 6080, the only public port; a browser watchdog; and a workspace sync service.

One Sprite, one browser and one screen per User; one slot — window plus clipped VNC port — per Bot. `DESKTOP_SLOTS = 4` and `SCREEN_WIDTH = SLOT_WIDTH * DESKTOP_SLOTS`. The single browser follows from Chromium's per-`user-data-dir` singleton lock.

### Protocol

`computer/host-protocol/protocol.ts` — HTTP POST per operation with optional NDJSON streaming; not a WebSocket. The envelope is `{version: 1, effectId, identity: {userId}, tenant: {botId}, credentialRef}`. Eleven operation kinds: `open`, `exec`, `file/read`, `file/write`, `file/list`, `file/stat`, `file/delete`, `control`, `viewer`, `service`, `cancel`. Frames: `open` yields `progress | result | error`; `exec` yields `stdout | stderr | exit | error`. Requests shard to `computer-host-<fnv1a(userId) % 2>` (`apps/computer-host/src/router.ts:38-48`) and carry `x-frockbot-host-token`, checked in both the Worker and the container.

### Screenshots and live view

A screenshot is a guarded `exec` running `scrot`, clipped to the Bot's slot of the shared screen, followed by a `file/read` (`computer/fly/computer.ts:732-797`); the bytes are filed into the durable `screenshots` root and attached to the model turn. The live view is noVNC iframed directly at `https://<sprite>.sprites.app/...`, with no Worker proxy; CSP allows `frame-src https://*.sprites.app` (`apps/cloudflare/src/user-application.ts:178`). FrockBot ships its own viewer page because stock noVNC fixes `view_only` at construction.

### Tools

All from `computer/`; `computer/fly` registers none.

- `computer_exec` — `agent.ts:794`
- `computer_screenshot` — `:1309`
- `computer_doctor` — `:1507`
- `computer_process_check` / `computer_process_logs` / `computer_process_stop` — `:1579`, `:1609`, `:1648`
- `computer_browser` — `:1678`, actions `snapshot | navigate | click | fill | press | wait`, returning an accessibility snapshot over CDP

### Lifecycle

The container sets `sleepAfter: "10m"` with `max_instances: 3`. A renderer watchdog sends SIGKILL to Chromium renderer processes only, above 1.5 GiB RSS or when `MemAvailable` is under 512 MiB (`runtime.ts:601-677`). A service refresh that does not complete returns without writing the state digest, so the next `open` retries it. The Bot Durable Object arms a 60-second connect watchdog before each connect. Slots are reclaimed after 900 seconds idle unless a 90-second lease is held; with no free slot the process exits 75.

---

## 10. Storage

Bindings are declared in `apps/cloudflare/wrangler.jsonc`.

| Binding                                                                   | Kind               | Contents                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USER_APPLICATIONS` (:20)                                                 | Worker Loader      | The per-user foundation application artifact (`apps/cloudflare/src/index.ts:2229`, `src/user-configuration.ts:201`, `src/package-publication.ts:120`) |
| `BOT_PACKAGES` (:26)                                                      | Worker Loader      | Bot Package isolates, loaded with `globalOutbound` disabled (`app/isolates/bot.ts:99`)                                                                |
| `APPLETS` (:33)                                                           | Worker Loader      | Applet server artifacts, mounted as facets (`apps/cloudflare/src/applet-state.ts:94`, `:249`)                                                         |
| `COMPUTER_HOST` (:47)                                                     | Service            | `frockbot-computer-host` (`apps/cloudflare/src/bot-state.ts:465-474`)                                                                                 |
| `APPLICATION_ARTIFACTS` (:53)                                             | R2                 | Application, Package and Applet artifacts, content-addressed                                                                                          |
| `MEMORY_FILES` (:57)                                                      | R2                 | Memory and workspace file bodies (`apps/cloudflare/src/workspace.ts:126`, `:157`)                                                                     |
| `AUTH_DB` (:70)                                                           | D1 `frockbot-auth` | better-auth only                                                                                                                                      |
| `MEMORY_INDEX` (:78)                                                      | Vectorize          | Memory embeddings; the app Worker uses the binding only for deletion (`bot-state.ts:820-825`)                                                         |
| `AI` (:83)                                                                | Workers AI         | Frock AI gateway transport and image generation                                                                                                       |
| `BOT_STATES`, `USER_CONFIGURATIONS`, `DEPLOYMENT_POLICY`, `APPLET_STATES` | Durable Objects    | §2                                                                                                                                                    |

D1 schema: `apps/cloudflare/migrations/` holds one file, `0001_better_auth.sql`, defining `user`, `session`, `account` and `verification` with their indexes. All other product state lives in Durable Objects.

Durable Object storage is key-value in every class. SQLite is used only inside `UserConfiguration`, and only by the search and audit stores. Each class is declared in a `new_sqlite_classes` migration; `VoiceSession`'s v5 entry is retired by the `deleted_classes` v6 entry that follows it.

Not used anywhere in the repository: KV namespaces, Queues, Workflows, Hyperdrive, Browser Rendering, Analytics Engine, Pipelines. Containers appear only in `apps/computer-host`.

Top-level vars: `NATIVE_SLICE_2_AUTH`, `DEFAULT_APPLICATION_HASH`, `FROCK_AI_GATEWAY_ID`, `FROCK_AI_ACCOUNT_ID`, `FROCK_AI_AUTO_ROUTE`, `UI_ARTIFACT_HOSTS`. `ALLOWED_CLIENT_ORIGINS` is read but set nowhere: the web app is same-origin and the Flutter app sends no `Origin`.

Secrets are declared in `apps/cloudflare/src/production-secrets.ts`. Required (`:60-103`): `FROCKBOT_AUTHORIZATION_STATE_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SPRITES_TOKEN`, `COMPUTER_HOST_TOKEN`, `CREDENTIAL_KEYRING`, `ROUTINE_HOOK_SECRET`, `MACHINE_TOKEN_SECRET`, `APPLET_BUILD_TOKEN`, `APPLET_VIEWER_SECRET`. Optional: `FROCKBOT_ADMIN_EMAILS`, `DEBUG_TOKEN`, `FROCK_AI_GATEWAY_TOKEN`.

---

## 11. Auth

better-auth 1.7.2, configured once in `apps/cloudflare/src/auth.ts`. `bearer()` is the only enabled plugin: there is no admin plugin, no organization plugin and no jwt plugin. `trustedOrigins` is left at its `baseURL` default; `account.encryptOAuthTokens` is true. Missing secrets yield a stub that returns 503 for every route (`:64-97`).

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
4. **Computer host** — `apps/computer-host/vitest.config.ts` plus `bun test src container`. Opt-in live suites `test:live` and `test:live:desktop` are not run by CI.
5. **Playwright** — `apps/cloudflare/e2e/playwright.config.ts`, `**/*.e2e.ts`, `fullyParallel: false`, `workers: 1`, 240 s timeout, 4-way CI sharding through `balanced-shard-reporter.ts`, `webServer` of `bun e2e/serve.ts`. Roughly 28 spec files.
6. **Flutter** — `apps/native/test/*.dart` (14 files) plus `integration_test/settings_screens.dart`, which is a screenshot runner.
7. **Gate scripts** — run under `typecheck`: `scripts/check-client-protocol.ts`, `scripts/check-layer-imports.ts`, `scripts/check-computer-host-imports.ts`, `scripts/generate-isolate-context-catalog.ts --check`, `scripts/build-applets-assets.ts --check` (the SDK scaffold, the Applets Skill and the two page HTMLs, as strings the Worker bundle can carry), then `scripts/typecheck.ts`.

### `.github/workflows/ci.yml`

Triggers: push to `main`, all pull requests, `workflow_dispatch`.

- `changes` (:17) — classifies documentation-only runs through `scripts/docs-only.sh`, so ruleset-required checks report `skipped` rather than remaining pending.
- `docs` (:83) — install plus `format:check`.
- `validate` (:110) — Bun 1.3.6: `format:check`, `typecheck`, `bun test`, app `test:workerd`, app `test:integration`, computer-host `test` and `test:workerd`, Applet build service `test` and `test:workerd`, then the pinned Flutter SDK and `bun run build`, whose first step builds the web client.
- `e2e` (:189) — 4-shard matrix, `fail-fast: false`, Chromium install, `bun run test:e2e --shard=N/4`; uploads blob reports, failure diagnostics and wrangler logs.
- `e2e-gate` (:318) — aggregates the matrix into the ruleset-required check `Browser end-to-end`.
- `e2e-report` (:346) — merges blob reports into HTML on failure.
- `deploy-staging` (:367) — push to `main`, `needs: [validate, e2e]`, environment `staging`. Validates required env names, creates missing staging R2 buckets, the Vectorize index and D1, rewrites `wrangler.jsonc` in place to inject the staging `database_id` and replace `foundation-v1` with the artifact sha256, applies D1 migrations, uploads the artifact to R2, then `wrangler deploy --env staging --secrets-file`.

### `.github/workflows/release.yml`

Trigger: push of a tag matching `v*.*.*`.

- `verify` (:16) — validates strict SemVer, then `typecheck`, `bun test`, and `bun run build` behind the pinned Flutter SDK, because the build compiles the web client.
- `publish-npm` (:95) — `applets/sdk` is the only workspace it considers, and it publishes only because its manifest declares `frockbot.npm`. It rewrites that manifest to the tag version and sets `private: false`, resolves `workspace:` ranges to literals, requires npm ≥ 11.5.1, then `npm publish --access public` (`--tag next` for prereleases) through OIDC trusted publishing. `EPUBLISHCONFLICT` is treated as success.
- `github-release` (:233) — `gh release create --generate-notes --verify-tag`.
- `deploy-marketing` (:255).
- `deploy-backend` (:307, environment `production`) — rewrites the production D1 id and artifact hash into `wrangler.jsonc`, applies D1 migrations remotely, uploads the artifact, deploys the bundler and then the computer host with its own secrets file, runs `scripts/check-production-secrets.ts check --live` and `write-secrets-file`, then `wrangler deploy --secrets-file`.

### `.github/workflows/auto-merge.yml`

On pull request `opened`, `reopened` and `ready_for_review`. Skips drafts and forks; runs `gh pr merge --auto --merge`. The branch ruleset on `main`, requiring `Validate` and `Browser end-to-end`, is what holds the merge.

### `.github/workflows/native.yml`

On pull requests touching `apps/native/**`, `core/protocol-schemas/**`, `scripts/*protocol*`, `scripts/*native*` or itself. Advisory (`continue-on-error: true`). Runs `scripts/check-native-pins.py`, installs the pinned SDK, fails unless its `frameworkRevision` is `4cf24164269a5ebf0c16a028a00727d0e77bbb05`, then `flutter pub get --enforce-lockfile`, `flutter analyze`, `flutter test` and `flutter build web --release`. The web client is a required check elsewhere — `ci.yml`'s `validate` builds it — so this job is the device's analysis, not the client's gate.

---

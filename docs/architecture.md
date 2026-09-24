# FrockBot Architecture

Paths are relative to the repository root.

---

## 1. Deployables

Five Workers, two container images, one Flutter client — on the web and on the phone. Which of them a given deployment actually has is its profile's answer; the table is the hosted deployment's, and [Deployment profiles](#deployment-profiles) below is the difference.

| Deployable           | Worker name              | Config                              | Serves                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cloudflare`    | `frockbot-cloudflare`    | `apps/cloudflare/wrangler.jsonc`    | The product. Custom domain `bot.frockbot.com`. `main: src/index.ts`, compatibility date `2026-08-27`, flag `nodejs_compat`. Carries an `assets` payload: the Flutter web client, uploaded with the deploy.                                                                                                                                                    |
| `apps/computer-host` | `frockbot-computer-host` | `apps/computer-host/wrangler.jsonc` | No routes; reached only through the app's `COMPUTER_HOST` service binding. Fronts a Cloudflare Container built from `apps/computer-host/Dockerfile` (`node:24-slim`, `instance_type: basic`, `max_instances: 3`).                                                                                                                                             |
| `apps/applet-build`  | `frockbot-applet-build`  | `apps/applet-build/wrangler.jsonc`  | No routes; reached only through the app's `APPLET_BUILD` service binding. Fronts a Cloudflare Container built from `apps/applet-build/Dockerfile` (`node:24-slim`, `instance_type: standard`, `max_instances: 3`, no egress) that runs the Plugin SDK's build pipeline. `plugin_check` and `plugin_publish` are its only callers.                             |
| `apps/marketing`     | `frockbot-marketing`     | `apps/marketing/wrangler.jsonc`     | `frockbot.com` and `www.frockbot.com`. Static `ASSETS` from `./public` with `run_worker_first: true`; the Worker is a canonical-host redirect plus security headers, and `macDownloadRedirect` (`apps/marketing/src/index.ts`) sends `/download/mac` to the disk image's R2 custom domain.                                                                    |
| `apps/admin-portal`  | `frockbot-admin-portal`  | `apps/admin-portal/wrangler.jsonc`  | `admin.frockbot.com`, hosted-only. The deployment's whole administrative surface, behind its own Cloudflare Access application, which it verifies itself; it holds no state and reaches the app only through a `services` binding to the app Worker's `AdminEntrypoint` ([ADR 0028](adr/0028-open-deployment.md)). Server-rendered HTML and forms, no script. |
| `apps/native`        | `frockbot_native`        | `apps/native/pubspec.yaml`          | The client. Its web build ships as the app Worker's `assets` payload, so `bot.frockbot.com` is deployed by `apps/cloudflare`. Neither the Android nor the macOS build is deployed by CI; the macOS build is qualified by `.github/workflows/mac-release.yml` and distributed as a signed download from a `mac-v*` GitHub release.                             |

The tracked `wrangler.jsonc` files hold bindings, migrations, vars and the local environments; they carry no deployment identity. The account, the Worker names, the routes and the bucket, index, database and service-target names are in `deployments/hosted.json` and `deployments/staging.json`, and `bun run deployment:config <profile>` writes the config every `wrangler deploy -c` reads into `.deployment/<profile>/<worker>/wrangler.jsonc` ([ADR 0028](adr/0028-open-deployment.md), [`scripts/deployment-config/README.md`](../scripts/deployment-config/README.md)). `scripts/deployment-config.test.ts` proves the generated hosted and staging configs are still the ones production and staging ran before the move.

Named environments on the app Worker, both for local runs and never deployed:

- `development` — `wrangler dev --env development`
- `e2e` — `"routes": []`, the browser harness

Staging is a profile rather than an environment: `frockbot-cloudflare-staging` on `staging-bot.frockbot.com`, with its own D1, buckets and Vectorize index, sharing production's Computer host and Plugin build service.

The client's bytes are not in the Worker bundle and not in R2. `apps/cloudflare/build-flutter-web.ts` builds `apps/native` for the browser and stages it under `apps/cloudflare/dist/web/_flutter/<buildHash>/`, which is the `assets` directory; the asset router answers those URLs before the Worker runs. The Worker renders only the document that names them (§6).

Not deployed, though it carries a wrangler config: `apps/cloudflare/e2e/frock-ai-fake.wrangler.jsonc` (bound as a service by the `e2e` env, run from the local wrangler dev registry).

No Fly configuration exists in the repository. Fly Sprites are rented at runtime over the Sprites HTTP API.

Deploy paths:

- `.github/workflows/main.yml`, job `deploy-staging` — on push to `main`, deploys the app Worker from the `staging` profile; opt-in through the repository variable `DEPLOY_STAGING`, and skipped while it is unset.
- `.github/workflows/release.yml` — on tag `v*.*.*`, deploys marketing and the admin portal in one job, the computer host, the Plugin build service and the app Worker, each from the configs `scripts/deployment-config.ts` writes for the `hosted` profile. The portal's step skips when the `production` environment names no Access application.

### Deployment profiles

Two deployments exist, and they are the same code ([ADR 0028](adr/0028-open-deployment.md)):

- **hosted** — `frockbot.com`: better-auth with Google, billing live, the Android and macOS release channels, the marketing site and the admin portal. `deployments/hosted.json`, with `deployments/staging.json` as its disposable twin.
- **simple** — what `bun run setup` installs into a deployer's own Cloudflare account: Cloudflare Access sign-in, no billing, no release ceremony, the Computer included. `deployments/simple.json`, written by the installer and never by hand.

A profile is which auth Package is built in, which secrets exist, which workflows run, and whether the container images are built or pulled. It is not a fork, and nothing is gated: a deployer who sets `STRIPE_SECRET_KEY` gets billing, the simple installer simply never asks for one.

|                  | hosted                                                                  | simple                                                         |
| ---------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| auth Package     | `app/auth/better-auth`, resolved by the tracked `#auth-package` mapping | `app/auth/access`, resolved by an `alias` the generator writes |
| identity store   | D1 `AUTH_DB` and a session cookie                                       | none; the Access token is the identity                         |
| admission        | the `DeploymentPolicy` authority, administered from the admin portal    | the Access policy, which is the allowlist                      |
| billing          | `STRIPE_SECRET_KEY` set                                                 | never asked for                                                |
| native sign-in   | `NATIVE_SLICE_2_AUTH=android,macos,macos-dev,ios`                       | no targets named, so none                                      |
| deployables      | five Workers                                                            | three: the app, the Computer host, the Plugin build service    |
| container images | built from the Dockerfiles by `release.yml`                             | pulled from Docker Hub for the release tag                     |
| workflows        | `check.yml`, `main.yml`, `release.yml`                                  | none; a deployer runs the installer                            |

Identity lives in `deployments/<name>.json`, validated against `deployments/profile.schema.json`. `scripts/deployment-config.ts` (`bun run deployment:config <profile>`) reads one and writes `.deployment/<profile>/<worker>/wrangler.jsonc` from the tracked files, which is what every `wrangler deploy -c` takes. `scripts/deployment-config.test.ts` is the equivalence gate: it generates `hosted` and `staging` and proves the result is still the configs those deployments ran before identity moved out, because a Worker name, Durable Object class or migration tag that differs on deploy is a new namespace, which is data loss.

---

## 2. Durable Objects

Five classes in the app Worker, exported from `apps/cloudflare/src/index.ts`. `core/durable` defines no Durable Object class; it is the storage and authority library `BotState` delegates to. Four are hand-rolled; `VoiceAssistant` is the one Cloudflare Agents SDK class.

### `BotState` — `apps/cloudflare/src/bot-state.ts:524`

- Binding `BOT_STATES`; id `idFromName("<userId>:<botId>")` (`apps/cloudflare/src/index.ts:532`, `:634`).
- Authoritative for all Bot-scoped state: identity, runs, admission fences, the pending and agent-lane queues, the session event log, notifications, conversations, its Plugin enable map, Workspace file generations and conflicts, the memory vector purge journal, and the record of each upload it holds (`upload:<sha256>`, §4 "Attachments"). Its `composition:` records are a mirror of the User's Composition, not an authority over it (§5). Keys are enumerated in `core/durable/storage-keys.ts`.
- Bot-scoped state is key-value — `ctx.storage.get/put/list/delete/transaction`. SQLite holds the Bot's Memory: `createBotMemoryEngineV1` (`apps/cloudflare/src/memory-records.ts`) hands `ctx.storage.sql` to the Memory engine (`app/memory/engine.ts`), which owns the `bot` scope's tables (`app/memory/schema.ts`) — items, their FTS5 index, jobs and vector index intents. The class issues no `sql.exec` of its own.
- Roughly 100 RPC methods (`bot-state.ts:1321-3453`), each taking `input: unknown` and decoding through an envelope decoder. They include `run`/`runAgent`, the `isolate*` loopback surface, Composition reads and reverts, routines, tasks, approvals, notifications, `debugSnapshot` and `fenceRunAdmission`.
- `alarm()` drains the push-notification outbox first, and with it the Telegram outbox (§3, "From Telegram"). While the Bot is being deleted it then runs one page of the Memory vector purge and finishes the teardown when the purge completes; otherwise it runs the mounted contribution's alarm, then drains the audit and voice-reply outboxes.
- `GET /api/bots/:bot/cards` answers the newest Cards that fit one listing — `truncated` says some did not — `GET /api/bots/:bot/cards/:surfaceId` answers one Card by its id whatever the listing's byte budget cut (404 when this Bot never drew it), and `POST` to the listing path is one renderer action — `{surfaceId, revision, event:{name, context}, dataModel?, commandId?}` — routed by the kernel, never by the Card: `approval/<approvalId>` goes to `decideApproval` and cannot name a decision the kernel never recorded, `plugin/<pluginId>/<action>` is a `cardAction` RPC on the Plugin worker whose returned messages fold into the card, and anything else becomes the Bot's next user-lane pending input, keyed on the client's `commandId` when it sent one — so a retried post is the same press — and on a minted id when it did not, and opens an input-delivery Turn (below) so the Bot answers the press without the person having to type. A handler's `input` opens none: that press was answered on the card and costs no Turn. A stale revision is a 409. A card write is a transcript write, so `shell:card:` joins the keys `bot-state-channel` invalidates `runs` for.
- `fetch()` at `:3520` serves one path: the state-channel WebSocket upgrade. Sockets use the hibernation API — `state.acceptWebSocket(server, tags)` (`apps/cloudflare/src/bot-state-channel.ts`), tagged `bot-state-v1` and, for an observer that asked with `drafts=1`, `bot-state-v1-drafts` as well — with `webSocketMessage/Close/Error` forwarded from `bot-state.ts`.

### `UserConfiguration` — `apps/cloudflare/src/user-configuration.ts:255`

- Binding `USER_CONFIGURATIONS`; id `idFromName(userId)`.
- Authoritative for the User's Composition — the installed Plugin set, its generations, last known good and quarantine — reached through the composition RPCs a Bot calls (§5).
- Its constructor runs receipted, disposable cleanups under `blockConcurrencyWhile` before any request or alarm: Plugin-panels (`plugin-panels-cleanup.ts`) drops directory entries, Composition `applets[]`, the account `applets` flag and cleanup to-dos; `cleanDefaultPackagesMarkerV1` (`default-packages-marker-cleanup.ts`) deletes pre-ledger `{ schemaVersion: 1 | 2 | 3 }` bootstrap markers under `maintenance:default-packages-marker:2026-09-20`; the default-Package bootstrap decoder accepts only the v4 ledger. Package-page shapes (`package-page-shapes-cleanup.ts`, `maintenance:package-page-shapes:2026-09-24`) runs before anything decodes a run or a Session event: a finished run loses its `directTool` field, an unfinished one is removed with its active, queue, index and repair pointers, and a `computer/sync` whose `reason` was `publish` reads `signal`.
- Counts the account's upload space: one `uploads:entry:<botId>:<sha256>` per Bot and file, and the `uploads:total` beside them, checked against 5 GB in one transaction (`reserveUploadQuota`, `app/uploads/quota.ts`) and given back when a Bot is deleted (`releaseBotUploadQuota`).
- Uses SQLite, and does not own the tables. `ctx.storage.sql` is handed to four stores: transcript search FTS5 (`app/search/index-store.ts:143-177`), audit (`app/audit/store.ts:166-175`), the billing ledger (`app/billing/ledger.ts`, the `billing_*` tables) and the Memory engine for the `user` and `groupChat` scopes (`createUserMemoryEngineV1`, `apps/cloudflare/src/memory-records.ts`). All other state is key-value.
- One `alarm()` serving credential leases, each Connection owner's own work — connected-app catalogs and MCP server directories among it (§8) — publisher and template recovery, flock sagas and archived-Bot sweeps — except while the account is being deleted, when it serves the deletion alone.
- Owns account deletion. `POST /api/account/delete` (the gateway checks the typed confirmation — the email this session signed in with, or the User id without one — and answers `202`) reaches `beginAccountDeletion`, which writes the saga record `account:deletion:v1`, ends access in `DeploymentPolicy` before it answers, and sets the alarm. The saga (`app/account/deletion.ts`, steps in `apps/cloudflare/src/account-deletion.ts`) runs in order: access, the voice session, Group Chats, every Bot through the Bot delete saga, the Computer's `teardown`, the Connected apps provider's accounts and triggers (listed by `user_id` at the provider, not from our records), the grant each signed-in MCP server issued (revoked at its RFC 7009 endpoint with the refresh token only this object holds; each `mcp:grant:v1:` record is the key and goes once its server has answered, and a server that has not answered after five passes of the backoff is given up on, so a dead server never holds the deletion), the Stripe customer (which ends the subscription), the User's object-storage roots, User and Group Chat Memory vectors, the sign-in identity with its sessions, and the access record and invitation. Each step only deletes and is safe to repeat; the record names the step and its cursor, a failure backs off to five minutes and never stops, and the next alarm is armed before each pass. The last step wipes the object with `deleteAll()` and writes the permanent tombstone `account:deleted:v1`, after which the object refuses every identity check with `AccountDeletedError` (`410` at the entry boundary) and its constructor runs no cleanup. From the moment the record exists the object refuses work that would start something — `prepareAccount` (so no Turn starts), usage reservations, Bot creation and lifecycle commands, group and Connection commands, triggers, checkout, push — and reads every native session back as signed out. Content-addressed objects (Skill bodies, Plugin artifacts, exported templates) are kept: one address can hold another account's bytes, and nothing names them once the account is gone.
- Owns [General bootstrap](../app/flock/README.md#general-bootstrap); the [first-run guidance](../README.md#getting-started) describes how the shared Flutter client opens it and offers editable suggestions.
- Holds the User's Telegram link (`telegram:link`) and the at-most-once record of each message sent to it (`telegram:delivery:<botId>`), and is the only object that calls Telegram's `sendMessage` (§3, "From Telegram").
- No `fetch()`, no WebSockets.

### `DeploymentPolicy` — `apps/cloudflare/src/deployment-policy.ts`

- Binding `DEPLOYMENT_POLICY`; singleton `getByName("frockbot-deployment-policy")` (`apps/cloudflare/src/index.ts:694`).
- Owns deployment admission, account access and email invitations. The authority contract and scoped release cleanup are in [`beta-access.md`](beta-access.md); storage keys and RPCs are defined in `apps/cloudflare/src/deployment-policy.ts`. No fetch, no alarm. Deleting an account calls it twice: `closeAccountForDeletion` first, which writes `ended` over whatever the record said, and `forgetAccount` last, once the sign-in identity is gone, which deletes the record and any invitation under the account's address.
- Also owns the versioned hosted model rate table (`apps/cloudflare/src/model-rates.ts`, [`billing.md`](billing.md#hosted-model-rates)): `readModelRates` for each Bot object's minute-long copy and the billing page, `readModelRatesView`/`saveModelRates` for the admin portal, and `reportUnpricedServedModel`. Its constructor seeds version 1 under the receipt `maintenance:model-rates-seed:2026-09-24` when no version exists. The table is deployment-wide, so deleting an account leaves it alone.
- Also keeps the deployment's Telegram directory (`app/telegram/directory.ts`): which User each Telegram account speaks for, and each User's one pending link code, by digest. It is the one object the whole deployment shares, which is what the webhook needs before it may address any User's object (§3, "From Telegram"). `forgetAccount` forgets the account's Telegram entries with the rest.
- Storage is key-value through the synchronous `ctx.storage.kv` API inside `transactionSync`, which only SQLite-backed storage provides. It creates no tables.

### `VoiceAssistant` — `apps/cloudflare/src/voice-assistant.ts`

- Binding `VOICE_ASSISTANTS`; one object per User, reached with `get(idFromName(userId))` through the gateway's `GET /api/voice/assistant` upgrade and with `getAgentByName` from the token-gated operator read `GET /api/debug/voice?userId=<id>`, which calls `debugSnapshot()` and reads storage only (there is no `/agents/*` route). The upgrade is not routed through `getAgentByName`, which would wait for `onStart` before returning the 101. Dictation leases still use `getAgentByName` because they are RPC. Migration `v7`, `new_sqlite_classes`.
- A plain `Agent` from `agents` 0.23.0, with no voice SDK: since [ADR 0031](adr/0031-voice-gemini-live.md) one call is one Gemini Live session (`gemini-3.8-live`, `bidiGenerateContent` over a WebSocket the object opens with `GEMINI_API_KEY`) and the object writes the client's protocol-v1 frames itself. The wire is built and decoded in `app/voice/gemini-live.ts`, against shapes recorded in [`voice-gemini-probe.md`](voice-gemini-probe.md). The instruction is rendered once at setup from `app/voice/assistant.ts` — persona, then conversational rules, then guardrails, with the Bot's delivery prose from `app/voice/appearance.ts` in the persona and its `voiceName` in `speechConfig`. Its tools are `NON_BLOCKING` function declarations (`list_bots`, `status`, `read_history`, `search_history`, `subagent`, `cancel`, `switch_bot`, `end_call`, `remember`, `forget` — since ADR 0029 a call addresses one Bot and the six that mean a Bot take no id; `end_call` is the hang-up frame as a function, offered even with no Bot) plus `googleSearch` as a built-in; a call runs through `runVoiceToolV1` and is answered with `scheduling: "WHEN_IDLE"`. The model says nothing until the result is back and speaks it in a fresh generation, which the object keeps in the same ledger turn. Audio is bridged unchanged in both directions: 16 kHz PCM16 up as `realtimeInput`, 24 kHz PCM16 down as binary frames.
- Durable state is the ledger in `app/voice/ledger.ts` over the object's key-value storage: the live call, each spoken turn under its idempotency key, each Bot delegation under the run id the Bot fences on (returned to the live session as that function call's own late response, or written into chat after hang-up), and the day's meters, beside the voice session's own memory in `app/voice/memory.ts` (the record, its removal fences, and one finalization job per call). Hang-up also writes those spoken turns onto the Bot's announcement log as a `voice/call` event, drawn as a collapsible Voice chat section in the thread, idempotent by call id. `BotState.runVoice` admits a distinct voice requester to the existing agent lane, so active chat and Routine Turns finish without interruption. The Bot answers with `reply_to_request`; its `reply/to-caller` event returns to the original request and is read on the exchange view behind the thread's "Message from Voice" marker, without an ordinary User notification. Terminal state records a durable completion wake; scheduled `checkDelegation` look-ups recover lost dispatches or wakes, and `onStart` restores checks from the ledger. An answer is told on the call that asked for it — waking a quiet-room sleep so Gemini can say it, unless the person paused or muted — or written into chat after hang-up: it is marked spoken the moment it is handed back, and ending a call does not cancel admitted Bot work.
- Deleting the account calls `eraseAccount`: every opening and live call is cancelled and its model session closed, every socket closed, and the object's storage and alarm deleted — with nothing finalized, since everything a transcript or memory job would write to is being deleted too.
- Read-only voice history uses the existing Bot run projection and User transcript index (`app/voice/history.ts`). The target is the call's own Bot, checked against the User's Bot directory when the call is admitted rather than passed as a tool argument; search hydrates bounded matches to preserve User, Bot and voice attribution. Explicit sends and caller replies are readable, private model/tool scratch is not. `status` reads current durable progress directly, while search declares that its settled-conversation index may lag. These reads never admit target Bot work or call its model.
- Full contract, protocol and limits: `docs/voice.md`.

### `GroupChat` — `apps/cloudflare/src/group-chat.ts`

- Binding `GROUP_CHATS`; one object per Group Chat, `idFromName("<userId>:<groupId>")`, pinned to that pair when the User object creates it. Migration `v9`, `new_sqlite_classes`.
- Holds the group's thread: the ordered log (`group:msg:<seq>`), the person's read cursor, and for each member the Turn it is running or owed. The logic is `app/groups/log.ts`, run inside one storage transaction; what has to leave the object — admitting a member's Turn, telling a running member a message arrived, stopping a Turn — comes back as effects the object carries out after the commit.
- Who is in the group is the User object's: `UserConfiguration` holds the list of the User's groups, their members and sidebar arrangement (`app/groups/user.ts`), and the group reads it before it acts. A membership change commits there first and its thread line is carried here, idempotent by command id.
- A member's Turn runs in its own `BotState`: `admitGroupTurn` admits it on the `agent` lane under the Session `group:<groupId>`, with the thread since the member last took part as its input and the group as its origin. It is left out of the member's one-to-one thread, unread and push (`isVisibleRunV1`, `visiblePublicationsV1`, `messageRecords`). The Bot nudges the group after each commit and at settlement; the group reads the Turn back with `readGroupTurn` and posts each send once. Its alarm reads open Turns again every 30 s and retries owed admissions, so a lost nudge only delays the thread.
- A new message tells every member with a Turn open (`signalGroupMessage`); that Turn yields at its next step boundary, and a member that yielded before answering is asked again with the new messages.
- Who answers: the person's @mentions run at once. Then Jev judges every message (`GroupReplyJudgeV1`, hosted in `app/supervision/group-reply.ts`) — which free members should answer, and for a member's message whether its own @mentions continue the conversation, loop or drift. Its decision is kept as `group:judgement:<seq>`, and a member it asks runs with the reason `jev` on its origin. Without Jev nobody extra is asked, and a run of Bots asking Bots ends after eight Turns.
- A Bot acts on its groups from its own chat and Routines through `app/groups/agent.ts`, whose host (`app/shell/backend-groups.ts`) sends membership commands to the User object as that Bot and posts with `postFromBot`, both idempotent by ids derived from the run and call. Inside a group Turn, `bot_message` reaches only Bots outside the group; the group reads those calls back with the Turn and writes an Exchange line. A member's `@User` pushes once per message: the group records `group:push:<seq>` in the post's transaction and the alarm retries it until the User object's `deliverGroupPush` has sent it.
- A group's Memory is the engine's `groupChat` scope, keyed by the group's id and kept in the User object with User Memory. Membership is its authority: the User object reads `groupsOf(botId)` for each Memory call, and a Bot's Turns read it over `listMemoryGroups`. A group's Turns inject that group's prepared core beside the Bot's and its User's, and capture their thread for extraction into it; a Bot reaches its other groups' Memory with the tools' `group` scope. Deleting a group purges the scope.
- `fetch()` serves the client channel: a hibernating WebSocket that sends a small `group/state` frame (head, read cursor, working members) on every change; clients read messages through `GET /api/groups/:id/messages`.

The composer's dictation relay (`apps/cloudflare/src/voice-dictation.ts`) is not a Durable Object: a Worker-level socket pair to OpenAI Realtime transcription, admitting nothing durable.

### In `apps/computer-host`

- `FlyHostContainer` — `apps/computer-host/src/index.ts:47`, `extends Container`, bound as `COMPUTER_HOST_CONTAINER`. The class name is legacy and permanent: a Cloudflare container application is bound to one Durable Object class for its lifetime.

---

## 3. Request path: one user message

1. **Client.** `apps/native/lib/client/transport.dart:197` posts `{schemaVersion, commandId, text}` to `POST /api/bots/{botId}/turns`. A file the person attached was uploaded before Send, and the command names each by its hash, `attachments: [{uploadId}]`; with files, `text` may be empty (§4 "Attachments").

2. **Gateway.** `apps/cloudflare/src/gateway.ts`, the Worker's `fetch`. Order of dispatch in `createGateway`: client-compatibility refusal, native-auth routes, `/api/auth/*` to the auth Package, `/sign-out` to the auth Package, the debug route, public Package routes, then identity resolution — native bearer token, development identity, or the auth Package's session — then the [beta-access admission check](beta-access.md#where-it-is-asked), then authenticated Package backend contributions.

3. **Per-user application isolate.** Unmatched requests fall through to `routeUserApplication` (`:187`). It resolves the user's `applicationHash`, then `dependencies.loader.get(workerId, ...)` loads that artifact from R2 into a Worker Loader isolate whose `env` holds `BOT_STATE` — a Durable Object stub already scoped to the user — plus `DEPLOYMENT` (`:209-222`). The client's `x-frockbot-user-id` header is deleted before forwarding (`:225`); the gateway sets `x-frockbot-deployment`, `x-frockbot-auth-session-v1` and `x-frockbot-is-admin-v1` itself. Authorization is established here and passed downward as capability; nothing below re-verifies it.

4. **Application.** `apps/cloudflare/src/user-application.ts:653` matches the turn route; `:940` calls `env.BOT_STATE.admitRun({schemaVersion, botId, command: {runId: commandId, sessionId: "<userId>:<botId>", acceptedAt, text, skills?, attachments?, retryOf?}})` and answers 202 with the receipt. The Bot Durable Object resolves each attachment ref against the uploads it holds before it admits the Turn, and refuses one it does not hold with `UploadNotFoundError`, a 422 the composer shows. A message sent while a Turn runs is admitted into the user queue, and a chat Turn on the user lane ends at its next step boundary to let it run ([Steering](../CONTEXT.md)); the `supersedes` field installed apps still send is accepted and dropped. The session id is derived server-side. The command decoder accepts exact keys only, so a client cannot name a turn type; an absent turn type means `chat`.

5. **Bot Durable Object.** `apps/cloudflare/src/bot-state.ts:2001` `run()` decodes the envelope, materializes the identity and calls `shell.run(...)`.

6. **Shell.** `app/shell/turn.ts:151` `run()` takes the session log from any in-flight compaction — which keeps summarising and parks its outcome for the next Turn end rather than writing beside this Turn — then delegates to `admitTurnV1`, which mirrors the User's Composition and calls `BotDurableAuthority.run` (`core/durable/authority.ts:293`): recover whatever the object holds, check for a settled replay, then `acceptRun`. An accepted run executes inline; otherwise it is durably queued — one user-lane slot, FIFO agent lane — and promoted by `runQueuedRun` (`:332`).

7. **Mount.** `activateCompositionV1` reads the pin and builds the Turn's runtime through `createShellCompositionHost` (`app/shell/backend-composition.ts:274`).

8. **Loop.** `executeResidentBotTurn` (`app/shell/backend-runner.ts:431`) calls `runtime.execute(...)`, then `agent.send({text, skills})` and awaits `whenIdle()`.

9. **Model.** Inside the loop, `ctx.llm.stream(request, signal)` dispatches to a provider, which issues the HTTP request (§7).

10. **Tools.** `ctx.tools.prepare` then `ctx.tools.executePrepared`.

11. **Return.** The POST returns the settled turn. Live updates arrive on a separate WebSocket, `GET /api/bots/{botId}/state-channel?version=1&drafts=1&cursor=N` (`apps/cloudflare/src/gateway.ts`). It carries every committed publication on a contiguous cursor — each send with its payload, run status, announcements, card revisions, and Computer notices, the last coalesced per interval — and, to an observer that asked with `drafts=1`, the reply a running Turn is writing as `state/draft` frames that are never stored and have no cursor ([Reply drafts](#reply-drafts--appshellreply-draftts)).

### From Telegram

A person may also write to a Bot from Telegram (`app/telegram/`). The deployment runs one Telegram bot, configured by two optional secrets, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` (32 or more of `A-Za-z0-9_-`); either absent, Telegram is off, the webhook answers 404 and the Telegram page says so. Nothing is configured per person.

**Linking.** You → Telegram (`apps/native/lib/telegram/page.dart`, over the `telegram` `ViewDocument` from `GET /api/telegram?as=document`) presses Link Telegram, `POST /api/telegram/link`. The gateway points the bot's webhook at `<origin>/api/telegram/webhook` with the secret (`setWebhook`, once per isolate, with `allowed_updates: ["message"]`), reads the bot's username (`getMe`), mints a 32-character code, and hands the `DeploymentPolicy` directory only its SHA-256 and a ten-minute expiry; a new code retires the User's previous one. The code exists on the receipt alone, as `https://t.me/<bot>?start=<code>`, which the page's banner opens. Pressing Start sends `/start <code>`: the webhook spends the code on the sender's Telegram account in the directory (a redelivered `/start` claims it again), tells the account's previous User, if any, to drop its link (`dropTelegramLink`, a no-op on a link made after the claim), and completes the link in this User's object: account, chat, display name, and the Bot the chat talks to — the Bot it talked to before when the same account relinks, otherwise General or the first active Bot. The answer to the webhook is the confirmation itself, as a Bot API method in the response body. Choosing another Bot is `POST /api/telegram/bot` from the page or `/bot <number or name>` in the chat (`/bots` lists them); unlinking is `POST /api/telegram/unlink`, which deletes the User's link and then releases the directory entry. Deleting a Bot clears the chat's choice in the same sweep that purges its search rows. Deleting the account forgets its directory entries in `forgetAccount`, and its link goes with the rest of the User object; an update that meets the account mid-deletion is acknowledged and dropped.

**Inbound** (`backend.ts`). The webhook is a `publicRoute`. `X-Telegram-Bot-Api-Secret-Token` is compared with the secret in constant time before the body is read; a request without it is a 401 that touches no object. Only a text message in a private chat from a person is read (`update.ts`); anything else is acknowledged and dropped, and a photo or voice note is answered with a line saying only text reaches the Bot. The directory says which User the sender's account speaks for — none, and the chat is told how to link — then the same account admission every external door asks (`externalAccountRefusal`), then the User's object decides (`routeTelegramMessage`): an account or chat it does not link is `not-linked`, and the stale directory entry is released; a command is answered in the chat; anything else is words for the chosen Bot. The gateway admits them with `admitTelegramTurn` on that Bot: an ordinary `chat` Turn on the user lane in the Bot's own Session, so it queues ahead of agent work and a running chat Turn yields to it like a typed message ([Steering](../CONTEXT.md)), with origin `{kind: "telegram", messageId}` and run id `tg-<sha256(chat, message)>`, so a redelivered update replays the admission. Only once that returns does the webhook answer 200 (with a `sendChatAction` "typing"). A failure before it is a 500 and Telegram delivers the update again; a full user queue, a Bot archived or deleted in between, and a duplicate are answered rather than retried. The thread projects the origin as `via: {kind: "telegram"}` on the run, drawn as a "via Telegram" caption under the person's own bubble.

**Outbound.** The Bot object holds `telegram:mirror` while it is the chat's Bot — set by the User object when the chat starts talking to it, and on every Telegram admission; cleared when it stops. `visibleMessageRecordsV1`, the one place a message is minted, reads it in the minting transaction and writes `shell:telegram:<cursor>` beside the push outbox entry for every visible message except a voice answer: the whole text, not the alert's preview, and a line pointing to the app for a card, approval, file or secret request. A send from a Telegram Turn wakes no device (`notify: false`), because it is being read in Telegram. The push drain drains this outbox too, in cursor order, entry by entry through the User object's `deliverTelegramMirror`, which sends only to the chat the link names now and only for the Bot it names now (anything else is `skipped`), and records the attempt under `telegram:delivery:<botId>` before calling `sendMessage` with the token. A record found still `attempting` is an outcome lost with the object: it becomes `uncertain` and is not sent again, and the message stays in the conversation. A 429 holds the entry until Telegram's `retry_after`; a refusal (the person blocked the bot) is `failed`; a network failure or a 5xx is `uncertain`. The alarm retries what is still owed every 30 seconds.

`telegram.integration.ts` walks the link, the webhook's refusal of a forged secret, a message admitted as a Turn, its reply sent to the stub Bot API (`test/harness/miniflare.ts`), a redelivery that is the same Turn, and an unlink.

---

## 4. Agent loop — `core/agent-loop/`

The Turn's state machine lives in `index.ts`; the external work it dispatches lives beside it, reached through the `LoopRuntime` seam in `runtime.ts`. `model-request.ts` owns provider dispatch and stream consumption, `tool-execution.ts` tool calls, `resume.ts` the replay of a durable log, `errors.ts` the classified failures.

### At-most-once by idempotency key

Every external effect that matters carries a key, and is retried **by that key** rather than investigated afterwards.

- A model call's key is its `NormalizedModelRequest.requestId`. A retry, and a re-issue after the object was evicted, send the same request object under the same id.
- A tool call's key is its `occurrenceId`, derived from the Turn, the step and the call's position, and handed to the tool as `ToolExecutionContext.effectId`. A call declared inside a `batch` keys off the batch's own id, a dot, and its declared position — `tool:<turn>:<step>:<ordinal>.<subIndex>` — because an approval id may not carry a colon, and because every effect-keyed tool needs the calls in one batch to be distinct.

The loop never asks a provider what became of a call it lost. It sends the call again. A provider that honours the key answers once; one that does not may run it twice, and that is the accepted trade — reconstructing the history of a lost dispatch is what used to wedge a Bot behind a question nobody could answer.

`admitEffect({kind, effectId})` still runs immediately before every dispatch, including a re-issue. Admissions are recorded per effect id, so re-admitting an effect returns its earlier outcome and a Stop still fences a call the evicted Turn had already started.

### Turn lifecycle — `#runTurn`

Appends `turn/start`, `composition/pinned`, `turn/admission` and `input/admitted` as one batch, shifts the inbox before the flush, then runs through `#driveTurn`, which owns the deadline, the failure classification and the settlement. The body iterates `step = 1..maxSteps`:

- `agent/pre-step` waterfall; a `reject` decision ends the Turn as `blocked`.
- `step/start`, then a `user/message` per admitted input.
- `#callModel` — `requestModelV1`, then `assistant/message`, flush, `notifyModelOutcome`, `#announceAssistantText`.
- `#completeStep` — the step's tool calls through `executeToolsV1`, then the `agent/step-continuation` waterfall and `step/end`. A step every hook would continue past still ends the Turn `completed` when `userMessageWaiting` answers true: the Bot Durable Object says so for a chat Turn on the user lane with a message queued behind it, and that message runs next ([Steering](../CONTEXT.md)).

Exhausting the loop throws `StepLimitReachedError`, which settles the Turn as `interrupted` with `STEP_LIMIT_REASON_V1`.

**Input-delivery Turns** (`app/shell/input-delivery.ts`). An input that reaches the Bot only through the pending-input queue and has nothing else to answer it — a person's decision on an approval, a card press no handler answered, a finished machine command (`deliverMachineResult`, `app/machine/bot.ts`) — admits a `chat` Turn on the Bot's own conversation once the input is durable, with an `input-delivery` origin naming the input's queue id. It runs on the `agent` lane, so it waits behind a Turn still running and never makes that Turn yield the way a person's message does. Its admitted text says only that nobody spoke (`INPUT_DELIVERY_CUE_V1`); `turnInputTextV1` adds one line of guidance per kind of input the drain actually carried, since the drain takes the whole queue and not only the input that opened the Turn. The run id is a digest of the input's own id — for an approval, with the run that asked, because a Bot may reuse an approval id — so a retried delivery or a replayed press asks for the Turn it already admitted. An input that lands while an input-delivery Turn is admitted but not started rides that Turn instead of queueing another, so a person changing their answer costs at most one Turn running and one waiting. A waiting Turn took its Composition pin when it was admitted, so an approved Plugin that rides one is mounted from the Turn after it. Like a Routine delivery it ends without a model call when the person's own Turn drained the queue first, gives back what it drained if it fails or is stopped, and costs only the immediate reply when it cannot be admitted. Sibling Bots of the same User see the new generation but run the Plugin only when a person switches it on for them.

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

Validates the settled tool-occurrence journal, assembles the system prompt through `ctx.systemPrompt.assemble` (session, provider, model, turn type, subagent role, step budget, deadline), then builds one request: `session.deriveMessages()` through `agent/message-window`, `ctx.tools.schemas({turnType, subagentRole})` through `agent/tool-exposure`, and the assembled `NormalizedModelRequest` through `agent/request`. Per dispatch it journals `model/request`, flushes, calls `admitEffect` — a `false` throws `EffectAdmissionFencedError` — and consumes the stream.

On failure it flushes, releases the request id through `notifyModelOutcome`, and classifies: a `StructuredOutputValidationError` is terminal; a cancellation rethrows and lets the Turn settle; anything else is a retry candidate under `nextModelRetryV1`, classified `unknown` when the provider offered no classification of its own. The `agent/request-error` waterfall may refuse a planned retry or substitute a provider-owned fallback — a fallback is a different call and takes a new key.

### Attachments

A file the person attaches is uploaded before the message that carries it is sent: `POST /api/bots/:bot/uploads?name=<name>` with the bytes as the body (`apps/cloudflare/src/uploads.ts`, a gateway route contribution). The route reads at most 20 MB, decides what the file is from its bytes first and its name second (`classifyUploadV1`, `app/uploads/shared.ts` — PNG, JPEG, WebP and GIF pictures; PDF, Word, Excel, PowerPoint, CSV, Markdown, JSON and plain text or code; anything else, HEIC included, is a 415 with a sentence), extracts a document's text once (`app/uploads/extract.ts`: Workers AI `toMarkdown` with image description off, and a small Office XML reader for PowerPoint and as Word's fallback; a document with no text is a 422), counts the file against the account's 5 GB in the User object, writes the bytes and the text to `MEMORY_FILES` under `uploads/<userId>/<botId>/<sha256>` and `…/<sha256>.md`, and has the Bot record `upload:<sha256>` — and only then answers `UploadReceipt` with the hash as `uploadId`. Every step is idempotent by that hash, so a retried upload counts, writes and records once. `GET /api/bots/:bot/uploads/:uploadId` serves the bytes back, `private, immutable`, a picture inline and anything else as a download under `sandbox`.

The Turn command names uploads by hash, and the Bot resolves each ref against its own `upload:` records before admission, so a message can only carry a file its Bot was given. From there a `MessageAttachmentV1` (`core/contracts/message-attachments.ts`) — kind, hash, name, media type and size, never bytes — rides the run record, `input/queued`, `user/message`, the working-context pages and the journaled `model/request`. Its bytes and text are filled in after the request is journaled: `LlmRegistry` hands the request to a `ModelAttachmentResolverV1` before any `modelStream` hook or provider sees it (`core/models/llm.ts`), and the Turn's resolver (`app/uploads/resolver.ts`, mounted in `app/shell/turn.ts`) reads R2. A re-dispatch after an eviction resolves the same content-addressed bytes again, and nothing resolved is ever written to the log. The resolver also fills in a tool result's image from the Workspace when the Session no longer holds it, which is how `generate_image`'s attachment reaches the model.

What a request carries is bounded here, newest first, because the history budget measures a message by its durable shape: the attachments on the newest three messages that have any, at most eight pictures of at most 8 MB, and up to 30,000 characters of each document within 90,000 for the request. Every provider adapter draws a user message through `userMessagePartsV1`: a picture as an image part for a model that can see one, a document as `<attachment name type>` text, and for anything the request does not carry — an older file, a model without vision — one line naming it. Compaction is unchanged: tool payloads older than three Turns are pruned as before, and the summariser reads a message's words, not its files, so a file older than the summary is known only by what the conversation said about it.

A Run carries its `attachments` to a client that negotiated protocol 3; `withoutRunAttachmentsV1` leaves them off every Run sent to an older one — a page, a lookup, a Stop receipt, a state frame (the socket names its protocol in its URL, since a browser cannot send a header on one). A Bot's uploads are deleted with the Bot, and its quota entries given back. Deleting the account deletes every Bot that way, then sweeps the whole `uploads/<userId>/` prefix again for a Bot lost before its own teardown (`accountObjectPrefixesV1`, `apps/cloudflare/src/account-deletion.ts`); from the moment that deletion begins, the User object counts no new upload. Both ids in an upload's key are URL-encoded, so no account's prefix is the start of another's.

### Stream consumption — `consumeStreamV1`

Iterates `ctx.llm.stream(request, signal)`, accumulating text, tool calls and usage, journaling `assistant/chunk` per text delta. A `tool-input-delta` — a fragment of a call's arguments while the model is still writing them — goes to the Agent's `watchToolInput` watcher for that dispatch and nowhere else: it is never journaled, the call still arrives whole as a `tool-call`, and a watcher that throws is ignored. Usage is recorded per dispatch, on every path except a `ModelProviderFailureError` with no partial data, because the provider says no billable call occurred; billing (`app/billing/model.ts`) counts a tool-input delta as partial data, like text, because it is output the model produced.

### Reply drafts — `app/shell/reply-draft.ts`

The Bot's voice is `send_to_user`, and a send exists only once the step's model call has finished and the tool has run. A chat or agent Turn in the Bot's own thread (never a group Turn) mounts a watcher that reads the `text` of each `send_to_user` the model is writing — alone or declared inside a `batch` — out of its streamed arguments with a partial JSON reader, and publishes it at most every 100 ms and once more when the dispatch ends, through the Shell host's `deliverReplyDraft` to `BotStateChannel.broadcastDraft`. A draft is `{runId, ordinal, parts}`: one text per send the step is writing, in the order they will land, the first at `ordinal` among the run's sends (counted from the journal when the dispatch began). A part that is not text yet, or not text at all, is empty and still holds its place. The next dispatch clears whatever the last one drew, so a send the step never made does not outlive its step.

Nothing about a draft is durable: it is not journaled, not published, not replayed to a reconnecting observer, and an eviction simply loses it. The Session reconstructs every model request exactly as before. A frame larger than one state frame is not sent, so the draft stops growing and the message still arrives whole; past 256 KiB of a dispatch's argument text the watcher stops reading. Which providers stream arguments decides which Bots draw a draft at all: the OpenAI-compatible adapter (Frock AI included) and the catalog bridge do, while the seeded DeepSeek Plugin and Bedrock deliver a call whole at the end, so the message simply appears as it always has.

### Tool execution — `executeToolsV1`

The occurrences of a step run one after another. Per occurrence: validate the journal, skip if a result already exists, `ctx.tools.prepare`, journal `tool/call` if there is no intent yet, `admitEffect({kind: "tool"})`, `ctx.tools.executePrepared`, journal `tool/result`, flush.

- An occurrence with an intent and no result is dispatched again under the same effect id.
- A throw that is not a cancellation becomes an error result. For a tool not declared `idempotent` the content says the outcome is uncertain, because the loop does not know whether the work happened and does not try to find out.
- A result carrying `endsTurn: true` closes the Turn unless the `agent/step-continuation` waterfall overrides it.
- `batch` spends one inference on several independent calls. It is registered so the catalog offers it, but it is never dispatched as a tool: the loop expands it into the occurrences it declares (`core/contracts/batch.ts`) and runs each one through the registry's own `prepare`/`executePrepared`, so admission, guards, hooks and one `tool/call`–`tool/result` pair per effect hold inside a batch exactly as outside one. A call whose tool declares `orderedEffect` — its effect occupies a position in the conversation, like a `send_to_user` bubble or a `wake_parent` hand-off — runs in declared order against the other ordered calls, so landing order is declared order and the wire ordinal, the rendered order and the unread boundary keep reading the log the one way they always have; every other call is dispatched at once. One refused or failing call does not abort the rest, `endsTurn` is the OR of the sub-results, and `batch` cannot call itself. At most 25 calls, and a batch needing more effect admissions than the run's record can still hold is refused whole — never truncated — with the number that would fit. The transcript draws the declared calls rather than the envelope, so a batched reply is indistinguishable from the same calls issued across separate steps; only a batch refused before any call was declared draws its own row.
- `send_to_user` requires `disposition: "finish" | "continue"`. Each call delivers one separate message. Use `continue` when there is more to say or do, including another part of the answer, and `finish` on the last message to end the Turn. A `continue` send leaves a final reply owed. Widgets and approvals always end the Turn. The Shell derives completion from the durable tool input and matching send occurrence, including after eviction.
- A `card` payload (`{type:"card", surfaceId, messages}`) is one A2UI 1.0 surface in the conversation ([ADR 0030](adr/0030-a2ui-cards.md)). The four agent→renderer messages and their decoder are `core/contracts/a2ui.ts`; the budgets are in `SEND_TO_USER_LIMITS_V1` — 16 messages per send, 32,000 bytes per message, 128 components and 32 actions per surface, 16,000 bytes of data model, 32 surfaces per Session — and a payload past one, or naming a malformed message, is refused at the decoder. A `card` does not end the Turn: it is something the Bot put in the thread and keeps updating, not a question it is waiting on. The seam stores the 1.0 shape and accepts the v0.9 envelope the Flutter renderer still writes, `theme` included, until `genui` catches up.
- The Session folds those messages where the Turn settles (`app/shell/cards.ts`, beside the approvals): `shell:card:<surfaceId>` holds the component set, the data model and a revision, with `shell:card-index` bounding how many surfaces a Session may hold. `createSurface` replaces the surface, `updateComponents` upserts by `id`, `updateDataModel` writes at its JSON Pointer (`null` deletes the key) and `deleteSurface` tombstones the record. Re-settling a Turn folds nothing twice, and a fold past a surface budget leaves the card as it was and says why on it; a Session already holding its 32 surfaces tombstones the oldest indexed surface the drawing Turn is not itself writing, whichever Turn drew it, with a refusal saying it made room, rather than dropping the new card; a Turn whose own sends outnumber the cap then spends the oldest surface it has already folded in that same Turn, and `app/shell/cards.ts` states what that costs. The index is hard-capped at the 32 surfaces and never runs past them: a send the fold refuses, and one the exhausted Session has no slot to give, each write a refusal record that evicts nothing and is simply not indexed — read by its surface id and listed until retention reaches it, the same bargain approvals make, because the send that drew it is still on the durable log of the Turn that made it. The records eviction leaves behind answer to that same one surface bound, the stalest dropped when the listing is read once the records the index no longer lists outnumber the surfaces it may hold, never one the index still lists.
- The conversation prompt defaults to plain paragraphs, one thought and a line or two per message. Simple answers use one message; distinct parts can use two to four, keeping the whole reply concise, and the parts the model already knows go in one `batch` — arriving as separate messages in written order, `finish` on the last — rather than spending an inference per bubble. Headings, bold labels, lists and tables are reserved for requested structured output; links and necessary code remain available, and a request for detail gets it.
- Chat/agent requests expose only `send_to_user` and the three meta-tools — `batch`, `get_dynamic_tools` and `call_dynamic_tool`, listed after the tools they operate on — initially, plus `reply_to_request` on an agent Turn that has a caller (the voice session or another Bot), which is where its answer goes. Specialist first-party tools live in the `frockbot` namespace: names are listed in the prompt, schemas are read on demand, and execution retains the same admission and authority checks. Background Turns expose `wake_parent` in place of user delivery.
- An `agent` Turn — a question handed to a Bot by the voice session or by another Bot — is a working Turn, so every work tool and model capability admits `chat`, `agent`, `automation` and `subagent`: connected apps, web fetch and search, image generation, Routines, the machine registry, the Computer, and the provider Capabilities. A question asked out loud is therefore answered from the same mailbox or calendar a typed one would be. The narrower admissions are deliberate and are about what the tool touches, not about how much the Turn is trusted: `machine-control` and `machine-messages` reach into the person's own Mac and want them present to answer the approval card, `bot-messaging` and `bot-template-export` act out of the thread the person is reading, so those four stay `chat` only; subagent dispatch and lifecycle stay `chat` and `automation`, which is what bounds the tree to depth one.
- A provider that emits private text instead of a final send gets one bounded delivery-repair step. No provider-specific forced-tool option is assumed.

### Usage accounting

Provider-reported token counts are used when present. Otherwise `estimateModelUsageV1` estimates at 4 bytes per token over the exact journaled request and assembled response, and the event marks the figure as estimated.

---

## 5. Composition

### Resolution and mounting

Composition is the untrusted layer and nothing else. First-party Packages are ordinary imports: `app/packages.ts` lists the 30 the deployment ships as `PackageDefinitionV1` records, and a Package that carries data (settings, Capabilities, Connection Types, durable roots, dependencies) exports its own definition from its own package. There is no manifest, no compiler and no application hash over a plan.

1. On first use the User Durable Object materializes an empty bootstrap generation (`app/composition/user.ts`; `core/durable/composition/generation.ts`), and a Bot's first admission mirrors it. A User who has installed nothing composes nothing, which is why a release no longer has to rewrite every generation to follow the deploy.
2. At admission, `activateCompositionV1` (`app/shell/turn.ts:317`) reads the mirrored pin, mounts, verifies, then commits and records last-known-good on the User.
3. Mounting builds one runtime per Turn (`backend-composition.ts`): the registries, a `LoopHookListV1`, and the features the host lists, mounted in that order by `mountRuntimeFeaturesV1`. Neither the Shell nor `app/agent-runtime.ts` imports an application: the Shell's Bot host carries the deployment's `PackageDefinitionV1` list, its one Package version, and four factories — `base`, `hosted`, `enabled`, `model` — that turn a Package id into a mounted feature (`app/shell/backend-runtime.ts`). `app/runtime.ts` fills them in as `foundationShellApplicationV1`, and `apps/cloudflare/src/bot-state.ts` spreads that into the host. The base Packages — identity, the built-in model, the two demo tools and the Shell's own voice — are appended last, so a provider an earlier Package registered is already there. Every member goes through `PluginWorkerHost`, which mounts the generation's Plugins as one Dynamic Worker per User; each open hook event is registered once on the same list after the app's, over the Plugins this Bot's enable map leaves on that declared it. `panel_focus` mounts only when this Bot's conversation-panel bag is non-empty.

### Generation shape

`CompositionGenerationV1` — `core/durable/composition/generation.ts`:

```
{ schemaVersion: 1, generationId, artifactSetHash, parentGenerationId?,
  summary?, createdAt, origin, members[], status }
```

- `status ∈ pending | active | superseded | failed | quarantined`.
- `origin ∈ bootstrap | bot-authored | revert`.
- `members[]` is `{packageId, version, provenance, artifact, descriptor}`; `provenance ∈ user | bot | installed`. Every member is untrusted, so the artifact and the Frock Compose descriptor are required, not optional.
- `artifactSetHash = sha256(canonicalJson(members sorted by packageId))`.
- `generationId = "<createdAt>:<artifactSetHash[0..16]>"`.
- Caps: 64 members, 160-character summary.

### Where the pin lives

The User Durable Object owns the Composition (ADR 0026): `DurableCompositionStore` (`core/durable/composition-store.ts`) and `DurableCompositionFailureLog` write into the User object under `composition:current` (a `{generationId, artifactSetHash}` pin), `composition:generation:<id>`, `composition:index:<createdAt>:<id>`, `composition:last-known-good`, plus failure, failure-count and quarantine keys, reached through the `readComposition`, `proposeComposition`, `commitComposition`, `failComposition`, `revertComposition` and failure-log RPCs (`app/composition/user.ts`). Pinning is compare-and-swap; a lost race raises `CompositionPinConflictError` and the caller re-reads and re-derives (four attempts).

A Bot admits a Turn inside its own storage transaction, which cannot make a cross-object call, so every admission goes through `admitTurnV1` (`app/composition/bot.ts`) — a chat Turn, a Routine firing, a Subagent task — which first reads the User's pin and fallback and `adopt`s them into the Bot's own `composition:` records: a mirror the admission pins from, never a second truth. A stale mirror is replaced whole, which is also what retires the records a Bot held from before the store moved. Activation reads the mirror, commits and fails against the User, and refreshes the mirror after; the settings views read the User directly.

Which of the User's installed Plugins a Bot runs is the Bot's own revisioned enable map, `plugins:enablement` (`app/plugins/enablement.ts`), read at every mount. The rule per Plugin is its seed state (`app/plugins/catalog.ts`): `locked` always runs, `default-off` runs only when switched on, `default-on` and an opened `admin-gated` run unless switched off, `installable` (a provider Plugin, installed by the account's own Package command) runs only when switched on, and a Plugin a Bot wrote — never in the catalog — runs only when switched on, so a publish alone runs nowhere. A provider Plugin's _model_ contribution is the exception the state does not govern: a Bot whose model names that provider is served by it whatever the switch says (ADR 0032). The list it yields is what the Plugin worker registers tools for and passes as the enabled list on every hook. The same map switches off the first-party features a User may turn off per Bot — web, routines, image, subagents, machine messages, never custom models — while the account-wide installation stays the precondition. Two places enforce it, because only one of the five reaches a Turn through the plan: `maskPlanForBotV1` filters the Bot's execution plan, which is what drops Web's enabled Contribution, and `firstPartyFeatureOnForBotV1` gates the hosted seams in `app/shell/runtime-mount.ts`, which is what leaves image, routines, subagents and machine messages unmounted so their tools are never registered. A Bot with Routines switched off also fires no Routine: the scheduler consumes the occurrence without admitting a Turn (`app/routines/bot.ts`), so its clock advances and the Routine resumes when the switch goes back on.

The deployment's catalog (`DEPLOYMENT_PLUGIN_CATALOG_V1`, built from `app/plugins/seeded/`) is reconciled into the User's Composition on every `readComposition`, which is the read a Bot makes before admitting a Turn: the seeded Plugins the account should carry — every catalog entry except an `admin-gated` one the admin has not opened in the account's features record, and except an `installable` one nobody installed — are proposed beside whatever its Bots wrote whenever the current generation differs, pinned for the next Turn on any of the User's Bots. The same read reconciles the account's own installations (ADR 0032): installing the Package a provider Plugin belongs to installs the deployment's artifact with `installed` provenance, uninstalling removes it, and a generation that already matches holds still. A member matches a catalog entry only when it carries the same artifact _and_ the same descriptor (`memberShipsFromCatalogV1`), because the runtime reads the contract version, the grants and the slots off that descriptor and a Bot reads the Skills off it: a catalog entry whose descriptor moved reaches every account still carrying the old one at that account's next composition read, at unchanged module bytes. Because it runs on the admission read, a lost race or a transient failure during the command self-heals, and an artifact the deployment updated reaches the next Turn.

An in-flight Turn keeps the generation it pinned — a read of that pin falls back to the User when a later admission has already adopted a newer one over the mirror. Activation takes effect at the next admitted Turn.

### Activation and failure — `core/durable/composition/activation.ts`

Failure phases are `resolve | bundle | mount | health`, declared beside the activation that records them (`core/durable/composition/failure.ts`) and raised by the host the app supplies. `activateCompositionV1` reads the pin, mounts and verifies, then commits and clears failures. On failure it records the attempt, marks the generation `failed` or `quarantined`, mounts last-known-good, notifies, and admits the Turn on the fallback. The quarantine threshold is three attempts; a quarantined generation is never retried. If last-known-good is itself the failing generation, the error is rethrown.

### The Plugin worker — `frock-compose/plugin-worker-host.ts`

Every Plugin a generation names mounts into one Dynamic Worker per User, layer two of [ADR 0026](adr/0026-plugins.md). The loop stays in the Bot Durable Object and calls the worker once per open hook per Turn.

- Loading uses the `BOT_PACKAGES` Worker Loader binding, typed structurally as `BotIsolateLoader`. There is no dynamic `import()`.
- `loader.get(loaderId, () => ({compatibilityDate, mainModule: "index.js", modules, globalOutbound, env: {IDENTITY, CAPABILITIES}, limits: {cpuMs: 5000, subRequests: 5}}))`. `modules` is the generated index plus one `plugins/<id>.js` per Plugin (`plugin-worker-wrapper.ts`); `IDENTITY` is `{userId, plugins}`, each Plugin's id, grants and consumed services, and nothing per Bot or per Turn. `globalOutbound` is the `PluginEgress` stub when the enabled Plugins declared a policy, and `null` when they declared no network.
- The loader id is `pluginWorkerLoaderIdV1({userId, moduleSetHash})`, where `pluginWorkerModuleSetHashV1` covers the contract version, the index version, every artifact by content, each Plugin's grants and consumed services, and the binding digest, because a loader id is served from cache with the `env` it was first loaded with. The binding digest (`pluginWorkerBindingDigestV1`) names the User and the egress policy and nothing per Turn or per Bot, so one worker holds across every Turn of every Bot of a User until a Plugin is installed, removed, or a declared host changes.
- Artifacts come from `createR2PackageArtifactStore` (`app/isolates/capabilities.ts`): R2 key `packages/<contentHash>.mjs`, sha-256 verified before load.
- `PluginWorkerHost.mount` first refuses, per Plugin and at `resolve`, a descriptor that does not match its member, names a retired contract, a grant this deployment has not opened, or a slot other than `settings.sections`; orders the rest so a provider mounts before the Plugins that consume its service (`pluginMountOrderV1`, which excludes and names an unmet, mismatched, duplicated or cyclic need); loads every artifact; then mounts and calls `health()` as one guarded phase — a successful report is held for that loader id, so a later Turn that loads it reuses the report, while a failure is not held: a worker that was overloaded when it was asked is asked again. A module that does not parse fails the whole worker at `mount`, naming every Plugin. A Plugin whose report differs from its descriptor — tools, hooks, services, triggers or views — fails at `health` alone; the others still mount.
- On commit the host registers each verified Plugin's tools under its own namespace and one loop hook per event any of them declared. A hook call carries the enabled list; the index runs the enabled Plugins that declared the event in mount order, each seeing the value the one before it left, and names any it skipped. The invocation's deadline is the budget for the whole chain — the Durable Object races the single call against that deadline plus a fixed 250 ms margin (`PLUGIN_WORKER_HOOK_RACE_MARGIN_MS`), so a chain that spends its whole budget still answers before the race fires — and each Plugin gets only what is left of it, one the chain reaches with nothing left being named as skipped. The Durable Object records each named skip as `package/hook-failed`; a worker that does not answer in time, or answers with a value the kernel cannot decode, is charged to every enabled Plugin that wraps the event.
- `BotCapabilities` (`apps/cloudflare/src/bot-capabilities.ts`), a `WorkerEntrypoint`, is the loopback through which every Plugin in the worker reaches the kernel. It is minted per User with the User as its only prop; every call carries an `IsolateScopeV1` — Bot, Session, run, Turn, generation, Plugin — which the wrapper puts on the call from the invocation it is serving, and the Bot Durable Object it routes to resolves that Turn's authority when called and refuses a scope that is neither the Turn it is running nor a standalone mount it registered (see the grants below). Nothing in the stub can go stale, and inside the worker `pluginId` is attribution, never authority, because every Plugin shares a realm.
- **Model providers (ADR 0032).** `PLUGIN_SERVED_PROVIDER_CLAIMS_V1` joins every Plugin-served entry in the compiled provider catalog to the deployment artifact that may claim it, and every mount receives that whole list independently of the Bot's model selection. `PluginWorkerHost` refuses a closed provider claim, a claimant whose Plugin id or content hash differs, and a second claimant at `resolve`; selecting a provider only decides which successfully mounted contribution is registered into the runtime's `llm` registry. The Bot's plugin switch does not govern that model contribution, while its tools and hooks stay off until the switch is on. The Plugin is handed the normalized request without its Connection binding, answers with normalized events over an NDJSON byte stream (`streamModel`), and composes a wire body it hands to `ctx.modelTransport` — which may be called once per attempt, carries the host's one-shot ticket, and sends to the endpoint in force (the Connection's own `api-base-url`, else the catalog's) along the one inference route the catalog names, with the Connection's credential attached by the Bot object and never disclosed. The dispatch must match the **first** journaled `model/request` for its request id, with the same provider, model and Connection binding; a second occurrence is refused before the fetch, so one effect is one upstream call. The attempt's abort is owned by the dispatch, so a Stop, a deadline or an abandoned stream ends the upstream call. `ai` grant calls are not served on a plugin-served provider: they are made outside the loop, under a request id the Plugin chose, and have no durable `model/request` for the transport to bind to.
- The grants reach the Bot object as `isolateAuthority`, `isolateInvokeModel` (the Bot injects the model binding it resolved; a Plugin names a provider and a model, never a Connection), Memory, Workspace, `isolateConnection`, `isolateSchedule`, `isolateStorage{Get,Put,Delete,List}` (a key-value store under `plugin:storage:<pluginId>:` in the Bot object, bounded per value) and `isolateSettings` (`plugin:settings:<pluginId>`, the values the User set for this Bot; the read side ships here and reads `{}` until the authoring surface that writes the key arrives with ADR 0026 step 7). Every grant but `schedule` admits a call from a standalone mount as well as from the resident Turn: `ActiveTurnSlotV1.beginStandalone` registers the mount's identity and members for as long as it lives, and `isolateCallAdmittedV1` (`app/isolates/bot.ts`) admits a scope that names either. `schedule` needs the Turn's runtime and stays Turn-only. A Plugin's model call (`isolateInvokeModel` → `isolateModelPath`) is billed under the Turn's own Session with the Plugin named on the operation's description (`ModelBilling.attribution`), and when the stream ends the call is appended to the Turn's log as `package/model-usage` — the same accounting as the loop's `model/usage`, plus `packageId` and, when the deployment bills, `costMicros` as the call's settlement charged it — which the run projection carries to the client as `plugin/model-usage` and the Work view draws as one row per call under "Plugins" (ADR 0026: itemised per Plugin). A call from a standalone mount has no Turn log and is only in the ledger.
- Egress is `PluginEgress` (`apps/cloudflare/src/plugin-egress.ts`), a `WorkerEntrypoint` bound as the worker's `globalOutbound`, minted with the union of the enabled Plugins' declared hosts or open access (`pluginEgressPolicyV1`). A request outside the policy, or not https, is a thrown error the Plugin's `fetch` sees as a rejection; a worker whose enabled Plugins declare no network has no outbound at all.

### Built-in versus dynamic

First-party code is never a Composition member: it is imported, and `app/packages.ts` is the list that says it exists. A member is untrusted by definition and always carries an artifact and a descriptor.

**Authoring (ADR 0026 step 7).** A Bot writes a Plugin with the `plugin_*` Tool Namespace (`app/plugins/feature.ts`), mounted for a Turn only behind the account's admin-held `pluginAuthoring` feature, beside the managed `plugins` Skill that teaches the SDK (`app/plugins/skills/plugins/`) — two files, every grant on `ctx`, hooks, bundled Skills, services, model providers, triggers, sections, cards, and the failures `plugin_check` returns. Source — `plugin.ts` and `plugin.json` — lives under the User's Package-declared `plugins`/`source` Workspace root, one directory per Plugin (`app/plugins/root.ts`); `plugin_create` writes the SDK scaffold (`applets/sdk/plugin/template/`). `plugin_check` and `plugin_publish` post the source to the Plugin build service (`@frockbot/applet-sdk/build/plugin`), which type-checks against `@frockbot/applet-sdk/plugin`, bundles one module and reads its exports by running it in Miniflare. The app decodes `plugin.json` with the kernel's own descriptor decoder, refuses a descriptor that disagrees with the built module about tools, hooks, services, triggers, views, cards or model providers, verifies the module's hash and stores it under `packages/<hash>.mjs`.

A publish never runs anything. `plugin_publish` and `plugin_enable` write a Plugin intent (`app/plugins/approval.ts`, `plugin:intent:<approvalId>`, keyed by the Turn's `effectId`) and then put an approval card on the Turn's own log naming the Plugin's tools, hooks, grants, hosts and model providers. The approval settlement (`app/approvals/bot.ts`) settles the intent in the same transaction as the decision; after the commit an approved `publish` proposes the generation on the User — the current one with the member replaced or appended, skipped when the Composition already holds that artifact, retried on a lost pin race — and switches the Plugin on for this Bot; an approved `enable` only switches. Last, any decision a person made — approved or denied, on any approval card — opens an input-delivery Turn, so the Bot says the Plugin is ready (or acts on whatever it asked for) without the person having to speak first.

**Skills a Plugin ships (ADR 0030 step 2).** A Skill is a directory: one `SKILL.md` and the Markdown under its `references/`, at most 32 of them and 64 KiB each, listed by the same `WorkspaceReadsV1` walk the `SKILL.md` came through and admitted by the same `isLoadableSkillSourceV1` (`app/skills/catalog.ts`). That walk — and the quota count beside it — lists only `skills/`, the prefix a written Skill lands in, so the rest of an instruction root costs the turn-start path nothing. A Skill past either bound, or one whose reference carries a writer the predicate refuses, is refused whole and recorded in `skill/injected`, which lists every reference a loaded Skill offered with its generation. Bodies stay out of the prompt: `skill_load` takes an optional `reference` and returns that one file, only for a Skill this Turn loaded and only at the generation the catalog listed, and `skill_write` takes a `reference` file name and writes it inside that Skill's own directory under the same quota and provenance (`app/skills/write.ts`, `writeSkillReferenceV1`). `PluginDescriptorV1.skills` is `{slug, text, references?}[]`, decoded with the descriptor's own helpers and bounded three ways — at most 8 Skills, the same 32 references and 64 KiB per file, and 256 KiB of Skill text across the artifact group, counted in encoded bytes rather than code units, so one member cannot outgrow the Composition generation that carries it. That total is `ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1` (`core/contracts/skills.ts`), each artifact's own rather than the catalog's, and the managed set carries it too: both sources load through one loader (`app/skills/artifact.ts`), which parses each document and records a malformed one as a refusal rather than failing the Composition, and past the bound refuses every otherwise valid Skill of the group together. `plugin` is the fourth `SKILL_REF_SOURCES_V1` entry, ref form `plugin/<pluginId>/<slug>`, offered only to a Bot with that Plugin enabled — the same roster the Plugin worker mounts from (`app/skills/bot.ts`, `enabledPluginSkillsV1`, through `SkillsRuntimeHostV1.pluginSkills`) — and `skill_write{scope:"plugin"}` is refused the way `managed` is, because neither is a Workspace file.

**The managed set (ADR 0030 step 5).** Six Skills ship as authored directories compiled into the Skills Package's artifact (`app/skills/managed.ts`): `add-connector`, `export-bot-template`, `import-bot-template` and `write-skill` under `app/skills/managed-skills/`, plus `plugins` (`app/plugins/skills/plugins/`) and `a2ui` (`app/cards/skills/a2ui/`), copied in by `scripts/build-applets-assets.ts`. GrokBot's `learn-from-demonstration` is not among them — the teach-queue and capture UI are not started (parity row 54), so `write-skill` is the path that names `skill_write`. `SKILL_CATALOG_CAPS_V1.managed` is 12, which is the six plus room. `scripts/check-managed-skills.ts` is the typecheck gate that the set is complete, that each `SKILL.md` indexes its `references/`, and that a body does not name a tool this product does not offer. `a2ui` is the Cards catalog: its `SKILL.md` carries the message model, the adjacency-list and binding rules, the budgets and the kernel's action namespaces, and its eleven references — `layout.md`, `text-and-media.md`, `forms.md`, `actions.md`, `frock.md`, `structure.md`, `data.md`, `rich-text.md`, `media.md`, `input.md`, `examples.md` — are loaded one at a time, so a Turn that draws no card pays nothing for the vocabulary and a Turn that draws one pays only for the families it uses. The per-component tables and their minimal examples are _generated_ from the two committed catalogs by `scripts/generate-a2ui-skill.ts`, stitched into hand-written prose in `templates/`; the script fails the build when a catalog component no reference documents, when two document one, when the index in `SKILL.md` stops matching, or when a reference passes 64 KiB, and `bun run typecheck` runs it with `--check`. What the Skill teaches can therefore never disagree with what `admitCardV1` will draw.

**Cards a Plugin draws (ADR 0030 step 6).** `PluginDescriptorV1.cards` is `{id, displayName, description, dataSchema, actions}[]` — at most 16 cards, 16 actions each, a 64 KiB schema — and declares what the Bot fills in, never how the card looks, because a Plugin's surface may depend on its values. The surface is what `renderCard` answers with. Each card is offered to the Bot as one tool in the Plugin's own Tool Namespace, named `<pluginId>_<cardId>` (`pluginCardToolNameV1`), taking `{data, surfaceId?}`; a declared tool of that name is refused at decode. The tool (`PluginWorkerHost.cardDefinition`) validates `data` against `dataSchema` with the kernel's own JSON Schema subset (`core/contracts/json-schema.ts`, which refuses a schema keyword it cannot enforce rather than ignoring it), mints the surface id unless the Bot named one it already drew, calls `renderCard` under the same deadline and race a tool call runs under, and hands the messages to the app's `sendCard` seam — `app/shell/backend-composition.ts` — which decodes them as a `card` payload and records the send on the Turn's log through the same `recordSendToUserV1` the Bot's own `send_to_user` uses. A host with no `sendCard`, which is what a standalone mount is, registers no card tools at all.

Trust chrome is bound there: `bindCardApprovalsV1` (`app/shell/cards.ts`) overwrites every `ApprovalActions` component's `approvalId` with one the kernel mints and records the matching `approval` send beside the card, so a Card can only ever point a decision at an Approval the kernel issued. The seam also records what that decision _covers_: `shell:card-approval:<pluginId>:<surfaceId>` (`createCardApprovalStoreV1`) holds the ids it minted beside `cardValuesDigestV1` of the values the card was drawn with, which is what lets a capability refuse an Approval that was given on another card or for other values. One draft is one live decision: a redraw of a surface whose decision is still pending reuses that decision when the values digest the same, and is refused outright when they do not, so the Bot draws a new card rather than moving what a pending decision covers. A decision the person already approved and nothing has spent yet is refused the same way — redrawing over it would ask them a second time for what they already answered — unless the draw is the very effect the decision was asked under, which recomputes the ids the binding already holds and so is the replay the send's own effect-id dedupe makes a no-op — while a declined decision, and one whose single use has been claimed at `shell:card-approval-used:<approvalId>`, leave the surface free to draw its receipt. The Approval is recorded with the words the draw declared beside its `covers` — `decision: { action, risk, rationale? }` — because the Frock catalog allows the `ApprovalActions` component an `approvalId` and its two labels and nothing else; a draw that asks for a decision and declares no `decision` is refused exactly as one declaring no `covers` is. The ids the kernel mints are `card-approval-<seed>-<index>`, where the seed is a digest of the Bot's own stored secret, the Session, and the effect the send is recorded under: the same effect of the same Session recomputes the same ids, so a replayed Turn rebinds the decision it already asked for, while two Sessions of one Bot — every Routine has its own, and each starts its own turn count — can never share a decision, and nothing outside the Durable Object can compute one. That prefix is refused for any model-supplied `approvalId` at `decodeSendToUserPayloadV1`, so the one namespace Approval records share cannot be written into from `send_to_user`. `ConnectApp` is bound the same way by `bindCardConnectAppsV1`, in `recordSendToUserV1` — which every card send passes, the Bot's own and a Plugin's alike — and in the fold of a Plugin handler's answer: the component's `app` is looked up in the compiled connect catalog (`connectCardAppV1`, `app/connect/card.ts`, which takes the id or the name however it is spelled), and its `name`, `description`, `packageId` and `connectionTypeId` are overwritten with the catalog's, so the words beside the button are never the card's and the button can only start the grant it names. An app the catalog does not carry refuses the send whole, naming the closest apps it does. A card that asked for a decision ends the Turn, as an approval send does. A press the renderer names `plugin/<pluginId>/<action>` reaches `cardAction` on the worker with the Bot's authority for that Turn (`app/cards/bot.ts`) carrying the `cardId` the surface was minted for and the Card's stored `record` beside the surface id, the action and the client's data model — so a handler reads which card it is on and what that card holds without keeping a second copy of either, and a press whose surface names a different card of the same Plugin is dropped rather than answered on the wrong surface — the answer is folded into the Card, and an `input` the handler returned is enqueued as a `card-action` pending input for the next user-lane Turn. A press the kernel will not put to the Plugin at all is refused off the roster and the descriptor before a worker is reached, and in three different words because they are three different things: a Plugin this Bot's Composition no longer carries has no switch to throw, a member that is off says whether the person switched it off or a quarantine did (the health record is what tells those apart), and a member that is on whose card declares no such action says that — none of them charged to a Plugin that never ran. The worker side is the generated index: `cards` in the health report carries each card's id _and the actions it owns_, checked against the descriptor the way tools are, and a press is resolved against that declaration rather than by scanning the module — a module declaring one action name on two cards fails to mount, and one whose actions disagree with the descriptor fails health. A card's `render` and its `actions` are declared by `declaredCards`, and both calls are deadline-guarded and answer with a drop that leaves the Card exactly as it was; a draw or a press that threw, overran its own deadline, reached no worker or answered undecodably is charged to the Plugin's health, while one marked `deliberate` — a handler refusing in as many words — is not, and neither is a draw the Turn's own signal ended, because a person pressing stop or a Turn running out of time is not the Plugin failing (`RaceAbortedError`, which is how the race tells the two aborts apart). `PLUGIN_WORKER_INDEX_VERSION` is `index-v10` and `ISOLATE_CONTRACT_VERSION` is 7: version 5 opened `ctx.email` under the `http` grant, version 6 adds `streamModel` with the credentialed `ctx.modelTransport` a provider contribution calls ([ADR 0032](adr/0032-plugin-model-providers.md)), and version 7 adds `theme/assemble` ([ADR 0026](adr/0026-plugins.md)).

**Seeded Plugins and the email card (ADR 0030 step 6).** `DEPLOYMENT_PLUGIN_CATALOG_V1` is no longer empty. One directory per Plugin under `app/plugins/seeded/` — `plugin.json`, `plugin.ts`, and `SKILL.md` (plus `references/` when the procedure has more than one file) when the Plugin has anything to teach the Bot — is built by `scripts/build-seeded-plugins.ts` through the same `runPluginBuildV1` an authored Plugin goes through, compared with its descriptor by the same `pluginManifestDisagreementV1` the publish path uses, and written into `app/plugins/seeded/artifacts.generated.ts` with its content hash, its size and the module text. The module travels in the Worker bundle because a seeded artifact has no publisher to put it in R2: `createR2PackageArtifactStore` answers a seeded content hash from that table before it reaches the bucket, under the same content address. `bun run typecheck` runs the script's `--check`, which compares each directory's digest with the `sourceHash` the build recorded, so a Plugin edited without a rebuild fails the typecheck. Every entry's descriptor must also name a contract version the deployment still serves — `app/plugins/catalog.test.ts` holds the catalog to it, and rebuilding the directory is what moves an entry onto a newer one — because a seeded member is carried to every account that should have it, so a retired contract there is refused everywhere rather than on one Bot. A deployment with no `BOT_PACKAGES` loader seeds nothing, because a member nothing can mount would fail every Turn rather than the one Plugin.

The first seeded Plugin is `email`, `default-off`: a `draft` card over `{to, cc?, subject, inReplyTo?, body}` drawn from the Frock catalog's `StatusPill`, `KeyValueRows`, `CollapsibleText`, `ApprovalActions` and `Receipt` — the headers are rows and the body collapses in the component whose job that is, so the card declares no action of its own — two tools the Bot spends the decision with — `email_send` and `email_discard`, each naming the card's `surfaceId` — and the Skill that says when to draft. Sending is not the card's: on the Turn after the person approved, the Bot calls `email_send`, which sends through `ctx.email` — the kernel loopback `isolateEmail` (`app/isolates/bot.ts`) over the deployment's own sender (`app/email/sender.ts`, `EMAIL_SENDER`), attributed to the Bot, never a credential the Plugin holds. The request names the card's `surfaceId` as well as the `approvalId`, and the loopback refuses unless the Approval is the one bound to that Plugin and surface _and_ the message digests to the values the binding recorded, so an approved decision about anything else authorizes nothing; an address that is not an address, or is longer than the kernel's own bound, is refused when the card is drawn, and a refused request answers with its own reason rather than the deployment's — and the card settles into a `Receipt` the next time it is drawn. A deployment that has bound no sender answers unavailable, in words the card shows. Because `http` now opens two members rather than one, both are said wherever the reach is: the approval a User activates a Plugin with (`pluginApprovalActionV1`) and the Plugins page row (`pluginNetworkCopyV1`) name the deployment's sender beside the declared hosts, and a Plugin that declares no host of its own reads as reaching none rather than as reaching nothing — the same approval also names each card's tool, so a Plugin whose whole Bot-facing surface is cards does not read as offering nothing.

**The five locked card Plugins (ADR 0030 step 7).** `approvals`, `questions`, `attachments`, `credentials` and `agents` are seeded `locked`: they run on every Bot, a User cannot switch them off, and a Bot's Plugins page leaves them out because there is nothing on them to change. Each declares one card and no tool, holds no grant, and ships no Skill — `send_to_user` already tells the Bot about the members they draw. They are how the `approval`, `widget`, `attachment`, `secret-request` and `agent-card` payloads reach the screen; see §6, "The first-party cards are Plugins", for the seam that maps a send onto one. `locked` is not a convenience: the conversation cannot lose the ability to ask for a decision, hand over a file or say a credential is missing, so a switch on one of these would be a switch on the Bot's voice — and a locked Plugin's failure is fatal, which is the same sentence read the other way.

**The `connectors` card Plugin.** Seeded `locked` beside them, for the same reason: offering an app the Bot cannot reach is how a Bot asks for more reach, and the only way it may. It declares one card, `offer` over `{app, reason?}` — the tool `connectors_offer` — no tool and no grant, and draws the reason above a `ConnectApp`. It draws no legacy member and so ships no Skill either; the managed `add-connector` Skill is what tells a Bot that cannot reach an app to draw it. The Bot proposes and the person connects: nothing about the press reaches the Bot, and the app's tools reach it on a later Turn.

**Failure and quarantine (ADR 0026 step 9).** Every Plugin failure the mount host names — a descriptor refused at `resolve`, a module that does not parse, a health report that disagrees, a hook that throws or overruns — reaches the Bot through the mount options' `onPluginFailure` seam (`app/plugins/health-bot.ts`). The Turn carries on without the Plugin; the User gets a notice in their inbox (one per Turn for a hook, one per generation for a mount phase); and the failure counts toward the per-Bot quarantine (`app/plugins/health.ts`, `plugin:health:<pluginId>`): three failures in a row — Turns, card presses and card draws counted in one total — switch it off in the Bot's enable map with a critical notice, and the Plugins page says so on its card. A Turn the Plugin ran through cleanly resets the count (`settlePluginHealthV1`, after every Turn); once a Plugin is quarantined its later failures neither count again nor raise a notice the User has already answered; switching the Plugin on again clears its history. A locked Plugin's failure is fatal — the mount, or the hook it was raised in, fails the Turn — because a locked Plugin cannot be skipped. A card press and a card draw are charged the same way, but neither is a Turn, so the record carries what the run is made of (`failureKinds`) beside how long it is: a press's notice says the press did not go through rather than that a Turn was lost, and the count and the quarantine notice read a run back as Turns, presses or draws only when the whole run was that one kind — a mixed run says only that the Plugin failed that many times, and a record written before the kinds were carried reads as mixed rather than as Turns. What turns a Plugin off is the total, whatever it is made of. A Plugin on a retired contract version is refused at `resolve` and therefore noticed and, after three Turns, turned off.

**Triggers (ADR 0026 step 8).** A Routine's trigger is `{ kind: "webhook" }`, `{ kind: "plugin", pluginId, trigger }`, or `{ kind: "connection", connectionId, triggerType, config? }` (`app/routines/records.ts`). Webhook and Plugin triggers enter through the same signed webhook door (`app/routines/hook.ts`, `app/routines/backend.ts`), keyed and replay-guarded alike, and `routine_manage` takes a `pluginTrigger` beside `trigger`. For a Plugin trigger the store (`RoutineStore.deliverHook`) makes the door's checks in one transaction, hands the delivery — body and the sender's headers, never the door's credential — to the Plugin outside any transaction, then enqueues the firing with the Plugin's text as the delivered payload, or records a drop with the Plugin's reason so a replay answers the same. `deliverPluginTriggerV1` (`app/plugins/triggers-bot.ts`) mounts the User's Plugin worker for the delivery alone under a synthetic Turn identity naming the Routine, delivers to `receiveTrigger`, and disposes; a Plugin that is off for this Bot, declares no such trigger, or does not mount is a drop with that reason. A connection trigger lives at the provider; see §8.

---

## 6. Clients

There is one client. `apps/native` is a Flutter app; built for the browser it is
what `bot.frockbot.com` serves, and built for Android, macOS or iOS it is the
same Dart on a device. The two differ only at four conditional-import seams — the
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
also stages Rive Native's WebAssembly runtime under
`apps/cloudflare/dist/web/rive/<wasmVersion>/` and names it to the Dart side
with `--dart-define=RIVE_NATIVE_WASM_HOST=/rive/<wasmVersion>/`, so that
runtime too comes from this origin (see the policy below). It writes a
`_headers` file marking everything under either prefix `immutable` for a year,
and records the build hash in `apps/cloudflare/dist/flutter-web.json`.

The runtime is named by Rive's own version rather than the build hash, because
that hash is only known after a build that has to be told the URL first. The
version the Dart package asks for and the version the npm dependency installs
are pinned in different files, so the build reads the former out of
`apps/native/.dart_tool/package_config.json` — which is why it runs `flutter
pub get` before anything else — and refuses on drift. It also refuses to stage
a bundle whose `main.dart.js` still names `cdn.jsdelivr.net`, so a dropped or
renamed `--dart-define` fails the build rather than shipping a blank window.

That directory is the app Worker's `assets` binding
(`apps/cloudflare/wrangler.jsonc:27`, and again in `development` (:176),
`staging` (:300) and `e2e` (:415)). The payload is uploaded with the deploy and answered by the asset router before the
Worker runs, so it needs no route, no bucket and no seeding step, and the same
`wrangler dev` that runs the Worker locally serves it. `html_handling` and
`not_found_handling` are both `"none"`: the document is rendered per account, so
an asset directory that answered `/` or invented an index would answer for it.
`isPublicAssetPathV1` (`apps/cloudflare/src/gateway.ts`) admits `/`,
`/favicon.ico`, and What’s New stills at `/whats-new/<file>.webp` — product
copy, loaded by a plain GET. No request for the client's own bytes ever
reaches the gateway.

The document is `appHtml()` (`apps/cloudflare/src/user-application.ts:101`).
`build-artifact.ts` defines `__FROCKBOT_FLUTTER_BUILD__` from `flutter-web.json`
and `__FROCKBOT_CLIENT_ICON__` from the brand icon; those two are all the
artifact carries of the client. The page is a
`<base href="/_flutter/<buildHash>/">`, four `data-frockbot-*` body attributes
and one `<script src="…/flutter_bootstrap.js" async>`. Every engine URL is relative to that base, so a new client build is a new path
rather than a new body at an old one, and the document is the only thing that
changes when the client does.

Identity is handed over in the document. A browser's session is a cookie it
cannot read, so the Worker stamps the account onto `<body>` —
`HOSTED_EMBEDDED_BODY_ATTRIBUTES_V1` (`user-application.ts:103`):
`data-frockbot-user-id`, `data-frockbot-auth-mode`, `data-frockbot-is-admin` —
and `bootstrapUserIdV1()` (`apps/native/lib/client/identity_web.dart`) reads
them on the first frame, so `restore()` (`apps/native/lib/main.dart:117`) paints
the shell instead of flashing the sign-in door at someone who is already signed in.
The `/api/identity` read still happens; the attributes are what it confirms.
`identity_io.dart` returns null, because the phone is handed no document.

The app origin's policy is `withSecurityHeaders` (`user-application.ts:143`).
Two relaxations belong to the engine and neither is avoidable:
`script-src 'wasm-unsafe-eval'`, because CanvasKit instantiates WebAssembly, and
`style-src 'unsafe-inline'`, because the engine injects a `<style>` element to
measure text.
`img-src` allows `data:` and `blob:` for what the app decodes itself, and
`base-uri` is `'self'` rather than `'none'` because the document sets a `<base
href>` of its own. `frame-src` names only the Computer host's viewer origins
(`COMPUTER_HOST_CAPABILITIES_V1.viewerFrameOrigins`): the Computer viewer is the
one page the app frames.
CanvasKit is built local (`--no-web-resources-cdn`) so `script-src 'self'` stays
true and no engine byte is fetched from gstatic. Rive Native's WebAssembly
runtime is staged and served from this origin for the same reason: left to
itself `rive_native` fetches it from jsdelivr, and because its loader appends a
`<script>` and awaits a `load` event that a refusal never fires, a blocked
runtime is not a failure it sees — `RiveNative.init()` simply never settles.
Widening `script-src` was rejected in favour of serving the bytes; the loader is
additionally given a deadline in `lib/main.dart`, past which a missing runtime
costs the animation rather than the window.

There is no service worker. Every URL under the prefix is content-addressed and
served `immutable`, so a cache the page managed itself would duplicate the
browser's with a second staleness rule to get wrong.

### The app

`lib/main.dart` is the app entry and the sign-in door: the `MaterialApp`, the
session, the `?bot=` deep link, which it hands to the shell through a
`ValueNotifier` rather than acting on, and one `builder` that puts the mobile
update header above every screen (`lib/update/update_ready.dart`; the patch
delivery it serves is [`apps/native/README.md`](../apps/native/README.md)). On
macOS the same `builder` provides the desktop updater, drawn as a control
beside the profile button (`lib/update/desktop_update.dart`, Sparkle underneath;
the plan for every platform is [`docs/app-updates.md`](app-updates.md)).
Everything a person looks at is `lib/shell/`.

Voice is shell-owned chrome shared by web, Android and macOS: the composer
microphone starts dictation into the selected Bot's draft, and the control at
its far right starts a call with that Bot — the only way in, the sidebar's
list-root control having gone (ADR 0029), so a call always names a Bot. A call
with the Bot on screen is **voice mode**: `lib/voice/voice_mode.dart` takes
the place of the thread and the composer, and neither is drawn. A call with
another Bot is drawn instead in a footer below the complete shell layout, so
looking at one Bot while talking to another still works. Capture and playback
live under `apps/native/lib/voice/`; the authenticated gateway sockets and
durable voice ledger are described in [`docs/voice.md`](voice.md).

**The shell layout.** `lib/shell/desktop_layout.dart` has three tiers at two
widths. Above 980 points the shell is three columns — the Bot list, the
conversation, and the right panel. At or below 980 the right panel becomes a
drawer over the conversation; at or below 640 the Bot list goes the same way and
the conversation has the window. A region is a column or a drawer, never both,
so nothing is built twice; a parked drawer is
inert to the pointer, to assistive technology and to its own tickers, and one
scrim serves whichever drawer is open.

**The slot registry.** `lib/shell/slots.dart` is where a feature reaches the
shell: two named regions — `right-panel` and `overlays` — that a feature
registers a `WidgetBuilder` into and the shell draws where the region belongs.
An empty region draws nothing, so the layout reserves no space for a feature
that is not there. Trust chrome is never a slot: the transcript, the composer
and the Bot list are the shell's own, and what one Bot holds belongs to that
Bot's own surfaces rather than to a region over the list of every Bot.

**Semantics identifiers.** Flutter Web draws to a canvas, so a browser spec can
only select the engine's accessibility tree. Every interactive widget carries a
`Semantics(identifier:)` whose name is written once in
`lib/shell/semantics.dart`, and Playwright selects on
`[flt-semantics-identifier="chat-composer"]`.

Screens (no router; `MaterialApp(home:)` plus `Navigator.push`):

- `FrockBotApp` — `lib/main.dart:44`, `ThemeMode.dark` hardcoded
- `SignInPage` — `lib/auth/sign_in_page.dart:5`
- `AppShell` — `lib/shell/app_shell.dart`: the directory, the identities the
  sidebar groups by, the unread fan-out, the right-panel drawer, the slot
  registry, the Bot's page, You and the selected Bot's Session,
  whose controller the chrome's connection, working-Turn and Computer marks are
  read off rather than mirrored in the shell. Three tiers
  (`lib/shell/desktop_layout.dart`): columns at a desk; below 640 the Bot list
  is the first screen, a conversation is a page over it with Back to the list,
  and the conversation's bar is GrokBot's — Back, the Bot's name as the way to
  its page, the Computer
- `ShellSidebar` — `lib/shell/sidebar.dart`: pinned tiles in pin order, label
  groups, unread badges, hidden Bots, and the list's own controls: You, What’s
  New, search, create
- `ProfilePage` — `lib/shell/profile_page.dart`: You, the account's
  destinations. Below 640 a list whose rows each push their page; wider, the
  rows are a column beside the chosen page, which keeps its own stack inside
  a nested `Navigator`, so another row swaps the page in place and Back leaves
  that stack before it leaves You
- `ChatPane` / `ConversationView` — `lib/shell/chat_pane.dart` over
  `lib/shell/transcript.dart`, `composer.dart`, `markdown.dart`,
  `send_payload.dart` and `skill_menu.dart`
- `RunView` — `lib/shell/run_view.dart`: a Turn's tool receipts, on the right
  panel at wide widths and as a page on the phone. The thread never names a
  tool; it offers one control that opens this.
- `ExchangeView` — `lib/shell/exchange_view.dart`: the view-only chat between
  this Bot and one counterpart, opened by the thread's exchange marker, in the
  right panel beside `RunView` at wide widths and a pushed page on the phone.
  There is no composer and the footer says the chat is view-only.
  `ExchangeController` (`lib/client/exchange_controller.dart`) pages the
  counterpart-filtered run read and merges the loaded thread, so an exchange
  still in flight updates live.
- `BotRecoveryPage` — `lib/recovery/page.dart:11`, Manage Bots on the account
  sheet, detail with three tabs at `:202`
- `DeletionPage` — `lib/settings/account_deletion.dart`, You → Delete: "Delete
  my Computer" behind one confirmation, and "Delete account" behind typing the
  phrase `GET /api/account/delete` names. Each press keeps one command id across
  its retries; once the account is being deleted the device signs out.
- `SettingsPage` — `lib/settings/page.dart`: a host over `ViewDocumentView`,
  not a renderer of its own. `ModelPicker` at `lib/settings/model_picker.dart`
  is the host editor for the one field whose choices are a paged catalog.
- `BotPageView` — `lib/shell/bot_page.dart`: what a Bot is _doing_. The right
  panel's root at the wide tiers and a pushed page on the phone, in one scroll:
  the Computer card when the Bot has one, the last Routine firings as loose
  one-line rows — name, then the time and a running / finished / failed mark
  at the end — with the All Routines door under them, and the doors of its
  Plugin panels. The Bot's name in the conversation bar is the one way in at
  every tier, and the gear in the page's own header is the one way to Settings
- `BotSettingsView` — `lib/settings/bot_settings.dart`: what a Bot _is_ — its
  character, its About fields, its behaviour switches, its Plugins and model,
  and the two danger rows — written
  as they are edited rather than on a Save button. One level under the Bot page
  at every width, in one card grammar: a section label over a `FrockRowGroup`,
  with the About fields on a card of their own. There is no Advanced expander
  and no Members tile
- `ConnectionsPage` — `lib/connections/page.dart`: a host over
  `ViewDocumentView` for the accounts a User authorizes once for every Bot
- `PluginsPage` — `lib/plugins/page.dart`: the same host over the Plugins
  document, plus the controller that carries enablement to the settings route.
  A Bot's page is reached from the Plugins row in its Settings at every tier —
  a sub-page of the panel on a desktop, a pushed page on the phone — keyed per
  Bot and drawn without chrome because the panel names it. The projection files
  each Plugin under its kind and the host draws those as labelled cards of rows
  (`ViewDocumentView.switchRows`) rather than a card per Plugin; the Profile's
  entry is the account's list
- `RoutinesView` — `lib/routines/page.dart`: what a Bot does on its own and
  what it left behind, reached from the All Routines row on the Bot page — a
  sub-page of the panel on a desktop, a pushed page on the phone. The
  projection files each Routine under Scheduled or Webhooks. The host draws
  each Routine as a door — tap opens the read-only detail, the switch at the
  end is only the switch — with that Routine's recent completions under it as
  the same loose rows the Bot page uses. Conversation authors a Routine
  ([ADR 0033](adr/0033-conversation-authored-routines.md)); there is no
  create/edit form. The detail stays inside the right panel (or the phone
  page), not a second settings screen. `RoutineRunsPage`
  (`lib/routines/runs.dart`) is one Routine's firings, and one firing opens on
  the Work view. `RoutineInboxController` reads the completion inbox once for
  the recent runs the Bot page lists.
- `AuditPage` — `lib/audit/page.dart`: every effect a Bot performed, and each
  use of the microphone by a Plugin's page, filtered by kind, with an audited
  effect's Turn opening on the Work view
- `WhatsNewPage` — `lib/whats_new/page.dart`: the curated list of what
  production shipped, from `GET /api/whats-new`. Reached from the megaphone
  beside the profile in the sidebar, which wears an unread mark; it never
  opens itself. Dates are the first production tag that
  contained the entry, not the pull request: the tag deploy writes them into
  the Worker with `app/whats-new/published.ts`, so every other build serves
  the entries undated and they read “New”. A still is optional, one WebP
  served at `/whats-new/<file>`, same origin. Each entry is its own file under
  `app/whats-new/entries/`, ordered newest first by the instant it was
  written, so pull requests that each add one do not collide. A pull request
  that touches `app/whats-new/**` posts a comment with the copy and stills
  from the branch head, so they can be reviewed there.
- `SearchOverlay` — `lib/search/overlay.dart` over `lib/search/controller.dart`:
  the backend index across every Bot, debounced, with each of its four states
  named
- `CreateBotSheet` — `lib/flock/create.dart`: a character, a name and the first
  thing to say to the Bot, opened from the sidebar's own create gesture
- `MachinesPage` — `lib/machines/page.dart`: a host over `ViewDocumentView` for
  the computers a Bot may reach, plus the pairing code the host holds
- `TemplatesPage` — `lib/templates/page.dart`: the same host twice, a tab
  apiece — what this Bot is packed into, and what this account has imported
- `PanelCanvas` — `lib/panels/canvas.dart`: the conversation panel for this Bot. A host tab strip over the focused Plugin's `ViewDocument` or its own page, in the right column on a wide window and a pushed page on a phone. The bag, the Session focus and the `bot.nav` doors come from `GET /api/bots/:bot/panels/open`. Empty bag: the region is not offered
- `ComputerCard` → `ComputerViewerPage` — `lib/computer/card.dart`: the Bot's
  screen, live or as its last capture, and the full-window viewer it opens
- `ViewSamplePage` — `lib/view/sample_page.dart:117`, reachable only from a `--dart-define=FROCKBOT_DEV_AUTH=true` build

The thread's rules: a Turn is ordered as a unit by its own user message's
stamp, except that a message sent while an earlier Turn was running is drawn
where it landed — after what that Turn had already said, above what it said
next — by the Session positions the wire carries (`transcript_model.dart`); a
message the person sends is drawn at full strength from the moment it is sent;
a draft belongs to the Bot it was typed for and survives a refusal
(`composer.dart`); and readiness and the draft are separate questions so Try
again works with an empty composer. A running Turn's reply draft (`ChatController.drafts`,
from `state/draft` frames) is drawn as the lines its messages will be, under the
`<runId>:send:<ordinal>` ids they will have, so a message that lands replaces its
draft in place; a draft has no message actions and is never reported as read, and
it is dropped when its run settles, when a snapshot replaces the page, and when
the socket drops.

Transport is REST over `package:http` behind a conditional import (`lib/client/transport.dart`, `transport_io.dart`, `transport_web.dart`). `--dart-define=FROCKBOT_ORIGIN` names the gateway; left unset it is `https://bot.frockbot.com` on the phone, which has no origin of its own, and `window.location.origin` in the browser, which is served by the gateway it talks to and may be on any port. There is one read-only WebSocket at `/api/bots/{botId}/state-channel` with a strict `cursor + 1` contiguity rule for committed frames (`lib/client/state_channel.dart`), a `state/draft` frame that sits outside the cursor but is queued with them so it is never applied after the message that replaces it, a 64 KiB frame cap and 1–30 s backoff. The client asks for drafts with `drafts=1`; a server that predates them ignores the parameter, and an installed client that never asks is never sent one — its generated `StateFrame` decoder has no `state/draft`, and an unknown frame drops its socket.

On the phone, auth is PKCE in the system browser (`lib/client/auth.dart:17`), returning over an App Link validated in `accept()` (`:60`); the session token lives in `flutter_secure_storage`, and the directory, drafts, cached transcripts and cursors are plaintext JSON on disk (`lib/client/plain_store_io.dart:13`, `:100`). In the browser the same seams are the hosted better-auth Google redirect (`auth_web.dart`), a cookie the client never sees, and `localStorage` (`plain_store_web.dart`).

`lib/protocol/client_wire.generated.dart` (1054 lines) is generated by `scripts/generate-dart-protocol.ts:119` from `core/protocol-schemas/schema/client-wire.schema.json`. Its classes wrap an opaque `Object? _json` and validate; they are not typed models, so call sites index by string.

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

A field whose `choiceSource` names something the document cannot draw is drawn
by the host, not by the document: `ViewScope.fields` maps a `choiceSource` to a
host editor the way `ViewScope.frames` maps an `embed` name to a host region.
The settings surface supplies the model picker for the paged catalog
(`account-models`).

**A Bot's Plugins, the same way.** One more projection in that family:
`app/plugins/page.ts` draws `BotPluginsFrameV1` (`GET /api/bots/:botId/plugins`,
`?as=document`, surface `bot-plugins`) from `app/plugins/bot.ts`, a row per
first-party feature, seeded Plugin and Plugin a Bot wrote, under two headings:
**Built in** and **Made by your Bots**. Every row is something the person can
switch. A locked Plugin runs for every Bot and a Plugin that only serves a
model runs when that model is chosen, so neither is a row. A press posts
`set-plugin-enabled` back to the same route carrying the revision the page
read, so the Bot answers `applied`, `conflict` — the page re-reads — or
`rejected` with the reason. The Flutter host draws it from `PluginsController`
(`lib/plugins/page.dart`). There is no account-wide Plugins list and no
account-wide feature switchboard: the first-party features a Bot switches are
platform-owned Packages, so the account always holds them and the Bot's switch
is the only one, and a model provider is added and removed in the Marketplace.

**Marketplace is one searchable catalog.** `apps/native/lib/connections/page.dart`
draws `ConnectionsFrame` (`/api/settings/connections?catalog=1`) as a single
page: one search box, Models and Connectors checkboxes under it, Catalog and
Installed halves, and a builder list so cards mount as the person scrolls. The
catalog includes every non-platform model provider and every connected app,
whether or not the Package is installed — some 1,500 rows — so it is read a
page at a time. The route takes the search as `q`, the checkboxes as `kinds`,
the Installed half as `installed=1`, and a `cursor`; `connectionsFrame`
matches them and answers fifty cards with every account and a `nextCursor`
while more remain. A cursor counts cards, not rows, so a model provider's ways
in never straddle a page. The client asks again once typing pauses and at
once for a checkbox or a half, reads the next page when the list's last row
comes into view, and settles a press by reading the cards it already drew
(`limit`) rather than the catalog. A model row says whether its Package
is `installed` — a key left behind by a provider that was removed does not
count — and one that is not offers **Add** (`user/choose-model-provider`, which
also reconciles a provider Plugin into the Composition), which opens the key
form at once for a keyed provider; **Connect** is the same key or sign-in flow
as before, and a connected model provider's card offers **Choose a model**,
which opens Models. Cards are laid out in rows rather than a fixed-height grid
so an opened card is never clipped. Installed lists added models and connected
apps so they can be configured or removed (`user/uninstall-package`). Models
settings lists only providers already added, with a link back to this catalog,
and each built-in model in the picker says it needs no key. The ordinary
`/api/settings/connections`
read stays installed-only, so Manage provider does not grow a storefront.
Each card carries a bundled icon (`assets/connectors/<icon>.png`, named by
the Connection Type's `icon`) or a letter tile when no mark ships. Catalog
model marks are host assets, the same way connected-app marks are — compiled
providers are Packages, not Plugins, and a Plugin cannot ship an image.
Refresh the catalog set with `python3 scripts/sync-connector-icons.py`
(Lobe Icons, MIT). Radius has no mark in that pack and stays a letter tile. The frame
carries what the surface needs and no credential: a provider row per
Connection Type, the accounts with the line that says what their state
means, and the "Model in use" line, written by `modelRuntimeLabel` where the
settings live. A connector Package with several types is a grouping, so each
of its rows is named by its type and is a card of its own. A model provider's
types are ways into one provider — a key, a sign-in — so every row of it is
named for the provider, and the client draws them as one card that offers
each way and lists the accounts of all of them; commands and accounts stay per
Connection Type. A model provider's accounts and a connector's are one frame
because the surface a person opens to connect something is one surface;
`packageConfigurationHomeV1` decides which page shows a row, and travels as
the row's `kind`. The requests a press becomes live in
`lib/connections/document.dart`: a Connection command goes to
`/api/connections`, a revocation to the Package's own route, and a hosted grant
is a `connection/start` whose answer is a URL the app opens after checking it.
That start names the app's own `returnClient` — `android`, `macos`, `ios`, or `macos-dev` and `ios-dev` from the FrockBot Dev builds, and
nothing from a browser tab or any other platform — so the door sends the person
back through the page that reopens the app: the verified App Link the manifest
claims at `/api/connect/callback/android`, or the same page handed to the
`frockbot://` scheme on a Mac or an iPhone (`frockbot-dev://` and the `-dev` segment for FrockBot Dev). `main.dart` recognises exactly this build's three links
(`isConnectReturnV1`) and bumps `connectReturns`, which the page reads its
frame again on rather than waiting for a lifecycle resume; the next settings
read is what settles the Connection. The one thing read from a link is an MCP
server's sign-in answer (`mcp_state`, `mcp_code`, `mcp_iss`, `mcp_error`),
which `main.dart` first sends to `POST /api/mcp/oauth/complete` under the app's
own session (`mcpSignInCompletionV1`); a refusal is set on
`connectReturnNotice`, which the page shows. While a
press is in flight the page tracks the one `pendingRow`, so the pressed pill
shows the wait and no other row looks disabled.

`lib/view/surface.dart` is what both pages are: `ViewSurfaceController` is the
read and the dispatch, `ViewSurfacePage` is the chrome, the empty state, the
pull to refresh and the one `ViewController` per revision. A page is a
controller and a title, and the surface borrows that controller: the page
creates it, replaces it when the read it is over changes and disposes it, and
the surface only listens while it is mounted. An editor that asks before a
dirty leave installs `confirmLeave` on that chrome: the AppBar back and the
system back both go through it, and a save or cancel that already decided to
leave does not.

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
  the Routines a Bot holds and the completions nested under each of them —
  because a client that had to ask twice could file a run under the wrong
  Routine. Its action kinds are one closed vocabulary
  (`ROUTINE_ACTION_KINDS_V1`): the Routine commands the route already takes —
  pause or resume, run, delete, rotate or revoke a key — and the navigation
  no route owns, which is a completion's run log and the detail a row opens.
  Conversation authors a Routine; the list is not a form
  ([ADR 0033](adr/0033-conversation-authored-routines.md)).
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
adopts a fresh `ViewController` exactly when what it is showing has changed and
keeps the one it has when nothing did.

The last list `ViewDocument` for Routines, Plugins, Machines and Settings is
kept the way a conversation page is (`lib/client/document_cache.dart`):
memory is what a remount paints from in the tap frame, disk is what a later
process finds, and the host then lets the live read replace it if the
revision moved. A shape this build cannot read is discarded wholesale. Editor
and create documents, minted webhook keys and pairing codes are never written
there. The Bot page prefetches the Routines list and that Bot's Plugins so those
doors can open on cache. `GET …/routines?as=document` is one Bot Durable
Object read — the list and the inbox together — not two RPCs started in
parallel. The host keeps drawing a document it already holds while a refresh
is out, and shows host chrome in the tap frame rather than
hiding the page behind a spinner. The Bot page, Routines, Bot Plugins and Bot
settings stay mounted after the first visit (`lib/shell/hot_panel.dart`); a
collapsed desktop column keeps those pages too, so closing the panel is not a
dispose. Audit, Templates, Look, Voice and framed WebViews stay out of that
set: they are not the thing someone flips back to.

The `right-panel` region shows one entry at a time rather than stacking every
registered builder: an entry registers with a label, the panel's stack names
which one is on screen (see the header and panel stack below), and
`ViewSurfacePage`'s `chrome` flag is off inside it because the region already
carries the title. On the phone each entry is a page.

**The rest of PR 8.** Completions have no read status. `RoutineInboxController`
feeds the recent firings listed above the All Routines row on the Bot page,
and the All Routines surface nests those same rows under the Routine that
left them. A firing that spoke — an explicit `send_to_user`, or the message a
broken firing commits in its place — is an ordinary message in the
conversation instead; see [notifications](notifications.md).

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

The native conversation chrome is an overlay, not a bar: a fade down from the
top of the thread, the Bot's companion cropped to ink at the top-left, and
frosted pills on the far right — the Bot's name, the Computer, and the panel's
own switch where there is a panel to hide. A phone keeps Back as a pill on the
left at the same inset. The name is the door to the Bot page; the Computer icon
takes a cooler blue while the Bot is driving one. A call still uses a solid bar:
the thread is gone, and the bar is the name, a mark that says why, and the
Computer.
Routines, Plugins, Settings and the doors of a Bot's Plugin panels are rows on
the Bot page rather than icons here: a bar of doors was the same doors the panel
could have named, and a Plugin adding one more made the bar the Bot's navigation
rather than its title.

The right panel holds a small stack: the Bot page is its floor, a row pushes a
sub-page onto it, the header grows a back chevron (`right-panel-back`) and names
what it is showing, and the close empties the stack. A Bot switch empties it too.
On a phone the same keys push routes instead, which is the same idea drawn
twice.
Bot messages have no avatar or tool-count row. While a Turn runs the Bot stands
at the end of its thread, where its reply will land, and it works the same way
everywhere it is drawn: in the conversation header, in the sidebar and there,
the drawing holds still and one light crosses it in step. Working belongs to
the conversation, so a Bot answering in a group chat lights that group and not
its own row. The thread only says something in words when a Stop is being
waited on or a Turn is queued behind the one it displaced.
A message that crossed to or from a counterpart — another of the User's Bots,
or the voice session — is one centred marker in the thread, "Messaged Codex
Watch" or "Message from Xero Books", wearing the counterpart's own character
and, while queued, stopped or unanswered, its status; a running exchange says
nothing there, because the Bot's companion in the header already says it.
The words are never in the thread: the marker opens a view-only chat,
"General ⇄ Xero Books", that lists every exchange between the two in both
directions, each request under the name that sent it and each answer under
the name that gave it, with a lock footer saying it is view-only. The history
is the cloud's filtered run read (`GET /api/bots/:id/turns?with=bot:<id>` or
`with=voice`), which returns only the Turns that crossed to or from that
counterpart — inbound by the admission's origin, outbound by a `bot_message`
call in the journal — paged with the same cursor as the conversation; the
loaded thread is merged in so an exchange in flight updates live. On the
wire, a `bot_message` call is projected as `message/to-bot` in place of its
`tool/call`, named by the target's id alone (the client's directory names
it), and a Bot caller's answer is a `reply/to-caller` with `caller: "bot"` —
the same delivery voice uses, so a Bot's answer to another Bot mints no User
message, badge or notification. A spoken answer stays bounded at 4,000
characters; a Bot's answer is bounded by the wire event instead, at 32,000.
The marker's long-press still opens Work details. Message long-press opens work
details or records “Mark unread from here”. That boundary names a validated
chat message in the Bot-owned unread record, is included in the command
fingerprint and receipt, and is projected to the native transcript after
reconnect. An explicit mark-read
clears it. The Computer continues through its existing backend surface; header
navigation adds no authority or credentials.

Session announcements such as rename and compaction remain system lines,
projected by `projectAnnouncements` and ordered by their recorded timestamps.

**PR 9: the Flock, and three more projections.**

`lib/flock/` is what a Bot looks like and what may be done to one.
`avatar.dart` is `CharacterAvatar`, one animated Rive artboard per Bot drawn
from the cast `apps/native/assets/characters/` bundles, and the same character
is drawn wherever a Bot is: the sidebar row, its pinned tile, the thread, the
conversation companion and Bot settings, each from the `characterId` and `primary`
the directory already returns. The cast and the motion contract are
[the character integration note](design/character-app-integration.md).

`create.dart` is the sidebar's create gesture, which no longer hands off to
Manage Bots, and `AvatarPickerSheet` beside it is the edit half — the one thing
left of the old wardrobe under the single-default-avatar rule — reached
by pressing the avatar in Bot settings and fenced on the avatar revision the read
just reported rather than one held since the sheet opened. The command is written to the durable store before it is sent and
cleared only once the authority has answered it, so a lost reply finishes the
Bot that was asked for rather than making a second one; a 409 is not a failure
but a re-fence on the revision it reported, under the same `commandId`. The
first message, when there is one, goes through the same `BotSession` the
conversation uses, so a new Bot's first Turn is admitted exactly as every other
one is.

`lifecycle.dart` is one retained `BotLifecycleCommand` per account, whichever
surface issued it — `BotDangerZone`, which is the Danger card at the foot of Bot
Settings, or Manage Bots, which now shares it rather than keeping a second
copy. The zone is
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
- The Routines list and the Routine detail are two documents. The list is
  what is armed and what it left behind; the detail is one Routine, named
  by `?routine=` — name, prompt, trigger in words, optional provider
  `config`, last and next run — because conversation is the only author and
  the list a person came to read is not a form. Which document is open is
  navigation, so it is asked for on the read and written nowhere. The host
  opens that page from a row; it does not unfold an accordion on the list.
  A schedule travels with the sentence the projection made of it
  (`describeRoutineScheduleV1`, `app/routines/cron.ts`), so a row and the
  detail say the same thing about when it fires. A triggered Routine also
  gets its two key controls, and only a triggered one: the route refuses a
  key for a scheduled Routine, so the control is absent rather than offered.

**A secret the authority minted once is never in a document.** A webhook key
and a pairing code are each signed once, stored only as a digest and answered
on a receipt; a document can be read twice, so neither can be in one.
`ViewSurfacePage` gained one seam for exactly this — a `banner` the host draws
above the document — and the two surfaces hold their secret there for as long
as the person is looking at it and nowhere else. It is the same reasoning
`SettingField.secret` already carried, from the other direction.

Creating a Bot and its danger zone are host chrome rather than projections, and
deliberately: the character is bundled art rather than an `embed`'s https image,
the create command fences on a directory revision `ViewController` has no way
to express, and the lifecycle receipt has a third state — `pending` — that a
view action's two do not.

**PR 10a: the Computer.**

`lib/computer/` is the Computer card and its full-window viewer: the
projection, one versioned command per action, and the two rules the card needs —
whether the desktop or its last photograph is on screen, and what to call that.
The card streams only a desktop that exists, to a card someone is looking at,
while the Bot is working or has just stopped; every other answer is the Bot's
frame, which costs nothing to hold — read through the authenticated frame
route by the client that holds the session, because the URL the projection
carries is on this account's own origin and an anonymous image request there
is answered 401. There is one destination: the card, the bar's
Computer icon and the search hit all open the same full window on the same
session, with Take control in it. Taking control is two gestures, and only the
second reaches the Bot. The viewer is a `HostFrame` (`lib/view/host_frame.dart`):
an iframe under `sandbox` in the browser, a hardened WebView on the phone.

**Why the Computer is host chrome and not a projection.** It holds a credential
minted per reader — the Computer's bearer viewer URL — and a document can be
read twice. That is the rule PR 9 arrived at from the other direction, and it
settles the shape here: the host holds the credential, the host frames the
page, and what a plugin may say about it is the name of a region.

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

`embed`'s frame names are the host's, not the plugin's: `computer-viewer` (`apps/native/lib/view/embed.dart`). A `HostViewFrames` scope is what a host surface puts in one — the Computer card fills `computer-viewer` — so a region a plugin names is drawn by whichever host surface is above it and by nothing at all elsewhere, where it stays the trust-neutral reserved region. A name this host does not offer draws the unavailable one.

**Budgets**, checked by `ViewDocumentView` before it builds a widget (`lib/view/budgets.dart`): 512 nodes, depth 16, 262,144 bytes. A document past any of them is refused whole rather than half-rendered. The schema's own shape caps are separate — 256 children per `group`, 256 rows per `list`, 32 declared actions.

**The plugin declaration.** `PluginDescriptorV1.views` is `{slot, surfaceId}[]` (`core/contracts/plugin-descriptor.ts`), account-scoped, with `PLUGIN_SLOTS_V1` as the slot vocabulary and at most 16 entries with distinct surface ids. `settings.sections` is the one open slot (`OPEN_PLUGIN_SLOTS_V1` in the worker host); a Plugin naming any other, in `slots` or in a view, is refused at resolve. A Plugin exports `views`, one function per surface id, and the wrapper reports the names at `health` so a declaration the module does not honour fails the Plugin alone. The Bot's Plugins page (`readBotPluginsFrameV1` with `sections`, `app/plugins/bot.ts`) mounts this Bot's enabled Plugins once for the read (`withPluginWorkerV1`, `app/plugins/worker-bot.ts`, the same standalone mount a trigger delivery uses), calls `renderView` for every declared surface at once so the page waits one deadline in all rather than one per Plugin, and `pluginSectionV1` (`app/plugins/views.ts`) re-reads the answer against a short vocabulary — `text`, `group`, `list`, `action`, at most 64 nodes and 8 deep, every string it carries non-empty — before it joins the card. A `field` or `embed`, a tool the Plugin does not declare, or a tree past the budget is the section's failure, said on the card. A worker that does not mount is the same thing said on every card that wanted a section, never an error for the page, so the switch that turns a broken Plugin off is still there. An `action` node's `actionId` names one of the Plugin's tools and becomes the page's `plugin-tool` action, whose input is `{kind, pluginId, tool, arguments}` with the tool's input as one JSON string of at most 8,000 bytes (the wire schema's `maxLength` cap). Pressing it posts a `plugin-tool` command to the same route as a switch; `executeBotPluginToolV1` (`app/plugins/views-bot.ts`) refuses a Plugin that is off, has no section or no such tool, then mounts and calls `executeTool` on the active worker under the identity `action:<commandId>`, so every loopback call the tool makes is attributed to that press. The client reloads the page after any command, so the section shows what changed.

The renderer is `apps/native/lib/view/`: `budgets.dart`, `action.dart` (input assembly and the retained command envelope), `document.dart` (`ViewDocumentView`, `ViewScope`), `nodes.dart` (one widget per node type), `embed.dart` (the frame registry) and `sample_page.dart` (a development-only page, so the renderer can be looked at on a device before a plugin produces a document).

### Card — how a Bot renders

A Card is one A2UI surface in the conversation ([ADR 0030](adr/0030-a2ui-cards.md)), drawn as native widgets by `genui` from two catalogs this build compiled in. `ViewDocument` stays where it is: it is the host's layout with a Plugin's values in it, which is a different thing from a card a Bot writes.

The renderer is `apps/native/lib/cards/`: `client.dart` (the two routes the client uses — read one, post one press; the backend's list route has no client caller yet), `surface.dart` (admission and the translation), `catalog.dart` (the catalogs, as one), `schema_client.dart` (the schema resolution the intake runs under: the draft 2020-12 documents this build carries, and a refusal for every other `$schema` without a request), `press.dart` (which press the card is waiting on), `chat_card.dart` (`CardChatCard`, the widget in the transcript) and `frock_catalog/` (the Frock components and their schemas, one file per family and one under `frock_catalog/schemas/` beside it).

**The translation.** The record the seam stores is A2UI 1.0 — `core/contracts/a2ui.ts`, folded by `app/shell/cards.ts` into a component set, a data model and a revision. `genui` 0.10.3 on `a2ui_core` 0.1.1 speaks v0.9, which spells the version literally `v0.9`, calls `createSurface`'s surface properties `theme`, and puts no content in `createSurface` at all. So `cardMessagesV1` turns one record into three messages: create the surface under its catalog, put the whole component set on it with `updateComponents`, write the whole data model at the root with `updateDataModel`. That is the only translation the client does; when the renderer catches up to 1.0 it is the only thing that changes.

**Catalogs.** v0.9 gives a surface exactly one catalog, so the A2UI standard catalog and the Frock catalog are registered as one under `https://frockbot.com/a2ui/catalogs/frock/v1.json`, with the standard catalog's id as an alias. The standard catalog's own definition is fetched from a2ui.org once and committed (`core/protocol-schemas/schema/a2ui-basic-catalog.json`); nothing fetches it at build time. The Frock catalog's definition is generated — `scripts/generate-frock-catalog.ts` reads `apps/native/lib/cards/frock_catalog/schemas/`, one raw JSON string per family and the only place a Frock component's data schema is written, merges the files in filename order (a name two families declare is refused by the generator and by the Dart alike) and emits `core/protocol-schemas/schema/frock-catalog.json`; `bun run typecheck` fails when the committed file is stale. Twenty-four components in six families (ADR 0030 steps 4 and 8): **core** — `StatusPill`, `KeyValueRows`, `CollapsibleText`, `ApprovalActions`, `ConnectApp`, `Receipt`; **structure** — `CardHeader`, `SectionHeader`, `Callout`, `IdentityRow`; **data** — `MetricTile`, `ProgressBar`, `DataTable`, `Timeline`; **rich text** — `Markdown`, `CodeBlock`, `Quote`; **media** — `ImageGallery`, `FileAttachment`, `LinkPreview`; **input** — `ChoiceChips`, `MultiSelect`, `SegmentedControl`, `Rating`. The host owns every layout that could come out wrong at phone width: `CardHeader` lays out the title and the pill so the pill cannot leave the card, `DataTable` scrolls sideways rather than squeezing a column narrower than its values, and **every** Frock component is registered as implicitly flexible — as is the standard catalog's `Text` — because `genui`'s `Row` and `Column` wrap a child in a `Flexible` only when the model wrote a `weight` on it, and a child they do not wrap is laid out at unbounded width, which a component holding an `Expanded`, a stretched `Column` or a scroller does not survive. The fit an implicit weight gets is `FlexFit.loose`, so a row hands the child a width it may use and a column still lets it be its own height; `apps/native/test/cards_row_test.dart` draws every Frock component inside a `Row` and fails when one is added that is not covered. Following a link is the host's too (`frock_catalog/links.dart`): one function, https only, checked again at the moment of opening because a link can arrive through the data model, which admission never sees.

**Budgets**, checked by `admitCardV1` before a message reaches the renderer (`lib/cards/surface.dart`), mirroring `A2UI_LIMITS_V1`: 128 components, 32 actions, 16,000 bytes of data model, 131,072 bytes of record. A record past any of them, one naming a component this build has not compiled in, one carrying the seam's own `refusal`, one with no `root`, or one carrying a literal link — `url`, `imageUrl`, or one inside a row — that is not `https://` draws the host's unavailable region — the same `ViewRegion` a plugin's document gets — and never half a card. A validation error the renderer reports against the catalog schema draws it too.

**A press** becomes one `POST /api/bots/:bot/cards` carrying the surface, the revision it was drawn at, the event, the data model as the renderer holds it when the surface was created with `sendDataModel`, and a `commandId` minted once per press so a retry is the same press. The card is held still until the receipt lands, and redrawn from the card the receipt carries. A 409 means the surface moved under the person: the card re-reads, redraws and says so. `ApprovalActions` is the one component that names its own action — `approval/<approvalId>`, built by the host from the id the kernel issued, never by the card. `ConnectApp` raises no action at all: its button is the host's door to the app's hosted sign-in (`connections/door.dart`, the same one Connect in the Marketplace opens), under the person's own session, and whether the account now holds a working Connection of that app is read from `/api/settings/connections` through `CardConnectionsScope` (`shell/connect_cards.dart`) — lazily, once a card draws one, and again when the app resumes or the hosted door closes into it — because the Card does not move when a Connection lands.

**What the Bot is taught.** A Bot composes a card from the managed `a2ui` Skill (§5, "the managed set"), which is listed in `<agent_skills>` by name and description and loaded only when it decides to draw one. The Skill's references are generated from the same two catalog files this renderer registers, so the vocabulary the model writes in and the vocabulary the client draws are one file apart, not two opinions. One detail of the shipping renderer is taught rather than hidden: an action is written `{"action": {"event": {"name", "context"}}}`, v0.9's spelling, because that is what `genui` raises a press from — and `a2uiActionCountV1` at the seam counts both that and 1.0's bare `action.name`, so the seam and `admitCardV1` refuse exactly the same surfaces.

**The first-party cards are Plugins.** `approval`, `widget`, `attachment`, `secret-request` and `agent-card` are drawn by five locked seeded Plugins — `approvals`, `questions`, `attachments`, `credentials`, `agents` (`app/plugins/seeded/`) — so the deployment's own cards take the path a User's Plugin takes: a declared `dataSchema`, a `renderCard` in the Plugin worker, the Frock catalog, and `sendCard`. The mapping is `app/shell/first-party-cards.ts`, reached through `AgentRuntimeV1.firstPartyCards`, which the Plugin host sets when it mounts a generation and the Shell's send seam reads. The payload itself is still recorded on the Turn's log unchanged — it is where an Approval record is minted, where a Machine command and a Plugin intent find the id they are keyed by, and where delivery decides the Turn is over — so the Card is the _face_ of the send and never its meaning. A decision the seam maps is bound to the `approvalId` the Bot chose (`PluginCardSendV1.approvalIds`) rather than to a minted one, because that is the id everything downstream already names. The client draws nothing for those five members; a draw that could not happen leaves the send with no face and writes nothing else.

**Staying put.** The card reads over REST when it mounts and re-reads when the Bot's durable state is invalidated (`ChatController.invalidations`, bumped once per state-channel notice), and is kept alive in the transcript. A notice names no record, and every adopted record is admitted and then rebuilt into a fresh controller — there is no same-record path that keeps the live renderer. What the rebuild no longer costs is the person's half-finished answer: when the record's own data model has not moved, the model the old renderer held is theirs alone and is handed to the new one (`keptDataModel`), which is what makes a card with `ChoiceChips` and a `MultiSelect` on it answerable over the several seconds it takes. A card that is answering a press ignores the notice instead, because the receipt carries the surface back. Adopting any record ends the reads older than it, so a read still in flight never redraws over the receipt a press carried back. A later `card` send naming the same `surfaceId` updates the record rather than adding a second card, so `dedupeCardSendsV1` (`lib/shell/transcript_model.dart`) drops the repeat where the thread is ordered and the card stays where it was first drawn.

---

## 7. Model providers

`ctx.llm` is `LlmRegistry` — `core/models/llm.ts:15-40`. It is a `Map<providerId, LlmProvider>` that dispatches on `request.provider`, wraps the call in the `modelStream` hook, then validates structured output. The kernel-declared interfaces are `LlmProvider`, `ModelInvocation` and `ModelProviderRegistration` in `core/contracts/model-invocation.ts`.

Stream events (`LlmStreamEvent`, `core/contracts/types.ts`): `provider-state`, `text-delta`, `tool-input-delta` (a call's arguments as they are written, which only a reply draft reads), `tool-call`, `usage`, `response-format-note`, `structured-output-failure`, `finish`.

### Selection

- `resolveEffectiveBotModelV1` (`core/configuration/index.ts:723-874`): a Bot-scoped Package setting with `role: "model"`, else a User-scoped one, else `user.platformModel`. Two enabled packages both declaring a model setting is a hard conflict. A broken choice falls back to the platform model and records `fallback.from`.
- `resolveBotModelBindingV1` (`:668-695`) yields `ready`, `requires-resolution` or `unavailable`.
- The Turn resolves the effective model, refuses if it changed mid-reply, and mounts it as a runtime Package for that Turn (`app/shell/runtime-mount.ts:685-749`) — unless the deployment serves that provider only through a Plugin, which mounts no compiled Package and carries the installed Plugin's provider host on the mount instead ([ADR 0032](adr/0032-plugin-model-providers.md)). The resulting `modelSelection` flows through `app/shell/turn.ts:270` → `backend-composition.ts:297` → `app/agent-runtime.ts:557-583`, where it overrides the default provider and model and becomes `AgentOptions.modelBinding`.
- Package-to-provider-type mapping is the map at `app/runtime.ts:304-382`, one `provider-<id>` key per compiled adapter — `provider-ollama-cloud` and `provider-flock-ai` beside one entry for each catalog provider this deployment still adapts — and a provider served only through a Plugin has no entry at all: the mount resolves it through the installed Plugin instead, and one the account has not installed fails with the sentence that names it ([ADR 0032](adr/0032-plugin-model-providers.md)). A pair with no factory, or one whose provider type does not match, resolves to `Bot model provider "X" is unavailable` (`:603-607`).

### Packages

**`providers/openai-compatible`** — a shared transport library, not a plugin. Response decoding — SSE framing, tool-call accumulation, finish reason and the non-streamed body — is the Vercel AI SDK's `OpenAICompatibleChatLanguageModel`, handed the already-open stream through a loopback `fetch`; request mapping, failure classification and the deadlines stay here, because the Frock AI gateway and Ollama's native endpoint reach this seam with a stream rather than a URL. `OpenAICompatibleProvider` (`index.ts:884-967`) issues `fetch` to `${baseUrl}/chat/completions` with `authorization: Bearer`. Request planning is `planOpenAICompatibleRequestV1` (`:367-455`): `stream: true` with `stream_options.include_usage`; tools as `{type: "function", function: {...}}`; `response_format` in an `openai` dialect and a `workers-ai` dialect, degrading to `json_object` and then to prompt-injected instructions, emitting a `response-format-note` at each step. Stream bytes are capped at 1 MiB per event and 16 MiB per response before they reach the decoder. Tool calls are emitted only after the stream terminates, and a stream that ends without a terminal marker throws. Deadlines are 120 s to first byte and 60 s idle (`core/contracts/model-invocation.ts:88-131`), applied by `streamWithModelRequestDeadlinesV1` (`:852`).

**`providers/frock-ai`** — package id `provider-flock-ai`, provider type `flock-ai`. Calls Cloudflare AI Gateway through one of two transports, chosen at `apps/cloudflare/src/frock-ai.ts:132`: with an account id and token, a raw fetch to `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions` with `cf-aig-authorization` (`:55-58`, `:163-180`); otherwise the `AI` binding's `gateway(id).run({provider: "compat", endpoint: "chat/completions"})` (`:195-207`). Both send `cf-aig-skip-cache: true`, and both hand the answer's `cf-aig-provider`/`cf-aig-model`/`cf-aig-cache-status` headers back through the seam's `served` callback; the provider keeps them per request for billing to read with `frockAiServedModelV1`, never as a stream event, because the model stream is also what a Plugin model provider answers with. Only the compat transport accepts a `dynamic/<route>` model, so the binding path's host carries no Auto route (`autoRoute: null`) and Auto resolves there to `FROCK_AI_BINDING_AUTO_MODEL` — the catalog's own `@cf/` chat model — rather than to a route the binding would reject. Model ids are `@frock/*` with legacy `@flock/*` normalized (`catalog.ts:30-38`); `@frock/auto` maps to the `dynamic/flock-auto` route, `@frock/structured` (the unlisted conversation-summary model every Bot's compaction runs on, mounted summary-only beside a Bot on another provider by `createFrockAiSummaryFeature`) to the `dynamic/frock-structured` route or, on the binding path, to the binding's Auto model, a concrete id to `workers-ai/@cf/...`, and a structured-output request on Auto is pinned to `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` (`:21-22`, `:92-101`). The static catalog has two entries: `@frock/auto` and `@frock/deepseek-ai/deepseek-v4-flash-0731` (`:49-56`, `:104-124`). `user.ts:192-275` bootstraps an ambient `flock-ai-ambient` Connection and sets it as `platformModel` for every User, which is what lets a new Bot answer with no configuration. `runtime.ts:224-255` tags the Agent on a permanent failure and rewrites the next request to `@frock/auto`. Auto on the gateway route takes pictures (`acceptsImages`), and its catalog entry says `vision: true`; a schema request pinned to the text model, and Auto on the binding path, are told in words that a picture was attached. Under billing, `apps/cloudflare/src/frock-ai.ts` holds each image to a fixed allowance of 6,000 input tokens when it checks a request fits its reservation, in place of its base64, and the charge settles from the model's reported usage, which counts the image. `reconciliation.retrieve` returns `not-retrievable` (`:133-140`). Stored ids are `flock-*`; display strings are `Frock` (`catalog.ts:3-8`).

**`providers/ollama-cloud`** — provider id `ollama-cloud`, `defaultEnablement: "disabled"`. Takes an API-key Connection and acquires a per-request credential lease against the User Durable Object before any bytes are sent (`runtime.ts:133-190`), settling it afterwards; a lease that does not match `connectionId` and `connectionGeneration` is a permanent failure. Base URL comes from the Connection setting `api-base-url`, default `https://ollama.com`, with `/v1` appended (`:74-77`). It delegates to `OpenAICompatibleProvider` (`:229-241`). Behavior forks on hostname: a non-`ollama.com` host uses native `/api/chat` with `format` for JSON Schema, while `ollama.com` reports `structuredOutput: "none"` (`:130-132`, `:278-289`).

**`providers/foundation`** — provider id `foundation`, model `deterministic-v1` (`runtime.ts:8-9`). It echoes the last user message prefixed `"Built-in model: "`, or echoes tool output, and reports `structuredOutput: "none"`. It is the default in `createFoundationRuntime` and is overridden by `modelSelection`.

**`core/models`** — the registry service. Also implements `structured<T>()` by streaming with a `json_schema` response format and validating the accumulated text.

**`app/custom-models`** — `defaultEnablement: "disabled"`, and nothing but the Bot-scoped `role: "model"` setting it declares (`app/custom-models/definition.ts`). It has no runtime and no provider: enabling it is what puts the model picker in Bot settings, which the client draws from the settings document.

Adjacent, outside the loop: image generation uses Workers AI ids directly (`app/image/model.ts:40-52`, default `@cf/black-forest-labs/flux-1-schnell`).

Web search is not a model provider either. `web_search` is the platform-owned `web` Package's `web-search` Capability (`app/web/brave.ts`), on Brave's Web Search API with the deployment's `BRAVE_SEARCH_API_KEY` in the `X-Subscription-Token` header. It needs no Connection, the Bot's Web switch covers it together with `web_fetch`, and without the key (optional in `production-secrets.ts`) it does not mount, so no Bot is offered a search it cannot run. The tool's contract, bounds and durable result are provider-neutral (`app/web/contract.ts`). Where the deployment bills, each search reserves US$0.01 under `search:<effect id>` before the request and settles it once Brave answers (`app/billing/search.ts`, [`billing.md`](billing.md)). The integration harness answers `api.search.brave.com` with `braveSearchStub` (`test/harness/miniflare.ts`).

---

## 8. Connected apps

`app/connect/` is the integration layer for the apps a User connects FrockBot to, and `app/mcp/` holds the remote MCP servers a person adds by address ([below](#mcp-servers--appmcp)). Both are first-party app code, not plugins: `AGENTS.md` reserves plugin machinery for untrusted code. The provider behind `app/connect/` is the deployment's, chosen at build time and named nowhere a person reads, and a Bot-authored plugin reaches a connected account later through the `http` grant, which that module will serve.

**One Package, one Connection Type per app.** `connectDefinitionV1` (`app/connect/definition.ts`) is built from `catalog.ts`, declaring for each app a `connect-<app>` Connection Type (`authorization.kind: "grant"`, `allowMultiple`) and a `connect-<app>-tools` Capability bound to it. The list is every app — some 1,500 — the provider's hosted page can sign in with nothing of ours, generated into `apps.generated.ts` by `scripts/generate-connect-catalog.ts` from the provider's public app data, each with how it signs in (`ConnectAuthV1`): an OAuth app the provider runs (`managed`), dynamic client registration (`DCR_OAUTH`), a key, token or password the person types on the provider's page (`API_KEY`, `BEARER_TOKEN`, `BASIC`), the person's own developer app, whose client id and secret that page asks for with the steps to register one (`OAUTH2`, `OAUTH1`, `S2S_OAUTH2`, `SAML`), or nothing at all (`NO_AUTH`). AI model providers are left out; they are chosen in Models. The featured apps lead the list in our own words; the rest follow alphabetically in the provider's. The Connectors frame names a row by the type when a Package declares more than one (`settings-frame.ts`), so each app is its own row beside a model provider's accounts, with nothing above it; the Marketplace frame pages through every row — connectors first in the order the Package declares them, then model providers by name — and the ordinary connections read carries an app only once it has an account. Enablement is account-wide as every Connection is: connect once, every Bot holds it.

**The hosted grant** (`user.ts`, `backend.ts`). Connect is the Connectors surface's existing `authorize` press: `POST /api/plugins/connect/connections` carries `connection/start`, which the gateway turns into a `connection/oauth` command (`action: "start"`, with the `connectionTypeId` that command grew for this) on the User Durable Object. There the Contribution finds or creates the app's auth config — the provider's own OAuth app, or a custom config for the app's scheme, which asks nothing of us: the person types any key on the provider's hosted page, so it never passes through this deployment — mints a sign-in link for this User with `/api/connect/callback` as its return — under the client's own segment (`android`, `macos`, `ios`, or `macos-dev` and `ios-dev` for the FrockBot Dev builds) when the start command named one in `returnClient`, so the Android app's verified App Link opens the app on the redirect and the Mac and iPhone pages hand over on that build's scheme (`frockbot`, or `frockbot-dev` for FrockBot Dev), as the sign-in return does — writes the Connection in `authorizing` with the connected-account id, namespace and app in its safe metadata, and answers the link, which the client opens in the system browser. An app with nothing to sign in to has no page: its account is created live, the Connection settles to `ready` in the same command, and the gateway answers `status: "ready"`, which the client takes without opening a browser. The return page is a `publicRoute` drawn by the shared `app/return-page.ts` template that says to come back and touches no object: an anonymous redirect must never address a Durable Object. The origin of the return is always the deployment's own; the command names only which page. Settling is a `registerConfigurationReadBootstrap`: before every settings read, each `authorizing` Connection is asked about at most every three seconds and moved to `ready` (with a fresh generation) or `failed` (with a line for the person); a sign-in nobody finishes fails after thirty minutes. Disconnect deletes the account upstream with `revoke_on_delete` and retires the Connection. Start and disconnect are keyed by their command id and replayed from the stored receipt.

**Tools** (`agent.ts`, `account-catalog.ts`). For each enabled Capability the runtime host has authorized against a `ready` Connection, `createConfiguredConnectRuntimeContribution` mounts one Tool Namespace named for the app — the toolkit slug, `gmail-2` for a second account — carrying every tool the app has, up to several hundred. The User Durable Object keeps each Connection's account catalog: a directory of every tool's name and description, and the schemas in chunks each well under a Durable Object value, refreshed hourly by its alarm. The namespace lists the directory and resolves one tool at a time (`resolveTool` on the namespace registration): reading a tool's schema or calling it asks the User object for that tool alone, and the Turn pins it through `pinToolCatalog` under the Connection and the tool, so a remount keeps the exact schema it first used. A namespace of more than fifty tools is counted rather than named in the prompt and the bare catalog, and searched by pattern. Nothing is in the prompt for an app nobody connected. A call is `call_dynamic_tool` on that namespace; execution posts to the provider with the deployment key and the account id off the Connection's safe metadata, so no credential is ever leased, opened or logged. A tool-level refusal is an error the model can act on; a transport failure after dispatch says the outcome is unknown and not to repeat it, because the provider offers no idempotency key. A catalog that cannot be read refuses the one tool asked for with a line saying so rather than failing the Turn.

**The provider client** (`composio.ts`) is raw `fetch` against the v3.1 REST API with `x-api-key`, verified against the published OpenAPI document on 2026-09-23: auth configs by app, hosted links, open accounts for an app with nothing to sign in to, the seven connected-account statuses, the full tool listing, trigger types, trigger-instance upsert and delete, execution, and deletion. Every answer is decoded at that seam.

**Triggers.** A Routine may fire on a connected-app event — `{ kind: "connection", connectionId, triggerType, config? }`. Creating or resuming one upserts a provider instance under the command id; deleting it, or rewriting it onto a schedule, deletes that instance. `GET /api/connect/triggers` lists the events ready Connections offer (Gmail's `GMAIL_NEW_GMAIL_MESSAGE` and `GMAIL_EMAIL_SENT` among them). One deployment-wide `POST /api/connect/events` door HMAC-verifies the raw body with `COMPOSIO_WEBHOOK_SECRET` before any Durable Object is addressed; a `trigger.message` enqueues a firing keyed by the event id, `trigger.disabled` pauses the Routine, and `connected_account.expired` marks the Connection failed and pauses each Routine that fired on it. Disconnect deletes the instances; the Routines may stay enabled. `routine_manage` takes `connectionTrigger` and a `list_triggers` that offers only connected apps' events. Conversation authors the Routine; the prompt names the kind of event. `config` is optional and, when present, only `query` — a Gmail search; the write path refuses `labelIds`, `userId`, `interval`, and any other key. On drain, before the conversational model, Jev classifies the standalone payload against that prompt (`RoutineEventJudgeV1`). Only `clearly_unrelated` skips the Turn — a run-log row, no conversation line, no notification. Unavailable or a timeout is `is_or_might_be` and still admits. Reply-style and empty-ish payloads are not a clear miss: Jev does not have the Gmail thread.

**Secrets.** `COMPOSIO_API_KEY` is the project key (optional in `production-secrets.ts`: absent, no app can be connected and a Bot has no app tools). `COMPOSIO_WEBHOOK_SECRET` verifies event deliveries (optional: absent, the events door answers 503). The harness answers `backend.composio.dev` with `composioStub` (`test/harness/miniflare.ts`), and `connect-apps.integration.ts` walks the row, the sign-in hand-off, the settle, the return page, a Bot's tool call and the disconnect through the gateway.

### MCP servers — `app/mcp/`

A remote MCP server is a Connection a person adds by its address: one Package, `mcp`, with one Connection Type, `mcp-server` — authorization `api-key`, a Connection setting `url` — and one `mcp-tools` Capability bound to it. Enablement is account-wide, as every Connection's is: add a server once, and every Bot holds its tools.

**Adding one** (`user.ts`). The Connectors surface draws the row with a form of its own — the address, a name, and a token only when the server asks for one — and presses the ordinary `connection/create`, or `connection/create-api-key` with the token, on `POST /api/connections`. Adding is a setting plus at most one secret, and the handshake that proves it is a read, so the add runs to its answer inside the command: the address is held to `web_fetch`'s outbound classifier with the server's own port allowed; the Connection is written `authorizing` with the token staged in the credential store; `initialize` and `tools/list` run against the server; and the Connection settles `ready`, with its transport, server name and instructions in its safe metadata and its tools in the directory, or `failed` with the line a person reads. A retry of the same address retires the failed one, and a settings read fails an add that stopped mid-handshake for two minutes. A command's receipt is stored under its id with a digest of the command, never the token. Sixteen servers per User. Each is a namespace `mcp-<name>` taken from its host — `mcp.linear.app` is `mcp-linear` — suffixed for a second server whose host reads the same. Streamable HTTP is tried first, the older HTTP+SSE transport on a 400, 404 or 405, and whichever answered is remembered. A server that refuses an add made without a token is asked whether it offers a sign-in (below): when it does, the Connection is failed with its authorization set to `grant`, unconfigured, and the line "This server asks you to sign in", and the Connectors row goes straight on to the sign-in; when it does not, the line asks for an access token.

**Signing in** (`oauth.ts`, `oauth-state.ts`, `grant.ts`, `backend.ts`). A sign-in is the MCP authorization specification, on the SDK's own OAuth functions with the same outbound seam as a session — every request classified, under a 20-second deadline and a 64 KiB body bound. The row's Sign in posts `POST /api/plugins/mcp/connections/:connectionId/authorize` with a `connection/start` body; the gateway turns it into a `connection/oauth` start carrying the `connectionId` and a return page on its own origin under the client's segment (`/api/mcp/oauth/callback[/<client>]`, one per Connect return client). The User object asks the server once with no credential for its `WWW-Authenticate` challenge, reads its protected-resource metadata (RFC 9728, from the challenge's `resource_metadata` or the well-known path) and its authorization server's metadata (RFC 8414 or OpenID discovery, issuer checked), and refuses a server whose endpoints are not public https, which does not advertise PKCE `S256`, or whose declared resource this address is not under. FrockBot's identity there is a public client registered dynamically for every return page (RFC 7591) where the server offers registration, otherwise its client metadata document (`GET /api/mcp/oauth/client`, a public route) where the server takes a URL as a `client_id`, and the identity kept from an earlier sign-in to the same authorization server is reused. Linear, Notion and Atlassian answered this discovery with registration on 2026-09-24; GitHub's does not, and it takes a token. The authorization request carries PKCE `S256`, the RFC 8707 `resource`, the scope the challenge or the metadata named, and a `state` signed with an HMAC key derived by HKDF from the credential keyring (`deriveKeyringSigningKeyV1`) over the User, the Connection, the attempt and a ten-minute expiry. The attempt — verifier, client identity and server metadata sealed under the keyring, the state's digest beside them — is kept under `mcp:sign-in:v1:<connectionId>`, one per server, a new start replacing an old one. The callback is a `publicRoute`: it verifies the state's signature and expiry before any Durable Object is addressed, and trades the code only for a request that is the User the state names. Whoever holds a sign-in link can be the one an authorization server sends back, so someone who finishes another account's link must grant it nothing. A browser tab proves who it is with its own session, which the public route asks the gateway for (`sessionUserId`: the same identity and admission every authenticated request goes through). A browser signed in to no account, or to another one, is told to finish in FrockBot, and nothing is traded. An app's browser has no session, so its page never trades: it is a 303 to the Connect return page for that app, carrying the answer's `state`, `code`, `iss` and `error` as `mcp_` parameters, and the Mac and iPhone pages forward those, and only those, onto the scheme. The app sends them to the authenticated `POST /api/mcp/oauth/complete` under its bearer, which refuses a state naming another User with 403. Either way the answer reaches the User object as a `connection/oauth` complete keyed `mcp-return-<attemptId>`, so a repeat is answered from its receipt. The User object checks the address's state against the digest it kept, claims the attempt (`exchanging`) before trading the code, so the code is traded once whatever arrives, validates the RFC 9207 `iss` where the server sends one, and installs the tokens: the access token and its expiry become a new credential generation — the one thing a Turn ever leases — and the refresh token and client identity are sealed under `mcp:grant:v1:<connectionId>` in a context no credential generation carries, so no lease can name them. The handshake runs with the new access token before the Connection moves to the new generation; a refusal keeps what the server had.

**Keeping it signed in.** Before a lease, an access token that would expire inside the lease is refreshed through the credential store's `refreshActiveSecret`, which records the refresh before it is sent and rewrites the credential in place under the same generation, so a Turn's pins are undisturbed; the rotated refresh token is sealed in its place. A refused refresh, or one that stopped partway, is never retried: the server is failed with "Your sign-in to this server has ended. Sign in again." Removing a signed-in server, signing in again, or giving it a token instead revokes the grant it held at the server's revocation endpoint (RFC 7009) when there is one.

**Changing and reconnecting** (`user.ts`). A server's menu offers Change token (or Use a token), which is `connection/rotate-api-key`: the new token is staged, the handshake runs with it, and only then does the Connection move to a new generation holding it — a refused token leaves a working server as it was, and the client says so. A server that is not working offers Try again, which is `connection/refresh-models` on a failed Connection: the handshake runs again with whatever credential it still holds, and it comes back `ready` at the generation it had, or stays failed with the reason as it is now. An installed app from before these routes sends a Disconnect for a server with no token to `POST /api/plugins/mcp/connections/:connectionId/revoke`, which removes it.

**The client** (`client.ts`) is a thin adapter over the official `@modelcontextprotocol/client` — its `Client`, both HTTP transports and the JSON-RPC framing — with FrockBot's edge around it: every request and every 307 or 308 hop is classified again and every other redirect refused, each response body is read through an 8 MiB bound, the client declares no capabilities a server could call back into, and a session lives for one operation, so nothing is resident and nothing needs restoring after an eviction. Cloudflare's `MCPClientManager` is not used ([plan](plan.md)). Failures are sorted into what a caller can say honestly: the server wants a credential, it could not be reached before anything was asked of it, it refused the request (JSON-RPC invalid request, unknown method or invalid params), or the call left and its outcome is unknown.

**The directory** (`catalog.ts`). The User Durable Object keeps one record per server under `mcp:catalog:v1:<connectionId>`: every tool's name, description and input schema, as listed under the Connection generation it names, bounded to 500 tools and 900 KB. It is refreshed an hour after each listing from the User alarm, one server per firing, and when the person presses Refresh tools (`connection/refresh-models`). A server that is down keeps its tools and says why in `refreshError`, retried from 30 seconds back to hourly; one that refuses its credential is failed. `readConnectToolCatalog` is answered by the Package that owns the Connection, so a Turn reads a server's directory through the same RPC a connected app's goes through.

**Tools** (`agent.ts`). For each enabled `mcp-tools` Capability bound to a `ready` server, `createConfiguredMcpRuntimeContributionV1` mounts one Tool Namespace marked `external: true`, so the registry refuses a `call_dynamic_tool` on it without `mcpDetails.description`. It lists the directory, carries the server's own instructions — at most 800 characters — in its use instructions, and resolves one tool at a time, pinned by the Turn under `<connectionId>/<tool>`. Permission is asked again before a schema is disclosed and before a call is sent. A call leases the server's token — the one it was given, or the access token its sign-in holds — under its effect id, opens it in the Bot, sends one `tools/call` and settles the lease; the token never reaches an argument, a result or the log. A server that could not be reached, or refused the token, was never asked; a JSON-RPC refusal is the server's answer; a transport failure after the call left says the outcome is unknown and not to repeat it. MCP carries no idempotency key, so a call re-issued after an eviction mid-call is sent again — the trade the loop makes for every effect whose provider honours no key (§4). Each call is audited as `mcp` against `remote:<namespace>`, which the User object resolves to `remote:<host>` from its servers.

The harness answers `mcp.example.test` (`test/harness/miniflare.ts`) with a server that has an open endpoint, one behind a token and one behind OAuth, and `mcp-auth.example.test` with that one's authorization server; `mcp-servers.integration.ts` walks the Connectors row, an add with and without a token, a sign-in through the public callback with a forged state, a sessionless browser and another account's browser refused on the way, an app's sign-in finished only under its own session, a Bot's call and its audit row, the removal that revokes the grant, and an installed app's Disconnect.

---

## 9. Plugin panels

A Plugin may render a host-drawn `ViewDocument` in two open slots beside `settings.sections` ([ADR 0034](adr/0034-plugin-panels.md)). The plugin ships no markup. `conversation.panel` is the page beside the chat: a bag of at most eight surfaces, in Composition mount order, drawn as host tabs in `PanelCanvas` (`apps/native/lib/panels/canvas.dart`). `bot.nav` is a door on this Bot's page; a panel with no nav view still gets a host-drawn door. One tab is visible. An empty bag is not offered. A strip of one tab is omitted.

The selected tab is a Session pointer on the Bot Durable Object (`core/durable/panels.ts`). Absent or `{ pluginId: null }` closes the region. A tab press, a nav press and the first-party `panel_focus` tool write the same record. `panel_focus` mounts on a Turn only when the bag is non-empty. If the focused surface leaves the bag, the pointer clears and the region closes.

`GET /api/bots/:bot/panels/open` answers `PanelOpenView`: the bag, the focus, the focused document or page, and the doors. `GET` and `POST /api/bots/:bot/panels/focus` read and write the pointer. Both slots render as the Bot whose page they are on; `renderView` already carries `botId`.

**A panel may be the Plugin's own page** ([ADR 0036](adr/0036-plugin-html-surfaces.md)). A `conversation.panel` view that names `page` returns state instead of a tree. `plugin_check` and `plugin_publish` refuse a named page the source lacks; publish injects the bridge (`PLUGIN_PAGE_HELPER_JS_V1`, `core/contracts/plugin-page.ts`) first in `<head>`, stores the bytes under `plugin-pages/<sha256>.html` in the artifact bucket, and records `pages` on the Composition member, so the generation hash covers them. The panel read answers `page: {url, state}`, and the gateway serves the page anonymously at that path on the app origin (`apps/cloudflare/src/plugin-page-route.ts`) under CSP `sandbox allow-scripts` with nothing to load or connect to, so it never runs as the app. The app document frames `/plugin-pages/` of its own origin and the Computer viewer, nothing else. `PluginPageFrame` (`apps/native/lib/panels/plugin_page.dart`) answers the page's `hello` with its state and theme tokens, runs the Plugin's own tools it calls through the `plugin-tool` command, and posts each new state after a read, over the host frame's `onMessage` and `outbox`.

**A page may listen.** A descriptor with the `device` grant and `"device": {"abilities": ["microphone"]}` — valid only beside a page view — has its approval card say the page can use the microphone, and the panel read answers the page's `abilities`. The page asks with `frockbot.openMicrophone`; `PluginPageFrame` opens nothing the answer does not name, and otherwise borrows the shell's one capture through `ShellPageMicrophone` (`apps/native/lib/panels/page_microphone.dart`) at 16 kHz in the unprocessed `instrument` profile (Android's recognition source, no echo cancel, noise suppression or gain). A page is the weakest `MicOwnership` owner: it gets the microphone only when nobody holds it, and dictation or a call takes it back. Frames go to the page as base64 PCM16 `audio` messages under a host-drawn "… is using the microphone" bar with Stop; leaving the panel, the app going to the background, or Stop closes it and tells the page why. When a use ends, however it ended, the client reports it once to `POST /api/bots/:bot/panels/device-use`, keyed by a use id it minted when the microphone opened. The Bot records it only for a page of a Plugin in its Composition that declares the ability, keeps the row in its own bounded `audit:device-uses` record — no run holds it, and a rebuild must reproduce it, so a rebuild's first page from the Bot is those rows — and queues it through the audit outbox like any other. The row is a `device` kind with no Turn (`turn`, `step` and `ordinal` are 0, and it offers no "View activity details"), a `device:<kind>` target, the Plugin's name in its preview and how long the use lasted.

The Applet product is gone: no `AppletState`, no `applet_*` tools, no account `applets` switch, no `send_to_user` type `applet`, no Composition `applets[]`. `apps/applet-build` still builds Plugins. The Package page went with it: no `/api/bots/:bot/package-ui` catalog, no `ui.<host>` origin, no direct-tool run, and no `publish` reason on `computer/sync` — the sync runs only at `open`, `signal` and `turn-end`. Disposable storage is dropped once per User and Bot under `maintenance:plugin-panels:2026-09-21` (`apps/cloudflare/src/plugin-panels-cleanup.ts`). Migration `deleted_classes` includes `AppletState`.

---

## 10. Computer

### The interface

One interface, `ComputerHostV1` (`computer/core/host.ts`), and two implementations of it: `computer/fly`, which is what production runs, and `computer/fake`, an in-memory host the tests substitute for it. A host `open`s a session for one Bot tenant of one User; the session is where every operation lives — `workspace`, `sync`, `exec`, `browser`, `screenshot`, `processes`, `doctor`, `presence`, `viewer`, `control` — and `close()` ends the session rather than the Computer. `teardown?(identity)` destroys the Computer itself — its files and browser logins — and the next `open` provisions a new, empty one. Both hosts implement it, idempotently, and only the User asks for it: "Delete my Computer" (`UserConfiguration.deleteComputer`, receipted per command so a retried press never destroys a newer Computer) and deleting the account (§2). Nothing reaps a Computer on a schedule.

`ComputerHostCapabilitiesV1` is what a host _is_, as opposed to what it does: `scratchPath`, `refuseGuiCommand`, `desktop` and `viewerFrameOrigins`. It hangs off the host and off every session it opens, because the readers need it before there is a session — the app builds its `frame-src` from `viewerFrameOrigins` with no Bot running, and `computer_exec` describes the scratch and refuses a GUI command without waking a Computer to ask. `desktop` is descriptive — slots and geometry — and never says that anything is shared: Fly's one browser per User follows from Chromium's `user-data-dir` lock, and a host with a container per Bot would isolate better. That model is deliberately absent from the interface, so no reader above the Computer can come to depend on it.

### Choosing a host

One file chooses: `apps/cloudflare/src/computer-host.ts`, beside the bindings the choice depends on. It hands the app a factory over the per-Turn seams (`ShellComputerHostFactoryV1`), and the app registers whatever it is given — `app/runtime.ts` for the Turn's runtime, `apps/cloudflare/src/bot-state.ts` for the Durable Object Contribution. "Is there a Computer" is the presence of that factory and nothing else; `SPRITES_TOKEN` is read in the chooser and nowhere above it. Substituting a k8s host is that one file and a new directory beside `computer/fly`.

### The gate

`scripts/check-computer-host-imports.ts`, four rules:

1. `@fly/sprites` is imported, and declared as a dependency, only under `apps/computer-host/**`. It speaks an HTTP exec protocol that depends on chunk boundaries workerd does not preserve, so it may exist only in the Node container app.
2. `@frockbot/computer/fly` is importable only from `computer/fly/**`, `apps/computer-host/**`, the one deployment chooser, and the two rigs that prove the implementation — `computer/host-contract.test.ts` and `apps/cloudflare/test/**`.
3. No source outside `computer/fly/**` and `apps/computer-host/**` may _name_ a Sprite or its desktop stack (`sprite`, `sprites.app`, `novnc`, `x11vnc`, `xvfb`, `fluxbox`, `websockify`) in code or in prose. An import gate stops the dependency; this stops the vocabulary. `SPRITES_TOKEN` is the one admitted occurrence, because it is the production secret name. `apps/marketing/**` is exempt: its privacy policy has to name the real sub-processor, and its own "sprite" is an SVG sprite sheet.
4. `computer/fake/**` imports `@frockbot/computer/core` and `@frockbot/computer/core/host` and nothing else from this Package. A fake that reached into an implementation would be that implementation's double rather than a second host.

Two names the gate does not police and that must not be changed: the Durable Object class `FlyHostContainer` (`apps/computer-host/wrangler.jsonc`), because a Cloudflare container application is bound to one class for its lifetime and the v3/v4 rename pair is already applied in production; and the header `x-frockbot-host-token`, which is checked in the app Worker, in the host Worker and in the container, all of which deploy on different tags.

### Proving the substitution

`computer/host-contract.test.ts` is one suite run twice — over `computer/fake` and over `computer/fly` on its wire-level double (`computer/fly/host-double.ts`). Its cases are the interface's own behaviour: a session opened and closed, a Workspace round-trip, the shape of an exec result, PNG bytes from a capture, a viewer opened, renewed and revoked on a URL within the host's declared origins, a control lease taken, refused to a second owner and given back, and an idempotent `teardown` where a host offers one. A third host is a third entry in its `HOSTS` list and no new assertion. `apps/cloudflare/test/computer-compatibility-worker.ts` is the other half: the Fly implementation in workerd, over the real v1 wire on a service binding.

### The Fly implementation

A persistent Linux desktop virtual machine per User, rented from Fly Sprites (`api.sprites.dev`, SDK `@fly/sprites@0.1.0`). `apps/computer-host` is a Worker that shards and authorizes, fronting a Cloudflare Container (`node:24-slim`, no desktop) that runs the Sprites SDK. It serves the v1 protocol and nothing else: the prototype's `/v1/effects` route and its `ComputerEffectJournal` are gone, retired by migration `v5`.

#### Provisioning

`getSprite`, and on a miss `createSprite`, named `frockbot-<sha256(["user", userId])[0..12]>` (`computer/fly/runtime.ts`). The host then adopts an existing machine via a marker file, or provisions through a detached, resumable five-phase shell run — `layout`, `packages`, `runtime`, `browser`, `reference` — bounded at 10 minutes, at most 8 relaunches, polled every second at first and at most every 5. New Sprites are created in `FROCKBOT_SPRITE_REGION` when that var is set; unset, the platform chooses, and an existing Sprite keeps its region. An ordinary open of an adopted Computer is one Sprite round trip: the adoption inspection rides on the front of the ensure script and is decoded out of the same answer, and only a stale digest or a pending update intent takes the two-step path. The `runtime` phase, which an in-place update also runs, records every path it installs in `~/.frockbot/provision/install-manifest` and removes what the previous manifest held and the current one does not, so a file a release stopped shipping leaves the Computer; `~/.frockbot` also holds live state, so nothing outside a manifest is ever removed, and a Computer with no manifest yet is taken to have one naming what earlier installs left and nothing deleted, the removed `applets` phase's SDK and shim among them. Egress is restricted to one host: `enableInternet: false, allowedHosts: ["api.sprites.dev"], interceptHttps: true` (`apps/computer-host/src/egress.ts`), with a WebSocket bridge for upgrades.

#### Inside the Sprite

Ubuntu 25.10 running one `Xvfb :100 -screen 0 5120x720x24`; `fluxbox`; one Chromium — Playwright 1.55's build — on CDP port 9222 with a single shared `~/chrome-profile`; a per-Bot `x11vnc -clip 1280x720+<slot*1280>+0 -rfbport $((5900+slot))`; `websockify --web=~/.frockbot/viewer` on port 6080, the only public port; a browser watchdog; and a workspace sync service.

One Sprite, one browser and one screen per User; one slot — window plus clipped VNC port — per Bot. `DESKTOP_SLOTS = 4` and `SCREEN_WIDTH = SLOT_WIDTH * DESKTOP_SLOTS`. The single browser follows from Chromium's per-`user-data-dir` singleton lock, and is a fact about this host rather than about the Computer (known issue 25).

#### Lifecycle

The container sets `sleepAfter: "30m"` with `max_instances: 3`, and its entrypoint runs `node` directly rather than `npm start`, because a cold start after the idle sleep is paid by one caller and npm's own start-up and registry call were about a second of it. A renderer watchdog sends SIGKILL to Chromium renderer processes only, above 1.5 GiB RSS or when `MemAvailable` is under 512 MiB. A service refresh that does not complete returns without writing the state digest, so the next `open` retries it. The Bot Durable Object arms a 60-second connect watchdog before each connect. Slots are reclaimed after 900 seconds idle unless a 90-second lease is held; with no free slot the process exits 75.

### The in-memory host

`computer/fake/host.ts`, exported as `@frockbot/computer/fake`: one `FakeComputerV1` per User holding a `Map`-backed `FakeWorkspace`, a table of scripted `exec` answers, a 1×1 PNG, viewer sessions on `https://viewer.invalid/session/<id>`, process records, a doctor report, leases keyed by scope, and a `teardown` that destroys the Computer and can be asked twice. It records every operation it was asked for, so a suite asserts on calls rather than on a filesystem. There is no Sprite, slot, VNC or shell script anywhere in it — rule 4 is what keeps it that way.

### Protocol

`computer/host-protocol/protocol.ts` — HTTP POST per operation with optional NDJSON streaming; not a WebSocket. The envelope is `{version: 1, effectId, identity: {userId}, tenant: {botId}, credentialRef}`, and `credentialRef` is `computer:user:<userId>`, decoded and length-limited but never read (known issue 26). Twelve operation kinds: `open`, `exec`, `file/read`, `file/write`, `file/list`, `file/stat`, `file/delete`, `control`, `viewer`, `service`, `cancel`, `teardown`. A `teardown` answers to no Bot — its envelope's tenant is `teardown` and the host ignores it — derives the Computer's name from the User, deletes it (a Computer already gone answers `deleted: false`) and forgets what the container had cached about it. An `open` answers an opaque `instanceId`; nothing above the host reads a host's naming out of it. Frames: `open` yields `progress | result | error`; `exec` yields `stdout | stderr | exit | error`. Requests shard to `computer-host-<fnv1a(userId) % 2>` (`apps/computer-host/src/router.ts`) and carry `x-frockbot-host-token`, checked in both the Worker and the container.

### Screenshots and live view

A screenshot is one operation on the session — `screenshot.capture()` — which the Fly host implements as one guarded `exec` running `scrot`, clipped to the Bot's slot of the shared screen, that answers with the PNG inline; only a capture past `SCREENSHOT_INLINE_MAX_BYTES` is followed by a `file/read` (`computer/fly/computer.ts`). `computer_screenshot` files its capture through the Computer's Workspace into the `screenshots` root, with the Bot as writer, and attaches it to the model turn; retention runs at the Turn end, never in the call. The card's picture is a different thing: one frame per Bot in the Bot Durable Object's own storage (`computer/frame.ts`), not a Workspace file — replaced by the Turn end of any Turn that used the Computer, by `computer_screenshot`, and by closing a live viewer — and served by its hash at `GET /api/bots/:botId/computer/frame/:sha256` without waking a Computer. A Computer action photographs nothing mid-Turn: filing a capture after every action cost each call about fourteen seconds of listing and pruning. Writing the frame raises the `computer` state notice, and the card reads its projection again on it. The live view is the URL a viewer session answers with, iframed directly and with no Worker proxy; the app's `frame-src` is built from the registered host's `viewerFrameOrigins` (`apps/cloudflare/src/user-application.ts`), which is `https://*.sprites.app` for Fly. FrockBot ships its own viewer page because stock noVNC fixes `view_only` at construction.

A `connect` first asks the host for a viewer on the existing desktop (`computer/bot.ts`). A fresh stored session is renewed; otherwise a viewer is opened. The host checks the Bot's credentials and the viewer and gateway ports in one remote command, without adoption, provisioning or desktop setup. A confirmed missing viewer and an update already in flight both fall through to `presence.connect()`, which waits that update out; transport, permission and billing failures are reported. Only the session id and expiry are durable, so this path also reconstructs the in-memory bearer URL after eviction. Recovery stays on an authenticated command with a durable effect key: projection reads never renew paid viewing. A refused viewer probe is billed for its active duration rather than a viewing window.

### Tools

All from `computer/`; neither implementation registers one.

- `computer_exec` — `agent.ts`
- `computer_screenshot`
- `computer_doctor`
- `computer_process_check` / `computer_process_logs` / `computer_process_stop`
- `computer_browser` — actions `snapshot | navigate | click | fill | press | wait`, returning an accessibility snapshot over CDP

---

## 11. Storage

Bindings are declared in `apps/cloudflare/wrangler.jsonc`.

| Binding                       | Kind               | Contents                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `USER_APPLICATIONS` (:28)     | Worker Loader      | The per-user foundation application artifact, loaded by the gateway (`apps/cloudflare/src/index.ts:2357`)                                                                                                                                                                                                                                                        |
| `BOT_PACKAGES` (:34)          | Worker Loader      | The per-User Plugin worker, whose `globalOutbound` is the `PluginEgress` loopback, or disabled when no enabled Plugin declared network (`app/isolates/bot.ts:150-184`)                                                                                                                                                                                           |
| `COMPUTER_HOST` (:45)         | Service            | `frockbot-computer-host` (`apps/cloudflare/src/computer-host.ts:61-67`)                                                                                                                                                                                                                                                                                          |
| `APPLET_BUILD` (:53)          | Service            | `frockbot-applet-build`, the Plugin build service in `apps/applet-build`: it type-checks, lints, bundles and boots a Plugin's source and returns the artifacts (`app/plugins/authoring-bot.ts:52-60`)                                                                                                                                                            |
| `APPLICATION_ARTIFACTS` (:59) | R2                 | Content-addressed: application artifacts (`applications/<hash>.mjs`, uploaded by the release workflows), Plugin artifacts (`packages/<hash>.mjs`, written by Plugin authoring in `app/plugins/authoring-bot.ts` and read hash-verified by `createR2PackageArtifactStore` in `app/isolates/capabilities.ts`) and exported Bot templates (`templates/<hash>.json`) |
| `MEMORY_FILES` (:62)          | R2                 | Memory and workspace file bodies (`apps/cloudflare/src/workspace.ts:130`, `:186`), and uploads under `uploads/<userId>/<botId>/` (§4 "Attachments")                                                                                                                                                                                                              |
| `AUTH_DB` (:67)               | D1 `frockbot-auth` | better-auth only                                                                                                                                                                                                                                                                                                                                                 |
| `MEMORY_INDEX` (:73)          | Vectorize          | Memory embeddings: upserted and deleted by the Memory drain (`app/memory/processing.ts`), deleted with the Bot (`bot-state.ts:1214-1249`), queried for semantic recall (`bot-state.ts:1137-1149`, `app/memory/semantic.ts`)                                                                                                                                      |
| `AI` (:78)                    | Workers AI         | Frock AI gateway transport and image generation                                                                                                                                                                                                                                                                                                                  |
| `BOT_STATES` (:83)            | Durable Object     | `BotState` (§2)                                                                                                                                                                                                                                                                                                                                                  |
| `USER_CONFIGURATIONS` (:87)   | Durable Object     | `UserConfiguration` (§2)                                                                                                                                                                                                                                                                                                                                         |
| `DEPLOYMENT_POLICY` (:91)     | Durable Object     | `DeploymentPolicy` (§2)                                                                                                                                                                                                                                                                                                                                          |
| `VOICE_ASSISTANTS` (:97)      | Durable Object     | `VoiceAssistant` (§2)                                                                                                                                                                                                                                                                                                                                            |
| `GROUP_CHATS` (:102)          | Durable Object     | `GroupChat` (§2)                                                                                                                                                                                                                                                                                                                                                 |

D1 schema: `apps/cloudflare/migrations/` holds `0001_better_auth.sql`, defining `user`, `session`, `account` and `verification` with their indexes, and `0002_drop_account_issuer.sql`, which removes the `account.issuer` column and its unique index — better-auth wrote that column through 1.7.2 only, and from 1.7.3 refuses every `/api/auth/*` request while a column it never writes is `not null`. All other product state lives in Durable Objects.

Durable Object state is key-value unless a store owns tables. SQLite tables are used inside `BotState`, by the Memory engine; inside `UserConfiguration`, by the Memory engine, the search and audit stores and the billing ledger; and inside `VoiceAssistant`, by the Agents SDK's own conversation and schedule tables. `DeploymentPolicy` creates no tables but uses the synchronous `ctx.storage.kv` API, which only SQLite-backed storage provides; `GroupChat` is key-value only. Each class is declared in a `new_sqlite_classes` migration; `VoiceSession`'s v5 entry is retired by the `deleted_classes` v6 entry that follows it, and `VoiceAssistant` is a new name under v7.

Not used anywhere in the repository: KV namespaces, Queues, Workflows, Hyperdrive, Browser Rendering, Analytics Engine, Pipelines. Containers appear only in `apps/computer-host`.

Top-level vars: `NATIVE_SLICE_2_AUTH`, `DEFAULT_APPLICATION_HASH`, `FROCK_AI_GATEWAY_ID`, `FROCK_AI_ACCOUNT_ID`, `FROCK_AI_AUTO_ROUTE`. `ALLOWED_CLIENT_ORIGINS` is read but set nowhere: the web app is same-origin and the Flutter app sends no `Origin`.

Secrets are declared in `apps/cloudflare/src/production-secrets.ts`, where a required secret may belong to one auth Package: the hosted build requires `BETTER_AUTH_*` and `GOOGLE_*`, and an Access build requires `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` instead. Required of the hosted build: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SPRITES_TOKEN`, `COMPUTER_HOST_TOKEN`, `CREDENTIAL_KEYRING`, `ROUTINE_HOOK_SECRET`, `MACHINE_TOKEN_SECRET`, `APPLET_BUILD_TOKEN`, `OPENAI_API_KEY` (composer dictation), `GEMINI_API_KEY` (the voice session). Optional: `FROCKBOT_ADMIN_EMAILS`, `DEBUG_TOKEN`, `COMPOSIO_API_KEY` (Connected apps, §8), `COMPOSIO_WEBHOOK_SECRET` (Connected-app Routine events, §8), `BRAVE_SEARCH_API_KEY` (web search, §7), `FROCK_AI_GATEWAY_TOKEN`, `JEV_API_KEY` (hosted turn supervision, routine-event rejector, dictation tidy review), `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` (Telegram, §3). `VOICE_ASSISTANT_MODEL` and `VOICE_DICTATION_CLEANUP_MODEL` are optional vars; `VOICE_DICTATION_UPSTREAM_URL` and `VOICE_ASSISTANT_UPSTREAM_URL` are harness-only doors the release gate refuses to find live.

---

## 12. Auth

Sign-in is a build-time Package. `AuthPackageV1` (`core/contracts/auth-package.ts`) is what the gateway speaks: resolve an identity from a request, serve `/api/auth/*` and `/sign-out`, and hand the native authorize page its sign-in step. Two implementations exist — `app/auth/better-auth` and `app/auth/access` — and the deployment names one in `apps/cloudflare/src/auth-package.ts`, the way `computer-host.ts` names a Computer host. `scripts/check-auth-package-imports.ts` keeps the `better-auth` dependency inside its own Package and that one file, so an Access build carries none of it ([ADR 0028](adr/0028-open-deployment.md)).

The hosted deployment builds better-auth 1.7.3, configured once in `app/auth/better-auth/index.ts`. `bearer()` is the only enabled plugin: there is no admin plugin, no organization plugin and no jwt plugin. `trustedOrigins` is left at its `baseURL` default; `account.encryptOAuthTokens` is true. Missing secrets yield a stub that returns 503 for every route. `/sign-out` is better-auth's own route, reached over its handler with the browser's headers — including the `referer` its CSRF check reads — and answered with a 303 to `/`.

The Access Package verifies the `Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie, against the team's keys at `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (`app/auth/access/token.ts`), checking the signature, `aud` against `ACCESS_AUD`, the issuer and the expiry. The User id is derived from the token's `sub` and the email is taken from the token as verified. It stores nothing, needs no D1, and signs out to the team's `/cdn-cgi/access/logout`. Because the Access policy is itself the allowlist, that build's admission seam in `index.ts` answers "admitted" for every identity the Package produced and the `DeploymentPolicy` authority is never asked.

Google is the only configured provider. The `verification` table and the `account.password` column are unused.

`deleteStoredIdentity(userId)` is the Package's half of deleting an account: the better-auth build deletes the User's `session` and `account` rows and then the `user` row in one D1 batch — by name, although the schema cascades — so nothing can sign in as that User again. The Access build stores nothing and declares none.

Session storage is D1 `AUTH_DB`. There is no `cookieCache` and no `secondaryStorage`, so each authenticated request performs a D1 lookup. Native sessions are separate: they live in the User Durable Object under `native:sessions:v1`, capped at 32 with a 7-day lifetime (`apps/cloudflare/src/native-sessions.ts:56-109`).

### Native sign-in

1. `POST /api/auth/native/start` (unauthenticated) mints an HMAC-signed 5-minute claim; `returnUri` is checked against a deployment-fixed allowlist (`nativeReturnUris` in `apps/cloudflare/src/native-auth.ts`). The allowlist is the profile's `nativeAuth` list, written to `NATIVE_SLICE_2_AUTH` comma-joined, and nothing is implied by another entry: the hosted profile names `android`, `macos`, `macos-dev` (the FrockBot Dev Mac build) and `ios`, and no `ios-dev`, since no FrockBot Dev iPhone signs in to production. A flag with an unknown name, a space or a repeat serves nothing.
2. The app opens `/native/authorize` in the external browser. That route asks the auth Package who the browser is and otherwise hands it the sign-in step with a return to `/native/complete` — Google on the hosted build; on an Access build the route sits behind Access and always arrives identified.
3. **Consent before code.** Neither route issues a code on a GET. A browser that holds a session — already, or just now after Google — gets a FrockBot-drawn page naming the app from its return ("Sign in to the FrockBot app on this Mac?") and the account it will be signed in as, with one Sign in button. The start is public, so anyone can start a sign-in with their own PKCE values and open this URL in the person's browser, and an Apple custom scheme is not exclusive: an app that claims `frockbot://` would otherwise receive a code for whoever the browser was signed in as and redeem it with its own verifier. `/native/complete` asks too, because it is a GET any page can open and cannot tell a sign-in that just happened from a browser that was signed in already. The button posts a signed `consent` claim back to `/native/authorize`: the pending authorization (its state, challenge, return and hello) bound to the browser's User, expiring with the start. The post is refused unless its `Sec-Fetch-Site` is `same-origin` and its `Origin` is the deployment's — whichever of the two the browser sends, and at least one — and unless the browser's User is the one the consent names; the page is served `referrer-policy: same-origin` so that its post carries its `Origin`, `frame-ancestors 'none'` and `X-Frame-Options: DENY` so it cannot be framed, and `form-action 'self'`. Only then is the code issued, as a 303. Android takes the same page, although its verified App Link already keeps the code from any other app: one issuing path is simpler to reason about than two. The development door alone still issues without a page, and only for a browser with no session, on a stack production refuses.
4. The code goes to the Android App Link `bot.frockbot.com/native/return/android?code=&state=`, on the Mac to `bot.frockbot.com/native/return/macos`, or on an iPhone to `bot.frockbot.com/native/return/ios` (`/native/return/macos-dev` and `/native/return/ios-dev` for the FrockBot Dev builds, which hand over on `frockbot-dev://` so the released app never takes their code). That page hands the same `code` and `state` to the app's `frockbot://` scheme (`nativeReturnPage`, drawn by the shared `app/return-page.ts` template under a per-response script nonce), because only Safari dispatches a Universal Link and only on the user's own click; the app checks the host and path of a scheme return exactly as it checks the verified link (`NativeSignIn.canonical`), and the exchange still names the https return URI.
5. `POST /api/auth/native/exchange` verifies `SHA-256(verifier)`, the state, the return URI and a byte-exact ClientHello, asks the beta-access authority, commits in the User Durable Object, and returns `Bearer frockbot-native.<claims>.<sig>` with a 7-day lifetime.

The token is stored in the platform keystore through `flutter_secure_storage` (`apps/native/lib/client/store.dart:38`).

Afterwards, every request carrying that bearer passes the compatibility gate — a malformed hello or a protocol outside the supported range is `426` — and then has its hello compared against the session's own signed hello. That comparison covers `schemaVersion` and `catalogs` as a set; `protocolVersion` and `nativeVersion` are compatibility rather than authority, so an app that updates itself to another supported protocol or release keeps the sign-in it holds. A hello that disagrees on the rest is a rejected session (`401`), not an unsupported client. Revoking runs the same gate and the same comparison and answers `401` the same way, because that is the refusal the app finishes signing out on; an updated app can still sign the device out. The session's original hello stays in the signed claims and in the persisted record, and the two must still match exactly for the record to be read.

### Admission and admin

The singleton `DeploymentPolicy` owns beta access. [`beta-access.md`](beta-access.md) defines the admission rule, admin and development exceptions, enforcement paths, refusal responses and release procedure. Its administration is `app/admin/operations.ts`, mounted by `AdminEntrypoint` and reached only by the admin portal over a service binding (§1); `createDeploymentPolicyAdminHost` adapts the Durable Object RPC results for both production and the Worker fixture.

An account's features are its `UserFeaturesV1` record (`app/admin/shared.ts`), held by the User Durable Object under `user:features:v1` and read and written by RPCs that never pin the identity, so an admin can set it for an account that has no access without admitting that account. It carries the account's two Plugin fields (ADR 0026): `pluginAuthoring`, the admin-held gate on a Bot writing Plugins, and `plugins`, the admin-gated seeded Plugins opened for this account that §5 reconciles into its Composition. A record written without them reads as closed and none opened. `AdminEntrypoint` lists accounts from the Better Auth `user` table and writes one account's features; the operator surface writes the same record under the deployment's debug token, which is how a deployment with no portal turns them on. Each account's features are read from its own User Durable Object, so one failed read marks that account `{ unavailable: true }` in `AdminUserListViewV1` rather than failing the list or reporting the default: the portal shows that account as unreadable and never as off, and every other account stays usable.

`ALLOW_DEVELOPMENT_AUTH` enables an identity bypass: `?as_user=` is accepted and persisted as the `frockbot_dev_user` cookie (`gateway.ts:115-136`, `:250-256`). Its admission exception is described in [`beta-access.md`](beta-access.md#where-it-is-asked). `admin-identities.ts:20-21` treats the id `development` as admin unconditionally, and `:27` treats any development identity as admin when `FROCKBOT_ADMIN_EMAILS` is empty.

---

## 13. Tests and CI

### Test layers

1. **Bun unit** — root `bun test` (`package.json`), matching `*.test.ts` and `*.spec.ts` across every workspace. No `bunfig.toml`.
2. **Workerd, hermetic** — `apps/cloudflare/vitest.config.ts`, `test/**/*.workerd.ts`, entry `./test/computer-compatibility-worker.ts`, with Miniflare fakes for the Computer host, the Plugin build service, Frock AI and Vectorize, and a D1 `AUTH_DB` the auth-schema suite migrates from `migrations/` via `readD1Migrations`. `fileParallelism: false`.
3. **Workerd, integration** — `apps/cloudflare/vitest.integration.config.ts`, `test/integration/**/*.integration.ts`, entry `./src/index.ts`, with the real gateway, the built artifact and D1 migrations via `readD1Migrations`.
4. **Computer host** — `apps/computer-host/vitest.config.ts` plus `bun test src container`. Opt-in live suites `test:live` and `test:live:desktop` are not run by CI.
5. **Playwright** — `apps/cloudflare/e2e/playwright.config.ts`, `**/*.e2e.ts`, `fullyParallel: false`, `workers: 1` under CI and for a `publication` corpus, four in any other local run, 240 s timeout, no retries in any lane (`retries: 0`, with `maxFailures: 2` under CI) so a red lane is a failure on its first attempt, `webServer` of `bun e2e/serve.ts`. Roughly 30 spec files. CI picks a runner's corpus with `FROCKBOT_E2E_SUITE` (`e2e/suite.ts`) and runs five lanes: four `core` shards of every spec except the real publication journey (`plugins-publish.e2e.ts`), sharded `--shard=n/4` and packed by `balanced-shard-reporter.ts` under a 20-minute run budget, plus one unsharded `publication` lane holding just that one, whose run budget is `publicationJourneyTimeoutMs` (900 s) per journey — the value each journey applies as its own test timeout — on top of the webServer's 15-minute startup allowance.
6. **Flutter** — `apps/native/test/*.dart` plus `integration_test/settings_screens.dart`, which is a screenshot runner, and `integration_test/cards_live.dart`, which re-runs the card suites against the built app (`flutter test -d macos integration_test/cards_live.dart`) so a card promise the headless engine keeps is also kept by a real one.
7. **Gate scripts** — run under `typecheck`: `scripts/check-client-protocol.ts`, `scripts/generate-frock-catalog.ts --check` (the Frock A2UI catalog definition, emitted from the Dart schemas), `scripts/generate-a2ui-skill.ts --check` (the Cards Skill's references, stitched from the catalogs), `scripts/check-layer-imports.ts`, `scripts/check-computer-host-imports.ts`, `scripts/check-auth-package-imports.ts`, `scripts/generate-isolate-context-catalog.ts --check`, `scripts/generate-card-schema-documents.ts --check` (the draft 2020-12 documents the card renderer answers schema resolution from, lifted from ajv's delivered refs), `scripts/generate-deployment-profile-schema.ts --check` (the deployment-profile TypeScript type, `FromSchema` of `deployments/profile.schema.json`), `scripts/build-applets-assets.ts --check` (the Plugin SDK scaffold, the Plugins and Cards Skill directories and the managed recipe Skills — each `SKILL.md` and the Markdown under its `references/` — as strings the Worker bundle can carry), `scripts/build-seeded-plugins.ts --check` (each seeded Plugin's committed artifact against its source digest), `scripts/check-managed-skills.ts` (the managed and seeded Skill directories are complete, each `SKILL.md` indexes its references, and no body names a tool this product does not offer), then `scripts/typecheck.ts`, then `tsc --noEmit -p scripts/deployment-config/tsconfig.json`.

### Local validation

Pre-commit formats staged files. `scripts/validate.ts` runs format, typecheck,
unit, runtime, integration, browser and build categories before pushing. Each
successful category records a receipt in `.local-validation/receipts/`, keyed on
the content of that category's inputs and the toolchain rather than on the
commit, so a commit that changes nothing a category reads reuses it; a clean
code checkout is required before and after checks. Categories run concurrently,
except those whose commands write tracked files — `integration`, `e2e` and
`build` — each of which runs alone, one after another, once the rest have
finished. Every other category reads the work tree, through its own commands
and through the snapshot proving the tree still matches the commit, so a
half-written tracked file would abort the run; the test before adding a
category to that set is whether anything its command runs writes a tracked
file.
Each run has an isolated Wrangler service registry. Pre-push fetches remote
main before and after validation and rejects stale branches or new merge commits.
See [local validation](local-validation.md) for commands and cache recovery.

### Workflows

Seven workflows live in `.github/workflows/`:

- `check.yml` (`Check`, plus `Flutter`) — what a pull request owes: the fast
  tier (format, typecheck, `bun test`, the Computer host and Plugin build
  suites) beside Dart analysis, the Flutter tests and the Android badge unit
  test. It needs no secret, so a fork's pull request runs it.
- `main.yml` — everything a landed change owes, on the merge commit: the fast
  tier again, plus the marketing and admin-portal bundles, then — when the
  `Scope` job says the change could have affected them — the Flutter suite, the
  Cloudflare workerd and integration suites, the application build, and the
  browser suite across five runners. Green deploys staging when
  `DEPLOY_STAGING` is `true`, cuts the next patch tag and starts `release.yml`
  for it. A push touching only `docs/**` and root Markdown starts no run.
  `Scope` (`scripts/ci-change-scope.ts`) measures from the newest release tag
  rather than from the previous push, because a tag is only cut after a run
  concluded, so everything since one is exactly what no run has yet accepted —
  a burst of merges that the concurrency group cancels cannot slip through. It
  excuses the slow tier only when every path in that range is under
  `apps/marketing/`, `apps/admin-portal/` or `docs/`, or is root Markdown;
  anything else, an empty range and an unreadable one all oblige the full
  tier. The two site bundles live in the unskippable job for that reason: they
  are the only build of those Workers, and the pushes that touch only them are
  exactly the ones that skip everything else. `deploy-staging` and `release`
  require `Scope` itself to have succeeded and each slow job to have succeeded
  or been skipped, so a failed `Scope` — whose dependents all skip — cannot
  read as permission to ship.
- `release.yml` — the production pipeline for a `v*.*.*` tag, below.
- `main-health.yml` — keeps the `main-health` commit status on every open
  pull request, from `scripts/main-health.ts`: green while `main` is green,
  red while it is red, always green on a `fix-main` pull request or a revert.
  The ruleset requires it, so nothing merges onto a red `main` but its repair.
  It runs on `pull_request_target` so that it can write the status and runs
  only the base branch's script, never the pull request's code.
- `whats-new-preview.yml` — comments a pull request's What’s New copy and
  stills on the pull request.
- `native.yml` — manual-only native qualification.
- `mac-release.yml` — the Mac desktop app's own qualification and tag.
- `ios.yml` — an advisory unsigned iPhone build.

Branch protection is recorded in
[local validation](local-validation.md#github-configuration): the `main`
ruleset requires the checks it names, branch freshness is not required, and
nothing approves a production deploy. Merging belongs to the babysitter
(`.claude/skills/babysit/SKILL.md`), which reads the whole pipeline through
`scripts/babysit.ts`.

### `.github/workflows/release.yml`

Trigger: push of a tag matching `v*.*.*`.

- `verify` — validates strict SemVer, then `typecheck`, `bun test`, and `bun run build` behind the pinned Flutter SDK, because the build compiles the web client.
- `publish-npm` (after `deploy-backend`) — `applets/sdk` is the only workspace it considers, and it publishes only because its manifest declares `frockbot.npm`. It rewrites that manifest to the tag version and sets `private: false`, resolves `workspace:` ranges to literals, requires npm ≥ 11.5.1, then `npm publish --access public` (`--tag next` for prereleases) through OIDC trusted publishing. `EPUBLISHCONFLICT` is treated as success.
- `github-release` — creates the Release for the tag with `--generate-notes --verify-tag`, attaching the web client archive and the application artifact an installer needs. The notarized disk image is attached only when `macos-release` produced one: notarization depends on Apple answering and used to take the whole Release with it when it did not.
- `deploy-marketing`.
- `deploy-backend` (environment `production`) — runs `bun run deployment:config hosted` and then `scripts/deployment-config.test.ts` as a gate, writes the artifact's own sha256 over the generated config's `DEFAULT_APPLICATION_HASH` placeholder, applies D1 migrations remotely, uploads the artifact, deploys the computer host and then the Plugin build service, each with its own secrets file, runs `scripts/check-production-secrets.ts check --live` and `write-secrets-file`, then `wrangler deploy --secrets-file`. It rewrites no tracked `wrangler.jsonc`: the D1 identifier is in `deployments/hosted.json`, and the only in-place edit is to the generated config under `.deployment/`.

### `.github/workflows/native.yml`

Manual dispatch only. The advisory job retains native pin checking, analysis,
tests and web build checks for explicit qualification runs.

### `.github/workflows/mac-release.yml`

On pull requests touching the Mac desktop path and on push of a tag matching
`mac-v*.*.*`. `qualify` runs on macOS: the `@frockbot/mac-messages` typecheck,
the machine and Messages test files, `scripts/mac-release-test.py`,
`scripts/mac-appcast-test.py`, the Flutter Mac Messages and desktop update
tests, and an unsigned `scripts/mac-release.py` build. On a tag,
`draft` creates a draft GitHub release only; the signed, notarized archive is
built and uploaded by hand. Mac tags ship independently of the `v*.*.*` cloud
release. See [the Mac release guide](../apps/native/macos/README.md).

### `.github/workflows/ios.yml`

On pull requests touching the iPhone Runner, the client's native dependencies
or the icon scripts, an advisory job on macOS type-checks the icon scripts,
builds the released identity with `flutter build ios --no-codesign`, checks
the built bundle's identifier, name and scheme, and reads the FrockBot Dev
switch's build settings. It signs, archives and uploads nothing: those need
the team's Apple credentials ([`apps/native/README.md`](../apps/native/README.md#ios)).

---

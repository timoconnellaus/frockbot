# Dogfood journeys

Ten end-to-end journeys a non-technical human — or an ego-browser agent driving the real UI — walks to find out whether FrockBot works. Each journey is what a person says and clicks. Each proof is a durable record. Journeys depend only on earlier ones.

## Three targets

- **Local dev** — `bun run dev:cloudflare` (`wrangler dev --env development --var ALLOW_DEVELOPMENT_AUTH:true`), then `http://localhost:8787/?as_user=<any-id>`. `?as_user=` is the development identity: it answers as that user and sets the `frockbot_dev_user` cookie. On a non-loopback host click **Continue as local developer** instead.
- **Staging** — `https://staging-bot.frockbot.com`. Real sign-up, real Sprites, real Composio.
- **Production** — `https://bot.frockbot.com`. Same, on the account you actually use.

Every journey runs on all three unless its **Expected to fail today** note says otherwise.

## The rule: assert on records, not prose

A Bot's wording is not evidence. Never write a proof that reads the reply text. Read what the Turn wrote down.

**Debug surface** — read-only, token-authorized, works while nobody is signed in and while a Bot is wedged. Always the script, never a hand-rolled curl:

```bash
.claude/skills/frockbot-debug/scripts/debug.sh users
.claude/skills/frockbot-debug/scripts/debug.sh bots <userId>
.claude/skills/frockbot-debug/scripts/debug.sh bot <userId> <botId> --events [--limit N]
.claude/skills/frockbot-debug/scripts/debug.sh run <userId> <botId> <runId>
```

Underneath: `GET /api/debug`, `/users`, `/bots?userId=`, `/bots/<botId>?userId=&events=true&limit=&before=`, `/bots/<botId>/runs/<runId>?userId=`. A snapshot carries `activeRunId`, `runs[]` (`status`, `phase`, `failure`, `responseText`, `compositionGenerationId`, `eventCount`), `runs[].events[]`, `composition` (`currentGenerationId`, `currentStatus`, `lastKnownGoodGenerationId`, `generations[].failures[]`, `quarantined`), `configuration.packageValues`, `notifications`, `nextCursor`. Five runs by default, 20 max; events bounded at 512 KB with the **oldest** dropped as `omittedEvents`.

**Session events** (`packages/kernel-contracts/src/types.ts`). Every effect is an intent/outcome pair, and the pair is what to assert on: `session/created`, `input/queued`, `input/admitted`, `turn/start`, `composition/pinned`, `turn/admission`, `step/start`, `user/message`, `model/request`, `assistant/message`, `tool/call` (**with its input**), `tool/result`, `package/author-intent`→`package/authored`, `package/catalog-change-intent`→`package/catalog-changed`, `package/undo-intent`→`package/undo-recorded`, `package/hook-failed`, `memory/injected`, `memory/write-intent`→`memory/written`, `skill/injected`, `skill/invoked`, `skill/write-intent`→`skill/written`, `computer/injected`, `computer/process`, `computer/sync`, `task/dispatched`→`task/settled`, `send/to-user`, `wake/parent`, `step/end`, `turn/end`. The in-app run view drops `model/request` and tool inputs; the debug surface keeps them.

**Session-authenticated reads** the debug surface deliberately does not carry — read them from the browser's network tab: `GET /api/settings` (User view: `packages[]`, `connections[]`, `platformModel`, `revision`), `GET /api/bots/:botId/settings`, `GET /api/bots/:botId/routines`, `.../routines/:routineId/runs`, `.../routines/inbox`.

**In-app durable surfaces**: Bot settings → **Audit log** (`#bot-audit`) and **Routines** (`#bot-routines`); the sidebar **Computer** strip; **Plugins**, **Models**, **Connectors**; Composition history.

**A live tail** for what never got written down: `cd apps/cloudflare && bunx wrangler tail --format pretty`.

Log every stumble in the **Friction log** at the bottom, including the small ones.

---

## 1. First run

**Persona intent.** I signed up ten seconds ago and I want a Bot that answers.

**Steps**

1. Open the target. On local dev, land on `/?as_user=<fresh-id>`; on staging or production, sign up.
2. The Bot creation dialog opens by itself for a User with no Bots. Type into **Bot name**, press **Create Bot**.
3. Send one message. Touch no settings.

**Proof**

- There is no **Choose a model** button anywhere on the page, and the workspace subtitle reads `Auto (recommended) · Frock AI`.
- `GET /api/settings` → `platformModel` is `{ connectionId: "flock-ai-ambient", providerModelId: "@frock/auto" }`, and `packages[]` carries `custom-models` in state `disabled`.
- `debug.sh bot <userId> <botId> --events` → newest run `status: "completed"` with a non-empty `compositionGenerationId`; events run `turn/start` → `input/admitted` → `composition/pinned` → `user/message` → `model/request` → `assistant/message` → `turn/end`.
- The `model/request` names the Frock AI connection and model `@frock/auto` — the platform binding, resolved per Turn, never stored on the Bot.
- `composition.currentGenerationId === composition.lastKnownGoodGenerationId`, no `failures[]`, no `quarantined: true`.

---

## 2. Bring your own model

**Persona intent.** I have my own Ollama Cloud key and I want my Bots on it.

**Steps**

1. Profile menu → **Plugins**. Switch on **Ollama Cloud** _first, on purpose_ — it must be refused.
2. Switch on **Custom models** (it ships disabled; without it there is nothing to choose), then **Ollama Cloud**.
3. Profile menu → **Models**. On the **Ollama Cloud** card press **Connect**, fill **Connection label**, **API key**, **API base URL**, press **Connect account**.
4. Pick a model under **Account model**, press **Save account model**.
5. Send a message in the Bot from journey 1.

**Proof**

- Step 1: the `user/set-package-enabled` command for `provider-ollama-cloud` is refused with a visible message naming `custom-models`, and `GET /api/settings` shows an unchanged `revision`. Nothing was written.
- The Ollama Cloud card reads `ready · models fresh`.
- `GET /api/settings` → a `connections[]` entry with `connectionTypeId: "ollama-cloud-account"`, `state: "ready"`, `authorization.kind: "api-key"`, a `credential.generation`, `modelCatalog.state: "fresh"`. **No key material anywhere in the DTO.**
- The `custom-models` Package's user-scoped `model` setting value names that `connectionId` and `providerModelId`.
- Step 5's `model/request` names the Ollama connection and model. The journey-1 Turn's `model/request` still names `@frock/auto` — resolution is per Turn and history is not rewritten.
- Switch **Custom models** off: the next `model/request` is back on `@frock/auto`. Switch it on again: the Ollama binding returns without re-entering the key. The values are inert while disabled, not deleted.

**Expected to fail today (local dev only).** Local dev has no real Ollama Cloud; the fake provider server exists only inside the Playwright harness (`apps/cloudflare/e2e/harness.ts`). Run this on staging or production with a real key, or point **API base URL** at an Ollama you host.

---

## 3. Give the Bot an account

**Persona intent.** I connected Gmail. I want to ask about my inbox without explaining that Gmail exists.

**Steps**

1. Sidebar → **Connectors**. Enable **Composio**, authorize **Gmail**, complete the grant flow in the popup.
2. In the conversation: _"anything urgent in my inbox this morning?"_ Do not name Gmail, Composio, or a tool.
3. Return to **Connectors** and revoke the Gmail Connection with the conversation still open.
4. Ask the same question again.

**Proof**

- `GET /api/settings` → a `connections[]` entry with `packageId: "composio"`, `connectionTypeId: "gmail"`, `authorization.kind: "grant"`, `authorization.driverId: "composio"`, `state: "ready"`. No token in the DTO.
- Step 2's run: a `tool/call` for `composio_search_tools` (`{ query }`), then `composio_execute_tool` (`{ toolSlug, arguments }`) with a Gmail slug, and a matching `tool/result`. The Bot found the account from the authority projection, not from the sentence.
- **Audit log** has an `mcp`-kind row for that Turn, targeted at the Connection, carrying the turn id.
- After step 3, the Connection is gone from `GET /api/settings` or no longer `ready`.
- Step 4's run: the `composio_execute_tool` `tool/result` is an error whose text is the `unavailable` reason naming the missing Connection. The run settles with a recorded outcome — no wedged `activeRunId`, no `tool/call` without a `tool/result`.
- The two Turns ran under different isolate binding digests: a revoked Connection changes the Bot's authority projection at its next admitted Turn.

**Expected to fail today.** Composio needs the deployment's Composio credentials, which a bare `wrangler dev` has none of — run this on staging or production. And **Gmail is the only toolkit wired**: `packages/plugin-composio/src/backend.ts` maps exactly one Connection Type (`gmail`) to an auth config. Asking for Slack, Notion or GitHub through Composio has no Connection to authorize, however many tools `composio_search_tools` can see.

---

## 4. The Bot builds itself a tool

**Persona intent.** I want a thing it doesn't have, I want it to just make it, and I want to take it back.

**Steps**

1. _"I keep asking you to convert AUD to USD. Build yourself a tool that does it and use it from now on."_
2. Next message: _"what's 240 dollars in USD?"_
3. Then: _"undo that."_

**Proof**

- Step 1's run has `package/author-intent` → `package/authored` around a `tool/call` for `package_author` whose recorded input carries `packageId`, `displayName`, the declared `tools[]`, and the TypeScript `source`.
- `composition.currentGenerationId` is new, `lastKnownGoodGenerationId` is the previous one, the new generation's `failures[]` is empty and `quarantined` is absent. If it failed to mount, the failure is delivered to the Bot as durable input and appears in the **next** Turn's `model/request` — that is the intended path, not a bug.
- Step 2's run has a `tool/call` naming the newly authored tool, in the same Turn that answers. No restart, no reload.
- **Audit log** has a `file`-kind row for `package_author`.
- Step 3's run has `package/undo-intent` → `package/undo-recorded` around a `tool/call` for `package_undo`, and afterwards `currentGenerationId` is a new generation that no longer mounts the Package. The authored generation is still in Composition history — superseded, never edited.
- Ask for the tool once more: it is absent from the `model/request`'s tool schemas.
- Extra: ask it to author a tool whose name collides with an existing one. Refused at author time, with no new generation.
- Extra: _"what can you see about yourself?"_ → `package_inspect_self` returns the isolate context contract, the current Composition, the last authoring or activation failure, and the retained TypeScript source.

---

## 5. Install from the Catalog by chat

**Persona intent.** Somebody already built this. Just install it.

**Steps**

1. _"is there anything already made for tracking parcels? install it if so."_
2. Use it: _"where's my parcel `<tracking number>`?"_
3. _"take that back off, I don't need it."_
4. Install it again on a **second User**.
5. **Operator half**, out of band: delist the entry by republishing the Catalog pointer without it — `bun scripts/publish-catalog.ts` against the target's `frockbot-package-catalog` bucket.
6. Send the second User's Bot a message.

**Proof**

- Step 1's run: `package_search` (`{ query }`), `package_inspect` (`{ catalogId }`), `package_install` (`{ catalogId, contentHash, summary? }`), bracketed by `package/catalog-change-intent` → `package/catalog-changed`. The install is hash-pinned — the 64-hex `contentHash` in the call equals the one inspect returned.
- `GET /api/settings` → the Package is in `packages[]`. Enablement is account-wide, so a second Bot of the same User has it at its next Turn.
- Step 2's run: a `tool/call` naming the installed Package's tool with a `tool/result`. If a Connection it needs is missing, the result is `unavailable` with a repairable reason — that is a pass.
- Step 3: `package_remove` (`{ packageId, summary? }`), and the Package leaves `packages[]` and the next `model/request`'s tool schemas.
- Step 5: R2 `catalog/current` names a new generation whose `entries[]` omit the entry. **The old generation and its artifact are still readable** — check both objects.
- Step 6 is the point: the second User's Bot still calls the tool successfully and its `compositionGenerationId` is unchanged. Delisting changes no installation and revokes nothing. A `package_search` on that Bot no longer returns the entry.

**Expected to fail today (partially).** Delisting has no in-app surface. Step 5 needs R2 operator access and `scripts/publish-catalog.ts`; a non-technical dogfooder cannot perform it and should have somebody else drive it between steps 4 and 6.

---

## 6. Memory across sessions

**Persona intent.** I told it once. Don't make me say it again.

**Steps**

1. In one conversation: _"I'm in Wollongong, and I only drink decaf after 2pm."_
2. Start a **new conversation** with the same Bot.
3. Ask: _"what time should you stop offering me coffee?"_

**Proof**

- Step 1's run has `memory/write-intent` → `memory/written` around one or two `tool/call`s for `memory_write`, whose input carries `fact` and the chosen `scope` (`bot` | `user` | `project`) and `tier` (`profile` | `log` | `note`).
- **Audit log** shows `file`-kind rows for `memory_write`.
- Step 3's run has a `memory/injected` event and the facts appear in the `model/request`'s Memory prompt section — **not** in the message history. The new session has its own `session/created` and no copy of the first conversation's `user/message`.
- On the Workspace, the files exist at the Memory layout: bot-scope under the Bot Memory root as `profile.md` or `log/YYYY-MM.md`; user-scope under the User Memory root sharded as `by-agent/<botId>/profile.md`. Read them by asking the Bot to `cat` under `/home/box/agent-data/user-memory/by-agent/<botId>/` and `/home/box/agent-data/agents/<botId>/`.
- Ask _"what do you remember about me?"_ — it should go through `memory_search` (`{ query, scope, maxResults }`), not answer from the injected section alone.
- Ask it to forget one: `memory_forget` with the exact recorded `fact`. The retraction is written into the Bot's own shard rather than editing another Bot's file — newest wins.

**Expected to fail today.** There is **no Workspace file-browser surface** in the app. "Visible on the Workspace" is provable only through `computer_exec` (which wakes the Computer — do journey 7 first) or the memory read path. If a browsable Workspace view is meant to exist, this is the gap.

---

## 7. The Computer wakes for work

**Persona intent.** Go do something real on a machine. Don't burn money sitting idle.

**Steps**

1. With the Computer asleep or never opened, glance at the sidebar **Computer** strip. Do not click it.
2. _"clone github.com/`<something small>` and tell me how many test files it has."_
3. Watch the strip while it works.
4. Single-click the strip to expand the viewer.
5. Walk away for the idle window and come back.

**Proof**

- Step 1 wakes nothing: no `ensure`/`connect` in `wrangler tail`. The strip renders the newest **durable** capture from the `screenshots` root by Workspace read URL; change detection is by `contentHash`.
- Step 2's run: `computer_exec` calls with `{ command }` in the recorded input, each with a `tool/result`. The Sprite wakes on the **first tool call**, not at Turn start — `turn/start`, `composition/pinned` and `model/request` all precede any host traffic.
- **Audit log**: one `shell`-kind row per `computer_exec` with `target: computer`, carrying the turn id. A `{ command, background: true }` call is a `process` row instead, producing a `computer/process` event and a `processId` you can follow with `computer_process_check`, `computer_process_logs`, `computer_process_stop`. A `computer_browser` call (`{ action: snapshot|navigate|click|fill|press|wait, … }`) is a `browser` row.
- Ask it to drive the GUI from the shell (_"just launch chromium yourself"_): the call is refused. The GUI is never driven from the shell.
- The strip's capture changes — a new `contentHash`, up to 20 kept per Bot, older ones pruned on the next capture.
- Step 4 opens the viewer **view-only**: the cursor is inert and a click does not reach the Bot's browser.
- After idle, the phase is asleep or `disconnected` and **the newest screenshot is still rendered** from the durable root. Reading it wakes nothing — ask a question needing no Computer and see no host traffic in `wrangler tail`.
- `computer_doctor` files a report under the `doctor` durable root; `computer_screenshot` files a PNG into `screenshots`. The Turn's `model/request` carries a `computer/injected` section, and durable-root syncs appear as `computer/sync`.

**Expected to fail today (local dev).** The hosted Computer path needs the Sprite host; a bare `wrangler dev` publishes local-host state only. Run this on staging or production.

---

## 8. Human takeover for a login

**Persona intent.** It hit a login wall. Let me type the password and get out of its way.

**Steps**

1. Ask for something behind a login: _"open my council rates portal and download this quarter's notice."_
2. When it stalls, click the strip — the viewer opens **view-only**.
3. Press **Take control**. Confirm in the dialog, which says the Bot is fenced from this desktop until you release.
4. Log in by hand.
5. Press **Escape**, or close the viewer.
6. _"ok, you're back in — carry on."_
7. Repeat 1–6 after an **Update Computer**, and again after letting the Computer go cold and waking it.

**Proof**

- Step 2: the session is `view_only`; no input reaches the desktop. The viewer URL carries a one-time token and appears in **no** session event and **no** log — grep the run events for it and find nothing.
- Step 3: a durable control lease is recorded on the Bot Durable Object **before** the Computer is asked, on the User-wide `desktop-gui` key. Prove it is User-wide: from a **second Bot of the same User**, ask for `computer_exec` — the `tool/result` is `human-control-active` and names the holder.
- While the lease is fresh, that second Bot's next `model/request` carries the system prompt section saying the User is controlling the Computer.
- Step 5: the lease is released by the Escape, not by the 90 s expiry — `computer_exec` from either Bot succeeds again within seconds.
- Step 6: the run continues past the login with `computer_browser` / `computer_exec` results showing the authenticated page.
- Watching counts as activity: `last-seen` is touched by viewer open and by renewal, so the slot reclaim did not take the display while you were looking at it. A dropped socket is a `disconnected` phase with a reconnect action, never a frozen frame on `ready`.
- After an in-place runtime update: the card showed an `updating` phase, the update did **not** start while your lease was fresh, and a Bot tool call arriving mid-update got a retryable `computer-updating` failure — never a `tool/call` with no `tool/result`.

**Expected to fail today.**

- **"Update Computer" does not exist as a user action.** Only the automatic in-place runtime-document update on wake is shipped (computer-presence plan P5). VM replacement and Reset are deferred behind parity row 32, so step 7's first half can only be performed by changing the runtime document and waking the Computer.
- **Logins do not survive a cold wake or a replacement.** Parity row 32 — cookie seeding, periodic capture, cross-window mirroring, import — is **not started**. Expect to log in again, and record how often a cold wake alone loses the session: that number decides whether row 32 is urgent.

---

## 9. A Routine that outlives you

**Persona intent.** Do this every weekday morning whether I'm here or not.

**Steps**

1. _"every weekday at 8am, summarise anything urgent in my inbox."_
2. Open Bot settings → **Routines** (`#bot-routines`) and read the row back.
3. Close the browser entirely. Come back after the firing time.
4. Force the interesting cases: a bad expression, **Run now**, and an eviction between firings.

**Proof**

- Step 1's run has a `tool/call` for `routine_manage` with `{ action: "create", name, prompt, schedule, timezone }`. The other actions are `edit`, `pause`, `resume`, `delete`, `run_now`.
- `GET /api/bots/:botId/routines` → a record with the schedule (never both a schedule and a trigger), the timezone, `enabled: true`, a writer of `{ kind: "bot", botId, sessionId, turnId }` naming the Turn that wrote it, and a `nextRunAt` supplied by the scheduler.
- _"every Blursday"_ is refused at write time with its reason, and nothing is stored.
- After the firing, with no client connected the whole time: `GET /api/bots/:botId/routines/:routineId/runs` has an `ok` entry naming its `runId`, and `lastRunAt` advanced.
- The firing is invisible in the conversation: the chat run list does not contain it, because `admission.turnType` is `automation`. Its events are reachable only through `GET /api/bots/:id/routines/:routineId/runs/:runId`.
- `debug.sh run <userId> <botId> <runId>` → admission carries `origin: { kind: "routine", routineId, fireId }` and the session is `routine:<routineId>`, not the User's.
- The automation Turn's `model/request` carries **only its own Turn** plus one pointer line naming the parent conversation — no chat history copied — while the Memory section is still present.
- No duplicate firing after eviction: the fire id **is** the run id, so a retry is refused by the kernel's fingerprint idempotency. Check exactly one fire record and one run-log entry per occurrence.
- If it handed off: `GET /api/bots/:id/routines/inbox` has an entry with `acknowledged: false` and `attribution: "Automation: <name>"`, the header badge shows it, and the Bot's **next chat Turn** has the hand-off prefixed to its input — visible in that Turn's `model/request`, while `run.input` stays exactly what you typed.
- Reading the drawer does **not** clear the badge; only the explicit acknowledge `POST` does.

---

## 10. A second Bot from a template

**Persona intent.** The first one turned out well. Make me another like it.

**Steps**

1. To the first Bot: _"pack yourself up as a template I can reuse."_
2. In Bot settings, find the staged template and create a Bot from it — read the review card before applying.
3. Give the new Bot a task that uses the Computer.
4. Ask each Bot to write a Memory fact and a Skill.

**Proof**

- Step 1's run has a `tool/call` for `bot_export_template` whose `tool/result` names a `shareId`. The template is staged **privately**; nothing is shared until the User picks a visibility, and it carries no Memory, credentials, Connections, or model.
- The review card is honest: each Package is `will-install`, `already-installed`, or `missing`, resolved only against the Catalog generation this User is pinned to. It creates **no** Connection and **no** credential — every server it names becomes a line telling the User what they must connect themselves. Compare the card against what the apply actually wrote in `GET /api/settings`.
- Step 2's write path: `bot_create` (the Bot's own tool, which issues the User's `bot/create` and nothing else) or the create dialog. The registration carries **no** `initialModel` and no Assignments — model and Capability authority resolve account-wide at the new Bot's next admitted Turn. There is no delete tool; `bot_update` cannot archive, restore, or remove anything.
- One Computer, shared: ask Bot A to write a file to `$FROCKBOT_SCRATCH` and Bot B to read it. It is there — scratch is shared across the User's Bots and survives hibernation without being durable.
- Separate roots: Bot A's Skills under `/home/box/agent-data/agents/<botA>/skills`, Bot B's under `.../agents/<botB>/skills`. Ask each for `skill_write` (`{ name, description, body, slug, scope: bot|user }`), check `skill/write-intent` → `skill/written` in each run, and check the paths differ. `user-memory` is shared but sharded — `by-agent/<botA>/` and `by-agent/<botB>/` — so each file has one writer.
- Shared browser profile: log in to a site as Bot A, then ask Bot B to open the same site. It is already authenticated. That is also why takeover in journey 8 fences the whole User.

---

## Friction log

One row per stumble, filled in while it is still annoying. Severity is how much it would bother a person who did not build this.

| #   | Journey | Step | What happened | Severity (blocker / annoying / papercut) | Repro test file |
| --- | ------- | ---- | ------------- | ---------------------------------------- | --------------- |
| 1   |         |      |               |                                          |                 |
| 2   |         |      |               |                                          |                 |
| 3   |         |      |               |                                          |                 |

**Repro test file** is where the failing test should live, so a row turns into code without a second conversation:

| Symptom                                          | Where its test goes                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| UI label, click path, console error, empty state | `apps/cloudflare/e2e/*.e2e.ts` — the `page` fixture already fails on any console error, page error, failed request, or 5xx |
| Gateway route, command decode, Durable Object    | `apps/cloudflare/test/*.workerd.ts`                                                                                        |
| A whole account's durable state, or a migration  | `apps/cloudflare/test/integration/*.integration.ts`                                                                        |
| One Package's logic                              | `packages/plugin-*/src/*.test.ts`                                                                                          |

---

## Legacy account subset

Journeys **1, 2, 4 and 5** again, against an account created before the account-wide configuration rollout — the shape in `apps/cloudflare/test/legacy-model-account.ts`: `provider-workers-ai` and `provider-ollama-cloud` installed, a `newBotModelTemplate` pointing at Ollama, a stranded `platformModel` pointing at Workers AI, per-Bot `assignments`, and a Bot-level `model`. Use a real pre-rollout account if you have one; otherwise seed the fixture into a User Durable Object the way `apps/cloudflare/test/integration/legacy-model-account.integration.ts` does.

**Before anything else**

- The first `GET /api/settings` migrates on read: `platformModel` becomes `{ connectionId: "flock-ai-ambient", providerModelId: "@frock/auto" }`, `provider-workers-ai` is gone from `packages[]`, and `custom-models` appears in state `disabled`. `newBotModelTemplate` and `newBotModelTemplateSource` are dropped, not interpreted.
- `GET /api/bots/:botId/settings` no longer carries `model` or `assignments`. The per-Bot override lives in `packageValues` under the Custom models Package id, and only once Custom models is enabled.
- The composer shows no "Model unavailable" and no model call to action.

**Then**

- **Journey 1** — the Bot's next Turn is admitted on Frock AI and `model/request` names `@frock/auto`. Nothing had to be repaired by hand.
- **Journey 2** — the pre-existing Ollama Connection is still in `connections[]` with its credential generation intact. Enabling **Custom models** makes it selectable on Models **without re-entering the key**, and the old per-Bot assignment does not resurrect: check `packageValues`, not `assignments`.
- **Journey 4** — `package_author` produces a Composition generation that mounts and `package_undo` reverts it. The legacy account had no Composition history, so check `lastKnownGoodGenerationId` is set only after a successful mount.
- **Journey 5** — `package_search` and `package_install` work against the generation this legacy User is pinned to; a legacy account with no recorded pin must land on the current pointer rather than failing.

**Expected to fail today.** Nothing here is known to be broken, but this subset is the most likely to surface migration gaps, because the fixture deliberately preserves historical fields — including the stranded platform binding an affected account actually reported. Any repair a human has to perform by hand is a blocker-severity friction row.

# Research: GrokBot's computer, as observed

Primary evidence: GrokBot ("Discovery Bot", agent `23ea47c3-…`) ran every command itself on 2026-08-30/31 and returned the
output. `§<n>` cites `MESSAGE_1_RESPONSE.md`; `§<A1|B5|C12|…>` cites `MESSAGE_1_ATTACHMENT_layout.md`; `§2.<n>` cites
`MESSAGE_2_RESPONSE.md` question `<n>`; `§2A` cites `MESSAGE_2_ATTACHMENT_files.md`; `§3.<n>` cites `MESSAGE_3_RESPONSE.md`;
`§4.<n>` cites `MESSAGE_4_RESPONSE.md` section `<n>`. Everything not marked **INFERENCE** is command output or a quote. GrokBot
labels harness-only facts **instruction** — from its injected prompt, not a file it opened — and from MESSAGE_4 also
**host-source**, meaning read out of the harness's own TypeScript (`system-prompt-assembly.ts`, the `memory` renderers,
`turn-toolset.ts`) rather than out of a prompt; both labels are carried through here.

## Summary

GrokBot's "computer" is not one machine per agent. It is a single long-lived Debian 13 container — user `box`, `HOME=/home/box`
— shared by all fourteen of Tim's Grok Bot agents at once (§B8, §B11). One overlay filesystem carries `/`, `/home/box`,
`/workspace` and `/tmp`, and `/tmp` is not tmpfs (§A3). Durable agent state lives under `/home/box/agent-data` → `sand-data`,
per agent as `agents/<uuid>/{memory,automations,…}` (§A1). Scratch is the shared `/workspace` (§B7), and Chrome is a single
shared profile — not per agent — so all fourteen bots share one cookie jar and one logged-in identity (§B6). A `sand-*`
supervisor stack runs virtual desktops (Xvfb + x11vnc + noVNC + xfwm4 + plank) on separate X displays behind separate
`exec-daemon` ports — seven of them for fourteen agents, so a "per-agent desktop" is a screen allocated on demand on the same
box (§C12, §3.8). The tool surface is seven native function tools plus 27 Cursor-namespace dynamic tools, five `Task` subagent
types and MCP connectors (§16–§18), trimmed per turn type; memory, routines, skills, profile, settings, projects and avatar all
mutate through one tool, `update_state`.

## Machine

Debian GNU/Linux 13.6 (trixie), kernel `6.12.94+` x86_64, hostname `cursor`, user `box`, default cwd `/workspace` (§A1, §A4).
`/.dockerenv` is present and PID 1 is `tini` running `/pod-daemon` (§A2) — but §2A says the shipped default runtime is a
_brokered anyrun pod_, not Docker; this box is the Docker variant. One `overlay` filesystem backs `/`, `/home/box`, `/workspace`
and `/tmp` (all `stat` device `39`); `df -h` shows 126 G total, 5.7 G used; the only tmpfs are `/dev` and `/dev/shm` (§A3). The
container started ~Aug 26 23:32 UTC and was unchanged on Aug 30 (§A2, §C15). ~936 `dpkg` entries including python 3.13.5, node
v20.19.2, git, rg, gh, jq, bun, uv, ffmpeg, pdftotext — while `tree`, the `docker` CLI and ImageMagick are **absent** (§B9).
**Update vs Reset** (§A3, §2A): _"Update Grok Bot Computer moves the box to a fresh instance while keeping files and logins.
Installed software does not survive the move."_ Reset "restores from the last saved snapshot and can lose recent unsynced work",
and the doc tells the agent never to steer users there (§9).

**Supervisor processes** (`ps aux --sort=-rss`, §C12). No systemd, supervisord, s6 or runit; roles are INFERENCE from name/argv.
PID 1 `tini` → `/pod-daemon` (argv names `/run/host-services/ssh-auth.sock` and `vsock port 52` — the host↔box control channel);
`sand-host/host-main.cjs` (~547 MB RSS) is the agent host, running turns and owning `sand-data`; seven `exec-daemon/index.js
serve` run commands (one main on `--port 1337 … --computer-use-enabled --mcp-meta-tool-enabled`, one per desktop on
`14003`–`14013`); `sand-supervisor.mjs`, `sand-window-router.mjs` and per-child `box-bounded-log.mjs` supervise, route and log;
four singletons handle durability and the browser — `sand-session-sync.mjs`, `sand-cookie-persist.mjs`,
`sand-special-treatment-chrome.mjs`, `sand-web-bot-auth.mjs` (226 min CPU, the busiest on the box); one
`Xvfb`/`x11vnc`/`novnc`/`picom`/`xfwm4`/`plank` set runs per display. `/usr/local/bin` launchers include `start-sand-box`,
`start-desktop.sh`, `start-window`, `supervise-*`, `box-chrome`, `box-doctor`, `sand-egress-tunnel`, `sand-webauthn-proxy-host`.

**Displays, background work, suspend** (§3.8). Live X locks are `:1 :3 :4 :5 :6 :12 :13` — **seven displays for fourteen
agents** — with `sand-window-{3,4,5,6,12,13}` beside them and `:1` the primary per `debugging-the-box.md`;
`sand-window-router.mjs` routes `x-sand-display` to port `1337` for display ≤ 1 and to `14000 + display` otherwise, behind an
owner-token check. INFERENCE (GrokBot's): displays are allocated on demand and idle agents hold no Xvfb; the agent-id → display
allocator was not found. **Instruction**: a `Shell` command exceeding `block_until_ms` keeps running in the background and
notifies on completion, `block_until_ms: 0` being the sanctioned way to start a never-ending process, so background jobs outlive
the turn — survival across a later wake was not probed. Whether the box ever suspends or idle-kills is **unknown**: no
idle-teardown evidence.

## Filesystem layout

Scope labels are OBSERVED from ownership and path shape (§A1, §A3, §B7, §B8, §B10, §2.4, §2.9).

```
/home/box/  [shared by all 14 agents]  .mcp-auth/ .beeper-mcp-auth/ [SECRET: OAuth]  .cursor/
  .local/ .npm/ .cache/ .config/{google-chrome,xfce4,plank,dconf}/ bin/ deps/ Downloads/ tmp/messages/
  cli-config/(700, empty)  sand-host/(host-main.cjs 25 MB, agent-isolation/)  agent-data -> sand-data
  .sand-webauthn-proxy-enabled  .sand-window-assignments.json  [flag; window↔agent map]
  chrome-profile/Default/{Cookies, Login Data, …} [SHARED, SECRET]  telegram-{inbox/,allowlist,webhook}
  reference/{debugging-the-box.md, app-ui.md}  [shipped docs, not agent-written]
/home/box/sand-data/   [durable; mode 700]
├── agents/<uuid>/   [PER-AGENT — 14 dirs]  profile.json settings.json avatar.<ext>?  audit.jsonl
│   memory/profile.md  memory/log/YYYY-MM.md   automations/<slug>/{automation.json,runs.json}
│   store.db  conversation-blobs.db (+ -wal/-shm)   [sqlite]
├── agents/{active-agent.json, audit-outbox.json}  agent-transcripts/<id>/<id>.jsonl
├── user-memory/by-agent/<uuid>/profile.md  [PER-USER memory sharded by writer; only 2 exist]
├── connector-secrets/<agent-uuid>/ [SECRET, 2 of 14]  workflows/<slug>/SKILL.md [GLOBAL — EMPTY]
├── managed-skills/skills/{add-connector, export-bot-template, import-bot-template,
│      learn-from-demonstration}/SKILL.md + cache.json;  plugin-skills/cache.json
├── plugins/cache/cursor-public/<plugin>/<git-sha>/
├── {box,host}-secrets.json webhook-keys.json teach-queue-key.json chrome-cookie-seed.json [SECRET]
├── settings.json gateway.json source-map.json  [host-only: `Read` refuses, python does not, §2.4]
└── search-index.db (+ -wal/-shm) [462 KB; transcripts of ALL 14 agents]  ack-obligations.json
    host-pending-wakes.json host.lock box-store-sync.lock …  NOTE: `projects/` does NOT exist (§B5).
/workspace/  [SHARED SCRATCH] xero/ linkedin_profile/ health-docs/ up/ tradie-sites/ + ~60 loose
   files. `/workspace/uploads` NOT observed (§7).   /tmp/ [overlay, NOT tmpfs] sand-desktop/
   sand-window-{3..13}/ sand-{window,novnc}-tokens.d/ sand-supervisor/ xdg-runtime*/ .X<N>-lock
   {xvfb,x11vnc,novnc,xfwm4,picom,plank}:<display>.log sand-host.log box-doctor.log exec-daemon.log
```

## `update_state`: the single mutation surface

A **first-party** tool (not in the `cursor` namespace). Its descriptor (§2.2) takes a required `target` — `memory | routine |
skill | profile | settings | channel | project | avatar` — and a required `action` — `write | forget | create
| update | pause | resume | delete | set | disconnect | join | leave | clear`. Disk effects below are **instruction**
unless corroborated on disk.

| target   | actions                               | input                                                                                                                                          | disk effect                                                                                                                                                                                         |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory   | write, forget                         | `fact` (exact sentence); write also `tier` (`profile`/`log`/`note`, default log), `scope` (`agent`/`user`/`project`, default agent), `project` | agent → `agents/<id>/memory/profile.md` or `memory/log/YYYY-MM.md`; user → `user-memory/by-agent/<id>/`; project → `projects/<slug>/memory/by-agent/<id>/`. `forget` needs the exact recorded text. |
| routine  | create, update, pause, resume, delete | create: `name`, `prompt`, `schedule` XOR `trigger`; others: `id` (folder slug); update rewrites name/prompt/schedule/trigger/enabled           | `agents/<id>/automations/<slug>/automation.json`. `runs.json` is written by the runtime, not this tool.                                                                                             |
| skill    | write, delete                         | write: `name`, `description` (required, "use this when …"), `body` (markdown); `id` to rewrite                                                 | `agent-data/workflows/<slug>/SKILL.md` — **global across all the user's assistants**. Managed skills are not editable this way.                                                                     |
| profile  | set                                   | `name` and/or `description`                                                                                                                    | `agents/<id>/profile.json`; edits are announced to the user. `title`/`avatarShape`/`avatarColor` exist in the JSON but the action does not document them.                                           |
| settings | set                                   | `hidden_from_sidebar`, `notify_on_updates` (only passed fields change)                                                                         | `agents/<id>/settings.json` (observed: `{"notifyOnAgentUpdates": true}`)                                                                                                                            |
| channel  | disconnect                            | `platform`                                                                                                                                     | disconnects a live channel connector                                                                                                                                                                |
| project  | create, join, leave                   | create: `project` slug, `name`, optional `description`; join/leave: `project`                                                                  | `agent-data/projects/<slug>/` + membership; create-is-join if the slug exists. **The dir does not exist on this box.**                                                                              |
| avatar   | set, clear                            | set: `path` to an image already on disk (png/jpg/webp/gif/svg, < 5 MB)                                                                         | `agents/<id>/avatar.<ext>`; clear restores the default                                                                                                                                              |

Creating or changing a routine may show the user a confirmation card (§2.2).

## Memory model

Given to GrokBot, not designed by it: _"Given to me; I did not design it"_ (§5).

- **Three memory _scopes_, not one memory** (§4.1a, injected text pasted with facts redacted): **own** (`Memory:`), **project**
  (`Project memory:`) and **user** (`User memory:`). They are paragraphs in the prompt that begin with those labels, not `##`
  headings, joined blank-line-separated in the order **user, project, own** (**host-source**, §4.1b). The agent profile is a
  _separate earlier_ `Agent profile:` section, not part of Memory.
- **Three write _tiers_ within a scope** (**instruction**, §2.2): `profile` = foundational, _"kept in mind every turn"_; `log` =
  dated history, the default tier, monthly `log/YYYY-MM.md` with line format `- (YYYY-MM-DD) <fact>` (now OBSERVED on disk after
  writes); `note` = _"fades fast"_. **Facts are deduped** by the host; `forget` matches the exact recorded text.
- **Every memory file has a single writer** (§4.1a, quoting the injected text). User memory _"lives under
  /home/box/agent-data/user-memory, split into one shard folder per assistant so every file has a single writer"_; the agent's
  own shard is `user-memory/by-agent/<agent-uuid>/` (a `profile.md` plus `log/YYYY-MM.md`), and it is told _"Never edit another
  assistant's shard"_. Project memory shards the same way: `projects/<slug>/memory/by-agent/<assistantId>/` — _"a standard
  profile.md + log/"_. Correcting another assistant's fact means writing the corrected fact into **your own** shard and letting
  newest-wins resolve it.
- **The single write path is `update_state`** (§4.1a): `target "memory"`, `scope "agent" | "user" | "project"` (plus `project=<slug>`
  for the project scope), `action "write" | "forget"`, and for a write a `tier` of `profile | log | note`. Reading is ordinary
  `Read`/`Shell` over the shards; only changes are told to go through the tool. Project membership is its own target:
  `update_state target "project"` with `create` (create-is-join if the slug exists), `join`, `leave` — and _"Only projects you
  have joined load below"_.
- **Precedence** (§4.1a, injected verbatim): _"on conflict prefer your OWN memory first, then project memory, then user memory —
  the most specific wins"_, with _"newest wins on conflict"_ within a shared tier. This matches the §2.3 instruction; MESSAGE_4
  is the first time the three-way ordering was seen in the prompt itself.
- **Attribution.** Shared facts are tagged `[via <assistant>]` _"so you can tell which assistant learned each one"_ — GrokBot saw
  `[via General]` and `[via School]`.
- **On-disk and injected fact formats differ** (**host-source**, §4.1b). On disk: `- (YYYY-MM-DD) <fact>`. Injected: own agent
  `- (learned YYYY-MM-DD) <fact>`; user and project `- (learned YYYY-MM-DD) [via <assistant>] <fact>` (the `[via …]` omitted when
  `via` is empty). Notes and episodes are stored as a `[note] ` / `[episode] ` prefix _on the fact text_, not as separate files.
- **Renderer headings** (**host-source**, §4.1b), added only when the corresponding array is non-empty: user memory gets
  `About the user (shared):` then `Recently (shared):`; each injected project gets
  `Project "<name>" (<slug>) — your shard: <dir>:`, then `About this project (shared):` / `Recently (shared):` or
  `No shared facts recorded yet for this project.`, then `Also a member of: …`; own memory gets `About the user:`, `Recently:`
  and optionally `(N more log facts on disk — grep the log/ folder for them.)`. Empty own profile+recent renders
  `No facts recorded yet.`; empty shared user renders `No shared facts recorded yet.`
- **The block is capped, not a file dump** (**host-source** constants, §4.1b). Own: `recall(30)` recent facts, 4000-char recent
  budget, 500-char clamp per fact. User: profileLimit 50 / recentLimit 15, char budgets 4000 / 2000. Project: at most **3**
  projects injected (`MEMORY_PROJECT_INJECTED_CAP`), profileLimit 25 / recentLimit 10, char budgets 2500 / 1500. So a memory
  file can outgrow what any turn ever sees, and the agent is told to grep the rest.
- **Then it is frozen** (**host-source**, §4.1b): `resolveFrozenMemoryPrompt` reuses the rendered snapshot for as long as
  `compactionEpoch` matches, unless `SAND_DISABLE_MEMORY_FREEZE=1`. Freeze is the mechanism behind `kv.memoryPromptSnapshot`.
- **The injection reality — OBSERVED DIVERGENCE (§2.3, §3.6, §4.1a).** On three independent automation-subagent runs the
  injected own-`Memory` block said _"No facts recorded yet"_ while `memory/profile.md` held facts (2, then 3) and
  `log/2026-08.md` held a `[note]` line. Shared user memory **was** injected each time (5 bullets this run, `[via General]` /
  `[via School]`); no `Recently (shared):` block and no project blocks appeared, only project boilerplate. So own-agent profile
  memory, which the harness claims is kept in mind every turn, is consistently **not injected on automation turns**. INFERENCE
  (GrokBot's, §4.1b): **the freeze is the most likely cause** — a snapshot rendered when the agent had no facts is being reused
  while `compactionEpoch` holds — rather than a deliberate blanking of automation subagents. Unresolved: whether own profile
  facts appear on a live chat turn. The renderer is the same function either way (§4.1b).
- **This agent has no user-memory shard of its own** (§4.1a): the shared facts it sees all come from other agents' shards, and
  `user-memory/by-agent/<its uuid>/` does not exist — consistent with INFERENCE that a shard is created on first user-scoped
  write (2 of 14 exist).
- **`project` scope is fully specified but never used on this box** (§3.7, §4.1a): the prompt carries the whole project
  paragraph including paths, but there is no `agent-data/projects/`, no `projects.json` under any agent, and no agent has ever
  created one; whether the host materialises the directory on first `project create` is untested — GrokBot did not call it.
- **The injection text is snapshotted**: `store.db kv.memoryPromptSnapshot` (4451 chars) and `agentProfilePromptSnapshot` are
  rendered copies of what was injected (§2.5). Memory changes only via `update_state`, but the files are ordinary readable
  markdown, so that is a contract, not a permission boundary. INFERENCE: a shard is created on first user-scoped write (2 of 14
  exist).

## Databases and audit trail

- **`sand-data/search-index.db`** (462 848 B + WAL) — SQLite, **transcripts of all 14 agents**, not memory files. Schema as read
  (§2.4): `agents(agent_id PK, fingerprint NOT NULL)` (14 rows); `media(id, agent_id, entry_id, file_name, ext, mime, kind,
timestamp_ms, width, height, UNIQUE(agent_id, entry_id))` (4); `messages(id, agent_id, entry_id, role CHECK user|assistant,
timestamp_ms, body, UNIQUE(agent_id, entry_id))` (958); `meta(key PK, value)` (1 row). **There is no search tool over it** —
  the agent can only SQL it from `Shell`.
- **`agents/<id>/store.db`** (4 KB + 556 KB WAL) — `automation_completion_inbox(seq PK, id UNIQUE, text, attribution,
acknowledged 0|1)`, `blobs(id PK, data BLOB)` (empty), `kv(key PK, value TEXT)`, `transcript_entries(seq PK, id UNIQUE, entry
TEXT)` (17 rows, kinds `event`, `send-message`). The 8 `kv` keys: `metadata` (agentId, latestRootBlobId, name, createdAt,
  `mode: "default"`, `isRunEverything`, `blobEncryptionKey` **[redacted]**), `origin`, `unreadState`,
  `agentProfilePromptSnapshot`, `memoryPromptSnapshot`, `requestIds`, `episodePending`, `lastTurnSettlement`. Observed inbox
  row: `automation-subagent:6ee6b077-…`, `acknowledged=1`. `transcript_entries` kinds across runs: `event`, `send-message`,
  `spend-initiation`, `message`; `kv.unreadState` = `lastActivityAt`/`lastViewedAt`/`unreadCount`/`isManuallyUnread` (§3.2,
  §3.4).
- **`conversation-blobs.db`** — one table `blobs(id TEXT PK, data BLOB)`, 175 blobs / 845 379 B, ids look like sha256 hex; the
  real message bodies live here because `store.blobs` is empty. The `blobEncryptionKey` in `kv.metadata` is 64 hex chars = **32
  bytes**, generated into default agent metadata by the host (`getDefaultAgentMetadata` in `host-main.cjs`), so the host holds
  it by construction; whether Cursor cloud keeps a copy is unknown. Rows are **not uniform ciphertext**: some are plaintext
  UTF-8 JSON payloads (printable ratio ~1.0), others binary frames (protobuf-shaped, one head containing ASCII `SAND_HIDDEN_…`,
  entropy 4.5–6.6 bits/byte). INFERENCE (GrokBot's): the key serves some blob codec or host path, not blanket at-rest encryption
  of every row — the codec was not reversed (§3.5).
- **`audit.jsonl`** — 202 lines, **every line `type=shell_command`**, e.g.
  `{"ts":"2026-08-30T22:37:12.433Z","agentId":"23ea47c3-…","eventId":"dd8f6ade-…","turnId":"a0071eb9-…","type":"shell_command","command":"ls
-la ~/tmp/messages …","shellKind":"foreground","target":"box"}` — every command tied to a turn and to a target (`box` or
  `user_machine`). True of **every** agent's `audit.jsonl`, not just this one (§3.4).
- **`agents/audit-outbox.json`** — a richer schema, 1028 entries keyed by `action.kind`: `shellCommand` (934),
  `browserNavigation` (98), `mcpToolCall` (4). Browser navigations and MCP calls are audited, but only in the outbox. **Memory
  writes and routine edits are audited nowhere** — they leave traces only in `memory/*.md`, `automation.json`, transcript
  entries and the search index.

## Durability: what syncs, how often, what Reset loses

Three host-owned mechanisms (§3.3). **`sand-session-sync.mjs`** mirrors cookies and localStorage across the live Chromes over
CDP every `POLL_INTERVAL_MS = 1500` (`SAND_SESSION_SYNC_INTERVAL_MS`) — box-internal consistency, not off-box durability.
**`sand-cookie-persist.mjs`** captures the live cookie jar over CDP into `agent-data/chrome-cookie-seed.json` every
`CAPTURE_INTERVAL_MS = 5000` (`SAND_COOKIE_PERSIST_INTERVAL_MS`). **`box-store-sync`** is a host extension bundled into
`host-main.cjs` beside `box-store-vacuum-worker.cjs` (a `VACUUM INTO` worker snapshotting sqlite off-thread);
`box-store-sync.lock` is its writer lock, `{uid, pid, hostname, windowId, acquiredAt}`. Its constants, read out of
`host-main.cjs`:

```
BOX_STORE_SYNC_INTERVAL_MS        = 2 * 6e4    # 120 s full sync tick
BOX_STORE_CHROME_INTERVAL_MS      = 15 * 6e4   # 15 min Chrome session snapshot
BOX_STORE_DB_DEBOUNCE_MS          = 5e3        # 5 s after a DB write
CHROME_SESSION_CHANGE_DEBOUNCE_MS = 5e3
AGENT_STORE_DB_BASENAMES          = ["store.db", "conversation-blobs.db"]
```

Its startup line is _"box-store sync enabled (snapshot-out only)"_ — one-way, box → host, never a pull back down. Excluded from
the synced `sand-data` category: `host-upgrade-resume.json`, `ack-obligations.json`, `host-pending-wakes.json`,
`host-disk-pressure-reminders.json`. So the durable unit is the per-agent sqlite pair plus the Chrome session; `/workspace`,
`memory/*.md` and `automations/` ride on the container's own overlay instead. **What Reset can lose — INFERENCE (GrokBot's own
label):** anything changed since the last successful snapshot cycle — up to the ~5 s DB debounce plus the 120 s tick, up to ~15
min of Chrome session state when idle (sooner on a session-DB change), in-flight cookies not yet caught by the ~5 s capture, and
the excluded control files, which are never in the snapshot at all. Installed packages are separate: Update already drops them.
`ps -o args` exposes none of these intervals.

## Routines (automations)

`automations/<slug>/automation.json` is the whole routine definition, and `runs.json` the run log written by the runtime (§2.6):

```json
{ "name": "New Message",
  "prompt": "When this runs, a new message has been written on Tim's computer … Read PROTOCOL.md …",
  "trigger": { "type": "webhook" },  "triggerPresentation": { "version": 1, "trigger": {…} },
  "enabled": true, "provenance": "user", "createdAt": 1788129330192, "lastRunAt": 1788132190802 }
{ "id": "c84a23b3-…", "requestId": "49c38ee1-…", "trigger": "event", "startedAt": 1788132190804,
  "finishedAt": null, "status": "running", "event": "Webhook POST: \"{\"message\":\"New message …\"" }
```

Observed `trigger` values `event` and `manual`; observed `status` `running` and `ok`. The webhook key is **not** in
`automation.json` — it lives in `sand-data/webhook-keys.json` (mode 600).

**Complete trigger-type list** from the `update_state` descriptor (**instruction**, §2.6); never both `schedule` and `trigger`.
**cron** (5-field, Australia/Sydney, or `@hourly`/`@daily`/`@weekly`/`@monthly`/`@every …`, optional `CRON_TZ=`); **slack**
(channel `#eng`/`@someone`/`*`; match `mention`|`keyword`|`message`|`reaction`); **github** (one `owner/name`; PR/review/CI
events; optional `pr`, `userAllowlist`, `ciBranch`); **origin** (Cursor Origin repo; CI is PR-only); **microsoftTeams**
(`tenantId` + `teamIds`; optional `channelIds`/`messageContains`); **linear** (`issueCreated`|`statusChanged`|`endOfCycle`);
**sentry** and **pagerduty** (issue/incident lifecycle events); **webhook**; **group** (any-of over several).

**Firing semantics** (OBSERVED, §2.7). The cue is `[routine] "New Message" (folder new-message) was triggered by an event…`,
then _"You are running an automation as a fresh subagent with the same work capabilities as the parent agent"_ and _"The parent
agent's shared durable memories are available… Parent transcript pointer: `agent-transcripts/<id>/<id>.jsonl` (not copied into
the prompt)"_. So a routine run is a **fresh subagent turn under the same agent id**, not a turn inside the user's chat. It
cannot mutate the visible transcript or speak to the user; `WakeParent` is the only immediate route, and its final message is
persisted **silently**, arriving later as an `automation_completion_inbox` row on the parent.

**Concurrency — OBSERVED (§3.1).** Across the siblings' `runs.json` (5 routines, 36 rows), runs of _different_ agents overlap in
wall time, both finishing `ok`:

```
school    weekday-school-brief  started 2026-08-26T21:34:57Z  finished 21:35:37Z
housework weekday-housework     started 2026-08-26T21:35:27Z  finished 21:36:13Z   # overlap ~10 s
school                          started 2026-08-30T21:31:10Z  finished 21:32:23Z
housework                       started 2026-08-30T21:31:54Z  finished 21:33:10Z   # overlap ~29 s
```

Runs of the _same_ routine were strictly sequential — every `startedAt` ≥ the previous `finishedAt` on `telegram-inbox`, and
`new-message` never showed two `running` rows. INFERENCE (GrokBot's): cross-agent concurrency is real and same-routine
serialization looks likely, but **no hard lock was found**; a routine firing while the user is mid-chat with the same agent was
never observed. **Delivery to the user (§3.2)** rides four on-disk mechanisms: the completion text queues in `store.db
automation_completion_inbox` with `acknowledged` and an `attribution` like `Automation: New Message`;
`agent-data/host-pending-wakes.json` holds pending wakes with `kind: "subagent"`, `quietOrigin.automation`, a title and an
`automationRunUuid`; `kv.unreadState` tracks the unread counters; and every agent's `settings.json` carries
`notifyOnAgentUpdates: true`. So a subagent finishing against a sleeping parent lands in inbox + pending-wake + unread
machinery, not nothing — whether that surfaces as a push notification or only a sidebar unread is app UI GrokBot could not
verify from the box.

## Skills, workflows, plugins

**Skill format** (§2.8). A skill is a folder containing one `SKILL.md`: YAML frontmatter with `name` and `description` ("use
this when …"), then a markdown recipe body — e.g. `workflows/daily-standup/ SKILL.md` = `---\nname: Daily standup\ndescription:
Use this when assembling the weekday standup.\n ---\n# Steps\n1. …`. **Loading**: only the _catalog_ is injected each turn, as
`<agent_skills>` with each skill's `fullPath` + `description`; bodies are not, and the agent is told to Read the `SKILL.md` when
relevant and that _mentioning a skill is not running it_. Users invoke with `/` or `@`.

**Three skill roots** (§2.9). `managed-skills/skills/<slug>/SKILL.md` is Cursor-shipped, read-only, not editable via
`update_state` (4 here, plus a protected `cache.json`). `plugin-skills/cache.json` is only an _index_ of skills that arrived
with installed plugins, mapping pluginId → name → filePath into `plugins/cache/…` — no `SKILL.md` lives there (2 Composio
skills). `workflows/<slug>/SKILL.md` is user-authored, **global across the user's assistants**, where `update_state skill write`
lands; **empty** on this box.

**`learn-from-demonstration` — a recording becomes a global skill** (§3.9). From the ~164-line managed `SKILL.md`: claim a teach
recording from `/workspace/teach-sessions/queues/<scope>/{pending, claimed}/`; read its `session.json` (`sessionDir`,
`videoPath`, `ffmpegPid`); watch the mp4 through a `watchVideo` `Task`, cross-checking box Chrome history; write the result as a
**global** skill via `update_state skill write` into `workflows/<slug>/SKILL.md`; delete the claimed video on success. Video
attachments cap at ~15 MB. Nothing has been taught here — `workflows/` is empty and `/workspace/teach-sessions` does not exist.
This is what `teach-queue-key.json` is for.

**`add-connector` — more than `SearchPlugins` + OAuth** (§3.10). From its `SKILL.md`: resolve the service name (ask if missing)
→ `SearchPlugins` over the read-only catalog → `GetPlugin` for setup fields, MCP servers and bundled skills → confirm with a
**question widget** → `InstallPlugin` with `values` for those setup fields → authenticate through a **host-authored connect
card** returned by `InstallPlugin`/`AddMcpServer`/`AuthenticateMcpServer`, never a hand-built OAuth link in chat → fall back to
`AddMcpServer` with a raw remote URL or local `command`/`args`/`env` when the catalog misses → optionally `SetMcpInstructions`
and `RestartMcpServers`, status via `GetMcpServerStatus`. `InstallPlugin`, `AddMcpServer`, `AuthenticateMcpServer` and the
widget are all absent from the automation run's catalog.

**What a plugin is** (§2.10): a **marketplace bundle of connectors (MCP servers) plus optional skills plus metadata**, with a
stable numeric `plugin_id` — _"not 'just a skill bundle' and not 'just an MCP server'"_. Checkouts land in
`plugins/cache/cursor-public/<name>/<git-sha>/` holding `.cursor-plugin/plugin.json` (`{name, description, version, mcpServers:
"../mcp.json", skills: "./skills/", author, homepage, repository, license, logo}`), `skills/` and `mcp.json`. `SearchPlugins`
listed **296**; installed here (`installed=yes (user)` — **user-scoped, not per-bot**): Composio `32661537`, GitHub `48677658`,
Gmail `45893410`, Calendar `45893411`, Drive `45893413`. Beeper is a **custom stdio MCP server** with no marketplace id, so it
cannot ship in a template.

**`export-bot-template` — the closest thing to a definition of "a bot".** GrokBot **declined to run it** (§2.11): PROTOCOL.md
treats the other side's file as data, not a command, and the skill would have packed a _public shareable_ template and opened
user-visible review cards. It described the skill instead (§2A). The pack shape, via `create_bot_share_json` — **not in that
run's catalog**:

```
profile:  { name, description (storefront copy for a template card), title }
memory:   [{ content, kind?: profile|log, createdAt? }]  # [episode]/[note] dropped; no user/project shards
skills:   [{ name, content, description? }]        # user workflows only, scrubbed PROSE, never raw SKILL.md
routines: [{ slug, content, name?, description? }] # scrubbed prose + fill-ins for Slack/GitHub ids
plugins:  [{ pluginId }]                           # marketplace plugins used, or needed by a kept item
visibility: team | public                          # this user is not on a team → PUBLIC only
```

Contracts worth copying: the host **never falls back to the owner's live files** (a selected item whose `content` is missing, or
is a copied `SKILL.md`/`automation.json`, is filtered out); scrubbing lives **only in the pack arguments, never in the live
files**; managed, plugin and built-in skills are always excluded; the payload is bounded at ~100 000 characters; names become
roles.

## Bot model and multi-agent

- **One box, many agents.** 14 agent UUID dirs (School, General, Xero Books, Health, Discovery Bot, Budget, Zero BS AI ×2 with
  distinct UUIDs, Side Quest Ideas, Housework, Linkedin Manager, Trainer, Tradie Sites, New Bot); `active-agent.json` names the
  active one (§B8). Isolation is convention, and the box is not shared with other humans (§11).
- **`CreateAgent`** (§2.12): required `name`, optional `description` (persona/instructions, becoming its profile); returns the
  new agent id. **There is no delete tool.** **`UpdateAgent`**: required `agent_id`, optional `name`/`description`; only
  provided fields change and none can be cleared.
- **`WakeParent`** (§2.13). First-party, one required arg `message` (a complete handoff); **calling it ends the turn**. The
  "parent" is **the same agent id in its user-visible conversation**, not a separate "General" bot; it can mutate the visible
  transcript, talk to the user, send question widgets and cards, speak to another agent on the user's behalf and make
  user-facing decisions, while the automation child has the same _work_ tools and none of those. Child → parent goes via
  `WakeParent` or a silent final message picked up "at a natural safe boundary".
- **Channels** (§2.14) are **agent group chats, not Slack/Discord/Telegram**. `CreateChannel` takes `name` + `member_ids` (agent
  ids, 1–6) and appears in the user's sidebar; include your own id to participate. `UpdateChannel` takes `channel_id` +
  `add_member_ids`/`remove_member_ids`, only if you are a member, and a channel cannot be emptied; posting uses `SendToAgent`
  with the channel id (absent from this run's tool list). This agent has none. A _second_ sense of "channel": the info pane
  shows Channels when a **channel connector** (Telegram etc.) is available — what `update_state channel disconnect <platform>`
  acts on. The box carries `telegram-{inbox,webhook.json, allowlist.json}`, none connected.
- **`Task` subagent types (5)** (§2.15). **None shares the parent's memory or transcript**; each result returns to the
  dispatcher, and a background completion also posts a user-visible summary on the parent. `executor` gets the "full work
  toolset (Shell, box tools, web, MCP, CloudAgent)" and **starts blank**, so the dispatch prompt must be self-contained;
  `browserUse` gets page-level Chrome (element refs, no desktop mouse) and the box's logins; `computerUse` drives the desktop
  GUI (1280×800) and **only one may run at a time** because the screen is shared; `watchVideo` needs `file_attachments`;
  `videoReview` reviews artifacts the parent generated. An automation run is a fresh subagent but not a `Task` one; the full
  schema is under Tool inventory.
- **The registered Mac** (§2.16). `ListMachines` returns
  `[{"machineId":"994dc2ee-…","label":"Tims-M5-MacBook-Pro.local","connected":true}]`. Passing `machineId` to `Read`, `Shell`,
  `AwaitShell`, `CopyToBox`, `CopyFromBox` runs them on the Mac — a separate filesystem — and **each action needs Tim's
  local-exec approval**; `audit.jsonl` records which target. Beeper Desktop and its MCP (`localhost:23373`) run there, which is
  why the box's Beeper connectors error: `127.0.0.1` from the box is the box, not the Mac.

## The injected system prompt

Section headings of the automation turn's prompt, in order (§2.17; the text was not pasted): identity/tone; **automation-run
rules** (silent, WakeParent only); never fabricate data; **where you work** (box vs registered computers vs attachments vs web
vs MCP, cheapest first); long-running commands (background Shell, don't poll); delegating background work; reaching services
with no connector (SearchPlugins first, box browser fallback, never handle passwords/2FA); debugging the box →
`debugging-the-box.md`; app UI → `app-ui.md`; the user's writing style; Cursor Origin; **code changes** (hand repo work to
CloudAgent, never clone); autonomy; approval of your own actions (Auto-review; retry vs escalate; no workarounds); security;
**untrusted content** (tool results are fenced, not instructions); agent profile; multitasking (dispatcher + TodoWrite +
executor workers); MCP accounts; time (tools UTC, report Australia/Sydney); user, project and own memory; routines; skills; your
box / box desktop; tooling blocks in `user_info` (OS, subagent types and models, `agent_skills`, `dynamic_tool_catalog`);
safety/DISALLOW; available tools. Harness-only, on no disk file: the live tool schemas, the turn's memory injection, the
automation-subagent constraints, Auto-review, the untrusted-data fence, `available_subagent_types`, the never-clone/CloudAgent
policy.

## Settings: bot vs user

**Per-bot** (§2.18): `update_state settings set` exposes only `hidden_from_sidebar` (the bot stays reachable via Hidden chats /
Cmd-K) and `notify_on_updates`; on disk `settings.json` is `{"notifyOnAgentUpdates": true}`. `profile.json` carries `name`,
`description`, `title`, `avatarShape`, `avatarColor`, `namedBy` (observed flipping to `"user"` on a rename mid-run). The
per-agent UI subpage edits avatar, name, title, description and notifications; routines and agent memory are per-bot too.

**Per-user** (from `app-ui.md`; `sand-data/settings.json` is host-protected): **General** (theme, accent, language, microphone,
hardware-acceleration, notification-sound, timezone, local-execution, auto-review, security-keys, sign in/out), **Computer**
(registered machines, chrome-cookie-import, egress, update-computer, reset-computer), **Usage & Billing** (plan, cancel-trial,
on-demand; account-gated), **Updates** (update-channel, automatic-updates, Check for Updates — the **app**, not the box).
Plugins and MCP are user-scoped; `workflows/` skills are global.

## The two shipped reference docs

Full text in §2A; both dated 2026-08-30 04:52 UTC, Cursor-written. **`debugging-the-box.md`** is a self-diagnosis runbook: a
`Shell` command returning output proves the box is up, "still starting up" is transient, and if `Shell` and `Screenshot` are not
offered at all the substrate is down. The box ships **`box-doctor`**, run at startup and on demand, writing
`/tmp/box-doctor.log`, checking "the handful of things that silently break the box" — `/etc/machine-id`, Chrome and its version,
DNS/egress, the clock, the D-Bus session bus — one `[box-doctor] PASS|FAIL <name>: <detail>` line per check plus a `SUMMARY`.
Desktop triage: `:1` is primary and comes up **with no browser window**, so no Chrome process is normal; tail
`/tmp/{start-desktop,x11vnc:1,novnc:1}.log`; stale X or Chrome locks after a wake are a known cause; never drive GUI apps from
`Shell` with `xdotool` or CDP. **Two runtimes exist** — local Docker (dev) and a "brokered anyrun pod" (**the default**) — told
apart by `/.dockerenv`. The agent **cannot rebuild the box**: point the user at Update, never Reset; `request_box_help` hands
over a manual step on a _working_ desktop.

**`app-ui.md`** maps real UI paths with an instruction never to invent others. Settings open from the bottom-left account
button, `Cmd+,` or the palette — **no gear icon, no macOS Preferences item**. Deleting an agent is sidebar right-click → Delete:
permanent, removes the transcript, **no archive or hide**. It enumerates the four tabs and every linkable row anchor
(`grokbot://app/v1/settings?id=<anchor>`), notes rows can be absent per account/build/state, and makes Update Computer a
two-click confirm. The **per-agent info pane** (chat header or `Cmd+Shift+I`) shows a live preview of that agent's computer over
its Routines list, plus Channels when a channel connector is available and Members in group chats.

## Tool inventory

**Native function tools (7):** `WakeParent`, `update_state`, `Shell`, `Read`, `Screenshot`, `GetDynamicTools`,
`CallDynamicTool`. **Cursor-namespace dynamic tools (27, via `CallDynamicTool`):** `AwaitShell`, `CheckSubagent`, `CloudAgent`,
`CopyFromBox`, `CopyToBox`, `CreateAgent`, `CreateChannel`, `GenerateImage`, `GetMcpServerStatus`, `GetPlugin`, `ListMachines`,
`MessageSubagent`, `RemoveMcpAccount`, `RenameMcpAccount`, `RestartMcpServers`, `SearchPlugins`, `SendFeedback`,
`SetMcpInstructions`, `StopSubagent`, `Task`, `TodoWrite`, `UninstallMcpServer`, `UninstallPlugin`, `UpdateAgent`,
`UpdateChannel`, `WebFetch`, `WebSearch`. Named in descriptors but **absent from the automation run's catalog**: `SendToAgent`,
`create_bot_share_json`, `request_box_help`, `SendToUser` — trimming per run type is now **host-source**, not inference (§4.2,
the table below). **MCP** (§16):
Gmail ×5 accounts (31 tools each), Calendar ×5, Drive ×5 connected; GitHub **needsAuth**; Composio connected;
`beeper`/`beeper-desktop` **error**.

**The full first-party catalog, from `buildTurnTools`** (**host-source**, §4.2 — GrokBot read the harness's `turn-toolset.ts`
rather than a chat prompt, so this is registration, not a screenshot of a chat turn's tool list). **here** = callable on an
automation turn; **chat-only** = registered for the parent chat path and gated off parent-mediated automation by
`isParentMediatedAutomationSubagent` / `isSubagentRunner`; the named `gates.*` are feature flags that can drop a tool even on
chat. MCP app tools are dynamic and account-specific and are not part of this list.

_Present on an automation turn:_ `WakeParent` (ends the turn and wakes the parent — the only user-visible path, and chat does
**not** get it), `update_state`, `Shell`, `Read`, `Screenshot`, `GetDynamicTools`, `CallDynamicTool`, `Task`, `TodoWrite`,
`ListMachines`, `AwaitShell`, `CheckSubagent`, `MessageSubagent`, `StopSubagent`, `CloudAgent`, `CopyToBox`, `CopyFromBox`,
`CreateAgent`, `UpdateAgent`, `CreateChannel`, `UpdateChannel`, `GenerateImage`, `WebSearch`, `WebFetch`, `SendFeedback`,
`SearchPlugins`, `GetPlugin`, `UninstallPlugin`, `UninstallMcpServer`, `GetMcpServerStatus`, `SetMcpInstructions`,
`RestartMcpServers`, `RemoveMcpAccount`, `RenameMcpAccount`.

_Chat-only (absent on an automation turn):_

| Tool                                                                                                                                           | What it is                                                                                                    | Gate                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `SendToUser`                                                                                                                                   | The only voice to the user in chat: `text` / `attachment` / `widget` / secret-request / cursor-agent payloads | parent chat path                                                   |
| `DraftExternalMessage`                                                                                                                         | Editable email/Slack composer card the **user** hits Send on                                                  | parent chat path; also `isSubagentRunner` → null                   |
| `SendToAgent`                                                                                                                                  | Fire-and-forget message to another agent or a group channel                                                   | parent chat path                                                   |
| `ReactToMessage`                                                                                                                               | Emoji tapback on a user message address                                                                       | parent chat path                                                   |
| `create_bot_share_json`                                                                                                                        | Stage a bot-template share card                                                                               | `gates.botShare`                                                   |
| `request_box_help`                                                                                                                             | Hand the box desktop to the user for a login / captcha / payment                                              | parent chat path                                                   |
| `request_user_form`                                                                                                                            | In-chat form; the host fills the live browser, no values return to the agent                                  | `gates.userForm`                                                   |
| `offer_team_access` / `offer_slack_connect`                                                                                                    | In-chat cards to share the bot with a team / connect Slack                                                    | `gates.teamAccessCards`, not subagent                              |
| `request_cookie_origin_approval`                                                                                                               | List or request Chrome cookie origins from the user's computer                                                | `gates.agentPromptedCookieSync`                                    |
| `request_virtual_card`                                                                                                                         | Ask the user to authorize a one-time Stripe Link virtual card                                                 | `gates.stripeLink` + connector present                             |
| `FindIMessageChats`, `ChatItems`, `SearchIMessages`, `IMessageActivity`, `FetchIMessageAttachment`, `SendIMessage`, `CheckIMessagePermissions` | Mac Messages.app tools, run against the registered machine                                                    | `gates.messagesTools`, not subagent                                |
| `InstallPlugin`, `AddMcpServer`, `AuthenticateMcpServer`                                                                                       | Connector install and OAuth; present on chat                                                                  | explicitly stripped by `AUTOMATION_PARENT_MEDIATED_MCP_TOOL_NAMES` |

Three shape facts that correct earlier guesses (**host-source**, §4.2):

- **Question widgets are not a tool.** They are a `SendToUser` payload —
  `{"type":"widget","widget":{prompt, helpText?, options[1-6], allowCustom?, dismissOnMoveOn?}}` — and **sending a widget ends
  the turn**. `AskQuestion` exists only as a Cursor IDE protobuf (`aiserver.v1.AskQuestionParams`); `buildTurnTools` never
  registers a standalone `AskQuestion`/`ask_question`.
- **`SendMessage` is not a second tool.** It is a legacy _execution alias_ of `SendToUser`
  (`SAND_LEGACY_SEND_MESSAGE_TOOL_NAME`).
- **`ListAgents` / `ListGroups` are not tools.** They are named in `SendToAgent`'s description but are not registered.
  INFERENCE (GrokBot's): teammate and group ids arrive as prompt sections (`getAgentDirectorySection` / `getChannelsSection`),
  and those sections are **skipped** on parent-mediated automation — so an automation turn has neither the tool nor the
  directory.

**Full `Task` schema**, read live from `GetDynamicTools` (§3.12, unchanged in §4.3). Required `description`, `prompt`. Optional
`model` (a slug from `available_subagent_models`; omit to inherit the parent; not to be passed with `resume`), `resume` (id of a
**finished** subagent to continue — it fails if that subagent is still running), `subagent_type`
(`executor` | `videoReview` | `watchVideo` | `computerUse` | `browserUse`), `file_attachments` (local image/video paths, no count
limit in the schema), `run_in_background` (false blocks until done, true returns and notifies on completion). The slug list is
**injected per turn** as `<available_subagent_models>` and read by the one schema function `createTaskTool`; on an automation
turn it holds **only `sand-automation`**, and GrokBot found no second hard-coded chat list — the live chat list is still
unmeasured. Limits come from elsewhere, not the schema: ~15 MB per video (from `learn-from-demonstration`), **instruction** that
only one `computerUse` may run at a time because the desktop is shared, `browserUse` parallelisable.

## Secrets on disk

Trust-model fact: **all of these are readable by ordinary shell as `box`** (§10), and every agent runs as `box`.

| Path                                                                                                         | Kind                                                                         | Scope                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------- |
| `agent-data/{box,host}-secrets.json`, `webhook-keys.json`, `teach-queue-key.json`, `chrome-cookie-seed.json` | secret stores (mode 600), webhook signing keys, queue key, 50 KB cookie seed | shared                                  |
| `agent-data/connector-secrets/<agent-uuid>/`; `agents/<id>/store.db kv.metadata.blobEncryptionKey`           | per-agent connector credentials; conversation-blob encryption key            | per-agent (2 of 14 have connectors)     |
| `agent-data/{settings,gateway,source-map}.json`, `plugin-skills/cache.json`                                  | host-only store — the `Read` tool refuses them                               | host-guarded **in the tool layer only** |
| `.mcp-auth/*`, `.beeper-mcp-auth/*`; `chrome-profile/Default/{Cookies, Login Data, …}`                       | MCP OAuth token stores; live browser credentials                             | **shared across all 14 agents**         |

Absent: `.ssh`, `.netrc`, any `.env` to depth 4 (§10, §B10). **The `Read` barrier is not a filesystem barrier**: GrokBot read
`plugin-skills/cache.json` and `search-index.db` with python after `Read` refused them (§2.4). INFERENCE: one trusted user, one
trust domain — agent separation is organisational, not enforced.

## Divergences from FrockBot's Fly Sprite design

The parity register below carries the capability comparison; the code-level divergences are worth naming separately.

**The paths are GrokBot's, not Fly's.** `HOME_ROOT = "/home/box"` and `DATA_ROOT = ${HOME_ROOT}/agent-data` are still
hardcoded, and this document is what that code was copying — Fly's own home is `/home/sprite`. Since ADR 0004 they are
declared once in `packages/computer-host-runtime/src/runtime.ts` rather than in `plugin-fly-sprite/src/computer.ts`, because
the on-Sprite layout is shared by the provider and the Computer host; the divergence is unchanged, only its address is.

**The browser is not the distribution's.** GrokBot runs the box's own Chromium; FrockBot downloads Playwright's build and
`start-desktop.sh` runs it through the stable symlink `/home/box/bin/chromium`, because Ubuntu's `chromium` is a snap
transitional package that drags in `snapd` and `systemd` (ADR 0004, "A custom image and a shared snapshot were both checked
first").

**Two divergences recorded here are closed:** the Package allocates one Sprite per **User** (ADR 0012), and every Bot on it
shares one `/home/box/chrome-profile`.

**And one whole layer has no counterpart.** GrokBot's desktop adds `plank`, `picom`, a WebAuthn proxy host,
`sand-egress-tunnel`, `sand-ua-governor.mjs` and `sand-fingerprint-profiles.mjs`; FrockBot has none of them. That is no
longer one open gap: row 34 is now three decisions — routed egress (34a) and WebAuthn proxying (34c) are **declined**, each
with the trigger that would reopen it, and the one piece with value before there are Users, measuring what our own browser
announces itself as, is landed as `box-doctor`'s `browser-identity` check (34b).

## Parity register

`AGENTS.md` names this table the parity register. Each row is one capability FrockBot must match, the GrokBot mechanism,
primary-source evidence, the Package proposed to own it, and status against `docs/architecture.md` today.

| #   | Capability                                                                                                                                            | GrokBot mechanism                                                                                                                                               | Evidence         | FrockBot Package (proposed)                                                                                                                                                                                                                               | Status        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | **Bot model** — identity record: name, description, title, avatar shape/colour, `namedBy`                                                             | `agents/<id>/profile.json`                                                                                                                                      | §2.18            | `plugin-flock`                                                                                                                                                                                                                                            | landed        |
| 2   | Create and edit a Bot from inside a Bot; only provided fields change; no delete tool                                                                  | `CreateAgent{name, description?}`, `UpdateAgent{agent_id, …}`                                                                                                   | §2.12            | `plugin-flock`                                                                                                                                                                                                                                            | landed        |
| 3   | Bot deletion is a user-only permanent UI action; no archive, no hide                                                                                  | sidebar right-click → Delete, removes transcript                                                                                                                | §2A              | `plugin-flock` + settings UI                                                                                                                                                                                                                              | divergent     |
| 4   | Per-Bot settings: `hidden_from_sidebar` (still reachable by palette), `notify_on_updates`                                                             | `update_state settings set` → `settings.json`                                                                                                                   | §2.18            | `plugin-settings`                                                                                                                                                                                                                                         | landed        |
| 5   | Per-Bot avatar set from a file on disk or cleared; self-rename announced, provenance recorded                                                         | `update_state avatar`; `profile.json.namedBy`                                                                                                                   | §2.2, §2.18      | `plugin-flock`                                                                                                                                                                                                                                            | partial       |
| 6   | Export/import a Bot as a shareable template: scrubbed prose, visibility scope, review card                                                            | `export-bot-template` + `create_bot_share_json`; `import-bot-template`                                                                                          | §2.11, §2A       | `plugin-bot-template`                                                                                                                                                                                                                                     | landed        |
| 7   | **Memory** — profile tier: enduring facts, one per line, injected every turn                                                                          | `agents/<id>/memory/profile.md`                                                                                                                                 | §5, §2.2         | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 8   | Log tier: dated monthly file, `- (YYYY-MM-DD) <fact>`, read on demand rather than injected                                                            | `memory/log/YYYY-MM.md`                                                                                                                                         | §2.2, §2.3       | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 9   | Note tier that "fades fast" and is excluded from exports; fact dedupe on write; `forget` by exact text                                                | `tier: note`; `update_state memory write`/`forget`                                                                                                              | §2.2, §2.11      | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 10  | Three write scopes chosen per fact: agent, user, project                                                                                              | `scope: agent\|user\|project`                                                                                                                                   | §2.2             | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 11  | User memory sharded per writing Bot so every file has one writer; shards readable by all, writable by their owner only                                | `user-memory/by-agent/<uuid>/{profile.md,log/}`; _"Never edit another assistant's shard"_                                                                       | §2.3, §4.1a      | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 11b | Correcting another Bot's shared fact = writing the correction into your own shard; newest wins, nothing edited in place                               | injected user-memory instruction                                                                                                                                | §4.1a            | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 11c | Shared facts attributed to the Bot that learned them, in the injected line itself                                                                     | `- (learned YYYY-MM-DD) [via <assistant>] <fact>`; `[via …]` omitted when empty                                                                                 | §4.1b            | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 12  | Precedence: own > project > user-memory; newest write wins on conflict                                                                                | injected: _"prefer your OWN memory first, then project memory, then user memory — the most specific wins"_                                                      | §2.3, §4.1a      | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 13  | Project memory tier: an opt-in third scope, per-Bot shards, only joined projects load, membership by create/join/leave                                | `update_state project create\|join\|leave`; `projects/<slug>/memory/by-agent/<id>/` (**absent on disk**)                                                        | §2.2, §B5, §4.1a | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 13b | An injection cap on the shared tiers: at most 3 projects, per-tier profile/recent limits and char budgets, per-fact clamp                             | `MEMORY_PROJECT_INJECTED_CAP`=3; own `recall(30)`/4000/500; user 50/15; project 25/10                                                                           | §4.1b            | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 13c | The rendered Memory block is frozen per compaction epoch and reused, with an env-var escape hatch                                                     | `resolveFrozenMemoryPrompt`, `compactionEpoch`, `SAND_DISABLE_MEMORY_FREEZE=1`                                                                                  | §4.1b            | `plugin-memory` + kernel session log                                                                                                                                                                                                                      | declined      |
| 13d | Distinct on-disk and injected fact formats; `[note]`/`[episode]` as a prefix on the fact text                                                         | disk `- (YYYY-MM-DD) …` vs injected `- (learned YYYY-MM-DD) …`                                                                                                  | §4.1b            | `plugin-memory`                                                                                                                                                                                                                                           | landed        |
| 14  | Exactly what memory was injected is recorded per turn; memory mutated only through one tool                                                           | `store.db kv.*PromptSnapshot`; `update_state` (advisory — files stay writable)                                                                                  | §2.5             | kernel session log                                                                                                                                                                                                                                        | landed        |
| 15  | **Routines** — per-Bot definition file (name, prompt, trigger, enabled, provenance, timestamps) and durable run log                                   | `automations/<slug>/{automation.json,runs.json}`                                                                                                                | §2.6             | new `plugin-routines`                                                                                                                                                                                                                                     | landed        |
| 16  | Cron triggers with timezone and `@daily` shorthands; inbound webhook with its own signing-key store                                                   | `trigger.type=cron`/`webhook`; `webhook-keys.json`                                                                                                              | §2.6             | `plugin-routines`                                                                                                                                                                                                                                         | landed        |
| 17  | Integration triggers (slack, github, origin, teams, linear, sentry, pagerduty), `group`, manual run                                                   | typed trigger schemas; `runs.json trigger:"manual"`                                                                                                             | §2.6             | per-integration Packages                                                                                                                                                                                                                                  | partial       |
| 18  | A firing runs as a fresh subagent turn under the same Bot id; runs of _different_ Bots overlap, same-routine runs are sequential                      | "fresh subagent with the same work capabilities as the parent"; overlapping `runs.json` windows, no lock found                                                  | §2.7, §3.1       | kernel Turn admission                                                                                                                                                                                                                                     | landed        |
| 19  | A routine run cannot speak to the user, lands silently in a parent inbox; pause/resume/delete/edit with a card                                        | `automation_completion_inbox`; `update_state routine`                                                                                                           | §2.5, §2.7       | `plugin-routines`                                                                                                                                                                                                                                         | partial       |
| 19b | A run finishing against a sleeping parent queues a pending wake the host replays, rather than dropping the result                                     | `host-pending-wakes.json` `kind:"subagent"`, `quietOrigin.automation`, `automationRunUuid`                                                                      | §3.2             | kernel Turn admission                                                                                                                                                                                                                                     | landed        |
| 20  | **Skills** — folder + `SKILL.md`, frontmatter `name`/`description`, markdown body, Bot-authorable                                                     | `workflows/<slug>/SKILL.md`; `update_state skill write`                                                                                                         | §2.2, §2.8       | new `plugin-skills`                                                                                                                                                                                                                                       | landed        |
| 21  | User skills global across a user's Bots; managed skills read-only; plugin-borne skills indexed not copied                                             | `workflows/`; `managed-skills/`; `plugin-skills/cache.json`                                                                                                     | §2.9             | `plugin-skills`                                                                                                                                                                                                                                           | landed        |
| 22  | Catalog of path + description injected each turn; bodies read on demand; `/` or `@` invocation                                                        | the `<agent_skills>` block                                                                                                                                      | §2.8             | `plugin-skills` + WebUI                                                                                                                                                                                                                                   | landed        |
| 23  | **Computer** — one persistent Linux computer per user shared by all Bots, per-Bot durable roots, shared scratch                                       | one container, 14 agents; `agent-data/agents/<uuid>/` vs `/workspace`                                                                                           | §B8, §A1         | `plugin-computer` + provider; `/workspace` scratch                                                                                                                                                                                                        | done          |
| 24  | Desktops allocated on demand, not one per Bot: own display, VNC/noVNC route, owner token, exec port                                                   | 7 live displays for 14 agents; `sand-window-router.mjs` `14000 + display`, `:1` primary                                                                         | §C12, §3.8       | `plugin-fly-sprite`                                                                                                                                                                                                                                       | partial       |
| 25  | Screenshot of the Bot's own desktop; human takeover for a login or captcha                                                                            | native `Screenshot`; `request_box_help`                                                                                                                         | §16, §2A         | `computer_screenshot`; `plugin-fly-sprite` lease                                                                                                                                                                                                          | landed        |
| 26  | "Update Computer" (fresh instance, keep files+logins, lose packages) and "Reset" (snapshot restore)                                                   | settings `update-computer` two-click confirm; `reset-computer`                                                                                                  | §2A, §9          | `plugin-computer`                                                                                                                                                                                                                                         | not started   |
| 26b | **Durability** — snapshot-out-only sync of the per-Bot state DBs on a debounce + tick, control files excluded                                         | `box-store-sync`: 120 s tick, 5 s DB debounce, 15 min Chrome, `AGENT_STORE_DB_BASENAMES`, `box-store-sync.lock`                                                 | §3.3             | `plugin-computer`                                                                                                                                                                                                                                         | partial       |
| 27  | A self-check the Bot runs and reads a log from, plus in-box reference docs it reads to debug itself and the UI                                        | `box-doctor` + `/tmp/box-doctor.log`; `reference/*.md`                                                                                                          | §2A              | `computer_doctor`; versioned `reference/`                                                                                                                                                                                                                 | done          |
| 28  | Two interchangeable computer runtimes behind one tool surface                                                                                         | local Docker (dev) vs brokered anyrun pod (default)                                                                                                             | §2A              | Computer interface                                                                                                                                                                                                                                        | partial       |
| 29  | Long-running commands run in background and outlive the turn                                                                                          | background `Shell`, "don't poll"                                                                                                                                | §2.17            | `computer_exec{background}`                                                                                                                                                                                                                               | landed        |
| 30  | Every shell command audited with turn id and target; memory writes and routine edits are **not** audited                                              | `audit.jsonl` `type=shell_command` only, `target: box\|user_machine`                                                                                            | §2.5, §3.4       | `plugin-audit`                                                                                                                                                                                                                                            | landed        |
| 30b | A separate host-bound audit outbox covering shell, browser navigation and MCP tool calls                                                              | `agents/audit-outbox.json` `action.kind`: `shellCommand` 934 / `browserNavigation` 98 / `mcpToolCall` 4                                                         | §3.4             | `plugin-audit`                                                                                                                                                                                                                                            | landed        |
| 31  | **Browser** — one profile shared by all of a user's Bots                                                                                              | `/home/box/chrome-profile`                                                                                                                                      | §B6              | `plugin-fly-sprite`                                                                                                                                                                                                                                       | landed        |
| 32  | Cookies and logins survive computer replacement; seeding, periodic capture, cross-window mirroring, import                                            | `sand-cookie-persist.mjs` (5 s → `chrome-cookie-seed.json`), `sand-session-sync.mjs` (1.5 s CDP), `chrome-cookie-import`                                        | §A3, §2A, §3.3   | `plugin-computer`                                                                                                                                                                                                                                         | not started   |
| 33  | A launcher that enforces correct browser flags; GUI never driven from the shell                                                                       | `box-chrome`; no `xdotool`/CDP from `Shell`                                                                                                                     | §B9, §2A         | `frockbot-chrome`; exec denylist + PATH shims                                                                                                                                                                                                             | done          |
| 34a | Egress routed through the User's desktop                                                                                                              | settings `egress`, `sand-egress-tunnel`                                                                                                                         | §A3              | none — declined                                                                                                                                                                                                                                           | declined      |
| 34b | UA / fingerprint governance                                                                                                                           | `sand-ua-governor.mjs`, `sand-fingerprint-profiles.mjs`                                                                                                         | §A3              | `computer-host-runtime` (`box-doctor`'s `browser-identity` check); per-site profiles declined                                                                                                                                                             | partial       |
| 34c | WebAuthn proxying to the User's authenticator                                                                                                         | `sand-webauthn-proxy-host`, `.sand-webauthn-proxy-enabled`                                                                                                      | §A3              | none — declined                                                                                                                                                                                                                                           | declined      |
| 35  | **Channels** — Bot-to-Bot group chats, 1–6 members, in the sidebar, posted into by id                                                                 | `CreateChannel`/`UpdateChannel`; `SendToAgent`                                                                                                                  | §2.14            | `plugin-channels`: records, membership and the message log in the User DO; `channel_manage`; sidebar list, group thread with per-sender avatars and tapback chips, and per-Channel unread                                                                 | landed        |
| 36  | External channel connectors (Telegram etc.) connected and disconnected per Bot                                                                        | info-pane Channels; `update_state channel disconnect{platform}`                                                                                                 | §2.14, §2A       | `plugin-telegram` (`telegram-bot` Connection Type) over a `ChannelConnector` seam in `plugin-channels`: signed per-Channel webhook, outbound by lease, `channel_manage disconnect`, and a WebUI connect/disconnect surface showing the Connection's label | landed        |
| 37  | **Subagents** — typed roles: executor, browserUse, computerUse, watchVideo, videoReview                                                               | `Task{description, prompt, subagent_type, model?, resume?, file_attachments?, run_in_background?}`                                                              | §2.15, §3.12     | `plugin-subagents` `Task` + role ceilings (ADR 0017)                                                                                                                                                                                                      | landed        |
| 38  | Subagents start blank; background by default; check, message, stop, resume by id; the model set varies by turn type                                   | `Check`/`Message`/`StopSubagent`, `resume=<id>`; `available_subagent_models` = `sand-automation` only on automation turns                                       | §2.15, §3.12     | `plugin-subagents` `task_check`/`task_message`/`task_stop`/`task_resume`                                                                                                                                                                                  | landed        |
| 39  | Only one desktop-GUI subagent at a time, because the screen is shared                                                                                 | `computerUse` serialization                                                                                                                                     | §2.15            | Computer host `control` `desktop-gui` lease, per User                                                                                                                                                                                                     | landed        |
| 40  | Child → parent handoff that ends the child's turn                                                                                                     | `WakeParent{message}`; parent = the same Bot's visible conversation                                                                                             | §2.13            | `plugin-shell` + kernel Turn admission                                                                                                                                                                                                                    | partial       |
| 41  | **Connectors / MCP** — plugin = marketplace bundle of MCP connectors ± skills, stable numeric id                                                      | `plugins/cache/…/.cursor-plugin/plugin.json`                                                                                                                    | §2.10            | `catalog-core` + `plugin-settings` + `plugin-mcp`                                                                                                                                                                                                         | partial       |
| 42  | Plugin discovery, fetch, install state and uninstall over a 296-plugin catalog; plugins are user-scoped                                               | `SearchPlugins`/`GetPlugin`/`UninstallPlugin`; `installed=yes (user)`                                                                                           | §2.10            | `catalog-core` + `plugin-settings`                                                                                                                                                                                                                        | partial       |
| 43  | Multi-account connectors with per-account labels; MCP lifecycle (status, restart, rename, instructions)                                               | Gmail/Calendar/Drive ×5; `GetMcpServerStatus`, `SetMcpInstructions`                                                                                             | §16, §17         | `connection-core` + `plugin-mcp` (servers, tools, status, restart, instructions, rename, `mcp-remote-oauth` grant driver)                                                                                                                                 | partial       |
| 44  | Custom (non-marketplace) stdio MCP servers, which cannot ship in a template                                                                           | `user-beeper`, `user-beeper-desktop`                                                                                                                            | §2.10            | `plugin-mcp` (stdio deferred: refused durably as `unsupported-transport`)                                                                                                                                                                                 | deferred      |
| 45  | Per-Bot connector credential store                                                                                                                    | `connector-secrets/<agent-uuid>/`                                                                                                                               | §10              | `plugin-credentials`                                                                                                                                                                                                                                      | partial       |
| 46  | Repo work delegated to a cloud coding agent; repos never cloned onto the computer                                                                     | `CloudAgent`                                                                                                                                                    | §2.17, §14       | new Package                                                                                                                                                                                                                                               | not started   |
| 47  | Web search, web fetch and image generation as first-class tools                                                                                       | `WebSearch`, `WebFetch`, `GenerateImage`                                                                                                                        | §17              | `plugin-web` + `plugin-provider-ollama-cloud` + `plugin-image`                                                                                                                                                                                            | landed        |
| 48  | **Registered machine** — registry of the user's own machines with live connected state                                                                | `ListMachines` → `{machineId, label, connected}`                                                                                                                | §2.16            | `plugin-user-machine`: User-DO registry, pairing/enroll/poll/claim/result routes, `machine_list`, desktop agent, settings section                                                                                                                         | landed        |
| 49  | Shell/Read/AwaitShell targeted at a machine by id with local-exec approval; copy files both ways                                                      | `machineId`; `CopyToBox`/`CopyFromBox`                                                                                                                          | §2.16, §2A       | `plugin-user-machine`: `machine_exec`/`machine_read`/`machine_copy_*`/`machine_command_check`, per-call approval, `machine:<id>` audit — chat turns only, and `copy_from_computer` refuses (protocol v1 carries no Workspace bytes)                       | partial       |
| 50  | **UI** — settings tabs with per-row deep links the agent may cite but never invent                                                                    | `grokbot://app/v1/settings?id=<anchor>`                                                                                                                         | §2A              | `plugin-shell/settings-links` + `plugin-settings`                                                                                                                                                                                                         | landed        |
| 51  | Per-Bot info pane: live computer preview + routines + channels + members                                                                              | chat header / `Cmd+Shift+I`                                                                                                                                     | §2A              | `plugin-settings` surface + `plugin-computer` / `plugin-routines` / `plugin-channels` slots; the Channels thread carries the members strip                                                                                                                | partial       |
| 52  | Search across every Bot's transcript and media (the agent gets no tool over it)                                                                       | `search-index.db` `messages` / `media`                                                                                                                          | §2.4             | new `plugin-search`                                                                                                                                                                                                                                       | partial       |
| 53  | Approval cards for the Bot's own risky actions (Auto-review)                                                                                          | harness "when your own action needs approval"                                                                                                                   | §2.17            | `plugin-shell` (card, record, decision, expiry) + WebUI                                                                                                                                                                                                   | partial       |
| 54  | **Learn from demonstration** — a screen recording becomes a user-global skill, then the video is deleted                                              | `learn-from-demonstration`: teach queue → `session.json` → `watchVideo` → `update_state skill write`                                                            | §3.9             | `plugin-skills` + capture UI                                                                                                                                                                                                                              | not started   |
| 55  | Guided connector install: catalog → setup fields → confirm widget → host-authored connect card → raw-MCP fallback                                     | `add-connector`: `SearchPlugins`/`GetPlugin`/`InstallPlugin{values}`/`AddMcpServer`/`SetMcpInstructions`                                                        | §3.10            | `catalog-core` + `plugin-settings` + `plugin-mcp` (setup fields → install values → host-authored connect card; no confirm widget)                                                                                                                         | partial       |
| 56  | Per-Bot unread and notification state, so a silent completion still surfaces to the user                                                              | `kv.unreadState` (`lastActivityAt`/`lastViewedAt`/`unreadCount`/`isManuallyUnread`); `notifyOnAgentUpdates`                                                     | §3.2             | `plugin-shell` + `plugin-flock` + WebUI                                                                                                                                                                                                                   | landed        |
| 57  | The tool catalog is trimmed per turn type; user-facing tools exist only on chat turns, work tools on both                                             | `buildTurnTools` + `isParentMediatedAutomationSubagent`/`isSubagentRunner`; per-tool `gates.*` feature flags                                                    | §3.11, §4.2      | kernel Turn admission                                                                                                                                                                                                                                     | partial       |
| 57b | One user-facing send tool carrying typed payloads (text, attachment, widget, secret request, agent card, connect card, approval), with a legacy alias | `SendToUser`; `SendMessage` = `SAND_LEGACY_SEND_MESSAGE_TOOL_NAME` alias                                                                                        | §4.2             | `plugin-shell` + kernel Turn admission                                                                                                                                                                                                                    | partial       |
| 57c | A question widget is a send payload, not a tool, and sending one ends the turn                                                                        | `{type:"widget",widget:{prompt,helpText?,options[1-6],allowCustom?,dismissOnMoveOn?}}`                                                                          | §4.2             | `plugin-shell` + kernel Turn                                                                                                                                                                                                                              | partial       |
| 57d | Human takeover of the Bot's desktop for a login, captcha or payment                                                                                   | `request_box_help` (chat-only)                                                                                                                                  | §2A, §4.2        | `plugin-fly-sprite` lease + WebUI                                                                                                                                                                                                                         | not started   |
| 57e | Bot drafts an outbound external message; the user reviews and sends it from a composer card                                                           | `DraftExternalMessage` (chat-only, also null for subagent runners)                                                                                              | §4.2             | per-platform Package + WebUI                                                                                                                                                                                                                              | not started   |
| 57f | Bot-to-Bot messaging and emoji tapbacks as chat-turn tools; teammate/group directories arrive as prompt sections, not tools                           | `SendToAgent`, `ReactToMessage`; `getAgentDirectorySection`/`getChannelsSection` (INFERENCE)                                                                    | §4.2             | `plugin-channels`: `send_to_agent`/`react_to_message` on `["chat","channel"]`; both directories are prompt sections                                                                                                                                       | landed        |
| 57g | Messages.app tools on the registered Mac behind a feature gate and a permission check                                                                 | `FindIMessageChats`/`ChatItems`/`SearchIMessages`/`IMessageActivity`/`FetchIMessageAttachment`/`SendIMessage`/`CheckIMessagePermissions`, `gates.messagesTools` | §4.2             | `plugin-machine-messages` (7 tools, `machines.messagesEnabled`) + `plugin-user-machine` transport + macOS handlers in `apps/desktop`                                                                                                                      | landed        |
| 57h | Bot asks the user to authorize a one-time virtual payment card, gated on the payment connector                                                        | `request_virtual_card`, `gates.stripeLink` + connector present                                                                                                  | §4.2             | new Package                                                                                                                                                                                                                                               | not started   |
| 58  | **Beyond parity** — deployment-wide signup admission policy and owner-only administration                                                             | not present in GrokBot                                                                                                                                          | FrockBot product | `plugin-admin` + singleton `DeploymentPolicy` Durable Object                                                                                                                                                                                              | beyond parity |

**Status `declined`** means FrockBot deliberately does not copy the row, and the
row itself carries why. Row 13c is the precedent: GrokBot freezes the rendered
Memory block per compaction epoch and reuses it, which is its own best
explanation for the injection divergence in §3.6 — own profile facts on disk
while the injected block said "No facts recorded yet". `plugin-memory` renders
fresh every Turn and records exactly what it injected instead. The reasoning is
in `docs/plans/slice-2.md` Step 3. Rows 34a and 34c are the other two, each with
a named revisit trigger below: a decline is a decision on the record, and the
trigger is what would make it wrong.
**Status `partial`** means some of the row exists at HEAD. What is missing, for
the rows whose status the code moved:

- **58** — **beyond parity.** Because the deployment's default model can incur a cost on every Turn, first-time identities are refused while the deployment signup policy is closed. Existing Users, deployment admins, and local development identities remain admitted. `plugin-admin` supplies the owner-only policy routes and overlay; the singleton `DeploymentPolicy` Durable Object owns the closed-by-default record and optimistic revision. This is FrockBot product policy, not a GrokBot capability being copied.

- **2** — landed. `bot_update` and `bot_create` are runtime tools the Flock
  Package contributes (`plugin-flock/src/agent.ts`), mounted only for an
  admitted Turn whose Session and Turn the write can name
  (`plugin-shell/src/backend-flock.ts`). `bot_update` is a true partial update:
  it takes `name`, `description`, `title`, `hidden_from_sidebar` and
  `notify_on_updates`, changes only the fields the call carries, and writes
  nothing at all when the durable record already holds them. A self-rename goes
  through `bot/set-profile` with `namedBy: "bot"` and a `writer` naming the Bot,
  Session and Turn, so the `bot/renamed` announcement carries its provenance.
  **There is no delete tool**, matching GrokBot: `bot_update` cannot archive,
  restore or remove anything, and no third tool does.

  Two deliberate narrowings. GrokBot's `UpdateAgent` cannot _clear_ a field;
  FrockBot's can, with the empty string, because `bot/set-profile` already
  defines that and refusing it would leave a Bot able to set a title it could
  never take back. And `bot_create` takes no `model`: giving the new Bot the
  caller's model would mean writing a `bot/select-model` and a Capability
  Assignment onto another Bot, and "self-modification never widens authority" —
  the new Bot is registered exactly as the sidebar registers one, with no
  Assignments and no model of its own, and follows its User's default model.

- **3** — **`divergent`, deliberately.** FrockBot ships reversible archive and
  restore (`bot/archive`, `bot/restore` in `plugin-flock/src/shared.ts`, the
  saga in `user.ts` and `bot.ts`, ADR 0006) where GrokBot has a permanent
  user-only delete and no archive or hide. The two states GrokBot lacks are both
  present here and are distinct: archive stops a Bot working, while
  `hidden_from_sidebar` (row 4) only takes it out of the list. Nothing deletes a
  Bot, so this row will not reach `landed` without a decision to add permanent
  deletion.

  The half of the row that _is_ matched is the tool surface (row 2): archive and
  restore are User commands over the Flock's HTTP routes and its client, and no
  Bot-callable tool reaches either. A Bot may hide itself and rename itself; it
  cannot archive itself, restore itself, or remove any Bot.

- **4** — landed, with one shape difference: GrokBot keeps a hidden Bot
  reachable through a command palette, and FrockBot has no palette, so the Flock
  sidebar grows a "Show N hidden" group instead (`FlockSidebar.vue`). The
  durable field is `BotProfile.hiddenFromSidebar`, beside — not inside — the
  notification policy, because it describes how the Bot presents itself rather
  than when it notifies.
- **5** — the avatar half is landed: an uploaded PNG, JPEG, WebP, GIF or SVG up
  to 5 MB is set through `POST /api/bots/:id/avatar`, served back from
  `GET /api/bots/:id/avatar`, and cleared by setting the avatar back to the
  sheep; the provenance is recorded in `BotProfile.namedBy` and a rename appends
  a durable `bot/renamed` Session event the WebUI renders as a system line. The
  self-rename is landed too: `bot_update` (row 2) issues the command with
  `namedBy: "bot"` and a `writer` naming the Bot, Session and Turn, and the
  `bot/renamed` event carries both.

  What is still missing is the _file_ half. GrokBot's `update_state avatar` takes
  a path on the box; FrockBot's avatar arrives as bytes over
  `POST /api/bots/:id/avatar`, which only a client can call, so a Bot cannot set
  its own avatar from a file it wrote on its Computer. **TODO:** that needs a
  Computer-dependent read — the Bot names a path, the Computer provider reads the
  bytes and hands them to the same content-addressed upload — and it is therefore
  blocked on the Computer rows (23–28) being exercised against a live Sprite. It
  is deliberately out of scope for the self-management slice, whose tools
  function while the Computer is hibernated.

- **6** — landed, with the departures recorded in ADR 0015 rather than here.
  `BotTemplateV1` matches GrokBot's share document section for section except
  that **`memory[]` does not exist**: a template crosses to a stranger and
  there is no scrub that makes a User's remembered facts safe, so
  `decodeBotTemplateV1` refuses a document carrying `memory` and the export
  path never reads a Memory root. A marketplace `pluginId` becomes
  `packageId` + `catalogId` + `version` resolved against the importing User's
  own pinned Catalog generation, and visibility is a User click on a revocable
  share record rather than a tool argument, because publication beyond the
  authoring User is a User act. Export is `bot_export_template` staging at
  `visibility: "private"` and reporting an `agent-card`; import is a review
  card the User confirms before anything is written
  (`plugin-bot-template/src/{scrub,import}.ts`, `BotTemplateImportSection.vue`).
- **7** — landed. `profile.md` per shard (`plugin-memory/src/roots.ts`) is
  read and rendered on every Turn by `renderMemoryPromptV1`
  (`plugin-memory/src/render.ts`) under GrokBot's own caps — own 200/30,
  user 50/15, project 25/10 — in GrokBot's injection order (user → project →
  own) with its precedence running the other way, and exactly what was injected
  is recorded as `memory/injected` (row 14). The one departure is deliberate and
  is row 13c: FrockBot renders fresh every Turn rather than reusing a block
  frozen per compaction epoch, which is why this row and 13c disagree on
  purpose. There is nothing outstanding, so the earlier unexplained `partial`
  was the register lagging its own code.
- **9** — **`landed`, with the fade's one invented number stated.** The note
  tier is accepted and stored (`[note] ` prefix into the monthly log,
  `plugin-memory/src/agent.ts`), dedupe-on-write and forget-by-exact-text are
  landed and tested, and the export half of the row is satisfied from the other
  direction: a Bot template carries no Memory at all (ADR 0015,
  `plugin-bot-template/src/scrub.ts` adds `memory` to the omissions
  unconditionally and never reads a Memory root), so a note cannot leak into an
  export because nothing can. The fade is now real: `MEMORY_NOTE_TTL_DAYS = 14`
  in `plugin-memory/src/render.ts`, applied at **render time and purely** —
  a marked fact older than the Turn's `noteCutoff` is dropped before any cap,
  so a faded note never occupies a slot a live fact could have used, and the
  cutoff, the TTL and a per-scope `faded[]` count are written into
  `memory/injected` so a replayed Turn renders the same block. Nothing is
  mutated or deleted: a faded note is still on disk, still greppable, still
  searchable and still forgettable, which is the strongest reading of "fades
  fast" that does not throw away a User's data. The fortnight is **FrockBot's
  number, not GrokBot's** — the research records "fades fast" and no duration
  anywhere (§2.2) — and it is one constant in one file for that reason.
  `forget` matches the marker-stripped body, so a User can forget a note
  without retyping a marker they never saw.
- **13d** — **`landed`, with `[episode]` reserved rather than invented.** The
  two formats are distinct and round-trip (`renderMemoryFactLineV1` vs
  `renderInjectedFactLineV1` in `plugin-memory/src/facts.ts`), and the marker
  is no longer opaque text: `MEMORY_MARKERS_V1` is one vocabulary that the
  writer, the parser, the renderer, the fade and `forget` all share, the disk
  bytes are unchanged from before it existed, and an unrecognised bracket
  prefix (`[forgotten] `, a `[todo] ` a User typed) is deliberately **not** a
  marker. The injected line is `- (learned <date>) [via <bot>] [note] <fact>`,
  the order derived from §4.1b putting `[via …]` before the fact text and the
  marker on it. `[episode]` is **parsed and reserved but never produced**:
  FrockBot has no episodic summariser, and GrokBot exposes no episode tier
  either (§2.2), so inventing a `memory_write` tier to close the row would be
  inventing product surface. A parsed `[episode]` fades on the note's rule, so
  a summariser that ever lands writes the marker and nothing else changes.
- **15** — landed. `RoutineRecordV1` in the Bot Durable Object
  (`plugin-routines/src/records.ts`, keys in `storage-keys.ts`) carries name,
  prompt, schedule XOR webhook trigger, timezone, `enabled`, the writer of the
  creating and the latest write, the timestamps and `lastRunAt`;
  `RoutineScheduler` (`scheduler.ts`) fires it on the Bot Durable Object's one
  alarm and writes a `RoutineRunEntryV1` on the firing and again on its
  settlement, with the status taken from the durable run. A webhook Routine
  reaches the same log through the delivery door (`hook.ts`, `backend.ts`).
  GrokBot keeps the definition in a per-Bot file and the key in a separate
  mode-600 store; FrockBot keeps both in the Bot Durable Object, and the key
  only as a digest.
- **16** — landed. Cron: five-field expressions evaluated in an IANA zone by
  `croner`, the `CRON_TZ=` prefix, the `@hourly`/`@daily`/`@weekly`/`@monthly`
  aliases and `@every <duration>`, validated at write time and evaluated by the
  scheduler (`plugin-routines/src/cron.ts`, tested across two daylight-saving
  boundaries). Webhook: `POST /api/bots/:botId/routines/:routineId/hook` on the
  gateway's pre-auth `publicRoute`, whose key is a self-describing token signed
  with `ROUTINE_HOOK_SECRET` and verified in constant time before any Durable
  Object is addressed, then re-checked against the authoritative
  `routine-key:<routineId>` digest and version inside the Bot. GrokBot's
  `webhook-keys.json` becomes that durable digest record: minted on create,
  rotatable, revocable, and never readable twice.
- **17** — `manual` and `webhook` are landed; `manual` as `routine/run` and the
  tool's `run_now` action, `webhook` as the delivery door. Both enqueue a
  durable firing that the alarm drains, and the run log records which.
  `"integration"` is a declared member of `ROUTINE_TRIGGER_KINDS`
  (`plugin-routines/src/records.ts`) and nothing produces one: no connector
  raises a firing, no provider (slack, github, origin, teams, linear, sentry,
  pagerduty) is named anywhere in the Package, and `group` does not exist. The
  enum slot is room left for the row, not the row.
- **18** — landed, including the "fresh subagent" half. A firing is an admitted
  Turn of the same Bot with `turnType: "automation"` and a recorded `origin`,
  run from inside the Bot Durable Object; same-Routine firings are strictly
  sequential behind the `routine-fire:<routineId>` lock — stricter than
  GrokBot, which showed no lock — and runs of different Bots overlap freely,
  because they are separate Durable Objects. Its prompt now starts from an
  empty history plus one pointer line naming the parent conversation
  (`plugin-shell/src/history.ts`), the parent transcript is never copied, and a
  chat Turn's request in turn carries no automation Turn's events. Memory tiers
  stay shared, which is the row's other half of "the same work capabilities as
  the parent".
- **19** — create, update, pause, resume, delete and run-now are landed end to
  end: as versioned Bot commands with durable fingerprinted receipts
  (`plugin-routines/src/store.ts`), as the `routine_manage` tool the Bot calls on
  any turn type (`agent.ts`), and as `RoutinesSection.vue` in the Bot settings
  surface, where "next run" is now the moment the scheduler armed an alarm on, a
  firing appears in the per-Routine run log, and a webhook Routine's delivery URL
  and key are shown once with rotate and revoke beside them. The silent half is
  landed too: an automation Turn is absent from `GET /api/bots/:id/turns` and
  from the run lookup, reachable only through the run log, and a completed
  firing writes a `RoutineInboxEntryV1` in the transaction that settles it —
  `attribution: "Automation: <name>"`, `acknowledged: false` — surfaced by the
  header badge and drawer (`RoutineInboxBadge.vue`) and cleared by an explicit
  acknowledge command. What is still missing is the confirmation **card**:
  a Routine write answers with a receipt the settings surface re-renders, not
  with a card in the conversation, because a Bot-authored write happens on a
  Turn whose only user-facing channel is `send_to_user`.
- **19b** — landed. A firing that calls `wake_parent` writes a
  `PendingBotInputV1` of kind `wake` beside its inbox entry, in the same
  terminal transaction — GrokBot's `quietOrigin.automation` as
  `quiet: { automation: true }`, and the run id in place of
  `automationRunUuid`. It drains at exactly two points: the Bot's next admitted
  chat Turn prefixes it to that Turn's input, durably and idempotently through
  a `routine-drain:<runId>` receipt, and the alarm re-emits its notification
  once for an entry still unread. The queue is bounded at 16 and its record is
  the wider `PendingBotInputV1`; row 53's approval decisions now produce its
  `approval` variant through `enqueuePendingBotInputV1`, inside the caller's own
  transaction — a second producer, never a second queue.
- **21** — all three halves are landed. **Managed** Skills are four
  first-party `SKILL.md` documents compiled into the `plugin-skills` artifact
  (`plugin-skills/src/managed.ts`), mirroring GrokBot's `add-connector`,
  `export-bot-template`, `import-bot-template` and `learn-from-demonstration`;
  they are read-only in the strongest sense — there is no write path to an
  artifact at all, so `skill_write{scope:"managed"}` is refused with GrokBot's
  own wording, "managed skills are not editable this way". **Plugin-borne**
  Skills are an _index_ over the Catalog entries the User has installed
  (`plugin-skills/src/plugin-index.ts`), read at the generation each install
  pinned and never copied into any root, so an uninstall removes them on the
  next Turn with nothing to delete. Both are Package-contributed prompt
  content, not Workspace files, which is why the constitution's rule about
  instruction roots is untouched: the catalog is ordered `bot` → `user` →
  `managed` → `plugin` under `SKILL_CATALOG_CAPS_V1`, every drop recorded as an
  `over-source-cap` refusal in `skill/injected`. The **user-global** root
  landed with ADR 0016 and the matching amendment to the constitution's
  instruction-root sentence: `{ kind: "user-instructions", userId }` is a
  durable root at `users/<id>/skills/`, mounted on the Computer at GrokBot's
  own `agent-data/workflows`. `isLoadableSkillSourceV1` accepts the owning User
  or **any** Bot of that User as its writer and still refuses `first-party`,
  `unattributed`, and another User's root, so a Bot writing there writes under
  authority it already holds. `skill_write{scope:"user"}` records the writing
  Bot's full provenance, the catalog renders it (`by="Bot …"`, the attribution
  GrokBot spells `[via]`) and `skill/injected` records it, and the quota is per
  root (`maxSkillsPerBot` plus `maxSkillsPerUser`). The Skills Package is the
  root's single writer over object storage and the Computer presents it
  read-only — ADR 0013's Memory exception, extended by ADR 0016 — so a shared
  tier needs no shard and no Turn wakes a Computer to read a Skill.
- **22** — the `<agent_skills>` catalog of ref, source and description is injected once
  per Turn, bodies are disclosed on demand through `skill_load`
  (`plugin-skills/src/catalog.ts`, `agent.ts`), and `/` or `@` in the composer
  opens a popover over that catalog (`plugin-shell/src/client/`
  `skill-invocation.ts`, `FrockBotApp.vue`) which attaches a `SkillRefV1` chip
  rather than pasting text. An invoked ref resolves against the Turn's catalog
  at its exact generation, is recorded as `skill/invoked`, and its body is
  expanded into step 1's `model/request`; an unresolvable ref blocks the Turn
  with a reason. `bot`, `user`, `managed` and `plugin` refs all resolve, the
  last of them since row 21's User-global root landed.
- **23** — one Computer per User with per-Bot durable roots is landed and
  checked (`computer-core/src/index.test.ts`,
  `plugin-fly-sprite/src/computer.test.ts`); the shared scratch is not.
  `/workspaces/<bot>` is Bot-private, and the only User-shared thing on the
  Sprite is the browser profile. Since ADR 0004 the Computer is reachable from
  the cloud path rather than only from a local process: the Bot Durable Object
  calls `apps/computer-host` over the `COMPUTER_HOST` service binding and holds
  no Sprites SDK. What keeps the row `partial` is unchanged — no shared
  scratch, and rows 26 and 27 below.
- **24, 25** — a desktop slot, its viewer session, and the human-takeover lease
  are all reachable from a Bot Durable Object (`/v1/computer/viewer`,
  `/v1/computer/control`), which they were not while the provider needed the
  Sprites SDK. **Row 25 is now `landed`**: `computer_screenshot`
  (`plugin-computer/src/agent.ts`) captures the Bot's own desktop through one
  guarded `exec` and writes the PNG back through `ComputerWorkspace.write`, and
  the hosted client has the human-takeover flow the earlier text said it
  lacked — `ComputerCard.vue` renders the noVNC viewer, **Take control**,
  **Release control** and a full-window overlay, and the same card is a section
  of the per-Bot info pane (row 51). What is still absent is the _Bot-initiated_
  ask, `request_box_help`, and that is row 57d rather than this row.

  **Row 24 stays `partial`.** The allocator, the per-tenant display, the
  `websockify` token route and the idle-reclaim rule are all there
  (`apps/computer-host/container/computer.ts`,
  `plugin-fly-sprite/src/computer.ts`), and an exec-only tenant holds its slot
  through a `tenantStamp` refreshed on every guarded command. Nothing has been
  measured against a live Sprite under contention, and there is no
  per-Bot exec port of GrokBot's kind — the host is one port and the tenant is
  a field in the request.

- **28** — the interchangeable seam exists and has two implementations in
  tests, but only one is a Computer: `packages/computer-host-protocol` is the
  one contract, the container is the one runtime behind it, and
  `apps/cloudflare/test/computer-host-fake.ts` is a second implementation of
  the protocol rather than a second Computer runtime. A local Docker runtime
  beside the Sprite is not started.
- **26b** — durability exists, by the opposite mechanism. The durable-root sync
  (`plugin-fly-sprite/src/sync.ts`, called from `plugin-computer/src/agent.ts`)
  is bidirectional, per-file and generation-fenced rather than
  snapshot-out-only, and reconciles on `open`/watcher-signal/`turn-end` rather
  than on a debounce plus tick. Memory roots are pull-only and the watcher
  excludes the control directories, which is the row's exclusion clause. There
  is no state-DB snapshot and no basename list.
- **27** — one in-box reference file is written
  (`/home/box/reference/README.md`, written by the provisioning document in
  `packages/computer-host-runtime/src/runtime.ts`, which is where the on-Sprite
  layout moved after ADR 0004), but there is no self-check the Bot runs and no
  log it is pointed at: nothing in the tree answers to `box-doctor` or any
  other name for one.
- **29** — landed. `computer_exec` grew a background mode that starts a command
  under the tenant's own runtime root and returns without waiting, plus the
  read-back and stop calls that make it usable
  (`plugin-fly-sprite/src/computer.ts`, "starts a command that outlives its
  Turn"). GrokBot's "don't poll" guidance is prompt policy on both sides.
- **33** — **`partial`, upgraded from `not started` after reading the code.**
  A flag-enforcing launcher does exist: `start-desktop.sh`
  (`packages/computer-host-runtime/src/runtime.ts`) is the only thing that
  starts a browser, it starts exactly one, and it fixes the flags —
  `--user-data-dir` at the shared `/home/box/chrome-profile`, the remote
  debugging address pinned to loopback and its port to the tenant's. It runs
  Playwright's own Chromium build through the stable symlink
  `/home/box/bin/chromium` rather than the distribution's, which is a
  divergence in the binary but the same idea as `box-chrome`. Two halves are
  missing: the launcher is not exposed to the Bot under a name it can invoke,
  and **"GUI never driven from the shell" is not enforced** — `computer_exec`
  can reach `DISPLAY` and CDP like any other command, so the rule is a
  convention rather than a control.

- **34a** — **`declined`.** Routing the box's egress through the User's own
  registered machine buys a residential IP, and costs a long-lived proxy
  process inside the Sprite, a client-side tunnel on the User's machine
  (`sprite proxy` "requires a running client-side tunnel"), a second
  long-lived connection to babysit because the Sprite's one HTTP service port
  is already the noVNC gateway, and a reconnect story for a link that dies on
  every pause. It would make a **core** capability — the Bot browsing — depend
  on a native client process being awake, which "core workflows remain
  available without a native client process" forbids unless both paths and the
  switch between them are built. The containment half is already free: Sprites
  govern outbound by a DNS-based allowlist with raw-IP and private-IP egress
  blocked, which is the policy we would otherwise have configured, so no policy
  surface is built over it either. **Revisit trigger: the first real User
  blocked by the Sprite's datacentre IP.** What is preserved cheaply is that
  `CHROMIUM_FLAGS` is one declared list (row 33), so a future `--proxy-server`
  is one line rather than a redesign.
- **34b** — **`partial`, and deliberately scoped to the measurement.**
  GrokBot's posture here is not "hide": the busiest process on its box is
  `sand-web-bot-auth.mjs`, so it runs signed bot identity beside its
  fingerprint governance. What FrockBot lacked was not governance but a fact —
  whether our browser announces itself as a robot was an assumption nobody had
  checked, and it depends on the headful/Xvfb path and the pinned Playwright
  build. `box-doctor` now has a `browser-identity` check
  (`packages/computer-host-runtime/src/runtime.ts`): it asks the browser over
  the tenant's existing CDP port what it presents, records `navigator.userAgent`,
  `navigator.webdriver` and the `userAgentData` brands as one
  `[box-doctor] PASS|FAIL` line and a `browserIdentity` field on the report
  (schema 2), and **fails only on a tell** — a `HeadlessChrome` token or
  `navigator.webdriver` true. A Computer with no browser running measures
  nothing and says so, which is a different fact from a browser with no tells.
  Read-only like every other check, so `computer_doctor` stays exempt from
  recording durable intent. **Declined: the rest.** Per-site rotating
  fingerprint profiles are an arms race with no User to lose, they would make
  the browser's presentation non-deterministic across Turns — which the session
  log would then have to record to stay reconstructable — and they point away
  from the honest-identity half of GrokBot's own posture. If pinning is ever
  warranted the check is the evidence for it, and the fix is one entry in the
  flag list that already exists.
- **34c** — **`declined`.** CDP's WebAuthn domain offers _virtual_
  authenticators, which is the opposite of what this row wants: a virtual
  authenticator is a fake key, not the User's key. A faithful build is a real
  CTAP2 relay — a process on the Sprite intercepting the ceremony, a backend
  relay, an Electron shell with platform WebAuthn access, origin binding that
  survives the hop, a per-ceremony User consent surface, and a durable
  per-User enable — a vertical slice on the order of the takeover-lease work,
  across the trust boundary. It is constitutionally admissible (an assertion is
  origin-scoped and short-lived, so nothing secret comes to rest on the
  Workspace), but it makes a native client load-bearing for a login path, so it
  could only ever be an enhancement with a takeover fallback, which is most of
  the build again. The mitigation is landed: human takeover over noVNC, where
  the User drives the Sprite's own browser and any non-hardware factor —
  password, TOTP, email OTP — completes there. **Takeover genuinely does not
  solve a passkey-only site, and that is the honest cost of this decline.**
  **Revisit trigger: a passkey-only site a real User needs.**

- **41** — the Catalog half is landed and the MCP half is not. A remote,
  versioned Catalog exists (`packages/catalog-core`, the `PACKAGE_CATALOG`
  bucket, the gateway's `/catalog/v1/*` routes), and a Catalog entry already
  carries the fields a connector bundle needs — `servers[]`, `setupFields`,
  `skills[]` — but nothing yet reads them. `plugin-mcp` exists and a server can
  be added by URL, but no Catalog entry installs one: the guided install that
  turns `servers[]` and `setupFields` into a Connection is the missing half.
  `catalogId` is the stable opaque marketplace identity GrokBot's
  numeric `plugin_id` plays, split from the composition identity `packageId`.
  Bundled skills are carried in the entry and not indexed (plan decision 4).
- **42** — discovery, fetch, install state and uninstall are landed over a
  first-party seed catalog whose entries are the compiled-in Packages
  (`scripts/publish-catalog.ts`), and installs are User-scoped as GrokBot's
  are. What is missing is scale and provenance breadth: 22 first-party entries
  against GrokBot's 296, no third-party or Bot-published entry in the index yet
  (ADR 0008 publication writes artifacts, not Catalog rows), and no agent-side
  `SearchPlugins`/`GetPlugin` tools — the Catalog is reachable from the hosted
  Plugins surface only.
- **43** — the MCP half of the lifecycle is landed and the multi-account half
  is not. A server is a Connection with a durable `McpServerRecordV1` beside it
  (`plugin-mcp/src/records.ts`), and GrokBot's whole lifecycle set has a
  counterpart: `GetMcpServerStatus` is `GET /api/mcp/servers`,
  `SetMcpInstructions` and `RestartMcpServers` are `mcp/set-instructions` and
  `mcp/restart`, and `RenameMcpAccount`/`RemoveMcpAccount` are the ordinary
  `connection/update-label` and `connection/disconnect`, which the record
  follows. `needs-auth` and `error` are distinguished as GrokBot distinguishes
  them. What is missing is the _account_ shape of the row: GrokBot's Gmail ×5
  are five accounts of one marketplace connector, and FrockBot has no connector
  to hold them until the guided install of row 55 lands — `allowMultiple` is
  declared, and a User can hold up to sixteen custom servers, but they are
  sixteen separate servers rather than five accounts of one plugin.
- **44** — **`deferred`, with the dependency stated.** `mcp/add-server` with
  `transport: "stdio"` records a durable `unsupported-transport` refusal and
  creates no Connection, so the gap is a visible failure state rather than
  silence. Shipping stdio needs all four of: (1) the computer-host slice —
  a `COMPUTER_HOST` service binding and `POST /v1/computer/exec` carrying stdin
  with NDJSON streaming, since script-over-argv is the current HTTP 431 bug;
  (2) the stdio server registered as a Computer-provider-declared reattachable
  service, since only those may be reattached after a cold pause, with intent
  and effect identifier recorded before spawn; (3) a `/v1/computer/service`
  framing proxy carrying JSON-RPC over the exec stream, because MCP over stdio
  needs a bidirectional pipe the current bounded `exec` does not offer; and
  (4) credentials delivered as an opaque expiring lease through the Computer
  interface, because no secret may live on the Workspace. stdio MCP runs on the
  User's Computer, not the Cloudflare Container host, and one Computer per User
  (ADR 0012) is what makes it User-scoped as GrokBot's is.

**Status `deferred`** means the row is deliberately not attempted yet, its
blocking dependency is named, and the gap is a durable, visible refusal rather
than a silent absence. Row 44 is the only one.

- **47** — landed; all three tools exist. `web_search` is a Connection-backed
  Capability of `plugin-provider-ollama-cloud` (`src/web-search.ts`,
  `POST {apiBaseUrl}/api/web_search`, the same key and the same resolved
  endpoint root as chat) and `web_fetch` is the `plugin-web` Package
  (`src/agent.ts`, `src/ssrf.ts`). Both are work tools on all four turn types,
  both declare `idempotent: true`, and both emit stable JSON into `tool/result`
  rather than prose. `generate_image` is the `plugin-image` Package: it renders
  on the Workers AI binding through `plugin-shell/src/backend-image.ts`
  (`@cf/black-forest-labs/flux-1-schnell` by default, the model readable from
  the Package settings store) and, like `computer_screenshot`, writes its bytes
  into a Package-declared Workspace root and answers with a reference rather
  than with base64 in the session log.

  **No schema parity is claimed, and none is possible.** Row 47 cites §17,
  which is not in this document: no input schema, bound, or error shape was
  ever measured for any of the three. FrockBot's contracts are its own, defined
  from first principles — the web-search DTO and its `WebSearchV1` interface
  live in `@frockbot/plugin-web/contract` so a second provider can satisfy them
  with no kernel diff, and `web_fetch`'s bounds (https only, ≤ 3 re-validated
  redirects, a content-type allow list, a 1 MiB streamed read and ≤ 32 KiB of
  extracted text) are FrockBot's outbound policy, not a copy of GrokBot's.

  `plugin-web/src/ssrf.ts` is also the single outbound classifier
  `plugin-mcp` holds a User-named server URL to, replacing the duplicate copy
  that Package shipped with a note asking for exactly this merge.

  One known limitation, recorded rather than papered over: workerd exposes no
  resolve-then-connect hook, so host classification is exact for IP literals
  and known-internal name shapes and **best-effort against DNS rebinding**.

- **52** — the transcript half is landed and the media half cannot be. A
  User's Durable Object holds a rebuildable index over every one of their Bots'
  transcripts (`packages/plugin-search`), reached through a route and a search
  overlay, and the row's own parenthesis is matched: the agent gets no tool over
  it. `SearchRowKindV1` declares `"media"` beside `user`, `assistant` and
  `tool` and **nothing writes it**, deliberately — FrockBot has no attachment
  concept for a User to have sent, so the schema carries the slot rather than
  changing when one arrives. `computer_screenshot` and `generate_image`
  attachments are Workspace files referenced from a tool result, not indexed
  media, so the row stays `partial` until there is media to find.
- **37** — landed. The five roles exist as a real ceiling, not a label. A
  `Task` names `type` (GrokBot's `subagent_type`), the child Turn is admitted
  with it, and `ToolRegistry.schemas` takes a second coordinate beside the turn
  type — so `browserUse` is offered `computer_browser` and not `computer_exec`,
  `computerUse` is offered the shell, the screen and the browser, and
  `watchVideo`/`videoReview` reach no Computer at all. The role is an opaque
  string to the kernel exactly as a turn type is: the narrowing is _declared_,
  by a tool definition or by a manifest Capability's
  `admission.subagentRoles`, and the registry only intersects the two. It is
  recorded on the durable run, so a child recovered after eviction re-mounts
  the same catalog rather than a wider one.

  Three shape differences from GrokBot's schema, all in the argument names:
  `type` for `subagent_type`, `background` for `run_in_background`, and
  `attachments` for `file_attachments`. The defaults match — `executor`, and
  background `true`. Depth is one by construction rather than by counting: the
  dispatch and lifecycle tools declare `admission.turnTypes: ["chat",
"automation"]`, so a `subagent` Turn is never offered them and there is no
  grandchild to bound.

- **38** — landed. A child starts blank in a Subagent Durable Object of the
  same Bot (ADR 0017): its own Session, none of the parent's transcript or
  memory-of-the-Turn, and a summary — never a transcript — handed back through
  the completion inbox, a pending wake and a notification intent. `task_check`,
  `task_message`, `task_stop` and `task_resume` are the four lifecycle tools;
  `resume` refuses a running task and refuses a `model`, because the resumed
  run continues a Session already pinned to a binding.
  `<available_subagent_models>` renders from the Bot's enabled model
  Assignments and narrows to exactly one slug on an automation or subagent
  Turn, which is GrokBot's `sand-automation`-only rule.

  `task_message` is _delivery_, not queueing: the parent holds the bounded
  queue, and the child claims it on its way into each step of its Turn and
  folds what it gets into that step's inputs, in `seq` order. The claim marks
  what it took in the parent's own transaction, so a step retried after an
  eviction reads the marks back rather than the instruction — the child's
  Session shows each message exactly once. A queue nobody read would have been
  an empty queue, and GrokBot's `MessageSubagent` influences the _running_
  child.

- **39** — landed, at a different home than this register first guessed. The
  lease is not `plugin-fly-sprite`'s: that one is per tenant layout, and the
  desktop is not. One Computer serves all of a User's Bots and there is one
  screen on it, so `computerUse` is serialized at the Computer host's own
  `control` op — already the single writer that serializes human takeover —
  under a new User-wide `desktop-gui` scope keyed against the box rather than
  against a tenant directory. The Bot Durable Object records the intent
  (`task-lease:desktop`) before the host is asked, records the grant on the
  same key, and releases on every path that settles a task: completion,
  failure, `task_stop`, and the deadline reconciliation. A second `computerUse`
  dispatch — including one from another Bot of the same User, which no Bot
  Durable Object can see — is refused with the holder's owner id, which names
  the Bot and the task, so the refusal is something the dispatcher can act on.
  A lapsed lease holds nothing.
- **56** — landed. `UnreadStateV1` under `shell:unread`
  (`plugin-shell/src/unread.ts`) is GrokBot's `kv.unreadState` kept as a pair of
  admission-index cursors rather than a counter, with the count derived on read
  and capped at "99+"; activity advances in the transaction that settles a chat
  Turn, so recovery cannot double-count. Reading is the authenticated
  `bot/mark-read`/`bot/mark-unread` command and never a side effect of a list.
  The sidebar's two bounded fan-outs (`GET /api/bots/unread`,
  `GET /api/bots/notifications`) surface a completion on a Bot nobody is looking
  at, and `notifications.enabled` — GrokBot's `notify_on_updates` — gates the
  intent only, so a muted Bot still goes bold. One shape difference, from row 4:
  a Bot hidden from the sidebar has no row to carry a badge, so its unread rolls
  into one aggregate on the "Show N hidden" entry.
- **51** — the pane exists and assembles three of the four halves. Identity
  (avatar, name, title, label, description, `namedBy` provenance), Members, the
  Computer preview through `frockbot.computer`, a Routines glance through the
  new `frockbot.bot-info-sections` outlet, and the notification toggle all
  render; a Playwright spec opens the pane and asserts every section at 1351px
  and at 390px. What is missing is **Channels**, deferred by an owner decision
  because neither sense of the word exists yet — row 35's Bot-to-Bot group
  chats and row 43's channel connectors are both `not started`. The pane
  carries a labelled, empty Channels section where they will mount, and
  "Members" therefore means the Bot's own identity plus its Capability
  Assignments rather than a roster of a group chat that cannot be created.
  GrokBot's `Cmd+Shift+I` shortcut is not bound; the pane opens from the
  window's Bot actions and from its own deep link.

- **53** — the card mechanism is landed; the policy that decides _which_
  actions need one is not. An `approval` payload on `send_to_user`
  (`{approvalId, action, rationale?, risk, expiresInSeconds?}`) ends the Turn
  the way a widget does, and the Turn's settling transaction writes an
  `ApprovalRecordV1` under `shell:approval:<approvalId>` — the constitution's
  "a request for more becomes a durable pending decision for the User, never a
  grant", as a record rather than a sentence. The decision route records the
  answer first-write-wins and answers a replay with the decision already
  stored; that decision and the `PendingBotInputV1` it owes the Bot are written
  together, so the Bot always learns the outcome. Expiry rides the Bot Durable Object's one alarm (a day by
  default, clamped to five minutes and seven days) and writes the same input.
  The intent is recorded at `critical` whatever `notifications.enabled` says,
  because muting silences chatter and not a question that has stopped the Bot.

  **What is missing is Auto-review itself.** GrokBot's approval is a
  system-prompt section plus a user-global `auto-review` General setting
  (l. 371, 387); FrockBot ships the card and no switch, because the policy that
  decides which actions are risky belongs with the risky tools — Computer,
  machine-targeted Shell — and not in a global toggle nothing yet reads. No
  first-party tool asks for an approval today; a Bot or a Package must send one
  deliberately.

## Open questions for GrokBot

Each needs either a chat turn or a probe GrokBot declined to run from an automation turn.

**Answered by MESSAGE_4.** The chat-turn tool catalog (§4.2 reads `buildTurnTools` directly, chat path included, so the table
above is now registration-complete for first-party tools); the Memory block's structure, precedence, shard layout, fact
formats, caps and freeze (§4.1a–b); and the `Task` schema with its per-turn model-slug injection (§4.3).

Still open:

1. **What is in `available_subagent_models` on a live chat turn?** The slug list is injected per turn and read by the one
   schema function; GrokBot found no second hard-coded list, and only `sand-automation` was ever observed (§4.3).
2. **Do own `profile.md` facts inject on a live chat turn?** They were missing on three independent automation runs while
   sitting on disk (§2.3, §3.6, §4.1a). The renderer is the same function for both paths and GrokBot's INFERENCE is the
   per-`compactionEpoch` freeze (§4.1b) — but no chat-turn Memory block has ever been captured, so freeze-vs-bug is unsettled.
3. **Can a routine fire while the same Bot is mid-chat, and what then?** Cross-agent overlap is observed and same-routine runs
   are sequential, but no lock was found and no chat/routine overlap for one agent was ever seen (§3.1).
4. **Does the box ever suspend or idle-kill?** No evidence either way, and background `Shell` survival across a later wake was
   never probed (§3.8).
5. **What codec does `conversation-blobs.db` use?** The 32-byte `blobEncryptionKey` exists, yet rows are a mix of plaintext JSON
   and binary frames (§3.5). Does Cursor cloud hold a copy of the key?
6. **Does `project create` materialise `agent-data/projects/`?** The target is fully documented, nothing on this box has used
   it, and GrokBot did not call it to find out (§3.7).

# Research: GrokBot's computer, as observed

Primary evidence: GrokBot ("Discovery Bot", agent `23ea47c3-…`) ran every command itself on
2026-08-30/31 and returned the output. `§<n>` cites `MESSAGE_1_RESPONSE.md`; `§<A1|B5|C12|…>` cites
`MESSAGE_1_ATTACHMENT_layout.md`; `§2.<n>` cites `MESSAGE_2_RESPONSE.md` question `<n>`; `§2A` cites
`MESSAGE_2_ATTACHMENT_files.md`. Everything not marked **INFERENCE** is command output or a quote.
GrokBot labels harness-only facts **instruction** — from its injected prompt, not a file it opened;
that label is carried through here.

## Summary

GrokBot's "computer" is not one machine per agent. It is a single long-lived Debian 13 container —
user `box`, `HOME=/home/box` — shared by all fourteen of Tim's Grok Bot agents at once (§B8, §B11).
One overlay filesystem carries `/`, `/home/box`, `/workspace` and `/tmp`, and `/tmp` is not tmpfs
(§A3). Durable agent state lives under `/home/box/agent-data` → `sand-data`, per agent as
`agents/<uuid>/{memory,automations,…}` (§A1). Scratch is the shared `/workspace` (§B7), and Chrome is
a single shared profile — not per agent — so all fourteen bots share one cookie jar and one logged-in
identity (§B6). A `sand-*` supervisor stack runs per-agent virtual desktops (Xvfb + x11vnc + noVNC +
xfwm4 + plank) on separate X displays behind separate `exec-daemon` ports, so "per-agent desktop"
means a separate screen on the same box (§C12). The tool surface is seven native function tools plus
27 Cursor-namespace dynamic tools, five `Task` subagent types, and MCP connectors (§16–§18). Memory,
routines, skills, profile, settings, projects and avatar all mutate through one tool, `update_state`.

## Machine

Debian GNU/Linux 13.6 (trixie), kernel `6.12.94+` x86_64, hostname `cursor`, user `box`, default cwd
`/workspace` (§A1, §A4). `/.dockerenv` is present and PID 1 is `tini` running `/pod-daemon` (§A2) —
but §2A says the shipped default runtime is a _brokered anyrun pod_, not Docker; this box is the
Docker variant. One `overlay` filesystem backs `/`, `/home/box`, `/workspace` and `/tmp` (all `stat`
device `39`); `df -h` shows 126 G total, 5.7 G used; the only tmpfs are `/dev` and `/dev/shm` (§A3).
The container started ~Aug 26 23:32 UTC and was unchanged on Aug 30 (§A2, §C15). ~936 `dpkg` entries
including python 3.13.5, node v20.19.2, git, rg, gh, jq, bun, uv, ffmpeg, pdftotext — while `tree`,
the `docker` CLI and ImageMagick are **absent** (§B9). **Update vs Reset** (§A3, §2A): _"Update Grok
Bot Computer moves the box to a fresh instance while keeping files and logins. Installed software
does not survive the move."_ Reset "restores from the last saved snapshot and can lose recent
unsynced work", and the doc tells the agent never to steer users there (§9).

**Supervisor processes** (`ps aux --sort=-rss`, §C12). No systemd, supervisord, s6 or runit; roles
are INFERENCE from name/argv. PID 1 `tini` → `/pod-daemon` (argv names
`/run/host-services/ssh-auth.sock` and `vsock port 52` — the host↔box control channel);
`sand-host/host-main.cjs` (~547 MB RSS) is the agent host, running turns and owning `sand-data`;
seven `exec-daemon/index.js serve` run commands (one main on `--port 1337 … --computer-use-enabled
--mcp-meta-tool-enabled`, one per desktop on `14003`–`14013`); `sand-supervisor.mjs`,
`sand-window-router.mjs` and per-child `box-bounded-log.mjs` supervise, route and log; four
singletons handle durability and the browser — `sand-session-sync.mjs`, `sand-cookie-persist.mjs`,
`sand-special-treatment-chrome.mjs`, `sand-web-bot-auth.mjs` (226 min CPU, the busiest on the box);
one `Xvfb`/`x11vnc`/`novnc`/`picom`/`xfwm4`/`plank` set runs per display. `/usr/local/bin` launchers
include `start-sand-box`, `start-desktop.sh`, `start-window`, `supervise-*`, `box-chrome`,
`box-doctor`, `sand-egress-tunnel`, `sand-webauthn-proxy-host`.

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

A **first-party** tool (not in the `cursor` namespace). Its descriptor (§2.2) takes a required
`target` — `memory | routine | skill | profile | settings | channel | project | avatar` — and a
required `action` — `write | forget | create | update | pause | resume | delete | set | disconnect |
join | leave | clear`. Disk effects below are **instruction** unless corroborated on disk.

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

- **Three tiers** (**instruction**, §2.2): `profile` = foundational, _"kept in mind every turn"_;
  `log` = dated history, the default tier, monthly `log/YYYY-MM.md` with line format
  `- (YYYY-MM-DD) <fact>` (now OBSERVED on disk after writes); `note` = _"fades fast"_. **Facts are
  deduped** by the host; `forget` matches the exact recorded text.
- **Precedence** (**instruction**, §2.3): _"Own memory beats project beats user-memory"_, and
  _"newest write wins"_ on conflict. Shared user facts are injected under the heading **"About the
  user (shared)"**, each tagged `[via <assistant>]` — GrokBot saw `[via General]` and `[via School]`.
  Other agents' shards are readable on disk; the agent is told not to edit them.
- **The injection reality — OBSERVED DIVERGENCE (§2.3).** On this automation-subagent run the
  injected "Memory" block said _"No facts recorded yet"_ while `memory/profile.md` held two facts and
  `log/2026-08.md` held one. So own-agent profile memory, which the harness claims is kept in mind
  every turn, was **not injected on an automation run**; shared user-memory **was**.
- **The injection text is snapshotted**: `store.db kv.memoryPromptSnapshot` (4451 chars) and
  `agentProfilePromptSnapshot` are rendered copies of what was injected (§2.5). Memory changes only
  via `update_state`, but the files are ordinary readable markdown, so that is a contract, not a
  permission boundary. INFERENCE: a shard is created on first user-scoped write (2 of 14 exist).

## Databases and audit trail

- **`sand-data/search-index.db`** (462 848 B + WAL) — SQLite, **transcripts of all 14 agents**, not
  memory files. Schema as read (§2.4): `agents(agent_id PK, fingerprint NOT NULL)` (14 rows);
  `media(id, agent_id, entry_id, file_name, ext, mime, kind, timestamp_ms, width, height,
UNIQUE(agent_id, entry_id))` (4); `messages(id, agent_id, entry_id, role CHECK user|assistant,
timestamp_ms, body, UNIQUE(agent_id, entry_id))` (958); `meta(key PK, value)` (1 row). **There is
  no search tool over it** — the agent can only SQL it from `Shell`.
- **`agents/<id>/store.db`** (4 KB + 556 KB WAL) — `automation_completion_inbox(seq PK, id UNIQUE,
text, attribution, acknowledged 0|1)`, `blobs(id PK, data BLOB)` (empty), `kv(key PK, value TEXT)`,
  `transcript_entries(seq PK, id UNIQUE, entry TEXT)` (17 rows, kinds `event`, `send-message`). The 8
  `kv` keys: `metadata` (agentId, latestRootBlobId, name, createdAt, `mode: "default"`,
  `isRunEverything`, `blobEncryptionKey` **[redacted]**), `origin`, `unreadState`,
  `agentProfilePromptSnapshot`, `memoryPromptSnapshot`, `requestIds`, `episodePending`,
  `lastTurnSettlement`. Observed inbox row: `automation-subagent:6ee6b077-…`, `acknowledged=1`.
- **`conversation-blobs.db`** — one table `blobs(id TEXT PK, data BLOB)`, 175 blobs / 845 379 B, ids
  look like sha256 hex. INFERENCE (GrokBot's): content-addressed conversation payload store; the real
  message bodies live here because `store.blobs` is empty. Note the `blobEncryptionKey` above.
- **`audit.jsonl`** — 202 lines, **every line `type=shell_command`**, e.g.
  `{"ts":"2026-08-30T22:37:12.433Z","agentId":"23ea47c3-…","eventId":"dd8f6ade-…","turnId":"a0071eb9-…","type":"shell_command","command":"ls -la ~/tmp/messages …","shellKind":"foreground","target":"box"}`
  — every command tied to a turn and to a target (`box` or `user_machine`).

## Routines (automations)

`automations/<slug>/automation.json` is the whole routine definition, and `runs.json` the run log
written by the runtime (§2.6):

```json
{ "name": "New Message",
  "prompt": "When this runs, a new message has been written on Tim's computer … Read PROTOCOL.md …",
  "trigger": { "type": "webhook" },  "triggerPresentation": { "version": 1, "trigger": {…} },
  "enabled": true, "provenance": "user", "createdAt": 1788129330192, "lastRunAt": 1788132190802 }
{ "id": "c84a23b3-…", "requestId": "49c38ee1-…", "trigger": "event", "startedAt": 1788132190804,
  "finishedAt": null, "status": "running", "event": "Webhook POST: \"{\"message\":\"New message …\"" }
```

Observed `trigger` values `event` and `manual`; observed `status` `running` and `ok`. The webhook key
is **not** in `automation.json` — it lives in `sand-data/webhook-keys.json` (mode 600).

**Complete trigger-type list** from the `update_state` descriptor (**instruction**, §2.6); never both
`schedule` and `trigger`. **cron** (5-field, Australia/Sydney, or `@hourly`/`@daily`/`@weekly`/
`@monthly`/`@every …`, optional `CRON_TZ=`); **slack** (channel `#eng`/`@someone`/`*`; match
`mention`|`keyword`|`message`|`reaction`); **github** (one `owner/name`; PR/review/CI events;
optional `pr`, `userAllowlist`, `ciBranch`); **origin** (Cursor Origin repo; CI is PR-only);
**microsoftTeams** (`tenantId` + `teamIds`; optional `channelIds`/`messageContains`); **linear**
(`issueCreated`|`statusChanged`|`endOfCycle`); **sentry** and **pagerduty** (issue/incident lifecycle
events); **webhook**; **group** (any-of over several).

**Firing semantics** (OBSERVED, §2.7). The cue is `[routine] "New Message" (folder new-message) was
triggered by an event…`, then _"You are running an automation as a fresh subagent with the same work
capabilities as the parent agent"_ and _"The parent agent's shared durable memories are available…
Parent transcript pointer: `agent-transcripts/<id>/<id>.jsonl` (not copied into the prompt)"_. So a
routine run is a **fresh subagent turn under the same agent id**, not a turn inside the user's chat.
It cannot mutate the visible transcript or speak to the user; `WakeParent` is the only immediate
route, and its final message is persisted **silently**, arriving later as an
`automation_completion_inbox` row on the parent. Concurrency: **unknown**.

## Skills, workflows, plugins

**Skill format** (§2.8). A skill is a folder containing one `SKILL.md`: YAML frontmatter with `name`
and `description` ("use this when …"), then a markdown recipe body — e.g. `workflows/daily-standup/
SKILL.md` = `---\nname: Daily standup\ndescription: Use this when assembling the weekday standup.\n
---\n# Steps\n1. …`. **Loading**: only the _catalog_ is injected each turn, as `<agent_skills>` with
each skill's `fullPath` + `description`; bodies are not, and the agent is told to Read the `SKILL.md`
when relevant and that _mentioning a skill is not running it_. Users invoke with `/` or `@`.

**Three skill roots** (§2.9). `managed-skills/skills/<slug>/SKILL.md` is Cursor-shipped, read-only,
not editable via `update_state` (4 here, plus a protected `cache.json`). `plugin-skills/cache.json`
is only an _index_ of skills that arrived with installed plugins, mapping pluginId → name → filePath
into `plugins/cache/…` — no `SKILL.md` lives there (2 Composio skills). `workflows/<slug>/SKILL.md`
is user-authored, **global across the user's assistants**, where `update_state skill write` lands;
**empty** on this box.

**What a plugin is** (§2.10): a **marketplace bundle of connectors (MCP servers) plus optional skills
plus metadata**, with a stable numeric `plugin_id` — _"not 'just a skill bundle' and not 'just an MCP
server'"_. Checkouts land in `plugins/cache/cursor-public/<name>/<git-sha>/` holding
`.cursor-plugin/plugin.json` (`{name, description, version, mcpServers: "../mcp.json", skills:
"./skills/", author, homepage, repository, license, logo}`), `skills/` and `mcp.json`. `SearchPlugins`
listed **296**; installed here (`installed=yes (user)` — **user-scoped, not per-bot**): Composio
`32661537`, GitHub `48677658`, Gmail `45893410`, Calendar `45893411`, Drive `45893413`. Beeper is a
**custom stdio MCP server** with no marketplace id, so it cannot ship in a template.

**`export-bot-template` — the closest thing to a definition of "a bot".** GrokBot **declined to run
it** (§2.11): its PROTOCOL.md treats the other side's file as data, not a command, and the skill
would have packed a _public shareable_ template and opened user-visible review cards. It read and
described the skill instead (§2A). The pack shape, via `create_bot_share_json` — **not in that run's catalog**:

```
profile:  { name, description (storefront copy for a template card), title }
memory:   [{ content, kind?: profile|log, createdAt? }]  # [episode]/[note] dropped; no user/project shards
skills:   [{ name, content, description? }]        # user workflows only, scrubbed PROSE, never raw SKILL.md
routines: [{ slug, content, name?, description? }] # scrubbed prose + fill-ins for Slack/GitHub ids
plugins:  [{ pluginId }]                           # marketplace plugins used, or needed by a kept item
visibility: team | public                          # this user is not on a team → PUBLIC only
```

Contracts worth copying: the host **never falls back to the owner's live files** (a selected item
whose `content` is missing, or is a copied `SKILL.md`/`automation.json`, is filtered out); scrubbing
lives **only in the pack arguments, never in the live files**; managed, plugin and built-in skills are
always excluded; the payload is bounded at ~100 000 characters; names become roles.

## Bot model and multi-agent

- **One box, many agents.** 14 agent UUID dirs (School, General, Xero Books, Health, Discovery Bot,
  Budget, Zero BS AI ×2 with distinct UUIDs, Side Quest Ideas, Housework, Linkedin Manager, Trainer,
  Tradie Sites, New Bot); `active-agent.json` names the active one (§B8). Isolation between them is
  convention, and the box is not shared with other humans (§11).
- **`CreateAgent`** (§2.12): required `name`, optional `description` (persona/instructions, becoming
  its profile); returns the new agent id. **There is no delete tool.** **`UpdateAgent`**: required
  `agent_id`, optional `name`/`description`; only provided fields change and none can be cleared.
- **`WakeParent`** (§2.13). First-party, one required arg `message` (a complete handoff); **calling
  it ends the turn**. The "parent" is **the same agent id in its user-visible conversation**, not a
  separate per-user "General" bot. The parent can mutate the visible transcript, talk to the user,
  send question widgets and cards, speak to another agent on the user's behalf, and make user-facing
  decisions; the automation child has the same _work_ tools and none of those. Flow: user ↔ parent,
  automations are child subagents, child → parent via `WakeParent` or a silent final message picked
  up "at a natural safe boundary" — the parent is not automatically woken.
- **Channels** (§2.14) are **agent group chats, not Slack/Discord/Telegram**. `CreateChannel`: `name`
  - `member_ids` (agent ids, 1–6); it appears in the user's sidebar; include your own id to
    participate. `UpdateChannel`: `channel_id` + `add_member_ids`/`remove_member_ids`, only if you are
    a member; a channel cannot be emptied. Posting uses `SendToAgent` with the channel id (named in the
    descriptor, absent from this run's tool list). This agent has none. A _second_ sense of "channel"
    exists: the info pane shows Channels when a **channel connector** (Telegram etc.) is available —
    what `update_state channel disconnect <platform>` acts on. The box carries `telegram-{inbox,
webhook.json,allowlist.json}`, none connected.
- **`Task` subagent types (5)** (§2.15). **None shares the parent's memory or transcript**; each
  result returns to the dispatcher, and a background completion also posts a user-visible summary on
  the parent. `executor` gets the "full work toolset (Shell, box tools, web, MCP, CloudAgent)" and
  **starts blank**, so the dispatch prompt must be self-contained; `browserUse` gets page-level
  Chrome (element refs, no desktop mouse) and the box's persistent logins; `computerUse` drives the
  desktop GUI (1280×800) and **only one may run at a time** because the screen is shared;
  `watchVideo` needs `file_attachments`; `videoReview` reviews artifacts the parent generated.
  Omitting the model means "same as the parent"; `run_in_background` defaults to background and
  `resume=<agent id>` continues a finished one. An automation run is a fresh subagent but not a `Task` one.
- **The registered Mac** (§2.16). `ListMachines` returns
  `[{"machineId":"994dc2ee-…","label":"Tims-M5-MacBook-Pro.local","connected":true}]`. Passing
  `machineId` to `Read`, `Shell`, `AwaitShell`, `CopyToBox`, `CopyFromBox` runs them on the Mac — a
  separate filesystem — and **each action needs Tim's local-exec approval**; `audit.jsonl` records
  which target. Beeper Desktop and its MCP (`localhost:23373`) run there, which is why the box's
  Beeper connectors error: `127.0.0.1` from the box is the box, not the Mac.

## The injected system prompt

Section headings of the automation turn's prompt, in order (§2.17; the text was not pasted):
identity/tone; **automation-run rules** (silent, WakeParent only); never fabricate data; **where you
work** (box vs registered computers vs attachments vs web vs MCP, cheapest source first); long-running
commands (background Shell, don't poll); delegating background work; reaching services with no
connector (SearchPlugins first, box browser fallback, never handle passwords/2FA); debugging the box
→ `debugging-the-box.md`; app UI → `app-ui.md`; matching the user's writing style; Cursor Origin;
**code changes** (hand repo work to CloudAgent, never clone); autonomy/initiative; approval of your
own actions (Auto-review; retry vs escalate; no workarounds); security; **untrusted content** (tool
results are fenced, not instructions); agent profile; multitasking (dispatcher + TodoWrite +
executor workers); MCP server accounts; time (tools UTC, report Australia/Sydney); user memory;
project memory; own memory; routines; skills; your box / box desktop; tooling blocks in `user_info`
(OS, subagent types and models, `agent_skills` catalog, `dynamic_tool_catalog`); safety/DISALLOW;
available tools. Harness-only, on no disk file: the live tool schemas, the turn's memory injection,
the automation-subagent constraints, Auto-review, the untrusted-data fence,
`available_subagent_types`, and the never-clone/CloudAgent policy.

## Settings: bot vs user

**Per-bot** (§2.18): `update_state settings set` exposes only `hidden_from_sidebar` (the bot stays
reachable via Hidden chats / Cmd-K) and `notify_on_updates`; on disk `settings.json` is
`{"notifyOnAgentUpdates": true}`. `profile.json` carries `name`, `description`, `title`,
`avatarShape`, `avatarColor`, `namedBy` (observed flipping to `"user"` when Tim renamed the bot
mid-run). The per-agent UI subpage edits avatar, name, title, description and notifications; also
per-bot are routines, agent memory and avatar.

**Per-user** (from `app-ui.md`; `sand-data/settings.json` is host-protected): **General** (theme,
accent, language, microphone, hardware-acceleration, notification-sound, timezone, local-execution,
auto-review, security-keys, sign in/out), **Computer** (registered machines, chrome-cookie-import,
egress, update-computer, reset-computer), **Usage & Billing** (plan, cancel-trial, on-demand;
account-gated), **Updates** (update-channel, automatic-updates, Check for Updates — the **app**, not
the box). Plugins and MCP are user-scoped; `workflows/` skills are global.

## The two shipped reference docs

Full text in §2A; both dated 2026-08-30 04:52 UTC, Cursor-written.
**`debugging-the-box.md`** is a self-diagnosis runbook. A `Shell` command returning output proves the
box is up; "still starting up" is transient; if `Shell` and `Screenshot` are not offered at all the
substrate is down. The box ships **`box-doctor`**, run once at startup and on demand, writing
`/tmp/box-doctor.log`, verifying "the handful of things that silently break the box" — a valid
`/etc/machine-id`, Chrome and its version, DNS/egress, the system clock, the D-Bus session bus — one
`[box-doctor] PASS|FAIL <name>: <detail>` line per check plus a `SUMMARY`. Desktop triage: the primary
desktop is `:1`; it comes up **with no browser window**, so no Chrome process is normal; tail
`/tmp/{start-desktop,x11vnc:1,novnc:1}.log`; stale X or Chrome locks after a wake are a known cause;
never drive GUI apps from `Shell` with `xdotool` or CDP. **Two runtimes exist** — local Docker (dev)
and a "brokered anyrun pod" (**the shipped default**) — told apart by `/.dockerenv`. The agent
**cannot rebuild the box**: point the user at Update, never Reset; `request_box_help` hands the user
a manual step (a login, a captcha) on a _working_ desktop.

**`app-ui.md`** maps real UI paths with an explicit instruction never to invent others. Settings open
from the bottom-left account button, `Cmd+,`, or the palette — **no gear icon, no macOS Preferences
item**. Deleting an agent is sidebar right-click → Delete: permanent, removes the transcript, with
**no archive or hide**. It enumerates the four tabs and every linkable row anchor
(`grokbot://app/v1/settings?id=<anchor>`), notes rows can be absent per account/build/state, and
makes Update Computer a two-click confirm. The **per-agent info pane** (chat header, or `Cmd+Shift+I`)
shows a live preview of that agent's computer over its Routines list, plus Channels when a channel
connector is available and Members in group chats.

## Tool inventory

**Native function tools (7):** `WakeParent`, `update_state`, `Shell`, `Read`, `Screenshot`,
`GetDynamicTools`, `CallDynamicTool`. **Cursor-namespace dynamic tools (27, via `CallDynamicTool`):**
`AwaitShell`, `CheckSubagent`, `CloudAgent`, `CopyFromBox`, `CopyToBox`, `CreateAgent`,
`CreateChannel`, `GenerateImage`, `GetMcpServerStatus`, `GetPlugin`, `ListMachines`,
`MessageSubagent`, `RemoveMcpAccount`, `RenameMcpAccount`, `RestartMcpServers`, `SearchPlugins`,
`SendFeedback`, `SetMcpInstructions`, `StopSubagent`, `Task`, `TodoWrite`, `UninstallMcpServer`,
`UninstallPlugin`, `UpdateAgent`, `UpdateChannel`, `WebFetch`, `WebSearch`. Named in descriptors but
**absent from the automation run's catalog**: `SendToAgent`, `create_bot_share_json`,
`request_box_help`, `SendToUser` — INFERENCE: the tool surface is trimmed per run type. **MCP** (§16):
Gmail ×5 accounts (31 tools each), Calendar ×5, Drive ×5 connected; GitHub **needsAuth**; Composio
connected; `beeper`/`beeper-desktop` **error**.

## Secrets on disk

Trust-model fact: **all of these are readable by ordinary shell as `box`** (§10), and every agent
runs as `box`.

| Path                                                                                                         | Kind                                                                         | Scope                                   |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------- |
| `agent-data/{box,host}-secrets.json`, `webhook-keys.json`, `teach-queue-key.json`, `chrome-cookie-seed.json` | secret stores (mode 600), webhook signing keys, queue key, 50 KB cookie seed | shared                                  |
| `agent-data/connector-secrets/<agent-uuid>/`; `agents/<id>/store.db kv.metadata.blobEncryptionKey`           | per-agent connector credentials; conversation-blob encryption key            | per-agent (2 of 14 have connectors)     |
| `agent-data/{settings,gateway,source-map}.json`, `plugin-skills/cache.json`                                  | host-only store — the `Read` tool refuses them                               | host-guarded **in the tool layer only** |
| `.mcp-auth/*`, `.beeper-mcp-auth/*`; `chrome-profile/Default/{Cookies, Login Data, …}`                       | MCP OAuth token stores; live browser credentials                             | **shared across all 14 agents**         |

Absent: `.ssh`, `.netrc`, any `.env` to depth 4 (§10, §B10). **The `Read` barrier is not a filesystem
barrier**: GrokBot read `plugin-skills/cache.json` and `search-index.db` with python after `Read`
refused them (§2.4). INFERENCE: one trusted user, one trust domain — agent separation is
organisational, not enforced.

## Divergences from FrockBot's Fly Sprite design

The parity register below carries the capability comparison; three code-level divergences are worth
naming. `plugin-fly-sprite/src/computer.ts:6` hardcodes `HOME_ROOT = "/home/box"` and `DATA_ROOT =
${HOME_ROOT}/agent-data` — GrokBot's paths, not Fly's, whose home is `/home/sprite`; this document is
what that code was copying. `computer.ts:53` still gives each Bot its own `chrome-profiles/$KEY`
where AGENTS.md and GrokBot both mandate one shared profile, and the Package still allocates one
Sprite per Bot where ADR 0012 says one Computer per User. And GrokBot's desktop adds `plank`, `picom`,
a WebAuthn proxy host, `sand-egress-tunnel`, `sand-ua-governor.mjs`, `sand-fingerprint-profiles.mjs`
and a "Route egress through this desktop" setting; FrockBot has no counterpart to any of those.

## Parity register

`AGENTS.md` names this table the parity register. Each row is one capability FrockBot must match, the
GrokBot mechanism, primary-source evidence, the Package proposed to own it, and status against
`docs/architecture.md` today.

| #   | Capability                                                                                                          | GrokBot mechanism                                                                | Evidence    | FrockBot Package (proposed)  | Status      |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- | ---------------------------- | ----------- |
| 1   | **Bot model** — identity record: name, description, title, avatar shape/colour, `namedBy`                           | `agents/<id>/profile.json`                                                       | §2.18       | `plugin-flock`               | partial     |
| 2   | Create and edit a Bot from inside a Bot; only provided fields change; no delete tool                                | `CreateAgent{name, description?}`, `UpdateAgent{agent_id, …}`                    | §2.12       | `plugin-flock`               | not started |
| 3   | Bot deletion is a user-only permanent UI action; no archive, no hide                                                | sidebar right-click → Delete, removes transcript                                 | §2A         | `plugin-flock` + settings UI | not started |
| 4   | Per-Bot settings: `hidden_from_sidebar` (still reachable by palette), `notify_on_updates`                           | `update_state settings set` → `settings.json`                                    | §2.18       | `plugin-settings`            | partial     |
| 5   | Per-Bot avatar set from a file on disk or cleared; self-rename announced, provenance recorded                       | `update_state avatar`; `profile.json.namedBy`                                    | §2.2, §2.18 | `plugin-flock`               | partial     |
| 6   | Export/import a Bot as a shareable template: scrubbed prose, visibility scope, review card                          | `export-bot-template` + `create_bot_share_json`; `import-bot-template`           | §2.11, §2A  | new `plugin-bot-template`    | not started |
| 7   | **Memory** — profile tier: enduring facts, one per line, injected every turn                                        | `agents/<id>/memory/profile.md`                                                  | §5, §2.2    | `plugin-memory`              | partial     |
| 8   | Log tier: dated monthly file, `- (YYYY-MM-DD) <fact>`, read on demand rather than injected                          | `memory/log/YYYY-MM.md`                                                          | §2.2, §2.3  | `plugin-memory`              | not started |
| 9   | Note tier that "fades fast" and is excluded from exports; fact dedupe on write; `forget` by exact text              | `tier: note`; `update_state memory write`/`forget`                               | §2.2, §2.11 | `plugin-memory`              | not started |
| 10  | Three write scopes chosen per fact: agent, user, project                                                            | `scope: agent\|user\|project`                                                    | §2.2        | `plugin-memory`              | not started |
| 11  | User memory sharded per writing Bot, injected into every Bot, attributed to the writer                              | `user-memory/by-agent/<id>/profile.md`, tagged `[via <bot>]`                     | §2.3        | `plugin-memory`              | not started |
| 12  | Precedence: own > project > user-memory; newest write wins on conflict                                              | harness instruction                                                              | §2.3        | `plugin-memory`              | not started |
| 13  | Project memory scope with create/join/leave membership                                                              | `update_state project`; `projects/<slug>/…` (**absent on disk**)                 | §2.2, §B5   | `plugin-memory`              | not started |
| 14  | Exactly what memory was injected is recorded per turn; memory mutated only through one tool                         | `store.db kv.*PromptSnapshot`; `update_state` (advisory — files stay writable)   | §2.5        | kernel session log           | partial     |
| 15  | **Routines** — per-Bot definition file (name, prompt, trigger, enabled, provenance, timestamps) and durable run log | `automations/<slug>/{automation.json,runs.json}`                                 | §2.6        | new `plugin-routines`        | not started |
| 16  | Cron triggers with timezone and `@daily` shorthands; inbound webhook with its own signing-key store                 | `trigger.type=cron`/`webhook`; `webhook-keys.json`                               | §2.6        | `plugin-routines`            | not started |
| 17  | Integration triggers (slack, github, origin, teams, linear, sentry, pagerduty), `group`, manual run                 | typed trigger schemas; `runs.json trigger:"manual"`                              | §2.6        | per-integration Packages     | not started |
| 18  | A firing runs as a fresh subagent turn under the same Bot id, with that Bot's authority                             | "fresh subagent with the same work capabilities as the parent"                   | §2.7        | kernel Turn admission        | not started |
| 19  | A routine run cannot speak to the user, lands silently in a parent inbox; pause/resume/delete/edit with a card      | `automation_completion_inbox`; `update_state routine`                            | §2.5, §2.7  | `plugin-routines`            | not started |
| 20  | **Skills** — folder + `SKILL.md`, frontmatter `name`/`description`, markdown body, Bot-authorable                   | `workflows/<slug>/SKILL.md`; `update_state skill write`                          | §2.2, §2.8  | new `plugin-skills`          | not started |
| 21  | User skills global across a user's Bots; managed skills read-only; plugin-borne skills indexed not copied           | `workflows/`; `managed-skills/`; `plugin-skills/cache.json`                      | §2.9        | `plugin-skills`              | not started |
| 22  | Catalog of path + description injected each turn; bodies read on demand; `/` or `@` invocation                      | the `<agent_skills>` block                                                       | §2.8        | `plugin-skills` + WebUI      | not started |
| 23  | **Computer** — one persistent Linux computer per user shared by all Bots, per-Bot durable roots, shared scratch     | one container, 14 agents; `agent-data/agents/<uuid>/` vs `/workspace`            | §B8, §A1    | `plugin-computer` + provider | partial     |
| 24  | Per-Bot desktop on one machine: own display, VNC/noVNC route, token, exec port                                      | Xvfb/x11vnc/noVNC per display, `exec-daemon` `14003`–`14013`                     | §C12        | `plugin-fly-sprite`          | partial     |
| 25  | Screenshot of the Bot's own desktop; human takeover for a login or captcha                                          | native `Screenshot`; `request_box_help`                                          | §16, §2A    | `plugin-fly-sprite` lease    | partial     |
| 26  | "Update Computer" (fresh instance, keep files+logins, lose packages) and "Reset" (snapshot restore)                 | settings `update-computer` two-click confirm; `reset-computer`                   | §2A, §9     | `plugin-computer`            | not started |
| 27  | A self-check the Bot runs and reads a log from, plus in-box reference docs it reads to debug itself and the UI      | `box-doctor` + `/tmp/box-doctor.log`; `reference/*.md`                           | §2A         | `plugin-computer`            | not started |
| 28  | Two interchangeable computer runtimes behind one tool surface                                                       | local Docker (dev) vs brokered anyrun pod (default)                              | §2A         | Computer interface           | partial     |
| 29  | Long-running commands run in background and outlive the turn                                                        | background `Shell`, "don't poll"                                                 | §2.17       | `plugin-shell`               | partial     |
| 30  | Every shell command audited with turn id and target                                                                 | `audit.jsonl` `type=shell_command`, `target: box\|user_machine`                  | §2.5        | kernel event log             | partial     |
| 31  | **Browser** — one profile shared by all of a user's Bots                                                            | `/home/box/chrome-profile`                                                       | §B6         | `plugin-fly-sprite`          | not started |
| 32  | Cookies and logins survive computer replacement; seeding, persistence, import from the user's machine               | `chrome-cookie-seed.json`, `sand-cookie-persist.mjs`, `chrome-cookie-import`     | §A3, §2A    | `plugin-computer`            | not started |
| 33  | A launcher that enforces correct browser flags; GUI never driven from the shell                                     | `box-chrome`; no `xdotool`/CDP from `Shell`                                      | §B9, §2A    | `plugin-fly-sprite`          | not started |
| 34  | Egress routed through the desktop; UA/fingerprint governance; WebAuthn proxying                                     | settings `egress`, `sand-{ua-governor,fingerprint-profiles,webauthn-proxy-host}` | §A3         | none proposed                | not started |
| 35  | **Channels** — Bot-to-Bot group chats, 1–6 members, in the sidebar, posted into by id                               | `CreateChannel`/`UpdateChannel`; `SendToAgent`                                   | §2.14       | new `plugin-channels`        | not started |
| 36  | External channel connectors (Telegram etc.) connected and disconnected per Bot                                      | info-pane Channels; `update_state channel disconnect{platform}`                  | §2.14, §2A  | per-platform Package         | not started |
| 37  | **Subagents** — typed roles: executor, browserUse, computerUse, watchVideo, videoReview                             | `Task{subagent_type}`                                                            | §2.15       | new `plugin-subagents`       | not started |
| 38  | Subagents start blank (no memory or transcript); background by default; check, message, stop, resume by id          | self-contained dispatch prompt; `Check`/`Message`/`StopSubagent`, `resume=<id>`  | §2.15       | `plugin-subagents`           | not started |
| 39  | Only one desktop-GUI subagent at a time, because the screen is shared                                               | `computerUse` serialization                                                      | §2.15       | `plugin-fly-sprite` lease    | partial     |
| 40  | Child → parent handoff that ends the child's turn                                                                   | `WakeParent{message}`; parent = the same Bot's visible conversation              | §2.13       | kernel Turn admission        | not started |
| 41  | **Connectors / MCP** — plugin = marketplace bundle of MCP connectors ± skills, stable numeric id                    | `plugins/cache/…/.cursor-plugin/plugin.json`                                     | §2.10       | `plugin-catalog`             | partial     |
| 42  | Plugin discovery, fetch, install state and uninstall over a 296-plugin catalog; plugins are user-scoped             | `SearchPlugins`/`GetPlugin`/`UninstallPlugin`; `installed=yes (user)`            | §2.10       | `plugin-catalog`             | partial     |
| 43  | Multi-account connectors with per-account labels; MCP lifecycle (status, restart, rename, instructions)             | Gmail/Calendar/Drive ×5; `GetMcpServerStatus`, `SetMcpInstructions`              | §16, §17    | `connection-core`            | partial     |
| 44  | Custom (non-marketplace) stdio MCP servers, which cannot ship in a template                                         | `user-beeper`, `user-beeper-desktop`                                             | §2.10       | `connection-core`            | not started |
| 45  | Per-Bot connector credential store                                                                                  | `connector-secrets/<agent-uuid>/`                                                | §10         | `plugin-credentials`         | partial     |
| 46  | Repo work delegated to a cloud coding agent; repos never cloned onto the computer                                   | `CloudAgent`                                                                     | §2.17, §14  | new Package                  | not started |
| 47  | Web search, web fetch and image generation as first-class tools                                                     | `WebSearch`, `WebFetch`, `GenerateImage`                                         | §17         | tool Packages                | not started |
| 48  | **Registered machine** — registry of the user's own machines with live connected state                              | `ListMachines` → `{machineId, label, connected}`                                 | §2.16       | new `plugin-user-machine`    | not started |
| 49  | Shell/Read/AwaitShell targeted at a machine by id with local-exec approval; copy files both ways                    | `machineId`; `CopyToBox`/`CopyFromBox`                                           | §2.16, §2A  | `plugin-user-machine`        | not started |
| 50  | **UI** — settings tabs with per-row deep links the agent may cite but never invent                                  | `grokbot://app/v1/settings?id=<anchor>`                                          | §2A         | `plugin-settings`            | partial     |
| 51  | Per-Bot info pane: live computer preview + routines + channels + members                                            | chat header / `Cmd+Shift+I`                                                      | §2A         | `webui-shell` + Packages     | not started |
| 52  | Search across every Bot's transcript and media (the agent gets no tool over it)                                     | `search-index.db` `messages` / `media`                                           | §2.4        | new `plugin-search`          | not started |
| 53  | Approval cards for the Bot's own risky actions (Auto-review)                                                        | harness "when your own action needs approval"                                    | §2.17       | `plugin-settings` + WebUI    | not started |

## Open questions for GrokBot

1. **Concurrency of routines** — no documented rule, only one `"running"` row ever seen (§2.7). What
   happens if two fire at once, or one fires while the user is typing?
2. **Are there `audit.jsonl` event types other than `shell_command`?** 202 lines, all one type
   (§2.5). Are memory writes, routine edits or tool calls audited anywhere?
3. **What is the actual durability mechanism?** `box-store-sync.lock`, `sand-session-sync.mjs`,
   `sand-cookie-persist.mjs` and `audit-outbox.json` imply host-side sync GrokBot cannot see (§A3).
   What syncs, how often, and how much can "Reset restores the last saved snapshot" lose?
4. **Why was own-agent memory not injected on the automation run** (§2.3) — a deliberate difference
   between chat turns and routine turns, or a bug? What does a _chat_ turn's memory block contain?
5. **Is the `project` scope live anywhere?** `update_state` fully documents it and the harness has a
   "Project memory" section, yet `sand-data/projects/` does not exist (§B5, §2.2, §2.17).
6. **Does `conversation-blobs.db` hold encrypted bodies,** given `kv.metadata.blobEncryptionKey`
   (§2.5) — and who holds that key besides the box?
7. **Does the box ever suspend?** No measured cycle (§15). Is there an idle-kill, do background
   `Shell` jobs outlive a turn, and how are 7 displays allocated across 14 agents?
8. **What does `learn-from-demonstration` record, and where,** given `workflows/` is empty? And what
   does `add-connector` do that `SearchPlugins` plus OAuth does not?
9. **What is the full `Task` schema** (model slugs, `run_in_background`, `resume`,
   `file_attachments`), and how does a subagent's output reach the user when the parent is asleep?
10. **What does the _chat_ system prompt carry that the automation prompt lacks** — `SendToUser`,
    question widgets, `create_bot_share_json` and `request_box_help` were all absent (§2.11, §2.14)?

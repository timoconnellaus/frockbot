# Research: GrokBot's computer, as observed

Primary evidence: GrokBot ("Discovery Bot", agent `23ea47c3-…`) ran every command itself on
2026-08-31 and returned the output. `§<n>` cites `MESSAGE_1_RESPONSE.md`; `§<A1|B5|C12|…>` cites
`MESSAGE_1_ATTACHMENT_layout.md`. Everything not marked **INFERENCE** is command output or a quote.

## Summary

GrokBot's "computer" is not one machine per agent. It is a single long-lived Debian 13 Docker
container — user `box`, `HOME=/home/box`, hostname `cursor` — shared by all fourteen of Tim's Grok
Bot agents at once (§B8, §B11). One overlay filesystem carries `/`, `/home/box`, `/workspace` and
`/tmp`, and `/tmp` is not tmpfs (§A3). Durable agent state lives under `/home/box/agent-data`, a
symlink to `/home/box/sand-data`, fanned out per agent as `agents/<uuid>/{memory,automations,…}`
(§A1). Scratch is the shared `/workspace`, where other agents' project dirs sit in plain view (§B7),
and Chrome is a single shared profile at `/home/box/chrome-profile` — not per agent — so all
fourteen bots share one cookie jar and one logged-in identity (§B6). A `sand-*` supervisor stack
runs per-agent virtual desktops (Xvfb + x11vnc + noVNC + xfwm4 + plank) on separate X displays
behind separate `exec-daemon` ports, so "per-agent desktop" means a separate screen on the same box
(§C12). The tool surface is seven native function tools plus 27 Cursor-namespace dynamic tools
reached through `CallDynamicTool`, five `Task` subagent types, and MCP connectors (§16–§18). Memory
is not free-edited: the agent mutates it only through `update_state` (§5).

## Machine

Debian GNU/Linux 13.6 (trixie), kernel `6.12.94+ SMP PREEMPT_DYNAMIC` x86_64, hostname `cursor`,
user `box`, `HOME=/home/box`, default cwd `/workspace` (§A1, §A4). It is a Docker container:
`/.dockerenv` is present and PID 1 is `tini` running `/pod-daemon` (§A2, §C12). One `overlay`
filesystem with many docker overlay2 lowerdirs backs `/`, `/home/box`, `/workspace` and `/tmp` (all
`stat` device `39`); `df -h` shows 126 G total, 5.7 G used, 114 G free; the only tmpfs mounts are
`/dev` and `/dev/shm` at 64 M each (§A3). The container started ~Aug 26 23:32 UTC and was still the
same container on Aug 30 22:47 UTC (§A2, §C15). ~936 `dpkg` entries: python 3.13.5, node v20.19.2,
git 2.47.3, rg 14.1.1, gh 2.46.0, jq 1.7, bun 1.4.0, uv 0.12.6, ffmpeg, pdftotext — while `tree`,
the `docker` CLI and ImageMagick `convert` are **absent**. `PATH` starts `/home/box/.local/bin:
/home/box/bin:/usr/local/bin:…` (§B9).

**Update vs Reset.** From `/home/box/reference/debugging-the-box.md` (§A3): _"Update Grok Bot
Computer moves the box to a fresh instance while keeping files and logins. Installed software does
not survive the move."_ Reset "restores from the last saved snapshot and can lose recent unsynced
work", and the doc tells the agent never to steer users there. **Files and logins keep; packages,
CLIs and docker images go** (§9).

**Supervisor processes** (from `ps aux --sort=-rss`, §C12). There is no systemd, supervisord, s6 or
runit — `/etc/supervisor`, `/etc/s6`, `/etc/service` do not exist.

| Process                                                                                                          | Count observed                               | What it appears to do (INFERENCE from name/argv, unless quoted)                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tini` → `/pod-daemon`                                                                                           | 1 (PID 1)                                    | container init; argv names `/run/host-services/ssh-auth.sock` and `vsock port 52` — the host↔box control channel                                                                    |
| `sand-host/host-main.cjs`                                                                                        | 1 (~547 MB RSS, largest)                     | the agent host itself: runs turns, owns `sand-data`, serves the agent tool surface                                                                                                  |
| `exec-daemon/index.js serve`                                                                                     | 7                                            | command execution: one main on `--port 1337 … --computer-use-enabled --mcp-meta-tool-enabled`, plus one per desktop on ports `14003`–`14013`                                        |
| `sand-supervisor.mjs`, `sand-window-router.mjs 1339 1337 14000`                                                  | 1 each                                       | process supervision (writes `/tmp/sand-supervisor/{acks,desktop-health.json,status.json}`); routes a window/agent to its exec-daemon port                                           |
| `sand-session-sync.mjs`, `sand-cookie-persist.mjs`, `sand-special-treatment-chrome.mjs`, `sand-web-bot-auth.mjs` | 1 each (the last 226 min CPU — busiest)      | session state sync (INFERENCE: host-side durability); persists Chrome cookies out of the live profile; Chrome-specific/anti-bot handling; web bot auth signing (last two INFERENCE) |
| `Xvfb` / `x11vnc` / `novnc` / `picom` / `xfwm4 --compositor=off` / `plank --name dock1`                          | one set per display `:1,:3,:4,:5,:6,:12,:13` | the per-agent virtual desktop: framebuffer, VNC server, browser-facing VNC gateway, compositor, window manager, dock                                                                |
| `box-bounded-log.mjs <logfile> <pid>`                                                                            | one per supervised child                     | size-bounded log capture into `/tmp/<name>.log`                                                                                                                                     |

Launchers in `/usr/local/bin`: `start-sand-box`, `start-desktop.sh`, `start-window`, `stop-window`,
`supervise-{sand-supervisor,exec-daemon,egress-tunnel}`, `box-chrome`, `box-doctor`,
`sand-egress-tunnel`, `sand-webauthn-proxy-host`, `playwright-core`. Chrome must be launched via
`box-chrome`, never a raw binary (§B9, §A3). Per-agent desktop roots live in `/tmp/sand-desktop/`.

## Filesystem layout

Scope labels are OBSERVED from ownership and path shape; `agent-data` → `sand-data` is a real
symlink (§A1 `readlink -f`, §A3, §B7, §B8, §B10).

```
/home/box/                     [per-user, shared by all 14 agents; .bashrc/.profile from base image]
├── .mcp-auth/{mcp-remote-0.1.43,-v1}/  .beeper-mcp-auth/mcp-remote-0.0.2/  [SECRET: OAuth
│                                           tokens, client_info, code verifiers]
├── .cursor/  .local/  .npm/  .cache/  .config/{google-chrome,xfce4,plank,dconf}/   [shared;
│                                           google-chrome holds only Crash Reports]
├── .sand-webauthn-proxy-enabled  .sand-window-assignments.json  [flag; window↔agent map]
├── agent-data -> /home/box/sand-data       [THE durable store, shared]
├── chrome-profile/                         [SHARED browser profile — not per-agent]
│   └── Default/{Cookies, Login Data, Login Data For Account}   [SECRET-bearing]
├── bin/  deps/  cli-config/ (mode 700, empty)  sand-host/ (image: host-main.cjs 25 MB,
│                                             box-scripts/, agent-isolation/)
├── reference/{debugging-the-box.md, app-ui.md}  [shipped docs, not agent-written]
└── telegram-{inbox/,allowlist.json,webhook.json}  tmp/messages/  Downloads/  [webhook: SECRET 600]
/home/box/sand-data/                        [durable; mode 700]
├── agents/<uuid>/                          [PER-AGENT — 14 dirs]
│   ├── profile.json  settings.json         [name/description; per-agent settings]
│   ├── memory/profile.md  memory/log/      [PER-AGENT memory]
│   ├── automations/<name>/{automation.json,runs.json}   audit.jsonl
│   └── store.db  conversation-blobs.db (+ -wal/-shm)    [sqlite]
├── agents/{active-agent.json, audit-outbox.json}   [+ agent-transcripts/<id>/, PER-AGENT, 56]
├── user-memory/by-agent/<uuid>/profile.md  [PER-USER memory, sharded by agent; only 2 shards exist]
├── connector-secrets/<agent-uuid>/         [SECRET, PER-AGENT; only 2 agents have one]
├── workflows/                              [PER-USER skills dir — EMPTY]
├── managed-skills/skills/{add-connector, export-bot-template, import-bot-template,
│                          learn-from-demonstration}   + plugin-skills/ plugins/ transcript-publish/
├── box-secrets.json  host-secrets.json  webhook-keys.json  teach-queue-key.json
│   chrome-cookie-seed.json                 [ALL SECRET-bearing]
├── settings.json  [host-only; the Read tool refused it]   search-index.db (+ -wal/-shm) [462 KB]
└── ack-obligations.json  host-pending-wakes.json  host.lock  box-store-sync.lock  gateway.json
    source-map.json  send-acceptance.json  sand-statsig-bootstrap.json
/workspace/                                 [SHARED SCRATCH — every agent's junk in one dir]
├── xero/ linkedin_profile/ linkedin_logos/ health-docs/ up/ tradie-sites/
└── cloud-agent-transcripts/  + ~60 loose files (chunk_*.txt, pa_*.js, shot.py, …)
    NOTE: `/workspace/uploads` was NOT observed; §7 names it for inbound copies.
/tmp/                                       [overlay, NOT tmpfs — lives as long as the container]
├── sand-desktop/  sand-window-{3,4,5,6,12,13}/  sand-window-tokens.d/  sand-novnc-tokens.d/
├── sand-supervisor/{acks,desktop-health.json,status.json}  xdg-runtime{,-box}{,-N}/  dbus-*
└── {xvfb,x11vnc,novnc,xfwm4,picom,plank}:<display>.log  .X<N>-lock  sand-host.log  box-doctor.log
    exec-daemon.log  sand-supervisor.log  sand-identity.sock
```

## Memory model

Given to GrokBot, not designed by it: _"Given to me; I did not design it"_ (§5).

- **Per-agent profile tier.** `agent-data/agents/<uuid>/memory/profile.md` — markdown, **one fact
  per line**, enduring user facts, preceded by an HTML comment describing the format. GrokBot's own
  file is 597 bytes and _"currently one fact"_. Exists for 12 of the 14 agents (§B5, §C13), and is
  _"kept in mind every turn"_ alongside an injected system prompt the agent does not maintain (§13 —
  STATED, not verifiable from disk).
- **Per-agent log tier.** `memory/log/` exists as a directory, described as _dated history_, intended
  monthly. **OBSERVED empty** — "no monthly log file yet" (§5, §B5); monthly granularity is
  GrokBot's statement, not visible on disk.
- **Per-user shards.** `agent-data/user-memory/by-agent/<uuid>/profile.md`. Only two exist — School
  and General; Discovery Bot has none (§B5). INFERENCE: written lazily on first user-scoped fact,
  not provisioned with the agent.
- **Mutation path.** _"I change memory via `update_state` (tiers profile / log / note), not by
  free-editing those files"_ (§5) — the files are ordinary readable/greppable markdown, so the
  discipline is a contract, not a permission boundary. No `note`-tier artefact was seen on disk.
- **What does not exist.** `sand-data/projects/` (`No such file or directory`, §B5) even though
  `update_state` advertises a `projects` scope (§16); and no `AGENTS.md`, `SOUL.md`, `MEMORY.md`,
  `NOTES.md` or `CLAUDE.md` under `/home/box` or `/workspace` to depth 5 (§C13).

## Skills, routines, workflows

- **Managed skills** (host-shipped, shared): `agent-data/managed-skills/skills/` contains exactly
  `add-connector`, `export-bot-template`, `import-bot-template`, `learn-from-demonstration` (§7,
  §A1). INFERENCE: the four built-in meta-capabilities — connect a service, move a bot definition in
  and out, learn a routine by watching the user. The user's own `agent-data/workflows/` exists and is
  **empty**; `agent-data/plugin-skills/`, `plugins/` and `.cursor/skills-cursor/canvas` exist but
  were not enumerated (§7, §A1, §C13).
- **Routines/automations are per-agent, not in `workflows/`.** The only observed routine is
  `agents/<uuid>/automations/new-message/{automation.json,runs.json}` — "New Message", trigger type
  `webhook`, `enabled: true`, provenance `user`, `runs.json` as the run log (§B5). Its prompt directs
  the agent at `/Users/tim/tmp/messages` **on Tim's Mac**, not the box. There is no cron and no
  OS-level scheduled service (§C12).

## Secrets on disk

Kinds and locations only. Trust-model fact: **all of these are readable by ordinary shell as `box`**
— _"Ordinary shell can read these files"_ (§10) — and every agent runs as `box`.

| Path                                                                                                 | Kind                                                      | Scope                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| `agent-data/{box,host}-secrets.json`, `webhook-keys.json`, `teach-queue-key.json`                    | secret stores (mode 600), webhook signing keys, queue key | shared                          |
| `agent-data/chrome-cookie-seed.json`                                                                 | cookie seed, 50 KB                                        | shared                          |
| `agent-data/connector-secrets/<agent-uuid>/`                                                         | per-agent connector credentials                           | per-agent (2 of 14)             |
| `agent-data/settings.json`                                                                           | host-only store — the Read tool _refused_ it              | host-guarded                    |
| `.mcp-auth/*`, `.beeper-mcp-auth/*` (`*_tokens.json`, `*_client_info.json`, `*_code_verifier_*.txt`) | MCP OAuth token stores                                    | shared                          |
| `telegram-webhook.json`                                                                              | Telegram webhook config (mode 600)                        | shared                          |
| `chrome-profile/Default/{Cookies, Login Data, Login Data For Account}`                               | live browser credentials                                  | **shared across all 14 agents** |

Absent: `.ssh`, `.netrc`, any `.env` to depth 4; `cli-config/` is mode 700 and empty (§10, §B10).
`settings.json` is the one file with a real read barrier, and that barrier is in the _tool layer_,
not the filesystem (§A1). INFERENCE: one trusted user, one trust domain — agent separation here is
organisational, not enforced.

## Tool inventory

Two layers: function tools the agent calls, and CLIs on the box. **Native function tools (7):**

| Tool                                  | Does                                                                                    | Where it runs       | Frequency (§18)    |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ------------------- | ------------------ |
| `WakeParent`                          | hands off to the parent agent for user-visible talk                                     | box (control plane) | as needed          |
| `update_state`                        | writes memory, routines, skills, profile, settings, projects, avatar                    | box (`sand-data`)   | most-used          |
| `Shell` / `Read`                      | run commands / read files on the box, **or on a registered Mac when given `machineId`** | box or Mac          | most-used          |
| `Screenshot`                          | captures the agent's desktop                                                            | box                 | rare for text work |
| `GetDynamicTools` / `CallDynamicTool` | fetch schemas for, then invoke, the Cursor-namespace tools                              | box                 | most-used          |

**Cursor-namespace dynamic tools (27, via `CallDynamicTool`).** `AwaitShell`, `CheckSubagent`,
`CloudAgent`, `CopyFromBox`, `CopyToBox`, `CreateAgent`, `CreateChannel`, `GenerateImage`,
`GetMcpServerStatus`, `GetPlugin`, `ListMachines`, `MessageSubagent`, `RemoveMcpAccount`,
`RenameMcpAccount`, `RestartMcpServers`, `SearchPlugins`, `SendFeedback`, `SetMcpInstructions`,
`StopSubagent`, `Task`, `TodoWrite`, `UninstallMcpServer`, `UninstallPlugin`, `UpdateAgent`,
`UpdateChannel`, `WebFetch`, `WebSearch`.

On the box: `AwaitShell`, `CopyToBox`/`CopyFromBox` (box end), subagent lifecycle, `TodoWrite`.
Calls out: `WebSearch`/`WebFetch`, `CloudAgent`, `ListMachines` and anything `machineId`-scoped,
`CreateAgent`, the plugin/MCP lifecycle set (§17). Most-used: `ListMachines`, `Task`, web tools,
`TodoWrite`; rare: `GenerateImage`, `SendFeedback`, the uninstall/remove set, `CreateAgent`,
`CloudAgent` (§18).

**`Task` subagent types (5).** `executor`, `browserUse`, `computerUse`, `watchVideo`, `videoReview`.
`executor` and `browserUse` are the common two; `browserUse`/`computerUse` drive the desktop on the
box (§16, §17).

**MCP connectors** (from `GetMcpServerStatus`, §16). Gmail ×5 accounts (31 tools each), Google
Calendar ×5 (9), Google Drive ×5 (11) — all connected. GitHub **needsAuth** (44 tools). Composio
connected (7). `beeper` and `beeper-desktop` **error**, 0 tools. All call out over HTTP. The Beeper
failure is structural, not transient: the connector targets this box's loopback while Beeper
actually runs on Tim's Mac (§15, §16).

## Multi-agent model

- **One box, many agents.** 14 agent UUID dirs under `agents/`: School, General, Xero Books, Health,
  Discovery Bot, Budget, Zero BS AI (×2 — distinct UUIDs, same name), Side Quest Ideas, Housework,
  Linkedin Manager, Trainer, Tradie Sites, New Bot; `active-agent.json` names the active one (§B8).
- **Per-agent desktops, one machine.** Displays `:1,:3,:4,:5,:6,:12,:13`, each with its own
  Xvfb/x11vnc/noVNC/xfwm4/plank and `exec-daemon` port (`14003`–`14013`), routed by
  `sand-window-router.mjs` and `.sand-window-assignments.json`. _"Desktops are per-agent (separate
  screen), not a separate machine"_ (§8, §C12). 7 displays for 14 agents — INFERENCE: allocated on
  demand.
- **Shared everything else**: filesystem, `/workspace`, packages, `/tmp`, `sand-data`, the search
  index, and critically the **single Chrome profile with one cookie jar** (§B8, §B11).
- **Reach off-box.** `Shell`/`Read` with a `machineId` run on Tim's Mac, as this channel does (§17).
- **Hierarchy.** `WakeParent` hands control to a parent for user-visible speech; `Task` spawns
  subagents managed with `CheckSubagent`/`MessageSubagent`/`StopSubagent`; `CreateAgent` makes
  peers. Desktop/browser work is delegated to subagents (§15, §16).
- **Not shared with other humans** — _"No evidence it is shared with other humans or other
  customers"_ (§11). Isolation between Tim's own agents is convention, not enforcement.

## Divergences from FrockBot's Fly Sprite design

Comparing against `docs/research/fly-sprites-computer.md` and `packages/plugin-fly-sprite/src`.

- **One box vs one Sprite per Bot.** GrokBot: one container for all 14 agents; FrockBot's Fly design
  item 1 allocates one Sprite per Bot plus a storage Sprite. FrockBot's isolation is stronger; it
  needs a deliberate answer for what GrokBot gets free by sharing a disk.
- **`/home/box` is GrokBot's, not Fly's.** `plugin-fly-sprite/src/computer.ts:6` hardcodes
  `HOME_ROOT = "/home/box"` and `DATA_ROOT = ${HOME_ROOT}/agent-data`, but the Sprites home
  directory is `/home/sprite` (fly-sprites §"Corrections" 1). That path is a copy of GrokBot's
  Debian box — this document is what it was copying.
- **Shared vs per-Bot Chrome profile.** GrokBot: one `/home/box/chrome-profile` for everyone;
  FrockBot: `${HOME_ROOT}/chrome-profiles/$KEY` per Bot (`computer.ts:53`). A real capability
  divergence — GrokBot's agents inherit each other's logins, FrockBot's do not.
- **Memory via a tool vs free file edits.** GrokBot mutates memory only through `update_state` (§5);
  FrockBot's memory Package owns its own Markdown/index layout, provider-uninjected (fly-sprites
  item 2; `provider.ts:343`). A controlled mutation surface is a Package contract FrockBot has not
  stated.
- **Supervision and persistence.** GrokBot hand-rolls `sand-supervisor.mjs` and `supervise-*`
  wrappers with no systemd, and its durability is a Docker overlay plus host-side sync it cannot see
  (§A3). Sprites give a Services API surviving cold wake and object-backed ext4 with checkpoints.
  FrockBot still needs an "Update Computer" equivalent: a user-facing button contracted to keep
  files+logins and lose packages.
- **Scratch and `/tmp`.** GrokBot's `/workspace` is shared and littered with other agents' files,
  and its `/tmp` is overlay holding desktop logs since Aug 26 (§B7, §A3). FrockBot uses Bot-private
  `/workspaces/<bot-key>` (`computer.ts:214`), and Sprites flags `/tmp` persistence as unverified —
  do not port GrokBot's habit of leaving durable-ish artefacts there.
- **Desktop stack and egress.** Both use Xvfb + x11vnc + noVNC + a light WM, but GrokBot adds
  `plank`, `picom`, a wallpaper tool, a WebAuthn proxy host, `sand-egress-tunnel`,
  `sand-ua-governor.mjs`, `sand-fingerprint-profiles.mjs`, and a "Route egress through this desktop"
  setting (§A3, §B9). FrockBot has no fingerprint, egress-routing or WebAuthn counterpart.

## Parity checklist

- [ ] Persistent Linux computer per user, surviving across turns and days (not per-turn), with a
      durable data root (`agent-data`, per-agent subtrees) separate from a documented scratch dir.
- [ ] Per-agent memory: profile tier (one fact per line), dated log tier, note tier; per-user shards
      addressable per agent; mutation only via one tool (`update_state`); injected each turn.
- [ ] Per-agent automations with webhook triggers and a persisted run log; a user-owned
      workflows/skills dir; managed skills add-connector, export/import-bot-template,
      learn-from-demonstration.
- [ ] Browser profile whose cookies and logins survive computer replacement; cookie seeding and
      import from the user's machine; a launcher enforcing correct flags (`box-chrome`).
- [ ] Per-agent virtual desktop (own display, VNC/noVNC route, token), screenshot of it, and human
      takeover on it for a login or captcha (`request_box_help` equivalent).
- [ ] Shell + Read targeting either the computer or a registered user machine by id; machine
      registry (`ListMachines`); copy in/out (`CopyToBox`/`CopyFromBox`).
- [ ] Subagent spawn/message/check/stop with typed roles (executor, browser, computer, video), and
      parent/child handoff for user-visible speech (`WakeParent`).
- [ ] Agent and channel creation/update from within an agent; MCP connector lifecycle (install,
      uninstall, rename, remove account, restart, set instructions, status) with multi-account
      support; plugin search/fetch/uninstall; web search and fetch; image generation; cloud
      coding-agent delegation for repo work (repos are _not_ cloned on the box, §14).
- [ ] Per-agent transcripts and audit log (`audit.jsonl`); a shared search index over agent data;
      a cross-agent secret store, per-agent connector secrets, and a host-guarded settings store.
- [ ] "Update Computer" (fresh instance, keep files+logins, drop packages) and "Reset Computer"
      (restore last snapshot; destructive, de-emphasised in guidance).
- [ ] In-box reference docs the agent reads to debug its own environment; egress routing through the
      desktop; browser fingerprint/UA governance; WebAuthn proxying to the real authenticator.

## Open questions for GrokBot

1. **Where does the `note` memory tier land on disk?** `update_state` advertises it (§5); no note
   artefact appears anywhere in the dump.
2. **What creates a `user-memory/by-agent/<id>` shard, and when?** Only 2 of 14 agents have one.
   Relatedly, `update_state` advertises a `projects` scope but `sand-data/projects/` does not exist
   (§B5) — unimplemented, stored elsewhere, or lazily created?
3. **What is the actual durability mechanism?** `box-store-sync.lock`, `sand-session-sync.mjs` and
   `sand-cookie-persist.mjs` imply host-side sync GrokBot cannot see (§A3). What syncs, how often,
   and how much can "Reset restores the last saved snapshot" lose?
4. **Does the box ever suspend?** No measured cycle (§15); this container ran four days. Is there an
   idle-kill, and do background `Shell` jobs outlive a turn indefinitely?
5. **Is `/workspace/uploads` real?** §7 names it as the inbound-copy destination; §B7's `find` output
   does not show it. Relatedly, how are displays allocated — 7 for 14 agents, on demand or from a
   pool, and what tears one down?
6. **What is in `plugins/` and `plugin-skills/`?** Never enumerated. Is that how a user extends a
   bot, and what is its manifest format?
7. **Does `connector-secrets/<id>` isolate credentials in any enforced way,** given every agent runs
   as `box` and can read the others' directories? And what are `sand-special-treatment-chrome.mjs`
   and `sand-web-bot-auth.mjs` doing — the latter is the busiest process on the box (226 min CPU)?
8. **Is the shared Chrome profile deliberate** — do all 14 agents genuinely share one logged-in
   Google session? And what does `learn-from-demonstration` record, and where, given `workflows/` is
   empty?

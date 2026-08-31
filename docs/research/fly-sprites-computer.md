# Fly.io Sprites computer integration

## Status

Primary-source research for a FrockBot Computer provider backed by Fly.io Sprites. The provider now implements `@frockbot/computer-core`; generic tools, memory, and viewer UI are owned by separate Packages.

Sources read: `docs.sprites.dev` (API reference version `0.0.1-dev`, path prefix `/api/dev-latest/`), the official SDK README at `github.com/superfly/sprites-js`, and the Fly.io engineering post on Sprite internals. Secondary sources (community posts, tutorials) were not used except where explicitly labelled unverified.

## Documented capabilities

- A Sprite is a "persistent, hardware-isolated Linux environment for running arbitrary code" — a stateful microVM, not a container, with a persistent ext4 filesystem that survives hibernation. Sending a command or HTTP request wakes it. [Sprites overview](https://docs.sprites.dev/) / [Sprites quickstart](https://docs.sprites.dev/quickstart/)
- The official JavaScript SDK is `@fly/sprites`. `SpritesClient` exposes `sprite()`, `createSprite()`, `getSprite()`, `listSprites()`, `watchSprites()`, `listAllSprites()`, `deleteSprite()`, `upgradeSprite()`, `restartSprite()`, `checkSprite()`, `updateSprite()`, `updateURLSettings()`, `createToken()`. A `Sprite` supports `spawn()` / `exec()` / `execFile()` / `execFileHTTP()`, sessions (`createSession()`, `attachSession()`, `listSessions()`, `killSession()`), checkpoints, services (`restartService()`, `getServiceLogs()`), filesystem, network policy, port proxy, `watchPorts()`, and control-connection methods. [Official SDK README](https://github.com/superfly/sprites-js#readme)
- The SDK requires Node.js 24.0.0 or newer, defaults to `https://api.sprites.dev`, and authenticates with a bearer token read from `SPRITES_TOKEN`. [Official SDK README](https://github.com/superfly/sprites-js#readme)
- Every Sprite has one HTTPS URL at `https://<sprite-name>-<org-id>.sprites.app/`. It is HTTPS-only and routes to a single HTTP service port — by default port 8080, or the first HTTP port opened. It defaults to org-member-only auth and can be switched to public ("Anyone with the URL can reach it"). `sprite proxy` forwards arbitrary TCP ports but requires a running client-side tunnel. Outbound traffic is governed by a DNS-based allowlist; raw-IP egress is blocked unless the IP came from an allowed domain, and private IPs are always blocked. [Sprites networking](https://docs.sprites.dev/concepts/networking/) / [Working with Sprites](https://docs.sprites.dev/working-with-sprites/)
- A service is "a process the Sprite runtime owns: it starts when the Sprite boots, restarts if it crashes, and can receive the HTTP traffic that hits your Sprite's URL." Only one service may hold the HTTP port; a second returns `409: another service already has an HTTP port configured`. Killing a service process triggers an automatic restart (`restart_count` increments); explicitly stopping it keeps it stopped. Service stdout/stderr lands in `/.sprite/logs/services/<name>.log`. [Sprites services](https://docs.sprites.dev/concepts/services/)
- The Services API is `PUT /v1/sprites/{name}/services/{service_name}` with `cmd`, `args`, `env`, `dir`, `needs` (dependency ordering), and optional `http_port`; separate start/stop/restart endpoints stream logs. [Services API](https://docs.sprites.dev/api/dev-latest/services/)
- Exec is available over WebSocket (`WSS /v1/sprites/{name}/exec`) and over HTTP POST ("simpler alternative … for environments that can't handle websockets", non-TTY only). Commands keep running after client disconnect: `max_run_after_disconnect` defaults to `0` (forever) for TTY sessions and `10s` for non-TTY. Sessions can be reattached to resume streaming output. [Exec API](https://docs.sprites.dev/api/dev-latest/exec/)
- Checkpoints snapshot "the writable filesystem overlay: everything you've added on top of the base image" — files, installed packages, dotfiles, on-disk databases. They do **not** capture running processes, in-memory state, or open network connections: "disk is in the snapshot, memory is not." Restore "replaces the writable overlay with the saved state" and "restarts the environment"; it is destructive and the replaced state is not backed up. [Sprites checkpoints](https://docs.sprites.dev/concepts/checkpoints/)
- Checkpoints are copy-on-write and incremental, created live in milliseconds with no interruption to running processes, and identified by version ids (`v1`, `v5`, …) with optional comments. [Checkpoints API](https://docs.sprites.dev/api/dev-latest/checkpoints/)
- Connectors let an org store a credential centrally and route calls through `https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/<path>`, deny-by-default, so "Sprites never see the token." [Connectors](https://docs.sprites.dev/concepts/connectors/)
- noVNC's embedded viewer accepts connection settings, including `autoconnect` and `password`, from a URL query string or fragment. [noVNC embedding guide](https://novnc.com/noVNC/docs/EMBEDDING.html)

## Corrections to the previous version of this document

1. **Home directory was wrong.** The previous design said `/home/box/agent-data`. The documented home directory is `/home/sprite/`, on Ubuntu 25.10, with `/home/sprite/.local/` for user-installed binaries, `/opt/` for standalone applications, and `/var/` for databases and application state. [Working with Sprites](https://docs.sprites.dev/working-with-sprites/)
2. **"Processes started manually are not a substitute for services because hibernation can terminate them" was imprecise.** Manual processes survive a _warm_ pause (the VM is suspended with memory frozen and processes continue mid-execution on resume) and die on a _cold_ pause. The conclusion still holds — you cannot choose which pause you get — but the failure is state-dependent, not unconditional. [Lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle/)
3. **"Restoring a checkpoint … terminates active sessions" was under-specified.** Restore restarts the whole environment; on the resulting cold start, services with on-disk definitions come back and manually started processes do not. Checkpoint _creation_, by contrast, does not interrupt anything. [Sprites checkpoints](https://docs.sprites.dev/concepts/checkpoints/)
4. **The Sprite URL description was incomplete.** It has a documented hostname form (`<sprite-name>-<org-id>.sprites.app`) and a documented default target port (8080). This matters because the noVNC gateway service must claim that port, and only one service can. [Sprites networking](https://docs.sprites.dev/concepts/networking/)
5. **Token env var naming needed a caveat, not a correction.** `SPRITES_TOKEN` is correct for the SDK. The CLI reads `SPRITE_TOKEN` (singular), alongside `SPRITE_URL` and `SPRITES_API_URL`. Anything that shells out to the CLI inside a Sprite needs the singular spelling. [CLI commands](https://docs.sprites.dev/cli/commands/)
6. **The previous doc had no durability section at all** and implicitly treated "persistent filesystem" as the whole story. See below — the open-TCP-connection behaviour on pause is the item most likely to bite the viewer design.

## Durability model

The team's mental model — _"Sprites are durable. They use a persistent disk and the compute layer is added on demand. For things that need to survive between runs (e.g. browser cookies) it would need to be stored on disk."_ — is **confirmed by the docs**, with two refinements: the "persistent disk" is not a local disk, and "survives between runs" has a warm case where more than the disk survives.

### Storage layer

"Every Sprite has an ext4 filesystem" backed by two tiers: "A hot NVMe cache holds the data you're actively working with while the Sprite runs. It's fast and local," and "Durable object storage holds the persistent copy of everything. The filesystem syncs to it continuously, not as a snapshot taken at hibernation." [Lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle/)

Fly's engineering post describes the implementation: a JuiceFS-style split where "Data chunks live on object stores; metadata lives in fast local storage … that metadata store is kept durable with Litestream," and "A Sprite has a sparse 100GB NVMe volume attached to it, which the stack uses to cache chunks to eliminate read amplification." The NVMe is a cache; object storage is authoritative, which is what lets a Sprite move between machines and come back intact. [The Design & Implementation of Sprites](https://fly.io/blog/design-and-implementation/)

Practical consequence: durability does not depend on the Sprite landing on the same host, and continuous sync means there is no documented "flush before hibernate" step to worry about. It also means first reads after a cold wake may miss the NVMe cache — the docs do not quantify that cost.

### Compute layer

Compute is a Linux microVM with hardware-level isolation ("dedicated microVMs rather than container-level security"), 8 vCPUs per Sprite, and platform-managed memory that "auto-scales under pressure." Compute is billed only while the Sprite is active. [Lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle/)

The filesystem is composed as a base image plus a writable overlay — that framing comes from the checkpoints page ("everything you've added on top of the base image"). Both layers are durable; there is **no documented non-persistent overlay or ephemeral scratch mount**. `/tmp` is on the same persistent filesystem; the docs only warn against _relying_ on it ("Anything in `/tmp` you treat as scratch" appears in the "does not persist" column), which is guidance about intent, not a documented tmpfs. Treat `/tmp` as undefined rather than as either guaranteed-persistent or guaranteed-wiped.

### Hibernation and wake

Three states. [Lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle/) / [Keeping a Sprite running](https://docs.sprites.dev/keeping-sprites-running/)

| State  | Trigger                                                                                              | What happens                              | Wake latency                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Active | Commands, sessions, TCP connections, service traffic                                                 | Compute billed                            | —                                                                              |
| Warm   | "When the activity stops, a short idle window passes (about 30 seconds today) and the Sprite pauses" | VM suspended, memory frozen               | "100–500ms", "with process state preserved" — processes continue mid-execution |
| Cold   | Further idleness (duration **not documented**)                                                       | VM fully stopped, in-memory state dropped | "1–2s", services start fresh                                                   |

The ~30-second idle window is explicitly marked as current behaviour ("about 30 seconds today"), so it is not a contract.

### Exactly what survives

| Thing                                                     | Warm pause                                                                                              | Cold pause                                                           | Source                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Files, directories, permissions, ownership                | Survives                                                                                                | Survives                                                             | [Lifecycle](https://docs.sprites.dev/concepts/lifecycle/), [Working with Sprites](https://docs.sprites.dev/working-with-sprites/) |
| Installed packages, git repos, on-disk databases (SQLite) | Survives                                                                                                | Survives                                                             | [Lifecycle](https://docs.sprites.dev/concepts/lifecycle/)                                                                         |
| Chromium profile directory / cookies **written to disk**  | Survives                                                                                                | Survives                                                             | Inference from the filesystem guarantee — Sprites docs never mention browsers                                                     |
| Chromium cookies / session state held only in memory      | Survives (memory frozen)                                                                                | **Lost**                                                             | [Lifecycle](https://docs.sprites.dev/concepts/lifecycle/)                                                                         |
| Running processes                                         | "Process state pauses on warm"                                                                          | "dies on cold"                                                       | [Keeping a Sprite running](https://docs.sprites.dev/keeping-sprites-running/)                                                     |
| In-memory state generally                                 | Frozen and restored                                                                                     | Lost                                                                 | [Lifecycle](https://docs.sprites.dev/concepts/lifecycle/)                                                                         |
| **Open TCP connections**                                  | **Dropped** — "Open TCP connections drop on the pause, even on warm"                                    | Dropped                                                              | [Keeping a Sprite running](https://docs.sprites.dev/keeping-sprites-running/)                                                     |
| Services (runtime-owned)                                  | Resume without restart                                                                                  | "the runtime starts every service fresh, in dependency order"        | [Services](https://docs.sprites.dev/concepts/services/)                                                                           |
| Manually started background daemons                       | Resume                                                                                                  | Gone                                                                 | [Services](https://docs.sprites.dev/concepts/services/)                                                                           |
| Detached exec/TTY sessions                                | Documented to persist across client disconnect; the docs state TTY sessions "don't survive hibernation" | Gone                                                                 | [Working with Sprites](https://docs.sprites.dev/working-with-sprites/), [Exec API](https://docs.sprites.dev/api/dev-latest/exec/) |
| Network configuration, open ports, URL settings           | Remain configured                                                                                       | Remain configured                                                    | [Working with Sprites](https://docs.sprites.dev/working-with-sprites/)                                                            |
| Listening sockets themselves                              | Not documented — the port _configuration_ persists, the bound socket is a property of the process       |                                                                      | —                                                                                                                                 |
| Environment variables of a process                        | Follow the process                                                                                      | Follow the process (service `env` is re-applied from the definition) | [Services API](https://docs.sprites.dev/api/dev-latest/services/)                                                                 |

The single most load-bearing line for FrockBot: **open TCP connections drop on every pause, warm included.** A live noVNC/VNC websocket, a CDP websocket, and any long-poll from the backend all break when the Sprite pauses, even though the Sprite wakes in 100–500ms with the VNC server process still alive.

### Keeping a Sprite awake

A Tasks API creates a hold on the current run: "Register a task; the Sprite stays up. Delete it (or let it expire); the Sprite is free to pause again." The documented pattern is a heartbeat with a short expiry (5 minutes) refreshed on a shorter interval (60 seconds), so "if the process crashes without cleaning up, the task expires on its own and the Sprite pauses." Services do **not** keep a Sprite awake — "Services don't prevent the Sprite from pausing when idle—they simply resume on the next wake." [Keeping a Sprite running](https://docs.sprites.dev/keeping-sprites-running/) / [Sprites services](https://docs.sprites.dev/concepts/services/)

### Resource and lifecycle limits

- Storage: "Every Sprite starts with 100 GB of storage. It does not autoscale yet." Billing is TRIM-friendly — "you pay for the bytes you actually write, not the full 100 GB, and deleting files lowers your bill." [Lifecycle](https://docs.sprites.dev/concepts/lifecycle/)
- CPU: 8 vCPUs. Memory: platform-managed, auto-scaling under pressure — no documented ceiling. [Lifecycle](https://docs.sprites.dev/concepts/lifecycle/)
- Deletion is explicit only: `DELETE /v1/sprites/{name}` / `sprite destroy`. **No idle-deletion or TTL policy is documented anywhere in the docs.** [Sprites API](https://docs.sprites.dev/api/dev-latest/sprites/) / [CLI commands](https://docs.sprites.dev/cli/commands/)
- Max sprites per org, max concurrent _active_ sprites, checkpoint retention limits, and filesystem-API size limits are **not documented** on docs.sprites.dev. Fly community "Fresh Produce" threads mention paid plans with concurrent-active-Sprite allowances; that is **unverified** for our purposes and must not be designed against.
- Cost model: the docs state compute is billed only while active and storage by bytes written; the marketing/pricing page did not render for automated fetch, so specific prices are **not captured here**. The engineering post says Sprites "cost practically nothing while asleep." [The Design & Implementation of Sprites](https://fly.io/blog/design-and-implementation/)

### Creation and shape

`POST /v1/sprites` accepts only `name`, optional `wait_for_capacity`, and optional `url_settings.auth` (`sprite` | `public`). There is **no documented way to choose an image, region, CPU/memory size, or disk size at creation**. Sprite status values observed in the API docs are `cold` (on creation) and `running`. `PUT /v1/sprites/{name}` currently updates URL auth settings only. [Sprites API](https://docs.sprites.dev/api/dev-latest/sprites/)

## Important gap

The first-party Sprites documentation does not describe a built-in graphical desktop, VNC server, noVNC client, Chromium automation API, or Chrome DevTools Protocol endpoint. A human-controllable browser therefore has to be provisioned as software inside the Sprite. This is an integration design, not a native Sprites feature.

## Integration design inferred from those capabilities

1. Use one stable Sprite per User, shared by all of that User's Bots with per-Bot directories and X displays and one shared browser profile ([ADR 0012](../adr/0012-one-computer-per-user.md)). The earlier one-Sprite-per-Bot design, which `packages/plugin-fly-sprite` still implements, is superseded.
2. Create `/workspaces/<bot-key>` for shell work and Package-private durable directories under the documented home directory `/home/sprite/agent-data`. Memory owns its Markdown and index layout; the Fly provider does not inject memory or mirror sessions.
3. Derive a traversal-safe Bot key from persistent `botId`. Allocate each Bot a registry slot, Chromium profile, X display, CDP port, and VNC port.
4. Provision Chromium, Xvfb, a lightweight window manager, x11vnc, noVNC, and websockify in the Sprite. A single supervised gateway service serves noVNC and uses websockify's reloadable `TokenFile` routing to reach bot-scoped loopback VNC ports. Because only one service may hold the HTTP port and the URL defaults to 8080, the gateway is the sole HTTP-port claimant.
5. Route noVNC through the Sprite HTTPS URL. Because an embedded iframe cannot attach an API `Authorization` header, use public URL mode only for this gateway and protect each route with an opaque viewer token plus a high-entropy VNC password passed in the URL fragment. Public exposure, token routing, and passwords are FrockBot design choices, not guarantees supplied by Sprites.
6. Launch Chromium with an explicit on-disk user-data-dir under the Bot's durable directory. The docs guarantee disk survival, not memory survival, so any cookie or session that must outlive a cold wake has to be flushed to the profile directory. Do not rely on warm-pause memory freezing to preserve login state.
7. Every long-lived connection to the Sprite (noVNC websocket, CDP websocket, log streams) must be treated as droppable at any moment, because pauses kill TCP even when warm. Client-side auto-reconnect is mandatory, and a Tasks-API heartbeat should hold the Sprite awake for the duration of a human takeover.
8. Put an owner-scoped takeover lease under each Bot runtime directory. Serialize assertion, acquisition, renewal, release, and expired-lease replacement with `flock`. New process and browser operations refuse work while another fresh human lease exists; durable Package file operations remain available. A failed heartbeat immediately re-shields the viewer. Leases must live on disk, not in process memory, so they survive a cold wake — and lease expiry must tolerate the Sprite having been asleep for the whole lease window.
9. Keep the Sprites token only in the backend Fly provider Plugin. Hosted clients receive the selected Bot's noVNC URL/password through authenticated, decoded DTOs, never the API token. Connectors are the documented alternative for third-party credentials that should never enter the Sprite at all.
10. Use the SDK's cancellable HTTP exec path for bounded non-interactive commands; the pinned SDK's WebSocket `execFile` path does not honor `AbortSignal` or timeouts.
11. Treat takeover as coordination rather than a security boundary for work already in flight. The User's Sprite is the trust boundary; Bots of one User are separated by directories and displays only, and Cordis contexts and directory names are not security controls.
12. Memory roots are written only by the Memory Package to object storage and presented read-only on the Sprite through the durable-root sync; other durable roots sync bidirectionally with conflict preservation ([ADR 0013](../adr/0013-bidirectional-memory-sync.md)). Vector indexes are derived; session events remain authoritative and are not mirrored by the Fly provider.
13. Consider a checkpoint after Sprite provisioning (Chromium, Xvfb, x11vnc, noVNC installed) as a cheap rebuild path; checkpoints are incremental and creation does not interrupt running processes. Never restore a checkpoint on a Sprite holding live Bot state — restore is destructive and restarts the environment.

## Configuration

Production configuration uses `SPRITES_TOKEN`, matching the current SDK README; alternate spellings are not part of the hosted contract, though the `sprite` CLI itself reads `SPRITE_TOKEN` if anything ever shells out to it. `FROCKBOT_SPRITE_NAME` overrides the base name from which stable Bot and User storage Sprite names are derived. Standalone agent-runtime development may also set `FROCKBOT_COMPUTER_PROVIDER=fly-sprite`, `FROCKBOT_BOT_ID`, `FROCKBOT_AGENT_ID`, and `FROCKBOT_SESSION_ID`; hosted identity comes from durable backend authority instead of these process variables.

## Verification limits

No Sprite token is available in the development environment, so automated tests must use fakes and live provisioning must remain an explicit manual/integration check.

The following behaviours are **not stated in the primary sources** and must be verified empirically before any of them is relied on:

1. Whether `/tmp` is tmpfs or ordinary persistent disk, and whether its contents survive a cold wake.
2. How long a Sprite stays warm before going cold — only the ~30s active→warm window is documented, and it is flagged as subject to change.
3. Whether listening sockets bound by a service are re-bound automatically on a warm resume, and whether an in-flight `accept()` loop needs restarting.
4. Whether an X server (Xvfb) and x11vnc tolerate a warm suspend/resume without losing the display, and whether Chromium survives the freeze without a renderer crash.
5. Whether Chromium flushes cookies/localStorage to the profile directory frequently enough that a cold wake does not lose a login — and whether an explicit flush or `--disk-cache-dir` tuning is needed.
6. First-read latency after a cold wake when the NVMe cache is empty and chunks must come from object storage.
7. Whether service definitions genuinely persist across `DELETE`-free restarts and checkpoint restores (the Services API docs do not state where definitions are stored).
8. Whether the Sprite HTTPS hostname is stable across hibernation, checkpoint restore, and Sprite migration between hosts — the format is documented, its invariance is not.
9. Actual quotas: max sprites per org, max concurrent active sprites, checkpoint count/retention, filesystem-API request size limits.
10. Whether an idle Sprite is ever reclaimed or deleted by the platform, and any storage cost floor for a long-idle Sprite.
11. Exact pricing, which could not be captured from a primary page in this pass.
12. Whether the Tasks API is exposed by the pinned `@fly/sprites` SDK version, or must be called over raw HTTP.

## Answered empirically on 2026-09-01

Measured against disposable Sprites while fixing the Computer's provisioning (ADR 0004). These close four of the questions above.

- **A detached background process does not keep a Sprite awake** (item 2, and the sharp edge of item 3). With a `setsid nohup` provisioner running `apt-get` and nothing else holding the Sprite, its own `/proc/uptime` and `ps` elapsed times advanced about 4 minutes across ~25 minutes of wall time: the VM was suspended and ran only while the backend's polls woke it. This matches the documented definition of activity — "Active exec/console commands, Open TCP connections, Running TTY sessions, Active Services with open connections" — which does not include in-Sprite CPU work. Anything long-running and detached must hold a Tasks-API task.
- **The Tasks API is not in `@fly/sprites@0.1.0`** (item 12), and it is not an `api.sprites.dev` endpoint either. It is served from **inside** the Sprite on the management socket `/.sprite/api.sock` (`POST`/`PUT`/`DELETE http://sprite/v1/tasks[/<name>]`), so the holder must be a process on the Sprite, not the backend. Verified working from a plain `curl` as the unprivileged `sprite` user; the socket is mode `srw-rw-rw-`.
- **No custom image, and checkpoints are per Sprite** (extends "Creation and shape"). `POST /v1/sprites` documents only `name`, `wait_for_capacity`, and `url_settings`; the pinned SDK additionally sends a `default`/`dev` `runtime` variant, and its `SpriteConfig` carries `ramMB`/`cpus`/`region`/`storageGB`. Checkpoints are addressed as `/v1/sprites/{name}/checkpoints/{id}/restore` and nothing documents restoring one onto a different Sprite, so a checkpoint cannot serve as a prebuilt image for a Sprite that does not exist yet.
- **`/.sprite/bin/node` is a shim, not a binary.** It sources `nvm.sh` and falls back to `command -v node` — itself, in a non-login shell — so a detached `node` re-execs for ever and never returns. The real toolchain directories are listed one per line in `/etc/profile.d/languages_paths`; put them on `PATH` before invoking `node` or `npm` from anything that is not a login shell.
- **The base image is Ubuntu 25.10 (`resolute`)** with `/var/lib/apt/lists` pre-populated (~40 MB) but stale enough to 404 on superseded `.debs`, and no `snap` binary. `apt-get update` costs ~6 s on a Sprite that is held awake, against the 262 s ADR 0004 recorded on one that was not. Playwright 1.55 refuses the release outright ("does not support chromium on ubuntu26.04-x64"); `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` installs a build that runs headful under Xvfb with CDP answering.

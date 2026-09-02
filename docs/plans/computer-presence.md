# Plan: Computer presence — see it, open it, take it over, keep it current

## Status

in progress. Steps 1–4 below; each records its own status when it lands.

## Why

Parity rows 24, 25, 26 and 57d. The hosted Computer card exists
(`packages/plugin-computer/src/client/ComputerCard.vue`) but only the local
development host publishes the state behind it
(`packages/plugin-fly-sprite/src/host.ts` reads `process.env`); on the hosted
Cloudflare path the card is inert. A Sprite that has been provisioned is
adopted and never reprovisioned (`apps/computer-host/container/computer.ts`,
"adopted rather than reprovisioned"), so a change to the runtime document —
`start-desktop.sh`, `control.sh`, the browser helper, `reference/` — never
reaches an existing Computer, and nothing can say so. And a User watching a
desktop touches nothing the slot reclaim reads (`last-seen`), so fifteen
minutes of looking can lose the display to another Bot.

## Resolved decisions (owner, 2026-09-02)

- **P1 Sidebar shows durable screenshots, not a live socket.** The sidebar
  strip renders the newest capture from the Bot's durable screenshots root,
  addressed by Workspace read URL, so opening the sidebar wakes nothing and
  holds nothing awake. Change detection is by `contentHash`. A live noVNC
  session exists only while the viewer is expanded.
- **P2 First click expands, second click takes over, with a confirm.** Clicking
  the strip opens the full-window viewer **view-only** (noVNC `view_only`), so
  a stray click never reaches the Bot's browser. Take control is a second,
  explicit action behind a confirm dialog that says the Bot is fenced from this
  desktop until release. Escape or closing the viewer releases control; the
  90 s lease expiry is the backstop, not the mechanism.
- **P3 Watching counts as activity.** An open viewer session refreshes the
  tenant's `last-seen` on the Computer, so the slot reclaim never takes a
  display a human is looking at. A dropped viewer socket is a `disconnected`
  phase with a reconnect action, never a frozen frame on `ready`.
- **P4 Wake on open.** Clicking the strip when the Computer is asleep wakes it
  (the `connect` → `ensure` path). AGENTS.md § Computer and Workspace is
  amended in this PR to say so: "The Computer wakes only when a Bot uses it or
  its User explicitly opens it".
- **P5 Update means two things, and only one is automatic.** The runtime
  document gets a digest, recorded on the Computer at provisioning time. On
  every `ensure`, a digest that differs from the recorded one means the
  Computer is **stale**; the host re-applies the document in place — same VM,
  same disk, nothing lost — before handing the Computer to the caller, and the
  card shows an `updating` phase with the phase label. Replacing the VM (a
  fresh Sprite, disk carried over, installed packages lost — GrokBot's "Update
  Computer") and Reset (restore a snapshot) stay **user actions** on the card
  and are deferred until cookie seeding (row 32) makes "keep logins" true.
- **P6 An update never interrupts a human or a Turn.** An in-place update does
  not start while a human-control lease is fresh. A Bot whose Turn wakes a
  Computer mid-update waits a bounded time, then receives a retryable
  `computer-updating` failure rather than a hung tool call.
- **P7 Human takeover is User-wide.** Taking control leases the `desktop-gui`
  key shared by every tenant on the box, not the per-Bot key, because the
  browser profile is shared. The Bot is told it is fenced in the tool result
  it already receives (`human-control-active`) and in the next Turn's system
  prompt while the lease is fresh.

## Step 1 — the hosted Computer state (landed: see status line)

**Status:** landed.

**Goal.** The existing card works in the deployed app: phase, viewer session,
take/release control, retry, doctor, screenshots, all over the hosted protocol.

**Owns.** A `bot`-host backend Contribution and a `gateway`-host route set in
`@frockbot/plugin-computer` (pattern: `packages/plugin-flock/src/{backend,bot}.ts`,
`packages/plugin-routines`), exact v1 DTOs in `packages/plugin-computer/src/shared.ts`,
and a hosted `ComputerState` provider in `packages/plugin-computer/src/client/`
that replaces the "unavailable" stub when the hosted transport is present.

**Rules.** The Bot Durable Object is the authority: every viewer session and
control lease is recorded there before the Computer is asked, so a lease
survives eviction and a stale one is reclaimed on reconstruction. Reading
state wakes nothing (screenshots and doctor are durable; the phase is derived
from durable records plus the provider's last answer). `connect`,
`takeControl`, `releaseControl` are authenticated commands with idempotency
keys. Viewer URLs carry the Sprite's one-time token and are never logged or
stored in a session event.

**Tests.** Gateway route decoding, ownership rejection (another User's Bot →
404, no storage write), duplicate command replay, eviction mid-lease (the
lease record is read back and renewed or released), the hosted client state
machine against a fake transport, and one `apps/cloudflare/test/*.workerd.ts`
proving a viewer session and a control lease end-to-end against the Computer
host fake.

## Step 2 — the sidebar strip, view-only expand, confirm-to-control

**Goal.** P1–P4.

**Owns.** A `frockbot.sidebar-computer` (or the nearest existing sidebar slot;
check `packages/plugin-shell` for what the shell exposes and add one if none
fits) mount in `@frockbot/plugin-computer`'s client Contribution; `ComputerCard`
grows `disconnected` and `updating` phases; the viewer session refreshes
`last-seen` (Computer host `viewer open` touches it, and the hosted client
renews the session on an interval while expanded).

**Tests.** Strip renders the newest durable capture and re-renders only on a
new `contentHash`; expand opens view-only; take control requires the confirm;
Escape releases; a dead socket flips to `disconnected`; `last-seen` is
touched by `viewer open` and by renewal (container test); the slot reclaim
skips a tenant with a fresh viewer.

## Step 3 — the runtime document digest and in-place update on wake

**Status:** landed.

**Goal.** P5, P6.

**Owns.** `packages/computer-host-runtime`: `runtimeDocumentDigestV1()` over
every script and file the provisioner installs; the provisioner writes it to
`${PROVISION_ROOT}/digest`. `apps/computer-host/container/computer.ts`: on
`open`/`ensure`, compare; on mismatch run the idempotent re-apply phases (the
file installs, not `apt`) under the provision lock, reporting `updating`
progress through the same `ComputerHostProvisioningV1` the card already
renders. Refuse to start while `human-control` is fresh. A caller arriving
mid-update waits up to a bounded time then receives `computer-updating`
(retryable) — add the code to `packages/computer-host-protocol` and map it in
`packages/plugin-fly-sprite/src/host-client.ts`.

**Tests.** Digest is stable across runs and moves on any byte change; a
Computer with no digest file is treated as stale and updated once; an update
under a fresh lease is deferred and recorded; a Bot tool call during an update
returns the retryable failure with the phase label; the card shows `updating`.

## Step 4 — User-wide human fence

**Goal.** P7.

**Owns.** `takeControl` acquires `desktop-gui`; `assert-agent` on every guarded
command checks both keys; `plugin-computer`'s system prompt section says "Your
User is controlling the Computer; do not use it" while the lease is fresh.

**Tests.** Bot B's `computer_exec` is refused while the User holds control of
Bot A's desktop; the refusal names the holder; the prompt section appears only
while fresh.

## Docs this PR updates

`docs/research/grokbot-computer.md` rows 24, 25, 26, 57d and their notes;
`docs/architecture.md` § WebUI (the Bot panel text that says the card shows a
live thumbnail) and § Computer; `docs/architecture-checks.md` rows for the new
checks; `AGENTS.md` (P4).

## What could go wrong

- **Two state machines.** `plugin-fly-sprite/src/host.ts` (local host) and the
  hosted provider must not diverge. Step 1 extracts the phase machine into
  `packages/plugin-computer/src/client/state-machine.ts` and both drive it.
- **The viewer URL is a secret.** It carries the VNC password and token. It
  crosses one DTO, is held in client memory, and is never written to a session
  event, a log, or the URL bar.
- **`last-seen` from a viewer keeps the slot but not the Sprite.** Sprites pause
  on their own idle rule; a paused Sprite drops the socket, which is exactly
  the `disconnected` phase. Do not add a keepalive for the sidebar strip.

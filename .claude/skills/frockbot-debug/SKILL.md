---
name: frockbot-debug
description: Debug a FrockBot Bot's agent loop against a deployed or local Worker through the read-only /api/debug surface — why a turn failed, why a Bot is wedged mid-run, which Composition generation failed to mount, which model binding it resolved. Use when the user says a bot "isn't working", "is stuck", "stopped", "never replied", when a turn failed with no visible reason, when the app shows "Model unavailable", when you need to look at the user's production account or Bots from a terminal, or whenever you need the raw session events (model requests, tool inputs) that the in-app transcript deliberately hides. Always reach for this skill's script before hand-writing a curl to production — it already knows where the DEBUG_TOKEN lives.
---

# FrockBot debug surface

`/api/debug/*` on the app Worker returns a Bot's durable state exactly as the
authority stored it. It is authorized by `DEBUG_TOKEN`, not by a session, so it
works while nobody is signed in and while a Bot is wedged.

It is **read-only by design**: it never recovers an active run, reconciles an
effect, or writes storage. Looking at a stuck Bot must not be what unsticks it.

## Run

**Always use the script below; do not hand-roll `curl` against production.** The
script finds the token itself — the same one from a `.claude/worktrees/*`
worktree as from the main checkout — and runs without a permission prompt. A raw
`curl` to `bot.frockbot.com` is what gets blocked by the permission classifier,
which then looks like "no production token" when the token was there all along.

```bash
.claude/skills/frockbot-debug/scripts/debug.sh users
.claude/skills/frockbot-debug/scripts/debug.sh bots <userId>
.claude/skills/frockbot-debug/scripts/debug.sh bot <userId> <botId> [--events] [--limit N] [--before CURSOR]
.claude/skills/frockbot-debug/scripts/debug.sh run <userId> <botId> <runId>
```

Defaults to production (`https://bot.frockbot.com`). Override with
`FROCKBOT_DEBUG_URL=http://127.0.0.1:8787` for a local `bun run dev:cloudflare`.

The token is kept **outside every checkout**, because a checkout is the one
thing that reliably disappears: worktrees are deleted with the session that
made them, and `.dev.vars` is gitignored, so a fresh clone never has one. On
macOS it lives in the login Keychain under the service `frockbot-debug-token`;
elsewhere in `${XDG_CONFIG_HOME:-~/.config}/frockbot/debug.env`, mode 600.
Either survives deleting the repo entirely.

Where the token is looked up, in order of precedence:

1. `FROCKBOT_DEBUG_TOKEN` in the environment — overrides every stored copy.
2. macOS Keychain, service `frockbot-debug-token`. **This is the durable one.**
3. `${XDG_CONFIG_HOME:-~/.config}/frockbot/debug.env`, for non-macOS.
4. `DEBUG_TOKEN=` in `.dev.vars` — this checkout, then the main checkout's root,
   then either one's `apps/cloudflare/.dev.vars`. Read last, and only because
   `apps/cloudflare/.dev.vars` is the copy wrangler loads when the endpoint is
   served locally.

`token store` writes the durable copy and mirrors it into the **main
checkout's** `apps/cloudflare/.dev.vars`, never a worktree's:

```bash
.claude/skills/frockbot-debug/scripts/debug.sh token store          # prompts, input hidden
.claude/skills/frockbot-debug/scripts/debug.sh token store "$TOKEN" # or non-interactively
```

`token where` answers "which copy am I actually using?" without printing the
secret — the question that otherwise costs a confused half hour inside a
worktree:

```bash
$ .claude/skills/frockbot-debug/scripts/debug.sh token where
token source: macOS Keychain (frockbot-debug-token)
checkout:     /Users/tim/repos/grokbot-headless/.claude/worktrees/some-branch
main checkout: /Users/tim/repos/grokbot-headless
base url:     https://bot.frockbot.com
```

Raw, only for a local Worker you serve yourself:

```bash
curl -s -H "authorization: Bearer $DEBUG_TOKEN" \
  "https://bot.frockbot.com/api/debug/bots/<botId>?userId=<userId>&events=true" | jq
```

## What comes back

`GET /api/debug/bots/<botId>?userId=<id>` returns one snapshot:

- `activeRunId` — a run the object still considers in flight. **This is the
  wedged-Bot signal**: an `activeRunId` whose run's `status` is `running` and
  whose event tail does not advance between two snapshots is a turn that died
  mid-flight.
- `runs[]` — durable runs, newest first, unprojected: `status`
  (`running` | `completed` | `failed` | `reconciliation-required`), `phase`,
  `failure` (the actual error text), `responseText`, `compositionGenerationId`
  (which Composition the turn was admitted under), `eventCount`.
- `runs[].events[]` — with `?events=true`, or always for a single-run lookup:
  the full session log. `model/request` (the whole assembled prompt),
  `assistant/message`, `tool/call` **with its input**, `tool/result`,
  `model/effect-not-started`, `model/reconciliation-required`. The in-app run
  view drops every one of those; this is the only place they are readable.
- `composition` — `currentGenerationId`, its `status`,
  `lastKnownGoodGenerationId`, and the last few generations each with their
  recorded `failures[]` (message + diagnostics) and `quarantined` flag.
- `configuration` — the Bot settings view: profile, notifications, and
  `packageValues` (a Bot-scoped model override lives under the Custom models
  Package id there). It does **not** carry the resolved model binding; that is
  resolved per Turn from the User's enabled Packages and Connections.
- `notifications` — unacknowledged Bot notifications.

**Not on this surface:** the User settings view — enabled Packages,
Connections, the account model, the platform model. Those live in the User
Durable Object and are only readable through the session-authenticated
`GET /api/settings` (open the app, or copy the response from the browser's
network tab). To reason about an account's enablement state from here, combine
`runs[].failure` (the resolver's failure sentence names the Connection or
Package) with what the user can see under Settings → Plugins / Models.

Events are byte-bounded (~512KB per snapshot). When a run is trimmed,
`omittedEvents` counts the **oldest** events dropped — the tail is kept, because
that is where a failure is described.

## Reading it — the usual causes, in the order worth checking

1. **Turn never started.** `runs` is empty, or the newest run predates when the
   user says they messaged. An unresolvable model binding refuses admission
   before a run exists, so nothing is written here: the composer label in the
   app shows the resolver's failure sentence verbatim, and the User's Packages
   and Connections are in the session-authenticated `/api/settings`. Accounts
   created before a platform-default or enablement change are the usual cause
   (see `docs/architecture.md`, durable migrations).
2. **Composition will not mount.** `composition.currentStatus` is `pending` or
   `failed`, or the newest generation carries `failures[]` /
   `quarantined: true`. The Bot is running (or refusing to run) on
   `lastKnownGoodGenerationId`. The failure `message` and `diagnostics` name the
   member that would not compile or mount.
3. **Turn failed.** A run with `status: "failed"` — `failure` is the raw error.
   Then read the event tail for the last `model/request` and `tool/result`
   before it.
4. **Turn wedged.** `activeRunId` set, `status: "running"`, tail static across
   two snapshots. Read the last event: a `model/request` with no following
   `assistant/message` is a provider call that never returned; a `tool/call`
   with no `tool/result` is a tool that never came back.
5. **Uncertain effect.** `status: "reconciliation-required"` or a
   `model/reconciliation-required` event — the run made a call whose outcome
   was never settled. It stays scheduled; only an explicit resume in the app
   retrieves it. Do **not** try to force this from the debug surface: it has no
   write route, on purpose.

## Complements

`/api/debug` shows _durable_ state. For a live tail of console output and
uncaught exceptions during a reproduction:

```bash
cd apps/cloudflare && bunx wrangler tail --format pretty
```

Use them together: `wrangler tail` catches what never got written down;
`/api/debug` catches what happened before you started watching.

## Rotating the token

A Cloudflare secret cannot be read back, so the deployed value and the stored
one are only ever the same because rotation writes both in one go:

```bash
openssl rand -hex 32 >/tmp/tok
(cd apps/cloudflare && bunx wrangler secret put DEBUG_TOKEN --env="" </tmp/tok)
.claude/skills/frockbot-debug/scripts/debug.sh token store "$(cat /tmp/tok)"
rm /tmp/tok
```

That stores the durable copy and mirrors it into the main checkout's
`apps/cloudflare/.dev.vars` for local serving. Confirm with `token where`, then
`debug.sh users`. Removing the secret disables the surface entirely — the
routes 404, and do not admit they exist.

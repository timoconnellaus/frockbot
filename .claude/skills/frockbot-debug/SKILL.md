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
script finds the token itself — from the main checkout even when run inside a
`.claude/worktrees/*` worktree, which never has its own `.dev.vars` — and runs
without a permission prompt. A raw `curl` to `bot.frockbot.com` is what gets
blocked by the permission classifier, which then looks like "no production
token" when the token was there all along.

```bash
.claude/skills/frockbot-debug/scripts/debug.sh users
.claude/skills/frockbot-debug/scripts/debug.sh bots <userId>
.claude/skills/frockbot-debug/scripts/debug.sh bot <userId> <botId> [--events] [--limit N] [--before CURSOR]
.claude/skills/frockbot-debug/scripts/debug.sh run <userId> <botId> <runId>
```

Defaults to production (`https://bot.frockbot.com`). Override with
`FROCKBOT_DEBUG_URL=http://127.0.0.1:8787` for a local `bun run dev:cloudflare`.
The token is read from `DEBUG_TOKEN=` in `.dev.vars` at the **repository root**,
falling back to `apps/cloudflare/.dev.vars`, unless `FROCKBOT_DEBUG_TOKEN` is
set. The root file is the one to edit: this token is operator tooling rather
than one Worker's configuration, so it belongs where any command in the
monorepo finds it. Keep a copy in `apps/cloudflare/.dev.vars` only if you serve
the endpoint locally — that is the only copy wrangler loads. The local and
deployed tokens are the same value today, so the same command works against
both.

Where the token lives, in order of precedence:

1. `FROCKBOT_DEBUG_TOKEN` in the environment.
2. `DEBUG_TOKEN=` in `.dev.vars` at the **main checkout's** repository root
   (`/Users/tim/repos/grokbot-headless/.dev.vars`). This is the production
   token; the file is gitignored.
3. `DEBUG_TOKEN=` in `apps/cloudflare/.dev.vars` — the same value, kept there
   only because it is the copy wrangler loads when serving locally.

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

```bash
cd apps/cloudflare && bunx wrangler secret put DEBUG_TOKEN --env=""
```

Then update `DEBUG_TOKEN` in `.dev.vars` at the repository root (and in
`apps/cloudflare/.dev.vars` if you serve the endpoint locally). Removing the secret
disables the surface entirely — the routes 404, and do not admit they exist.

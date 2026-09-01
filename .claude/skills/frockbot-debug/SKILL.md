---
name: frockbot-debug
description: Debug a FrockBot Bot's agent loop against a deployed or local Worker through the read-only /api/debug surface — why a turn failed, why a Bot is wedged mid-run, which Composition generation failed to mount, which model binding it resolved. Use when the user says a bot "isn't working", "is stuck", "stopped", "never replied", when a turn failed with no visible reason, or whenever you need the raw session events (model requests, tool inputs) that the in-app transcript deliberately hides.
---

# FrockBot debug surface

`/api/debug/*` on the app Worker returns a Bot's durable state exactly as the
authority stored it. It is authorized by `DEBUG_TOKEN`, not by a session, so it
works while nobody is signed in and while a Bot is wedged.

It is **read-only by design**: it never recovers an active run, reconciles an
effect, or writes storage. Looking at a stuck Bot must not be what unsticks it.

## Run

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

Raw, if you prefer curl:

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
- `configuration` — the resolved Bot settings view: profile, model binding,
  assignments. Absent if settings would not resolve at all.
- `notifications` — unacknowledged Bot notifications.

Events are byte-bounded (~512KB per snapshot). When a run is trimmed,
`omittedEvents` counts the **oldest** events dropped — the tail is kept, because
that is where a failure is described.

## Reading it — the usual causes, in the order worth checking

1. **Turn never started.** `runs` is empty, or the newest run predates when the
   user says they messaged. Look at `configuration.model` — an unbound or
   unavailable model binding means no turn is admitted. Cross-check the user's
   connections in `/api/settings`.
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

# Journey 1 — local dev — 2026-09-03 (incomplete)

**Target.** Local dev. Client `http://127.0.0.1:5173` (vite) in front of
`wrangler dev --env development` on `http://127.0.0.1:8787`.

**Stack mode.** `wrangler dev --local`. The `AI` binding is **not** proxied to
the account, so a real model turn was expected to fail. Driver: ego-browser,
task space `frockbot dogfood journey 1`.

**Outcome.** Stopped early. Two things: (1) the vite client at `:5173`
**never renders at all** — a hard blocker, see friction #1 — so the journey was
re-driven against `:8787/?as_user=development`; (2) after the Bot was created
the user took control of the ego-browser task space, which is a hard stop, so
the first message was never sent and the model failure was never observed.

## Steps performed

1. Opened `http://127.0.0.1:5173`. Blank white page. No sign-in button, no
   shell, `#app` empty. Reloaded twice — same. (friction #1)
2. Diagnosed via an injected `window.onerror` probe: a single uncaught error
   from `packages/plugin-auth/src/client/browser.ts`.
3. Switched to the documented equivalent local target
   `http://127.0.0.1:8787/?as_user=development` (journeys.md "Local dev"). The
   shell rendered and the first-run Bot dialog **"Add to your flock"** opened by
   itself. Screenshot: `01-after-sign-in.png`.
4. Typed `Dogfood Bot` into **Bot name**, pressed **Create Bot**. The Bot was
   created (`dogfood-bot-1f5dca62`).
5. **Blocked.** The next browser call returned "The user has taken control of
   this task space". Per the ego-browser contract this is a hard stop; control
   was not taken back. No message was sent.

## Screenshots

- `01-after-sign-in.png` — the shell at `:8787` with the first-run dialog open.
  Note the composer behind it already reads **Model unavailable**.

## Proof results

Queried with `.claude/skills/frockbot-debug/scripts/debug.sh` against
`FROCKBOT_DEBUG_URL=http://127.0.0.1:8787`, plus `GET /api/settings`.

| Proof                      | Result                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot configuration revision | `configuration.revision: 0`, `profile.name: "Dogfood Bot"`, `packageValues: {}` — **pass** (untouched settings)                                                                                                                                                                        |
| Composition                | `currentGenerationId === lastKnownGoodGenerationId` = `2026-09-03T01:12:28.035Z:f2423b9751967eb8`, `origin: bootstrap`, 36 members, `failures: []`, `quarantined: false` — **pass**                                                                                                    |
| Turn admission / outcome   | **Not obtained.** `runs: []` — no message was ever sent (hard stop above)                                                                                                                                                                                                              |
| Resolved model binding     | `GET /api/settings` → `platformModel: { connectionId: "flock-ai-ambient", providerModelId: "@flock/auto" }`; `packages[]` has `custom-models` in state `disabled`; the `flock-ai-ambient` Connection is `state: ready` with `modelCatalog.state: fresh` and no key material — **pass** |
| Model-turn failure event   | **Not obtained.** No `model/request`, no `turn/end` — nothing ran                                                                                                                                                                                                                      |
| User settings revision     | `3`                                                                                                                                                                                                                                                                                    |

The one journey-1 proof that fails on evidence already in hand: the workspace
subtitle does **not** read `Auto (recommended) · Flock AI`. It reads
**Model unavailable**, on a client whose `/api/settings` resolves `@flock/auto`
against a `ready` Connection. See friction #3.

## Friction log

| #   | Journey | Step                      | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Severity | Repro test file                |
| --- | ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| 1   | 1       | 1 — open the app          | `http://127.0.0.1:5173` renders a **blank white page**. No error text, no spinner, nothing to click, nothing to report. The client throws `Uncaught Error: Hosted admin projection is invalid` from `packages/plugin-auth/src/client/browser.ts:34` and the whole Vue app fails to mount. Cause: `apps/cloudflare/index.html` (the vite dev entry) stamps `data-frockbot-user-id` and `data-frockbot-auth-mode` on `<body>` but **not** `data-frockbot-is-admin`, which `embeddedIsAdmin()` requires. The Worker-rendered HTML (`apps/cloudflare/src/user-application.ts:99`) does emit it, which is why `:8787` works and `:5173` does not. Every dogfood journey that follows the documented `bun run dogfood:dev` + `:5173` path is dead on arrival. | blocker  | `apps/cloudflare/e2e/*.e2e.ts` |
| 2   | 1       | 1 — before creating a Bot | With zero Bots the sidebar says "No Bots yet. Add your first sheep." while the main pane simultaneously renders a Bot called **Barebones** with the error state "**Barebones isn't ready.** / Check this Bot's model Connection." A new user's first screen shows a broken Bot they have never heard of and cannot fix. `debug.sh bots development` confirms `bots: []` — Barebones does not exist.                                                                                                                                                                                                                                                                                                                                                     | annoying | `apps/cloudflare/e2e/*.e2e.ts` |
| 3   | 1       | 1 — the composer          | The message box placeholder reads **"Model unavailable"** and is disabled, before any message is sent and before any Bot exists — even though `GET /api/settings` resolves `platformModel` to `@flock/auto` on a `flock-ai-ambient` Connection in `state: ready`. Journey 1's proof asks for the subtitle `Auto (recommended) · Flock AI` and explicitly for **no** "Model unavailable". The wording also tells a non-technical user nothing: no reason, no next step, no link to Models.                                                                                                                                                                                                                                                               | blocker  | `apps/cloudflare/e2e/*.e2e.ts` |
| 4   | 1       | 1 — sign-in               | The "Continue as local developer" sign-in could not be exercised at all, because of #1. On `:8787` the `?as_user=` path bypasses the button entirely, so the documented sign-in click is untested by this run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | papercut | `apps/cloudflare/e2e/*.e2e.ts` |
| 5   | 1       | 3 — send a message        | Not reached. The ego-browser task space was taken over by the user mid-run, which is a hard stop. The model failure this run existed to characterise is **still unobserved**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | n/a      | —                              |

## To finish this run

Send `hello, what can you do?` to `dogfood-bot-1f5dca62` and re-read
`debug.sh bot development dogfood-bot-1f5dca62 --events`, capturing the
`turn/admission` outcome, the `model/request` binding, and the exact failure on
`turn/end` — plus the wording the composer shows the user when it fails.

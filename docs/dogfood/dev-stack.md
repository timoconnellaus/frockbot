# The dogfood dev stack

One scripted local stack a browser-driving agent can sign into: the deployed
Worker (`apps/cloudflare/src/index.ts`) under `wrangler dev`, the shipped Vue
client under vite, and — when Cloudflare credentials are present — real Workers
AI through the `flock` AI Gateway.

```bash
bun run dogfood:dev  # or scripts/dogfood/dev-stack.sh
bun run dogfood:stop # or scripts/dogfood/dev-stack.sh stop
scripts/dogfood/dev-stack.sh status
```

`start` is idempotent: it kills any stale wrangler/workerd/vite first, rebuilds
and reseeds, then waits for health before printing.

## Prerequisites

- `bun install` in this checkout (a worktree does not inherit the main
  checkout's `node_modules`).
- **A logged-in wrangler.** Run `bunx wrangler login` in an interactive
  terminal from `apps/cloudflare`, or export `CLOUDFLARE_API_TOKEN`. The
  `development` environment marks `AI`, `MEMORY_FILES` and `MEMORY_INDEX`
  `remote: true`, so `wrangler dev` opens a proxy session against the Cloudflare
  API — that proxy is what makes the model real. Without it wrangler refuses to
  start, so the script falls back to `wrangler dev --local` with a loud warning:
  the UI and sign-in work, every model turn fails.
- `apps/cloudflare/.dev.vars`. The script copies it from
  `$FROCKBOT_MAIN_CHECKOUT` (default `~/repos/grokbot-headless`) when missing.

### Required `.dev.vars` keys (names only)

| Key                                                 | Why                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `CREDENTIAL_KEYRING`                                | Mandatory. Without it the User Durable Object throws `Credential Store Contribution is not configured` and no Bot can be created. |
| `ALLOW_DEVELOPMENT_AUTH`                            | The `development` identity seam. The script also passes `--var ALLOW_DEVELOPMENT_AUTH:true`.                                      |
| `DEBUG_TOKEN`                                       | Authorizes the read-only `/api/debug/*` surface; absent, those routes 404.                                                        |
| `SPRITES_TOKEN`                                     | The "this deployment has a Computer" flag.                                                                                        |
| `COMPUTER_HOST_TOKEN`                               | The shared secret the app Worker presents to the Computer host. **Not currently in the checkout's `.dev.vars`** — see below.      |
| `FROCKBOT_AUTHORIZATION_STATE_SECRET`, `COMPOSIO_*` | Connection flows; not needed for a model turn.                                                                                    |

`BETTER_AUTH_SECRET` / `GOOGLE_CLIENT_*` are only needed for real Google
sign-in. Development sign-in does not touch them.

## What the script does

1. Stops stale processes. `wrangler dev` is a Node parent supervising workerd;
   killing one leaves the other holding :8787, and the next `wrangler dev` then
   silently picks :8788. It `pkill -9`s both plus anything on the two ports.
2. `bun run artifact:build` in `apps/cloudflare`.
3. Seeds `applications/foundation-v1.mjs` into the local
   `frockbot-application-artifacts` bucket.
4. Applies the local D1 auth migrations (`frockbot-auth-development`). Without
   them `/api/debug/users` answers `D1_ERROR: no such table: user`.
5. Publishes a Package Catalog generation with `scripts/publish-catalog.ts` and
   seeds the pointer, the index and every entry document into
   `frockbot-package-catalog`. Without it `GET /catalog/v1/index` is 503 and
   the Plugins surface opens with a load error.
6. Starts `wrangler dev --env development --ip 127.0.0.1 --port 8787
--var ALLOW_DEVELOPMENT_AUTH:true`, then `vite --host 127.0.0.1` on :5173.

Logs land in `$CLAUDE_JOB_DIR/tmp` when that is set, otherwise
`.dogfood/logs/{wrangler,vite}.log`. `.dogfood/` is gitignored.

## Signing in

Open <http://127.0.0.1:5173> and click **Continue as local developer**. The
button appears only on `localhost` / `127.0.0.1` / `::1` and uses the fixed
`development` identity — no Google credentials. The vite proxy also stamps
`x-frockbot-user-id: development` onto `/api` and `/app-manifest`, so requests
from the page are already that User.

Use :5173, not :8787 — :8787 serves the built artifact without the proxy
header, and `?as_user=development` is the equivalent there.

## Health and debugging

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'x-frockbot-user-id: development' http://127.0.0.1:8787/app-manifest # 200

FROCKBOT_DEBUG_URL=http://127.0.0.1:8787 \
  .claude/skills/frockbot-debug/scripts/debug.sh users
FROCKBOT_DEBUG_URL=http://127.0.0.1:8787 \
  .claude/skills/frockbot-debug/scripts/debug.sh bots development
FROCKBOT_DEBUG_URL=http://127.0.0.1:8787 \
  .claude/skills/frockbot-debug/scripts/debug.sh bot development BOT_ID --events
```

`/api/debug/*` is read-only and authorized by `DEBUG_TOKEN`, not a session, so
it works while a Bot is wedged. See `.claude/skills/frockbot-debug/SKILL.md`.

## The model

`provider-flock-ai` is a first-party Package installed by default and its
Connection is ambient (`flock-ai-ambient`), so no Connection setup is needed —
`Auto (recommended)` (`@frock/auto`) should be selectable straight away. At the
Worker seam (`apps/cloudflare/src/frock-ai.ts`) it calls
`env.AI.gateway("flock").run({ provider: "compat", endpoint:
"chat/completions" })` with `dynamic/flock-auto`, so a real turn needs:

- the `AI` binding proxied to the account (wrangler auth, above), and
- an AI Gateway named `flock` on the account with a dynamic route `flock-auto`
  whose target model is configured in the dashboard, never in code.

If the model reads "Model unavailable", check the wrangler log for a failed
remote proxy session first.

## A live Fly Sprite Computer

Not reachable from this stack today, and the blocker is a secret rather than
the script.

- `COMPUTER_HOST` is a service binding to `frockbot-computer-host`, and a
  service binding only resolves to a Worker in the **same** `wrangler dev`
  session. In this one it reads `[not connected]` (so does `PACKAGE_BUNDLER` —
  same as `bun run dev:cloudflare`).
- The Computer gate is `Boolean(env.COMPUTER_HOST && env.COMPUTER_HOST_TOKEN)`
  (`apps/cloudflare/src/bot-state.ts`). With either missing the Computer card
  reads "Set SPRITES_TOKEN to attach a computer" — that string is the fast
  check that wiring failed.

Two ways to close it, both needing `COMPUTER_HOST_TOKEN` in
`apps/cloudflare/.dev.vars`:

1. **Point at the deployed host.** Add `"remote": true` to the `COMPUTER_HOST`
   service binding in the `development` env of `apps/cloudflare/wrangler.jsonc`
   and use the deployed host's `COMPUTER_HOST_TOKEN`. No Docker. This is a
   config change nobody has made yet.
2. **Run the host locally.** Add `-c apps/computer-host/wrangler.jsonc` to the
   `wrangler dev` invocation and give that app its own `.dev.vars` with
   `SPRITES_TOKEN` and the same `COMPUTER_HOST_TOKEN`. It declares a container
   (`FlyHostContainer`, built from `apps/computer-host/Dockerfile`), so Docker
   must be running. Note that a second config in the same session inherits
   `--env development`, which the auxiliary configs do not define — that is
   what makes this the fiddlier of the two.

Nothing has to reach _back_ into the stack: the Sprite never calls the host.
All traffic is the container egressing to `api.sprites.dev`
(`apps/computer-host/src/egress.ts`), so a locally-run host needs no public
URL. Only the browser needs to reach the Sprite's noVNC viewer URL.

In the UI, the Computer is the sidebar button labelled `Open Computer, <phase>`
and the Computer card in Bot settings; first click opens a view-only overlay,
then **Take control** and confirm.

## Gotchas

- Do **not** copy `.wrangler/state` between worktrees.
- If `curl :8787` connects but the app looks stale, a stray workerd from a
  previous run is serving it. `dev-stack.sh stop` handles this; a plain
  `kill` on the wrangler PID does not.
- `GET /catalog/v1/index` answers 401 unauthenticated. That is correct, not a
  seeding failure; check it through the app instead.
- The `env.development inherits the top-level routes` warning on every wrangler
  invocation is pre-existing config noise, not a stack problem.

# FrockBot

FrockBot is an experimental Cordis-first desktop environment for persistent conversational bots. Host, agent, and WebUI capabilities are composed as plugins across explicit Electron process seams.

The current vertical slice includes:

- an Electron main-process Cordis root and authenticated loopback WebUI host;
- a sandboxed Cordis WebUI/Vue renderer composed as a client plugin;
- a separate Cordis utility process with an event-sourced custom agent loop;
- streamed text, journaled tool calls, cancellation, restart, and lifecycle cleanup;
- an executable Cordis loader, dependency, isolation, WebSocket, CSP, and Electron foundation proof.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/adr/0001-cordis-application-spine.md`](docs/adr/0001-cordis-application-spine.md).

## Requirements

- [Bun](https://bun.sh) 1.3 or newer

## Development

```bash
bun install
bun run dev
```

The deterministic foundation provider runs without credentials. To use an OpenAI-compatible endpoint:

```bash
FROCKBOT_LLM_BASE_URL="https://api.example.com/v1" \
  FROCKBOT_LLM_MODEL="model-id" \
  FROCKBOT_LLM_API_KEY="..." \
  bun run dev
```

`FROCKBOT_LLM_API_KEY` is optional for local endpoints. `FROCKBOT_LLM_PROVIDER_ID` customizes the provider label.

To attach the built-in Fly Sprites Computer provider Package, provide a Sprites token. The provider sits behind the provider-neutral Computer interface used by generic tools, memory, and viewer UI. It assigns a distinct persistent Sprite and Chromium/noVNC desktop to each Bot, plus a separate User-scoped storage Sprite for global memory; `FROCKBOT_SPRITE_NAME` optionally selects the base name used to derive Bot and User storage Sprite names and `FROCKBOT_BOT_ID`/`FROCKBOT_AGENT_NAME` bind the desktop host to a Bot. `FROCKBOT_COMPUTER_PROVIDER` selects an installed provider and currently defaults to `fly-sprite`.

```bash
SPRITES_TOKEN="..." \
  FROCKBOT_SPRITE_NAME="frockbot-barebones" \
  bun run dev
```

The Computer panel shows the selected Bot's live browser. **Take control** creates a Bot-scoped lease that blocks new process and browser actions while leaving durable Package file operations available; **Release control** returns it to the Bot. A token-routed noVNC gateway serves each Bot desktop through that Bot Sprite's public HTTPS URL. Shells start in `/workspaces/<bot-key>` with `HOME=/home/box`. Canonical desktop memory Markdown and derived index metadata live in the memory Package's private Computer directory under `/home/box/agent-data`; cloud runtimes retain the explicit R2/Vectorize adapter. See [`docs/research/fly-sprites-computer.md`](docs/research/fly-sprites-computer.md) for provider constraints and primary sources.

Electron's installer script is explicitly allowed through the root `trustedDependencies` setting. If Electron was installed before that setting existed, rebuild its binary once:

```bash
node apps/desktop/node_modules/electron/install.js
```

## Checks

```bash
bun run typecheck
bun test
bun run build
bun run proof:cordis
```

GitHub Actions runs these checks on pushes to `main` and on pull requests. Dependabot checks Bun/npm dependencies and GitHub Actions weekly.

## Releases

Pushing a valid SemVer tag such as `v0.1.0` or `v0.1.0-rc.1` (build metadata such as `+build.1` is rejected because npm does not accept it in package versions) validates the monorepo, publishes every workspace under `packages/` to npm with the tag's version, and creates a GitHub release with generated notes. Prereleases use npm's `next` dist-tag rather than `latest`. Application workspaces remain private.

For the first publication, add a granular npm automation token with access to the `@frockbot` scope as the `NPM_TOKEN` repository secret. After each package exists on npm, configure its trusted publisher for repository `timoconnellaus/frockbot` and workflow `release.yml`; the workflow can then publish through GitHub OIDC without a long-lived token, and `NPM_TOKEN` can be deleted.

## Production deployment

After CI succeeds on a push to `main`, `ci.yml` deploys two Cloudflare Workers through the GitHub `production` environment:

- `apps/marketing` serves the public marketing site at `https://frockbot.com` and redirects `www.frockbot.com` to the apex domain;
- `apps/cloudflare` serves the authenticated application and API at `https://bot.frockbot.com`.

The app deployment applies remote D1 migrations, uploads the immutable application artifact to R2 under its SHA-256 digest, sets `DEFAULT_APPLICATION_HASH` to that digest, and then deploys the Worker, so each build is content-addressed and never overwrites a previously deployed artifact. Both Wrangler configurations declare their custom domains, so Cloudflare creates and maintains the required proxied DNS records when the Workers are first deployed.

Create the resources named in `apps/cloudflare/wrangler.jsonc` before the first app deployment:

- D1 database `frockbot-auth`;
- R2 buckets `frockbot-application-artifacts` and `frockbot-memory-files`;
- Vectorize index `frockbot-memory` with 768 cosine dimensions (`bunx wrangler vectorize create frockbot-memory --preset @cf/baai/bge-base-en-v1.5`).

Configure these GitHub `production` environment values:

| Type     | Name                        | Purpose                                                                       |
| -------- | --------------------------- | ----------------------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`      | Cloudflare token permitted to edit Workers, D1, and R2 for the target account |
| Secret   | `CLOUDFLARE_ACCOUNT_ID`     | Cloudflare account containing the production resources                        |
| Variable | `CLOUDFLARE_D1_DATABASE_ID` | Immutable ID of `frockbot-auth`                                               |
| Variable | `BETTER_AUTH_URL`           | Set to `https://bot.frockbot.com`                                             |
| Secret   | `BETTER_AUTH_SECRET`        | Better Auth secret with at least 32 random characters                         |
| Secret   | `GOOGLE_CLIENT_ID`          | Google Web application OAuth client ID                                        |
| Secret   | `GOOGLE_CLIENT_SECRET`      | Google Web application OAuth client secret                                    |

Run `./scripts/setup-production.sh` to create the scoped Cloudflare token, configure the Google OAuth web client, save the remaining secrets to the GitHub `production` environment, and verify the completed configuration.

Register `https://bot.frockbot.com/api/auth/callback/google` as an authorized Google redirect URI. The deploy token must include Workers Scripts and Workers Routes edit access, and the `frockbot.com` zone must be active in the same Cloudflare account. Production deployment intentionally does not create or delete D1, R2, or Vectorize resources.

The desktop smoke path can capture the connected UI without a model call:

```bash
FROCKBOT_SMOKE_SCREENSHOT="$PWD/artifacts/frockbot.png" \
  bun run --filter @frockbot/desktop start
```

To exercise one streamed custom-loop turn and its WebUI projection:

```bash
FROCKBOT_SMOKE_SCREENSHOT="$PWD/artifacts/frockbot-chat.png" \
  FROCKBOT_SMOKE_PROMPT='/echo FrockBot is ready.' \
  bun run --filter @frockbot/desktop start
```

`bun run --filter @frockbot/desktop package` builds unsigned installers (DMG, NSIS, AppImage) into `apps/desktop/release/`. `bun run icons:generate` regenerates the desktop, Android, and iOS app icons from the canonical `assets/marketing/app-icon/frockbot-icon-1024.png`; it requires ImageMagick 7 and macOS `iconutil`.

## Structure

```text
apps/
  desktop/          Electron Cordis host, WebUI server, and window plugins
  agent-runtime/    Transport-neutral Cordis agent composition plus Electron bridge
  cloudflare/       User application loader, Dynamic Worker artifact, and bot state
  marketing/        Public frockbot.com site and static-assets Worker
  cordis-poc/       Executable pinned Cordis/Electron/WebUI foundation proof
packages/
  agent-core/       Session, LLM, prompt, tool, and agent Cordis services
  agent-loop/       Concrete event-sourced custom agent-loop plugin
  computer-core/    Provider registry and capability interfaces for Computers
  plugin-catalog/   Manifest decoding, scoped activation, and rollback
  plugin-clock/     Reference package with agent, host, and WebUI contributions
  plugin-computer/  Generic Computer tools, prompt, state, and viewer UI
  plugin-fly-sprite/ Fly Sprites Computer provider and takeover adapter
  plugin-memory/    Computer-workspace or R2-backed durable Markdown memory
  protocol/         Commands and events shared across process seams
  provider-openai-compatible/  Streaming production model adapter
  webui-shell/      FrockBot Cordis WebUI/Vue client plugin
docs/
  architecture.md   Current system shape
  adr/              Architectural decisions
  research/         Primary-source compatibility research
```

## Cloudflare vertical slice

The Cloudflare application builds one immutable Dynamic Worker artifact containing both the user-facing UI and Cordis agent runtime. The gateway loads it as `userId:applicationHash`; bot run state is stored through a user-scoped capability backed by one Durable Object per bot.

```bash
bun run --filter @frockbot/cloudflare test
bun run --filter @frockbot/cloudflare typecheck
bun run --filter @frockbot/cloudflare build
```

Run the real Electron renderer against the local Worker backend with Wrangler, Vite renderer HMR, and Electron main-process HMR:

```bash
bun run dev:cloudflare:electron
```

The command builds and seeds the Dynamic Worker artifact, then starts Wrangler on port 8787, the renderer development server on port 5173, and Electron pointed at that renderer. On `localhost`, `127.0.0.1`, or `::1`, the sign-in screen includes **Continue as local developer**; it uses the fixed `development` identity and does not require Google credentials. The identity is accepted by the backend only when local development authentication is enabled.

For Worker-only development, place the artifact in local R2 before starting Wrangler:

```bash
cd apps/cloudflare
bun run artifact:build
bunx wrangler --env development r2 object put \
  frockbot-application-artifacts/applications/foundation-v1.mjs \
  --file dist/artifacts/foundation-v1.mjs --local
bunx wrangler dev --env development --var ALLOW_DEVELOPMENT_AUTH:true
```

Then open `http://localhost:8787/?as_user=alice`. CLI requests may instead send `x-frockbot-user-id: alice`. These query/header/cookie seams are enabled only by the local `ALLOW_DEVELOPMENT_AUTH` setting and must be disabled in production.

### Google authentication

The hosted gateway uses Better Auth with D1 and Google social login. Electron uses Better Auth's official desktop integration: sign-in opens in the system browser, returns over the `com.frockbot.desktop` protocol, and stores encrypted session material in the main process rather than the renderer.

For local Google sign-in:

```bash
cp apps/cloudflare/.dev.vars.example apps/cloudflare/.dev.vars
# Replace every value in .dev.vars, then initialize the local D1 database.
cd apps/cloudflare
bunx wrangler d1 migrations apply AUTH_DB --env development --local
bun run dev:electron
```

Create a Google **Web application** OAuth client and register this local redirect URI:

```text
http://127.0.0.1:8787/api/auth/callback/google
```

For production, keep `ALLOW_DEVELOPMENT_AUTH` unset and configure the GitHub `production` environment described above. `BETTER_AUTH_URL` is `https://bot.frockbot.com`; register `https://bot.frockbot.com/api/auth/callback/google` with Google. Never commit `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, or `GOOGLE_CLIENT_SECRET`.

The desktop host must receive both `FROCKBOT_APPLICATION_URL` (the public application URL loaded by its sandboxed window) and `FROCKBOT_AUTH_BASE_URL` (the Better Auth Worker origin). They may be the same hosted origin. If `FROCKBOT_APPLICATION_URL` is absent, the desktop loads its local host; if `FROCKBOT_AUTH_BASE_URL` is absent, it does not initialize hosted authentication.

The memory Package has a provider-neutral document-store seam. Desktop runtimes store canonical Markdown and incremental index metadata in private durable directories on the selected Computer; the Fly adapter places them on Sprite disk. Cloudflare runtimes use R2 for canonical documents and Vectorize with 768-dimensional embeddings from `@cf/baai/bge-base-en-v1.5`. Local Cloudflare development selects Wrangler's `development` environment and uses the remote-only development resources `frockbot-memory-files-development` and `frockbot-memory-development`; local application artifacts, D1, and Durable Objects remain isolated in `.wrangler/state`. The development memory resources are separate from the production names listed in [Production deployment](#production-deployment).

Memory has two user-private tiers: **agent** memory belongs to one bot, while **global** memory is shared by all of that user's bots. Reads and recall check both by default; when the same path exists in both tiers, the agent copy wins. Writes default to the safer agent tier.

## Security model

Renderers use `nodeIntegration: false`, context isolation, Chromium sandboxing, authenticated loopback transport, origin checks, and restrictive content security policy. Agent execution runs in an Electron utility process.

Cordis contexts provide composition and lifecycle ownership, not security isolation. Generated or unreviewed executable plugins must run inside a restricted process, container, or micro-VM rather than Electron main; untrusted rich UI must run in a sandboxed frame rather than the trusted WebUI context.

## Current limitations

- model configuration currently uses environment variables rather than onboarding UI;
- sessions are currently in memory;
- Fly Sprite live provisioning requires a valid Sprites token and has not been exercised by repository CI;
- Fly uses one Sprite per Bot, but live isolation still depends on Fly's VM and network enforcement and has not been exercised by repository CI;
- the local derived memory vector index is process-local and rebuilt through canonical-file fallback; cloud Vectorize remains durable;
- Kubernetes and Cloudflare Containers can now be added as provider Packages, but adapters are not implemented yet;
- the manifest-driven package catalog works for built-in packages, but external package discovery and download are not implemented;
- packaged applications are not code signed.

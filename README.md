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

To attach the built-in Fly Sprite computer package, provide a Sprites token. The first start provisions Chromium and noVNC in a persistent Sprite; `FROCKBOT_SPRITE_NAME` optionally selects its stable name.

```bash
SPRITES_TOKEN="..." \
FROCKBOT_SPRITE_NAME="frockbot-barebones" \
  bun run dev
```

The computer panel shows the live browser. **Take control** creates a lease that blocks new agent computer actions while you enter credentials; **Release control** returns it to the bot. The noVNC service uses a high-entropy password but is exposed through the Sprite's public HTTPS URL so Electron can embed it. See [`docs/research/fly-sprites-computer.md`](docs/research/fly-sprites-computer.md) for security constraints and primary sources.

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

## Structure

```text
apps/
  desktop/          Electron Cordis host, WebUI server, and window plugins
  agent-runtime/    Transport-neutral Cordis agent composition plus Electron bridge
  cloudflare/       User application loader, Dynamic Worker artifact, and bot state
  cordis-poc/       Executable pinned Cordis/Electron/WebUI foundation proof
packages/
  agent-core/       Session, LLM, prompt, tool, and agent Cordis services
  agent-loop/       Concrete event-sourced custom agent-loop plugin
  plugin-catalog/   Manifest decoding, scoped activation, and rollback
  plugin-clock/     Reference package with agent, host, and WebUI contributions
  plugin-fly-sprite/ Persistent Fly Sprite computer, browser tools, and takeover UI
  plugin-memory/    R2/Vectorize-backed agent and global durable memory
  protocol/         Commands and events shared across process seams
  provider-openai-compatible/  Streaming production model adapter
  webui-shell/      FrockBot Cordis WebUI/Vue client plugin
docs/
  architecture.md   Accepted Cordis-first target architecture
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

The command builds and seeds the Dynamic Worker artifact, then starts Wrangler on port 8787, the renderer development server on port 5173, and Electron pointed at that renderer. For Worker-only development, place the artifact in local R2 before starting Wrangler:

```bash
cd apps/cloudflare
bun run artifact:build
bunx wrangler r2 object put \
  frockbot-application-artifacts/applications/foundation-v1.mjs \
  --file dist/artifacts/foundation-v1.mjs --local
bunx wrangler dev
```

Then open `http://localhost:8787/?as_user=alice`. CLI requests may instead send `x-frockbot-user-id: alice`. These query/header/cookie seams are enabled only by the local `ALLOW_DEVELOPMENT_AUTH` setting and must be disabled in production.

### Google authentication

The hosted gateway uses Better Auth with D1 and Google social login. Electron uses Better Auth's official desktop integration: sign-in opens in the system browser, returns over the `com.frockbot.desktop` protocol, and stores encrypted session material in the main process rather than the renderer.

For local Google sign-in:

```bash
cp apps/cloudflare/.dev.vars.example apps/cloudflare/.dev.vars
# Replace every value in .dev.vars, then initialize the local D1 database.
cd apps/cloudflare
bunx wrangler d1 migrations apply AUTH_DB --local
bun run dev:electron
```

Create a Google **Web application** OAuth client and register this local redirect URI:

```text
http://127.0.0.1:8787/api/auth/callback/google
```

For production, replace the placeholder `AUTH_DB` database ID in [`apps/cloudflare/wrangler.jsonc`](apps/cloudflare/wrangler.jsonc), set `BETTER_AUTH_URL` to the public HTTPS origin, leave `ALLOW_DEVELOPMENT_AUTH` unset, and provision `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` as Worker secrets. Register `https://<your-host>/api/auth/callback/google` with Google. Never commit those values.

The desktop host must receive both `FROCKBOT_APPLICATION_URL` (the public application URL loaded by its sandboxed window) and `FROCKBOT_AUTH_BASE_URL` (the Better Auth Worker origin). They may be the same hosted origin. If `FROCKBOT_APPLICATION_URL` is absent, the desktop loads its local host; if `FROCKBOT_AUTH_BASE_URL` is absent, it does not initialize hosted authentication.

The memory plugin stores Markdown source documents and incremental index metadata in R2, with 768-dimensional cosine embeddings in Vectorize using `@cf/baai/bge-base-en-v1.5`. Provision the configured resources before remote deployment:

```bash
cd apps/cloudflare
bunx wrangler r2 bucket create frockbot-memory-files
bunx wrangler vectorize create frockbot-memory --dimensions=768 --metric=cosine
```

Memory has two user-private tiers: **agent** memory belongs to one bot, while **global** memory is shared by all of that user's bots. Reads and recall check both by default; when the same path exists in both tiers, the agent copy wins. Writes default to the safer agent tier.

## Security model

Renderers use `nodeIntegration: false`, context isolation, Chromium sandboxing, authenticated loopback transport, origin checks, and restrictive content security policy. Agent execution runs in an Electron utility process.

Cordis contexts provide composition and lifecycle ownership, not security isolation. Generated or unreviewed executable plugins must run inside a restricted process, container, or micro-VM rather than Electron main; untrusted rich UI must run in a sandboxed frame rather than the trusted WebUI context.

## Current limitations

- model configuration currently uses environment variables rather than onboarding UI;
- sessions are currently in memory;
- Fly Sprite live provisioning requires a valid Sprites token and has not been exercised by repository CI;
- the routines panel is presentational;
- the manifest-driven package catalog works for built-in packages, but external package discovery and download are not implemented;
- application packaging and code signing are not configured.

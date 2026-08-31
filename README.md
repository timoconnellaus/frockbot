# FrockBot

FrockBot is an experimental Cordis-first application for persistent conversational bots. The hosted WebUI and cloud backend provide the product path; Electron and mobile are thin platform shells around the same hosted protocols.

The current vertical slice includes:

- a hosted Cordis WebUI/Vue client composed from declared Package Contributions;
- backend-owned Bot Durable Objects running the event-sourced custom agent loop;
- a durable User-owned Bot directory with Bot-owned settings, sessions, and composable sheep identities;
- explicit Package, Connection, and Capability Assignment ownership;
- provider-neutral durable User settings independent of external integrations;
- thin Electron and Capacitor shells that load the hosted application and broker narrow optional platform capabilities;
- streamed text, journaled tool calls, durable recovery, and lifecycle cleanup;
- an executable Cordis loader, dependency, isolation, WebSocket, CSP, and Electron foundation proof.

See [`docs/architecture.md`](docs/architecture.md) and [`docs/adr/0001-cordis-application-spine.md`](docs/adr/0001-cordis-application-spine.md).

## Requirements

- [Bun](https://bun.sh) 1.3 or newer

## Development

```bash
bun install
bun run dev:cloudflare:electron
```

The development launcher builds the hosted application, starts its local Cloudflare and Vite origins, and passes both required origins to the Electron thin shell. Starting the desktop workspace directly requires explicit `FROCKBOT_APPLICATION_URL` and `FROCKBOT_AUTH_BASE_URL` values.

The deterministic foundation provider runs without credentials. To use an OpenAI-compatible endpoint:

```bash
FROCKBOT_LLM_BASE_URL="https://api.example.com/v1" \
  FROCKBOT_LLM_MODEL="model-id" \
  FROCKBOT_LLM_API_KEY="..." \
  bun run dev:cloudflare:electron
```

`FROCKBOT_LLM_API_KEY` is optional for local endpoints. `FROCKBOT_LLM_PROVIDER_ID` customizes the provider label.

The left sidebar lists the authenticated User's active Bots and switches the workspace. **Add sheep** creates a Bot with a durable random sheep identity; selecting the active sheep opens an editor where its background, headwear, facewear, and neckwear can be changed independently or rerolled together. **Manage** shows archived Bots and provides archive and restore controls without deleting their history or settings. Bot settings remain behind the selected workspace's header gear. The bottom-left **Plugins** surface installs available Packages and explicitly assigns, replaces, or unassigns their Capabilities for Bots; external account controls appear only when the compiled application includes a Connection Package. Selecting a connected model in Bot settings atomically commits that Bot's explicit durable model Capability Assignment and exact provider model. **Unbind model** removes the model authority and releases the Connection dependency so the User can disconnect it. User profile settings are under **Profile → Settings**, and the profile menu owns hosted sign-out; local development identities explicitly cannot sign out. Model selection remains Bot-specific and User defaults apply only when creating a Bot. During an active Turn, **Stop** records durable cancellation intent; closing or switching clients does not stop backend work. Browser, desktop, and mobile render the same hosted Bot, sheep, Connection, and model-selection workflows; mobile intentionally hides **Plugins** until its native OAuth/deep-link return is implemented.

`@frockbot/plugin-provider-ollama-cloud` lets each User create multiple named Ollama Cloud Connections with its own write-only API key. The backend validates and encrypts each credential, discovers that Connection's model catalog, and exposes the normalized models in Bot settings. Every Bot binds explicitly to a Connection ID and provider model ID, and execution additionally requires that Bot's enabled Ollama model Capability Assignment. Rotation affects subsequent model effects while already-admitted effects retain their durable credential lease; disconnect blocks new leases without cancelling admitted Turns.

To attach the built-in Fly Sprites Computer provider Package, provide a Sprites token. The provider sits behind the provider-neutral Computer interface used by generic tools and memory. It assigns a distinct persistent Sprite and Chromium/noVNC desktop to each Bot, plus a separate User-scoped storage Sprite for global memory. `FROCKBOT_SPRITE_NAME` optionally selects the base name used to derive Bot and User storage Sprite names for standalone development; the hosted backend supplies durable User and Bot identity. `FROCKBOT_COMPUTER_PROVIDER` selects an installed provider and currently defaults to `fly-sprite`.

```bash
SPRITES_TOKEN="..." \
  FROCKBOT_SPRITE_NAME="frockbot-barebones" \
  bun run dev:cloudflare:electron
```

The shared hosted shell does not currently expose Computer viewer or takeover controls. The backend's token-routed noVNC gateway serves each Bot desktop through that Bot Sprite's public HTTPS URL, and its Bot-scoped takeover lease blocks new process and browser actions while leaving durable Package file operations available. Shells start in `/workspaces/<bot-key>` with `HOME=/home/box`. Canonical desktop memory Markdown and derived index metadata live in the memory Package's private Computer directory under `/home/box/agent-data`; cloud runtimes retain the explicit R2/Vectorize adapter. See [`docs/research/fly-sprites-computer.md`](docs/research/fly-sprites-computer.md) for provider constraints and primary sources.

Electron's installer script is explicitly allowed through the root `trustedDependencies` setting. If Electron was installed before that setting existed, rebuild its binary once:

```bash
node apps/desktop/node_modules/electron/install.js
```

## Checks

```bash
bun run format:check
bun run lint:ui-styles
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

After CI succeeds on a push to `main`, `ci.yml` deploys three Cloudflare Workers through the GitHub `production` environment:

- `apps/marketing` serves the public marketing site at `https://frockbot.com` and redirects `www.frockbot.com` to the apex domain;
- `apps/fly-host-prototype` deploys the internal shared Computer host with no public route;
- `apps/cloudflare-bundler` is the binding-less Package bundler the app reaches through its `PACKAGE_BUNDLER` service binding; it deploys before the app because that binding must resolve;
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
| Secret   | `SPRITES_TOKEN`             | Fly Sprites token used only by the backend Computer provider                  |
| Secret   | `CREDENTIAL_KEYRING`        | Versioned AES-GCM keyring for per-User Connection credentials                 |

Composio is temporarily excluded from the foundation application and production setup while its integration is redesigned around Composio Connect MCP. No Composio credential is required or forwarded by the current deployment.

Run `./scripts/setup-production.sh` to create the scoped Cloudflare token, configure the Google OAuth web client, save the remaining secrets to the GitHub `production` environment, and verify the completed configuration.

Register `https://bot.frockbot.com/api/auth/callback/google` as an authorized Google redirect URI. The deploy token must include Workers Scripts and Workers Routes edit access, and the `frockbot.com` zone must be active in the same Cloudflare account. Production deployment intentionally does not create or delete D1, R2, or Vectorize resources.

The desktop smoke path can capture the connected UI without a model call:

```bash
FROCKBOT_SMOKE_SCREENSHOT="$PWD/artifacts/frockbot.png" \
  FROCKBOT_APPLICATION_URL="https://bot.frockbot.com" \
  FROCKBOT_AUTH_BASE_URL="https://bot.frockbot.com" \
  bun run --filter @frockbot/desktop start
```

To exercise one streamed custom-loop turn and its WebUI projection:

```bash
FROCKBOT_SMOKE_SCREENSHOT="$PWD/artifacts/frockbot-chat.png" \
  FROCKBOT_SMOKE_PROMPT='/echo FrockBot is ready.' \
  FROCKBOT_APPLICATION_URL="https://bot.frockbot.com" \
  FROCKBOT_AUTH_BASE_URL="https://bot.frockbot.com" \
  bun run --filter @frockbot/desktop start
```

`bun run --filter @frockbot/desktop package` builds unsigned installers (DMG, NSIS, AppImage) into `apps/desktop/release/`. `bun run icons:generate` regenerates the desktop, Android, and iOS app icons from the canonical `assets/marketing/app-icon/frockbot-icon-1024.png`; it requires ImageMagick 7 and macOS `iconutil`. Packaged builds take their icon from those generated resources; on macOS an unpackaged local run also sets the Dock icon to `apps/desktop/resources/icons/512x512.png` so development windows show the FrockBot sheep rather than Electron's default.

## Structure

```text
apps/
  desktop/          Electron hosted-window shell and optional platform adapters
  mobile/           Direct-hosted Capacitor shell and optional native capabilities
  agent-runtime/    Transport-neutral backend Agent composition
  cloudflare/       User application loader, Dynamic Worker artifact, and bot state
  marketing/        Public frockbot.com site and static-assets Worker
  cordis-poc/       Executable pinned Cordis/Electron/WebUI foundation proof
packages/
  kernel-contracts/ Session, LLM, prompt, and tool execution contracts
  kernel-agent-loop/ Concrete event-sourced durable agent loop and Agent registry
  kernel-composition/ Package manifest, activation, isolate host, and compiler
  kernel-do/        Bot Durable Object admission, log, cursor, and scheduling
  client-core/      Shared client runtime helpers and brand typography stylesheet
  client-ui/        Cordis-free reusable Vue primitives and surface registry
  computer-core/    Provider registry and capability interfaces for Computers
  configuration-core/ Versioned durable User/Bot settings contracts
  connection-core/  Provider-neutral Connection transport result contracts
  architecture-checks/ Automated checks for the constitutional rules
  plugin-clock/     Reference package with agent, host, and WebUI contributions
  plugin-composio/  Dormant Composio source pending Connect MCP redesign
  plugin-computer/  Generic Computer tools, prompt, state, and viewer UI
  plugin-flock/     Durable Bot directory and composable sheep identity Package
  plugin-fly-sprite/ Fly Sprites Computer provider and takeover adapter
  plugin-memory/    Bot, User and Project Markdown memory over the Workspace store
  plugin-package-publisher/ Durable User application publication and rollback
  plugin-settings/  Plugin-owned Bot, Package, and User settings surfaces
  plugin-shell/     Hosted application geometry and surface presenter
  plugin-ui-theme/  Global semantic tokens for hosted client Contributions
  protocol/         Commands and events shared across process seams
  provider-openai-compatible/  Streaming production model adapter
docs/
  architecture.md   Current system shape
  adr/              Architectural decisions
  research/         Primary-source compatibility research
```

## Cloudflare vertical slice

The Cloudflare application builds an immutable Dynamic Worker artifact containing the user-facing UI and gateway routes. The gateway loads the User's active `userId:applicationHash`; the Dynamic Worker forwards authoritative Bot execution through a user-scoped capability backed by one Durable Object per Bot. Bots can publish content-hashed application artifacts through the Package Publisher Contribution, and the User Durable Object retains durable revision and rollback state.

Every Bot has `list_setup_revisions`, `publish_setup`, and `rollback_setup` tools. The editable setup is the Git repository at `/home/box/setup` in its Sprite. After the Bot commits and tests a change, `publish_setup` archives Git `HEAD`, reads `dist/application.mjs`, and submits the check results; failed checks block publication, and the backend independently loads and health-checks the exact module before activation. File editing and choice of Sprite editor remain outside this Contribution. The hosted **Revisions** surface lists history and can roll every Bot back to an earlier shared application revision.

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

When one authorized Android device is visible to `adb` and Tailscale has an IPv4 address, the same command also starts the mobile Vite server on port 5174, binds Wrangler to the Mac's Tailscale address, builds and syncs the Capacitor Android project, installs the debug APK with `adb install -r`, and launches it. The phone loads both live-reload UI and gateway traffic over Tailscale; no LAN-wide bind or production deployment is used. Keep Tailscale connected on the Mac and phone. When the same phone appears through both USB and wireless ADB, the wireless endpoint is preferred. If multiple authorized devices are connected, set `ANDROID_SERIAL` to the intended serial. With no eligible device or no Tailscale address, desktop development continues and phone installation is skipped.

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

For local Google sign-in in either the browser or desktop shell:

```bash
cp apps/cloudflare/.dev.vars.example apps/cloudflare/.dev.vars
# Replace every value in .dev.vars with independent development credentials,
# then initialize D1.
cd apps/cloudflare
bunx wrangler d1 migrations apply AUTH_DB --env development --local
bun run dev:electron
```

Create a Google **Web application** OAuth client and register this local redirect URI:

```text
http://127.0.0.1:8787/api/auth/callback/google
```

For production, keep `ALLOW_DEVELOPMENT_AUTH` unset and configure the GitHub `production` environment described above. `BETTER_AUTH_URL` is `https://bot.frockbot.com`; register `https://bot.frockbot.com/api/auth/callback/google` with Google. Never commit `BETTER_AUTH_SECRET`, provider credentials, or OAuth client secrets.

The desktop host requires both `FROCKBOT_APPLICATION_URL` (the public application URL loaded by its sandboxed window) and `FROCKBOT_AUTH_BASE_URL` (the Better Auth Worker origin). They may be the same hosted origin. A desktop deployment with either origin missing is invalid and must fail before exposing chat; there is no local Agent or WebUI product fallback.

The memory Package has a provider-neutral document-store seam. Computer-backed runtimes store canonical Markdown and incremental index metadata in private durable directories on the selected Computer; the Fly adapter places them on Sprite disk. Cloudflare runtimes use R2 for canonical documents and Vectorize with 768-dimensional embeddings from `@cf/baai/bge-base-en-v1.5`. Local Cloudflare development selects Wrangler's `development` environment and uses the remote-only development resources `frockbot-memory-files-development` and `frockbot-memory-development`; local application artifacts, D1, and Durable Objects remain isolated in `.wrangler/state`. The development memory resources are separate from the production names listed in [Production deployment](#production-deployment).

Memory has two user-private tiers: **agent** memory belongs to one bot, while **global** memory is shared by all of that user's bots. Reads and recall check both by default; when the same path exists in both tiers, the agent copy wins. Writes default to the safer agent tier.

## Security model

The Electron renderer uses `nodeIntegration: false`, context isolation, Chromium sandboxing, hosted-origin navigation checks, and a narrow decoded preload bridge. Authentication handoff, external authorization, notifications, clipboard, and file selection are optional shell capabilities; core chat and Agent execution remain hosted and continue without a native process.

Cordis contexts provide composition and lifecycle ownership, not security isolation. Generated or unreviewed executable plugins must run inside a restricted process, container, or micro-VM rather than Electron main; untrusted rich UI must run in a sandboxed frame rather than the trusted WebUI context.

## Current limitations

- Ollama Cloud model onboarding uses hosted account Connections and explicit per-Bot model bindings; standalone Foundation provider defaults still use environment configuration;
- Fly Sprite live provisioning requires a valid Sprites token and has not been exercised by repository CI;
- Fly uses one Sprite per Bot, but live isolation still depends on Fly's VM and network enforcement and has not been exercised by repository CI;
- the local derived memory vector index is process-local and rebuilt through canonical-file fallback; cloud Vectorize remains durable;
- Kubernetes and Cloudflare Containers can now be added as provider Packages, but adapters are not implemented yet;
- the manifest-driven package catalog works for built-in packages, but external package discovery and download are not implemented;
- packaged applications are not code signed.

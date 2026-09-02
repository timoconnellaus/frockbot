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

The left sidebar lists the authenticated User's active Bots and switches the workspace. **Add sheep** creates a Bot with a durable random sheep identity; selecting the active sheep opens an editor where its background, headwear, facewear, and neckwear can be changed independently or rerolled together. **Manage** shows archived Bots and provides archive and restore controls without deleting their history or settings. Bot settings remain behind the selected workspace's header gear. The bottom-left **Plugins** surface turns installed Packages on and off — enablement and nothing else — and links to the **Package Catalog** for installing new ones. Setting a Package up happens where it belongs: **Profile → Models** configures model provider accounts and endpoints and picks the model every Bot uses, **Profile → Connections** authorizes the external accounts and MCP servers a Bot may be given, and any remaining declared Package settings sit under **Profile → Settings**. Selecting a connected model in Bot settings atomically commits that Bot's explicit durable model Capability Assignment and exact provider model. **Unbind model** removes the model authority and releases the Connection dependency so the User can disconnect it. User profile settings are under **Profile → Settings**, and the profile menu owns hosted sign-out; local development identities explicitly cannot sign out. The User's default model lives in **Profile → Models**; a Bot without its own model follows it and claims the required durable model Assignment before it runs. During an active Turn, **Stop** records durable cancellation intent; closing or switching clients does not stop backend work. Browser, desktop, and mobile render the same hosted Bot, sheep, Connection, and model-selection workflows; mobile intentionally hides **Plugins** until its native OAuth/deep-link return is implemented.

`@frockbot/plugin-provider-ollama-cloud` lets each User create multiple named Ollama Cloud Connections with its own write-only API key. The backend validates and encrypts each credential, discovers that Connection's model catalog, and exposes the normalized models in Bot settings. Every Bot binds explicitly to a Connection ID and provider model ID, and execution additionally requires that Bot's enabled Ollama model Capability Assignment. Rotation affects subsequent model effects while already-admitted effects retain their durable credential lease; disconnect blocks new leases without cancelling admitted Turns.

`@frockbot/plugin-provider-workers-ai` is the built-in credential-free model path. On a User's first configuration read its User Contribution idempotently installs the Package, creates the ready ambient `workers-ai-account` Connection, and selects **DeepSeek V4 Flash** (`@cf/deepseek-ai/deepseek-v4-flash-0731`) when the User has not chosen a default. The Package calls the deployment's native `AI` binding through a narrow `run(model, input)` adapter; no account id, API token, or User secret enters FrockBot state. Its model list is deliberately static because listing the REST catalog would require a separate Cloudflare account token. Connecting Ollama replaces an automatic default with its preferred available model (`gpt-oss:20b`, then `glm-5.3-flash:cloud`, then the first catalog entry), but never replaces a User-chosen default.

To attach the built-in Fly Sprites Computer provider Package, provide a Sprites token. The provider sits behind the provider-neutral Computer interface used by generic tools and memory. It provisions **one persistent Sprite per User** ([ADR 0012](docs/adr/0012-one-computer-per-user.md)), shared by every Bot that User owns: each Bot receives its own directories and an on-demand Chromium/noVNC desktop slot, and every Bot on the Computer shares the one browser profile at `/home/box/chrome-profile`, so logins are a User-level asset. There is no separate User storage Sprite. `FROCKBOT_SPRITE_NAME` optionally selects the base name the User's Sprite name is derived from for standalone development; the hosted backend supplies durable User identity. `FROCKBOT_COMPUTER_PROVIDER` selects an installed provider and currently defaults to `fly-sprite`. In the hosted deployment the Sprites SDK and `SPRITES_TOKEN` live in `apps/computer-host` ([ADR 0004](docs/adr/0004-host-fly-computer-in-cloudflare-containers.md)), which the Bot Durable Object reaches over the `COMPUTER_HOST` service binding; the app Worker keeps `SPRITES_TOKEN` only as the answer to "has this deployment a Computer at all".

```bash
SPRITES_TOKEN="..." \
  FROCKBOT_SPRITE_NAME="frockbot-barebones" \
  bun run dev:cloudflare:electron
```

The hosted shell does expose Computer viewer and human-takeover controls: `plugin-computer`'s Computer card renders a live noVNC viewer, **Take control** and **Release control**, and a full-window overlay, and the same card is a section of the per-Bot info pane. The backend's token-routed noVNC gateway serves each Bot desktop through the User Sprite's public HTTPS URL, and its Bot-scoped takeover lease blocks new process and browser actions while leaving durable Package file operations available. Shells start in `/workspaces/<bot-key>` with `HOME=/home/box`. Canonical Memory Markdown does **not** live on the Computer: the Memory Package is its single writer and writes object storage directly, and the Computer sees Memory roots read-only ([ADR 0013](docs/adr/0013-bidirectional-memory-sync.md)), so a Turn can read and write Memory with the Computer hibernated. See [`docs/research/fly-sprites-computer.md`](docs/research/fly-sprites-computer.md) for provider constraints and primary sources.

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

### Test layers

Five layers, each answering a different question. The first four run in CI; the fifth never does.

| Layer           | Command                                                  | What executes                                                                                                                  |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **unit**        | `bun test`                                               | `*.test.ts` and `*.spec.ts` under Bun, in every workspace. Pure logic and doubles.                                             |
| **workerd**     | `bun run --filter @frockbot/cloudflare test:workerd`     | `test/**/*.workerd.ts` in local workerd against a probe Worker, so Durable Objects and their storage are real. Hermetic.       |
| **integration** | `bun run --filter @frockbot/cloudflare test:integration` | `test/integration/**/*.integration.ts` — `SELF.fetch` through the deployed gateway, the Worker Loader, and the built artifact. |
| **e2e**         | `bun run --filter @frockbot/cloudflare test:e2e`         | `e2e/**/*.e2e.ts` — real Chromium against `wrangler dev`; the only layer in which the shipped Vue client runs.                 |
| **live**        | `bun run --filter @frockbot/computer-host test:live`     | The production container image against a real disposable Fly Sprite. Needs Docker and `SPRITES_TOKEN`; deleted in `finally`.   |

The suffixes matter: root `bun test` matches `*.test.ts` and `*.spec.ts` and neither `*.workerd.ts`, `*.integration.ts`, nor `*.e2e.ts`, so the pre-commit hook never starts a runtime project. There is no live Sprite probe inside the workerd project any more — the old `fly-compatibility.workerd.ts` live path went away with the Sprites SDK when it moved to the Computer host (ADR 0004). `apps/computer-host/live-test.ts` is the only thing in the repository that touches a real Sprite. `apps/cloudflare/test/README.md` documents each runtime project in full.

## Releases

Merging integrates; tagging ships. A pull request is queued to merge itself as soon as CI is green (`auto-merge.yml`), so `main` stays continuously integrated and nothing about landing a change touches production. Production moves only when a maintainer pushes a version tag.

Pushing a valid SemVer tag such as `v0.1.0` or `v0.1.0-rc.1` (build metadata such as `+build.1` is rejected because npm does not accept it in package versions) validates the monorepo, publishes every workspace under `packages/` to npm with the tag's version, creates a GitHub release with generated notes, and then deploys production. Prereleases use npm's `next` dist-tag rather than `latest`. Application workspaces remain private.

Auto-merge waits on the branch ruleset for `main`, which requires the `Validate` and `Browser end-to-end` checks. That ruleset is what holds a queued pull request back; without it GitHub has nothing to wait for and would merge on open. **Allow auto-merge** must also be enabled in the repository's settings.

For the first publication, add a granular npm automation token with access to the `@frockbot` scope as the `NPM_TOKEN` repository secret. After each package exists on npm, configure its trusted publisher for repository `timoconnellaus/frockbot` and workflow `release.yml`; the workflow can then publish through GitHub OIDC without a long-lived token, and `NPM_TOKEN` can be deleted.

## Production deployment

After a version tag's packages are published, `release.yml` deploys four Cloudflare Workers through the GitHub `production` environment. Merging to `main` deploys nothing — a tag is the only thing that reaches production, so code can be integrated freely and released deliberately:

- `apps/marketing` serves the public marketing site at `https://frockbot.com` and redirects `www.frockbot.com` to the apex domain;
- `apps/cloudflare-bundler` is the binding-less Package bundler the app reaches through its `PACKAGE_BUNDLER` service binding; it deploys before the app because that binding must resolve;
- `apps/computer-host` is the shared Computer host of [ADR 0004](docs/adr/0004-host-fly-computer-in-cloudflare-containers.md): an internal Worker with no public route, a bounded pool of Cloudflare Containers, and the only place `SPRITES_TOKEN` is used. It deploys before the app for the same reason the bundler does, and because a stale host would be serving a current app;
- `apps/cloudflare` serves the authenticated application and API at `https://bot.frockbot.com`.

The Computer host runs Containers, which require the **Workers Paid plan**; its deploy step builds and pushes the container image, so the runner needs Docker (`ubuntu-latest` has it).

The app deployment applies remote D1 migrations, uploads the immutable application artifact to R2 under its SHA-256 digest, sets `DEFAULT_APPLICATION_HASH` to that digest, publishes one Package Catalog generation, and then deploys the Worker, so each build is content-addressed and never overwrites a previously deployed artifact. The Catalog step runs `scripts/publish-catalog.ts` and writes into the `frockbot-package-catalog` bucket: the generation's entry documents and index are written first and are immutable, and the mutable pointer `catalog/current` is written last, so a reader either sees the previous generation whole or the new one whole ([ADR 0014](docs/adr/0014-catalog-package-provenance.md)). Both Wrangler configurations declare their custom domains, so Cloudflare creates and maintains the required proxied DNS records when the Workers are first deployed.

Create the resources named in `apps/cloudflare/wrangler.jsonc` before the first app deployment:

- D1 database `frockbot-auth`;
- R2 buckets `frockbot-application-artifacts`, `frockbot-memory-files`, and `frockbot-package-catalog`;
- Vectorize index `frockbot-memory` with 768 cosine dimensions (`bunx wrangler vectorize create frockbot-memory --preset @cf/baai/bge-base-en-v1.5`).

The same Wrangler file declares the native Workers AI binding as `AI` for production and development. It needs no secret, but the Cloudflare account must have Workers AI paid usage or prepaid credits for the default DeepSeek model. The browser e2e environment binds `AI` to its local RPC fake instead, so CI neither authenticates to Cloudflare nor incurs model usage.

Configure these GitHub `production` environment values:

| Type     | Name                        | Purpose                                                                                 |
| -------- | --------------------------- | --------------------------------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`      | Cloudflare token permitted to edit Workers, D1, and R2 for the target account           |
| Secret   | `CLOUDFLARE_ACCOUNT_ID`     | Cloudflare account containing the production resources                                  |
| Variable | `CLOUDFLARE_D1_DATABASE_ID` | Immutable ID of `frockbot-auth`                                                         |
| Variable | `BETTER_AUTH_URL`           | Set to `https://bot.frockbot.com`                                                       |
| Secret   | `BETTER_AUTH_SECRET`        | Better Auth secret with at least 32 random characters                                   |
| Secret   | `GOOGLE_CLIENT_ID`          | Google Web application OAuth client ID                                                  |
| Secret   | `GOOGLE_CLIENT_SECRET`      | Google Web application OAuth client secret                                              |
| Secret   | `FROCKBOT_ADMIN_EMAILS`     | Comma-separated owner emails allowed to administer deployment policy (optional; warns)  |
| Secret   | `SPRITES_TOKEN`             | Fly Sprites token used only by the backend Computer provider                            |
| Secret   | `COMPUTER_HOST_TOKEN`       | Shared secret the app Worker presents to the Computer host; generate it                 |
| Secret   | `CREDENTIAL_KEYRING`        | Versioned AES-GCM keyring for per-User Connection credentials                           |
| Secret   | `ROUTINE_HOOK_SECRET`       | HMAC secret every Routine webhook key is signed with; generate it                       |
| Secret   | `MACHINE_TOKEN_SECRET`      | HMAC secret every registered-machine token and pairing code is signed with; generate it |

Composio is temporarily excluded from the foundation application and production setup while its integration is redesigned around Composio Connect MCP. No Composio credential is required or forwarded by the current deployment.

New signups are closed by default. Set `FROCKBOT_ADMIN_EMAILS` to one or more comma-separated email addresses in the GitHub `production` environment; those identities can open **Admin** from the profile menu and change the durable signup policy. The allowlist stays in the gateway and only an `isAdmin` boolean reaches the client. Existing Users continue to sign in while signups are closed.

`ROUTINE_HOOK_SECRET` is generated too, once, with `openssl rand -hex 32` — `./scripts/setup-production.sh` does it if the secret is absent and preserves it if it is not. Every Routine webhook key is `HMAC-SHA256` over its own claims under this secret, and the gateway verifies that signature before any Durable Object is addressed. Rotating it invalidates every webhook key already handed out, which each Routine's owner then has to re-mint; without it set, the delivery route answers `503` and a webhook Routine is recorded without a key rather than given one nothing could verify.

`MACHINE_TOKEN_SECRET` is generated the same way and on the same terms. Every registered machine's token and every pairing code is `HMAC-SHA256` over its own claims under this secret, verified at the edge before any Durable Object is addressed. Rotating it un-enrols every registered machine, which then has to be paired again; without it set, enrollment and every machine route answer `503` rather than admitting a caller nothing could verify.

`COMPUTER_HOST_TOKEN` is not obtained from anywhere — generate it, once, with `openssl rand -hex 32`, and add it as a GitHub `production` secret. It is checked inside the container as well as at the host Worker, because the service binding is not the only route to that port. Rotating it means redeploying both Workers together.

Run `./scripts/setup-production.sh` to create the scoped Cloudflare token, configure the Google OAuth web client, and save the generated platform secrets. Then add `FROCKBOT_ADMIN_EMAILS` to the GitHub `production` environment and verify the completed configuration.

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
  cloudflare-bundler/ Binding-less Package bundler behind the PACKAGE_BUNDLER binding
  computer-host/    Shared Computer host Worker and its Node container (ADR 0004)
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
  computer-host-protocol/  Versioned v1 DTOs and decoders for the Computer host seam
  computer-host-runtime/   The Computer's on-Sprite layout, scripts, and Sprite naming
  configuration-core/ Versioned durable User/Bot settings contracts
  connection-core/  Provider-neutral Connection transport result contracts
  catalog-core/     Remote Package Catalog generations, index, and entry decoding
  workspace-store/  Object-storage durable-root store and its generation ledger
  template-core/    Bot template recipe document and its decoder (ADR 0015)
  architecture-checks/ Automated checks for the constitutional rules
  plugin-clock/     Reference package with agent, host, and WebUI contributions
  plugin-composio/  Dormant Composio source pending Connect MCP redesign
  plugin-audit/     Audited-effect projection and the User's rebuildable audit table
  plugin-bot-template/ Bot template export, share records, and guarded import
  plugin-computer/  Generic Computer tools, prompt, state, and viewer UI
  plugin-flock/     Durable Bot directory and composable sheep identity Package
  plugin-fly-sprite/ Fly Sprites Computer provider and takeover adapter
  plugin-image/     generate_image on Workers AI, fenced by the Workspace
  plugin-mcp/       Remote MCP servers as Connections, and their lifecycle
  plugin-memory/    Bot, User and Project Markdown memory over the Workspace store
  plugin-package-publisher/ Durable User application publication and rollback
  plugin-routines/  Durable Routines, the alarm scheduler, and the webhook door
  plugin-search/    Per-User transcript index, search route, and overlay
  plugin-settings/  Plugin-owned Bot, Package, and User settings surfaces
  plugin-shell/     Hosted application geometry and surface presenter
  plugin-skills/    Skill catalog, disclosure on demand, and managed Skills
  plugin-ui-theme/  Global semantic tokens for hosted client Contributions
  plugin-web/       web_search and a bounded, SSRF-classified web_fetch
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

The memory Package has a provider-neutral document-store seam. Memory has one store on every platform: the Memory Package writes canonical Markdown to object storage through `WorkspaceFilesV1` and is its only writer ([ADR 0013](docs/adr/0013-bidirectional-memory-sync.md)); the Computer mirrors Memory roots read-only and never writes one. Cloudflare runtimes use R2 for canonical documents and Vectorize with 768-dimensional embeddings from `@cf/baai/bge-base-en-v1.5`. Local Cloudflare development selects Wrangler's `development` environment and uses the remote-only development resources `frockbot-memory-files-development` and `frockbot-memory-development`; local application artifacts, D1, and Durable Objects remain isolated in `.wrangler/state`. The development memory resources are separate from the production names listed in [Production deployment](#production-deployment).

Memory has two user-private tiers: **agent** memory belongs to one bot, while **global** memory is shared by all of that user's bots. Reads and recall check both by default; when the same path exists in both tiers, the agent copy wins. Writes default to the safer agent tier.

## Security model

The Electron renderer uses `nodeIntegration: false`, context isolation, Chromium sandboxing, hosted-origin navigation checks, and a narrow decoded preload bridge. Authentication handoff, external authorization, notifications, clipboard, and file selection are optional shell capabilities; core chat and Agent execution remain hosted and continue without a native process.

Cordis contexts provide composition and lifecycle ownership, not security isolation. Generated or unreviewed executable plugins must run inside a restricted process, container, or micro-VM rather than Electron main; untrusted rich UI must run in a sandboxed frame rather than the trusted WebUI context.

## Current limitations

- Ollama Cloud model onboarding uses hosted account Connections and explicit per-Bot model bindings; standalone Foundation provider defaults still use environment configuration;
- Fly Sprite live provisioning requires a valid Sprites token and is not exercised by repository CI; `bun run --filter @frockbot/computer-host test:live` is the only check that drives a real Sprite, and it needs Docker and `SPRITES_TOKEN`;
- Fly uses one Sprite per User (ADR 0012) and separation between that User's Bots is organizational; the User's Computer is the trust boundary, and live isolation depends on Fly's VM and network enforcement rather than on directory naming;
- the local derived memory vector index is process-local and rebuilt through canonical-file fallback; cloud Vectorize remains durable;
- the Computer interface has exactly one runtime behind it — Fly Sprites, driven from the Cloudflare Container host of ADR 0004. A Kubernetes or Container-native Computer can be added as a provider Package, but no second adapter is implemented;
- the remote Package Catalog serves pinned, content-addressed generations, but its entries are the first-party Packages compiled into the application; no third-party or Bot-published entry is indexed, and a Bot has no tool over the Catalog;
- packaged applications are not code signed.

# ADR 0028: The simple deployment

Status: accepted, 2026-09-15; stage 6's external deploy outstanding. Decisions
are Tim's from the 2026-09-15 discussion. Each stage below carries a **Built**
note where what was built differs from what was proposed.

## Decision

FrockBot stays one public, MIT-licensed repository holding the whole product
and two **deployment profiles**:

- **hosted** — `frockbot.com`, Tim's deployment. Google sign-in through
  better-auth, billing live, Android and macOS releases through Shorebird and
  Sparkle, the marketing site, GitHub environments and `release.yml`. **This
  ADR changes nothing about it.**
- **simple** — what anyone installs into their own Cloudflare account with
  one command, `bun run setup`, from a release tag. Cloudflare Access
  sign-in, no billing, no release ceremony, the Fly Sprites Computer
  included. No customisation: the deployer chooses their account, their
  Access policy and their Fly token, nothing else.

A profile is _which secrets exist, which workflows run, and which auth
Package is built in_. It is not a fork and not a private repository. Nothing
is gated: every line of both profiles is in the public repository, and a
self-hoster who sets a Stripe key gets billing; the simple installer simply
never asks for one.

Within that frame:

1. **Sign-in is a build-time Package** with two implementations behind one
   interface, chosen the way the Computer host is chosen today, in one file
   beside the bindings. The hosted profile builds better-auth with Google;
   the simple profile builds Cloudflare Access. On the simple profile
   **Access alone decides admission**: the Access policy is the allowlist,
   the admission authority answers "admitted" for anyone Access let through,
   and there is no admission UI. The hosted profile keeps its modes,
   invitations and access records.
2. **Billing stays as it is.** It is switched by `STRIPE_SECRET_KEY`, which
   the simple installer never sets.
3. **The client updaters stay as they are.** Both are inert in a plain
   `flutter build`; the simple profile ships the web client and a plain APK
   attached to the release, and the update control never appears.
4. **The Fly Sprites Computer is in the simple deployment.** Fly is the one
   non-Cloudflare account a deployer needs.
5. **Customised deployments come later, through published packages.** Not
   submodules, not forks. Out of scope here; the constraints that keep it
   open are under _Consequences_.
6. **The seeded Plugin catalog stays a build constant** for now.
7. **Administration leaves the app.** The hosted deployment gets its own
   admin portal, a hosted-only Worker behind Cloudflare Access that reaches
   the app over a service binding. The `/api/admin/*` routes and the client's
   Site administration page are deleted. The simple deployment has no admin
   UI at all: the Access policy is who gets in, and the admin emails secret
   names the deployment's admins, who bypass admission.

## Why

- The successful self-hostable applications with a community — Home
  Assistant, Ghost, Discourse, Immich — ship one codebase, deploy in one
  command, gate nothing, and sell hosting or convenience beside it. The
  resented ones relicensed, gated features, or were open in name and
  unhostable in practice. This ADR takes the first shape: the hosted
  deployment is the same code, and the simple profile is the one-command
  path.
- The seams already exist. Billing is a secret switch. The Computer host is
  a Package behind one choosing file, which is the pattern auth adopts. The
  model path already falls back from the AI Gateway to the `AI` binding when
  the Gateway is unconfigured. The release jobs already skip when their
  environment is unset. What is missing is an installer, deployment identity
  outside the wrangler files, and one auth implementation.
- Prior art: `cloudflare/cloudflare-os-starter` deploys into a user's
  account from an annotated `deployment.jsonc`, uses Cloudflare Access for
  sign-in and admin emails for authority, and keeps secrets out of tracked
  configuration. Its configuration shape is adopted; its submodule is not.
- Platform facts checked 2026-09-15: Dynamic Workers is open beta for every
  Workers Paid account with no sign-up; Containers accept prebuilt images
  from `registry.cloudflare.com`, Docker Hub, ECR and Google Artifact
  Registry, so a deployer needs no Docker when the release publishes the
  images; Access protects a `workers.dev` hostname directly, so the simple
  deployment needs no zone.

## What a simple deployment needs

One Cloudflare account on the Workers Paid plan with **one domain on it**, a
Fly Sprites token, Bun, and a Zero Trust team (free). The domain is needed
because the artifact origin must be `ui.<the app's hostname>`: the app
derives the pairing from that prefix in the gateway and the Applet preview
path, and a `workers.dev` name cannot carry a dot, so a second Worker on
`workers.dev` cannot serve it. Optional keys extend reach and never repair a
default: OpenAI and ElevenLabs for voice, FCM for Android push, Composio for
connected apps, an AI Gateway for the hosted model route.

Resources wrangler creates: three Workers (`app`, `computer-host`,
`applet-build`) plus the artifact-origin deployment below, two container
applications from published images, two R2 buckets, one Vectorize index, the
`AI` binding, the Worker Loader bindings, five Durable Object namespaces. No
D1: the Access Package stores nothing.

Secrets the installer mints itself, as `setup-production.sh` does today:
`CREDENTIAL_KEYRING`, `COMPUTER_HOST_TOKEN`, `APPLET_BUILD_TOKEN`,
`APPLET_VIEWER_SECRET`, `ROUTINE_HOOK_SECRET`, `MACHINE_TOKEN_SECRET`.

## Plan

Each step is one or more PRs and leaves `main` shippable and production Bots
able to reply. The hosted deployment must not change behaviour at any step:
no Worker name, Durable Object namespace, User id or sign-in path moves, and
every PR that touches the gateway or the Worker entry is verified on staging
on web, phone and Mac before a tag. Steps 1, 2 and 3 are independent of
each other; 4 depends on 1 and 3; 5 and 6 follow 4.

### 1. Auth as a Package

- Define `AuthPackageV1` in `core/contracts`: resolve an identity from a
  request (user id, verified email), serve the sign-in and sign-out routes,
  serve the native authorize page's identity step, and declare what it
  needs from `env`. Its interface is the current seam between
  `gateway.ts` and `auth.ts`, named.
- Move the existing better-auth code behind it unchanged, as
  `app/auth/better-auth/`. Same routes, same D1, same session cookie, same
  User ids. This PR is a refactor with no behaviour change, proved by the
  suites and a staging sign-in on all three clients.
- Add `app/auth/access/`: verify `Cf-Access-Jwt-Assertion` (or the
  `CF_Authorization` cookie) against the team's public keys, check `aud`,
  derive the User id from the token's `sub`, take the email from the token.
  Two vars, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. No storage. The native
  flow keeps its shape: the app opens `/native/authorize`, Access
  authenticates, the Worker mints the code, the app exchanges it for a
  bearer; `native-auth.ts` and `native-sessions.ts` are shared by both
  Packages and unchanged.
- The choosing file, beside `computer-host.ts`: the hosted build names
  better-auth, the simple build names Access. One import, the way
  `check-computer-host-imports.ts` already polices the Computer choice; a
  matching import rule keeps `better-auth` out of the Access build and vice
  versa.
- The Access application is path-scoped to the document and
  `/native/authorize`, so bearer requests to `/api/*` reach the Worker; web
  API calls carry the Access cookie, which the Worker verifies itself.
- The development sign-in door (`ALLOW_DEVELOPMENT_AUTH`, the `development`
  User, `?as_user=`) stays exactly, in front of either Package, since the
  e2e, integration and workerd suites and `dev:native` depend on it.
- `production-secrets.ts` learns that a required secret can belong to one
  auth Package: `BETTER_AUTH_*` and `GOOGLE_*` are required by the hosted
  build, `ACCESS_*` by the simple one, and the manifest test checks the
  build it is in.

**Built.** The choosing file is reached through a subpath import rather than by
path: `apps/cloudflare/package.json` maps `#auth-package` to
`src/auth-package.ts`, better-auth, which is what `wrangler dev`, every suite and
the hosted deploy resolve, and a profile whose `authPackage` is `access` gets a
generated `alias` pointing the same specifier at `src/auth-package.access.ts`. A
bare specifier because esbuild, which wrangler's `alias` reaches, refuses to
alias a relative import. `apps/cloudflare/tsconfig.access.json` type-checks the
whole Worker against the other chooser, so an `env` name only one build has
cannot reach the other unnoticed, and `scripts/check-auth-package-imports.ts` is
the import rule. The Access build has no better-auth secret to sign the native
door with, so it mints `NATIVE_TOKEN_SECRET` instead — and native sign-in is
closed on the simple profile even so: the `assetlinks.json` and
`apple-app-site-association` the Worker serves name the hosted app's package and
signing fingerprint, so a client a deployer builds and signs has no verified
return path on their own hostname. The simple profile names no native targets,
and the web client is its client until that association is per-deployment.

### 2. Administration out of the app

- The app Worker exports an `AdminEntrypoint` WorkerEntrypoint whose RPCs are
  today's admin operations: read and set the admission mode, read and set an
  account's access, invite an email, add credit, open an admin-gated Plugin
  for an account. Each keeps its compare-and-swap revision. The class is
  reachable only over a service binding.
- `apps/admin-portal`: a hosted-only Worker beside `apps/marketing`, deployed
  by `release.yml` behind its own Cloudflare Access application. It binds the
  app Worker's `AdminEntrypoint`, checks the Access email against the admin
  emails list, and renders the admin surface. Same quality bar as every
  other surface.
- Delete `/api/admin/*`, the admin section of the client protocol, the
  client's Site administration page and its entry points in the profile
  sheet and Bot settings. The admin-identity check that bypasses admission
  and opens the debug surface stays where it is.
- The simple build has no portal and nothing to hide: with Access deciding
  admission there is no admin operation left for it.

**Built.** `AdminEntrypoint` is `apps/cloudflare/src/admin-entrypoint.ts` over
`app/admin/operations.ts`, and the portal is deployed by `release.yml`'s
`deploy-marketing` job, which carries both hosted-only sites; its step skips when
the `production` environment names no Access application, so the portal admits
nobody rather than everybody while it is unconfigured. An account's features are
also writable from the operator surface, `POST
/api/debug/users/<userId>/features` under the deployment's `DEBUG_TOKEN`, which
is how a deployment with no portal turns Applets or Plugin authoring on.

### 3. Deployment identity out of the wrangler files

- Strip `account_id`, `routes`, resource names and `database_id` from the
  three `wrangler.jsonc` files. They keep bindings, migrations, vars, the
  `development` and `e2e` environments and their comments, which is what
  `wrangler dev`, the suites and CI read.
- Add `scripts/deployment-config.ts`: reads a profile file
  (`deployments/<name>.json`: account id, Worker name prefix, optional
  hostnames, auth Package, Access team and audience, admin emails, D1 id
  when better-auth) and writes the deployable configs to
  `.deployment/<name>/`, git-ignored. `wrangler deploy -c` takes the written
  file. `release.yml`'s regex rewrite of the D1 id is replaced by this.
- Check in `deployments/hosted.json` and `deployments/staging.json`. The
  simple profile is written by the installer.
- **Equivalence gate.** A Worker name, Durable Object class or migration
  tag that differs on deploy is a new namespace, which is data loss. A CI
  check proves the generated hosted and staging configs equal today's
  checked-in files, comments aside, before the release workflow switches to
  them, and keeps proving it afterwards.
- Make the hardcoded hosts parameters: `NATIVE_ORIGIN` in `native-auth.ts`
  becomes the deployment's own origin; `defaultOriginV1` in
  `transport_io.dart` and `linkHost` in `build.gradle.kts` read a
  `--dart-define`/Gradle property, with the hosted values supplied by the
  hosted release job so its builds are byte-for-byte what they are today.
  `apps/marketing` keeps its hosts; it is hosted-only.
- **Artifact origin.** `UI_ARTIFACT_HOSTS` needs a second origin for CSP
  isolation, and the pairing is derived from the hostname: the app answers
  for `ui.<its own host>` (`packageUiGatewayOriginV1`,
  `isPackageUiArtifactOriginFor` in `gateway.ts`, `appletUiArtifactOriginV1`
  in `applets/preview.ts`). A `workers.dev` name cannot contain a dot, so a
  second Worker there cannot be the artifact origin, and the generator
  requires an `artifactHostname` of the form `ui.<app hostname>` on a zone.
  The origin needs only R2, no Durable Objects; making the pairing explicit
  configuration so it could live on a second `workers.dev` Worker is a
  change to the Applet path, and is out of this ADR.
- Model default without a Gateway: the host already took the `AI` binding,
  but Auto still resolved to `dynamic/<route>`, which the binding rejects
  (cloudflare/ai#617), so Auto failed outright on any deployment without a
  Gateway. On the binding path Auto now resolves to a pinned concrete
  Workers AI chat model (`FROCK_AI_BINDING_AUTO_MODEL` in the Frock AI
  catalog); the `dynamic/` route stays the hosted default through the
  profile.

**Built.** Five deployables, not three: the marketing site and the admin portal
have profiles too, and a profile generates exactly the Workers it names. Some
fields keep a placeholder rather than nothing, because wrangler's validator
refuses a `services` entry with no target and a `vectorize` entry with no index
even in a config it never deploys, so those say `named-by-deployment-config` in
the tracked files. The equivalence gate is
`scripts/deployment-config.test.ts` against the fixtures in
`scripts/deployment-config/fixtures/hosted/`; it runs under `bun test`, so
`Check` and `main.yml` enforce it, and `release.yml` runs it again before
`deploy-backend` deploys. The staging D1 identifier is resolved from
`wrangler d1 list` in the deploying job and passed with `--d1-database-id`, which
is what replaced the regex; the one in-place rewrite left is the application
artifact's digest over the generated config's `DEFAULT_APPLICATION_HASH`
placeholder. And the artifact origin is a second custom domain on the app Worker
rather than a Worker of its own: `routesForV1` appends `artifactHostname` to the
app's routes, and the schema requires the `ui.` form.

### 4. The installer

`bun run setup`, beside `scripts/setup-production.sh`, which stays the
hosted wizard. Idempotent: a second run converges, which is also how an
upgrade works (check out the next tag, run it again). Steps, each printing
what it did:

1. `wrangler whoami`; pick the account; confirm Workers Paid.
2. Write `deployments/simple.json` from a few prompts (name prefix, the
   zone and app hostname, region, admin email), then run the generator with
   the Access Package. The artifact hostname is derived, `ui.<app hostname>`.
3. Create the two R2 buckets and the Vectorize index if absent.
4. Mint the six internal secrets if absent and set them on the right Workers.
5. Ask for the Fly Sprites token; offer the optional keys and skip cleanly.
6. Create the Access application and policy for the app's hostname when the
   API token has Zero Trust scope; otherwise print the dashboard steps and
   wait for the audience tag.
7. Deploy `computer-host`, `applet-build`, the app Worker and the artifact
   origin, pulling the published container images. Print the URL and run the
   existing debug liveness check against it.

Until a throwaway-account job exists in CI, a dry-run mode that prints every
command is the gate, plus one real run against a fresh account (step 6).

**Built.** Eight steps, not seven: fetching the web client and the application
artifact from the release is its own step before the deploy. Seven internal
secrets, not six — `NATIVE_TOKEN_SECRET` joins them, because the Access build has
no better-auth secret to sign the native door with — recorded in
`.deployment/simple/secrets.env` at mode 0600, since `wrangler secret list` says
a name is set and never what it is set to, so a lost record could only be
re-minted and would invalidate every credential, webhook key, paired machine and
open Applet page it protects. **Two Access applications, not one**, because Access
matches by path prefix and there is no way to say "the document and nothing under
it": Allow on the app's own hostname — the document, the client, sign-out and the
native flow, and the policy that is the deployment's allowlist — and Bypass on
`/api`, which reaches the Worker, which authenticates every one of those requests
itself from the Access cookie or the bearer. `ui.<app hostname>` is in neither: an
Applet's page is anonymous by design. Secrets go in with `wrangler deploy
--secrets-file` rather than `wrangler secret put`, which addresses a Worker that
does not exist yet on a first install, and the file is removed even on a failed
deploy. `--dry-run`, `--yes`, `--profile`, `--account` and
`--allow-hosted-account` are the flags; the last exists because the installer
refuses the account `deployments/hosted.json` names.

What it leaves by hand: the zone, which must already be active on the account and
covered by the deploying credential, with Cloudflare creating both proxied DNS
records itself because the hostnames are custom domains; the two Access
applications, when `CLOUDFLARE_API_TOKEN` is absent or lacks `Zero Trust: Access
Apps and Policies Write`, for which it prints the dashboard steps and waits; the
audience tag, which until it is real leaves the Worker refusing every token; and
an APK, if the deployer wants the phone app.

### 5. Release publishes what the installer pulls

- `release.yml` gains a job that builds the two container images and pushes
  them to Docker Hub (`docker.io/timoconnellaus/frockbot-computer-host` and
  `frockbot-applet-build`, tagged with the version and `latest`). Docker Hub
  rather than GHCR because Cloudflare Containers pull only from its managed
  registry, Docker Hub, ECR and Google Artifact Registry, and a public Docker
  Hub image needs no registry configuration in the pulling account. Until
  the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets exist
  the job skips with a warning and production does not wait on it; once the
  simple profile is announced it becomes required. The hosted deploy keeps
  building from the Dockerfiles in this PR; switching it to pull the
  published images is its own later tag, with the previous tag as the
  rollback, since staging shares the production Computer host.
- The web client build and the application artifact are attached to the
  GitHub release; the installer fetches both for its tag rather than
  requiring Flutter locally. An APK cannot be prebuilt for the simple
  profile because the origin is baked in at build time, so the simple
  profile ships the web client and a deployer builds an APK themselves.

**Built.** The job is `publish-images`, pushing
`docker.io/timoconnellaus/frockbot-computer-host` and
`docker.io/timoconnellaus/frockbot-applet-build` from the repository root context
for `linux/amd64`. `timoconnellaus` is that Docker Hub account's own username; no
organisation was created. `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are still
unset, so the job skips with a warning on every tag and `deploy-backend` does not
name it in `needs` — adding it there is what makes a tag production runs always a
tag an installer can install. The assets are built by `release-assets` and
attached by `github-release`:
`frockbot-web-client-<version>.zip` and
`frockbot-application-artifact-<version>.mjs`, the second as bytes rather than an
archive because the R2 key the Worker loads it under is that file's own sha256.

### 6. Documentation and the first external deploy

- `README.md` leads with the simple deployment: requirements, `bun run
setup`, what it costs, how to upgrade. The hosted pipeline moves to a
  section a contributor can skip. `docs/architecture.md` §1 gains the two
  profiles; `CONTEXT.md` gains _Deployment profile_.
- One deploy into a fresh Cloudflare account, not Tim's, from the published
  tag, following only the README. Fix everything that bites. Until this has
  been done once, the simple profile is not announced.

## Consequences

- The hosted deployment is unchanged in behaviour by every step. The only
  code it exercises differently is the auth refactor in step 1, which is why
  that PR is a pure move verified on staging before anything else lands.
- The repository carries hosted-only code (`apps/marketing`,
  `apps/mac-messages`, billing, the release scripts, the `release.yml`
  ceremony) in plain sight. Each is labelled as the hosted profile's, and
  nothing a simple deployer runs depends on it.
- The hosted deployment gains a sixth deployable and a second Access
  application. In exchange the client loses its only admin-shaped surface,
  and the simple deployment ships with none.
- Two auth Packages means two things to keep working. The Access one has no
  storage and about a page of verification code; the cost is the interface,
  which is the seam the gateway already has.
- The "nothing kept for compatibility" rule is unchanged for the hosted
  deployment. Once the simple profile has an external deployer, stored state
  is no longer disposable for them; the tested-forward-migration rule the
  constitution already promises becomes due then.
- Constraints that keep the packages model open, honoured by every PR here:
  account identity never returns to a tracked wrangler file; new deployment
  choices land in the one options object the Worker entry is built from,
  never as another `env` read scattered through the app; there is one way to
  choose a Computer host, an auth Package, a provider and a seeded Plugin,
  the build-time seams.
- Out: submodules, a private product repository, deleting billing or the
  hosted admission authority, a lite profile without the Computer or the build
  service, an installer that customises anything.

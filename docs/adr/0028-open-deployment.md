# ADR 0028: The simple deployment

Status: proposed, 2026-09-15. Decisions are Tim's from the 2026-09-15
discussion; the plan is the proposed order of work.

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
   is who may bypass admission and open the debug surface.

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

One Cloudflare account on the Workers Paid plan, a Fly Sprites token, Bun,
and a Zero Trust team (free). Optional keys extend reach and never repair a
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
  isolation. On `workers.dev` a Worker has one hostname, so the simple
  deployment needs either a zone or a second Worker. Proposed: the same
  script deployed under a second name (`<prefix>-ui`) through a wrangler
  environment whose Durable Object bindings point at the app Worker by
  `script_name` and whose R2 binding is the same bucket. Verify against the
  Applet viewer socket path before committing; the fallback is to require a
  zone. The hosted profile keeps `ui.bot.frockbot.com` either way.
- Model default: with no Gateway vars the provider already uses the `AI`
  binding. Confirm `@frock/auto` resolves to a concrete `@cf/...` model on
  that path and pin one; the `dynamic/` route stays the hosted default.

### 4. The installer

`bun run setup`, beside `scripts/setup-production.sh`, which stays the
hosted wizard. Idempotent: a second run converges, which is also how an
upgrade works (check out the next tag, run it again). Steps, each printing
what it did:

1. `wrangler whoami`; pick the account; confirm Workers Paid.
2. Write `deployments/simple.json` from a few prompts (name prefix, region,
   admin email), then run the generator with the Access Package.
3. Create the two R2 buckets and the Vectorize index if absent.
4. Mint the six internal secrets if absent and set them on the right Workers.
5. Ask for the Fly Sprites token; offer the optional keys and skip cleanly.
6. Create the Access application and policy for the app Worker's hostname
   when the API token has Zero Trust scope; otherwise print the dashboard
   steps and wait for the audience tag.
7. Deploy `computer-host`, `applet-build`, the app Worker and the artifact
   origin, pulling the published container images. Print the URL and run the
   existing debug liveness check against it.

Until a throwaway-account job exists in CI, a dry-run mode that prints every
command is the gate, plus one real run against a fresh account (step 6).

### 5. Release publishes what the installer pulls

- `release.yml` gains a job that builds the two container images and pushes
  them to a registry tagged with the version, before `deploy-backend`. The
  hosted deploy may keep building from the Dockerfile or switch to pulling;
  switching is preferred because it proves the images on every release, and
  it is its own tag with the previous tag as the rollback, since staging
  shares the production Computer host.
- The web client build and a plain APK built with the simple defaults are
  attached to the GitHub release; the installer's step 7 fetches the client
  for its tag rather than requiring Flutter locally.

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

# Deployment configs

Deployment identity — the Cloudflare account, the Worker names, the hostnames,
the resource names and the identity vars — lives in `deployments/<name>.json`.
The tracked `wrangler.jsonc` files hold bindings, migrations, the local
environments and their comments, and nothing that names a deployment.

```
bun run deployment:config hosted
bun run deployment:config staging --d1-database-id <uuid>
bun run deployment:config simple --application-hash <sha256>
```

writes `.deployment/<profile>/<worker>/wrangler.jsonc`, which is what every
`wrangler deploy -c`, `wrangler d1 migrations apply -c` and `wrangler r2 object
put -c` in `release.yml` and `main.yml` takes. `.deployment/` is git-ignored.

The generator is `@frockbot/cloudflare`'s, published with the Worker, and its
bin is `frockbot-deployment-config` (`cli.ts`, run by Bun).
`bun run deployment:config` is that bin over this repository's own
`deployments/` and `.deployment/`, wherever it is run from; a white-label runs
the bin itself, from its own repository (see [White-label](#white-label)).

`profile.schema.json`, beside the generator, is the contract. `ajv` refuses a
profile that does not meet it, so a missing account or a malformed hostname
fails before a config is written rather than during a deploy. The TypeScript
type is generated from the same document:
`scripts/generate-deployment-profile-schema.ts` writes
`profile-schema.generated.ts` as `FromSchema` with `parseIfThenElseKeywords`,
and `profile.ts` spells out the three auth Package cases on top of it, because
`FromSchema` reads a path-or-name `authPackage` as a plain `string` — so an
Access profile that names no Access application, or a chooser path with no
`authEnvironment`, is invalid at the type as well. `bun run typecheck` fails
when the generated file is stale.

Two values are flags rather than profile fields, because whoever deploys resolves
them in the same run: `--d1-database-id` for a disposable stage that creates its
database, and `--application-hash` for the sha256 of the application artifact the
deployer just uploaded, which is the R2 key the Worker loads it from. Without the
second, the config keeps the tracked placeholder `foundation-v1`, which is no
object in anybody's bucket.

## Simple deployment

Nobody writes `deployments/simple.json` by hand. `bun run setup`
(`scripts/setup.ts`) writes it, in this order:

1. Picks the account.
2. Asks for the hostname, the admin emails and the Zero Trust team, and writes
   the profile.
3. Mints the internal secrets.
4. Asks for the Fly token the Computer host needs.
5. Sets up the two Access applications: Allow on the app's hostname, Bypass on
   `/api`.
6. Downloads the checked-out tag's deploy bundle.
7. Installs the bundle through the Cloudflare API: buckets, index, artifact,
   the three Workers and their container applications. The profile's prefix is
   the install name, and nothing is generated or built locally
   ([`docs/deploy-bundles.md`](../../../docs/deploy-bundles.md)).

The bundle itself is built by this generator, in the release.
`bun run setup --dry-run` asks the same questions and then prints every command
and every value it would write, running no wrangler command and reaching no
network; add `--yes` to take the defaults instead of answering, which is how it
runs in a check. `scripts/setup-production.sh` is a different thing: it is the
hosted deployment's wizard, and it sets GitHub environment secrets for
`release.yml` rather than creating anything in Cloudflare.

The simple profile is the one that builds the Access auth Package, which the
generator writes as one `alias` entry:

```json
"alias": { "#auth-package": "../../../apps/cloudflare/src/auth-package.access.ts" }
```

`apps/cloudflare/package.json` maps `#auth-package` to
`src/auth-package.ts` — better-auth, the tracked default that `wrangler dev`, the
suites and the hosted deploy resolve — and that alias is what makes the deployed
bundle resolve the Access chooser instead. A bare specifier rather than a relative
path because esbuild, which is what wrangler's `alias` reaches, refuses to alias a
relative import. Nothing is written for a `better-auth` profile: the tracked
source already resolves to it, so the hosted and staging configs stay byte-for-byte
what production runs. `apps/cloudflare/tsconfig.access.json` type-checks the whole
Worker against the other chooser, so an `env` name only the hosted build has
cannot reach the Access build unnoticed.

Five deployables: the app Worker, the Computer host, the Plugin build service,
the marketing site and the admin portal. A profile generates exactly the ones it
names, which is how `staging.json` has neither the marketing site nor the portal,
and how `simple.json` has neither either: with Access deciding admission there is
no admin operation left to administer.

## What a generated config is

The tracked file, with identity applied:

| Tracked                                   | Generated                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| no `account_id`                           | the profile's account                                                                                                                            |
| no `routes`                               | the Worker's hostnames as custom domains, or `workers.dev`                                                                                       |
| bindings with no bucket, index or db name | the profile's resource names, derived from `prefix`                                                                                              |
| `services` with no target                 | the profile's own Worker names: the Computer host, the build service, and the app Worker the portal binds                                        |
| `vars` without identity                   | plus the identity vars below                                                                                                                     |
| `containers[].image` a Dockerfile path    | the published image, when the profile's `images.source` is `registry`                                                                            |
| no `send_email`                           | the app Worker's `SEND_EMAIL` sender, when the profile names an `email` domain (below)                                                           |
| no `alias`                                | `#auth-package` for an `access` profile or a chooser path, `#payments` for `none` or a chooser path, `#brand` for a profile that names a `brand` |
| `env.development`, `env.e2e`              | dropped — a named environment in a deployed config is a second Worker                                                                            |

`assets.directory` becomes the profile's `webClient`, relative to the profile,
when it names one: a white-label's own staged client (below).

The identity vars the app Worker gains: `NATIVE_SLICE_2_AUTH` (the profile's
`nativeAuth` list, comma-joined),
`FROCK_AI_GATEWAY_ID`, `FROCK_AI_ACCOUNT_ID`, `FROCK_AI_AUTO_ROUTE`, `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` when the profile
builds the Access auth Package, and `EMAIL_DOMAIN` when it names an `email`
domain (below), `VOICE_PROVIDER` when it names a `voice.provider`
(`gemini-live`, the default, or `openai-realtime`; `docs/voice.md`), and `NATIVE_APPS` — the profile's `nativeApps` as JSON — when it
names the signed apps its association files list, and the `authEnvironment.vars`
of a profile whose auth Package is its own (below). `FROCK_AI_ACCOUNT_ID` is what selects the compat
HTTP transport, the only one that accepts a `dynamic/<route>` model
(cloudflare/ai#617); a profile with no `aiGateway` takes the `AI` binding, where
Auto resolves to a concrete Workers AI model instead.

`-c` changes the directory wrangler resolves relative paths against, so `main`,
`assets.directory`, `migrations_dir`, `$schema` and the containers' `image` and
`image_build_context` are rewritten to point from the written location at the
same files they pointed at before. `deployment-config.test.ts` resolves both
sides and compares the targets, so a rewrite that drifts fails there.

The tracked `name` stays: it is the name `wrangler dev` and the e2e harness give
the local Worker, and every generated config overrides it from the profile.

Some fields keep a placeholder rather than nothing: wrangler's validator refuses a `services` entry with no target and a `vectorize` entry with no index even in a config it never deploys, so the app Worker's two services and its Vectorize binding, and the admin portal's one service, all say `named-by-deployment-config`. Nothing reads those values — `wrangler dev --env development` and the `e2e` harness resolve their own environments, and the generator writes the deployment's own names. A bucket or database name is left out entirely, because wrangler does not ask for one.

`adminEmails` and `adminUserIds` are in the schema and in no generated config.
They are the `FROCKBOT_ADMIN_EMAILS` and `FROCKBOT_ADMIN_USER_IDS` secrets the
installer sets; the hosted deployment already carries the first as a repository
secret, which is why `hosted.json` omits it. An email makes an admin only once
the auth Package's provider verified it, so a deployment whose people have no
email names its admins by User id; `frockbot-deployment-config secrets` carries
`FROCKBOT_ADMIN_USER_IDS` like any other optional secret.

## Brand

What a person sees — the product's name, the built-in model's name, the
homepage outbound requests point back to, the icon and page logo, the palettes
behind the named looks and whether What's New is served — is a `BrandV1`
(`core/contracts/brand.ts`), chosen at build time the way the auth Package is
([ADR 0038](../../../docs/adr/0038-white-label-deployments.md)). The Worker imports
it through `#brand`, which `apps/cloudflare/package.json` maps to FrockBot's own,
`apps/cloudflare/src/brand.ts`, and hands it to app code as data. A profile that
names another module, relative to the profile file:

```json
"brand": "./wallet-pal/brand.ts"
```

gets a generated `alias` for `#brand` to it, and the generator imports it and
refuses a brand whose looks fail the ThemeDocument decoder or contrast floor, or
whose icon is not there. The hosted and staging profiles name none, so their
configs carry no alias.

The application artifact is bundled by `apps/cloudflare/build-artifact.ts`, not
by wrangler, so the alias never reaches it. Build it with the same module:

```
bun run apps/cloudflare/build-artifact.ts --brand deployments/wallet-pal/brand.ts
```

Without `--brand` it resolves `#brand` through the package import, which is
FrockBot's. Its icon, `src/brand-icon.png`, is a copy of
`assets/marketing/app-icon/frockbot-icon-64.png` kept inside the package so the
published default builds too; `src/brand.test.ts` holds the two to the same
bytes.

Where a deployment runs and which native apps sign in to it are the profile's
(`nativeApps`), not the brand's.

## Email

Email to and from Bots is off until a profile names one domain for both
directions:

```json
"email": { "domain": "bots.frockbot.com" }
```

Each Bot's address is its name and the account's username at it,
`fox.tim@bots.frockbot.com` (`docs/architecture.md`, "By email"): mail to the
Bot arrives there, and mail from the Bot leaves from there. The generated app
config gains the var both directions read and the sender's binding:

```json
"vars": { "EMAIL_DOMAIN": "bots.frockbot.com" },
"send_email": [{ "name": "SEND_EMAIL" }]
```

The binding names no sender, deliberately. Every Bot sends from its own
address, and a `send_email` binding cannot be told "any address on one
domain": `allowed_sender_addresses` is a list of exact addresses, with no
wildcard or domain form ([send bindings][send-bindings], read 2026-09-25). So
`app/email/sender.ts` holds the domain instead — the kernel composes every
`from` itself, and the sender refuses one that is not on `EMAIL_DOMAIN` before
the binding is reached — and Email Service refuses any domain the account has
not onboarded. It names no destination either: a Bot writes to its person, and
a draft card to whoever the person approved.

`hosted` names `bots.frockbot.com`; `staging` names none, so staging receives
and sends no email. What the domain needs in Cloudflare, once per deployment:

1. **Choose the domain.** Both Email Routing and Email Sending take over its
   records, so it must receive no mail through another provider; a subdomain
   of the app's zone is the simple choice. It may be the apex: a Bot's address
   always has a dot before the `@`, so a plain mailbox like `hello@` is never a
   Bot's and the Worker refuses it.
2. **Receiving.** In the dashboard, open the zone → **Email** → **Email
   Routing** and enable it for the domain (for a subdomain, add it under
   **Settings → Subdomains**), accepting the MX and SPF records it asks for.
   Under **Routing rules**, set the **Catch-all address** to **Send to a
   Worker**, choose the app Worker (`frockbot-cloudflare` for the hosted
   profile), and enable it. A plain mailbox that should reach a person, such as
   `postmaster@`, gets its own custom address above it; no username can be one
   of those names.
3. **Sending.** Workers Paid (3,000 messages a month included, then $0.35 per
   1,000), then **Compute › Email Service › Email Sending › Onboard Domain**
   for the same domain. Cloudflare writes MX, SPF and DKIM on the `cf-bounce`
   subdomain and DMARC on `_dmarc.<domain>`; for `bots.frockbot.com` those are
   live, with `p=reject`. Until the domain is verified every send is refused
   with `E_SENDER_NOT_VERIFIED`, which the sender reports as "not sent" and
   never as "may have sent". A new account starts on a conservative daily
   quota, which the Limit Increase Request Form raises; past it a send is
   refused with `E_DAILY_LIMIT_EXCEEDED` and nothing leaves.
4. **The profile.** Add `email`, and for `hosted` update
   `scripts/deployment-config/fixtures/hosted/app.wrangler.jsonc` in the same commit — the equivalence
   gate below exists to make exactly that visible. Until the deploy lands the
   Worker has no domain: it refuses every message and sends none.
5. **Check it.** In the app, choose a username under Account → Email
   username, switch a Bot's settings → Email on, and send it a message from
   your sign-in address; ask it to email you back. The Worker logs one
   `inbound-email` line per message with its outcome; a `rejected` with code
   `unauthenticated` means the message carried no DMARC verdict the Worker
   believes (`docs/known-issues.md` 51).

Removing `email` turns both directions off again: every message is refused,
nothing is sent, and the addresses start working again when it comes back.

[send-bindings]: https://developers.cloudflare.com/email-service/configuration/send-bindings/

## The equivalence gate

`scripts/deployment-config/fixtures/hosted/` holds the five wrangler configs exactly as production and
staging ran them before identity moved out. `scripts/deployment-config.test.ts`
generates `hosted` and `staging` and proves the result is still those files,
comments, key order and path spelling aside — because a Worker name, Durable
Object class or migration tag that differs on deploy is a new namespace, which is
data loss. It runs under `bun test`, so `Check` and `main.yml` enforce it, and
`release.yml` runs it again as a dry run before `deploy-backend` deploys.

Changing a binding, a migration or a var means updating the fixture in the same
commit. That is the point: the change is seen rather than discovered in
production.

Two things the fixtures make explicit:

- **The staging expectation is derived.** The gate resolves `env.staging` over
  the fixture's top level the way `wrangler --env staging` does, and asserts
  staging redefines every non-inheritable key so that overlay is that
  resolution. It also asserts staging's Computer host and Plugin build service
  are production's Workers, which is deliberate: both are stateless request
  handlers holding no per-user data, so staging exercises the ones production
  runs rather than paying for a second container deployment. The consequence is
  production's ordering constraint — a change to the host's contract ships with a
  tag, so staging sees it only once that tag lands.
- **Staging's `AUTH_DB` identifier is not in its profile.** The staging deploy
  creates the database if absent and resolves its identifier from
  `wrangler d1 list` in the same job, then passes it with `--d1-database-id`.
  That replaced the regex that used to rewrite the tracked file in place.

## What a release publishes, and what an installer pulls

A deployer runs `wrangler deploy -c` in their own account with no Docker and no
Flutter, so everything those two would have produced is published by
`release.yml` for the tag and fetched from it (ADR 0028 step 5).

**The container images**, by the `publish-images` job, built once from the
repository root context for `linux/amd64` and pushed under two tags each:

| Image                                             | Built from                      |
| ------------------------------------------------- | ------------------------------- |
| `docker.io/timoconnellaus/frockbot-computer-host` | `apps/computer-host/Dockerfile` |
| `docker.io/timoconnellaus/frockbot-applet-build`  | `apps/applet-build/Dockerfile`  |

`:<version>` is the release, `:latest` is the newest release. A profile names
them by setting `images`:

```json
"images": { "source": "registry", "registry": "docker.io/timoconnellaus", "tag": "0.7.20" }
```

and the generator writes `"image": "<registry>/frockbot-<worker>:<tag>"` with no
`image_build_context`. `"source": "dockerfile"`, which is also what an absent
`images` means, keeps today's behaviour — wrangler builds the image locally,
which is what the hosted profile still does. `CONTAINER_IMAGE_REPOSITORIES_V1`
and `PUBLISHED_IMAGE_REGISTRY_V1` in `generate.ts` are the one spelling of these
names, and `deployment-config.test.ts` proves `release.yml` pushes the same ones.

**What a deployer's account needs for the pull: nothing.** Cloudflare Containers
pull from [four registries][image-management] — the Cloudflare managed registry,
Docker Hub, Amazon ECR and Google Artifact Registry — and of those Docker Hub is
the only one where a public image needs no credentials: "Public Docker Hub images
do not require registry configuration." So the installer sets no registry
credentials and runs no `wrangler containers registries configure`. Two
consequences worth knowing:

- **GHCR is not one of the four.** `ghcr.io` images cannot be pulled by the
  platform at all; the documented way to use an image from any other registry is
  to pull it locally and `wrangler containers push` it, which needs the Docker
  the installer is avoiding.
- Cloudflare does not cache Docker Hub pulls, so a deployment is subject to
  Docker Hub's anonymous pull limits. A deployer who hits them configures their
  own read-only Docker Hub token once, with
  `wrangler containers registries configure docker.io --dockerhub-username=<user>`;
  the images themselves stay public.

Publishing needs the repository secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` (a Docker Hub personal access token with write access to the
`timoconnellaus` namespace, which is that account's username; no organisation
is needed). While they are unset, `publish-images` skips with a warning and
`deploy-backend` does not wait on it, so the hosted deployment keeps shipping.
Once the simple profile is announced, `deploy-backend` gains `publish-images`
in its `needs`, so a tag production is running is always a tag an installer can
install.

**The deploy bundle**, built by `release-assets` and attached by
`github-release`: `frockbot-deploy-<version>.json`, the manifest, and
`frockbot-deploy-<version>.tar.gz`. Together they hold the simple profile's three
Workers prebuilt, the web client as the app's assets and the application
artifact under its own sha256. The manifest names every Worker's modules,
bindings, migrations, secrets and container images, with `{install}` where an
install's name goes. `bun run setup` installs from it through the Cloudflare API,
and so will the deploy page. Nothing is generated or built on the deployer's
machine. The format, the gate that keeps an update on the same namespaces and
the proof are in [`docs/deploy-bundles.md`](../../../docs/deploy-bundles.md).

A generated config still carries the placeholder
`"DEFAULT_APPLICATION_HASH": "foundation-v1"` from the tracked file unless
`--application-hash` names the real one. `deploy-backend` rewrites the written
file in place in its `Configure application artifact` step, and the bundle build
passes the artifact's digest. A Worker whose var still says `foundation-v1` looks
for an object that is not there.

`frockbot.apk` is also attached, by `patch-android` when the tag cut a full release and by `android-apk` otherwise. It is the hosted phone app,
not an installer asset: `bun run setup` does not download it, and a deployer
who wants the phone app builds it against their own origin (`docs/app-updates.md`).

[image-management]: https://developers.cloudflare.com/containers/image-management/

## White-label

A white-label product is its own repository that installs FrockBot's packages at
a release version ([ADR 0038](../../../docs/adr/0038-white-label-deployments.md)).
Every workspace the Worker's graph reaches is published by `release.yml`'s
`publish-npm` job at the tag's version — `@frockbot/core`, `app`, `providers`,
`computer`, `frock-compose`, `applets` and this package, `@frockbot/cloudflare`
— listed once in `scripts/npm-publish.ts`, which rewrites every `workspace:*`
between them to that exact version. Pin the same exact version of each.

Its repository holds a profile, a brand module, its own auth Package, its own
payments Package if it takes payment, and its own thin Flutter application:

```json
{
  "schemaVersion": 1,
  "name": "wallet-pal",
  "accountId": "…",
  "prefix": "wallet-pal",
  "authPackage": "../auth/chooser.ts",
  "authEnvironment": {
    "secrets": [{ "name": "SIGN_IN_SECRET", "why": "Signs every session." }],
    "vars": { "SIGN_IN_APP": "…" }
  },
  "payments": "../payments/chooser.ts",
  "paymentsEnvironment": {
    "secrets": [
      { "name": "PAYMENTS_SECRET", "why": "Verifies payment events." }
    ]
  },
  "brand": "../brand/brand.ts",
  "webClient": "../client/web",
  "workers": { "app": { "hostnames": ["app.wallet-pal.example"] } }
}
```

- **`authPackage` by path** names a chooser module the white-label wrote: it
  exports `AUTH_PACKAGE_V1: AuthPackageBuildV1<AuthPackageEnvironmentV1>` and
  the `AuthPackageEnvironmentV1` type, from nothing but
  `@frockbot/core/contracts`, as `src/auth-package.ts` does. The generator
  aliases `#auth-package` to it, imports it, refuses one that names itself
  `better-auth` or `access`, and refuses a profile whose `authEnvironment` does
  not name exactly the settings the chooser's `required` lists — each as a
  secret the deploy carries or a var the config carries. It binds `AUTH_DB` only
  when the profile names a `d1DatabaseId`.
- **`payments`** names `stripe` (the tracked default, and what an absent field
  means), `none` for a deployment that does not bill, or a chooser module the
  white-label wrote: it exports `PAYMENTS_PACKAGE_V1:
PaymentsPackageBuildV1<PaymentsPackageEnvironmentV1>` and the
  `PaymentsPackageEnvironmentV1` type, from nothing but
  `@frockbot/core/contracts`, as `src/payments.ts` does. The generator aliases
  `#payments` to it and holds it to `paymentsEnvironment` exactly as it holds
  an auth chooser to `authEnvironment`. See [docs/billing.md](../../../docs/billing.md#the-payments-package).
- **Secrets.** The production-secrets manifest (`src/production-secrets.ts`)
  cannot import a chooser it was not built with, so the profile's
  `authEnvironment.secrets` and `paymentsEnvironment.secrets` are what it
  requires in place of a built-in Package's:

  ```
  frockbot-deployment-config secrets wallet-pal check
  frockbot-deployment-config secrets wallet-pal write-secrets-file secrets.json
  wrangler deploy -c .deployment/wallet-pal/app/wrangler.jsonc --secrets-file secrets.json
  ```

- **The client** is built from the white-label's own application, and the
  artifact with its brand:

  ```
  bun node_modules/@frockbot/cloudflare/build-flutter-web.ts --app . --dist dist
  bun node_modules/@frockbot/cloudflare/build-artifact.ts --brand brand/brand.ts --dist dist
  ```

  `webClient` then names `dist/web` relative to the profile, and
  `dist/artifacts/foundation-v1.mjs` goes into the artifacts bucket under its own
  sha256, which `--application-hash` names.

- **Only the app Worker is in the package.** The Computer host and the Plugin
  build service are deployed from a FrockBot checkout of the same release,
  whose profile may pull the images `publish-images` pushes; a profile outside
  this repository that names them is refused with that reason.

`scripts/white-label-fixture/` is such a repository in miniature, with a STUB
auth Package and a STUB payments Package, and `bun run build:white-label`
(`scripts/white-label-fixture.ts`) is the gate that proves the packages are
consumable: it packs every published workspace exactly as the release does,
installs the tarballs with npm into a scratch consumer, typechecks its choosers
and brand with stock TypeScript, has its payments Package credit an account
through the published ledger's port from a test webhook, runs the bin, the
secrets check and the artifact build, and runs `wrangler deploy --dry-run`,
checking that the bundle carries its choosers and brand and neither
better-auth, Stripe nor FrockBot's brand. It runs with the build category and in
`main.yml`'s `Validate` job.

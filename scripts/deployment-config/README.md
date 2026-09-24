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

`deployments/profile.schema.json` is the contract. `ajv` refuses a profile that
does not meet it, so a missing account or a malformed hostname fails before a
config is written rather than during a deploy. The TypeScript type is generated
from the same document: `scripts/generate-deployment-profile-schema.ts` writes
`profile-schema.generated.ts` as `FromSchema` with `parseIfThenElseKeywords`, so
an Access profile that names no Access application is invalid at the type as
well. `bun run typecheck` fails when that file is stale.

Two values are flags rather than profile fields, because whoever deploys resolves
them in the same run: `--d1-database-id` for a disposable stage that creates its
database, and `--application-hash` for the sha256 of the application artifact the
deployer just uploaded, which is the R2 key the Worker loads it from. Without the
second, the config keeps the tracked placeholder `foundation-v1`, which is no
object in anybody's bucket.

## Simple deployment

Nobody writes `deployments/simple.json` by hand. `bun run setup`
(`scripts/setup.ts`) does: it picks the account, asks for the hostname, the admin
emails and the Zero Trust team, writes the profile, runs this generator, creates
the buckets and the index, mints the internal secrets, asks for the Fly token the
Computer host needs, sets up the two Access applications — Allow on the app's
hostname, Bypass on `/api` — downloads the client and the application
artifact for the checked-out tag, and deploys the three Workers.
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

| Tracked                                   | Generated                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| no `account_id`                           | the profile's account                                                                                     |
| no `routes`                               | the Worker's hostnames as custom domains, or `workers.dev`                                                |
| bindings with no bucket, index or db name | the profile's resource names, derived from `prefix`                                                       |
| `services` with no target                 | the profile's own Worker names: the Computer host, the build service, and the app Worker the portal binds |
| `vars` without identity                   | plus the identity vars below                                                                              |
| `containers[].image` a Dockerfile path    | the published image, when the profile's `images.source` is `registry`                                     |
| `env.development`, `env.e2e`              | dropped — a named environment in a deployed config is a second Worker                                     |

The identity vars the app Worker gains: `NATIVE_SLICE_2_AUTH` (the profile's
`nativeAuth` list, comma-joined),
`FROCK_AI_GATEWAY_ID`, `FROCK_AI_ACCOUNT_ID`, `FROCK_AI_AUTO_ROUTE`, and `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` when the profile
builds the Access auth Package, and `INBOUND_EMAIL_DOMAIN` when the profile
names `inboundEmail` (below). `FROCK_AI_ACCOUNT_ID` is what selects the compat
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

`adminEmails` is in the schema and in no generated config. It is the
`FROCKBOT_ADMIN_EMAILS` secret the installer sets; the hosted deployment already
carries it as a repository secret, which is why `hosted.json` omits it.

## Inbound email

Email your Bot is off until a profile names a domain for it:

```json
"inboundEmail": { "domain": "in.frockbot.com" }
```

That becomes the app Worker's `INBOUND_EMAIL_DOMAIN` var, and each Bot's
address is a random token at it (`docs/architecture.md`, "By email"). The
generator writes the var; the mail itself is routed in Cloudflare, by hand,
once per deployment:

1. Use a domain, or a subdomain, that receives no other mail — every address
   at it is a Bot's. A subdomain of the app's zone (`in.frockbot.com`) is the
   simple choice.
2. In the Cloudflare dashboard, open that zone → **Email** → **Email
   Routing** and enable it for the domain (for a subdomain, add it under
   **Settings → Subdomains**). Cloudflare adds the MX and SPF records it asks
   for; accept them. No destination address is needed.
3. Under **Routing rules**, set the **Catch-all address** to **Send to a
   Worker** and choose the app Worker (`frockbot-cloudflare` for the hosted
   profile), then enable the catch-all.
4. Add `inboundEmail` to the profile, and deploy. Until this deploy lands,
   the Worker has no domain and refuses every message it is handed.
5. Check it: in the app, open a Bot's settings → Email → Create address, and
   send it a message from your sign-in address. The Worker logs one
   `inbound-email` line per message with its outcome; a `rejected` with code
   `unauthenticated` means the message carried no DMARC verdict the Worker
   believes (`docs/known-issues.md` 51).

Removing `inboundEmail` turns email off again: every message is refused, and
the addresses already made start working again when it comes back.

## The equivalence gate

`fixtures/hosted/` holds the five wrangler configs exactly as production and
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

**The release assets**, by `release-assets` and attached by `github-release`:

| Asset                                         | What it is                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `frockbot-web-client-<version>.zip`           | `apps/cloudflare/dist/web` — unpack into it, and the generated config's `assets.directory` is the app Worker's payload   |
| `frockbot-application-artifact-<version>.mjs` | `dist/artifacts/foundation-v1.mjs` — put in the `APPLICATION_ARTIFACTS` bucket under `applications/<its own sha256>.mjs` |

The artifact's key is its own sha256, and a generated config carries the
placeholder `"DEFAULT_APPLICATION_HASH": "foundation-v1"` from the tracked file
unless `--application-hash` names the real one. `bun run setup` passes it once it
has computed the digest of the artifact it downloaded; `deploy-backend` rewrites
the written file in place instead, in its `Configure application artifact` step. A
Worker whose var still says `foundation-v1` looks for an object that is not there.

`frockbot.apk` is also attached, by `patch-android` when the tag cut a full release and by `android-apk` otherwise. It is the hosted phone app,
not an installer asset: `bun run setup` does not download it, and a deployer
who wants the phone app builds it against their own origin (`docs/app-updates.md`).

[image-management]: https://developers.cloudflare.com/containers/image-management/

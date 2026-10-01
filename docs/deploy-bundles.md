# Deploy bundles

Every release publishes the simple profile's Workers **prebuilt**, with a
manifest that says how to install them into somebody's Cloudflare account
through the REST API alone. Nothing is built on the deployer's machine: no
wrangler build, no Docker, no Flutter. `scripts/deploy-bundle.ts` installs from
the bundle with a token, and so does [frockbot.com/deploy](hosted-deploy.md),
which runs the same deployer with the person's own Cloudflare sign-in. The
profile itself is
[ADR 0028](adr/0028-open-deployment.md).

## What a release publishes

`release.yml`'s `release-assets` job builds the bundle
(`scripts/build-deploy-bundle.ts`), and `github-release` attaches two files to
the tag's GitHub Release:

| Asset                              | What it is                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `frockbot-deploy-<version>.json`   | The manifest. The deploy page and the update check read this.                     |
| `frockbot-deploy-<version>.tar.gz` | Every file the manifest names, each by its `path`. Its sha256 is in the manifest. |

The container images the bundle names are the ones `publish-images` pushes to
Docker Hub for the same tag. Until that job has credentials it publishes none,
and a bundle whose images were never pushed cannot start its containers.

The archive holds:

```
workers/cloudflare/index.js        the app Worker
workers/computer-host/index.js     the Computer host
workers/applet-build/index.js      the Plugin build service
assets/app/…                       the Flutter web client, the app Worker's assets
application-artifact.mjs           the application artifact the app loads from R2
```

The modules are wrangler's own bundle, from `wrangler deploy --dry-run --outdir`,
of the configs `deployment-config` generates for the simple profile
(`scripts/deploy-bundle/simple-profile.ts`). A build therefore produces what a wrangler deploy of
that profile would have uploaded. Source maps are left out.

## The manifest

```jsonc
{
  "schemaVersion": 1,
  "kind": "frockbot-deploy-bundle",
  "version": "0.9.3",
  "profile": "simple",
  "protocol": { "min": 2, "max": 4 }, // the client protocol range this server speaks
  "archive": { "file": "frockbot-deploy-0.9.3.tar.gz", "sha256": "…" },
  "install": { "token": "{install}", "pattern": "^[a-z0-9][a-z0-9-]{0,40}$" },
  "resources": {
    "r2Buckets": ["{install}-application-artifacts", "{install}-memory-files"],
    "vectorizeIndexes": [{ "name": "{install}-memory", "dimensions": 768, "metric": "cosine" }]
  },
  "applicationArtifact": {
    "path": "application-artifact.mjs",
    "sha256": "…",
    "bucket": "{install}-application-artifacts",
    "key": "applications/<sha256>.mjs"
  },
  "workers": { "app": { … }, "computerHost": { … }, "appletBuild": { … } }
}
```

Each Worker entry:

| Field                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                                    | The script name, templated: `{install}`, `{install}-computer-host`, `{install}-applet-build`.                                                                                                                                                                                                                                                                                        |
| `optional`                                | `true` for the Computer host. It is deployed only when the install runs its own Computer host on its own Fly account, and the app then carries no `COMPUTER_HOST` binding.                                                                                                                                                                                                           |
| `contentHash`                             | sha256 over the canonical JSON of the entry, `contentHash` aside. It covers every module's and asset's hash, every binding and every migration, so two releases with the same `contentHash` deploy the same Worker.                                                                                                                                                                  |
| `mainModule`, `modules`                   | The ES modules, each with its archive `path`, `sha256` and `size`. A deployer refuses a module whose bytes do not hash to the manifest's value.                                                                                                                                                                                                                                      |
| `compatibilityDate`, `compatibilityFlags` | As the tracked `wrangler.jsonc` sets them.                                                                                                                                                                                                                                                                                                                                           |
| `bindings`                                | In the Workers script upload API's own shape (`{type, name, …}`), with every resource name templated.                                                                                                                                                                                                                                                                                |
| `installVars`                             | Plain-text vars the install supplies: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `APP_ORIGIN` from its own hostname.                                                                                                                                                                                                                                                                    |
| `secrets`                                 | By name, never by value. `required` refuses a first install without it. `mint` (`hex`, `keyring`, or `vapid` for the Web Push key pair, whose subject is the install's hostname) means the deployer generates it once and never again. `sharedWith` names another Worker holding the same value. `requiredWith` means it is required only when that optional Worker is deployed too. |
| `migrations`                              | The Durable Object migration history, exactly as the tracked config writes it.                                                                                                                                                                                                                                                                                                       |
| `containers`                              | Per container class: the templated application `name` (wrangler's default, `<script>-<class>`), the registry `image` for this release, `instanceType` and `maxInstances`.                                                                                                                                                                                                            |
| `assets`                                  | The app's static files, each with its served `path`, archive path, Workers assets `hash`, `size` and `contentType`. Also the assets `config`, and `_headers` as text.                                                                                                                                                                                                                |
| `workersDev`, `customDomains`             | Whether the script is reachable on `workers.dev`, and whether the install's hostnames are its custom domains. An install that names no hostname puts the app on `workers.dev` instead: that is how the deploy page installs, with Access in front and no zone.                                                                                                                       |

The assets `hash` is Workers' own: BLAKE3 over the base64 of the file and its
extension, first 32 hex characters. The build computes it, so a deployer in a
browser needs no BLAKE3.

## Install names

An install is named once, and every Worker, bucket, index and container
application is derived from that name by replacing `{install}`, so an install
`scripts/deploy-bundle.ts` made and one the deploy page made under the same name
are the same install.

The templates are not written out separately. The bundle is generated under a
sentinel prefix, and whatever the generator derived is taken as derived.
`scripts/deploy-bundle.test.ts` proves that instantiating the manifest for a
name gives exactly the names `bun run deployment:config` writes for that prefix.

## The equivalence gate

A Worker name, Durable Object class or migration tag that differs on deploy is
a new namespace, which is data loss. ADR 0028's gate holds the hosted configs to
fixtures. Bundles are held in three more places:

1. **The identity fixture.** `scripts/deployment-config/fixtures/bundle/identity.json`
   records each Worker's templated name, Durable Object bindings, the stores it
   binds, its migration tags and its container applications. A change to any of
   them fails `bun test` until the fixture changes in the same commit, where it
   is seen.
2. **Release to release.** Before a bundle is attached, `release-assets` runs
   `scripts/check-deploy-bundle.ts` against the newest Release's manifest
   (`bundleSuccessionProblemsV1`). It refuses:
   - a renamed Worker, bucket, index or container application;
   - a binding to durable data whose target moved;
   - a reshaped index;
   - a migration history that is not the previous one with steps appended.
3. **Against the live install.** Before the deployer touches anything, it reads
   the account's scripts and Durable Object namespaces
   (`installSuccessionProblemsV1`). It refuses:
   - a script at a migration tag the bundle's history lacks: another lineage,
     a newer release, or a hand deploy;
   - a namespace whose class the history never names;
   - Durable Objects on a script with no migration tag.

## Deploying one

`apps/cloudflare/deployment-config/deploy.ts` (`deployBundleV1`) makes the calls
`wrangler deploy` makes (wrangler 4.129), against the v4 API with a bearer token:

1. **Gate.** `GET /workers/services/<script>` for each script's migration tag, and
   `GET /workers/durable_objects/namespaces`. Then the checks above.
2. **Resources.** Each R2 bucket and the Vectorize index is created if absent:
   `POST /r2/buckets`, `POST /vectorize/v2/indexes`. The Analytics Engine dataset
   creates itself on its first write, and there is no D1: the Access Package
   stores nothing.
3. **The application artifact.** `PUT /r2/buckets/<bucket>/objects/applications/<sha256>.mjs`.
   It is content-addressed, so a second put writes the same bytes.
4. **Each Worker, in dependency order:** Computer host (when chosen), build
   service, app.
   - For the app, the assets upload session goes first:
     - `POST /workers/scripts/<script>/assets-upload-session` sends the manifest of hashes;
     - `POST /workers/assets/upload?base64=true` then sends, under the session's JWT, only the files Cloudflare asked for;
     - the completion JWT goes into the upload's `metadata.assets`.
   - `PUT /workers/scripts/<script>` uploads the modules as multipart. Its
     metadata carries:
     - the bindings, with names resolved;
     - the install's vars;
     - the secrets it was given, as `secret_text`;
     - `keep_bindings: ["secret_text", "secret_key"]`, so an update needs no secret again;
     - the migrations after the deployed tag (`old_tag`/`new_tag`/`steps`);
     - the container classes;
     - the release in `annotations`.
   - For a container class, `POST /containers/applications` creates the
     application, bound to the class's namespace id. An existing application is
     moved to the release's image with `PATCH` and a `rollouts` call. Cloudflare
     pulls the public Docker Hub image itself; nothing is pushed.
   - `POST /workers/scripts/<script>/subdomain` sets the workers.dev route.
   - For the app, `PUT /workers/scripts/<script>/domains/records` attaches the
     install's hostnames.

Every step converges, so an update is the same call with the next release's
bundle. The token needs Workers Scripts, Workers R2 Storage, Vectorize and
Containers write, and Workers Routes on the hostname's zone.
`scripts/deploy-bundle.ts` uses `CLOUDFLARE_API_TOKEN`, or the `wrangler login` token that `wrangler auth token`
prints.

Access is not the deployer's job. The Access applications and their policies
are made outside it: by hand for `scripts/deploy-bundle.ts`, and the deploy page
will make its own.

## The proof

`scripts/deploy-bundle.ts` installs a bundle into a scratch account through the
same deployer, with nothing but a token:

```sh
export CLOUDFLARE_API_TOKEN=…  # scratch account, the scopes above
export FROCKBOT_ACCESS_TOKEN=… # the CF_Authorization cookie, after signing in once
bun scripts/deploy-bundle.ts prove \
  --from 0.9.2 --to 0.9.3 \
  --account scratch --hostname bot.scratch.example \
  --access-team --access-aud \
  .deployment/scratch-secrets.json <id >--install <team >.cloudflareaccess.com <aud >--secrets
```

`prove` runs the whole claim in order:

1. Install the first release.
2. Hold a conversation with the General Bot, through `/api/bots/<id>/turns`.
3. Deploy the second release over the install.
4. Read the first Turn back unchanged, which shows the Durable Objects kept their data.
5. Hold a second conversation.

`--from` and `--to` also take a local manifest path, for a bundle built with
`scripts/build-deploy-bundle.ts`.

The secrets file must hold `SPRITES_TOKEN` unless you pass `--no-computer-host`.
The deployer mints the rest into the same file.

A conversation needs a person. An Access deployment stores no identities, so the
debug surface cannot speak for anyone. The script therefore talks as whoever's
`CF_Authorization` cookie it was given. `/api` is bypassed at the edge, and the
Worker verifies that cookie itself.

# Deployment configs

Deployment identity — the Cloudflare account, the Worker names, the hostnames,
the resource names and the identity vars — lives in `deployments/<name>.json`.
The tracked `wrangler.jsonc` files hold bindings, migrations, the local
environments and their comments, and nothing that names a deployment.

```
bun run deployment:config hosted
bun run deployment:config staging --d1-database-id <uuid>
```

writes `.deployment/<profile>/<worker>/wrangler.jsonc`, which is what every
`wrangler deploy -c`, `wrangler d1 migrations apply -c` and `wrangler r2 object
put -c` in `release.yml` and `main.yml` takes. `.deployment/` is git-ignored.

`deployments/profile.schema.json` is the contract; `ajv` refuses a profile that
does not meet it, so a missing account or a malformed hostname fails before a
config is written rather than during a deploy.

Five deployables: the app Worker, the Computer host, the Applet build service,
the marketing site and the admin portal. A profile generates exactly the ones it
names, which is how `staging.json` has neither the marketing site nor the portal
— and how the simple profile will have neither, since with Access deciding
admission there is no admin operation left to administer.

## What a generated config is

The tracked file, with identity applied:

| Tracked                                   | Generated                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| no `account_id`                           | the profile's account                                                                                     |
| no `routes`                               | the Worker's hostnames as custom domains, or `workers.dev`                                                |
| bindings with no bucket, index or db name | the profile's resource names, derived from `prefix`                                                       |
| `services` with no target                 | the profile's own Worker names: the Computer host, the build service, and the app Worker the portal binds |
| `vars` without identity                   | plus the identity vars below                                                                              |
| `env.development`, `env.e2e`              | dropped — a named environment in a deployed config is a second Worker                                     |

The identity vars the app Worker gains: `NATIVE_SLICE_2_AUTH`,
`UI_ARTIFACT_HOSTS`, `FROCK_AI_GATEWAY_ID`, `FROCK_AI_ACCOUNT_ID`,
`FROCK_AI_AUTO_ROUTE`, and `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` when the profile
builds the Access auth Package. `FROCK_AI_ACCOUNT_ID` is what selects the compat
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
  resolution. It also asserts staging's Computer host and Applet build service
  are production's Workers, which is deliberate: both are stateless request
  handlers holding no per-user data, so staging exercises the ones production
  runs rather than paying for a second container deployment. The consequence is
  production's ordering constraint — a change to the host's contract ships with a
  tag, so staging sees it only once that tag lands.
- **Staging's `AUTH_DB` identifier is not in its profile.** The staging deploy
  creates the database if absent and resolves its identifier from
  `wrangler d1 list` in the same job, then passes it with `--d1-database-id`.
  That replaced the regex that used to rewrite the tracked file in place.

## The artifact origin needs a zone

`UI_ARTIFACT_HOSTS` is the anonymous origin an Applet's page is served from, and
ADR 0028 proposed serving it from a second Worker named `<prefix>-ui` so a
deployment with no zone could have one. **It cannot work on `workers.dev`**, for
a reason that has nothing to do with bindings:

- The pairing between the two origins is _derived from the `ui.` prefix_, in
  three places: `packageUiGatewayOriginV1` and `isPackageUiArtifactOriginFor`
  (`apps/cloudflare/src/gateway.ts`) and `appletUiArtifactOriginV1`
  (`applets/preview.ts`). The page's `connect-src` is `ui.<host>` with the prefix
  stripped, and the gateway admits an Applet viewer socket from `ui.<its own
host>` and nothing else.
- A `workers.dev` hostname is `<worker name>.<account subdomain>.workers.dev`,
  and a Worker name cannot contain a dot. No second Worker name can produce a
  hostname of the form `ui.<the app's hostname>`, so a page served from
  `<prefix>-ui.<subdomain>.workers.dev` would be given a `connect-src` naming a
  host that does not exist, and its socket would be refused.

So the generator **requires** `artifactHostname`, and the schema requires it to
be `ui.<something>`: a profile that gives the app Worker a hostname must also
name the artifact origin, which means a zone. The alternative is to make that
pairing explicit configuration in all three places instead of derived — a change
to the Applet path, not to deployment identity, so it is not bundled here.

What the investigation did settle: **the artifact origin needs only R2.**
`servePackageUiArtifact` answers before any identity or Durable Object work — a
request to a configured artifact host reaches nothing else in the gateway — and
the Applet viewer socket is served by the _app_ origin, which is what the page's
`connect-src` names. So if the pairing is ever made explicit, the second Worker
needs the `APPLICATION_ARTIFACTS` bucket and no Durable Object bindings at all,
`script_name` or otherwise.

# frockbot.com/deploy

The hosted way to self-host: someone signs in with Cloudflare, picks a name,
and `/deploy` installs a pinned FrockBot release into the account they signed
in with, then updates it in place when a newer release is out. Nothing is
cloned or built on their machine. The repository path, `bun run setup`, stays
for a custom domain or changed code ([ADR 0028](adr/0028-open-deployment.md)).

The code is `apps/marketing/src/deploy/`, served by the marketing Worker under
`/deploy`. The pages are server-rendered under the site's CSP, and
`public/assets/deploy/` holds their stylesheet and the one small script.

## The flow

1. **Start.** "Sign in with Cloudflare" runs the Authorization Code flow with
   PKCE against `dash.cloudflare.com/oauth2`. Cloudflare's consent screen is
   where someone with several accounts picks one. A grant that reaches
   several accounts is sent back to sign in again with one.
2. **Choose.** The page shows the account, the install name and its
   `workers.dev` address, "Just you", and four account checks. Deploy stays
   off until all four pass, and the server enforces the same rule. The
   reading is kept for the session, and "Check again" reads the account
   afresh.
   - **Workers Paid.** Cloudflare gives third parties no billing scope, so
     the check uploads a one-line Worker, `frockbot-plan-check`, with a
     Worker Loader binding (only Paid accepts one) and deletes it straight
     after.
   - **R2.** Listing buckets fails with 10042 until R2 is turned on.
   - **Workers AI.** The account's catalog serves Jev (`typesafe/jev`),
     which the install's `AI` binding runs and every Turn is supervised by.
   - **Zero Trust.** The Access organization, or the Zero Trust (Gateway)
     account, exists. The fix links to Zero Trust, where the person chooses
     the Free plan.
3. **Deploying.** A Durable Object per Cloudflare user (`DeployAccount`) runs
   the steps by alarm. It writes its state before and after each step, so
   closing the page, an eviction or a failure leaves the deploy resumable.
   "Try again" picks up at the step that stopped. Every step converges, so a
   repeat makes nothing twice.
   1. **Storage.** The R2 buckets, KV namespaces, queues and Vectorize
      indexes, plus the D1 databases with their migrations. Each migration
      and its row in `d1_migrations` (the table wrangler keeps) go in one
      request, so a retry never replays one.
   2. **Sign-in.** The Access organization, if Zero Trust is on without one,
      then two applications ([ADR 0028](adr/0028-open-deployment.md) step 4):
      - Allow on the hostname, for the deployer's email only;
      - Bypass on `/api`, which the Worker authenticates itself.
   3. **Release.** Runs after Sign-in so the install is never reachable
      without Access in front of it. In order:
      1. Upload the web client as static assets (only the files Cloudflare
         lacks).
      2. Put the release's R2 objects.
      3. Upload the Worker with the audience Access issued.
      4. Switch on `workers.dev` last.
   4. **Jev and Workers AI.** Looks for Jev in the catalog again, now as the
      deploy's own step.
   5. **First check.** `/` must redirect to Access. `/api/identity` must be
      refused by the Worker itself (401, JSON). A new `workers.dev` name is
      retried for up to five minutes.
4. **Ready.** The address, Open FrockBot, and how to add the install in the
   apps.
5. **Your installs.** Every install deployed from here, the release it runs,
   and Update when a newer release has a manifest.
   - An update runs the same steps over the same record, so it keeps the
     same resource names.
   - It sends only the Durable Object migrations after the Worker's current
     tag. It refuses a tag the release doesn't continue from rather than
     risk the data.
   - It uploads with `keep_bindings: ["secret_text"]`, so the minted secrets
     that encrypt and sign stored state are never regenerated.

## What is kept, and where

The Cloudflare grant lives only in the person's Durable Object, never in a
cookie or the page, per "Secrets stay server-side".

- **Session.** The cookie is `<cloudflare user id>.<secret>`, and only the
  secret's hash is stored. The grant expires with the session after twelve
  hours.
- **Running deploy.** A deploy holds its own copy of the grant while it runs,
  so it survives the session ending, and drops it when it finishes or fails.
- **Refresh tokens.** They rotate, and the new one is written before it is
  used.
- **Install record.** It holds names and ids so an update redeploys over the
  same ones. It holds no secret: the minted ones are written to the Worker
  and never read back.

## The release manifest

A release that `/deploy` can install attaches `frockbot-deploy-<version>.json`
and every file it names. The newest non-draft release with a manifest is the
one offered. `manifest.ts` is the contract, decoded strictly: an unknown
binding type, a role no resource declares, an asset name with a path in it,
or a digest mismatch stops the deploy rather than shipping a Worker missing
something.

```jsonc
{
  "schemaVersion": 1,
  "version": "0.49.0",
  "highlights": "One line for Your installs.",
  "resources": {
    "r2Buckets": ["application-artifacts", "memory-files"],
    "kvNamespaces": [],
    "queues": [],
    "analyticsDatasets": ["events"],
    "d1Databases": [
      {
        "role": "auth",
        "migrations": [{ "name": "0001_init", "asset": "…sql", "sha256": "…" }],
      },
    ],
    "vectorizeIndexes": [
      { "role": "memory", "dimensions": 768, "metric": "cosine" },
    ],
  },
  "workers": [
    {
      "role": "app",
      "mainModule": "index.js",
      "modules": [
        { "name": "index.js", "type": "esm", "asset": "…js", "sha256": "…" },
      ],
      "compatibilityDate": "2026-08-27",
      "compatibilityFlags": ["nodejs_compat"],
      "bindings": [
        { "type": "ai", "name": "AI" },
        {
          "type": "r2_bucket",
          "name": "MEMORY_FILES",
          "bucket": "memory-files",
        },
        {
          "type": "durable_object_namespace",
          "name": "BOT_STATES",
          "className": "BotState",
        },
        { "type": "access_aud", "name": "ACCESS_AUD" },
      ],
      "migrations": [{ "tag": "v1", "newSqliteClasses": ["BotState"] }],
      "secrets": [{ "name": "CREDENTIAL_KEYRING", "shape": "keyring" }],
      "assets": {
        "asset": "frockbot-web-client-0.49.0.zip",
        "sha256": "…",
        "htmlHandling": "none",
      },
      "r2Objects": [
        {
          "bucket": "application-artifacts",
          "key": "applications/<sha256>.mjs",
          "asset": "…mjs",
          "sha256": "…",
        },
      ],
    },
  ],
}
```

Resources are named by role, and the deployer names each one
`<install>-<role>`.

Bindings take the upload API's types plus five the deployer fills itself:

- `install_origin`: the `https://…workers.dev` origin;
- `access_team_domain` and `access_aud`: what the Sign-in step created;
- `owner_email`: the deployer's email, the single-user allowlist and admin.

Durable Object migrations are the whole history, in order. Secrets are minted
once, as `hex` (32 random bytes) or `keyring` (the app's credential keyring),
and only when the Worker doesn't already hold one by that name.

The app Worker is the only Worker. The Computer host is deployed from inside
the install, only if its owner chooses Your Sprites.

## Setting it up

`/deploy` answers "use the repository" until the marketing Worker has both of
these:

- `CLOUDFLARE_OAUTH_CLIENT_ID`: the production environment variable;
- `CLOUDFLARE_OAUTH_CLIENT_SECRET`: the production environment secret.

`release.yml` passes both to the deploy. To create them:

1. On the frockbot.com account, go to **Manage Account → OAuth clients** (or
   `POST /accounts/{id}/oauth_clients`). Create a client with:
   - grant type `authorization_code`;
   - token endpoint auth `client_secret_basic`;
   - redirect URI `https://frockbot.com/deploy/callback`;
   - the scopes in `DEPLOY_SCOPES_V1` (`oauth.ts`), which are the modern
     dotted names from Cloudflare's scope catalog. Compare them with
     `GET /client/v4/oauth/scopes` when registering: a scope the registration
     lacks fails the whole consent.
2. Give the client a logo and `https://frockbot.com` as its client URL. Verify
   frockbot.com with the `cloudflare_oauth_client_publisher=…` TXT record,
   then make the client public. Until then only members of the frockbot.com
   account can authorize it.
3. Set the two values in the GitHub `production` environment. The next
   marketing deploy carries them.

For a local run, put the same two values and
`DEPLOY_ORIGIN=http://127.0.0.1:8787` in `apps/marketing/.dev.vars`, and
register that callback on a private client.

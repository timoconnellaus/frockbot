# frockbot.com/deploy

The hosted way to self-host: someone signs in with Cloudflare, picks a name,
and `/deploy` installs a pinned FrockBot release into the account they signed
in with, then updates it in place when a newer release is out. Nothing is
cloned or built on their machine: the release is its
[deploy bundle](deploy-bundles.md), installed by the same deployer,
`deployBundleV1`, that `scripts/deploy-bundle.ts` runs, so an install made here
and one made from the repository are the same install. The repository path,
`scripts/deploy-bundle.ts`, stays for a custom domain or changed code ([ADR 0028](adr/0028-open-deployment.md)).

The code is `apps/marketing/src/deploy/`, served by the marketing Worker under
`/deploy`. The pages are server-rendered under the site's CSP, and
`public/assets/deploy/` holds their stylesheet and the one small script.

## The flow

1. **Start.** The page says what the sign-in grants, what gets created, and
   that no access is kept. "Sign in with Cloudflare" runs the Authorization
   Code flow with PKCE against `dash.cloudflare.com/oauth2`. Cloudflare's consent screen is
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
   - **Workers AI.** Jev (`typesafe/jev`), which every Turn is supervised
     by, answers this account. Jev is served only to a Worker's `AI`
     binding: the model catalog doesn't list it and the REST `ai/run` route
     doesn't reach it. So the check puts a Worker with an `AI` binding,
     `frockbot-jev-check`, on the account's `workers.dev` (making the
     subdomain the deploy would make, if there is none), asks Jev one small
     question and deletes the Worker. Only an answer passes: Workers AI
     refuses an unknown model and a malformed question alike, with
     `7003: User Input Error`.
   - **Zero Trust.** The Access organization, or the Zero Trust (Gateway)
     account, exists. The fix links to Zero Trust, where the person chooses
     the Free plan.
3. **Deploying.** A Durable Object per Cloudflare user (`DeployAccount`) runs
   the steps by alarm. It writes its state before and after each step, so
   closing the page, an eviction or a failure leaves the deploy resumable.
   "Try again" picks up at the step that stopped. Every step converges, so a
   repeat makes nothing twice.
   1. **Storage.** The release's bundle is staged in frockbot.com's own R2
      (`DEPLOY_BUNDLES`), once per release for every install: its archive is
      streamed from GitHub through gunzip and a tar reader, its sha256 taken
      on the way, and it counts as staged only if that is the manifest's. No
      Durable Object could hold it unpacked. Then the install's buckets and
      search index.
   2. **Sign-in.** The Access organization, if Zero Trust is on without one,
      then three applications ([ADR 0028](adr/0028-open-deployment.md) step 4):
      - Allow on the hostname, for the deployer's email only;
      - Bypass on `/api`, which the Worker authenticates itself;
      - Bypass on `/.well-known/frockbot.json`, which the apps read before
        anyone signs in.
   3. **Release.** `deployBundleV1`, reading from the staged bundle, with an
      install that names no hostname, so the app answers on `workers.dev`, and
      no Computer host, which the install's own first-run Computer step adds
      if its owner chooses Your Sprites. It runs after Sign-in, so the install
      is never reachable without Access in front of it. The install's vars are
      the Access team and audience and its own origin. Its secrets:
      - The minted ones (`hex`, `keyring`, `vapid`), counted as set once the
        app Worker holds them, because the app is what encrypts and signs
        stored state with them. Until then they are minted afresh and set on
        every Worker that shares them, so a first deploy that stopped between
        two Workers converges. After that they are never sent again, and the
        upload keeps them.
      - Ones only an optional Worker needs are left to whoever deploys it.
      - `FROCKBOT_ADMIN_EMAILS`, the deployer's email, every time.
   4. **Jev and Workers AI.** Asks Jev through the same probe again, now as
      the deploy's own step. A probe that couldn't tell is tried again.
   5. **First check.** `/` must redirect to Access. `/api/identity` must be
      refused by the Worker itself (401, JSON). A new `workers.dev` name is
      retried for up to five minutes.
4. **Ready.** The address, Open FrockBot, and how to add the install in the
   apps.
5. **Your installs.** Every install deployed from here, the release it runs,
   and Update when a newer release has a bundle. Update starts with a new
   sign-in, because the last deploy ended the grant. An update runs the same
   steps over the same record. The bundle's deployer keeps the install's
   names, sends only the Durable Object migrations after the deployed tag,
   refuses an install it would orphan, and keeps every secret already set.

## What is kept, and where

The Cloudflare grant lives only in the person's Durable Object, never in a
cookie or the page, per "Secrets stay server-side". It is an access token and
nothing more: the sign-in asks for no `offline_access`, so there is no refresh
token, and nothing here reaches the account after the access token lapses.

- **Session.** The cookie is `<cloudflare user id>.<secret>`, and only the
  secret's hash is stored. The session lasts twelve hours so the pages can
  show installs and results. Anything that needs Cloudflare after the grant
  ends, or with under ten minutes left on it (a deploy must finish on that
  one token), sends the person to sign in again.
- **Running deploy.** A deploy runs on its session's grant, which outlives
  signing out while the deploy runs. A finished deploy revokes the grant at
  once, even with the page still open. A failed one keeps it so "Try again"
  works, until the person signs out or the token lapses.
- **Install record.** It holds names and ids so an update redeploys over the
  same ones. It holds no secret: the minted ones are written to the Worker
  and never read back.

## Setting it up

`/deploy` answers "use the repository" until the marketing Worker has both of
these:

- `CLOUDFLARE_OAUTH_CLIENT_ID`: the production environment variable;
- `CLOUDFLARE_OAUTH_CLIENT_SECRET`: the production environment secret.

`release.yml` passes both to the deploy, and creates the
`frockbot-deploy-bundles` bucket releases are staged in if it is missing. To
create them:

1. On the frockbot.com account, go to **Manage Account → OAuth clients** (or
   `POST /accounts/{id}/oauth_clients`). Create a client with:
   - grant type `authorization_code` only. The flow never asks for
     `offline_access`, so the registration needs no `refresh_token` grant;
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

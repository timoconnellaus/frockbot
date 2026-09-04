# Cloudflare runtime tests

Two Vitest projects run in local workerd, and they answer different questions.

## `bun run test:workerd` — runtime compatibility

`vitest.config.ts`, files `test/**/*.workerd.ts`. Its worker `main` is
`test/fly-compatibility-worker.ts`, a probe Worker, so these tests drive
Durable Objects and probe subclasses directly. Hermetic; it does not read or
expose a Sprites credential.

## `bun run test:integration` — the `SELF.fetch` integration layer

`vitest.integration.config.ts`, files `test/integration/**/*.integration.ts`.
Its worker `main` is `src/index.ts`, so `SELF` is the deployed gateway and every
test is a real request through it: gateway auth → the User Durable Object → the
`USER_APPLICATIONS` Worker Loader → the actual built
`dist/artifacts/foundation-v1.mjs` → the Bot Durable Object → the outbound
provider seam. The script runs `artifact:build` first, and `test/integration/
fixtures.ts` seeds the built artifact into the local `APPLICATION_ARTIFACTS`
bucket, so the bytes under test are the bytes that would deploy.

Both projects run their files **sequentially** (`fileParallelism: false`). The
fakes are shared: the Computer host fake is one Node-side object the whole run
drives, the Frock AI fake's call log is one array per pool worker, and the
outbound stub's MCP handshake counter and blocked-address tally are Node module
state. Several tests read one of those counts, act, and assert it moved by
exactly one — true only if no other file is acting at the same time. Anything
added here inherits that guarantee; nothing here should reintroduce parallelism
without first giving every fake per-test isolation.

The artifact is checked for staleness at config load. `test:integration` runs
`artifact:build` first, so it is always current there; running `vitest run
--config vitest.integration.config.ts` by hand does not, and the suite would
then exercise whatever was left in `dist/artifacts/` from the last build.
`test/artifact-freshness.ts` compares the artifact's mtime against every source
the bundler recorded in `foundation-v1.mjs.map` (`node_modules` excluded) plus
the `src/client` tree that `vite build` inlines into it, and fails the run by
name if any of them is newer. The fix it names is `artifact:build`.

Authentication uses the gateway's development identity
(`ALLOW_DEVELOPMENT_AUTH: "true"` plus an `x-frockbot-user-id` header), with a
fresh random user id per test so no two tests share Durable Object state. No
secret is required.

`docs/architecture-checks.md` § Integration maps each test to its seam and to
the production incident it guards.

The file suffix matters: root `bun test` matches `*.test.ts` and `*.spec.ts` and
neither `*.workerd.ts` nor `*.integration.ts`, so the pre-commit hook never runs
either project.

## The Computer host fake

`test/computer-host-fake.ts` stands in for the `COMPUTER_HOST` service binding
in both projects. It runs `@frockbot/computer-host-protocol` verbatim — the
same decoder at the seam, the same `problem()` refusals, the same NDJSON exec
framing, the same token check — and the real host Worker's own
`computerHostShardV1`, so a test can prove that every Bot of one User routes to
one container. What it replaces is only the Computer: an in-memory file map and
a scripted exec table instead of a Sprite.

It has to be a stand-in because `@cloudflare/vitest-plugin` cannot build, tag,
or start a container image; its pool never touches Docker. A real container runs
only under `wrangler dev` or in production, and `apps/computer-host/live-test.ts`
is what drives it there.

The fake runs in Node, so a workerd test cannot reach its state directly.
Control travels over the same binding under `/__fake/*` — `reset`, `exec` to
script an answer (exit codes, chunk splits, hangs, 429s), `calls` to read back
what the host was sent, `file`/`files` to seed and inspect the file map. The
real host serves none of those routes and the client never calls them.

`test/computer-host-client.workerd.ts` drives `ComputerHostClient` against it
from inside `ComputerHostClientProbe`, a Durable Object that records each
effect's intent and outcome in real Durable Object storage.

## Shared harness

`test/harness/miniflare.ts` holds what both projects need: the `.dev.vars`
reader, the fixture credential keyring, and the outbound Ollama Cloud stub. The
stub reproduces the authentication asymmetry measured in
`docs/research/ollama-cloud-auth.md` — `GET /api/tags` and `POST /api/show`
answer any key, while `POST /api/chat` and `POST /v1/chat/completions`
authenticate — which is what lets a test prove a Connection is validated by an
inference call rather than by a catalog read. It exports three keys: a good one,
a revoked one (validates, then fails on a Turn), and a bad one.

## `bun run test:e2e` — the browser layer

`e2e/playwright.config.ts`, files `e2e/**/*.e2e.ts`. A real Chromium against
`wrangler dev` running `src/index.ts` and the artifact the harness builds, so
it is the only layer in which the shipped Vue client executes.

`e2e/harness.ts` is the Playwright `webServer`: it runs `artifact:build`, seeds
`dist/artifacts/foundation-v1.mjs` into the local `APPLICATION_ARTIFACTS`
bucket, publishes one Package Catalog generation with
`scripts/publish-catalog.ts` and seeds its pointer and index into
`PACKAGE_CATALOG` (entry documents are read one row at a time and no spec opens
one), starts a fake Ollama HTTP server on a loopback port, and starts
`wrangler dev --env e2e`. That environment exists because `development` marks
`MEMORY_FILES`, `MEMORY_INDEX` and `AI` remote, and a remote binding makes
`wrangler dev` open a Cloudflare API session that a pull request has no
credential for; `e2e` is the same Worker with local bindings and no Vectorize
or remote AI, exactly as `vitest.integration.config.ts` omits them. Every run
gets a fresh `--persist-to` directory and the whole process tree — wrangler is
started in its own process group — is torn down afterwards.

The provider is reached through the Ollama Cloud Package's `api-base-url`
Connection setting. `wrangler dev` has no `outboundService`, so a spec points
its Connection at the fake server the way a User points one at a local Ollama.

The file suffix is `*.e2e.ts`, not `*.spec.ts`: root `bun test` matches
`*.spec.ts` as well as `*.test.ts`, and a Playwright spec loaded by Bun's
runner throws.

`docs/architecture-checks.md` § Browser end to end maps each spec to its seam
and incident.

## The Computer, and what no local pool can prove

There is no opt-in live Sprite probe here any more. The probe that used to sit
in `fly-compatibility.workerd.ts` asserted the workerd chunk-framing failure in
`@fly/sprites`; that path no longer exists, because the SDK is on the Computer
host and a Bot Durable Object reaches a Computer only through the
`COMPUTER_HOST` binding (ADR 0004). `apps/computer-host/live-test.ts` builds the
production image and drives a real disposable Sprite; it is the only thing in
the repository that touches one, and it deletes it in `finally`.

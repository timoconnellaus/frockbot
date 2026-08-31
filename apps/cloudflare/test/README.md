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

## `bun run test:fly:workerd:live` — opt-in boundary probe

Records the known incompatibility between workerd response re-chunking and the
Sprites HTTP exec framing used by provider workspace operations. The probe
passes only when that specific failure is observed and always deletes its
disposable `frockbot-test-*` Sprite.

The outbound stub 403s every host it does not recognise, which previously also
blocked this probe's own traffic and made it record a network refusal instead of
the framing failure. `createOutboundService` now passes `api.sprites.dev` — the
only host the `@fly/sprites` 0.1.0 SDK contacts — through to the real network,
and only when `FROCKBOT_RUN_LIVE_SPRITE_TEST=1`.

The local shared-host compatibility prototype lives in
`apps/fly-host-prototype`. Run its `test:live` script to verify streaming,
files, cancellation, reconstruction, and cleanup through a Cloudflare Container.

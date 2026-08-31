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

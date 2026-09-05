// The `SELF.fetch` integration project.
//
// `vitest.config.ts` boots `test/fly-compatibility-worker.ts`, so its `SELF` is
// a probe Worker and no test there crosses the gateway. Here `main` is
// `./src/index.ts` — the deployed Worker, unmodified — so `SELF.fetch` enters
// production code at the same door a browser does: gateway auth, the User
// Durable Object, the `USER_APPLICATIONS` Worker Loader, the real
// `dist/artifacts/foundation-v1.mjs` artifact, the Bot Durable Object, and the
// outbound provider seam.
//
// A second project rather than a rewrite: the 55 tests the first project runs
// depend on its probe subclasses (`WorkerdBotState`, `CompositionProbe`, …),
// which production `main` does not export. What the two share lives in
// `test/harness/miniflare.ts`.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { readBuiltArtifact } from "./test/artifact-freshness.ts";
import {
  createComputerHostFake,
  FAKE_COMPUTER_HOST_TOKEN,
} from "./test/computer-host-fake.ts";
import {
  createOutboundService,
  TEST_CREDENTIAL_KEYRING,
} from "./test/harness/miniflare.ts";
import {
  createFrockAiFakeWorker,
  FROCK_AI_FAKE_SERVICE,
} from "./test/frock-ai-fake.ts";

// The bytes `test:integration` just built, read here rather than imported with
// Vite's `?raw` from a test file: `tsc` resolves a relative specifier on disk
// and never against an ambient wildcard module, so a `?raw` import would be a
// permanent type error. Reading it here also means a run without a prior
// `artifact:build` dies at config load with the missing path named — and, since
// `readBuiltArtifact` compares the artifact against every source the bundler
// recorded in its map, so does a run against an artifact older than the tree.
// `vitest run --config vitest.integration.config.ts` by hand is the way that
// happens; the failure names the stale files instead of quietly testing bytes
// nobody wrote.
const foundationArtifact = readBuiltArtifact(
  resolve(import.meta.dirname, "dist/artifacts/foundation-v1.mjs"),
  resolve(import.meta.dirname, "src/client"),
);

// better-auth's D1 schema. `gatewayAuth` degrades to an unconfigured stub when
// the Google/better-auth secrets are absent (they are, and the suite adds
// none), but the binding is still real and migrated so the auth seam is a
// database and not a hole.
const authMigrations = await readD1Migrations(
  resolve(import.meta.dirname, "migrations"),
);

// The same fake the hermetic project binds, so a `SELF.fetch` Turn that uses
// the Computer crosses the real v1 seam. See `test/computer-host-fake.ts` for
// why a container cannot run under this pool.
// A scripted hang is capped well below `testTimeout`, so the Turn that armed
// it reaches its durable failure inside the test that is watching for it
// rather than at teardown.
const computerHost = createComputerHostFake({ maximumHangMs: 3_000 });

export default defineConfig({
  // `manifest-catalog.integration.ts` imports the production client decoder
  // from `@frockbot/plugin-shell/client`, whose module graph reaches Vue single
  // file components and the Cordis client runtime. The same two settings
  // `vite.config.ts` uses to build the shipped client make that graph
  // resolvable here; nothing in it executes — only `decodePluginCatalog` runs.
  plugins: [
    vue(),
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        outboundService: createOutboundService(),
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: {
          // The gateway loads the user application here; the Bot Durable
          // Object loads Bot-authored Packages in the other namespace.
          USER_APPLICATIONS: {},
          BOT_PACKAGES: {},
          APPLETS: {},
        },
        serviceBindings: {
          COMPUTER_HOST: (request: Request) => computerHost.fetch(request),
          // The `AI` binding is impersonated at the same Gateway and native
          // image seams production uses. `AI_PROBE` reaches the same RPC
          // entrypoint so tests can inspect its call log.
          AI: FROCK_AI_FAKE_SERVICE,
          AI_PROBE: FROCK_AI_FAKE_SERVICE,
        },
        workers: [createFrockAiFakeWorker("2026-08-27")],
        r2Buckets: ["APPLICATION_ARTIFACTS", "MEMORY_FILES", "PACKAGE_CATALOG"],
        d1Databases: ["AUTH_DB"],
        durableObjects: {
          // Production classes, not probes.
          BOT_STATES: "BotState",
          APPLET_STATES: { className: "AppletState", useSQLite: true },
          // `wrangler.jsonc` lists `UserConfiguration` in `new_sqlite_classes`,
          // so the transcript index has SQL storage in production; miniflare
          // needs that said explicitly.
          USER_CONFIGURATIONS: {
            className: "UserConfiguration",
            useSQLite: true,
          },
          // VoiceSession owns only the socket bridge. This binding lets the
          // gateway integration test prove its RPCs reach the User authority.
          VOICE_SESSIONS: "VoiceSession",
          DEPLOYMENT_POLICY: {
            className: "DeploymentPolicy",
            useSQLite: true,
          },
        },
        bindings: {
          COMPOSIO_API_KEY: "test-composio-backend-key",
          BETTER_AUTH_URL: "https://bot.frockbot.com",
          TEST_MIGRATIONS: authMigrations,
          FOUNDATION_ARTIFACT: foundationArtifact,
          DEFAULT_APPLICATION_HASH: "foundation-v1",
          ALLOW_DEVELOPMENT_AUTH: "true",
          NATIVE_SLICE_2_AUTH: "android",
          BETTER_AUTH_SECRET: "workerd-native-auth-secret-0123456789abcdef",
          APPLET_VIEWER_SECRET: "workerd-native-applet-secret-0123456789abcdef",
          // The same placeholder `wrangler.jsonc` gives the `development` and
          // `e2e` environments: with an allowlist configured, only the
          // canonical `development` identity is a deployment admin, so the
          // per-test identities here are ordinary Users.
          FROCKBOT_ADMIN_EMAILS: "owner@example.com",
          DEBUG_TOKEN: "integration-debug-token",
          ALLOWED_CLIENT_ORIGINS: "capacitor://localhost,frockbot://localhost",
          CREDENTIAL_KEYRING: TEST_CREDENTIAL_KEYRING,
          // Signs the `mcp-oauth` callback state. Fixed, so a test can mint a
          // state the gateway accepts and forge one it must refuse; strong
          // enough to pass the same check production makes, because the
          // Contribution refuses to serve its routes at all otherwise.
          FROCKBOT_AUTHORIZATION_STATE_SECRET:
            "workerd-mcp-oauth-state-secret-0123456789abcdef",
          // Not a credential: no Sprite token reaches this Worker in
          // production either, because the Computer host holds the only copy
          // (ADR 0004). `SPRITES_TOKEN` is only the "is a Computer configured"
          // gate, so a placeholder is exactly what a deployment with a
          // Computer looks like from here.
          SPRITES_TOKEN: "configured",
          COMPUTER_HOST_TOKEN: FAKE_COMPUTER_HOST_TOKEN,
          // A fixed signing secret, so a test can mint the key it presents and
          // forge one that must be refused.
          ROUTINE_HOOK_SECRET: "workerd-routine-hook-secret-0123456789abcdef",
          // The registered-machine door's signing secret. Fixed, so a test can
          // mint the token a machine presents and forge one that must be
          // refused.
          MACHINE_TOKEN_SECRET: "workerd-machine-token-secret-0123456789ab",
        },
        // Deliberately absent, and why:
        //
        // - `MEMORY_INDEX`: miniflare has no local Vectorize simulator, and
        //   `wrangler.jsonc` marks it `remote` even in development. Bot deletion
        //   treats its absence as an explicit, journaled skip; the workerd suite
        //   binds an auxiliary RPC fake in `vitest.config.ts` where deletion
        //   paging itself is under test. `AI` is bound above because image
        //   generation exercises it throughout this integration suite.
        // - `PACKAGE_BUNDLER`: `BotStateEnv` types it optional precisely so a
        //   host without Bot authoring still runs; the Bot Durable Object then
        //   refuses `package_author` visibly instead of throwing. No test in
        //   this layer authors a Package, and `test/authoring.workerd.ts`
        //   already covers that seam with `test/package-bundler-fake.ts`. The
        //   auxiliary-RPC-Worker pattern above is what would wire it in the
        //   day a test here needs it.
      },
    }),
  ],
  resolve: {
    alias: {
      "@cordisjs/client": resolve(
        import.meta.dirname,
        "src/client/cordis-client-runtime.ts",
      ),
    },
  },
  test: {
    // `*.integration.ts`, not `*.test.ts` or `*.spec.ts`: root `bun test` — and
    // therefore the pre-commit hook — matches neither pattern, so this layer
    // never runs on a commit.
    include: ["test/integration/**/*.integration.ts"],
    testTimeout: 60_000,
    // Sequential, for the same reason `vitest.config.ts` is: the fakes these
    // tests drive are single objects the whole project shares, and a file that
    // scripts one or counts what it recorded cannot be running beside another
    // file doing the same thing.
    //
    // Two of them, concretely. The Computer host fake above is one Node-side
    // closure, shared across every pool worker: its `/__fake/exec` table, its
    // file map and its call log belong to the run, not to a file. The Workers
    // AI fake is a Worker, one per pool worker: `generate-image` and
    // `package-settings` both read its call count, run a Turn, and assert the
    // count went up by exactly one, which is only true if nothing else
    // generated an image in between. So are the outbound stub's MCP handshake
    // counter and its blocked-address tally in `test/harness/miniflare.ts`.
    //
    // Per-test `/__fake/reset` would not fix it — a reset is itself the thing
    // that races — and the cost is small: this suite is dominated by module
    // transform and Durable Object work, not by wall time in parallel files.
    fileParallelism: false,
  },
});

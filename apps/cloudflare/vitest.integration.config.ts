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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import {
  createOutboundService,
  TEST_CREDENTIAL_KEYRING,
} from "./test/harness/miniflare.ts";

// The bytes `test:integration` just built, read here rather than imported with
// Vite's `?raw` from a test file: `tsc` resolves a relative specifier on disk
// and never against an ambient wildcard module, so a `?raw` import would be a
// permanent type error. Reading it here also means a run without a prior
// `artifact:build` dies at config load with the missing path named.
const foundationArtifact = readFileSync(
  resolve(import.meta.dirname, "dist/artifacts/foundation-v1.mjs"),
  "utf8",
);

// better-auth's D1 schema. `gatewayAuth` degrades to an unconfigured stub when
// the Google/better-auth secrets are absent (they are, and the suite adds
// none), but the binding is still real and migrated so the auth seam is a
// database and not a hole.
const authMigrations = await readD1Migrations(
  resolve(import.meta.dirname, "migrations"),
);

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
        outboundService: createOutboundService({ liveSpriteProbe: false }),
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: {
          // The gateway loads the user application here; the Bot Durable
          // Object loads Bot-authored Packages in the other namespace.
          USER_APPLICATIONS: {},
          BOT_PACKAGES: {},
        },
        r2Buckets: ["APPLICATION_ARTIFACTS", "MEMORY_FILES", "PACKAGE_CATALOG"],
        d1Databases: ["AUTH_DB"],
        durableObjects: {
          // Production classes, not probes.
          BOT_STATES: "BotState",
          // `wrangler.jsonc` lists `UserConfiguration` in `new_sqlite_classes`,
          // so the transcript index has SQL storage in production; miniflare
          // needs that said explicitly.
          USER_CONFIGURATIONS: {
            className: "UserConfiguration",
            useSQLite: true,
          },
        },
        bindings: {
          TEST_MIGRATIONS: authMigrations,
          FOUNDATION_ARTIFACT: foundationArtifact,
          DEFAULT_APPLICATION_HASH: "foundation-v1",
          ALLOW_DEVELOPMENT_AUTH: "true",
          ALLOWED_CLIENT_ORIGINS: "capacitor://localhost,frockbot://localhost",
          CREDENTIAL_KEYRING: TEST_CREDENTIAL_KEYRING,
          // No Sprite in this project: the Computer is unreachable from
          // workerd (ADR 0004) and no test here touches it. An empty token is
          // what production hands a Worker with no Computer configured.
          SPRITES_TOKEN: "",
        },
        // Deliberately absent, and why:
        //
        // - `AI` and `MEMORY_INDEX`: miniflare has no local Workers AI or
        //   Vectorize simulator, and `wrangler.jsonc` marks both `remote` even
        //   in the development environment. `BotStateEnv` declares them, but no
        //   production code path reads either today (`grep MEMORY_INDEX
        //   packages apps` finds only the declarations), so leaving them
        //   undefined stubs nothing the suite exercises. The day a Package
        //   reads them, the failure is a clear `undefined` at that seam.
        // - `PACKAGE_BUNDLER`: `BotStateEnv` types it optional precisely so a
        //   host without Bot authoring still runs; the Bot Durable Object then
        //   refuses `package_author` visibly instead of throwing. Wiring
        //   `test/package-bundler-fake.ts` in would need an auxiliary Worker
        //   with an RPC entrypoint, and no test in this layer authors a
        //   Package. `test/authoring.workerd.ts` covers that seam with the fake.
        // - `COMPUTER_HOST`: same reason as `SPRITES_TOKEN`.
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
  },
});

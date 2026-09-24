import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import {
  createAppletBuildFake,
  FAKE_APPLET_BUILD_TOKEN,
} from "./test/applet-build-fake.ts";
import {
  createComputerHostFake,
  FAKE_COMPUTER_HOST_SHARDS,
  FAKE_COMPUTER_HOST_TOKEN,
} from "./test/computer-host-fake.ts";
import {
  COMPOSIO_TEST_API_KEY,
  createOutboundService,
  TEST_CREDENTIAL_KEYRING,
} from "./test/harness/miniflare.ts";
import {
  createFrockAiFakeWorker,
  FROCK_AI_FAKE_SERVICE,
} from "./test/frock-ai-fake.ts";
import {
  createVectorizeFakeWorker,
  VECTORIZE_FAKE_SERVICE,
} from "./test/vectorize-fake.ts";

// One instance for the whole project. It runs in Node, so the suites reach its
// state over the same binding, under `/__fake/*`.
const computerHost = createComputerHostFake();

// The build service as well, for the same reason: a build needs a container
// this pool cannot start. Binding it is what makes `plugin_check` reach the
// source-reading half at all — without a binding the host answers "the build
// service is unavailable" and reads nothing.
const appletBuild = createAppletBuildFake();

// better-auth's D1 schema, so `auth-schema.workerd.ts` can boot the real
// better-auth Package against the migrations a deployment actually applies. A
// column better-auth refuses is a live sign-in outage no other check sees.
const authMigrations = await readD1Migrations(
  resolve(import.meta.dirname, "migrations"),
);

const workerdBindings = {
  // Whether this run is on CI, carried in from the runner's shell.
  // `process.env` inside workerd is these bindings and nothing else,
  // so a suite that scales its waiting budgets for a slow runner
  // cannot read the flag any other way.
  CI: process.env.CI ?? "",
  BETTER_AUTH_URL: "https://bot.frockbot.com",
  TEST_MIGRATIONS: authMigrations,
  CREDENTIAL_KEYRING: TEST_CREDENTIAL_KEYRING,
  // Signs the `mcp-oauth` callback state. Fixed, so a test can mint a
  // state the gateway accepts and forge one it must refuse; strong
  // enough to pass the same check production makes, because the
  // Contribution refuses to serve its routes at all otherwise.
  COMPUTER_HOST_TOKEN: FAKE_COMPUTER_HOST_TOKEN,
  COMPUTER_HOST_SHARDS: String(FAKE_COMPUTER_HOST_SHARDS),
  // A fixed signing secret, so a test can mint the key it presents.
  ROUTINE_HOOK_SECRET: "workerd-routine-hook-secret-0123456789abcdef",
  // The Connected apps provider key the harness stub accepts.
  COMPOSIO_API_KEY: COMPOSIO_TEST_API_KEY,
  // The registered-machine door's signing secret. Fixed, so a test can
  // mint the token a machine presents and forge one that must be
  // refused.
  MACHINE_TOKEN_SECRET: "workerd-machine-token-secret-0123456789ab",
  // A leak canary: a Bot isolate must never see a host binding.
  SECRET_TOKEN: "host-only-secret",
  // The voice session's upstream, pointed at a stand-in. The object still
  // builds the URL and puts its key on it; `voice-assistant-probe.ts`
  // answers the open with one half of a `WebSocketPair`.
  VOICE_ASSISTANT_UPSTREAM_URL: "wss://voice-upstream.invalid/live",
  GEMINI_API_KEY: "workerd-gemini-key",
  // The build service's token, so Plugin hosts find a build service behind
  // the `APPLET_BUILD` binding rather than reporting the deployment unable
  // to build.
  APPLET_BUILD_TOKEN: FAKE_APPLET_BUILD_TOKEN,
};

// The voice suite multiplies every waiting budget in
// `test/voice-assistant.workerd.ts` by this flag, because those budgets are
// written for a laptop and spent on a two-core runner. Only this file can see
// both the runner's shell and what the bindings carry into workerd, so the
// forwarding is checked here: a config that stops passing the flag through
// fails at load rather than as a probe that times out on the runner that
// needed the allowance.
if (Boolean(process.env.CI) !== Boolean(workerdBindings.CI)) {
  throw new Error(
    'vitest.config.ts is not forwarding the runner\'s CI flag into workerd: `workerdBindings.CI` must be `process.env.CI ?? ""`.',
  );
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/computer-compatibility-worker.ts",
      miniflare: {
        outboundService: createOutboundService(),
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: {
          BOT_PACKAGES: {},
        },
        // The shared Computer host as the Durable Object sees it:
        // a service binding, decoding the real v1 protocol.
        serviceBindings: {
          COMPUTER_HOST: (request: Request) => computerHost.fetch(request),
          APPLET_BUILD: (request: Request) => appletBuild.fetch(request),
          AI: FROCK_AI_FAKE_SERVICE,
          MEMORY_INDEX: VECTORIZE_FAKE_SERVICE,
          MEMORY_INDEX_PROBE: VECTORIZE_FAKE_SERVICE,
        },
        workers: [
          createFrockAiFakeWorker("2026-08-27"),
          createVectorizeFakeWorker("2026-08-27"),
        ],
        r2Buckets: ["APPLICATION_ARTIFACTS", "MEMORY_FILES"],
        d1Databases: ["AUTH_DB"],
        durableObjects: {
          BOT_ISOLATES: "BotIsolateProbe",
          // `wrangler.jsonc` lists `BotState` in `new_sqlite_classes`, so
          // Memory and the transcript index have SQL in production. Miniflare
          // needs that said on the binding or the first `sql` call breaks
          // the object.
          BOT_STATES: { className: "WorkerdBotState", useSQLite: true },
          COMPOSITIONS: "CompositionProbe",
          COMPUTER_HOST_CLIENT: "FlyHostTransportProbeV1",
          COMPUTER_COMPATIBILITY: "ComputerCompatibilityProbe",
          SEARCH_SPIKE: { className: "SearchSpikeProbe", useSQLite: true },
          // The audit table on real SQLite, at a size the unit fake cannot
          // honestly stand in for.
          AUDIT_PROBE: { className: "AuditProbe", useSQLite: true },
          // The User Durable Object is in `new_sqlite_classes` in
          // `wrangler.jsonc`, so it has SQL storage in production; miniflare
          // needs that said explicitly or the transcript index has nowhere to
          // live in this suite.
          USER_CONFIGURATIONS: {
            className: "UserConfiguration",
            useSQLite: true,
          },
          DEPLOYMENT_POLICY: {
            className: "DeploymentPolicy",
            useSQLite: true,
          },
          // The voice session object is an Agents SDK class and keeps its
          // conversation history in SQLite, as `new_sqlite_classes` v7 says.
          VOICE_ASSISTANTS: {
            className: "WorkerdVoiceAssistant",
            useSQLite: true,
          },
        },
        bindings: workerdBindings,
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    // Twice what the integration suite allows itself for the heavier trip
    // through the real gateway, and far above the slowest test here. It was
    // fifteen minutes, which is not a budget: a wedged test held the suite for
    // a quarter of an hour before failing, which is most of what a worst-case
    // local validation run cost. The hang that motivated that number was an
    // uncancellable request deadline keeping a Durable Object from draining,
    // fixed in `core/deadline.ts`.
    testTimeout: 120_000,
    // One fake Computer host serves every file in this project, and it is one
    // Node-side object: a file that resets it, or asserts on the calls it
    // recorded, cannot be running beside another file driving the same host.
    fileParallelism: false,
  },
});

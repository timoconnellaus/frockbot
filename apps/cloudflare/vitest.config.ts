import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import {
  createComputerHostFake,
  FAKE_COMPUTER_HOST_SHARDS,
  FAKE_COMPUTER_HOST_TOKEN,
} from "./test/computer-host-fake.ts";
import {
  createOutboundService,
  TEST_CREDENTIAL_KEYRING,
} from "./test/harness/miniflare.ts";

// One instance for the whole project. It runs in Node, so the suites reach its
// state over the same binding, under `/__fake/*`.
const computerHost = createComputerHostFake();

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/fly-compatibility-worker.ts",
      miniflare: {
        outboundService: createOutboundService(),
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: {
          BOT_PACKAGES: {},
        },
        // The shared Computer host (ADR 0004) as the Durable Object sees it:
        // a service binding, decoding the real v1 protocol.
        serviceBindings: {
          COMPUTER_HOST: (request: Request) => computerHost.fetch(request),
        },
        r2Buckets: ["APPLICATION_ARTIFACTS", "MEMORY_FILES", "PACKAGE_CATALOG"],
        durableObjects: {
          AUTHORING: "AuthoringProbe",
          BOT_ISOLATES: "BotIsolateProbe",
          BOT_STATES: "WorkerdBotState",
          COMPOSITIONS: "CompositionProbe",
          COMPUTER_HOST_CLIENT: "ComputerHostClientProbe",
          FLY_COMPATIBILITY: "FlyCompatibilityProbe",
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
        },
        bindings: {
          CREDENTIAL_KEYRING: TEST_CREDENTIAL_KEYRING,
          // Signs the `mcp-oauth` callback state. Fixed, so a test can mint a
          // state the gateway accepts and forge one it must refuse; strong
          // enough to pass the same check production makes, because the
          // Contribution refuses to serve its routes at all otherwise.
          FROCKBOT_AUTHORIZATION_STATE_SECRET:
            "workerd-mcp-oauth-state-secret-0123456789abcdef",
          // No Sprites credential reaches this Worker, in tests or in
          // production: the Computer host holds the only copy (ADR 0004).
          SPRITES_TOKEN: "",
          COMPUTER_HOST_TOKEN: FAKE_COMPUTER_HOST_TOKEN,
          COMPUTER_HOST_SHARDS: String(FAKE_COMPUTER_HOST_SHARDS),
          // A fixed signing secret, so a test can mint the key it presents.
          ROUTINE_HOOK_SECRET: "workerd-routine-hook-secret-0123456789abcdef",
          // The registered-machine door's signing secret. Fixed, so a test can
          // mint the token a machine presents and forge one that must be
          // refused.
          MACHINE_TOKEN_SECRET: "workerd-machine-token-secret-0123456789ab",
          // A leak canary: a Bot isolate must never see a host binding.
          SECRET_TOKEN: "host-only-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    testTimeout: 15 * 60_000,
    // One fake Computer host serves every file in this project, and it is one
    // Node-side object: a file that resets it, or asserts on the calls it
    // recorded, cannot be running beside another file driving the same host.
    fileParallelism: false,
  },
});

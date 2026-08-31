import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import {
  createOutboundService,
  readDevVariable,
  TEST_CREDENTIAL_KEYRING,
} from "./test/harness/miniflare.ts";

const runLiveSpriteTest = process.env.FROCKBOT_RUN_LIVE_SPRITE_TEST === "1";
const spritesToken = runLiveSpriteTest
  ? (process.env.SPRITES_TOKEN ?? readDevVariable("SPRITES_TOKEN") ?? "")
  : "";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/fly-compatibility-worker.ts",
      miniflare: {
        outboundService: createOutboundService({
          liveSpriteProbe: runLiveSpriteTest,
        }),
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: {
          BOT_PACKAGES: {},
        },
        r2Buckets: ["APPLICATION_ARTIFACTS", "MEMORY_FILES"],
        durableObjects: {
          AUTHORING: "AuthoringProbe",
          BOT_ISOLATES: "BotIsolateProbe",
          BOT_STATES: "WorkerdBotState",
          COMPOSITIONS: "CompositionProbe",
          FLY_COMPATIBILITY: "FlyCompatibilityProbe",
          USER_CONFIGURATIONS: "UserConfiguration",
        },
        bindings: {
          CREDENTIAL_KEYRING: TEST_CREDENTIAL_KEYRING,
          FROCKBOT_RUN_LIVE_SPRITE_TEST: runLiveSpriteTest ? "1" : "0",
          SPRITES_TOKEN: spritesToken,
          // A leak canary: a Bot isolate must never see a host binding.
          SECRET_TOKEN: "host-only-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    testTimeout: 15 * 60_000,
  },
});

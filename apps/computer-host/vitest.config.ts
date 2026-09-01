import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import {
  createSpritesOriginFakeWorker,
  SPRITES_ORIGIN_FAKE_NAME,
} from "./test/sprites-origin-fake.ts";

/**
 * The outbound WebSocket bridge under real workerd.
 *
 * `src/outbound.test.ts` injects `fetch` and `WebSocketPair`, which is enough
 * to pin down the bridge's own logic and not enough to say whether the runtime
 * agrees: the handshake, the pair, and the pumping are all workerd's, and all
 * three were wrong in production while those tests were green. Here the bridge
 * runs in the runtime, against a Worker impersonating the Sprites API at the
 * outbound seam it already uses.
 */
const COMPATIBILITY_DATE = "2026-08-27";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/bridge-worker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["nodejs_compat"],
        // Every `fetch` the bridge makes lands here, which is how the Sprites
        // API is impersonated without touching their cloud.
        outboundService: SPRITES_ORIGIN_FAKE_NAME,
        workers: [createSpritesOriginFakeWorker(COMPATIBILITY_DATE)],
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    testTimeout: 60_000,
  },
});

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * The front Worker under real workerd.
 *
 * `src/router.test.ts` drives the router with bun's `Request`, which is enough
 * to pin down the routing and not enough to say whether the runtime agrees:
 * the clone-and-reread, the rebuilt request and the abort signal are all
 * workerd's.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/front-worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    testTimeout: 60_000,
  },
});

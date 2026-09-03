// SPIKE (lane S1) config. Kept apart from `vitest.config.ts` so the spike does
// not run in `test:workerd` and does not carry the whole project's fakes.
//
//   cd apps/cloudflare && ./node_modules/.bin/vitest run --config vitest.spike.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/spike-applet-facet-worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-27",
        compatibilityFlags: ["nodejs_compat"],
        workerLoaders: {
          APPLETS: {},
        },
        durableObjects: {
          APPLET_FACETS: { className: "AppletStateSpike", useSQLite: true },
        },
        bindings: {
          // A leak canary: the facet must never see a host binding.
          SECRET_TOKEN: "host-only-secret",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.spike.ts"],
    testTimeout: 60_000,
  },
});

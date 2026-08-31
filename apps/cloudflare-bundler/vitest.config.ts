import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The `wrangler: { configPath }` form is required: the `main` + inline
// `miniflare` form routes the bundler's dynamic `./esbuild.wasm` import through
// Vite's Node module runner, which cannot instantiate the Go-compiled wasm.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.join(import.meta.dirname, "wrangler.jsonc"),
      },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    testTimeout: 5 * 60_000,
  },
});

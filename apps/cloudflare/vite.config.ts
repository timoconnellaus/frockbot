import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const cordisClientRuntime = fileURLToPath(
  new URL("./src/client/cordis-client-runtime.ts", import.meta.url),
);
const developmentGatewayUrl =
  process.env.FROCKBOT_DEV_GATEWAY_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  root,
  plugins: [vue()],
  resolve: {
    alias: {
      "@cordisjs/client": cordisClientRuntime,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: developmentGatewayUrl,
        headers: { "x-frockbot-user-id": "development" },
      },
      "/app-manifest": {
        target: developmentGatewayUrl,
        headers: { "x-frockbot-user-id": "development" },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    // The immutable application artifact stores one JS and one CSS payload.
    // Inline package-owned sheep rasters so no emitted asset can be omitted.
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});

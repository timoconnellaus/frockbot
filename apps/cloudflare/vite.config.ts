import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const cordisClientRuntime = fileURLToPath(
  new URL("./src/client/cordis-client-runtime.ts", import.meta.url),
);

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
        target: "http://127.0.0.1:8787",
        headers: { "x-frockbot-user-id": "development" },
      },
      "/app-manifest": {
        target: "http://127.0.0.1:8787",
        headers: { "x-frockbot-user-id": "development" },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(root, "src/main/index.ts"),
      },
    },
  },
  // Electron Vite requires a preload entry. The sandboxed window uses the
  // separately Bun-built CommonJS bridge from resources/preload.
  preload: {
    build: {
      rollupOptions: {
        input: resolve(root, "src/bridge/index.ts"),
      },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(root, "src/renderer/index.html"),
      },
    },
  },
});

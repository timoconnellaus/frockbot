import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    manifest: "manifest.json",
    lib: {
      entry: fileURLToPath(new URL("./src/client/index.ts", import.meta.url)),
      formats: ["es"],
    },
    rollupOptions: {
      external: ["@frockbot/client-core"],
      output: {
        entryFileNames: "assets/ui-theme-[hash].js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

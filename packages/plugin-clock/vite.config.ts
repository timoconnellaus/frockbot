import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    manifest: "manifest.json",
    lib: {
      entry: fileURLToPath(new URL("./src/client/index.ts", import.meta.url)),
      formats: ["es"],
    },
    rollupOptions: {
      external: ["vue", "@cordisjs/client"],
      output: {
        entryFileNames: "assets/clock-[hash].js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

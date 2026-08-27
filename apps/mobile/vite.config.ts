import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const cordisClientRuntime = fileURLToPath(
  new URL("./src/client/cordis-client-runtime.ts", import.meta.url),
);

export default defineConfig({
  root,
  base: "",
  plugins: [vue()],
  resolve: {
    alias: {
      "@cordisjs/client": cordisClientRuntime,
    },
    dedupe: ["vue"],
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./index.html", import.meta.url)),
    },
  },
});

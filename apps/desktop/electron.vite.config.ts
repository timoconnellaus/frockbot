import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

const root = fileURLToPath(new URL(".", import.meta.url));
// Workspace packages export TypeScript source and must be compiled into Electron's
// main bundle. Third-party dependencies remain external for electron-builder.
const workspaceMainDependencies = [
  "@frockbot/application-foundation",
  "@frockbot/desktop-core",
  "@frockbot/plugin-shell",
  "@frockbot/protocol",
];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: workspaceMainDependencies,
      },
      rollupOptions: {
        input: resolve(root, "src/main/index.ts"),
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ["@better-auth/electron"],
      },
      rollupOptions: {
        input: resolve(root, "src/preload/index.ts"),
      },
    },
  },
});

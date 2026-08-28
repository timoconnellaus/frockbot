import { resolve } from "node:path";

const root = import.meta.dirname;
const electron = resolve(root, "node_modules/.bin/electron");
// Linux CI runners lack a setuid chrome-sandbox and restrict unprivileged user
// namespaces, so Chromium's OS sandbox cannot start there. Renderer isolation
// is still asserted by the smoke itself (contextIsolation, no node globals).
const args =
  process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [];
const child = Bun.spawn([electron, ...args, resolve(root, "dist")], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exitCode = await child.exited;

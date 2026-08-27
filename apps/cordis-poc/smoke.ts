import { resolve } from "node:path";

const root = import.meta.dirname;
const electron = resolve(root, "node_modules/.bin/electron");
const child = Bun.spawn([electron, resolve(root, "dist")], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exitCode = await child.exited;

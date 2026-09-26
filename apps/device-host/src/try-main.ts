// The runner's entry, as Node runs it on the Bot's Computer:
// `node module-try.js <dir> <deno>`. `<dir>` holds `request.json` and the
// module runtime; one JSON line of what happened is printed.
//
// The module is started exactly as the Mac's host starts it — the same
// runtime, the same Deno flags from the same declaration, the same empty
// environment — minus the Seatbelt profile around it: that is macOS's, and
// Linux has none. Deno's permissions are the one boundary here, which is
// enough for the Bot's own Computer, and the denials a Bot sees are Deno's,
// the same ones it will hit on the Mac.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { PluginModuleTryRequestV1 } from "@frockbot/core/contracts";

import {
  denoRunArgsV1,
  moduleEnvironmentV1,
  type ModulePathsV1,
} from "./sandbox.ts";
import { runModuleTryV1 } from "./try.ts";

const [directory, denoPath] = process.argv.slice(2);
if (!directory || !denoPath) {
  throw new Error("usage: module-try.js <dir> <deno>");
}
// The module starts in its data directory, where a relative path means nothing.
const deno = resolve(denoPath);
const request = JSON.parse(
  readFileSync(join(directory, "request.json"), "utf8"),
) as PluginModuleTryRequestV1;
const paths: ModulePathsV1 = {
  deno,
  runtime: join(directory, "runtime.js"),
  code: join(directory, "module.js"),
  data: join(directory, "data"),
  home: homedir(),
};
writeFileSync(paths.code, request.code);
mkdirSync(paths.data, { recursive: true });
const result = await runModuleTryV1(request, {
  spawn: () =>
    spawn(deno, denoRunArgsV1(request.module, paths), {
      env: moduleEnvironmentV1(paths),
      cwd: paths.data,
      stdio: ["pipe", "pipe", "pipe"],
    }),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);

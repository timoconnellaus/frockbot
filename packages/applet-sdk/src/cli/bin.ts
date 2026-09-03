#!/usr/bin/env bun
/**
 * `applet` — the four commands a Bot runs on the Computer.
 *
 *   applet new <name> [--dir <parent>]
 *   applet check [dir]
 *   applet build [dir]
 *   applet dev   [dir] [--port <n>]
 *
 * Output is deliberately spare: diagnostics as `path:line:col message`, one
 * per line, and a non-zero exit when any of them is an error. That is the whole
 * contract a Bot has to remember about this CLI.
 */

import { resolve } from "node:path";

import { formatDiagnostic } from "../lint/index.js";
import { buildApplet } from "./build.js";
import { checkApplet } from "./check.js";
import { startAppletDev } from "./dev.js";
import { newApplet } from "./new.js";

const USAGE = `applet <command>

  new <name> [--dir <parent>]   scaffold an Applet from the template
  check [dir]                   type-check and lint
  build [dir]                   write dist/{server.js,ui.html,manifest.json}
  dev [dir] [--port <n>]        serve the built Applet locally
`;

interface Args {
  command?: string;
  positional: string[];
  options: Record<string, string>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const [flag, inline] = token.slice(2).split("=", 2);
      options[flag!] = inline ?? argv[++index] ?? "";
      continue;
    }
    positional.push(token);
  }
  return { command: positional.shift(), positional, options };
}

function report(diagnostics: Awaited<ReturnType<typeof checkApplet>>): number {
  for (const diagnostic of diagnostics)
    console.error(formatDiagnostic(diagnostic));
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length === 0) {
    console.log("applet check: no problems found");
    return 0;
  }
  console.error(`applet check: ${errors.length} error(s)`);
  return 1;
}

export async function run(argv: string[]): Promise<number> {
  const { command, positional, options } = parseArgs(argv);
  const directory = resolve(positional[0] ?? ".");

  switch (command) {
    case "new": {
      const name = positional[0];
      if (!name) {
        console.error("applet new needs a name");
        return 2;
      }
      const created = await newApplet({
        name,
        parent: resolve(options.dir ?? "."),
      });
      console.log(`Created ${created.directory} (id ${created.id})`);
      console.log("Next: applet check && applet build");
      return 0;
    }
    case "check":
      return report(await checkApplet(directory));
    case "build": {
      const result = await buildApplet(directory);
      console.log(
        `${result.serverPath} ${result.manifest.hashes.server.slice(0, 12)}`,
      );
      console.log(`${result.uiPath} ${result.manifest.hashes.ui.slice(0, 12)}`);
      console.log(
        `${result.manifestPath} ${result.manifest.tools.length} tool(s): ` +
          result.manifest.tools.map((tool) => tool.name).join(", "),
      );
      return 0;
    }
    case "dev": {
      const port = options.port === undefined ? 0 : Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        console.error("applet dev --port must be a port number");
        return 2;
      }
      const server = await startAppletDev({ directory, port });
      console.log(server.url.toString());
      const stop = () => {
        void server.dispose().then(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => {});
      return 0;
    }
    default:
      console.log(USAGE);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

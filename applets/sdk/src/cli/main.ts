/**
 * The bundled CLI's entry point.
 *
 * `bin.ts` guards its own execution with `import.meta.main` so it can be
 * imported by tests under Bun. `dist/cli.mjs` is only ever executed, and it
 * runs under whatever Node the Computer image ships — where `import.meta.main`
 * may not exist, and where an absent guard would mean a CLI that exits 0 and
 * does nothing. So the bundle gets its own entry with no guard at all.
 */
import { run } from "./bin.js";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

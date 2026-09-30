/**
 * Builds the Setup page (`setup/`) into the Worker's static assets under
 * `dist/web/_setup/`, beside the Flutter payload `build-flutter-web.ts`
 * stages. Run after it: that build replaces `dist/web` when the client
 * changes.
 *
 * The addresses are stable (`/_setup/setup.js`), so they are revalidated on
 * every load rather than cached for a year; the document that names them is
 * served by the Worker (`src/setup-page.ts`).
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const here = import.meta.dirname;
const out = resolve(here, "dist/web/_setup");
const fonts = resolve(here, "../native/packages/frockbot_client/assets/fonts");

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "fonts"), { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(here, "setup/src/main.tsx")],
  outdir: out,
  naming: "setup.js",
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("The Setup page didn't build");
}

await cp(resolve(here, "setup/src/setup.css"), resolve(out, "setup.css"));
for (const font of [
  "inter-latin-400.ttf",
  "inter-latin-500.ttf",
  "inter-latin-600.ttf",
  "inter-latin-700.ttf",
  "archivo-black-latin.ttf",
])
  await cp(resolve(fonts, font), resolve(out, "fonts", font));

const headersPath = resolve(here, "dist/web/_headers");
const rule = "/_setup/*\n  cache-control: public, max-age=0, must-revalidate\n";
const headers = await readFile(headersPath, "utf8").catch(() => "");
if (!headers.includes("/_setup/*"))
  await writeFile(headersPath, `${headers}${rule}`);

process.stdout.write("Built the Setup page at /_setup/\n");

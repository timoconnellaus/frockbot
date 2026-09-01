import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const outdir = resolve(root, "dist/artifacts");
const clientOutdir = resolve(root, "dist/client");
await rm(outdir, { recursive: true, force: true });

let manifest: Record<string, { file: string; isEntry?: boolean }>;
try {
  manifest = JSON.parse(
    await readFile(resolve(clientOutdir, ".vite/manifest.json"), "utf8"),
  ) as Record<string, { file: string; isEntry?: boolean }>;
} catch (error) {
  throw new Error("Worker renderer manifest is invalid", { cause: error });
}
const clientEntry = Object.values(manifest).find((entry) => entry.isEntry);
const clientStyle = Object.values(manifest).find((entry) =>
  entry.file.endsWith(".css"),
);
if (!clientEntry || !clientStyle) {
  throw new Error("Worker renderer assets were not emitted");
}
const [clientJavaScript, clientCss, clientIcon] = await Promise.all([
  readFile(resolve(clientOutdir, clientEntry.file), "utf8"),
  readFile(resolve(clientOutdir, clientStyle.file), "utf8"),
  // The hosted shell serves the site icon the marketing site already serves,
  // read from the one canonical brand icon the app-icon script also renders.
  readFile(
    resolve(root, "../../assets/marketing/app-icon/frockbot-icon-64.png"),
    "base64",
  ),
]);

const result = await Bun.build({
  entrypoints: [resolve(root, "src/user-application.ts")],
  outdir,
  // The Worker uses nodejs_compat, and hosted runtime Contributions may import
  // supported Node built-ins (for example the Fly Sprites SDK's node:net shim).
  target: "node",
  format: "esm",
  naming: "foundation-v1.mjs",
  minify: true,
  sourcemap: "external",
  packages: "bundle",
  define: {
    __FROCKBOT_CLIENT_JS__: JSON.stringify(clientJavaScript),
    __FROCKBOT_CLIENT_CSS__: JSON.stringify(clientCss),
    __FROCKBOT_CLIENT_ICON__: JSON.stringify(clientIcon),
  },
});

if (result.success) {
  const artifact = result.outputs.find((output) =>
    output.path.endsWith(".mjs"),
  );
  if (!artifact) throw new Error("user application artifact was not emitted");
  process.stdout.write(`Built ${artifact.path} (${artifact.size} bytes)\n`);
} else {
  for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
  process.exitCode = 1;
}

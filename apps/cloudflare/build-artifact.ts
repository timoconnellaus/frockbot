import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const outdir = resolve(root, "dist/artifacts");
await rm(outdir, { recursive: true, force: true });

// The document the artifact renders names the client's payload, which is
// content-addressed under `/_flutter/<buildHash>/`; `build-flutter-web.ts`
// stages it and writes the hash here.
let flutterBuild: string;
try {
  flutterBuild = (
    JSON.parse(
      await readFile(resolve(root, "dist/flutter-web.json"), "utf8"),
    ) as {
      buildHash: string;
    }
  ).buildHash;
} catch (error) {
  throw new Error("Flutter web client was not built", { cause: error });
}

// The hosted shell serves the site icon the marketing site already serves,
// read from the one canonical brand icon the app-icon script also renders.
const clientIcon = await readFile(
  resolve(root, "../../assets/marketing/app-icon/frockbot-icon-64.png"),
  "base64",
);

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
    __FROCKBOT_FLUTTER_BUILD__: JSON.stringify(flutterBuild),
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

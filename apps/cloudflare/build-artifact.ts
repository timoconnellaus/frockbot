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
  // supported Node built-ins (for example the Computer host SDK's node:net shim).
  target: "node",
  format: "esm",
  naming: "foundation-v1.mjs",
  minify: true,
  sourcemap: "external",
  packages: "bundle",
  define: {
    __FROCKBOT_FLUTTER_BUILD__: JSON.stringify(flutterBuild),
    __FROCKBOT_CLIENT_ICON__: JSON.stringify(clientIcon),
    // The module identity this bundle reports to itself.
    //
    // A Worker Loader module has no file URL, so `import.meta.url` is
    // `undefined` inside the isolate. That is fatal rather than cosmetic: the
    // provider catalog reaches the model provider SDKs (`openai`,
    // `@anthropic-ai/sdk`, `google-auth-library` and the CommonJS packages
    // underneath them), and for those Bun emits
    // `var require = createRequire(import.meta.url)` as the bundle's *first*
    // top-level statement. `createRequire(undefined)` throws
    // `TypeError: The argument 'path' must be a file URL object, a file URL
    // string, or an absolute path string`, so the artifact never finishes
    // evaluating and every request answers `Failed to start Worker`.
    //
    // Naming the bundle here is what a module loaded from a file would have
    // had. The `require` it builds is only ever called from inside the lazy
    // CommonJS wrappers of those SDKs' Node-only code paths — none of which an
    // artifact takes — and when one is, it reaches the `nodejs_compat`
    // built-ins exactly as any other `require` in the Worker does.
    "import.meta.url": JSON.stringify("file:///frockbot/foundation-v1.mjs"),
  },
});

if (result.success) {
  const artifact = result.outputs.find((output) =>
    output.path.endsWith(".mjs"),
  );
  if (!artifact) throw new Error("user application artifact was not emitted");
  // The `import.meta.url` substitution above is load-bearing, and a bundler
  // that stopped honouring it would leave an artifact that builds, ships, and
  // then fails to evaluate in every isolate that loads it. That is only
  // visible in the browser end-to-end job, hours later, as
  // `Failed to start Worker`. Read the bytes back instead.
  if ((await readFile(artifact.path, "utf8")).includes("import.meta.url"))
    throw new Error(
      "user application artifact still reads import.meta.url, which is undefined in a Worker Loader isolate",
    );
  process.stdout.write(`Built ${artifact.path} (${artifact.size} bytes)\n`);
} else {
  for (const log of result.logs) process.stderr.write(`${String(log)}\n`);
  process.exitCode = 1;
}

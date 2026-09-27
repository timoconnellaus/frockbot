/**
 * The application artifact: `src/user-application.ts` bundled with a brand, for
 * the Worker to load from R2.
 *
 *   bun build-artifact.ts [--brand <module>] [--dist <directory>]
 *
 * `--dist` is where `build-flutter-web.ts` staged the client and where
 * `artifacts/foundation-v1.mjs` is written: this package's own `dist` by
 * default, and a white-label's own directory when it builds from the published
 * package ([ADR 0038](../../docs/adr/0038-white-label-deployments.md) §4).
 */
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBrandV1 } from "@frockbot/core/contracts";

const root = fileURLToPath(new URL(".", import.meta.url));

/** The value after `flag`, or undefined when the flag is absent. */
function flagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} names nothing`);
  return value;
}

const dist = resolve(flagValue("--dist") ?? resolve(root, "dist"));
const outdir = resolve(dist, "artifacts");
await rm(outdir, { recursive: true, force: true });

// The document the artifact renders names the client's payload, which is
// content-addressed under `/_flutter/<buildHash>/`; `build-flutter-web.ts`
// stages it and writes the hash here.
let flutterBuild: string;
try {
  flutterBuild = (
    JSON.parse(await readFile(resolve(dist, "flutter-web.json"), "utf8")) as {
      buildHash: string;
    }
  ).buildHash;
} catch (error) {
  throw new Error("Flutter web client was not built", { cause: error });
}

// The brand this artifact is built with: `--brand <module>` names a
// deployment's own (the profile's `brand`, resolved), and without it `#brand`
// resolves through the package import to FrockBot's. The artifact is bundled
// here rather than by wrangler, so the profile's alias never reaches it; the
// plugin below is that alias for this build. The brand is validated here, where
// a build can still refuse it: every look through the ThemeDocument decoder
// and its contrast floor. Its icon is a path beside the brand module, which the
// shell serves as the site icon.
const brandFlag = flagValue("--brand");
const brandModule =
  brandFlag === undefined
    ? fileURLToPath(import.meta.resolve("#brand"))
    : resolve(brandFlag);
const brand = decodeBrandV1(
  ((await import(brandModule)) as { BRAND_V1?: unknown }).BRAND_V1,
);
const clientIcon = await readFile(
  resolve(dirname(brandModule), brand.iconPng),
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
  plugins: [
    {
      name: "brand",
      setup(build) {
        build.onResolve({ filter: /^#brand$/ }, () => ({ path: brandModule }));
      },
    },
  ],
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

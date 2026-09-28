#!/usr/bin/env bun
/**
 * The white-label gate: a minimal consumer, built from the packed tarballs of
 * every published workspace, deploys (ADR 0038 §5).
 *
 * `scripts/white-label-fixture/` is the consumer's own repository in
 * miniature — a profile, a brand module, a STUB auth Package and a STUB
 * payments Package, each named by path, written against nothing but the
 * published packages. This packs every
 * workspace `scripts/npm-publish.ts` lists, rewrites each manifest exactly as
 * the release does, installs the tarballs into a scratch directory with npm,
 * and then does what a white-label does:
 *
 *   1. `tsc` checks its choosers and brand against the published contract;
 *   2. its payments Package credits an account through the published ledger's
 *      port from its test webhook, once;
 *   3. `frockbot-deployment-config wallet-pal` writes its wrangler config;
 *   4. `frockbot-deployment-config secrets wallet-pal check` demands the stub
 *      Packages' own secrets and none of the built-in Packages';
 *   5. `build-artifact.ts --brand` bundles the application artifact with its
 *      brand;
 *   6. `wrangler deploy --dry-run` bundles the Worker, and the bundle's inputs
 *      are checked: its choosers and brand are in; better-auth, Stripe and
 *      FrockBot's brand are not.
 *
 * Nothing here reaches Cloudflare. It runs with the build category
 * (`bun run validate:build`) and in `main.yml`.
 *
 *   bun scripts/white-label-fixture.ts [--keep]
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  PUBLISHED_WORKSPACES_V1,
  publishedManifestV1,
  readManifestV1,
} from "./npm-publish.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const FIXTURE = join(import.meta.dirname, "white-label-fixture");
/** A version no registry has, so every `@frockbot/*` can only be a tarball. */
const VERSION = "0.0.0-white-label-fixture";
const PROFILE = "wallet-pal";

function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) {
    throw new Error(
      `\`${cmd.join(" ")}\` in ${cwd} exited ${result.exitCode}:\n${output}`,
    );
  }
  return output;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`White-label fixture: ${message}`);
}

/** `npm pack --json`'s answer, past any notice npm prints ahead of it. */
function packJson(output: string): { filename: string }[] {
  return JSON.parse(output.slice(output.indexOf("["))) as {
    filename: string;
  }[];
}

/**
 * Pack one workspace as `release.yml` publishes it: `npm pack` of the checked
 * out directory, its manifest rewritten by the same function the release's
 * `set-versions` runs, packed again. The repository's own manifests are never
 * touched.
 */
function packWorkspace(directory: string, scratch: string): string {
  const raw = join(scratch, "raw");
  mkdirSync(raw, { recursive: true });
  const name = readManifestV1(REPO_ROOT, directory).name!;
  const packed = packJson(
    run(
      ["npm", "pack", "--json", "--pack-destination", raw],
      join(REPO_ROOT, directory),
    ),
  );
  const staged = join(scratch, "staged", name.replace("/", "__"));
  mkdirSync(staged, { recursive: true });
  run(["tar", "-xzf", join(raw, packed[0]!.filename), "-C", staged], scratch);
  const packageDirectory = join(staged, "package");
  const manifestPath = join(packageDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(
    manifestPath,
    `${JSON.stringify(publishedManifestV1(manifest, VERSION), null, 2)}\n`,
  );
  const tarballs = join(scratch, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  const repacked = packJson(
    run(
      ["npm", "pack", "--json", "--pack-destination", tarballs],
      packageDirectory,
    ),
  );
  return join(tarballs, repacked[0]!.filename);
}

const keep = process.argv.includes("--keep");
const scratch = mkdtempSync(join(tmpdir(), "frockbot-white-label-"));
try {
  // 1. The tarballs.
  const tarballs = new Map<string, string>();
  for (const directory of PUBLISHED_WORKSPACES_V1) {
    const name = readManifestV1(REPO_ROOT, directory).name!;
    tarballs.set(name, packWorkspace(directory, scratch));
  }
  console.log(`Packed ${tarballs.size} workspaces at ${VERSION}.`);

  // 2. The consumer: the fixture's files, and every tarball as a dependency.
  // `overrides` points the exact version each package pins on its siblings at
  // the same tarball, since no registry has it.
  const consumer = join(scratch, "wallet-pal");
  cpSync(FIXTURE, consumer, { recursive: true });
  const dependencies = Object.fromEntries(
    [...tarballs].map(([name, tarball]) => [
      name,
      `file:${relative(consumer, tarball)}`,
    ]),
  );
  const cloudflareDevelopment = readManifestV1(
    REPO_ROOT,
    "apps/cloudflare",
  ).devDependencies!;
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "wallet-pal",
        private: true,
        type: "module",
        dependencies,
        devDependencies: {
          "@cloudflare/workers-types":
            cloudflareDevelopment["@cloudflare/workers-types"],
          // Stock TypeScript, not this repository's native fork: what a
          // white-label compiles its Package with.
          typescript: "5.9.3",
          wrangler: cloudflareDevelopment.wrangler,
        },
        overrides: Object.fromEntries(
          [...tarballs.keys()].map((name) => [name, `$${name}`]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  run(
    ["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"],
    consumer,
  );
  console.log("Installed the tarballs with npm.");

  // 3. Its own code, against the published contract.
  const bin = join(consumer, "node_modules", ".bin");
  run([join(bin, "tsc"), "-p", "tsconfig.json"], consumer);
  console.log("Its choosers and brand typecheck against @frockbot/core.");

  // Its payments Package, over the published ledger.
  console.log(run(["bun", join("payments", "prove.ts")], consumer).trimEnd());

  // 4. Its wrangler config, from its own profile, by the published bin.
  const generated = run(
    [join(bin, "frockbot-deployment-config"), PROFILE],
    consumer,
  );
  console.log(generated.trimEnd());
  const config = join(
    consumer,
    ".deployment",
    PROFILE,
    "app",
    "wrangler.jsonc",
  );
  const written = readFileSync(config, "utf8");
  check(
    written.includes('"WALLET_PAL_SIGN_IN_APP": "wallet-pal-fixture"'),
    "the auth Package's var is not in the generated config",
  );
  check(
    !written.includes("WALLET_PAL_SIGN_IN_SECRET"),
    "the auth Package's secret leaked into the generated config",
  );
  check(!written.includes("d1_databases"), "an AUTH_DB nobody asked for");
  check(
    written.includes('"#payments"') && written.includes("payments/chooser.ts"),
    "the generated config does not alias #payments to its chooser",
  );
  check(
    !written.includes("WALLET_PAL_PAYMENTS_SECRET"),
    "the payments Package's secret leaked into the generated config",
  );

  // 5. The production-secrets check, from the profile: the stub's secret, and
  // no built-in Package's.
  const secretsFile = join(scratch, "secrets.json");
  run(
    [
      join(bin, "frockbot-deployment-config"),
      "secrets",
      PROFILE,
      "write-secrets-file",
      secretsFile,
    ],
    consumer,
    {
      ...process.env,
      WALLET_PAL_SIGN_IN_SECRET: "fixture",
      WALLET_PAL_PAYMENTS_SECRET: "fixture",
      BETTER_AUTH_SECRET: "not-this-deployment's",
      STRIPE_SECRET_KEY: "not-this-deployment's",
    },
  );
  const carried = Object.keys(JSON.parse(readFileSync(secretsFile, "utf8")));
  check(
    carried.includes("WALLET_PAL_SIGN_IN_SECRET"),
    "the secrets file does not carry the auth Package's secret",
  );
  check(
    carried.includes("WALLET_PAL_PAYMENTS_SECRET"),
    "the secrets file does not carry the payments Package's secret",
  );
  check(
    !carried.includes("BETTER_AUTH_SECRET") &&
      !carried.includes("STRIPE_SECRET_KEY"),
    "the secrets file carries a built-in Package's secret",
  );
  const missing = Bun.spawnSync({
    cmd: [join(bin, "frockbot-deployment-config"), "secrets", PROFILE, "check"],
    cwd: consumer,
    env: { PATH: process.env.PATH },
    stdout: "pipe",
    stderr: "pipe",
  });
  check(
    missing.exitCode === 1 &&
      missing.stderr.toString().includes("WALLET_PAL_SIGN_IN_SECRET") &&
      missing.stderr.toString().includes("WALLET_PAL_PAYMENTS_SECRET"),
    "the secrets check does not demand the stub Packages' secrets",
  );
  console.log("The secrets check names the stub Packages' secrets.");

  // 6. The application artifact, with its brand, from the package's build.
  const cloudflare = join(consumer, "node_modules", "@frockbot", "cloudflare");
  const client = join(consumer, "client");
  mkdirSync(client, { recursive: true });
  // What `build-flutter-web.ts --dist client` writes; the Flutter build is the
  // white-label application's and outside this gate.
  writeFileSync(
    join(client, "flutter-web.json"),
    `${JSON.stringify({ schemaVersion: 1, buildHash: "white-label-fixture", files: [] })}\n`,
  );
  run(
    [
      "bun",
      join(cloudflare, "build-artifact.ts"),
      "--brand",
      join(consumer, "brand", "brand.ts"),
      "--dist",
      client,
    ],
    consumer,
  );
  const artifact = readFileSync(
    join(client, "artifacts", "foundation-v1.mjs"),
    "utf8",
  );
  check(
    artifact.includes("Wallet Pal") &&
      !artifact.includes('productName:"FrockBot"'),
    "the application artifact does not carry the white-label's brand",
  );
  console.log("Built the application artifact with the white-label's brand.");

  // 7. The Worker, as `wrangler deploy` would upload it.
  mkdirSync(join(consumer, "web"), { recursive: true });
  writeFileSync(join(consumer, "web", "index.html"), "wallet pal\n");
  const metafile = join(scratch, "worker.meta.json");
  run(
    [
      join(bin, "wrangler"),
      "deploy",
      "--dry-run",
      "-c",
      config,
      "--outdir",
      join(scratch, "worker"),
      "--metafile",
      metafile,
    ],
    consumer,
    { ...process.env, WRANGLER_SEND_METRICS: "false" },
  );
  const inputs = Object.keys(
    (JSON.parse(readFileSync(metafile, "utf8")) as { inputs: object }).inputs,
  );
  const reaches = (fragment: string) =>
    inputs.some((input) => input.replaceAll("\\", "/").includes(fragment));
  check(reaches("auth/chooser.ts"), "the Worker does not bundle its chooser");
  check(
    reaches("payments/chooser.ts"),
    "the Worker does not bundle its payments chooser",
  );
  check(
    !reaches("@frockbot/app/payments/") &&
      !reaches("@frockbot/cloudflare/src/payments"),
    "the Worker bundles a payments Package it did not choose",
  );
  check(reaches("brand/brand.ts"), "the Worker does not bundle its brand");
  check(
    reaches("node_modules/@frockbot/cloudflare/src/index.ts"),
    "the Worker was not built from the published package",
  );
  check(
    !reaches("node_modules/better-auth/") &&
      !reaches("@frockbot/cloudflare/src/auth-package"),
    "the Worker bundles an auth Package it did not choose",
  );
  check(
    !reaches("@frockbot/cloudflare/src/brand.ts"),
    "the Worker bundles FrockBot's brand",
  );
  const bundle = readdirSync(join(scratch, "worker")).find((file) =>
    file.endsWith(".js"),
  );
  check(bundle !== undefined, "wrangler wrote no bundle");
  console.log(
    `wrangler deploy --dry-run bundled the white-label Worker from ${inputs.length} inputs.`,
  );
} finally {
  if (keep) console.log(`Kept ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

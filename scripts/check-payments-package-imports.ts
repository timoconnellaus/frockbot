import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The payments seam, enforced mechanically, the way
// `check-auth-package-imports.ts` polices sign-in: payment is a build-time
// Package behind `PaymentsPackageV1`, and a build carries only the one it
// chose.
//
// Four rules:
//
// 1. Stripe is one implementation and lives entirely in
//    `app/payments/stripe/**`. Only it and the Stripe chooser may import it;
//    everything else speaks the contract in `core/contracts/payments-package.ts`.
// 2. A payments Package reaches the ledger only through the port it is handed.
//    `app/payments/**` imports the contracts, billing's refusals and body
//    readers, and its own files — never the ledger, the gateway or the rest of
//    the app. Its tests may drive a real ledger.
// 3. Each chooser names exactly one implementation as a value, and never the
//    other chooser. Nothing else imports a chooser by path: the Worker reaches
//    whichever one `#payments` resolves to.
// 4. Billing's own code names no provider. `app/billing/**` is the ledger,
//    metering and the Billing page every deployment shares.

const repoRoot = resolve(import.meta.dirname, "..");
const stripeRoot = "app/payments/stripe/";
const paymentsRoot = "app/payments/";
/** One per build; the first is the tracked default `#payments` resolves to. */
const choosers = [
  "apps/cloudflare/src/payments.ts",
  "apps/cloudflare/src/payments.none.ts",
];
const stripeChooser = choosers[0]!;

const failures: string[] = [];

function scan(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true })]
    .filter((path) => !path.includes("node_modules/"))
    .filter((path) => !path.includes("dist/"))
    .filter((path) => !path.includes(".wrangler/"))
    .sort();
}

/** The source with its comments removed: a commented import is prose. */
function withoutComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const specifierPattern =
  /(?:from|import|require)\s*\(?\s*["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function specifiersOf(
  source: string,
): Array<{ specifier: string; line: number; typeOnly: boolean }> {
  const found: Array<{ specifier: string; line: number; typeOnly: boolean }> =
    [];
  const scanned = withoutComments(source);
  for (const match of scanned.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const before = scanned.slice(0, match.index);
    const statement = before.slice(before.lastIndexOf("\n") + 1);
    found.push({
      specifier,
      line: before.split("\n").length,
      typeOnly: /\bimport\s+type\b/.test(statement),
    });
  }
  return found;
}

/** Where a relative specifier lands, repository-relative. */
function landing(path: string, specifier: string): string {
  return resolve(repoRoot, path, "..", specifier)
    .slice(repoRoot.length + 1)
    .replaceAll("\\", "/");
}

function reachesStripe(path: string, specifier: string): boolean {
  if (specifier.startsWith("@frockbot/app/payments/stripe")) return true;
  return (
    specifier.startsWith(".") && landing(path, specifier).startsWith(stripeRoot)
  );
}

const sources = scan(
  "{app,applets,apps,computer,core,frock-compose,providers,scripts}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
);

// Rules 1 and 3's second half.
let filesChecked = 0;
for (const path of sources) {
  if (path === "scripts/check-payments-package-imports.ts") continue;
  filesChecked += 1;
  const inStripe = path.startsWith(stripeRoot) || path === stripeChooser;
  for (const { specifier, line } of specifiersOf(
    readFileSync(resolve(repoRoot, path), "utf8"),
  )) {
    if (!inStripe && reachesStripe(path, specifier))
      failures.push(
        `${path}:${line}: imports "${specifier}"; Stripe is one implementation of PaymentsPackageV1 and is importable only from ${stripeRoot}** and its chooser (${stripeChooser}) — depend on @frockbot/core/contracts or reach the build through #payments`,
      );
    if (
      specifier.startsWith(".") &&
      choosers.some((chooser) =>
        [
          chooser,
          chooser.replace(/\.ts$/, ".js"),
          chooser.replace(/\.ts$/, ""),
        ].includes(landing(path, specifier)),
      )
    )
      failures.push(
        `${path}:${line}: imports the payments chooser "${specifier}" by path; import "#payments", which the deployment's config resolves to the build it chose`,
      );
  }
}

// Rule 2: what a payments Package may reach.
const packageAdmits = [
  "@frockbot/core/",
  "@frockbot/app/billing/errors",
  "@frockbot/app/billing/wire",
  "node:",
];
for (const path of scan(`${paymentsRoot}**/*.{ts,tsx,mts,cts}`)) {
  if (path.endsWith(".test.ts")) continue;
  const own = path.split("/").slice(0, 3).join("/") + "/";
  for (const { specifier, line } of specifiersOf(
    readFileSync(resolve(repoRoot, path), "utf8"),
  )) {
    if (specifier.startsWith(".")) {
      if (landing(path, specifier).startsWith(own)) continue;
    } else if (packageAdmits.some((allowed) => specifier.startsWith(allowed)))
      continue;
    failures.push(
      `${path}:${line}: imports "${specifier}"; a payments Package imports the contracts, @frockbot/app/billing/errors and /wire, and its own files — it reaches the ledger only through the port it is handed`,
    );
  }
}

// Rule 3: each chooser is one value import of one implementation.
const builds: string[] = [];
for (const chooser of choosers) {
  const specifiers = specifiersOf(
    readFileSync(resolve(repoRoot, chooser), "utf8"),
  )
    .filter(({ typeOnly }) => !typeOnly)
    .map(({ specifier }) => specifier);
  const chosen = specifiers.filter((specifier) =>
    specifier.startsWith("@frockbot/app/payments/"),
  );
  if (chosen.length !== 1)
    failures.push(
      `${chooser}: imports ${chosen.length} payments Packages (${chosen.join(", ") || "none"}); a build names exactly one, and the build is this one import line`,
    );
  for (const specifier of specifiers)
    if (specifier.includes("payments.") || specifier === "./payments.js")
      failures.push(
        `${chooser}: imports "${specifier}"; the choosers are alternatives, and one that reached the other would put both Packages in one bundle`,
      );
  builds.push(`${chooser.replace(/^.*\//, "")} → ${chosen[0] ?? "none"}`);
}

// Rule 4: billing's shared code names no provider.
for (const path of scan("app/billing/**/*.ts")) {
  if (path.endsWith(".test.ts")) continue;
  const source = withoutComments(readFileSync(resolve(repoRoot, path), "utf8"));
  if (/stripe/i.test(source))
    failures.push(
      `${path}: names Stripe; billing is every deployment's, and a provider's words belong to its payments Package`,
    );
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `Payments Package contract passed (${filesChecked} files checked; ${builds.join(", ")})\n`,
);

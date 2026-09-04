import { cpus } from "node:os";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Runs every workspace package's `typecheck` script through a bounded pool.
//
// `bun run --filter '*' typecheck` starts all ~74 packages at once and bun 1.3
// offers no way to cap that. Each one loads its own TypeScript program, so the
// machine pages instead of checking. It gets worse under TypeScript 7, whose
// native compiler is itself multithreaded: N native processes each claim the
// whole box. Bounding the process count and letting each tsc use the cores is
// the shape that fits both compilers.
//
// Override the default with TYPECHECK_CONCURRENCY=n (n=0 means unbounded).

const repoRoot = resolve(import.meta.dirname, "..");

const requested = process.env.TYPECHECK_CONCURRENCY;
const concurrency =
  requested === undefined
    ? Math.max(1, Math.min(4, Math.ceil(cpus().length / 2)))
    : Number(requested) || Number.POSITIVE_INFINITY;

interface Target {
  name: string;
  dir: string;
}

const targets: Target[] = [];
for (const group of ["packages", "apps", "applications"]) {
  for (const manifestPath of new Bun.Glob(`${group}/*/package.json`).scanSync({
    cwd: repoRoot,
    onlyFiles: true,
  })) {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, manifestPath), "utf8"),
    ) as { name?: string; scripts?: Record<string, string> };
    if (!manifest.name || !manifest.scripts?.typecheck) continue;
    targets.push({
      name: manifest.name,
      dir: join(repoRoot, manifestPath.replace(/\/package\.json$/, "")),
    });
  }
}
targets.sort((a, b) => a.name.localeCompare(b.name));

interface Failure {
  name: string;
  output: string;
}

const failures: Failure[] = [];
let started = 0;
let finished = 0;

async function runOne(target: Target): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "typecheck"], {
    cwd: target.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  finished += 1;
  const label = `[${String(finished).padStart(2)}/${targets.length}]`;
  if (exitCode === 0) {
    console.log(`${label} ok   ${target.name}`);
    return;
  }
  console.log(`${label} FAIL ${target.name}`);
  failures.push({ name: target.name, output: `${stdout}${stderr}`.trimEnd() });
}

async function worker(): Promise<void> {
  while (started < targets.length) {
    const target = targets[started++];
    if (target) await runOne(target);
  }
}

const poolSize = Math.min(
  Number.isFinite(concurrency) ? concurrency : targets.length,
  targets.length,
);
console.log(
  `typechecking ${targets.length} packages, ${poolSize} at a time ` +
    `(${cpus().length} cores; set TYPECHECK_CONCURRENCY to override)`,
);

const startedAt = Date.now();
await Promise.all(Array.from({ length: poolSize }, () => worker()));
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n─── ${failure.name} ───\n${failure.output}`);
  }
  console.error(
    `\n${failures.length} of ${targets.length} packages failed typecheck in ${seconds}s`,
  );
  process.exit(1);
}

console.log(`\nall ${targets.length} packages typecheck in ${seconds}s`);

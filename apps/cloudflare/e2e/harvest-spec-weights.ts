// Rebuild `spec-weights.json` from a CI run's Playwright blob reports.
//
//   bun e2e/harvest-spec-weights.ts 34561531194
//   bun e2e/harvest-spec-weights.ts path/to/downloaded/blobs
//
// A run id is fetched with `gh run download` (every `playwright-blob-report-*`
// artifact; they live for one day). A directory is searched for the
// `report-*.zip` files those artifacts contain, or for already-extracted
// `report.jsonl` files. Each test contributes the duration of its *last*
// attempt — the one that passed, when it passed — so a retry that timed out
// on a dying server does not become that file's weight. A file that failed
// outright still counts, at whatever its final attempt cost; pick a green run.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const REPOSITORY = "timoconnellaus/frockbot";

interface BlobEvent {
  method: string;
  params?: Record<string, unknown>;
}

interface SuiteEntry {
  testId?: string;
  location?: { file: string };
  entries?: SuiteEntry[];
}

function walk(files: string[], directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(files, path);
    else if (name === "report.jsonl" || /^report-\d+\.zip$/u.test(name))
      files.push(path);
  }
}

function readReport(path: string): string {
  if (path.endsWith(".jsonl")) return readFileSync(path, "utf8");
  const unzipped = spawnSync("unzip", ["-p", path, "report.jsonl"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (unzipped.status !== 0) {
    throw new Error(`unzip failed on ${path}: ${unzipped.stderr.toString()}`);
  }
  return unzipped.stdout.toString();
}

function download(runId: string): string {
  const into = mkdtempSync(join(tmpdir(), "frockbot-blobs-"));
  const result = spawnSync(
    "gh",
    [
      "run",
      "download",
      runId,
      "-R",
      REPOSITORY,
      "-p",
      "playwright-blob-report-*",
      "-D",
      into,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`gh run download ${runId} failed`);
  return into;
}

function main(): void {
  const argument = process.argv[2];
  if (!argument) {
    console.error(
      "usage: bun e2e/harvest-spec-weights.ts <run id | directory>",
    );
    process.exit(2);
  }
  const directory = /^\d+$/u.test(argument) ? download(argument) : argument;
  const reports: string[] = [];
  walk(reports, directory);
  if (reports.length === 0) {
    throw new Error(`no report-*.zip or report.jsonl under ${directory}`);
  }

  // Per file, the last attempt of each test; per run, the commit it tested.
  const lastAttempt = new Map<string, { file: string; seconds: number }>();
  let commit: string | undefined;
  let buildHref: string | undefined;
  for (const report of reports) {
    const testFile = new Map<string, string>();
    const collect = (entries: SuiteEntry[]): void => {
      for (const entry of entries) {
        if (entry.testId && entry.location) {
          testFile.set(entry.testId, entry.location.file);
        } else if (entry.entries) collect(entry.entries);
      }
    };
    for (const line of readReport(report).split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as BlobEvent;
      if (event.method === "onProject") {
        const project = event.params?.project as {
          suites: SuiteEntry[];
          metadata?: { ci?: { commitHash?: string; buildHref?: string } };
        };
        collect(project.suites);
        commit ??= project.metadata?.ci?.commitHash;
        buildHref ??= project.metadata?.ci?.buildHref;
      } else if (event.method === "onTestEnd") {
        const params = event.params as {
          test: { testId: string };
          result: { duration: number };
        };
        const file = testFile.get(params.test.testId);
        if (!file) throw new Error(`${report} ends a test it never began`);
        lastAttempt.set(params.test.testId, {
          file: basename(file),
          seconds: params.result.duration / 1000,
        });
      }
    }
  }

  const seconds: Record<string, number> = {};
  for (const attempt of lastAttempt.values()) {
    seconds[attempt.file] = (seconds[attempt.file] ?? 0) + attempt.seconds;
  }
  const table = {
    source: {
      run: buildHref ?? argument,
      commit: commit?.slice(0, 7) ?? "unknown",
      harvested: new Date().toISOString().slice(0, 10),
    },
    regenerate: "bun e2e/harvest-spec-weights.ts <run id | directory>",
    seconds: Object.fromEntries(
      Object.entries(seconds)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([file, total]) => [file, Math.round(total * 10) / 10]),
    ),
  };
  const target = join(e2eRoot, "spec-weights.json");
  writeFileSync(target, `${JSON.stringify(table, null, 2)}\n`);
  console.log(
    `${relative(repoRoot, target)}: ${Object.keys(seconds).length} files from ${table.source.run}`,
  );
}

main();

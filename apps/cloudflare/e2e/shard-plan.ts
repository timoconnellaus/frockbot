// How the browser end-to-end specs are divided between CI runners.
//
// Playwright's own `--shard` cannot split a spec file — `fullyParallel` is
// off, so a file is one indivisible group — and it assigns a group to the
// shard its *first* test falls in, walking the files in alphabetical order.
// One large file therefore lands whole in whichever shard reaches it, and
// every file before it is already there: with `chat.e2e.ts` (twelve tests)
// starting at index ten of fifty-six, shard 1 of 4 was given twenty-two tests
// — the four Applet specs and the whole of chat — while shard 2 was given
// seven. That runner then ran for thirteen minutes against the same
// `wrangler dev`, which is long enough to spend the harness's whole restart
// budget (`supervisor.ts`), after which every remaining spec in the shard
// fails on a server that is no longer there.
//
// Counting tests was the first fix, and it was not enough: a test here costs
// anywhere from half a second to a minute and a half, so four shards of twelve
// tests each still ran for five, eleven, five and seven minutes. `planShards`
// therefore packs by *measured seconds* — `spec-weights.json`, harvested from
// a green run's blob reports by `harvest-spec-weights.ts` — and only falls
// back to the test count for a file the table has never seen, priced at the
// measured average per test so a new spec is neither free nor a whole shard.
//
// The packing is greedy longest-first: the costliest file goes to the shard
// that is currently the lightest. The result is deterministic — the same
// corpus always produces the same assignment, so a rerun of one shard runs
// the same specs — and no shard is more than one file heavier than it has to
// be.
//
// `balanced-shard-reporter.ts` is what applies this to a run.

/** A spec file, how many tests it holds, and how long it took last time. */
export interface SpecWeight {
  readonly file: string;
  readonly tests: number;
  /** Measured wall-clock of the whole file; absent for a file not yet timed. */
  readonly seconds?: number;
}

/** A spec file with the cost the packer will use for it. */
export interface SpecCost {
  readonly file: string;
  readonly tests: number;
  readonly cost: number;
}

/**
 * The cost of each file in seconds, or the nearest thing to seconds a file
 * without a measurement can be given.
 *
 * A file the table knows is its measured seconds. A file it does not know is
 * its test count times the measured seconds per test across the files that
 * are known — so the untimed newcomer is priced like an average test rather
 * than like nothing. With no measurements at all the rate is one, and the
 * plan is the old count-balanced one.
 */
export function weighSpecs(specs: readonly SpecWeight[]): SpecCost[] {
  const measured = specs.filter((spec) => spec.seconds !== undefined);
  const measuredSeconds = measured.reduce(
    (sum, spec) => sum + (spec.seconds ?? 0),
    0,
  );
  const measuredTests = measured.reduce((sum, spec) => sum + spec.tests, 0);
  const secondsPerTest =
    measuredTests > 0 ? measuredSeconds / measuredTests : 1;
  return specs.map((spec) => ({
    file: spec.file,
    tests: spec.tests,
    cost: spec.seconds ?? spec.tests * secondsPerTest,
  }));
}

/** Files sorted the way the plan reads them: costliest first, then by name. */
function byCostThenName(specs: readonly SpecCost[]): SpecCost[] {
  return [...specs].sort(
    (left, right) =>
      right.cost - left.cost || (left.file < right.file ? -1 : 1),
  );
}

/**
 * Divide the spec files between `total` shards, keeping each file whole.
 *
 * Greedy longest-first packing: the costliest file goes to the emptiest shard.
 * That is optimal to within one file for this shape of problem, and it is
 * stable — no randomness, no dependence on file order in the directory.
 */
export function planShards(
  specs: readonly SpecWeight[],
  total: number,
): string[][] {
  if (total < 1) throw new Error("a run has at least one shard");
  const shards: { files: string[]; cost: number }[] = Array.from(
    { length: total },
    () => ({ files: [], cost: 0 }),
  );
  for (const spec of byCostThenName(weighSpecs(specs))) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.cost < lightest.cost) lightest = shard;
    }
    lightest.files.push(spec.file);
    lightest.cost += spec.cost;
  }
  return shards.map((shard) => [...shard.files].sort());
}

/**
 * What Playwright's built-in `--shard` does, for the test that compares them.
 *
 * Files in alphabetical order, cut into runs of `floor(total tests / shards)`
 * (the remainder spread over the first shards), with each file landing in the
 * shard its first test falls in. Faithful to `filterForShard` in
 * `playwright/lib/runner/index.js`.
 */
export function contiguousShards(
  specs: readonly SpecWeight[],
  total: number,
): string[][] {
  const ordered = [...specs].sort((left, right) =>
    left.file < right.file ? -1 : 1,
  );
  const totalTests = ordered.reduce((sum, spec) => sum + spec.tests, 0);
  const sizes = Array.from({ length: total }, () =>
    Math.floor(totalTests / total),
  );
  const remainder = totalTests - sizes.reduce((sum, size) => sum + size, 0);
  for (let index = 0; index < remainder; index += 1) {
    sizes[index % total] += 1;
  }
  const starts: number[] = [];
  let boundary = 0;
  for (const size of sizes) {
    starts.push(boundary);
    boundary += size;
  }
  const shards: string[][] = Array.from({ length: total }, () => []);
  let seen = 0;
  for (const spec of ordered) {
    let shard = total - 1;
    for (let index = 0; index < total; index += 1) {
      if (seen >= starts[index] && seen < starts[index] + sizes[index]) {
        shard = index;
        break;
      }
    }
    shards[shard].push(spec.file);
    seen += spec.tests;
  }
  return shards;
}

/** How many tests each shard of a plan carries. */
export function shardSizes(
  specs: readonly SpecWeight[],
  plan: readonly string[][],
): number[] {
  const tests = new Map(specs.map((spec) => [spec.file, spec.tests]));
  return plan.map((files) =>
    files.reduce((sum, file) => sum + (tests.get(file) ?? 0), 0),
  );
}

/** How many seconds each shard of a plan is expected to run, by the table. */
export function shardSeconds(
  specs: readonly SpecWeight[],
  plan: readonly string[][],
): number[] {
  const costs = new Map(
    weighSpecs(specs).map((spec) => [spec.file, spec.cost]),
  );
  return plan.map((files) =>
    files.reduce((sum, file) => sum + (costs.get(file) ?? 0), 0),
  );
}

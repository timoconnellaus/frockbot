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
// `planShards` packs the same indivisible files by size instead: largest
// first, each onto the shard that is currently the lightest. The result is
// deterministic — the same corpus always produces the same assignment, so a
// rerun of one shard runs the same specs — and no shard is more than one file
// heavier than it has to be.
//
// `balanced-shard-reporter.ts` is what applies this to a run.

/** A spec file and how many tests it contributes. */
export interface SpecWeight {
  readonly file: string;
  readonly tests: number;
}

/** Files sorted the way both plans read them: heaviest first, then by name. */
function bySizeThenName(specs: readonly SpecWeight[]): SpecWeight[] {
  return [...specs].sort(
    (left, right) =>
      right.tests - left.tests || (left.file < right.file ? -1 : 1),
  );
}

/**
 * Divide the spec files between `total` shards, keeping each file whole.
 *
 * Greedy longest-first packing: the heaviest file goes to the emptiest shard.
 * That is optimal to within one file for this shape of problem, and it is
 * stable — no randomness, no dependence on file order in the directory.
 */
export function planShards(
  specs: readonly SpecWeight[],
  total: number,
): string[][] {
  if (total < 1) throw new Error("a run has at least one shard");
  const shards: { files: string[]; tests: number }[] = Array.from(
    { length: total },
    () => ({ files: [], tests: 0 }),
  );
  for (const spec of bySizeThenName(specs)) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.tests < lightest.tests) lightest = shard;
    }
    lightest.files.push(spec.file);
    lightest.tests += spec.tests;
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

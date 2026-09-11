// The reporter that gives each CI runner a fair share of the specs.
//
// Playwright hands a reporter the whole, un-sharded corpus in `preprocess`
// and lets exactly one of them take sharding over with `skipSharding()`. That
// is the only seam where the assignment can be decided with the file sizes in
// hand, which is what `shard-plan.ts` needs: its packing is the difference
// between a runner with twenty-two specs and three with seven.
//
// With no `--shard` this does nothing at all, so a local `bun run test:e2e`
// is unaffected.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
} from "@playwright/test/reporter";
import { planShards, type SpecWeight } from "./shard-plan.ts";

interface TestRunControl {
  skipSharding(): void;
  exclude(test: TestCase): void;
}

/** The measured seconds per spec file, keyed the way the table writes them. */
function measuredSeconds(): Map<string, number> {
  const table = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./spec-weights.json", import.meta.url)),
      "utf8",
    ),
  ) as { seconds: Record<string, number> };
  return new Map(Object.entries(table.seconds));
}

export default class BalancedShardReporter implements Reporter {
  async preprocess(params: {
    config: FullConfig;
    suite: Suite;
    testRun: TestRunControl;
  }): Promise<void> {
    const shard = params.config.shard;
    if (!shard) return;

    const tests = params.suite.allTests();
    const counts = new Map<string, number>();
    for (const test of tests) {
      const file = test.location.file;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    // The table names a file the way the blob report does — relative to the
    // project's root — while a `TestCase` carries the absolute path.
    const seconds = measuredSeconds();
    const specs: SpecWeight[] = [...counts].map(([file, count]) => ({
      file,
      tests: count,
      seconds: seconds.get(relative(params.config.rootDir, file)),
    }));

    const plan = planShards(specs, shard.total);
    const mine = new Set(plan[shard.current - 1] ?? []);

    // Taken over, so Playwright's own contiguous split never runs.
    params.testRun.skipSharding();
    for (const test of tests) {
      if (!mine.has(test.location.file)) params.testRun.exclude(test);
    }
  }

  printsToStdio(): boolean {
    return false;
  }
}

// What each CI runner is asked to do.
//
// Two corpora, both fixtures on purpose — the point of these tests is the
// shape of the division, and that shape has to stay comparable as specs are
// added. `corpus` is the suite as CI ran it on 2026-09-05, counted: fifty-six
// tests in twenty-seven files. `timed` is the suite as CI ran it on
// 2026-09-11, with the seconds each file took on its runner.
import { describe, expect, test } from "bun:test";
import {
  contiguousShards,
  planShards,
  shardSeconds,
  shardSizes,
  weighSpecs,
  type SpecWeight,
} from "./shard-plan.ts";

const corpus: SpecWeight[] = [
  { file: "admin.e2e.ts", tests: 1 },
  { file: "applets-publish.e2e.ts", tests: 1 },
  { file: "applets-shell.e2e.ts", tests: 2 },
  { file: "applets.e2e.ts", tests: 2 },
  { file: "bot-info.e2e.ts", tests: 3 },
  { file: "bot-settings.e2e.ts", tests: 1 },
  { file: "chat.e2e.ts", tests: 12 },
  { file: "computer-presence.e2e.ts", tests: 3 },
  { file: "connect-gmail.e2e.ts", tests: 2 },
  { file: "connect-ollama.e2e.ts", tests: 2 },
  { file: "defaults.e2e.ts", tests: 1 },
  { file: "delete-bot.e2e.ts", tests: 2 },
  { file: "errors.e2e.ts", tests: 2 },
  { file: "first-run.e2e.ts", tests: 1 },
  { file: "mobile.e2e.ts", tests: 2 },
  { file: "continuous-chat.e2e.ts", tests: 2 },
  { file: "package-iframe-ui.e2e.ts", tests: 1 },
  { file: "pinned-bots.e2e.ts", tests: 1 },
  { file: "profile.e2e.ts", tests: 1 },
  { file: "routines.e2e.ts", tests: 4 },
  { file: "settings-models.e2e.ts", tests: 2 },
  { file: "sidebar-groups.e2e.ts", tests: 1 },
  { file: "skill-menu.e2e.ts", tests: 1 },
  { file: "theme.e2e.ts", tests: 1 },
  { file: "unread-focus.e2e.ts", tests: 2 },
  { file: "voice-assistant.e2e.ts", tests: 1 },
  { file: "voice-dictation.e2e.ts", tests: 2 },
];

const totalTests = corpus.reduce((sum, spec) => sum + spec.tests, 0);

const timed: SpecWeight[] = [
  { file: "admin.e2e.ts", tests: 1, seconds: 8.9 },
  { file: "applets-publish.e2e.ts", tests: 1, seconds: 73.1 },
  { file: "applets-shell.e2e.ts", tests: 3, seconds: 174.7 },
  { file: "applets.e2e.ts", tests: 2, seconds: 107.6 },
  { file: "bot-info.e2e.ts", tests: 2, seconds: 12.8 },
  { file: "bot-settings.e2e.ts", tests: 1, seconds: 7.5 },
  { file: "chat.e2e.ts", tests: 12, seconds: 128.9 },
  { file: "computer-presence.e2e.ts", tests: 3, seconds: 13.8 },
  { file: "continuous-chat.e2e.ts", tests: 2, seconds: 83 },
  { file: "defaults.e2e.ts", tests: 1, seconds: 5.1 },
  { file: "delete-bot.e2e.ts", tests: 2, seconds: 29.9 },
  { file: "errors.e2e.ts", tests: 2, seconds: 11.3 },
  { file: "first-run.e2e.ts", tests: 1, seconds: 3.7 },
  { file: "mobile.e2e.ts", tests: 2, seconds: 54.9 },
  { file: "package-iframe-ui.e2e.ts", tests: 1, seconds: 5.5 },
  { file: "pinned-bots.e2e.ts", tests: 1, seconds: 8.6 },
  { file: "profile.e2e.ts", tests: 2, seconds: 27.9 },
  { file: "routine-failure-message.e2e.ts", tests: 1, seconds: 52 },
  { file: "routines.e2e.ts", tests: 2, seconds: 15.3 },
  { file: "settings-models.e2e.ts", tests: 2, seconds: 48.3 },
  { file: "sidebar-groups.e2e.ts", tests: 1, seconds: 7.3 },
  { file: "skill-menu.e2e.ts", tests: 1, seconds: 41.7 },
  { file: "theme.e2e.ts", tests: 1, seconds: 3.4 },
  { file: "unread-focus.e2e.ts", tests: 2, seconds: 130.4 },
];

const totalSeconds = timed.reduce((sum, spec) => sum + (spec.seconds ?? 0), 0);

describe("contiguousShards", () => {
  test("reproduces the split that overloaded shard 1", () => {
    // Twenty-two tests on one runner and seven on another: the run this
    // fixture is taken from spent thirteen minutes on shard 1 and eighty
    // seconds on shard 2.
    expect(shardSizes(corpus, contiguousShards(corpus, 4))).toEqual([
      22, 7, 13, 14,
    ]);
  });
});

describe("planShards", () => {
  test("gives every shard the same share of the fifty-six tests", () => {
    const sizes = shardSizes(corpus, planShards(corpus, 4));
    expect(sizes).toEqual([14, 14, 14, 14]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(totalTests);
  });

  test("runs every spec exactly once", () => {
    const plan = planShards(corpus, 4);
    expect(plan.flat().sort()).toEqual(corpus.map((s) => s.file).sort());
  });

  test("is stable: the same corpus always divides the same way", () => {
    const shuffled = [...corpus].reverse();
    expect(planShards(shuffled, 4)).toEqual(planShards(corpus, 4));
  });

  test("never puts a shard more than the largest file above even", () => {
    for (const shards of [2, 3, 4, 5, 8]) {
      const sizes = shardSizes(corpus, planShards(corpus, shards));
      const largest = Math.max(...corpus.map((spec) => spec.tests));
      expect(Math.max(...sizes)).toBeLessThanOrEqual(
        Math.ceil(totalTests / shards) + largest,
      );
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(totalTests);
    }
  });

  test("beats the contiguous split on the heaviest shard", () => {
    for (const shards of [2, 3, 4, 5, 8]) {
      const balanced = Math.max(
        ...shardSizes(corpus, planShards(corpus, shards)),
      );
      const contiguous = Math.max(
        ...shardSizes(corpus, contiguousShards(corpus, shards)),
      );
      expect(balanced).toBeLessThanOrEqual(contiguous);
    }
  });

  test("one shard is the whole suite", () => {
    expect(planShards(corpus, 1)[0].sort()).toEqual(
      corpus.map((s) => s.file).sort(),
    );
  });

  test("a shard with nothing to do is empty, not undefined", () => {
    expect(planShards([{ file: "only.e2e.ts", tests: 1 }], 3)).toEqual([
      ["only.e2e.ts"],
      [],
      [],
    ]);
  });
});

describe("planShards by measured seconds", () => {
  test("counting tests evenly leaves one shard twice as long as another", () => {
    // The 2026-09-11 run: twelve tests a shard, and shard 2 ran for eleven
    // minutes while shard 1 ran for five.
    const counted = timed.map(({ file, tests }) => ({ file, tests }));
    const minutes = shardSeconds(timed, planShards(counted, 4)).map(
      (seconds) => seconds / 60,
    );
    expect(Math.max(...minutes) / Math.min(...minutes)).toBeGreaterThan(2);
  });

  test("weighing by seconds keeps every shard within one file of even", () => {
    const seconds = shardSeconds(timed, planShards(timed, 4));
    const even = totalSeconds / 4;
    const largest = Math.max(...timed.map((spec) => spec.seconds ?? 0));
    for (const shard of seconds) {
      expect(shard).toBeLessThanOrEqual(even + largest);
    }
    // And in practice far closer: the spread is under a minute.
    expect(Math.max(...seconds) - Math.min(...seconds)).toBeLessThan(60);
    expect(seconds.reduce((a, b) => a + b, 0)).toBeCloseTo(totalSeconds, 6);
  });

  test("the plan for the 2026-09-11 suite", () => {
    // Pinned so a change to the packer shows up as a diff here rather than as
    // a slower run. The two Applet files that shared a runner are apart now.
    const plan = planShards(timed, 4);
    expect(plan).toEqual([
      [
        "applets-shell.e2e.ts",
        "bot-settings.e2e.ts",
        "profile.e2e.ts",
        "routine-failure-message.e2e.ts",
        "theme.e2e.ts",
      ],
      [
        "admin.e2e.ts",
        "bot-info.e2e.ts",
        "mobile.e2e.ts",
        "settings-models.e2e.ts",
        "sidebar-groups.e2e.ts",
        "unread-focus.e2e.ts",
      ],
      [
        "applets-publish.e2e.ts",
        "chat.e2e.ts",
        "delete-bot.e2e.ts",
        "first-run.e2e.ts",
        "package-iframe-ui.e2e.ts",
        "pinned-bots.e2e.ts",
        "routines.e2e.ts",
      ],
      [
        "applets.e2e.ts",
        "computer-presence.e2e.ts",
        "continuous-chat.e2e.ts",
        "defaults.e2e.ts",
        "errors.e2e.ts",
        "skill-menu.e2e.ts",
      ],
    ]);
    expect(shardSeconds(timed, plan).map(Math.round)).toEqual([
      266, 263, 265, 263,
    ]);
  });

  test("a file the table has never timed is priced as average tests", () => {
    const costs = new Map(
      weighSpecs([
        { file: "slow.e2e.ts", tests: 1, seconds: 90 },
        { file: "quick.e2e.ts", tests: 3, seconds: 30 },
        { file: "new.e2e.ts", tests: 2 },
      ]).map((spec) => [spec.file, spec.cost]),
    );
    // 120 seconds over 4 timed tests is 30 a test; two of them are 60.
    expect(costs.get("new.e2e.ts")).toBe(60);
    expect(costs.get("slow.e2e.ts")).toBe(90);
  });

  test("a new file lands on a shard without disturbing the balance", () => {
    const plan = planShards(
      [...timed, { file: "brand-new.e2e.ts", tests: 2 }],
      4,
    );
    expect(plan.flat()).toContain("brand-new.e2e.ts");
    expect(plan.flat()).toHaveLength(timed.length + 1);
  });

  test("with nothing timed the plan is the count-balanced one", () => {
    const counted = corpus.map(({ file, tests }) => ({ file, tests }));
    expect(planShards(counted, 4)).toEqual(planShards(corpus, 4));
    expect(shardSeconds(counted, planShards(counted, 4))).toEqual(
      shardSizes(counted, planShards(counted, 4)),
    );
  });
});

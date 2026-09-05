// What each CI runner is asked to do.
//
// The corpus below is the browser end-to-end suite as CI ran it on
// 2026-09-05: fifty-six tests in twenty-seven files. It is a fixture on
// purpose — the point of these tests is the shape of the division, and that
// shape has to stay comparable as specs are added.
import { describe, expect, test } from "bun:test";
import {
  contiguousShards,
  planShards,
  shardSizes,
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
  { file: "new-conversation.e2e.ts", tests: 2 },
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

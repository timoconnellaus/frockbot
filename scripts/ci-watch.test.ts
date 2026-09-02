import { describe, expect, test } from "bun:test";
import {
  formatReport,
  parseArguments,
  pullRequestReport,
  releaseReport,
  watch,
  type GitHubJson,
} from "./ci-watch.js";

/**
 * Answers `gh` calls from a table keyed by the distinguishing argument, so a
 * test states the GitHub it is describing rather than a sequence of calls.
 */
function fakeGitHub(responses: {
  pr?: unknown;
  runs?: unknown;
  run?: unknown;
}): GitHubJson & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "pr") return Promise.resolve(responses.pr);
    if (args[1] === "list") return Promise.resolve(responses.runs ?? []);
    return Promise.resolve(responses.run ?? { jobs: [] });
  };
  return Object.assign(gh, { calls });
}

const merged = { state: "MERGED", url: "https://example.test/128" };

describe("pull request leg", () => {
  test("a merged pull request has landed", async () => {
    const report = await pullRequestReport(fakeGitHub({ pr: merged }), 128);
    expect(report.status).toBe("passed");
    expect(report.summary).toContain("#128 merged");
  });

  test("a pull request closed without merging is a failure, not a wait", async () => {
    const report = await pullRequestReport(
      fakeGitHub({ pr: { state: "CLOSED", url: "u" } }),
      128,
    );
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("closed without merging");
  });

  test("names the checks that failed", async () => {
    const report = await pullRequestReport(
      fakeGitHub({
        pr: {
          state: "OPEN",
          statusCheckRollup: [
            { name: "Validate", status: "COMPLETED", conclusion: "SUCCESS" },
            {
              name: "Browser end-to-end",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
          ],
        },
      }),
      128,
    );
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("Browser end-to-end");
    expect(report.summary).not.toContain("Validate,");
  });

  test("a cancelled required check never turns green, so it is a failure", async () => {
    const report = await pullRequestReport(
      fakeGitHub({
        pr: {
          state: "OPEN",
          statusCheckRollup: [
            { name: "Validate", status: "COMPLETED", conclusion: "CANCELLED" },
          ],
        },
      }),
      128,
    );
    expect(report.status).toBe("failed");
  });

  test("waits while a check is still running", async () => {
    const report = await pullRequestReport(
      fakeGitHub({
        pr: {
          state: "OPEN",
          statusCheckRollup: [
            { name: "Validate", status: "IN_PROGRESS", conclusion: "" },
          ],
          autoMergeRequest: { enabledAt: "now" },
        },
      }),
      128,
    );
    expect(report.status).toBe("pending");
    expect(report.summary).toContain("Validate");
  });

  test("green checks with the merge queued is still pending", async () => {
    const report = await pullRequestReport(
      fakeGitHub({
        pr: {
          state: "OPEN",
          statusCheckRollup: [
            { name: "Validate", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
          autoMergeRequest: { enabledAt: "now" },
        },
      }),
      128,
    );
    expect(report.status).toBe("pending");
    expect(report.summary).toContain("queued to merge");
  });

  test("green checks with nothing queued is the quiet failure this exists to catch", async () => {
    const report = await pullRequestReport(
      fakeGitHub({
        pr: {
          state: "OPEN",
          statusCheckRollup: [
            { name: "Validate", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
          autoMergeRequest: null,
        },
      }),
      128,
    );
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("nothing queued the merge");
    expect(report.detail?.join(" ")).toContain(".github/workflows/");
  });

  test("reads a legacy status context, which carries no status field", async () => {
    const report = await pullRequestReport(
      fakeGitHub({
        pr: {
          state: "OPEN",
          statusCheckRollup: [{ context: "legacy/build", state: "FAILURE" }],
        },
      }),
      128,
    );
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("legacy/build");
  });
});

describe("release leg", () => {
  const runs = [
    {
      databaseId: 7,
      headBranch: "v0.2.0",
      status: "completed",
      conclusion: "success",
      url: "https://example.test/7",
    },
  ];

  test("waits when the tag has produced no run yet", async () => {
    const report = await releaseReport(fakeGitHub({ runs: [] }), "v0.2.0");
    expect(report.status).toBe("pending");
    expect(report.summary).toContain("no release run");
  });

  test("a release that deployed both Workers has shipped", async () => {
    const report = await releaseReport(
      fakeGitHub({
        runs,
        run: {
          jobs: [
            { name: "Publish packages and release", conclusion: "success" },
            { name: "Deploy marketing site", conclusion: "success" },
            { name: "Deploy FrockBot app", conclusion: "success" },
          ],
        },
      }),
      "v0.2.0",
    );
    expect(report.status).toBe("passed");
    expect(report.summary).toContain("production deployed");
  });

  test("publishing without deploying is called out as production not moving", async () => {
    const report = await releaseReport(
      fakeGitHub({
        runs,
        run: {
          jobs: [
            { name: "Publish packages and release", conclusion: "success" },
            { name: "Deploy marketing site", conclusion: "success" },
            {
              name: "Deploy FrockBot app",
              conclusion: "failure",
              steps: [{ name: "Deploy Worker", conclusion: "failure" }],
            },
          ],
        },
      }),
      "v0.2.0",
    );
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("production did not change");
    expect(report.detail?.join(" ")).toContain("Deploy Worker");
  });

  test("a completed run that never deployed is a failure, not a pass", async () => {
    const report = await releaseReport(
      fakeGitHub({
        runs,
        run: {
          jobs: [
            { name: "Publish packages and release", conclusion: "success" },
          ],
        },
      }),
      "v0.2.0",
    );
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("without deploying production");
  });

  test("waits while the release is still running", async () => {
    const report = await releaseReport(
      fakeGitHub({
        runs: [{ ...runs[0], status: "in_progress", conclusion: "" }],
        run: {
          jobs: [{ name: "Publish packages and release", conclusion: "" }],
        },
      }),
      "v0.2.0",
    );
    expect(report.status).toBe("pending");
  });
});

describe("watching", () => {
  test("--once reports what is true now rather than waiting", async () => {
    let sleeps = 0;
    const report = await watch(
      fakeGitHub({ pr: { state: "OPEN", statusCheckRollup: [] } }),
      "pr",
      "128",
      { once: true, intervalSeconds: 1, deadlineMinutes: 1 },
      () => {
        sleeps += 1;
        return Promise.resolve();
      },
    );
    expect(report.status).toBe("pending");
    expect(sleeps).toBe(0);
  });

  test("polls until the pull request settles", async () => {
    const states = [
      { state: "OPEN", statusCheckRollup: [], autoMergeRequest: {} },
      merged,
    ];
    let index = 0;
    const gh: GitHubJson = () => Promise.resolve(states[Math.min(index++, 1)]);
    const report = await watch(
      gh,
      "pr",
      "128",
      { once: false, intervalSeconds: 1, deadlineMinutes: 5 },
      () => Promise.resolve(),
    );
    expect(report.status).toBe("passed");
  });

  test("gives up at the deadline and says so, still pending", async () => {
    let clock = 0;
    const report = await watch(
      fakeGitHub({ pr: { state: "OPEN", statusCheckRollup: [] } }),
      "pr",
      "128",
      { once: false, intervalSeconds: 1, deadlineMinutes: 1 },
      () => {
        clock += 60_000;
        return Promise.resolve();
      },
      () => clock,
    );
    expect(report.status).toBe("pending");
    expect(report.detail?.join(" ")).toContain("still pending after 1 minutes");
  });
});

describe("arguments", () => {
  test("rejects a leg it cannot watch", () => {
    expect(() => parseArguments(["deploy", "thing"])).toThrow("usage:");
  });

  test("rejects a pull request with no subject", () => {
    expect(() => parseArguments(["pr"])).toThrow("usage:");
  });

  test("reads the polling flags", () => {
    const parsed = parseArguments([
      "release",
      "v0.2.0",
      "--interval-seconds",
      "5",
      "--deadline-minutes",
      "2",
    ]);
    expect(parsed.subject).toBe("v0.2.0");
    expect(parsed.options).toEqual({
      once: false,
      intervalSeconds: 5,
      deadlineMinutes: 2,
    });
  });

  test("rejects a nonsense interval rather than polling forever", () => {
    expect(() =>
      parseArguments(["pr", "1", "--interval-seconds", "0"]),
    ).toThrow("positive number");
  });
});

describe("output", () => {
  test("prints the verdict first and its evidence beneath", () => {
    expect(
      formatReport({
        status: "failed",
        summary: "broke",
        detail: ["why", "url"],
      }),
    ).toBe("failed: broke\n  why\n  url");
  });
});

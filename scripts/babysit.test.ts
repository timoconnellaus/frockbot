import { describe, expect, test } from "bun:test";
import {
  formatSnapshot,
  latestReleaseTag,
  mainState,
  pullRequestOf,
  pullRequestState,
  requiredChecks,
  snapshot,
} from "./babysit.js";
import type { GitHubJson } from "./ci-watch.js";

/**
 * Answers `gh` calls by what they ask for, so each test states the GitHub it
 * describes rather than the order the script happens to call it in.
 */
function fakeGitHub(state: {
  mainRuns?: unknown[];
  /** Jobs for every run, or per run keyed `<id>` or `<id>#<attempt>`. */
  jobs?: unknown[] | Record<string, unknown[]>;
  compare?: unknown[];
  pullRequests?: unknown[];
  tags?: unknown[][];
  required?: string[];
  headCommitDate?: string;
  releaseRuns?: unknown[];
}): GitHubJson & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: readonly string[]) => {
    calls.push([...args]);
    const [command, sub] = args;
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (command === "run" && sub === "list")
      return Promise.resolve(
        args.includes("main.yml")
          ? (state.mainRuns ?? [])
          : (state.releaseRuns ?? []),
      );
    if (command === "run" && sub === "view") {
      if (Array.isArray(state.jobs) || !state.jobs)
        return Promise.resolve({ jobs: state.jobs ?? [] });
      const attempt = args.includes("--attempt")
        ? `#${args[args.indexOf("--attempt") + 1]}`
        : "";
      return Promise.resolve({
        jobs: state.jobs[`${args[2]}${attempt}`] ?? [],
      });
    }
    if (command === "pr") return Promise.resolve(state.pullRequests ?? []);
    if (path.includes("/compare/"))
      return Promise.resolve({ commits: state.compare ?? [] });
    if (path.endsWith("/rules/branches/main"))
      return Promise.resolve([
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: (
              state.required ?? ["Check", "Flutter"]
            ).map((context) => ({ context })),
          },
        },
      ]);
    if (path.includes("/matching-refs/tags/"))
      return Promise.resolve(state.tags ?? [[]]);
    if (path.includes("/commits/"))
      return Promise.resolve({
        commit: {
          committer: { date: state.headCommitDate ?? "2026-09-24T00:00:00Z" },
        },
      });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return Object.assign(gh, { calls });
}

const run = (
  id: number,
  conclusion: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) => ({
  databaseId: id,
  headSha: `sha${id}`,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  createdAt,
  url: `https://example.test/runs/${id}`,
  event: "push",
  ...extra,
});

const commit = (sha: string, message: string, parents: string[]) => ({
  sha,
  commit: { message },
  parents: parents.map((parent) => ({ sha: parent })),
});

describe("pullRequestOf", () => {
  test("reads a merge commit and a squash", () => {
    expect(pullRequestOf("Merge pull request #767 from a/b\n\nTitle")).toBe(
      767,
    );
    expect(pullRequestOf("Hold every copy of a Bot (#764)")).toBe(764);
  });

  test("a commit pushed straight to main landed no pull request", () => {
    expect(pullRequestOf("Upgrade Bun to 1.4.2")).toBeNull();
  });
});

describe("main", () => {
  test("green when the newest settled run passed; a cancelled run was only superseded", async () => {
    const state = await mainState(
      fakeGitHub({
        mainRuns: [
          run(3, "cancelled", "2026-09-24T03:00:00Z"),
          run(2, "success", "2026-09-24T02:00:00Z"),
          run(1, "failure", "2026-09-24T01:00:00Z"),
        ],
      }),
    );
    expect(state.status).toBe("green");
    expect(state.settled?.id).toBe(2);
    expect(state.suspects).toEqual([]);
  });

  test("a run on another event, such as a schedule, says nothing about main", async () => {
    const state = await mainState(
      fakeGitHub({
        mainRuns: [
          run(2, "failure", "2026-09-24T02:00:00Z", { event: "schedule" }),
          run(1, "success", "2026-09-24T01:00:00Z"),
        ],
      }),
    );
    expect(state.status).toBe("green");
  });

  test("red names the failed jobs, when the streak began, and every landing since the last green", async () => {
    const gh = fakeGitHub({
      mainRuns: [
        run(5, "", "2026-09-24T05:00:00Z"),
        run(4, "failure", "2026-09-24T04:00:00Z"),
        run(3, "failure", "2026-09-24T03:00:00Z"),
        run(2, "success", "2026-09-24T02:00:00Z"),
      ],
      jobs: [
        { name: "Validate", conclusion: "success", url: "j1", steps: [] },
        {
          name: "Browser end-to-end (core 4/4)",
          conclusion: "failure",
          url: "j2",
          steps: [
            { name: "Install dependencies", conclusion: "success" },
            { name: "Test browser end to end", conclusion: "failure" },
          ],
        },
      ],
      // sha2 ← m1 (merge of b1) ← s2 (squash) = sha4. `b1` is the merged
      // branch's own commit and must not count as a landing.
      compare: [
        commit("b1", "wip: branch commit", ["sha2"]),
        commit("m1", "Merge pull request #770 from x/y\n\nFix the composer", [
          "sha2",
          "b1",
        ]),
        commit("sha4", "Tidy the sidebar (#771)", ["m1"]),
      ],
    });
    const state = await mainState(gh);

    expect(state.status).toBe("red");
    expect(state.settled?.id).toBe(4);
    expect(state.running?.id).toBe(5);
    expect(state.redSince).toBe("2026-09-24T03:00:00Z");
    expect(state.lastGreen?.sha).toBe("sha2");
    expect(state.failedJobs).toEqual([
      {
        name: "Browser end-to-end (core 4/4)",
        conclusion: "failure",
        url: "j2",
        steps: ["Test browser end to end"],
      },
    ]);
    expect(state.suspects).toEqual([
      { sha: "m1", pullRequest: 770, title: "Fix the composer" },
      { sha: "sha4", pullRequest: 771, title: "Tidy the sidebar" },
    ]);
    expect(gh.calls).toContainEqual([
      "api",
      "repos/{owner}/{repo}/compare/sha2...sha4",
    ]);
  });

  test("a run that timed out reads as red: GitHub reports the timeout as cancelled", async () => {
    const state = await mainState(
      fakeGitHub({
        mainRuns: [
          run(3, "cancelled", "2026-09-24T03:00:00Z"),
          run(2, "success", "2026-09-24T02:00:00Z"),
        ],
        jobs: {
          "3": [
            { name: "Validate", conclusion: "success", url: "j1", steps: [] },
            {
              name: "Browser end-to-end (core 1/4)",
              conclusion: "cancelled",
              url: "j2",
              steps: [
                { name: "Test browser end to end", conclusion: "cancelled" },
              ],
            },
          ],
        },
      }),
    );
    expect(state.status).toBe("red");
    expect(state.settled?.id).toBe(3);
    expect(state.failedJobs).toMatchObject([
      { name: "Browser end-to-end (core 1/4)", conclusion: "cancelled" },
    ]);
  });

  test("a failed run being rerun keeps main red until the rerun passes", async () => {
    const state = await mainState(
      fakeGitHub({
        // A rerun keeps its id and creation time and goes back in progress.
        mainRuns: [
          run(3, "", "2026-09-24T03:00:00Z", { attempt: 2 }),
          run(2, "success", "2026-09-24T02:00:00Z"),
        ],
        jobs: {
          "3#1": [
            {
              name: "Cloudflare runtime",
              conclusion: "failure",
              url: "j",
              steps: [],
            },
          ],
        },
      }),
    );
    expect(state).toMatchObject({
      status: "red",
      rerunning: true,
      settled: { id: 3 },
      lastGreen: { id: 2 },
      failedJobs: [{ name: "Cloudflare runtime" }],
    });
    expect(state.running).toBeUndefined();
  });

  test("red with no green in the window says so rather than guessing suspects", async () => {
    const state = await mainState(
      fakeGitHub({ mainRuns: [run(2, "failure", "2026-09-24T02:00:00Z")] }),
    );
    expect(state.status).toBe("red");
    expect(state.lastGreen).toBeUndefined();
    expect(state.suspects).toEqual([]);
  });

  test("unknown before any run has settled", async () => {
    const state = await mainState(
      fakeGitHub({ mainRuns: [run(1, "", "2026-09-24T01:00:00Z")] }),
    );
    expect(state.status).toBe("unknown");
    expect(state.running?.id).toBe(1);
  });
});

describe("pull requests", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const green = [
    { name: "Check", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Flutter", status: "COMPLETED", conclusion: "SUCCESS" },
  ];
  const pr = (extra: Record<string, unknown> = {}) => ({
    number: 800,
    title: "Add a thing",
    url: "https://example.test/800",
    isDraft: false,
    labels: [],
    headRefName: "claude/thing",
    headRefOid: "head800",
    baseRefName: "main",
    mergeable: "MERGEABLE",
    statusCheckRollup: green,
    author: { login: "timoconnellaus" },
    ...extra,
  });
  const decide = (
    value: Record<string, unknown>,
    main: "green" | "red" | "unknown" = "green",
  ) => pullRequestState(value, { main, required: ["Check", "Flutter"], now });

  test("green, mergeable and main green: merge", () => {
    expect(decide(pr())).toMatchObject({ action: "merge", reason: "green" });
  });

  test("green but main red: held, unless it repairs main", () => {
    expect(decide(pr(), "red").action).toBe("held");
    expect(decide(pr({ labels: [{ name: "fix-main" }] }), "red").action).toBe(
      "merge",
    );
    expect(decide(pr({ title: 'Revert "Add a thing"' }), "red").action).toBe(
      "merge",
    );
  });

  test("green but main has no settled run is held too", () => {
    expect(decide(pr(), "unknown").action).toBe("held");
  });

  test("a fork's pull request waits for Tim, however green it is", () => {
    expect(decide(pr({ isCrossRepository: true }))).toMatchObject({
      action: "skip",
      reason: "from a fork: Tim reviews it",
    });
  });

  test("anyone can title a fork `Revert`, so only a branch here repairs main by title", () => {
    const revert = { title: 'Revert "Add a thing"' };
    expect(decide(pr(revert), "red").action).toBe("merge");
    expect(
      decide(pr({ ...revert, isCrossRepository: true }), "red").action,
    ).toBe("skip");
  });

  test("a review asking for changes holds the merge", () => {
    expect(decide(pr({ reviewDecision: "CHANGES_REQUESTED" })).reason).toBe(
      "changes requested",
    );
  });

  test("drafts, held pull requests and stacked branches are left alone", () => {
    expect(decide(pr({ isDraft: true })).action).toBe("skip");
    expect(decide(pr({ labels: [{ name: "hold" }] })).action).toBe("skip");
    expect(decide(pr({ baseRefName: "feature" })).reason).toBe(
      "targets feature, not main",
    );
  });

  test("a conflict comes before checks: they are stale once it is rebased", () => {
    const state = decide(
      pr({
        mergeable: "CONFLICTING",
        statusCheckRollup: [
          { name: "Check", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      }),
    );
    expect(state.action).toBe("rebase");
  });

  test("any failed check, required or not, needs a fix", () => {
    const state = decide(
      pr({
        statusCheckRollup: [
          ...green,
          {
            name: "Qualify Mac desktop",
            status: "COMPLETED",
            conclusion: "FAILURE",
          },
          { name: "Preview", status: "COMPLETED", conclusion: "CANCELLED" },
        ],
      }),
    );
    expect(state.action).toBe("fix");
    expect(state.failedChecks).toEqual(["Qualify Mac desktop", "Preview"]);
  });

  test("skipped and neutral checks pass", () => {
    const state = decide(
      pr({
        statusCheckRollup: [
          ...green,
          { name: "Preview", status: "COMPLETED", conclusion: "SKIPPED" },
          { context: "legacy", state: "SUCCESS" },
        ],
      }),
    );
    expect(state.action).toBe("merge");
  });

  test("waits for a required check that has not reported, and for running ones", () => {
    expect(decide(pr({ statusCheckRollup: [green[0]] })).reason).toBe(
      "waiting on Flutter",
    );
    expect(
      decide(
        pr({
          statusCheckRollup: [
            green[0],
            { name: "Flutter", status: "IN_PROGRESS", conclusion: "" },
          ],
        }),
      ).reason,
    ).toBe("waiting on Flutter");
  });

  test("a red main-health is main's state, not the pull request's fault", () => {
    const withHealth = (state: string) =>
      pr({ statusCheckRollup: [...green, { context: "main-health", state }] });
    expect(decide(withHealth("FAILURE"), "red")).toMatchObject({
      action: "held",
      failedChecks: [],
    });
    // main went green but the status has not been refreshed yet: GitHub
    // would refuse the merge.
    expect(decide(withHealth("FAILURE"), "green")).toMatchObject({
      action: "wait",
      reason: "main-health has not caught up with main",
    });
    expect(decide(withHealth("SUCCESS"), "green").action).toBe("merge");
  });

  test("waits while GitHub is still computing mergeability", () => {
    expect(decide(pr({ mergeable: "UNKNOWN" })).action).toBe("wait");
  });

  test("reads how long a failing pull request's author has been quiet", async () => {
    const gh = fakeGitHub({
      pullRequests: [
        pr({
          statusCheckRollup: [
            { name: "Check", status: "COMPLETED", conclusion: "FAILURE" },
          ],
        }),
        pr({ number: 801, headRefOid: "head801" }),
      ],
      headCommitDate: "2026-09-24T11:15:00Z",
      mainRuns: [run(1, "success", "2026-09-24T01:00:00Z")],
      tags: [[{ ref: "refs/tags/v0.1.0" }]],
      releaseRuns: [],
    });
    const value = await snapshot(gh, now);
    expect(
      value.pullRequests.map((state) => [
        state.number,
        state.action,
        state.idleMinutes,
      ]),
    ).toEqual([
      [800, "fix", 45],
      [801, "merge", null],
    ]);
    // Only the failing one's head commit was read.
    expect(
      gh.calls.filter((call) => call.some((arg) => arg.includes("/commits/"))),
    ).toEqual([["api", "repos/{owner}/{repo}/commits/head800"]]);
  });
});

describe("GitHub configuration", () => {
  test("the required checks come from the ruleset", async () => {
    expect(
      await requiredChecks(
        fakeGitHub({ required: ["Check", "Flutter", "main-health"] }),
      ),
    ).toEqual(["Check", "Flutter", "main-health"]);
  });

  test("the release tag is the highest vX.Y.Z across pages, by number not by text", async () => {
    const tag = await latestReleaseTag(
      fakeGitHub({
        tags: [
          [{ ref: "refs/tags/v0.7.99" }, { ref: "refs/tags/v0.7.191" }],
          [{ ref: "refs/tags/v0.8.0-rc.1" }, { ref: "refs/tags/v0.7.20" }],
        ],
      }),
    );
    expect(tag).toBe("v0.7.191");
  });
});

describe("format", () => {
  test("a red main leads with how long, what failed and who landed since green", () => {
    const text = formatSnapshot({
      takenAt: "2026-09-24T05:30:00Z",
      main: {
        status: "red",
        settled: {
          id: 4,
          sha: "sha4sha4sha4",
          url: "u",
          createdAt: "2026-09-24T04:00:00Z",
        },
        redSince: "2026-09-24T03:00:00Z",
        lastGreen: {
          id: 2,
          sha: "sha2sha2sha2",
          url: "u",
          createdAt: "2026-09-24T02:00:00Z",
        },
        failedJobs: [
          {
            name: "Cloudflare runtime",
            conclusion: "failure",
            steps: ["Test Cloudflare runtime compatibility"],
            url: "u",
          },
        ],
        suspects: [{ sha: "m1", pullRequest: 770, title: "Fix the composer" }],
      },
      production: {
        tag: "v0.7.191",
        report: {
          status: "passed",
          summary: "v0.7.191 released and production deployed",
        },
      },
      pullRequests: [],
    });
    expect(text).toContain("main   RED for 2h30m");
    expect(text).toContain(
      "✗ Cloudflare runtime › Test Cloudflare runtime compatibility",
    );
    expect(text).toContain("#770  Fix the composer");
    expect(text).toContain("prod   v0.7.191 released and production deployed");
    expect(text).toContain("PRs    none open");
  });
});

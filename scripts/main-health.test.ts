import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { GitHubJson } from "./ci-watch.js";
import { healthStatus, setHealth } from "./main-health.js";

describe("main-health", () => {
  test("follows main", () => {
    const pr = { labels: [], title: "Add a thing" };
    expect(healthStatus("green", pr).state).toBe("success");
    expect(healthStatus("red", pr).state).toBe("failure");
    expect(healthStatus("unknown", pr).state).toBe("pending");
  });

  test("a repair may always merge, or main could never go green again", () => {
    expect(
      healthStatus("red", { labels: ["fix-main"], title: "x" }).state,
    ).toBe("success");
    expect(
      healthStatus("red", { labels: [], title: 'Revert "Add a thing"' }).state,
    ).toBe("success");
  });

  test("every description fits GitHub's 140 characters", () => {
    for (const main of ["green", "red", "unknown"] as const)
      for (const labels of [[], ["fix-main"]])
        expect(
          healthStatus(main, { labels, title: "" }).description.length,
        ).toBeLessThanOrEqual(140);
  });

  test("sets the status on each open pull request's head, pointing at main's run", async () => {
    const calls: string[][] = [];
    const gh: GitHubJson = (args) => {
      calls.push([...args]);
      if (args[0] === "run" && args[1] === "list")
        return Promise.resolve([
          {
            databaseId: 9,
            headSha: "m9",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-09-24T02:00:00Z",
            url: "https://example.test/runs/9",
            event: "push",
          },
        ]);
      if (args[0] === "run" && args[1] === "view")
        return Promise.resolve({ jobs: [] });
      if (args[0] === "pr")
        return Promise.resolve([
          {
            number: 1,
            title: "Add a thing",
            labels: [],
            headRefOid: "h1",
            baseRefName: "main",
          },
          {
            number: 2,
            title: "Fix the fixture",
            labels: [{ name: "fix-main" }],
            headRefOid: "h2",
            baseRefName: "main",
          },
          {
            number: 3,
            title: "Stacked",
            labels: [],
            headRefOid: "h3",
            baseRefName: "feature",
          },
        ]);
      return Promise.resolve({});
    };

    const report = await setHealth(gh);

    const posts = calls.filter((call) => call.includes("POST"));
    expect(posts.map((call) => call[3])).toEqual([
      "repos/{owner}/{repo}/statuses/h1",
      "repos/{owner}/{repo}/statuses/h2",
    ]);
    expect(posts[0]).toContain("state=failure");
    expect(posts[0]).toContain("context=main-health");
    expect(posts[0]).toContain("target_url=https://example.test/runs/9");
    expect(posts[1]).toContain("state=success");
    expect(report).toHaveLength(2);
  });
});

describe("main-health workflow", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/main-health.yml", import.meta.url),
      "utf8",
    ),
  ) as {
    on: {
      workflow_run: {
        workflows: string[];
        types: string[];
        branches: string[];
      };
      pull_request_target: { types: string[] };
    };
    permissions: Record<string, string>;
    jobs: {
      status: {
        steps: Array<{
          uses?: string;
          with?: Record<string, unknown>;
          run?: string;
          env?: Record<string, string>;
        }>;
      };
    };
  };
  const main = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/main.yml", import.meta.url),
      "utf8",
    ),
  ) as { name: string };

  test("reruns when main settles and when a pull request's labels or title change", () => {
    expect(workflow.on.workflow_run).toEqual({
      workflows: [main.name],
      types: ["completed"],
      branches: ["main"],
    });
    expect(workflow.on.pull_request_target.types).toEqual(
      expect.arrayContaining(["synchronize", "labeled", "unlabeled", "edited"]),
    );
  });

  test("never checks out the pull request's code under its write token", () => {
    const steps = workflow.jobs.status.steps;
    const checkout = steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    // No `ref`: `pull_request_target` then checks out the base branch.
    expect(checkout?.with?.ref).toBeUndefined();
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(steps.at(-1)?.run).toBe("bun scripts/main-health.ts $PULL_REQUEST");
  });
});

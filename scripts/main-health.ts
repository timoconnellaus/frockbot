/**
 * Keeps the `main-health` commit status on open pull requests, so GitHub
 * itself refuses a merge onto a red `main` — whoever merges, with whatever
 * tool. Green while `main` is green; red while it is red, except on a pull
 * request that repairs it (`fix-main`, or a revert), which may always merge.
 * `.github/workflows/main-health.yml` runs it whenever `main.yml` finishes
 * and whenever a pull request changes.
 *
 *   bun scripts/main-health.ts        # every open pull request on main
 *   bun scripts/main-health.ts 812    # one
 */

import {
  ghJson,
  MAIN_HEALTH_CHECK,
  mainState,
  repairsMain,
  type MainState,
} from "./babysit.js";
import type { GitHubJson } from "./ci-watch.js";

export interface HealthStatus {
  state: "success" | "failure" | "pending";
  description: string;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${what} is not an object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** What `main-health` says on one pull request. GitHub caps a description at 140 characters. */
export function healthStatus(
  main: MainState["status"],
  pullRequest: Parameters<typeof repairsMain>[0],
): HealthStatus {
  if (repairsMain(pullRequest))
    return {
      state: "success",
      description: "Repairs main, so it may merge while main is red",
    };
  if (main === "green")
    return { state: "success", description: "main is green" };
  if (main === "red")
    return {
      state: "failure",
      description:
        "main is red: only a fix-main pull request or a revert merges until it is green",
    };
  return { state: "pending", description: "main has no settled run yet" };
}

export async function setHealth(
  gh: GitHubJson,
  only?: number,
): Promise<string[]> {
  const main = await mainState(gh);
  const fields = "number,title,labels,headRefOid,baseRefName,isCrossRepository";
  const pullRequests = (
    only
      ? [await gh(["pr", "view", String(only), "--json", fields])]
      : ((await gh([
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          fields,
        ])) as unknown[])
  )
    .map((value) => record(value, "pull request"))
    .filter((value) => text(value.baseRefName) === "main");

  const report: string[] = [];
  for (const value of pullRequests) {
    const labels = (Array.isArray(value.labels) ? value.labels : []).map(
      (label) => text(record(label, "label").name),
    );
    const status = healthStatus(main.status, {
      labels,
      title: text(value.title),
      crossRepository: value.isCrossRepository === true,
    });
    await gh([
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/statuses/${text(value.headRefOid)}`,
      "-f",
      `state=${status.state}`,
      "-f",
      `context=${MAIN_HEALTH_CHECK}`,
      "-f",
      `description=${status.description}`,
      ...(main.settled ? ["-f", `target_url=${main.settled.url}`] : []),
    ]);
    report.push(
      `#${String(value.number)} ${status.state}: ${status.description}`,
    );
  }
  return report;
}

if (import.meta.main) {
  const only = process.argv[2] ? Number(process.argv[2]) : undefined;
  const report = await setHealth(ghJson, only);
  console.log(
    report.length ? report.join("\n") : "no open pull requests on main",
  );
}

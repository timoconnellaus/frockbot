#!/usr/bin/env bun
/**
 * Reads the product events a deployment wrote (app/analytics/events.ts) from
 * Cloudflare Analytics Engine. See docs/analytics.md.
 *
 *   bun scripts/analytics.ts funnel [--days 30] [--profile hosted]
 *   bun scripts/analytics.ts events [--days 7]
 *   bun scripts/analytics.ts sql "SELECT blob1, count() FROM {dataset} GROUP BY blob1"
 *
 * `{dataset}` in a query is replaced with the profile's dataset name.
 * The token is an API token with Account Analytics Read, from
 * CLOUDFLARE_ANALYTICS_TOKEN or `CLOUDFLARE_ANALYTICS_TOKEN=` in `.dev.vars`
 * (this checkout, then the main checkout).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resourceNamesV1 } from "../apps/cloudflare/deployment-config/generate.ts";
import { loadProfileV1 } from "../apps/cloudflare/deployment-config/profile.ts";
import { PROFILE_DIRECTORY_V1 } from "./deployment-config/repository.ts";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * The milestones a new account's first week is read against, in order. A
 * `:` narrows a step to one `kind` or `detail`: `bot_created:user` is a Bot
 * the person made rather than General, and `turn_settled:routine` a Routine
 * that fired, whoever made it.
 */
export const FUNNEL_STEPS_V1 = [
  "account_created",
  "app_opened",
  "message_sent",
  "tool_used:memory_write",
  "tool_used:routine_manage",
  "turn_settled:routine",
  "push_registered",
  "desktop_paired",
  "bot_created:user",
  "plugin_enabled",
  "voice_call_started",
  "trial_started",
  "paid_period",
] as const;

export interface FirstSeenRowV1 {
  user: string;
  event: string;
  kind: string | null;
  detail: string | null;
  first: string;
}

/**
 * Of the accounts created in the window, how many reached each milestone
 * within their first seven days.
 */
export function funnelV1(rows: readonly FirstSeenRowV1[]) {
  const firsts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const at = Date.parse(row.first.replace(" ", "T") + "Z");
    const user = firsts.get(row.user) ?? new Map<string, number>();
    const keys = [row.event];
    if (row.kind) keys.push(`${row.event}:${row.kind}`);
    if (row.detail) keys.push(`${row.event}:${row.detail}`);
    for (const key of keys) {
      const seen = user.get(key);
      if (seen === undefined || at < seen) user.set(key, at);
    }
    firsts.set(row.user, user);
  }
  const cohort = [...firsts.values()].filter((user) =>
    user.has("account_created"),
  );
  const week = 7 * 86_400_000;
  return FUNNEL_STEPS_V1.map((step) => {
    const reached = cohort.filter((user) => {
      const at = user.get(step);
      return at !== undefined && at - user.get("account_created")! <= week;
    }).length;
    return { step, reached, of: cohort.length };
  });
}

function devVar(name: string): string | undefined {
  const roots = [repoRoot];
  try {
    const common = execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ).trim();
    roots.push(dirname(common));
  } catch {
    // Not a checkout; this one's `.dev.vars` is the only place to look.
  }
  for (const root of roots) {
    const file = join(root, ".dev.vars");
    if (!existsSync(file)) continue;
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((entry) => entry.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  }
  return undefined;
}

async function query(accountId: string, token: string, sql: string) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: sql,
    },
  );
  const text = await response.text();
  if (!response.ok)
    throw new Error(`Analytics Engine ${response.status}: ${text}`);
  return (JSON.parse(text) as { data: Record<string, unknown>[] }).data;
}

function option(args: string[], name: string, fallback: string) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
}

async function main(args: string[]) {
  const [command, ...rest] = args;
  const profile = loadProfileV1(
    option(rest, "profile", "hosted"),
    PROFILE_DIRECTORY_V1,
  );
  const dataset = resourceNamesV1(profile).analyticsDataset;
  const days = Number(option(rest, "days", command === "funnel" ? "30" : "7"));
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error("--days is a whole number from 1 to 90");
  const token =
    process.env.CLOUDFLARE_ANALYTICS_TOKEN ??
    devVar("CLOUDFLARE_ANALYTICS_TOKEN");
  if (!token)
    throw new Error(
      "Set CLOUDFLARE_ANALYTICS_TOKEN (an API token with Account Analytics Read), or put it in .dev.vars",
    );
  const run = (sql: string) =>
    query(profile.accountId, token, sql.replaceAll("{dataset}", dataset));
  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;

  if (command === "events") {
    console.table(
      await run(
        `SELECT blob1 AS event, blob4 AS kind, SUM(_sample_interval) AS events,
           COUNT(DISTINCT blob2) AS users
         FROM {dataset} WHERE ${since}
         GROUP BY event, kind ORDER BY events DESC LIMIT 200`,
      ),
    );
    return;
  }
  if (command === "funnel") {
    const rows = (await run(
      `SELECT blob2 AS user, blob1 AS event, blob4 AS kind, blob5 AS detail,
         MIN(timestamp) AS first
       FROM {dataset} WHERE ${since}
       GROUP BY user, event, kind, detail LIMIT 100000`,
    )) as unknown as FirstSeenRowV1[];
    const steps = funnelV1(rows);
    console.log(
      `Accounts created in the last ${days} days: ${steps[0]?.of ?? 0}. Reached within their first 7 days:`,
    );
    console.table(
      steps.map(({ step, reached, of }) => ({
        step,
        reached,
        share: of === 0 ? "-" : `${Math.round((reached / of) * 100)}%`,
      })),
    );
    return;
  }
  if (command === "sql" && rest[0]) {
    console.log(JSON.stringify(await run(rest[0]), null, 2));
    return;
  }
  console.error(
    'usage: bun scripts/analytics.ts funnel|events [--days N] [--profile NAME] | sql "SELECT … FROM {dataset}"',
  );
  process.exit(2);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

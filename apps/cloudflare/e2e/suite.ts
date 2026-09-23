export const publicationSpecFiles = ["plugins-publish.e2e.ts"] as const;

/**
 * What one real publication journey is allowed: two container builds and five
 * scripted Turns, on a two-core runner.
 *
 * Each journey applies it, and the lane that runs them reads it to size its
 * own clock, so the two can never disagree about what a journey may spend.
 */
export const publicationJourneyTimeoutMs = 900_000;

export type E2ESuite = "all" | "core" | "publication";

/** Which corpus this runner owns. Local runs default to every browser spec. */
export function e2eSuite(env: NodeJS.ProcessEnv = process.env): E2ESuite {
  const suite = env.FROCKBOT_E2E_SUITE ?? "all";
  if (suite === "all" || suite === "core" || suite === "publication") {
    return suite;
  }
  throw new Error('FROCKBOT_E2E_SUITE must be "all", "core", or "publication"');
}

/** Playwright's file filters for one runner's corpus. */
export function e2eTestSelection(suite: E2ESuite): {
  testMatch: string | string[];
  testIgnore?: string[];
} {
  const publication = publicationSpecFiles.map((file) => `**/${file}`);
  if (suite === "core") {
    return { testMatch: "**/*.e2e.ts", testIgnore: publication };
  }
  if (suite === "publication") return { testMatch: publication };
  return { testMatch: "**/*.e2e.ts" };
}

/** Only a corpus containing a real publish journey needs the container. */
export function suiteNeedsAppletBuild(suite: E2ESuite): boolean {
  return suite !== "core";
}

/** The decision passed from Playwright to its separate webServer process. */
export function appletBuildRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.FROCKBOT_E2E_APPLET_BUILD !== "0";
}

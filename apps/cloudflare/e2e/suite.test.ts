import { describe, expect, test } from "bun:test";
import {
  appletBuildRequested,
  e2eSuite,
  e2eTestSelection,
  publicationSpecFiles,
  suiteNeedsAppletBuild,
} from "./suite.ts";

describe("the browser suite selected for a runner", () => {
  test("local runs retain every spec and the real publication service", () => {
    expect(e2eSuite({})).toBe("all");
    expect(e2eTestSelection("all")).toEqual({
      testMatch: "**/*.e2e.ts",
    });
    expect(suiteNeedsAppletBuild("all")).toBe(true);
    expect(appletBuildRequested({})).toBe(true);
  });

  test("core runners exclude exactly the publication journeys", () => {
    expect(e2eSuite({ FROCKBOT_E2E_SUITE: "core" })).toBe("core");
    expect(e2eTestSelection("core")).toEqual({
      testMatch: "**/*.e2e.ts",
      testIgnore: publicationSpecFiles.map((file) => `**/${file}`),
    });
    expect(suiteNeedsAppletBuild("core")).toBe(false);
    expect(appletBuildRequested({ FROCKBOT_E2E_APPLET_BUILD: "0" })).toBe(
      false,
    );
  });

  test("the publication runner owns both real build journeys and nothing else", () => {
    expect(e2eSuite({ FROCKBOT_E2E_SUITE: "publication" })).toBe("publication");
    expect(e2eTestSelection("publication")).toEqual({
      testMatch: publicationSpecFiles.map((file) => `**/${file}`),
    });
    expect(suiteNeedsAppletBuild("publication")).toBe(true);
  });

  test("a misspelled suite fails instead of silently dropping coverage", () => {
    expect(() => e2eSuite({ FROCKBOT_E2E_SUITE: "publishing" })).toThrow(
      'FROCKBOT_E2E_SUITE must be "all", "core", or "publication"',
    );
  });
});

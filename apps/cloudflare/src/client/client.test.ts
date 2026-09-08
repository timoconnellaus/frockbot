import { describe, expect, test } from "bun:test";
import { foundationClientContributions } from "./client-contributions.js";
import { foundationClientPlugins } from "./client.js";
import { FOUNDATION_PACKAGES_V1 } from "@frockbot/app/packages";

/**
 * The Package a Contribution specifier names. A first-party Package lives in
 * an `app/` directory (`@frockbot/app/<directory>/<entry>`) or in a module of
 * its own (`@frockbot/computer/<entry>`); the directory is the Package id
 * except where the app cut shortened it.
 */
function packageIdOf(specifier: string): string {
  const segments = specifier.split("/");
  const directory = (segments[1] === "app" ? segments[2] : segments[1]) ?? "";
  return directory === "machine" ? "user-machine" : directory;
}

describe("foundation client composition", () => {
  test("takes one Plugin from each client Contribution the table lists", () => {
    expect(foundationClientPlugins).toHaveLength(
      foundationClientContributions.length,
    );
  });

  test("every client Contribution belongs to a Package this deployment ships", () => {
    const shipped = new Set(FOUNDATION_PACKAGES_V1.map((pkg) => pkg.id));
    for (const contribution of foundationClientContributions) {
      expect(shipped.has(packageIdOf(contribution.specifier))).toBe(true);
    }
  });
});

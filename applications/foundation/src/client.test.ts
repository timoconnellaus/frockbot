import { describe, expect, test } from "bun:test";
import { foundationClientContributions } from "./client-contributions.js";
import { foundationClientPlugins } from "./client.js";
import { FOUNDATION_PACKAGES_V1 } from "./packages.js";

describe("foundation client composition", () => {
  test("takes one Plugin from each client Contribution the table lists", () => {
    expect(foundationClientPlugins).toHaveLength(
      foundationClientContributions.length,
    );
  });

  test("every client Contribution belongs to a Package this deployment ships", () => {
    // A first-party Package is `@frockbot/plugin-<id>` until its module cut
    // lands, and `@frockbot/<id>` after.
    const specifiers = new Set(
      FOUNDATION_PACKAGES_V1.flatMap((pkg) => [
        `@frockbot/plugin-${pkg.id}`,
        `@frockbot/${pkg.id}`,
      ]),
    );
    for (const contribution of foundationClientContributions) {
      // `@frockbot/plugin-shell/client` names the Package before its entry.
      const [scope, name] = contribution.specifier.split("/");
      expect(specifiers.has(`${scope}/${name}`)).toBe(true);
    }
  });
});

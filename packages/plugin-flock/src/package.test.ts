import { expect, test } from "bun:test";
// Package conventions are verified through the production manifest surface.
import { verifyPluginPackage } from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

test("Flock satisfies built-in Package conventions", () => {
  expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
    name: "@frockbot/plugin-flock",
    contributionKinds: ["backend", "client"],
  });
});

import { expect, test } from "bun:test";

import { verifyPluginPackage } from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

test("auth satisfies plugin package conventions", () => {
  expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
    name: "@frockbot/plugin-auth",
    contributionKinds: ["client"],
  });
});

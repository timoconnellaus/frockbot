import { expect, test } from "bun:test";

import { verifyPluginPackage } from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

const styles = await Bun.file(
  new URL("./client/styles.css", import.meta.url),
).text();

test("auth satisfies plugin package conventions", () => {
  expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
    name: "@frockbot/plugin-auth",
    contributionKinds: ["client", "desktop"],
  });
});

test("the sign-in page clears both mobile safe areas", () => {
  expect(styles).toMatch(
    /padding:\s*calc\(32px \+ var\(--frock-safe-top\)\)\s+32px\s+calc\(32px \+ var\(--frock-safe-bottom\)\)/,
  );
});

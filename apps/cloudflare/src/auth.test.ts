import { expect, test } from "bun:test";
import { HOSTED_AUTH_TRUSTED_ORIGINS } from "./auth.ts";

test("hosted auth trusts no legacy local mobile origin", () => {
  expect(HOSTED_AUTH_TRUSTED_ORIGINS).toEqual(["com.frockbot.desktop:/"]);
  expect(HOSTED_AUTH_TRUSTED_ORIGINS).not.toContain("capacitor://localhost");
  expect(HOSTED_AUTH_TRUSTED_ORIGINS).not.toContain("frockbot://localhost");
});

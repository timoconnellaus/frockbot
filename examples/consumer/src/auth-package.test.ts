import { describe, expect, test } from "bun:test";
import type { AuthPackageIdV1 } from "@frockbot/core/contracts";
import { AUTH_PACKAGE_V1 } from "./auth-package.ts";

const frockbotProfiles = [
  "better-auth",
  "access",
] as const satisfies readonly AuthPackageIdV1[];

describe("a consumer auth chooser", () => {
  test("names itself outside FrockBot's profile enum", () => {
    expect(AUTH_PACKAGE_V1.id).toBe("consumer-fixture");
    expect(
      (frockbotProfiles as readonly string[]).includes(AUTH_PACKAGE_V1.id),
    ).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import type { UserApplicationEnv } from "./contracts.js";
import { createUserApplication } from "./user-application.js";

function parseContentSecurityPolicy(
  header: string | null,
): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of (header ?? "").split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

const env = {
  DEPLOYMENT: { userId: "alice", applicationHash: "foundation-v1" },
} as unknown as UserApplicationEnv;

describe("user application security headers", () => {
  test("serves the stylesheet with a policy that allows the embedded fonts", async () => {
    const fetchUserApplication = createUserApplication();

    const response = await fetchUserApplication(
      new Request("https://app.example/app.css"),
      env,
    );

    expect(response.status).toBe(200);
    const policy = parseContentSecurityPolicy(
      response.headers.get("content-security-policy"),
    );
    // The shipped stylesheet embeds Manrope and Archivo Black as data: URIs,
    // so fonts render only when the policy declares font-src for them.
    expect(policy.get("font-src")).toEqual(["'self'", "data:"]);
    expect(policy.get("style-src")).toEqual(["'self'"]);
  });
});

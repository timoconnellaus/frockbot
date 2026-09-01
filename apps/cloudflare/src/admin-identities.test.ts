import { describe, expect, test } from "bun:test";
import { adminEmailsV1, isDeploymentAdminV1 } from "./admin-identities.js";

describe("deployment admin identities", () => {
  test("normalizes the comma-separated email allowlist", () => {
    expect([
      ...adminEmailsV1(" Owner@Example.com,second@example.com, "),
    ]).toEqual(["owner@example.com", "second@example.com"]);
    expect([...adminEmailsV1(undefined)]).toEqual([]);
  });

  test("admits allowlisted emails without exposing the allowlist", () => {
    expect(
      isDeploymentAdminV1(
        {
          id: "user-1",
          email: "OWNER@example.com",
          mode: "better-auth",
        },
        "owner@example.com",
      ),
    ).toBe(true);
    expect(
      isDeploymentAdminV1(
        {
          id: "user-2",
          email: "somebody@example.com",
          mode: "better-auth",
        },
        "owner@example.com",
      ),
    ).toBe(false);
  });

  test("makes the canonical development identity admin", () => {
    expect(
      isDeploymentAdminV1(
        { id: "development", mode: "development" },
        "owner@example.com",
      ),
    ).toBe(true);
  });

  test("makes every development identity admin only when no allowlist is configured", () => {
    expect(
      isDeploymentAdminV1(
        { id: "local-alice", mode: "development" },
        undefined,
      ),
    ).toBe(true);
    expect(
      isDeploymentAdminV1(
        { id: "local-alice", mode: "development" },
        "owner@example.com",
      ),
    ).toBe(false);
  });
});

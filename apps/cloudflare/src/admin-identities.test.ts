import { describe, expect, test } from "bun:test";
import {
  adminEmailsV1,
  adminUserIdsV1,
  isDeploymentAdminV1,
} from "./admin-identities.js";

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
          emailVerified: true,
          mode: "better-auth",
        },
        { emails: "owner@example.com" },
      ),
    ).toBe(true);
    expect(
      isDeploymentAdminV1(
        {
          id: "user-2",
          email: "somebody@example.com",
          emailVerified: true,
          mode: "better-auth",
        },
        { emails: "owner@example.com" },
      ),
    ).toBe(false);
  });

  test("grants admin on an allowlisted email only once it is verified", () => {
    const identity = {
      id: "user-1",
      email: "owner@example.com",
      mode: "better-auth",
    } as const;
    expect(isDeploymentAdminV1(identity, { emails: "owner@example.com" })).toBe(
      false,
    );
    expect(
      isDeploymentAdminV1(
        { ...identity, emailVerified: false },
        { emails: "owner@example.com" },
      ),
    ).toBe(false);
    expect(
      isDeploymentAdminV1(
        { ...identity, emailVerified: true },
        { emails: "owner@example.com" },
      ),
    ).toBe(true);
  });

  test("makes the canonical development identity admin", () => {
    expect(
      isDeploymentAdminV1(
        { id: "development", mode: "development" },
        { emails: "owner@example.com" },
      ),
    ).toBe(true);
  });

  test("makes every development identity admin only when no allowlist is configured", () => {
    expect(
      isDeploymentAdminV1({ id: "local-alice", mode: "development" }, {}),
    ).toBe(true);
    expect(
      isDeploymentAdminV1(
        { id: "local-alice", mode: "development" },
        { emails: "owner@example.com" },
      ),
    ).toBe(false);
  });

  test("reads the User id allowlist exactly, trimmed", () => {
    expect([...adminUserIdsV1(" discord-Abc , user-2,, ")]).toEqual([
      "discord-Abc",
      "user-2",
    ]);
    expect([...adminUserIdsV1(undefined)]).toEqual([]);
  });

  test("grants admin by User id to a signed-in User with no email", () => {
    const admins = { userIds: "discord-abc,user-2" };
    expect(
      isDeploymentAdminV1({ id: "discord-abc", mode: "better-auth" }, admins),
    ).toBe(true);
    expect(
      isDeploymentAdminV1({ id: "discord-ABC", mode: "better-auth" }, admins),
    ).toBe(false);
    expect(
      isDeploymentAdminV1({ id: "user-3", mode: "better-auth" }, admins),
    ).toBe(false);
  });

  test("never grants admin by User id to a development identity somebody named", () => {
    expect(
      isDeploymentAdminV1(
        { id: "user-2", mode: "development" },
        { userIds: "user-2" },
      ),
    ).toBe(false);
    expect(
      isDeploymentAdminV1(
        { id: "local-alice", mode: "development" },
        { userIds: "user-2" },
      ),
    ).toBe(false);
  });
});

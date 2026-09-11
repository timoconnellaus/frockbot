import { describe, expect, test } from "bun:test";
import {
  decodeAdminUserListViewV1,
  decodeDeploymentPolicyV1,
  decodeSetSignupsCommandV1,
  decodeSetSignupsRequestV1,
  decodeSetUserFeaturesCommandV1,
  decodeUserFeaturesV1,
  defaultUserFeaturesV1,
} from "./shared.js";

const policy = {
  schemaVersion: 1,
  revision: 2,
  signups: { open: false },
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: "owner@example.com",
} as const;

describe("deployment policy codecs", () => {
  test("decode the exact policy and signup command shapes", () => {
    expect(decodeDeploymentPolicyV1(policy)).toEqual(policy);
    expect(
      decodeSetSignupsCommandV1({
        schemaVersion: 1,
        type: "deployment/set-signups",
        open: true,
        revision: 2,
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "deployment/set-signups",
      open: true,
      revision: 2,
    });
    expect(
      decodeSetSignupsRequestV1({
        schemaVersion: 1,
        command: {
          schemaVersion: 1,
          type: "deployment/set-signups",
          open: true,
          revision: 2,
        },
        updatedBy: "owner-id",
      }),
    ).toMatchObject({ updatedBy: "owner-id", command: { open: true } });
  });

  test("rejects unknown fields at every seam", () => {
    expect(() => decodeDeploymentPolicyV1({ ...policy, extra: true })).toThrow(
      "unknown fields",
    );
    expect(() =>
      decodeDeploymentPolicyV1({
        ...policy,
        signups: { open: false, extra: true },
      }),
    ).toThrow("unknown fields");
    expect(() =>
      decodeSetSignupsCommandV1({
        schemaVersion: 1,
        type: "deployment/set-signups",
        open: true,
        revision: 2,
        expectedRevision: 2,
      }),
    ).toThrow("unknown fields");
  });
});

describe("account feature codecs", () => {
  const features = {
    schemaVersion: 1,
    applets: true,
    updatedAt: "2026-09-11T00:00:00.000Z",
    updatedBy: "owner-id",
  } as const;

  test("decode the exact features and command shapes", () => {
    expect(decodeUserFeaturesV1(features)).toEqual(features);
    expect(
      decodeSetUserFeaturesCommandV1({
        schemaVersion: 1,
        type: "user/set-features",
        applets: false,
      }),
    ).toEqual({ schemaVersion: 1, type: "user/set-features", applets: false });
    expect(
      decodeAdminUserListViewV1({
        schemaVersion: 1,
        users: [
          { userId: "development", features },
          {
            userId: "u1",
            email: "u1@example.com",
            name: "One",
            features,
          },
        ],
      }).users.map((user) => user.userId),
    ).toEqual(["development", "u1"]);
  });

  test("an identity store row with blank identifiers keeps its account", () => {
    const [account] = decodeAdminUserListViewV1({
      schemaVersion: 1,
      users: [{ userId: "u1", email: "", name: "", features }],
    }).users;
    expect(account).toEqual({ userId: "u1", features });
  });

  test("an over-long display name is clamped, not refused", () => {
    const [account] = decodeAdminUserListViewV1({
      schemaVersion: 1,
      users: [
        {
          userId: "u1",
          email: "u1@example.com",
          name: "x".repeat(600),
          features,
        },
      ],
    }).users;
    expect(account).toEqual({
      userId: "u1",
      email: "u1@example.com",
      name: "x".repeat(512),
      features,
    });
  });

  test("the default is off and rejects unknown fields", () => {
    expect(defaultUserFeaturesV1().applets).toBe(false);
    expect(() => decodeUserFeaturesV1({ ...features, beta: true })).toThrow(
      "unknown fields",
    );
    expect(() =>
      decodeSetUserFeaturesCommandV1({
        schemaVersion: 1,
        type: "user/set-features",
        applets: "yes",
      }),
    ).toThrow("invalid");
    expect(() =>
      decodeAdminUserListViewV1({
        schemaVersion: 1,
        users: [{ userId: "u1", features, role: "admin" }],
      }),
    ).toThrow("unknown fields");
  });
});

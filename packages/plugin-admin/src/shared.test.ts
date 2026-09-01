import { describe, expect, test } from "bun:test";
import {
  decodeDeploymentPolicyV1,
  decodeSetSignupsCommandV1,
  decodeSetSignupsRequestV1,
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

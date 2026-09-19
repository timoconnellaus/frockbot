import { describe, expect, test } from "bun:test";
import {
  ADMISSION_REFUSAL_COPY_V1,
  accessEmailV1,
  decodeAccountAccessV1,
  decodeAccountAccessViewV1,
  decodeAccountAdmissionDecisionV1,
  decodeAdminUserFeaturesV1,
  decodeAdminUserListViewV1,
  decodeAdminWriteResultV1,
  decodeAdmissionIdentityV1,
  decodeDeploymentPolicyV1,
  decodeIdentityCreationRequestV1,
  decodeInviteEmailCommandV1,
  decodeSetAccountAccessCommandV1,
  decodeSetAdmissionModeCommandV1,
  decodeSetAdmissionModeRequestV1,
  decodeSetUserFeaturesCommandV1,
  decodeUserFeaturesV1,
  defaultUserFeaturesV1,
  isAccountAccessUnavailable,
  isUserFeaturesUnavailable,
} from "./shared.js";

const policy = {
  schemaVersion: 1,
  revision: 2,
  admission: { mode: "invite-only" },
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: "owner@example.com",
} as const;

const access = {
  schemaVersion: 1,
  userId: "u1",
  state: "paused",
  revision: 3,
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: "owner-id",
} as const;

describe("deployment policy codecs", () => {
  test("decode the exact policy and admission mode command shapes", () => {
    expect(decodeDeploymentPolicyV1(policy)).toEqual(policy);
    const command = {
      schemaVersion: 1,
      type: "deployment/set-admission-mode",
      mode: "open",
      revision: 2,
    } as const;
    expect(decodeSetAdmissionModeCommandV1(command)).toEqual(command);
    expect(
      decodeSetAdmissionModeRequestV1({
        schemaVersion: 1,
        command,
        updatedBy: "owner-id",
      }),
    ).toMatchObject({ updatedBy: "owner-id", command: { mode: "open" } });
  });

  test("the retired signups shape does not decode anywhere", () => {
    expect(() =>
      decodeDeploymentPolicyV1({
        schemaVersion: 1,
        revision: 2,
        signups: { open: true },
        updatedAt: "2026-09-01T00:00:00.000Z",
        updatedBy: "owner-id",
      }),
    ).toThrow("unknown fields");
    expect(() =>
      decodeSetAdmissionModeCommandV1({
        schemaVersion: 1,
        type: "deployment/set-signups",
        open: true,
        revision: 2,
      }),
    ).toThrow("unknown fields");
  });

  test("rejects unknown fields and unknown modes at every seam", () => {
    expect(() => decodeDeploymentPolicyV1({ ...policy, extra: true })).toThrow(
      "unknown fields",
    );
    expect(() =>
      decodeDeploymentPolicyV1({
        ...policy,
        admission: { mode: "closed", extra: true },
      }),
    ).toThrow("unknown fields");
    expect(() =>
      decodeDeploymentPolicyV1({ ...policy, admission: { mode: "waitlist" } }),
    ).toThrow("invalid");
    expect(() =>
      decodeSetAdmissionModeCommandV1({
        schemaVersion: 1,
        type: "deployment/set-admission-mode",
        mode: "open",
        revision: 2,
        expectedRevision: 2,
      }),
    ).toThrow("unknown fields");
  });
});

describe("administrative write result codec", () => {
  test("decodes the applied value with the caller's value decoder", () => {
    expect(
      decodeAdminWriteResultV1(
        { status: "applied", value: { revision: 4 } },
        (value) => {
          if (!value || typeof value !== "object") throw new Error("bad value");
          return (value as { revision: number }).revision;
        },
        "policy answer",
      ),
    ).toEqual({ status: "applied", value: 4 });
  });

  test("keeps a conflict as a union value with its current revision", () => {
    expect(
      decodeAdminWriteResultV1(
        { status: "conflict", currentRevision: 7 },
        () => "unused",
        "policy answer",
      ),
    ).toEqual({ status: "conflict", currentRevision: 7 });
  });

  test("rejects malformed write answers with the seam label", () => {
    expect(() =>
      decodeAdminWriteResultV1(
        { status: "conflict", currentRevision: "7" },
        () => "unused",
        "policy answer",
      ),
    ).toThrow("policy answer.currentRevision is invalid");
    expect(() =>
      decodeAdminWriteResultV1(
        { status: "unknown" },
        () => "unused",
        "policy answer",
      ),
    ).toThrow("policy answer.status is invalid");
  });
});

describe("account access codecs", () => {
  test("decode the exact access record, view and command", () => {
    expect(decodeAccountAccessV1(access)).toEqual(access);
    expect(
      decodeAccountAccessViewV1({ schemaVersion: 1, userId: "u1", access }),
    ).toEqual({ schemaVersion: 1, userId: "u1", access });
    expect(
      decodeAccountAccessViewV1({
        schemaVersion: 1,
        userId: "u1",
        access: null,
      }),
    ).toEqual({ schemaVersion: 1, userId: "u1", access: null });
    expect(
      decodeSetAccountAccessCommandV1({
        schemaVersion: 1,
        type: "account/set-access",
        state: "blocked",
        revision: 0,
      }),
    ).toMatchObject({ state: "blocked", revision: 0 });
  });

  test("refuses unknown states, zero revisions, strays and mismatched views", () => {
    expect(() => decodeAccountAccessV1({ ...access, state: "trial" })).toThrow(
      "invalid",
    );
    expect(() => decodeAccountAccessV1({ ...access, revision: 0 })).toThrow(
      "invalid",
    );
    expect(() => decodeAccountAccessV1({ ...access, credit: 5 })).toThrow(
      "unknown fields",
    );
    expect(() =>
      decodeAccountAccessViewV1({ schemaVersion: 1, userId: "u2", access }),
    ).toThrow("another account");
  });

  test("an invitation names one normalized address and nothing else", () => {
    expect(
      decodeInviteEmailCommandV1({
        schemaVersion: 1,
        type: "access/invite-email",
        email: "  Person@Example.COM",
      }).email,
    ).toBe("person@example.com");
    for (const email of ["", "person", "person@", "a b@example.com"]) {
      expect(() =>
        decodeInviteEmailCommandV1({
          schemaVersion: 1,
          type: "access/invite-email",
          email,
        }),
      ).toThrow("invalid");
    }
    expect(accessEmailV1("nobody")).toBeUndefined();
    expect(accessEmailV1(undefined)).toBeUndefined();
  });

  test("an admission identity must say whether its email was verified", () => {
    expect(
      decodeAdmissionIdentityV1({
        schemaVersion: 1,
        userId: "u1",
        email: "U1@example.com",
        emailVerified: true,
        isAdmin: false,
      }),
    ).toEqual({
      schemaVersion: 1,
      userId: "u1",
      email: "u1@example.com",
      emailVerified: true,
      isAdmin: false,
    });
    expect(() =>
      decodeAdmissionIdentityV1({
        schemaVersion: 1,
        userId: "u1",
        isAdmin: false,
      }),
    ).toThrow("unknown fields");
    expect(() =>
      decodeIdentityCreationRequestV1({
        schemaVersion: 1,
        email: "u1@example.com",
        emailVerified: "yes",
        isAdmin: false,
      }),
    ).toThrow("invalid");
  });

  test("a decision is either an admission with its basis or a refusal with a known reason", () => {
    expect(
      decodeAccountAdmissionDecisionV1({
        schemaVersion: 1,
        admitted: true,
        basis: "invitation",
      }),
    ).toEqual({ schemaVersion: 1, admitted: true, basis: "invitation" });
    for (const reason of Object.keys(ADMISSION_REFUSAL_COPY_V1)) {
      expect(
        decodeAccountAdmissionDecisionV1({
          schemaVersion: 1,
          admitted: false,
          reason,
        }),
      ).toMatchObject({ admitted: false, reason });
    }
    expect(() =>
      decodeAccountAdmissionDecisionV1({
        schemaVersion: 1,
        admitted: false,
        reason: "signups-closed",
      }),
    ).toThrow("invalid");
    expect(() =>
      decodeAccountAdmissionDecisionV1({
        schemaVersion: 1,
        admitted: true,
        basis: "open",
        reason: "account-paused",
      }),
    ).toThrow("unknown fields");
  });

  test("no refusal copy claims an invitation exists", () => {
    for (const copy of Object.values(ADMISSION_REFUSAL_COPY_V1)) {
      expect(`${copy.title} ${copy.detail}`).not.toMatch(/invited|invitation/i);
    }
  });
});

describe("account feature codecs", () => {
  const features = {
    schemaVersion: 1,
    applets: true,
    pluginAuthoring: false,
    plugins: [] as string[],
    updatedAt: "2026-09-11T00:00:00.000Z",
    updatedBy: "owner-id",
  } as const;

  const billing = {
    includedMicros: 0,
    purchasedMicros: 0,
    complimentaryMicros: 2_500_000,
    reservedMicros: 0,
    subscribed: false,
    canSpend: true,
    suspended: false,
  } as const;

  /** An account the authority holds no access record for. */
  const noAccess = { schemaVersion: 1, userId: "u1", access: null } as const;

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
        gatedPlugins: [{ pluginId: "gated", displayName: "Gated" }],
        users: [
          { userId: "development", features, billing, access: noAccess },
          {
            userId: "u1",
            email: "u1@example.com",
            name: "One",
            features,
            billing,
            access: noAccess,
          },
        ],
      }).users.map((user) => user.userId),
    ).toEqual(["development", "u1"]);
  });

  test("an identity store row with blank identifiers keeps its account", () => {
    const [account] = decodeAdminUserListViewV1({
      schemaVersion: 1,
      gatedPlugins: [],
      users: [
        {
          userId: "u1",
          email: "",
          name: "",
          features,
          billing,
          access: noAccess,
        },
      ],
    }).users;
    expect(account).toEqual({
      userId: "u1",
      features,
      billing,
      access: noAccess,
    });
  });

  test("an over-long display name is clamped, not refused", () => {
    const [account] = decodeAdminUserListViewV1({
      schemaVersion: 1,
      gatedPlugins: [],
      users: [
        {
          userId: "u1",
          email: "u1@example.com",
          name: "x".repeat(600),
          features,
          billing,
          access: noAccess,
        },
      ],
    }).users;
    expect(account).toEqual({
      userId: "u1",
      email: "u1@example.com",
      name: "x".repeat(512),
      features,
      billing,
      access: noAccess,
    });
  });

  test("an account whose features could not be read is carried, not defaulted", () => {
    const [readable, unreadable] = decodeAdminUserListViewV1({
      schemaVersion: 1,
      gatedPlugins: [],
      users: [
        { userId: "u1", features, billing, access: noAccess },
        {
          userId: "u2",
          features: { unavailable: true },
          billing: { unavailable: true },
          access: { unavailable: true },
        },
      ],
    }).users;
    expect(readable?.features).toEqual(features);
    expect(isAccountAccessUnavailable(unreadable!.access)).toBe(true);
    expect(isAccountAccessUnavailable(readable!.access)).toBe(false);
    expect(unreadable?.features).toEqual({ unavailable: true });
    expect(isUserFeaturesUnavailable(unreadable!.features)).toBe(true);
    expect(isUserFeaturesUnavailable(readable!.features)).toBe(false);
    expect(decodeAdminUserFeaturesV1({ unavailable: true })).toEqual({
      unavailable: true,
    });
  });

  test("the unavailable marker is exact: no value beside it, no false", () => {
    expect(() => decodeAdminUserFeaturesV1({ unavailable: false })).toThrow(
      "invalid",
    );
    expect(() =>
      decodeAdminUserFeaturesV1({ unavailable: true, applets: false }),
    ).toThrow("unknown fields");
    expect(() =>
      decodeAdminUserFeaturesV1({ ...features, unavailable: true }),
    ).toThrow("unknown fields");
    expect(() => decodeAdminUserFeaturesV1({})).toThrow("unknown fields");
    expect(() =>
      decodeAdminUserListViewV1({
        schemaVersion: 1,
        gatedPlugins: [],
        users: [{ userId: "u1", features: { unavailable: "yes" } }],
      }),
    ).toThrow("invalid");
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
        gatedPlugins: [],
        users: [{ userId: "u1", features, role: "admin" }],
      }),
    ).toThrow("unknown fields");
  });
});

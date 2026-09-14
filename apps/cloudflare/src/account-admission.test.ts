import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_ACCESS_STATES_V1,
  ADMISSION_MODES_V1,
  ADMISSION_REFUSAL_COPY_V1,
  type AccountAccessStateV1,
  type AccountAccessV1,
  type AdmissionModeV1,
  type EmailInvitationV1,
} from "@frockbot/app/admin/shared";
import {
  admissionRefusedResponse,
  admissionUnavailableResponse,
  evaluateAdmissionV1,
  identityMayBeCreatedV1,
} from "./account-admission.ts";

const identity = {
  schemaVersion: 1 as const,
  userId: "u1",
  email: "u1@example.com",
  emailVerified: true,
  isAdmin: false,
};

function access(state: AccountAccessStateV1): AccountAccessV1 {
  return {
    schemaVersion: 1,
    userId: "u1",
    state,
    revision: 4,
    updatedAt: "2026-09-14T00:00:00.000Z",
    updatedBy: "owner-id",
  };
}

const invitation: EmailInvitationV1 = {
  schemaVersion: 1,
  email: "u1@example.com",
  invitedAt: "2026-09-14T00:00:00.000Z",
  invitedBy: "owner-id",
};

type Outcome = string;

/** `admitted:<basis>[+activate][+redeem]` or `refused:<reason>`. */
function outcome(
  mode: AdmissionModeV1,
  state: AccountAccessStateV1 | null,
  invited: boolean,
  isAdmin = false,
): Outcome {
  const result = evaluateAdmissionV1({
    mode,
    identity: { ...identity, isAdmin },
    access: state ? access(state) : null,
    invitation: invited ? invitation : null,
  });
  if (!result.decision.admitted) return `refused:${result.decision.reason}`;
  return [
    `admitted:${result.decision.basis}`,
    result.activate ? "+activate" : "",
    result.redeemInvitation ? "+redeem" : "",
  ].join("");
}

describe("the beta-access rule", () => {
  test("the whole lifecycle matrix, for every mode", () => {
    const expected: Record<
      AdmissionModeV1,
      Record<AccountAccessStateV1 | "none", [Outcome, Outcome]>
    > = {
      // [no invitation, verified invitation]
      closed: {
        none: ["refused:admission-closed", "refused:admission-closed"],
        invited: ["refused:admission-closed", "refused:admission-closed"],
        active: ["admitted:active", "admitted:active"],
        paused: ["refused:account-paused", "refused:account-paused"],
        ended: ["refused:account-ended", "refused:account-ended"],
        blocked: ["refused:account-blocked", "refused:account-blocked"],
      },
      "invite-only": {
        none: [
          "refused:invitation-required",
          "admitted:invitation+activate+redeem",
        ],
        invited: [
          "admitted:invitation+activate",
          "admitted:invitation+activate+redeem",
        ],
        active: ["admitted:active", "admitted:active"],
        paused: ["refused:account-paused", "refused:account-paused"],
        ended: ["refused:account-ended", "refused:account-ended"],
        blocked: ["refused:account-blocked", "refused:account-blocked"],
      },
      open: {
        none: ["admitted:open+activate", "admitted:invitation+activate+redeem"],
        invited: [
          "admitted:invitation+activate",
          "admitted:invitation+activate+redeem",
        ],
        active: ["admitted:active", "admitted:active"],
        paused: ["refused:account-paused", "refused:account-paused"],
        ended: ["refused:account-ended", "refused:account-ended"],
        blocked: ["refused:account-blocked", "refused:account-blocked"],
      },
    };
    for (const mode of ADMISSION_MODES_V1) {
      for (const state of [null, ...ACCOUNT_ACCESS_STATES_V1]) {
        for (const invited of [false, true]) {
          expect({
            mode,
            state,
            invited,
            got: outcome(mode, state, invited),
          }).toEqual({
            mode,
            state,
            invited,
            got: expected[mode][state ?? "none"][invited ? 1 : 0],
          });
        }
      }
    }
  });

  test("an admin is admitted in every mode and every state, and writes nothing", () => {
    for (const mode of ADMISSION_MODES_V1) {
      for (const state of [null, ...ACCOUNT_ACCESS_STATES_V1]) {
        expect(outcome(mode, state, true, true)).toBe("admitted:admin");
      }
    }
  });

  test("an identity may be written only where it could later be admitted", () => {
    const request = {
      schemaVersion: 1 as const,
      email: "u1@example.com",
      emailVerified: true,
      isAdmin: false,
    };
    expect(identityMayBeCreatedV1("closed", request, invitation)).toBe(false);
    expect(identityMayBeCreatedV1("invite-only", request, null)).toBe(false);
    expect(identityMayBeCreatedV1("invite-only", request, invitation)).toBe(
      true,
    );
    expect(
      identityMayBeCreatedV1(
        "invite-only",
        { ...request, emailVerified: false },
        invitation,
      ),
    ).toBe(false);
    expect(identityMayBeCreatedV1("open", request, null)).toBe(true);
    expect(
      identityMayBeCreatedV1("closed", { ...request, isAdmin: true }, null),
    ).toBe(true);
  });
});

describe("refusal responses", () => {
  test("JSON names the reason and carries its copy", async () => {
    for (const reason of Object.keys(
      ADMISSION_REFUSAL_COPY_V1,
    ) as (keyof typeof ADMISSION_REFUSAL_COPY_V1)[]) {
      const response = admissionRefusedResponse(reason, false);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json<unknown>()).toEqual({
        error: ADMISSION_REFUSAL_COPY_V1[reason].title,
        code: "account-access-refused",
        reason,
      });
    }
  });

  test("the page says what is true and offers sign-out", async () => {
    const response = admissionRefusedResponse("account-paused", true);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    expect(page).toContain("Your FrockBot access is paused.");
    expect(page).toContain('href="/sign-out"');
    expect(page).not.toMatch(/invit/i);
  });

  test("an unreachable authority is a retryable 503, never a sign-in problem", async () => {
    const response = admissionUnavailableResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toMatchObject({
      code: "account-access-unavailable",
    });
  });
});

import {
  ADMISSION_REFUSAL_COPY_V1,
  type AccountAccessV1,
  type AccountAdmissionDecisionV1,
  type AdmissionIdentityV1,
  type AdmissionModeV1,
  type AdmissionRefusalReasonV1,
  type EmailInvitationV1,
  type IdentityCreationRequestV1,
} from "@frockbot/app/admin/shared";

export interface AdmissionEvaluationV1 {
  decision: AccountAdmissionDecisionV1;
  /** Whether this admission moves the account to `active`. */
  activate: boolean;
  /** Whether the email invitation that justified it is spent. */
  redeemInvitation: boolean;
}

function refused(reason: AdmissionRefusalReasonV1): AdmissionEvaluationV1 {
  return {
    decision: { schemaVersion: 1, admitted: false, reason },
    activate: false,
    redeemInvitation: false,
  };
}

/**
 * The beta-access rule, with no I/O so every row of it is testable.
 *
 * `invitation` is the invitation for this identity's *verified* email, or
 * null; the caller never passes one for an unverified address. The order is
 * the policy: an admin is always admitted, an account's explicit record beats
 * the deployment mode, and the mode only decides what happens to an account
 * that has no record.
 */
export function evaluateAdmissionV1(input: {
  mode: AdmissionModeV1;
  identity: AdmissionIdentityV1;
  access: AccountAccessV1 | null;
  invitation: EmailInvitationV1 | null;
}): AdmissionEvaluationV1 {
  const { mode, identity, access, invitation } = input;
  if (identity.isAdmin) {
    return {
      decision: { schemaVersion: 1, admitted: true, basis: "admin" },
      activate: false,
      redeemInvitation: false,
    };
  }
  if (access) {
    switch (access.state) {
      case "active":
        return {
          decision: { schemaVersion: 1, admitted: true, basis: "active" },
          activate: false,
          redeemInvitation: false,
        };
      case "paused":
        return refused("account-paused");
      case "ended":
        return refused("account-ended");
      case "blocked":
        return refused("account-blocked");
      case "invited":
        // Closing admission is exactly "admit nobody new", and an invited
        // account has not been admitted yet.
        if (mode === "closed") return refused("admission-closed");
        return {
          decision: { schemaVersion: 1, admitted: true, basis: "invitation" },
          activate: true,
          redeemInvitation: invitation !== null,
        };
    }
  }
  if (invitation) {
    if (mode === "closed") return refused("admission-closed");
    return {
      decision: { schemaVersion: 1, admitted: true, basis: "invitation" },
      activate: true,
      redeemInvitation: true,
    };
  }
  if (mode === "open") {
    return {
      decision: { schemaVersion: 1, admitted: true, basis: "open" },
      activate: true,
      redeemInvitation: false,
    };
  }
  return refused(
    mode === "invite-only" ? "invitation-required" : "admission-closed",
  );
}

/**
 * Whether the identity provider may write a brand-new identity. It runs
 * before there is a User id, so only the mode, the admin allowlist and a
 * verified invitation can answer it; an identity that is written still has to
 * pass `evaluateAdmissionV1` on every request.
 */
export function identityMayBeCreatedV1(
  mode: AdmissionModeV1,
  request: IdentityCreationRequestV1,
  invitation: EmailInvitationV1 | null,
): boolean {
  if (request.isAdmin || mode === "open") return true;
  return mode === "invite-only" && request.emailVerified && invitation !== null;
}

export const ACCOUNT_ADMISSION_UNAVAILABLE_MESSAGE =
  "FrockBot couldn't check this account's access. Try again in a moment.";

const NO_STORE = { "cache-control": "no-store" } as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A refusal a client can act on: the copy to show and the reason it is true.
 * Only the browser's document request gets a page; everything else is JSON.
 */
export function admissionRefusedResponse(
  reason: AdmissionRefusalReasonV1,
  page: boolean,
): Response {
  const copy = ADMISSION_REFUSAL_COPY_V1[reason];
  if (!page) {
    return Response.json(
      { error: copy.title, code: "account-access-refused", reason },
      { status: 403, headers: NO_STORE },
    );
  }
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FrockBot</title>
</head>
<body>
  <main data-reason="${escapeHtml(reason)}">
    <p>FrockBot</p>
    <h1>${escapeHtml(copy.title)}</h1>
    <p>${escapeHtml(copy.detail)}</p>
    <a href="/sign-out">Sign out</a>
  </main>
</body>
</html>`,
    {
      status: 403,
      headers: {
        ...NO_STORE,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * The authority could not answer. Never a 401: the session is fine, and a
 * client that signed out on this would throw away a valid sign-in.
 */
export function admissionUnavailableResponse(): Response {
  return Response.json(
    {
      error: ACCOUNT_ADMISSION_UNAVAILABLE_MESSAGE,
      code: "account-access-unavailable",
    },
    { status: 503, headers: { ...NO_STORE, "retry-after": "5" } },
  );
}

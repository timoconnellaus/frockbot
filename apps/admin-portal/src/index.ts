// The admin portal: the hosted deployment's administrative surface.
//
// It is a Worker of its own, on its own hostname, behind its own Cloudflare
// Access application, and it holds no state. Everything it shows and everything
// it writes crosses the `APP` service binding into the app Worker's
// `AdminEntrypoint`, which no HTTP route answers for (ADR 0028). The product
// itself has no administrative surface at all.
//
// Two gates, both here: Access authenticates the person (verified against the
// team's own keys, not taken on trust from a header), and
// `FROCKBOT_ADMIN_EMAILS` — the same secret the app reads for who bypasses
// admission and opens the debug surface — says whether that person administers.

import {
  GRANT_USER_CREDIT_MAXIMUM_CENTS,
  type AccountAccessStateV1,
  type AdmissionModeV1,
  type SetUserFeaturesCommandV1,
} from "@frockbot/app/admin/shared";
import {
  accessTokenFromRequestV1,
  isPortalAdminV1,
  verifyAccessTokenV1,
  type AccessRefusalReasonV1,
} from "./access.js";
import { administrationV1, type AdminAppBindingV1 } from "./app.js";
import { renderAdminPageV1, renderRefusalV1, type NoticeV1 } from "./render.js";

export interface Env {
  /** The app Worker's `AdminEntrypoint`, the only thing this Worker calls. */
  APP: AdminAppBindingV1;
  /** The Zero Trust team domain, e.g. `frockbot.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** This Access application's audience tag. */
  ACCESS_AUD?: string;
  /** Who may administer: a comma-separated list of verified addresses. */
  FROCKBOT_ADMIN_EMAILS?: string;
}

const SECURITY_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

/**
 * No script, no image, no font, no network: this page is text and forms. The
 * stylesheet carries the response's nonce, and `style-src` names only that, so
 * markup injected into a page cannot style it either.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    `style-src 'nonce-${nonce}'`,
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function html(body: string, nonce: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": contentSecurityPolicy(nonce),
      // Account emails, access states and balances: never a cached copy in a
      // shared browser or a proxy.
      "cache-control": "no-store",
    },
  });
}

function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SECURITY_HEADERS, location, "cache-control": "no-store" },
  });
}

const ACCESS_REFUSAL_DETAIL: Readonly<Record<AccessRefusalReasonV1, string>> = {
  "no-token": "This request carried no Cloudflare Access assertion.",
  malformed: "The Cloudflare Access assertion could not be read.",
  "unsupported-algorithm":
    "The Cloudflare Access assertion is not signed the way Access signs.",
  "unknown-key": "The Cloudflare Access assertion names an unknown key.",
  "bad-signature": "The Cloudflare Access assertion's signature is not valid.",
  "wrong-audience":
    "The Cloudflare Access assertion was issued for another application.",
  "wrong-issuer": "The Cloudflare Access assertion was issued by another team.",
  expired: "Your Cloudflare Access session has expired. Open the page again.",
  "not-yet-valid": "The Cloudflare Access assertion is not valid yet.",
  "no-email": "Cloudflare Access did not say which address signed in.",
  "keys-unavailable":
    "Cloudflare Access's signing keys could not be read just now. Try again.",
};

const NOTICES: Readonly<Record<string, NoticeV1>> = {
  mode: { tone: "done", message: "The admission mode is saved." },
  invited: {
    tone: "done",
    message:
      "The invitation is recorded. Only a sign-in whose provider verified that address can redeem it.",
  },
  access: { tone: "done", message: "That account's access is saved." },
  features: { tone: "done", message: "That account's settings are saved." },
  credit: { tone: "done", message: "The credit is added." },
};

function dollarsToCents(value: string): number {
  const dollars = Number(value.trim());
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new Error("The amount must be more than nothing.");
  }
  const cents = Math.round(dollars * 100);
  if (cents > GRANT_USER_CREDIT_MAXIMUM_CENTS) {
    throw new Error(
      `A single grant is capped at US$${(
        GRANT_USER_CREDIT_MAXIMUM_CENTS / 100
      ).toFixed(2)}.`,
    );
  }
  return cents;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`This form arrived without its ${name}.`);
  }
  return value.trim();
}

function revisionField(form: FormData): number {
  const revision = Number(field(form, "revision"));
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("This form arrived without a usable revision.");
  }
  return revision;
}

const STALE_MODE: NoticeV1 = {
  tone: "stale",
  message:
    "The admission mode changed underneath you, so nothing was written. This page is the current state — make the change again if you still want it.",
};

const STALE_ACCESS: NoticeV1 = {
  tone: "stale",
  message:
    "That account's access changed underneath you, so nothing was written. This page is the current state — make the change again if you still want it.",
};

/**
 * One form, applied.
 *
 * A write that lands answers with a redirect, so a reload re-reads rather than
 * writing again. A write that is refused or that lost a compare-and-swap
 * answers with the page itself and says so, because the reason is the point.
 */
async function apply(
  form: FormData,
  admin: ReturnType<typeof administrationV1>,
  by: string,
): Promise<{ notice: NoticeV1 } | { redirect: string }> {
  switch (form.get("action")) {
    case "admission-mode": {
      const written = await admin.setAdmissionMode(
        {
          schemaVersion: 1,
          type: "deployment/set-admission-mode",
          mode: field(form, "mode") as AdmissionModeV1,
          revision: revisionField(form),
        },
        by,
      );
      return written.status === "applied"
        ? { redirect: "/?notice=mode" }
        : { notice: STALE_MODE };
    }
    case "invite-email": {
      await admin.inviteEmail(field(form, "email"), by);
      return { redirect: "/?notice=invited" };
    }
    case "account-access": {
      const written = await admin.setAccountAccess(
        field(form, "userId"),
        {
          schemaVersion: 1,
          type: "account/set-access",
          state: field(form, "state") as AccountAccessStateV1,
          revision: revisionField(form),
        },
        by,
      );
      return written.status === "applied"
        ? { redirect: "/?notice=access" }
        : { notice: STALE_ACCESS };
    }
    case "account-features": {
      // An unchecked checkbox sends nothing, which is what off is. The whole
      // record is written every time, so the form is the account's new state.
      const command: SetUserFeaturesCommandV1 = {
        schemaVersion: 1,
        type: "user/set-features",
        applets: form.get("applets") !== null,
        pluginAuthoring: form.get("pluginAuthoring") !== null,
        plugins: form
          .getAll("plugin")
          .filter((value): value is string => typeof value === "string"),
      };
      await admin.setAccountFeatures(field(form, "userId"), command, by);
      return { redirect: "/?notice=features" };
    }
    case "grant-credit": {
      await admin.grantCredit(
        field(form, "userId"),
        {
          schemaVersion: 1,
          type: "user/grant-credit",
          id: field(form, "grantId"),
          cents: dollarsToCents(field(form, "dollars")),
          reason: field(form, "reason"),
        },
        by,
      );
      return { redirect: "/?notice=credit" };
    }
    default:
      throw new Error("That form is not one this page offers.");
  }
}

async function renderPage(
  env: Env,
  email: string,
  notice: NoticeV1 | undefined,
  status = 200,
): Promise<Response> {
  const admin = administrationV1(env.APP);
  const nonce = crypto.randomUUID();
  const [policy, accounts] = await Promise.all([
    admin.readPolicy(),
    admin.listAccounts(),
  ]);
  return html(
    renderAdminPageV1({
      email,
      policy,
      accounts,
      ...(notice ? { notice } : {}),
      grantId: crypto.randomUUID(),
      nonce,
    }),
    nonce,
    status,
  );
}

function refusal(title: string, detail: string, status: number): Response {
  const nonce = crypto.randomUUID();
  return html(renderRefusalV1({ nonce, title, detail }), nonce, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      // Unconfigured, this Worker cannot tell an administrator from anyone
      // else, so it administers for nobody.
      return refusal(
        "This portal is not configured",
        "ACCESS_TEAM_DOMAIN and ACCESS_AUD name the Cloudflare Access application that guards this hostname. Until both are set, nothing here can be read or changed.",
        503,
      );
    }

    const token = accessTokenFromRequestV1(request);
    if (!token) {
      return refusal("Not signed in", ACCESS_REFUSAL_DETAIL["no-token"], 401);
    }
    const verified = await verifyAccessTokenV1(token, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
    });
    if (!verified.ok) {
      return refusal(
        "Not signed in",
        ACCESS_REFUSAL_DETAIL[verified.reason],
        verified.reason === "keys-unavailable" ? 503 : 401,
      );
    }
    const { email } = verified.identity;
    if (!isPortalAdminV1(email, env.FROCKBOT_ADMIN_EMAILS)) {
      return refusal(
        "Not an administrator",
        `${email} is signed in, but this deployment's administrators are named by its own secret, and this address is not one of them.`,
        403,
      );
    }

    if (url.pathname !== "/") {
      return refusal(
        "Nothing here",
        "Administration is one page, at the root of this hostname.",
        404,
      );
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const requested = url.searchParams.get("notice");
      return renderPage(env, email, requested ? NOTICES[requested] : undefined);
    }

    if (request.method !== "POST") {
      return refusal("Not allowed", "This page answers GET and POST.", 405);
    }

    // A form posted from anywhere but this page is not this administrator's
    // intent, whatever cookie the browser attached to it.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) {
      return refusal(
        "Refused",
        "That form was submitted from another site, so nothing was written.",
        403,
      );
    }

    let outcome: { notice: NoticeV1 } | { redirect: string };
    try {
      outcome = await apply(
        await request.formData(),
        administrationV1(env.APP),
        email,
      );
    } catch (error) {
      return renderPage(
        env,
        email,
        {
          tone: "refused",
          message: `Nothing was written. ${
            error instanceof Error ? error.message : "That change was refused."
          }`,
        },
        400,
      );
    }
    return "redirect" in outcome
      ? seeOther(outcome.redirect)
      : renderPage(env, email, outcome.notice, 409);
  },
};

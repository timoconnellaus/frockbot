/**
 * The credential a framed Setup page reads the account with.
 *
 * The app frames `/setup` with no session: the web frame is `credentialless`
 * and the phone's web view keeps a store of its own, so neither carries the
 * cookie or the native bearer, and neither should — a page is never handed
 * the app's own session. The signed-in app mints one of these instead, for
 * the one reader it is about to open, and the page carries it back as
 * `Authorization: Bearer frockbot-setup.<token>`.
 *
 * It is short, it names one User, and it opens only the account routes Setup
 * uses (`setupReaderPathV1`). It cannot mint another: a page that outlives it
 * asks the app that framed it, which is signed in, for a fresh one.
 */

import type { AccountAdmissionDecisionV1 } from "@frockbot/app/admin/shared";

export const SETUP_READER_PREFIX_V1 = "frockbot-setup.";

/** How long one reader credential opens Setup. */
export const SETUP_READER_LIFETIME_MS_V1 = 60 * 60 * 1000;

/** The route the signed-in app mints a reader credential from. */
export const SETUP_FRAME_PATH_V1 = "/api/setup/frame";

/** The pages `/setup` draws, each its own address so a link can name one. */
export const SETUP_PAGES_V1 = [
  "plan",
  "computer",
  "ai",
  "search",
  "apps",
  "accounts",
] as const;
export type SetupPageV1 = (typeof SETUP_PAGES_V1)[number];

/** Whether `pathname` is the Setup document: `/setup` or one of its pages. */
export function isSetupDocumentPathV1(pathname: string): boolean {
  if (pathname === "/setup") return true;
  const page = /^\/setup\/([a-z]+)$/.exec(pathname)?.[1];
  return (
    page !== undefined && (SETUP_PAGES_V1 as readonly string[]).includes(page)
  );
}

const ACCOUNT_CONNECTION_PACKAGES_V1 = "(connect|mcp)";

/**
 * Every route a reader credential opens: the account's settings and
 * Connections, and its billing. Nothing a Bot owns, no saved secret, no
 * deletion, and not the mint itself.
 */
export function setupReaderPathV1(pathname: string): boolean {
  return (
    pathname === "/api/identity" ||
    pathname === "/api/settings" ||
    pathname === "/api/settings/connections" ||
    pathname === "/api/connections" ||
    pathname === "/api/connection-commands" ||
    pathname === "/api/billing" ||
    pathname === "/api/billing/spending" ||
    /^\/api\/billing\/provider\/(checkout|plan|portal)$/.test(pathname) ||
    new RegExp(
      `^/api/plugins/${ACCOUNT_CONNECTION_PACKAGES_V1}/connections(/[^/]+/(revoke|authorize))?$`,
    ).test(pathname)
  );
}

/** The reader credential a request carries, when it carries one. */
export function setupReaderBearerV1(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  const prefix = `Bearer ${SETUP_READER_PREFIX_V1}`;
  return header?.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

/** Who a reader credential was minted for. */
export interface SetupReaderClaimsV1 {
  userId: string;
  /**
   * Minted under the development identity, which a local stack admits
   * without an account behind it; honoured only where that identity is.
   */
  development: boolean;
}

export interface SetupReader {
  mint(
    claims: SetupReaderClaimsV1,
  ): Promise<{ token: string; expiresAt: number }>;
  /** Whom a credential was minted for, or undefined when it is not one. */
  verify(token: string): Promise<SetupReaderClaimsV1 | undefined>;
  /**
   * The beta-access authority's answer for the User, asked on every read as
   * a cookie's is; null when the account is unknown.
   */
  admit(userId: string): Promise<AccountAdmissionDecisionV1 | null>;
}

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function unbase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}

export function createSetupReader(options: {
  secret: string;
  admit: SetupReader["admit"];
  now?: () => number;
}): SetupReader {
  const now = options.now ?? Date.now;
  // Its own key domain: a reader credential is never a native session, and
  // nothing the native door signed verifies here.
  const key = () =>
    crypto.subtle.importKey(
      "raw",
      encoder.encode(`frockbot-setup-reader-v1:${options.secret}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  return {
    async mint({ userId, development }) {
      const expiresAt = now() + SETUP_READER_LIFETIME_MS_V1;
      const payload = base64(
        encoder.encode(
          JSON.stringify({ userId, development, expires: expiresAt }),
        ),
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        await key(),
        encoder.encode(payload),
      );
      return {
        token: `${payload}.${base64(new Uint8Array(signature))}`,
        expiresAt,
      };
    },
    async verify(token) {
      if (token.length > 1024) return undefined;
      const [payload, signature, ...rest] = token.split(".");
      if (
        rest.length ||
        !payload ||
        !signature ||
        !/^[A-Za-z0-9_-]+$/.test(payload) ||
        !/^[A-Za-z0-9_-]+$/.test(signature)
      )
        return undefined;
      try {
        if (
          !(await crypto.subtle.verify(
            "HMAC",
            await key(),
            unbase64(signature),
            encoder.encode(payload),
          ))
        )
          return undefined;
        const claims: unknown = JSON.parse(
          new TextDecoder().decode(unbase64(payload)),
        );
        if (!claims || typeof claims !== "object") return undefined;
        const { userId, development, expires } = claims as Record<
          string,
          unknown
        >;
        if (
          typeof userId !== "string" ||
          typeof development !== "boolean" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(userId) ||
          typeof expires !== "number" ||
          !Number.isSafeInteger(expires) ||
          expires <= now()
        )
          return undefined;
        return { userId, development };
      } catch {
        return undefined;
      }
    },
    admit: options.admit,
  };
}

import { readSetupFragmentV1 } from "@frockbot/core/setup-choices";
import { reviewSetupV1 } from "./review.js";
import { setupPageV1, setupScriptV1, setupStylesV1 } from "./page.js";

interface SetupRouteContextV1 {
  userId?: string;
}

/** The longest carried setup accepted: a fragment is a few hundred bytes. */
const MAX_SETUP_LENGTH = 8_192;

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length <= 200 &&
    value.every((entry) => typeof entry === "string" && entry.length <= 100)
    ? value
    : undefined;
}

/**
 * `/setup`, where a setup chosen on frockbot.com arrives, and the review of
 * it. The review is a pure reading of the carried choices against what the
 * page reports the account has; it changes nothing. Applying goes through
 * the same Settings, Connections and Billing commands the app uses.
 */
export function setupCarryOverRoutesV1(options: { productName: string }) {
  return {
    packageId: "setup",
    async publicRoute(request: Request, url: URL) {
      if (request.method !== "GET") return undefined;
      const body =
        url.pathname === "/setup/apply"
          ? { text: setupPageV1(options), type: "text/html" }
          : url.pathname === "/setup/apply.js"
            ? { text: setupScriptV1, type: "text/javascript" }
            : url.pathname === "/setup/apply.css"
              ? { text: setupStylesV1, type: "text/css" }
              : undefined;
      if (!body) return undefined;
      return new Response(body.text, {
        headers: {
          "content-type": `${body.type}; charset=utf-8`,
          ...PAGE_HEADERS,
        },
      });
    },
    async route(request: Request, url: URL, context: SetupRouteContextV1) {
      if (url.pathname !== "/api/setup/review") return undefined;
      if (!context.userId) return undefined;
      if (request.method !== "POST")
        return Response.json({ error: "method not allowed" }, { status: 405 });
      let input: Record<string, unknown>;
      try {
        input = (await request.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "Expected JSON" }, { status: 400 });
      }
      const connected = strings(input.connectedProviders);
      if (
        typeof input.setup !== "string" ||
        input.setup.length > MAX_SETUP_LENGTH ||
        !connected ||
        (input.plan !== undefined && typeof input.plan !== "string")
      )
        return Response.json(
          { error: "That setup could not be read." },
          { status: 400 },
        );
      return Response.json(
        reviewSetupV1(readSetupFragmentV1(`#setup=${input.setup}`), {
          connectedProviders: new Set(connected),
          plan: input.plan as string | undefined,
        }),
      );
    },
  };
}

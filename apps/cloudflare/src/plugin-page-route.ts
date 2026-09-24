// A Plugin's page, served from the app's own origin (ADR 0036).
//
// The page is untrusted HTML, so the app origin is only where its bytes come
// from, never what they run as. The response's CSP `sandbox` gives the
// document an opaque origin however it is opened — framed, or pasted into an
// address bar — so it can read no cookie and no storage of the app, and the
// policy lets it load and connect to nothing. The frame's own `sandbox`
// attribute says the same again. The route is anonymous because the frame's
// request is credentialless: the page is named by the hash of its bytes, and
// holds nothing of the account.
import { PLUGIN_PAGE_ROUTE_V1 } from "@frockbot/core/contracts";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import { INSIGHTS_REPORT_ORIGIN, INSIGHTS_SCRIPT_ORIGIN } from "./insights.js";

/*
 * The zone injects its Insights beacon into HTML it serves; `no-transform`
 * asks it not to, because the hash names these bytes. The beacon's origins
 * are named anyway, since that is a request rather than a guarantee, and
 * naming them opens nothing else.
 */
export const PLUGIN_PAGE_CSP_V1 = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'unsafe-inline' ${INSIGHTS_SCRIPT_ORIGIN}`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  `connect-src ${INSIGHTS_REPORT_ORIGIN}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

export function isPluginPagePathV1(pathname: string): boolean {
  return PLUGIN_PAGE_ROUTE_V1.test(pathname);
}

export async function servePluginPageV1(
  request: Request,
  url: URL,
  load: ((contentHash: string) => Promise<string | undefined>) | undefined,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const contentHash = PLUGIN_PAGE_ROUTE_V1.exec(url.pathname)?.[1];
  if (!contentHash) {
    return Response.json({ error: "page was not found" }, { status: 404 });
  }
  const etag = `"${contentHash}"`;
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": PLUGIN_PAGE_CSP_V1,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "public, max-age=31536000, immutable, no-transform",
    etag,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  const html = await load?.(contentHash);
  if (html === undefined) {
    return Response.json({ error: "page was not found" }, { status: 404 });
  }
  if ((await sha256HexTextV1(html)) !== contentHash) {
    return Response.json(
      { error: "page failed verification" },
      { status: 502 },
    );
  }
  return new Response(request.method === "HEAD" ? null : html, { headers });
}

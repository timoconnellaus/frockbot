/**
 * `/setup`: the account's Setup page, a small client app bundled into this
 * Worker's static assets under `/_setup/` (`build-setup.ts`).
 *
 * The document is the same for everyone and names no account, so it is
 * served before authentication: the page reads the account itself, with the
 * browser's own session when it is opened in a tab, or with the reader
 * credential the app minted when the app frames it (`setup-reader.ts`).
 */

import { INSIGHTS_REPORT_ORIGIN, INSIGHTS_SCRIPT_ORIGIN } from "./insights.js";

/** Where the bundle is staged beside the Flutter payload. */
export const SETUP_ASSET_PREFIX_V1 = "/_setup/";

/**
 * Framed only by the app on this origin. `connect-src 'self'` is every read
 * and command the page makes; the beacon is the zone's own (see the app
 * document's policy in `user-application.ts`).
 */
export const SETUP_PAGE_CSP_V1 = [
  "default-src 'none'",
  `script-src 'self' ${INSIGHTS_SCRIPT_ORIGIN}`,
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self' ${INSIGHTS_REPORT_ORIGIN}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

export function setupDocumentV1(productName: string): string {
  const title = `${productName} setup`.replace(/[<>&"]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title}</title>
  <link rel="icon" type="image/png" href="/favicon.ico">
  <meta name="color-scheme" content="dark light">
  <link rel="stylesheet" href="${SETUP_ASSET_PREFIX_V1}setup.css">
  <script type="module" src="${SETUP_ASSET_PREFIX_V1}setup.js"></script>
</head>
<body>
  <div id="setup"></div>
  <noscript>Setup needs JavaScript.</noscript>
</body>
</html>`;
}

export function serveSetupDocumentV1(
  request: Request,
  productName: string,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return Response.json({ error: "method not allowed" }, { status: 405 });
  return new Response(
    request.method === "HEAD" ? null : setupDocumentV1(productName),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": SETUP_PAGE_CSP_V1,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
}

const CANONICAL_HOST = "frockbot.com";

// The Mac download is a stable site URL that lands on our own domain, not on
// the repository. The release workflow writes every disk image to R2 under an
// immutable versioned key and only then overwrites this `latest` pointer, so
// what the site hands out moves when a release finishes rather than whenever
// a Release object is edited. Serving from the R2 custom domain rather than
// proxying through this Worker keeps range requests and resumable downloads —
// a Worker would have to implement `Range` itself to survive a dropped
// connection mid-download. The redirect is temporary so the target can move
// without stale caches. The disk image is still attached to each GitHub
// release as the per-tag provenance record.
export const MAC_DOWNLOAD_PATH = "/download/mac";
export const MAC_DOWNLOAD_URL =
  "https://downloads.frockbot.com/mac/FrockBot-macos.dmg";

export function macDownloadRedirect(request: Request): Response | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.pathname.replace(/\/+$/, "") !== MAC_DOWNLOAD_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  return Response.redirect(MAC_DOWNLOAD_URL, 302);
}

const SECURITY_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https://bot.frockbot.com",
    "font-src 'self'",
    "form-action 'self' https://bot.frockbot.com",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function canonicalUrl(request: Request): URL | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.hostname !== `www.${CANONICAL_HOST}`) return null;
  url.hostname = CANONICAL_HOST;
  url.protocol = "https:";
  return url;
}

export function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  return secured;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const canonical = canonicalUrl(request);
    if (canonical) return Response.redirect(canonical, 308);
    const download = macDownloadRedirect(request);
    if (download) return download;
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

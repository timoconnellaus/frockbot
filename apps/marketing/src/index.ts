interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
}

const CANONICAL_HOST = "frockbot.com";

// The Mac download is a stable site URL, not a GitHub asset link baked into
// the page: GitHub resolves `releases/latest/download/<asset>` to the newest
// published, non-prerelease release, and every release attaches the disk
// image under this fixed name. The redirect is temporary so the target can
// move without stale caches.
export const MAC_DOWNLOAD_PATH = "/download/mac";
export const MAC_DOWNLOAD_URL =
  "https://github.com/timoconnellaus/frockbot/releases/latest/download/FrockBot-macos.dmg";

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

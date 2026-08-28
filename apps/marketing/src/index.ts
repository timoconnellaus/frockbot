interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
}

const CANONICAL_HOST = "frockbot.com";

const SECURITY_HEADERS = {
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
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

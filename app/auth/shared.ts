/**
 * What both auth Packages and the native sign-in door answer with.
 *
 * A sign-in response is never cached and never leaks its URL to the next hop:
 * the URLs in this flow carry single-use codes.
 */
export const AUTH_NO_STORE_HEADERS_V1: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

/**
 * What a person is told when a sign-in cannot be finished.
 *
 * One sentence for every cause: a refused provider, a malformed answer, an
 * expired link. Which one it was is the Worker log's business, not the
 * visitor's.
 */
export const SIGN_IN_FAILED_MESSAGE_V1 =
  "Couldn't finish signing in. Please try again.";

/** A sign-in that cannot be finished, as JSON a client can show. */
export function signInFailedV1(
  status = 400,
  message = SIGN_IN_FAILED_MESSAGE_V1,
): Response {
  return Response.json(
    { error: message },
    { status, headers: AUTH_NO_STORE_HEADERS_V1 },
  );
}

/**
 * A sign-in step's redirect, carrying whatever cookies the step set.
 *
 * `set-cookie` is appended rather than copied: an identity provider's state
 * cookie and a session cookie can both be on one response, and a `Headers`
 * copy would keep only the last.
 */
export function signInRedirectV1(url: string, extra?: Headers): Response {
  const headers = new Headers(AUTH_NO_STORE_HEADERS_V1);
  headers.set("location", url);
  for (const cookie of extra?.getSetCookie() ?? [])
    headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

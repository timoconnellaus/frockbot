import {
  isProtocolValue,
  type AuthStartCommand,
  type ClientHello,
} from "@frockbot/core/protocol-schemas";
import {
  clientCompatibilityResponse,
  CLIENT_HELLO_HEADER,
} from "./client-compatibility.js";
import type { AuthSession, GatewayAuth } from "./contracts.js";
import type {
  NativeSessionOperation,
  NativeSessionRecord,
} from "./native-sessions.js";

export const NATIVE_ORIGIN = "https://bot.frockbot.com";
export const NATIVE_RETURN_ANDROID = `${NATIVE_ORIGIN}/native/return/android`;
export const NATIVE_RETURN_MACOS = `${NATIVE_ORIGIN}/native/return/macos`;
/**
 * Where a development build of the app receives its sign-in. A custom scheme,
 * because a plain-HTTP loopback origin can never be an App Link; only a Worker
 * running with `ALLOW_DEVELOPMENT_AUTH` ever lists it.
 */
export const NATIVE_RETURN_DEVELOPMENT = "frockbot-dev://native/return/android";
/**
 * The Mac app's custom scheme. A Universal Link only reaches the app from
 * Safari, and only on a user's own click; Chrome and Firefox never dispatch
 * one, and Google's completion redirect is not a click. The return page hands
 * the same code and state to this scheme, which every browser can open. The
 * code is useless without the PKCE verifier the app never shares.
 */
export const NATIVE_MACOS_SCHEME = "frockbot";
const PREFIX = "frockbot-native.";
const encoder = new TextEncoder();
const NO_STORE = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

/** Deployment policy, never a client-selected target or a per-Bot grant. */
export function nativeReturnUris(flag: string | undefined): readonly string[] {
  if (flag === "android") return [NATIVE_RETURN_ANDROID];
  if (flag === "android,macos")
    return [NATIVE_RETURN_ANDROID, NATIVE_RETURN_MACOS];
  return [];
}

/** The request origin with a fully qualified (trailing-dot) host normalised. */
export function requestOrigin(url: URL): string {
  const host = url.hostname.endsWith(".")
    ? url.hostname.slice(0, -1)
    : url.hostname;
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

// Supported app versions can reuse a session; its protocol and catalogs stay bound.
function sameClient(a: ClientHello, b: ClientHello): boolean {
  const shape = (h: ClientHello) =>
    JSON.stringify({
      schemaVersion: h.schemaVersion,
      protocolVersion: h.protocolVersion,
      catalogs: h.catalogs.map((c) => `${c.id}:${c.digest}`).sort(),
    });
  return shape(a) === shape(b);
}

export function isNativeAuthPath(path: string): boolean {
  return (
    path.startsWith("/api/auth/native/") ||
    path.startsWith("/native/") ||
    path === "/.well-known/assetlinks.json" ||
    path === "/.well-known/apple-app-site-association"
  );
}

interface StartClaims {
  kind: "start";
  start: AuthStartCommand;
  hello: ClientHello;
  expires: number;
}
interface ExchangeClaims {
  kind: "exchange";
  start: AuthStartCommand;
  hello: ClientHello;
  expires: number;
  userId: string;
}
interface SessionClaims {
  kind: "session";
  userId: string;
  sessionId: string;
  hello: ClientHello;
  expires: number;
}
interface SettingsClaims {
  kind: "settings";
  userId: string;
  hello: ClientHello;
  home: "models" | "connections";
  expires: number;
}
type Claims = StartClaims | ExchangeClaims | SessionClaims | SettingsClaims;

export interface NativeAuthOptions {
  secret: string;
  auth: GatewayAuth;
  // Only associated, signed targets belong here. No request can add an entry.
  returnUris: readonly string[];
  /** Existing account/signup policy, checked before the first User-DO write. */
  canIssueSession(userId: string): Promise<boolean>;
  session(
    userId: string,
    operation: NativeSessionOperation,
  ): Promise<NativeSessionRecord | null>;
  now?: () => number;
  /** The origin the app talks to. Production's unless a development stack. */
  origin?: string;
  /**
   * The development sign-in door: with this set, `/native/authorize` issues
   * the code for this User when the browser holds no session, in place of
   * Google. Set only from `ALLOW_DEVELOPMENT_AUTH`, which production refuses.
   */
  developmentUserId?: string;
}

export interface NativeAuth {
  route(request: Request): Promise<Response | undefined>;
  authenticate(
    request: Request,
  ): Promise<{ session: AuthSession | null; refusal?: Response } | undefined>;
}

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
function error(
  status = 400,
  message = "Couldn't finish signing in. Please try again.",
): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE });
}
function redirect(url: string, extra?: Headers): Response {
  const headers = new Headers(NO_STORE);
  headers.set("location", url);
  for (const cookie of extra?.getSetCookie() ?? [])
    headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}
export async function readNativeJsonBody(
  request: Request,
  maximumBytes = 8192,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing input");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("Too much input");
    }
    chunks.push(next.value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder().decode(data);
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > 16) throw new Error("Input nesting limit");
    } else if (character === "}" || character === "]") depth--;
  }
  return JSON.parse(text);
}

export function createNativeAuth(options: NativeAuthOptions): NativeAuth {
  const origin = options.origin ?? NATIVE_ORIGIN;
  const now = options.now ?? Date.now;
  const key = () =>
    crypto.subtle.importKey(
      "raw",
      encoder.encode(`frockbot-native-v1:${options.secret}`),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  async function sign(claims: Claims): Promise<string> {
    const payload = base64(encoder.encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign(
      "HMAC",
      await key(),
      encoder.encode(payload),
    );
    return `${payload}.${base64(new Uint8Array(signature))}`;
  }
  async function verify(token: string, kind: Claims["kind"]): Promise<Claims> {
    if (token.length > 4096) throw new Error("Invalid token");
    const parts = token.split(".");
    if (
      parts.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]!) ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1]!)
    )
      throw new Error("Invalid token");
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(),
        unbase64(parts[1]!),
        encoder.encode(parts[0]!),
      ))
    )
      throw new Error("Invalid signature");
    const value: unknown = JSON.parse(
      new TextDecoder().decode(unbase64(parts[0]!)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid claims");
    const v = value as Record<string, unknown>;
    if (
      v.kind !== kind ||
      typeof v.expires !== "number" ||
      !Number.isSafeInteger(v.expires) ||
      v.expires <= now() ||
      !isProtocolValue("ClientHello", v.hello)
    )
      throw new Error("Expired sign-in");
    if (kind === "settings") {
      if (
        !isProtocolValue("Identifier", v.userId) ||
        (v.home !== "models" && v.home !== "connections")
      )
        throw new Error("Invalid settings destination");
      return {
        kind,
        userId: v.userId,
        home: v.home,
        hello: v.hello,
        expires: v.expires,
      };
    }
    if (kind !== "session") {
      if (
        !isProtocolValue("AuthStartCommand", v.start) ||
        !options.returnUris.includes(v.start.returnUri)
      )
        throw new Error("Invalid return link");
      if (kind === "start")
        return { kind, start: v.start, hello: v.hello, expires: v.expires };
      if (!isProtocolValue("Identifier", v.userId))
        throw new Error("Invalid User");
      return {
        kind: "exchange",
        start: v.start,
        hello: v.hello,
        expires: v.expires,
        userId: v.userId,
      };
    }
    if (
      !isProtocolValue("Identifier", v.userId) ||
      !isProtocolValue("Identifier", v.sessionId)
    )
      throw new Error("Invalid session");
    return {
      kind,
      userId: v.userId,
      sessionId: v.sessionId,
      hello: v.hello,
      expires: v.expires,
    };
  }
  function hello(request: Request): ClientHello {
    const value: unknown = JSON.parse(
      request.headers.get(CLIENT_HELLO_HEADER) ?? "null",
    );
    if (!isProtocolValue("ClientHello", value))
      throw new Error("Update the app to continue using FrockBot.");
    return value;
  }
  async function browserIdentity(
    request: Request,
  ): Promise<AuthSession | null> {
    // Browser cookies only: this endpoint cannot be used to launder another bearer.
    const headers = new Headers();
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    return options.auth.getSession(headers);
  }
  function operation(
    claims: SessionClaims,
    action: NativeSessionOperation["action"],
  ): NativeSessionOperation {
    return {
      schemaVersion: 1,
      userId: claims.userId,
      sessionId: claims.sessionId,
      hello: claims.hello,
      expiresAt: claims.expires,
      action,
    };
  }
  async function browserSignIn(
    request: Request,
    callbackURL: string,
  ): Promise<Response> {
    const response = await options.auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: origin,
          cookie: request.headers.get("cookie") ?? "",
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: callbackURL,
        }),
      }),
    );
    if (!response.ok) return error(401);
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("url" in result) ||
      typeof result.url !== "string"
    )
      return error();
    const providerUrl = new URL(result.url);
    if (
      providerUrl.origin !== "https://accounts.google.com" ||
      providerUrl.username ||
      providerUrl.password
    )
      return error();
    return redirect(providerUrl.toString(), response.headers);
  }
  return {
    async authenticate(request) {
      const bearer = request.headers.get("authorization");
      if (!bearer?.startsWith(`Bearer ${PREFIX}`)) return undefined;
      const refusal = clientCompatibilityResponse(
        request,
        new URL(`${origin}/api/native/session`),
      );
      if (refusal) return { session: null, refusal };
      try {
        const claims = await verify(bearer.slice(7 + PREFIX.length), "session");
        if (claims.kind !== "session") return { session: null };
        // The app recovers a rejected session through sign-in; 426 asks for an update.
        if (!sameClient(hello(request), claims.hello)) return { session: null };
        const record = await options.session(
          claims.userId,
          operation(claims, "read"),
        );
        if (!record) return { session: null };
        // The email, not just the id: admission and the admin check read it,
        // so a native session that omitted it made a listed admin ordinary on
        // the phone while the same account was an admin in a browser.
        const profile = await options.auth.profile?.(record.userId);
        return {
          session: {
            user: {
              id: record.userId,
              ...(profile?.email ? { email: profile.email } : {}),
            },
          },
        };
      } catch {
        return { session: null };
      }
    },
    async route(request) {
      const url = new URL(request.url);
      if (!isNativeAuthPath(url.pathname)) return undefined;
      // The signed application's callback origin is not configurable by input.
      // Google's asset-links fetcher asks for the fully qualified host
      // ("bot.frockbot.com."); that trailing dot names the same origin.
      if (requestOrigin(url) !== origin) return error(403);
      const association =
        url.pathname === "/.well-known/assetlinks.json" ||
        url.pathname === "/.well-known/apple-app-site-association";
      if (association && request.method === "HEAD") {
        const full = await this.route(new Request(request.url));
        return new Response(null, {
          status: full?.status ?? 404,
          headers: full?.headers,
        });
      }
      try {
        if (
          url.pathname === "/.well-known/assetlinks.json" &&
          request.method === "GET"
        ) {
          return Response.json(
            [
              {
                relation: ["delegate_permission/common.handle_all_urls"],
                target: {
                  namespace: "android_app",
                  package_name: "com.frockbot.mobile",
                  sha256_cert_fingerprints: [
                    "61:E6:47:9F:9C:57:55:15:4C:1F:93:9C:DE:48:E8:A7:57:EF:F3:13:6E:54:ED:1D:DA:5F:61:E7:8B:3C:1E:37",
                  ],
                },
              },
            ],
            { headers: { "cache-control": "public, max-age=300" } },
          );
        }
        if (
          url.pathname === "/.well-known/apple-app-site-association" &&
          request.method === "GET"
        ) {
          return Response.json(
            {
              applinks: {
                details: [
                  {
                    appIDs: ["Q444L76529.com.frockbot.mobile"],
                    components: [{ "/": "/native/return/macos" }],
                  },
                ],
              },
            },
            { headers: { "cache-control": "public, max-age=300" } },
          );
        }
        // This signed link grants no browser session and no Connection. It only
        // carries a short-lived navigation intent to the same authenticated User.
        if (
          url.pathname === "/api/auth/native/settings" &&
          request.method === "POST"
        ) {
          const principal = await this.authenticate(request);
          if (principal?.refusal) return principal.refusal;
          if (!principal?.session) return error(401);
          const command = await readNativeJsonBody(request);
          if (!isProtocolValue("SettingsHandoffCommand", command))
            return error();
          const expires = now() + 300_000;
          const token = await sign({
            kind: "settings",
            userId: principal.session.user.id,
            home: command.home,
            hello: hello(request),
            expires,
          });
          return Response.json(
            {
              schemaVersion: 1,
              authorizationUrl: `${origin}/native/settings?request=${token}`,
              expiresAt: new Date(expires).toISOString(),
            },
            { headers: NO_STORE },
          );
        }
        if (url.pathname === "/native/settings" && request.method === "GET") {
          if ([...url.searchParams.keys()].join() !== "request") return error();
          const token = url.searchParams.get("request") ?? "";
          const claims = await verify(token, "settings");
          if (claims.kind !== "settings") return error();
          const session = await browserIdentity(request);
          if (!session)
            return browserSignIn(
              request,
              `${origin}/native/settings?request=${token}`,
            );
          if (session.user.id !== claims.userId)
            return new Response(
              "This browser is signed in to a different FrockBot account. Switch accounts in the browser, then return to the app and try again.",
              {
                status: 403,
                headers: {
                  ...NO_STORE,
                  "content-type": "text/plain; charset=utf-8",
                },
              },
            );
          return redirect(
            `${origin}/?settings=${claims.home}${claims.home === "models" ? "#user-model-providers" : ""}`,
          );
        }
        if (
          url.pathname === "/api/auth/native/start" &&
          request.method === "POST"
        ) {
          const invalid = clientCompatibilityResponse(request, url);
          if (invalid) return invalid;
          const start = await readNativeJsonBody(request);
          if (
            !isProtocolValue("AuthStartCommand", start) ||
            !options.returnUris.includes(start.returnUri)
          )
            return error();
          const expires = now() + 300_000;
          const token = await sign({
            kind: "start",
            start,
            hello: hello(request),
            expires,
          });
          return Response.json(
            {
              schemaVersion: 1,
              authorizationUrl: `${origin}/native/authorize?request=${token}`,
              expiresAt: new Date(expires).toISOString(),
            },
            { headers: NO_STORE },
          );
        }
        if (
          ["/native/authorize", "/native/complete"].includes(url.pathname) &&
          request.method === "GET"
        ) {
          if ([...url.searchParams.keys()].join() !== "request") return error();
          const token = url.searchParams.get("request") ?? "";
          const claims = await verify(token, "start");
          if (claims.kind !== "start") return error();
          const session = await browserIdentity(request);
          const userId = session?.user.id ?? options.developmentUserId;
          if (!userId) {
            if (url.pathname === "/native/complete") return error(401);
            return browserSignIn(
              request,
              `${origin}/native/complete?request=${token}`,
            );
          }
          const code = await sign({ ...claims, kind: "exchange", userId });
          const destination = new URL(claims.start.returnUri);
          destination.searchParams.set("code", code);
          destination.searchParams.set("state", claims.start.state);
          return redirect(destination.toString());
        }
        if (
          url.pathname === "/api/auth/native/exchange" &&
          request.method === "POST"
        ) {
          const invalid = clientCompatibilityResponse(request, url);
          if (invalid) return invalid;
          const command = await readNativeJsonBody(request);
          if (!isProtocolValue("AuthExchangeCommand", command)) return error();
          const claims = await verify(command.code, "exchange");
          if (claims.kind !== "exchange") return error();
          const digest = base64(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                encoder.encode(command.codeVerifier),
              ),
            ),
          );
          if (
            digest !== claims.start.codeChallenge ||
            command.state !== claims.start.state ||
            command.returnUri !== claims.start.returnUri ||
            JSON.stringify(hello(request)) !== JSON.stringify(claims.hello)
          )
            return error();
          const session: SessionClaims = {
            kind: "session",
            userId: claims.userId,
            sessionId: claims.start.commandId,
            hello: claims.hello,
            expires: now() + 7 * 86400_000,
          };
          if (!(await options.canIssueSession(session.userId)))
            return error(
              403,
              "FrockBot isn’t accepting new accounts right now.",
            );
          // Admission is committed before the bearer is returned. Replaying the
          // same authorization, including a repeated callback, cannot issue twice.
          const issued = await options.session(
            session.userId,
            operation(session, "issue"),
          );
          if (
            !issued ||
            issued.revoked ||
            issued.userId !== session.userId ||
            issued.sessionId !== session.sessionId ||
            issued.expiresAt !== session.expires ||
            JSON.stringify(issued.hello) !== JSON.stringify(session.hello)
          )
            return error();
          return Response.json(
            {
              schemaVersion: 1,
              userId: session.userId,
              sessionId: session.sessionId,
              expiresAt: new Date(session.expires).toISOString(),
              sessionToken: PREFIX + (await sign(session)),
            },
            { headers: NO_STORE },
          );
        }
        if (
          url.pathname === "/api/auth/native/revoke" &&
          request.method === "POST"
        ) {
          // This route is also called without the gateway's compatibility gate.
          const invalid = clientCompatibilityResponse(request, url);
          if (invalid) return invalid;
          const bearer = request.headers.get("authorization") ?? "";
          if (!bearer.startsWith(`Bearer ${PREFIX}`)) return error(401);
          const claims = await verify(
            bearer.slice(7 + PREFIX.length),
            "session",
          );
          if (claims.kind !== "session") return error(401);
          const command = await readNativeJsonBody(request);
          if (
            !isProtocolValue("SessionRevokeCommand", command) ||
            command.sessionId !== claims.sessionId
          )
            return error();
          // A 401 lets the app discard the unusable session and finish signing out.
          if (!sameClient(hello(request), claims.hello))
            return error(401, "Please sign in again.");
          await options.session(claims.userId, operation(claims, "revoke"));
          return Response.json(
            { schemaVersion: 1, status: "signed-out" },
            { headers: NO_STORE },
          );
        }
        if (
          options.returnUris.includes(url.origin + url.pathname) &&
          request.method === "GET"
        ) {
          if (url.origin + url.pathname === NATIVE_RETURN_MACOS)
            return macosReturnPage();
          return new Response(
            "Return to FrockBot to finish signing in. If it did not open, check that the latest app is installed and try again.",
            {
              headers: {
                ...NO_STORE,
                "content-type": "text/plain; charset=utf-8",
              },
            },
          );
        }
        return error(404);
      } catch {
        return error();
      }
    },
  };
}

/**
 * The page Google's completion lands on in the Mac user's browser. It carries
 * the code and state across to the app on its custom scheme, forwarding only
 * those two query parameters and never reflecting them into markup.
 */
function macosReturnPage(): Response {
  const target = `${NATIVE_MACOS_SCHEME}://${new URL(NATIVE_RETURN_MACOS).host}${new URL(NATIVE_RETURN_MACOS).pathname}`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Return to FrockBot</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #171319; color: #f4eef2; font: 16px/1.5 -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; color: #cfc3cb; }
  a.open { display: inline-block; padding: .8rem 1.5rem; border-radius: .75rem; background: #ec2f6a; color: #fff; font-weight: 600; text-decoration: none; }
  small { display: block; margin-top: 1.25rem; color: #9b8d96; }
</style>
</head>
<body>
<main>
  <h1>Return to FrockBot to finish signing in</h1>
  <p>Your browser should open FrockBot now. If it did not, open it here.</p>
  <a class="open" id="open" href="${target}">Open FrockBot</a>
  <small>If FrockBot still does not open, check that the latest app is installed and sign in again.</small>
</main>
<script>
(function () {
  var incoming = new URLSearchParams(location.search);
  var forwarded = new URLSearchParams();
  ["code", "state"].forEach(function (key) {
    var value = incoming.get(key);
    if (value !== null) forwarded.set(key, value);
  });
  var href = ${JSON.stringify(target)} + (forwarded.toString() ? "?" + forwarded.toString() : "");
  document.getElementById("open").setAttribute("href", href);
  location.replace(href);
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      ...NO_STORE,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

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
          return nativeReturnPage(
            url.origin + url.pathname === NATIVE_RETURN_MACOS
              ? "macos"
              : "android",
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
 * The FrockBot app icon. Inlined because the page's policy loads
 * nothing from anywhere, and small enough (a 144px WebP) to ride on every
 * return without a second request.
 */
const NATIVE_RETURN_LOGO =
  "data:image/webp;base64,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";

/**
 * The page Google's completion lands on in the user's browser. On the Mac it
 * carries the code and state across to the app on its custom scheme,
 * forwarding only those two query parameters and never reflecting them into
 * markup. On Android the verified App Link has already opened the app; this
 * page is what remains in the browser, and what a user sees if it did not.
 */
function nativeReturnPage(platform: "macos" | "android"): Response {
  const macos = platform === "macos";
  const target = macos
    ? `${NATIVE_MACOS_SCHEME}://${new URL(NATIVE_RETURN_MACOS).host}${new URL(NATIVE_RETURN_MACOS).pathname}`
    : undefined;
  const lead = macos
    ? "Your browser is handing you over to the FrockBot app. Once it opens, you can close this tab."
    : "Head back to the FrockBot app to finish signing in. You can close this page.";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#1f1e24">
<title>Return to FrockBot</title>
<style>
  :root {
    --window: #1f1e24; --raised: #2c2a33; --border: #3a3742;
    --text: #f4f2f6; --muted: #aaa6b1; --accent: #ec386b; --accent-hover: #f04d7b;
    --glow: rgba(236, 56, 107, .22); --shadow: rgba(0, 0, 0, .45);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --window: #faf8fb; --raised: #ffffff; --border: #dfd9e3;
      --text: #1f1e24; --muted: #625c6b; --accent: #bd1e50; --accent-hover: #d02a5f;
      --glow: rgba(189, 30, 80, .14); --shadow: rgba(31, 30, 36, .12);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: 24px;
    background: var(--window) radial-gradient(60rem 30rem at 50% -10%, var(--glow), transparent 70%);
    color: var(--text);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Manrope, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%; max-width: 26.5rem; padding: 2.5rem 2rem 2rem; text-align: center;
    background: var(--raised); border: 1px solid var(--border); border-radius: 20px;
    box-shadow: 0 24px 60px -24px var(--shadow);
    animation: rise .5s cubic-bezier(.2, .8, .2, 1) both;
  }
  .icon {
    display: block; width: 88px; height: 88px; margin: 0 auto 1.25rem; border-radius: 24px;
    box-shadow: 0 10px 30px -10px var(--shadow);
  }
  .brand {
    margin: 0 0 .75rem; font-size: .8125rem; font-weight: 700; letter-spacing: .12em;
    text-transform: uppercase; color: var(--accent);
  }
  h1 { margin: 0 0 .625rem; font-size: 1.5rem; line-height: 1.2; letter-spacing: -.01em; }
  p { margin: 0 0 1.5rem; color: var(--muted); }
  .status {
    display: inline-flex; align-items: center; gap: .625rem; margin-bottom: 1.5rem;
    padding: .5rem .9rem; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--text); font-size: .9375rem; font-weight: 600;
  }
  .dots { display: inline-flex; gap: 4px; }
  .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .dots i:nth-child(2) { animation-delay: .2s; }
  .dots i:nth-child(3) { animation-delay: .4s; }
  a.open {
    display: block; padding: .9rem 1.5rem; border-radius: 12px; background: var(--accent); color: #fff;
    font-weight: 700; text-decoration: none; transition: background .14s ease, transform .14s ease;
  }
  a.open:hover { background: var(--accent-hover); }
  a.open:active { transform: translateY(1px); }
  a.open:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
  small { display: block; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--muted); font-size: .875rem; line-height: 1.5; }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  @keyframes pulse { 0%, 80%, 100% { opacity: .25; transform: scale(.8); } 40% { opacity: 1; transform: scale(1); } }
  @media (prefers-reduced-motion: reduce) { main, .dots i { animation: none; } }
</style>
</head>
<body>
<main>
  <img class="icon" src="${NATIVE_RETURN_LOGO}" alt="" width="88" height="88">
  <p class="brand">FrockBot</p>
  <h1>Return to FrockBot to finish signing in</h1>
  <p>${lead}</p>${
    macos
      ? `
  <div class="status" role="status"><span class="dots"><i></i><i></i><i></i></span>Opening FrockBot</div>
  <a class="open" id="open" href="${target}">Open FrockBot</a>`
      : ""
  }
  <small>If FrockBot did not open, check that the latest app is installed and try signing in again.</small>
</main>${
    macos
      ? `
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
</script>`
      : ""
  }
</body>
</html>`;
  return new Response(html, {
    headers: {
      ...NO_STORE,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; img-src data:; ${macos ? "script-src 'unsafe-inline'; " : ""}style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

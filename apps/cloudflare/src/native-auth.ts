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
 * The FrockBot lamb, as the app icon. Inlined because the page's policy loads
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
    box-shadow: 0 10px 30px -10px var(--shadow), 0 0 0 1px var(--border);
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

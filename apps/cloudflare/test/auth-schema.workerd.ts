// The gateway's auth seam against the D1 schema a deployment actually applies.
//
// The better-auth Package degrades to an unconfigured stub without the Google
// and better-auth secrets, so every other suite here talks to a hole rather than to
// better-auth. This one configures it and drives `/api/auth/*` against a D1
// migrated from `migrations/`, because better-auth validates that schema at
// first use: a column it never writes but the migration declares `not null`
// fails every auth request with HTTP 500 while the rest of the repository, and
// the browser e2e harness, stay green.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import {
  BETTER_AUTH_PACKAGE_V1,
  createAuth,
} from "@frockbot/app/auth/better-auth";

const BASE_URL = "https://bot.frockbot.com";
const SECRET = "workerd-auth-schema-secret-0123456789abcdef";

function configuredAuth() {
  return BETTER_AUTH_PACKAGE_V1.create({
    AUTH_DB: env.AUTH_DB,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: BASE_URL,
    GOOGLE_CLIENT_ID: "auth-schema.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "auth-schema-client-secret",
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.AUTH_DB, env.TEST_MIGRATIONS);
});

test("a visitor with no session is told nobody is signed in", async () => {
  expect(await configuredAuth().getSession(new Headers())).toBeNull();
});

test("clicking sign in with Google hands back Google's consent URL", async () => {
  const response = await configuredAuth().handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    }),
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { url?: string };
  expect(body.url ?? "").toContain(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
});

test("a closed deployment refuses to create an account on first sign-in", async () => {
  const refused: string[] = [];
  const auth = createAuth(
    {
      AUTH_DB: env.AUTH_DB,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: BASE_URL,
      GOOGLE_CLIENT_ID: "auth-schema.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "auth-schema-client-secret",
    },
    {
      mayCreateIdentity: async ({ email }) => {
        refused.push(email);
        return false;
      },
    },
  );

  const created = await (
    await auth.$context
  ).internalAdapter.createUser(
    {
      name: "Uninvited Visitor",
      email: "uninvited@example.com",
      emailVerified: true,
    },
    { method: "oauth", oauth: { providerId: "google" } },
  );
  expect(created).toBeNull();

  expect(refused).toEqual(["uninvited@example.com"]);
  const { results } = await env.AUTH_DB.prepare(
    `select "email" from "user" where "email" = ?`,
  )
    .bind("uninvited@example.com")
    .all();
  expect(results).toEqual([]);
});

test("signing out clears the session cookie and sends the browser home", async () => {
  // The whole of what `/sign-out` means on this build: better-auth's own route,
  // reached over its own handler, and a 303 back to the document. The gateway
  // knows only that it hands the route to the Package.
  const auth = createAuth({
    AUTH_DB: env.AUTH_DB,
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: BASE_URL,
    GOOGLE_CLIENT_ID: "auth-schema.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "auth-schema-client-secret",
  });
  const adapter = (await auth.$context).internalAdapter;
  const user = await adapter.createUser(
    {
      name: "Signing out",
      email: `sign-out-${crypto.randomUUID()}@test.invalid`,
      emailVerified: true,
    },
    { method: "oauth", oauth: { providerId: "google" } },
  );
  const session = await adapter.createSession(user.id);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, encoder.encode(session.token)),
      ),
    ),
  );
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
  // What a browser sends when the refusal page's link is clicked: the session
  // cookie, and a same-origin `referer`, which is what better-auth's CSRF check
  // reads. The gateway forwards the request's own headers for exactly this
  // reason — a sign-out request stripped of them is refused.
  const request = new Request(`${BASE_URL}/sign-out`, {
    headers: { cookie, referer: `${BASE_URL}/` },
  });
  expect(
    await configuredAuth().getSession(new Headers({ cookie })),
  ).toMatchObject({ user: { id: user.id } });

  const response = await configuredAuth().signOut(
    request,
    new URL(request.url),
  );

  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/");
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(await configuredAuth().getSession(new Headers({ cookie }))).toBeNull();
});

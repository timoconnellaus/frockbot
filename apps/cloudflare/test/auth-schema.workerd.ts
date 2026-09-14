// The gateway's auth seam against the D1 schema a deployment actually applies.
//
// `gatewayAuth()` degrades to an unconfigured stub without the Google and
// better-auth secrets, so every other suite here talks to a hole rather than to
// better-auth. This one configures it and drives `/api/auth/*` against a D1
// migrated from `migrations/`, because better-auth validates that schema at
// first use: a column it never writes but the migration declares `not null`
// fails every auth request with HTTP 500 while the rest of the repository, and
// the browser e2e harness, stay green.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { gatewayAuth } from "../src/auth.ts";

const BASE_URL = "https://bot.frockbot.com";

function configuredAuth() {
  return gatewayAuth({
    AUTH_DB: env.AUTH_DB,
    BETTER_AUTH_SECRET: "workerd-auth-schema-secret-0123456789abcdef",
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

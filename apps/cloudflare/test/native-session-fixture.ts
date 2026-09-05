import { env } from "cloudflare:test";
import { decodeProtocol } from "@frockbot/protocol-schemas";
import { createNativeAuth, NATIVE_RETURN_ANDROID } from "../src/native-auth.ts";

export async function nativeHeaders(userId: string) {
  const owner = env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
  // The identity-provider seam supplies a synthetic User; real PKCE signing,
  // durable issuance and the deployed gateway's bearer verification follow.
  const auth = createNativeAuth({
    secret: env.BETTER_AUTH_SECRET,
    returnUris: [NATIVE_RETURN_ANDROID],
    auth: {
      getSession: async () => ({
        user: { id: userId },
        session: { id: "browser-test" },
      }),
      handler: async () => new Response(null, { status: 404 }),
    },
    canIssueSession: async () => true,
    session: async (_user, command) => {
      const result = await owner.nativeSession(command);
      if (result.status !== "ok") throw new Error("Fixture session refused");
      return result.record;
    },
  });
  const hello = {
    schemaVersion: 1,
    protocolVersion: 1,
    nativeVersion: "1.1.0",
    catalogs: [],
  };
  const verifier = "v".repeat(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const state = "s".repeat(32);
  const request = (path: string, body: unknown) =>
    new Request(`https://bot.frockbot.com${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frockbot-client": JSON.stringify(hello),
      },
      body: JSON.stringify(body),
    });
  const start = await auth.route(
    request("/api/auth/native/start", {
      schemaVersion: 1,
      commandId: "start-fixture",
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      returnUri: NATIVE_RETURN_ANDROID,
    }),
  );
  const view = decodeProtocol("AuthStartView", await start!.json());
  const redirect = await auth.route(new Request(view.authorizationUrl));
  const destination = new URL(redirect!.headers.get("location")!);
  const exchanged = await auth.route(
    request("/api/auth/native/exchange", {
      schemaVersion: 1,
      commandId: "exchange-fixture",
      code: destination.searchParams.get("code"),
      state,
      returnUri: NATIVE_RETURN_ANDROID,
      codeVerifier: verifier,
    }),
  );
  const session = decodeProtocol("AuthSessionView", await exchanged!.json());
  return {
    authorization: `Bearer ${session.sessionToken}`,
    "x-frockbot-client": JSON.stringify(hello),
  };
}

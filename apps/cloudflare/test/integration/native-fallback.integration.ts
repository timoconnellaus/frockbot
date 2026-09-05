import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  appletStateNameV1,
  verifyAppletViewerTokenV1,
} from "@frockbot/kernel-do";
import { decodeProtocol } from "@frockbot/protocol-schemas";
import {
  createNativeAuth,
  NATIVE_RETURN_ANDROID,
} from "../../src/native-auth.ts";
import { freshUserId, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

async function nativeHeaders(userId: string) {
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

test("the native gateway opens a stored published generation through the User-scoped RPC and short-lived viewer lease", async () => {
  const userId = freshUserId("native-fallback");
  const owner = env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
  const applet = await owner.createApplet({
    schemaVersion: 1,
    userId,
    displayName: "Todo",
    provenance: { kind: "user" },
  });
  const createdAt = "2026-09-05T00:52:26.826Z";
  const generationId = `${createdAt}:e0e3ce78fabf9eca`;
  await owner.recordAppletGeneration({
    schemaVersion: 1,
    userId,
    appletId: applet.appletId,
    generationId,
    tools: [],
  });
  const appletState = env.APPLET_STATES.get(
    env.APPLET_STATES.idFromName(appletStateNameV1(userId, applet.appletId)),
  );
  // Seed the released durable shape at its storage seam. Opening a page reads
  // these records; it must not mount code or wake the Computer to acquire a lease.
  await runInDurableObject(appletState, async (_instance, state) => {
    await state.storage.put({
      "applet:current": {
        schemaVersion: 1,
        generationId,
        changedAt: createdAt,
      },
      [`applet:generation:${generationId}`]: {
        schemaVersion: 1,
        generationId,
        createdAt,
        status: "active",
        contract: 1,
        origin: "publish",
        tools: [],
        server: {
          contentHash: "a".repeat(64),
          size: 10,
          mediaType: "application/javascript",
          bundlerVersion: "1",
        },
        ui: {
          contentHash: "b".repeat(64),
          size: 10,
          mediaType: "text/html",
          bundlerVersion: "1",
        },
        provenance: {
          botId: "fixture",
          sessionId: "fixture",
          turnId: "fixture",
          runId: "fixture",
        },
      },
    });
  });
  const headers = await nativeHeaders(userId);
  const path = `/api/native/applets/${applet.appletId}/bootstrap?epoch=native_navigation_epoch_1234`;
  const response = await SELF.fetch(`https://bot.frockbot.com${path}`, {
    headers,
  });
  expect(response.status).toBe(200);
  const bootstrap = decodeProtocol("FallbackBootstrap", await response.json());
  expect(bootstrap.generationId).toBe(generationId);
  expect(bootstrap.userId).toBe(userId);
  expect(bootstrap.bootstrapUrl).not.toContain("token");
  expect(bootstrap.viewer.socketUrl).not.toContain("?");
  const token = await verifyAppletViewerTokenV1(
    env.APPLET_VIEWER_SECRET,
    bootstrap.viewer.token,
  );
  expect(token).toMatchObject({
    u: userId,
    a: applet.appletId,
    g: generationId,
  });
  expect(
    Date.parse(bootstrap.viewer.expiresAt) - Date.now(),
  ).toBeLessThanOrEqual(120_000);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const other = await nativeHeaders(freshUserId("native-other"));
  expect(
    (await SELF.fetch(`https://bot.frockbot.com${path}`, { headers: other }))
      .status,
  ).toBe(503);
  expect(
    (
      await SELF.fetch(`https://bot.frockbot.com${path}`, {
        headers: { "x-frockbot-client": headers["x-frockbot-client"] },
      })
    ).status,
  ).toBe(401);
  const hostCalls = await env.COMPUTER_HOST.fetch(
    "https://computer.invalid/__fake/calls",
  );
  const hostView = await hostCalls.json<{ calls: Array<{ userId: string }> }>();
  expect(hostView.calls.filter((call) => call.userId === userId)).toEqual([]);
});

import { describe, expect, test } from "bun:test";
import {
  decodeDesktopAuthAcknowledgement,
  decodeDesktopAuthCallbackToken,
  decodeDesktopAuthEvent,
  decodeDesktopAuthRequest,
  decodeDesktopAuthUserResponse,
  decodeDesktopApiRequest,
  decodeDesktopApiResponse,
  decodeDesktopExternalAuthorizationRequest,
  decodeExternalAuthorizationAcknowledgement,
  decodeExternalAuthorizationUrl,
} from "./desktop-api.js";

describe("desktop hosted protocol", () => {
  test("admits only the hosted Bot, settings, Connection, notification, manifest, and Turn routes", () => {
    for (const request of [
      { schemaVersion: 1, path: "/app-manifest", method: "GET" },
      { schemaVersion: 1, path: "/api/identity", method: "GET" },
      { schemaVersion: 1, path: "/api/settings", method: "POST", body: "{}" },
      { schemaVersion: 1, path: "/api/package-revisions", method: "GET" },
      {
        schemaVersion: 1,
        path: "/api/package-revisions/rollback",
        method: "POST",
        body: "{}",
      },
      { schemaVersion: 1, path: "/api/bots", method: "POST", body: "{}" },
      { schemaVersion: 1, path: "/api/bots/primary/settings", method: "GET" },
      { schemaVersion: 1, path: "/api/bots/primary/sheep", method: "GET" },
      {
        schemaVersion: 1,
        path: "/api/bots/primary/notifications",
        method: "POST",
        body: "{}",
      },
      {
        schemaVersion: 1,
        path: "/api/bots/primary/turns",
        method: "POST",
        body: "{}",
      },
      {
        schemaVersion: 1,
        path: "/api/bots/primary/turns/run-1",
        method: "GET",
      },
      {
        schemaVersion: 1,
        path: "/api/bots/primary/turns/run-1/reconcile",
        method: "POST",
        body: '{"action":"resume"}',
      },
      {
        schemaVersion: 1,
        path: "/api/connections",
        method: "POST",
        body: "{}",
      },
      {
        schemaVersion: 1,
        path: "/api/connection-commands?packageId=provider-ollama-cloud&commandId=connect-1",
        method: "GET",
      },
      {
        schemaVersion: 1,
        path: "/api/plugins/composio/connections",
        method: "POST",
        body: "{}",
      },
      {
        schemaVersion: 1,
        path: "/api/plugins/composio/connections/connection-1/revoke",
        method: "POST",
      },
    ] as const) {
      expect(decodeDesktopApiRequest(request)).toEqual(request);
    }
    expect(() =>
      decodeDesktopApiRequest({
        schemaVersion: 1,
        path: "/api/auth/session",
        method: "GET",
      }),
    ).toThrow("invalid API request");
    expect(() =>
      decodeDesktopApiRequest({
        schemaVersion: 1,
        path: "/api/settings",
        method: "DELETE",
      }),
    ).toThrow("invalid API request");
    for (const path of [
      "/api/connection-commands?packageId=provider-ollama-cloud",
      "/api/connection-commands?packageId=provider-ollama-cloud&commandId=connect-1&extra=true",
      "/api/connection-commands?packageId=bad%2Fpackage&commandId=connect-1",
      "/api/connection-commands?packageId=provider-ollama-cloud&commandId=lost%20response",
      "/api/connection-commands?packageId=provider-ollama-cloud&commandId=connect@1",
    ]) {
      expect(() =>
        decodeDesktopApiRequest({ schemaVersion: 1, path, method: "GET" }),
      ).toThrow("invalid API request");
    }
    for (const botId of ["bad:bot", "bad@bot", "b".repeat(129)]) {
      expect(() =>
        decodeDesktopApiRequest({
          schemaVersion: 1,
          path: `/api/bots/${botId}/settings`,
          method: "GET",
        }),
      ).toThrow("invalid API request");
    }
  });

  test("decodes response envelopes before exposing them to the renderer", () => {
    expect(
      decodeDesktopApiResponse({
        schemaVersion: 1,
        status: 200,
        contentType: "application/json",
        body: "{}",
      }),
    ).toEqual({
      schemaVersion: 1,
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
    expect(() =>
      decodeDesktopApiResponse({
        schemaVersion: 1,
        status: "200",
        contentType: null,
        body: "{}",
      }),
    ).toThrow("invalid API response");
  });

  test("allows only HTTPS external authorization targets", () => {
    expect(
      decodeExternalAuthorizationUrl("https://connect.example/authorize"),
    ).toBe("https://connect.example/authorize");
    expect(() => decodeExternalAuthorizationUrl("javascript:alert(1)")).toThrow(
      "invalid external authorization URL",
    );
    expect(() =>
      decodeExternalAuthorizationUrl(
        "https://user:secret@connect.example/authorize",
      ),
    ).toThrow("invalid external authorization URL");
    expect(() =>
      decodeExternalAuthorizationUrl(
        "https://connect.example/authorize#complete",
      ),
    ).toThrow("invalid external authorization URL");
  });

  test("requires exact versioned Electron envelopes", () => {
    expect(() =>
      decodeDesktopApiRequest({ path: "/app-manifest", method: "GET" }),
    ).toThrow("invalid API request");
    expect(() =>
      decodeDesktopApiRequest({
        schemaVersion: 1,
        path: "/app-manifest",
        method: "GET",
        extra: true,
      }),
    ).toThrow("invalid API request");
    expect(() =>
      decodeDesktopApiResponse({
        schemaVersion: 2,
        status: 200,
        contentType: null,
        body: "",
      }),
    ).toThrow("invalid API response");

    expect(
      decodeDesktopExternalAuthorizationRequest({
        schemaVersion: 1,
        url: "https://connect.example/authorize",
        nativeReturnNonce: "nonce-1",
      }),
    ).toEqual({
      schemaVersion: 1,
      url: "https://connect.example/authorize",
      nativeReturnNonce: "nonce-1",
    });
    expect(() =>
      decodeDesktopExternalAuthorizationRequest({
        schemaVersion: 1,
        url: "https://connect.example/authorize",
        nativeReturnNonce: "nonce-1",
        extra: true,
      }),
    ).toThrow("invalid external authorization request");

    expect(
      decodeExternalAuthorizationAcknowledgement({
        schemaVersion: 1,
        status: "accepted",
      }),
    ).toEqual({ schemaVersion: 1, status: "accepted" });
    expect(() => decodeExternalAuthorizationAcknowledgement({})).toThrow(
      "invalid external authorization acknowledgement",
    );
  });

  test("decodes the exact Better Auth desktop callback target", () => {
    expect(
      decodeDesktopAuthCallbackToken(
        "com.frockbot.desktop://auth/callback#token=token-1",
      ),
    ).toBe("token-1");
    for (const value of [
      "com.frockbot.desktop:/auth/callback#token=token-1",
      "com.frockbot.desktop://auth/other#token=token-1",
      "com.frockbot.desktop://auth/other/../callback#token=token-1",
      "com.frockbot.desktop://other/callback#token=token-1",
      "com.frockbot.desktop://auth/callback?next=/#token=token-1",
      "com.frockbot.desktop://auth/callback#token=",
    ]) {
      expect(decodeDesktopAuthCallbackToken(value)).toBeUndefined();
    }
  });

  test("strictly decodes every desktop auth request, response, and event", () => {
    expect(
      decodeDesktopAuthRequest({ schemaVersion: 1, type: "auth/get-user" }),
    ).toEqual({ schemaVersion: 1, type: "auth/get-user" });
    expect(
      decodeDesktopAuthRequest({
        schemaVersion: 1,
        type: "auth/request",
        provider: "google",
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "auth/request",
      provider: "google",
    });
    const hiddenSignOut = { schemaVersion: 1, type: "auth/sign-out" };
    Object.defineProperty(hiddenSignOut, "hidden", { value: true });
    const symbolSignOut = { schemaVersion: 1, type: "auth/sign-out" };
    Object.defineProperty(symbolSignOut, Symbol("hidden"), { value: true });
    for (const invalid of [hiddenSignOut, symbolSignOut]) {
      expect(() => decodeDesktopAuthRequest(invalid)).toThrow(
        "invalid desktop auth request",
      );
    }

    const hiddenApiRequest = {
      schemaVersion: 1,
      path: "/app-manifest",
      method: "GET",
    };
    Object.defineProperty(hiddenApiRequest, "hidden", { value: true });
    const symbolApiRequest = {
      schemaVersion: 1,
      path: "/app-manifest",
      method: "GET",
    };
    Object.defineProperty(symbolApiRequest, Symbol("hidden"), { value: true });
    for (const invalid of [hiddenApiRequest, symbolApiRequest]) {
      expect(() => decodeDesktopApiRequest(invalid)).toThrow(
        "invalid API request",
      );
    }
    const user = { id: "user-1", name: "Alice", email: "a@example.com" };
    expect(
      decodeDesktopAuthUserResponse({
        schemaVersion: 1,
        type: "auth/user",
        user,
      }),
    ).toEqual({ schemaVersion: 1, type: "auth/user", user });
    expect(
      decodeDesktopAuthAcknowledgement({
        schemaVersion: 1,
        type: "auth/accepted",
      }),
    ).toEqual({ schemaVersion: 1, type: "auth/accepted" });
    expect(
      decodeDesktopAuthEvent({
        schemaVersion: 1,
        type: "auth/authenticated",
        user,
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "auth/authenticated",
      user,
    });
    for (const invalid of [
      { type: "auth/get-user" },
      { schemaVersion: 2, type: "auth/sign-out" },
      { schemaVersion: 1, type: "auth/get-user", extra: true },
      {
        schemaVersion: 1,
        type: "auth/request",
        provider: "google",
        extra: true,
      },
    ]) {
      expect(() => decodeDesktopAuthRequest(invalid)).toThrow(
        "invalid desktop auth request",
      );
    }
    expect(() =>
      decodeDesktopAuthUserResponse({
        schemaVersion: 1,
        type: "auth/user",
        user: { ...user, token: "secret" },
      }),
    ).toThrow("invalid desktop auth user");
    expect(() =>
      decodeDesktopAuthEvent({
        schemaVersion: 1,
        type: "auth/error",
        message: "failed",
        extra: true,
      }),
    ).toThrow("invalid desktop auth event");
  });
});

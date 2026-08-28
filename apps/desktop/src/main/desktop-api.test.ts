import { describe, expect, test } from "bun:test";
import {
  decodeDesktopApiRequest,
  decodeDesktopApiResponse,
  decodeDesktopExternalAuthorizationRequest,
  decodeExternalAuthorizationAcknowledgement,
  decodeExternalAuthorizationUrl,
} from "./desktop-api.js";

describe("desktop hosted protocol", () => {
  test("admits only the hosted settings, Connection, notification, manifest, and Turn routes", () => {
    for (const request of [
      { schemaVersion: 1, path: "/app-manifest", method: "GET" },
      { schemaVersion: 1, path: "/api/settings", method: "POST", body: "{}" },
      { schemaVersion: 1, path: "/api/bots/primary/settings", method: "GET" },
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
        path: "/api/bots/primary/turns/run-1/reconcile",
        method: "POST",
        body: '{"action":"resume"}',
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
});

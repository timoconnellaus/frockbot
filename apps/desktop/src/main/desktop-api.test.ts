import { describe, expect, test } from "bun:test";
import {
  decodeDesktopApiRequest,
  decodeExternalAuthorizationUrl,
} from "./desktop-api.js";

describe("desktop hosted protocol", () => {
  test("admits only the hosted settings, Connection, notification, manifest, and Turn routes", () => {
    for (const request of [
      { path: "/app-manifest", method: "GET" },
      { path: "/api/settings", method: "POST", body: "{}" },
      { path: "/api/bots/primary/settings", method: "GET" },
      { path: "/api/bots/primary/notifications", method: "POST", body: "{}" },
      { path: "/api/bots/primary/turns", method: "POST", body: "{}" },
      {
        path: "/api/plugins/composio/connections",
        method: "POST",
        body: "{}",
      },
      {
        path: "/api/plugins/composio/connections/connection-1/revoke",
        method: "POST",
      },
    ]) {
      expect(decodeDesktopApiRequest(request)).toEqual(request);
    }
    expect(() =>
      decodeDesktopApiRequest({ path: "/api/auth/session", method: "GET" }),
    ).toThrow("invalid API request");
    expect(() =>
      decodeDesktopApiRequest({ path: "/api/settings", method: "DELETE" }),
    ).toThrow("invalid API request");
  });

  test("allows only HTTPS external authorization targets", () => {
    expect(
      decodeExternalAuthorizationUrl("https://connect.example/authorize"),
    ).toBe("https://connect.example/authorize");
    expect(() => decodeExternalAuthorizationUrl("javascript:alert(1)")).toThrow(
      "invalid external authorization URL",
    );
  });
});

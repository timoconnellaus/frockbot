import { describe, expect, test } from "bun:test";
import { createCapacitorConfig } from "./capacitor.config.ts";

describe("createCapacitorConfig", () => {
  test("uses bundled assets and safe-area system bar handling", () => {
    const config = createCapacitorConfig({});
    expect(config.server).toEqual({
      androidScheme: "frockbot",
    });
    expect(config.plugins).toEqual({
      SystemBars: {
        insetsHandling: "css",
        style: "DARK",
      },
    });
    expect(config.backgroundColor).toBe("#1f1e24");
  });

  test("uses an HTTP live-reload origin and enables Android cleartext", () => {
    expect(
      createCapacitorConfig({
        FROCKBOT_MOBILE_DEV_SERVER_URL: " http://100.119.164.113:5174/ ",
      }).server,
    ).toEqual({
      androidScheme: "frockbot",
      url: "http://100.119.164.113:5174",
      cleartext: true,
    });
  });

  test("keeps cleartext disabled for an HTTPS live-reload origin", () => {
    expect(
      createCapacitorConfig({
        FROCKBOT_MOBILE_DEV_SERVER_URL: "https://dev.tail.example",
      }).server,
    ).toEqual({
      androidScheme: "frockbot",
      url: "https://dev.tail.example",
      cleartext: false,
    });
  });

  test("passes the Google Web OAuth client ID to the native auth plugin", () => {
    const config = createCapacitorConfig({
      FROCKBOT_HOSTED_APP_URL: "https://bot.frockbot.com",
      FROCKBOT_GOOGLE_WEB_CLIENT_ID: "123-example.apps.googleusercontent.com",
    });

    expect(config.plugins).toEqual({
      SystemBars: { insetsHandling: "css", style: "DARK" },
      FrockBotGoogleAuth: {
        serverClientId: "123-example.apps.googleusercontent.com",
      },
    });
  });

  test("requires the Google Web OAuth client ID for a hosted build", () => {
    expect(() =>
      createCapacitorConfig({
        FROCKBOT_HOSTED_APP_URL: "https://bot.frockbot.com",
      }),
    ).toThrow("FROCKBOT_GOOGLE_WEB_CLIENT_ID is required");
  });

  test("rejects a non-Web Google OAuth client ID", () => {
    expect(() =>
      createCapacitorConfig({
        FROCKBOT_GOOGLE_WEB_CLIENT_ID: "android-client-id",
      }),
    ).toThrow(
      "FROCKBOT_GOOGLE_WEB_CLIENT_ID must be a Google Web OAuth client ID",
    );
  });

  test("rejects a live-reload URL with credentials or a path", () => {
    expect(() =>
      createCapacitorConfig({
        FROCKBOT_MOBILE_DEV_SERVER_URL:
          "http://developer:secret@100.119.164.113:5174/path",
      }),
    ).toThrow("FROCKBOT_MOBILE_DEV_SERVER_URL must be an http(s) origin");
  });
});

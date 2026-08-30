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
      },
    });
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

  test("rejects a live-reload URL with credentials or a path", () => {
    expect(() =>
      createCapacitorConfig({
        FROCKBOT_MOBILE_DEV_SERVER_URL:
          "http://developer:secret@100.119.164.113:5174/path",
      }),
    ).toThrow("FROCKBOT_MOBILE_DEV_SERVER_URL must be an http(s) origin");
  });
});

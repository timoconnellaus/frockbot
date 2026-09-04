import { describe, expect, test } from "bun:test";
import {
  isAndroidNativeShell,
  requestNativeGoogleCredential,
} from "./native-google.ts";

describe("native Google sign-in", () => {
  test("detects only the native Android bridge", () => {
    expect(
      isAndroidNativeShell({
        isNativePlatform: () => true,
        getPlatform: () => "android",
      }),
    ).toBe(true);
    expect(
      isAndroidNativeShell({
        isNativePlatform: () => true,
        getPlatform: () => "ios",
      }),
    ).toBe(false);
    expect(
      isAndroidNativeShell({
        isNativePlatform: () => false,
        getPlatform: () => "web",
      }),
    ).toBe(false);
  });

  test("decodes the bounded native credential", async () => {
    await expect(
      requestNativeGoogleCredential({
        signIn: () =>
          Promise.resolve({ idToken: "header.payload.signature", nonce: "n" }),
      }),
    ).resolves.toEqual({
      idToken: "header.payload.signature",
      nonce: "n",
    });
  });

  test("rejects malformed native responses", async () => {
    await expect(
      requestNativeGoogleCredential({
        signIn: () => Promise.resolve({ idToken: "token" }),
      }),
    ).rejects.toThrow("Google returned an invalid sign-in response.");
  });
});

import { describe, expect, test } from "bun:test";
import {
  resolveHostedDesktopOrigins,
  startHostedDesktopApplication,
} from "./hosted-application.js";

const APPLICATION_ORIGIN = "https://app.example.com";
const AUTH_ORIGIN = "https://auth.example.com";

describe("desktop hosted application startup", () => {
  test("requires both hosted origins before startup", () => {
    expect(() => resolveHostedDesktopOrigins(undefined, AUTH_ORIGIN)).toThrow(
      "FROCKBOT_APPLICATION_URL is required for desktop startup",
    );
    expect(() =>
      resolveHostedDesktopOrigins(APPLICATION_ORIGIN, undefined),
    ).toThrow("FROCKBOT_AUTH_BASE_URL is required for desktop startup");
  });

  test.each([
    ["not a URL", "must be a valid URL"],
    ["file:///tmp/frockbot", "must use HTTPS or loopback HTTP"],
    ["http://app.example.com", "must use HTTPS or loopback HTTP"],
    ["https://user:secret@app.example.com", "must not contain credentials"],
    ["https://app.example.com/bots", "must be an origin without a path"],
    [
      "https://app.example.com?mode=desktop",
      "must be an origin without a path",
    ],
    ["https://app.example.com/#desktop", "must be an origin without a path"],
  ])("rejects unsafe application origin %s", (value, failure) => {
    expect(() => resolveHostedDesktopOrigins(value, AUTH_ORIGIN)).toThrow(
      `FROCKBOT_APPLICATION_URL ${failure}`,
    );
  });

  test.each([
    ["not a URL", "must be a valid URL"],
    ["file:///tmp/frockbot", "must use HTTPS or loopback HTTP"],
    ["http://auth.example.com", "must use HTTPS or loopback HTTP"],
    ["https://user:secret@auth.example.com", "must not contain credentials"],
    ["https://auth.example.com/api", "must be an origin without a path"],
    [
      "https://auth.example.com?mode=desktop",
      "must be an origin without a path",
    ],
    ["https://auth.example.com/#desktop", "must be an origin without a path"],
  ])("rejects unsafe auth origin %s", (value, failure) => {
    expect(() =>
      resolveHostedDesktopOrigins(APPLICATION_ORIGIN, value),
    ).toThrow(`FROCKBOT_AUTH_BASE_URL ${failure}`);
  });

  test("normalizes HTTPS origins", () => {
    expect(
      resolveHostedDesktopOrigins(
        "  HTTPS://APP.EXAMPLE.COM:443/  ",
        "https://AUTH.EXAMPLE.COM:443/",
      ),
    ).toEqual({
      applicationUrl: APPLICATION_ORIGIN,
      authBaseUrl: AUTH_ORIGIN,
    });
  });

  test.each([
    ["http://localhost:5173", "http://127.0.0.1:8787"],
    ["http://[::1]:5173", "http://[::1]:8787"],
  ])("permits explicit loopback development origins", (application, auth) => {
    expect(resolveHostedDesktopOrigins(application, auth)).toEqual({
      applicationUrl: application,
      authBaseUrl: auth,
    });
  });

  test("fails before starting a desktop controller for either invalid origin", async () => {
    let starts = 0;
    const start = () => {
      starts += 1;
      return Promise.resolve("started");
    };

    await expect(
      startHostedDesktopApplication(undefined, AUTH_ORIGIN, start),
    ).rejects.toThrow(
      "FROCKBOT_APPLICATION_URL is required for desktop startup",
    );
    await expect(
      startHostedDesktopApplication(APPLICATION_ORIGIN, undefined, start),
    ).rejects.toThrow("FROCKBOT_AUTH_BASE_URL is required for desktop startup");
    expect(starts).toBe(0);
  });

  test("starts the desktop controller only with normalized hosted origins", async () => {
    const origins: unknown[] = [];

    await expect(
      startHostedDesktopApplication(
        "https://APP.EXAMPLE.COM/",
        "https://AUTH.EXAMPLE.COM/",
        (resolved) => {
          origins.push(resolved);
          return Promise.resolve("started");
        },
      ),
    ).resolves.toBe("started");
    expect(origins).toEqual([
      { applicationUrl: APPLICATION_ORIGIN, authBaseUrl: AUTH_ORIGIN },
    ]);
  });
});

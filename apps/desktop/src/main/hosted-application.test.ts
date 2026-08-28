import { describe, expect, test } from "bun:test";
import {
  resolveHostedApplicationUrl,
  startHostedDesktopApplication,
} from "./hosted-application.js";

describe("desktop hosted application startup", () => {
  test.each([undefined, "", "   "])(
    "rejects missing hosted configuration before startup",
    (value) => {
      expect(() => resolveHostedApplicationUrl(value)).toThrow(
        "FROCKBOT_APPLICATION_URL is required for desktop startup",
      );
    },
  );

  test("rejects malformed and non-HTTP application URLs", () => {
    expect(() => resolveHostedApplicationUrl("not a URL")).toThrow(
      "FROCKBOT_APPLICATION_URL must be a valid URL",
    );
    expect(() => resolveHostedApplicationUrl("file:///tmp/frockbot")).toThrow(
      "FROCKBOT_APPLICATION_URL must use HTTP or HTTPS",
    );
  });

  test("selects only the hosted HTTP protocol", () => {
    expect(resolveHostedApplicationUrl("  https://app.example.com/bots  ")).toBe(
      "https://app.example.com/bots",
    );
    expect(resolveHostedApplicationUrl("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  test("fails before starting a desktop controller when configuration is missing", async () => {
    let starts = 0;

    await expect(
      startHostedDesktopApplication(undefined, () => {
        starts += 1;
        return Promise.resolve("started");
      }),
    ).rejects.toThrow(
      "FROCKBOT_APPLICATION_URL is required for desktop startup",
    );
    expect(starts).toBe(0);
  });

  test("starts the desktop controller only with the hosted URL", async () => {
    const urls: string[] = [];

    await expect(
      startHostedDesktopApplication("https://app.example.com", (url) => {
        urls.push(url);
        return Promise.resolve("started");
      }),
    ).resolves.toBe("started");
    expect(urls).toEqual(["https://app.example.com"]);
  });
});

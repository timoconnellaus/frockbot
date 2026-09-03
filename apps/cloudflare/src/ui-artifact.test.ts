import { describe, expect, test } from "bun:test";
import { packageUiCspV1, servePackageUiArtifact } from "./gateway.ts";

describe("Package UI artifact route", () => {
  const hash = "a".repeat(64);
  const artifacts = {
    load: () => Promise.reject(new Error("unused")),
    loadPackageUiArtifact: (requested: string) =>
      Promise.resolve(
        requested === hash ? "<!doctype html><h1>Page</h1>" : undefined,
      ),
  };

  test("serves immutable anonymous HTML with the restrictive CSP", async () => {
    const request = new Request(
      `https://ui.bot.frockbot.com/packages/${hash}.html`,
    );
    const response = await servePackageUiArtifact(
      request,
      new URL(request.url),
      artifacts,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      packageUiCspV1(new URL(request.url)),
    );
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toContain("Page");
  });

  test("names its own origin to nest and only the gateway to connect", () => {
    const csp = packageUiCspV1(
      new URL(`https://ui.bot.frockbot.com/packages/${hash}.html`),
    );
    // A canvas page nests the Applet's UI on the same anonymous origin.
    expect(csp).toContain("frame-src https://ui.bot.frockbot.com");
    // The Applet's UI opens its viewer socket back to the gateway, and to
    // nothing else: no other origin appears in connect-src.
    expect(csp).toContain("connect-src https://bot.frockbot.com wss:");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("*");
    expect(
      packageUiCspV1(new URL("http://ui.localhost:8787/packages/a.html")),
    ).toContain("connect-src http://localhost:8787 wss:");
  });

  test("serves no application route on the artifact host", async () => {
    const request = new Request("https://ui.bot.frockbot.com/");
    expect(
      (await servePackageUiArtifact(request, new URL(request.url), artifacts))
        .status,
    ).toBe(404);
  });
});

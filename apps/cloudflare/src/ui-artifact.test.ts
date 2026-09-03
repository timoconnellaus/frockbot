import { describe, expect, test } from "bun:test";
import {
  PACKAGE_UI_CSP,
  packageUiCspV1,
  servePackageUiArtifact,
} from "./gateway.ts";

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
    // The restrictive base, plus the one hole an Applet page needs: a socket
    // back to its own account's gateway and nowhere else (ADR 0022 §4).
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp.startsWith(PACKAGE_UI_CSP)).toBe(true);
    expect(csp).toBe(packageUiCspV1(new URL(request.url)));
    expect(csp).toContain(
      "connect-src https://bot.frockbot.com wss://bot.frockbot.com",
    );
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toContain("Page");
  });

  test("names its own origin to nest and only its gateway to connect", () => {
    const csp = packageUiCspV1(
      new URL("https://ui.bot.example.com/packages/x.html"),
    );
    expect(csp).toContain(
      "connect-src https://bot.example.com wss://bot.example.com",
    );
    // A canvas page nests the Applet's UI on the same anonymous origin.
    expect(csp).toContain("frame-src https://ui.bot.example.com");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("*");
    // A host that is already the gateway (local development) maps to itself.
    expect(
      packageUiCspV1(new URL("http://ui.localhost:8787/packages/x.html")),
    ).toContain("connect-src http://localhost:8787 ws://localhost:8787");
  });

  test("serves no application route on the artifact host", async () => {
    const request = new Request("https://ui.bot.frockbot.com/");
    expect(
      (await servePackageUiArtifact(request, new URL(request.url), artifacts))
        .status,
    ).toBe(404);
  });
});

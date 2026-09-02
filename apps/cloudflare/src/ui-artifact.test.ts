import { describe, expect, test } from "bun:test";
import { PACKAGE_UI_CSP, servePackageUiArtifact } from "./gateway.ts";

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
      PACKAGE_UI_CSP,
    );
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toContain("Page");
  });

  test("serves no application route on the artifact host", async () => {
    const request = new Request("https://ui.bot.frockbot.com/");
    expect(
      (await servePackageUiArtifact(request, new URL(request.url), artifacts))
        .status,
    ).toBe(404);
  });
});

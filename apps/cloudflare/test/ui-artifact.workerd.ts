import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { packageUiCspV1, servePackageUiArtifact } from "../src/gateway.ts";

describe("Package UI artifact route in workerd", () => {
  test("streams R2-backed HTML under the immutable CSP", async () => {
    const html = "<!doctype html><script>window.frockbot.resize()</script>";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(html),
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await env.APPLICATION_ARTIFACTS.put(`packages/${hash}.html`, html);
    const artifacts = {
      load: () => Promise.reject(new Error("unused")),
      loadPackageUiArtifact: async (contentHash: string) => {
        const object = await env.APPLICATION_ARTIFACTS.get(
          `packages/${contentHash}.html`,
        );
        return object?.text();
      },
    };
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
    // `no-transform` rides with the immutability: the artifact is addressed by
    // the hash of its bytes, so the edge is asked not to rewrite them — which
    // is also what keeps the zone's injected analytics beacon out of a frame
    // whose policy would refuse it.
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(await response.text()).toBe(html);
  });
});

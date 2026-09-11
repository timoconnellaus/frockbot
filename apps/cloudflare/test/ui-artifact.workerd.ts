import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { packageUiCspV1, servePackageUiArtifact } from "../src/gateway.ts";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The bucket-backed store, counting how often the route reaches it. */
function bucketArtifacts() {
  const reads: string[] = [];
  return {
    reads,
    artifacts: {
      load: () => Promise.reject(new Error("unused")),
      loadPackageUiArtifact: async (contentHash: string) => {
        reads.push(contentHash);
        const object = await env.APPLICATION_ARTIFACTS.get(
          `packages/${contentHash}.html`,
        );
        return object?.text();
      },
    },
  };
}

describe("Package UI artifact route in workerd", () => {
  test("streams R2-backed HTML under the immutable CSP", async () => {
    const html = "<!doctype html><script>window.frockbot.resize()</script>";
    const hash = await sha256Hex(html);
    await env.APPLICATION_ARTIFACTS.put(`packages/${hash}.html`, html);
    const { artifacts } = bucketArtifacts();
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

  test("the edge cache answers the second read, the 304 and the HEAD without the bucket", async () => {
    const html = `<!doctype html><h1>cached ${crypto.randomUUID()}</h1>`;
    const hash = await sha256Hex(html);
    await env.APPLICATION_ARTIFACTS.put(`packages/${hash}.html`, html);
    const { artifacts, reads } = bucketArtifacts();
    const url = `https://ui.bot.frockbot.com/packages/${hash}.html`;
    const filled: Promise<unknown>[] = [];
    const serve = (init?: RequestInit) => {
      const request = new Request(url, init);
      return servePackageUiArtifact(
        request,
        new URL(request.url),
        artifacts,
        (promise) => filled.push(promise),
      );
    };

    const first = await serve();
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(html);
    expect(reads).toEqual([hash]);
    await Promise.all(filled);

    // The bucket copy goes away; the edge copy is what answers now, with the
    // same headers the first answer carried.
    await env.APPLICATION_ARTIFACTS.delete(`packages/${hash}.html`);
    const second = await serve();
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(html);
    expect(second.headers.get("etag")).toBe(`"${hash}"`);
    expect(second.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(second.headers.get("content-security-policy")).toBe(
      packageUiCspV1(new URL(url)),
    );

    const notModified = await serve({
      headers: { "if-none-match": `"${hash}"` },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    const head = await serve({ method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe(`"${hash}"`);

    expect(reads).toEqual([hash]);
  });
});

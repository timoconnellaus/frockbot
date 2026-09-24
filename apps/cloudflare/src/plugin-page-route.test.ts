import { describe, expect, test } from "bun:test";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  isPluginPagePathV1,
  PLUGIN_PAGE_CSP_V1,
  servePluginPageV1,
} from "./plugin-page-route.ts";

const PAGE = "<!doctype html><html><head></head><body>score</body></html>";

async function served(
  init: { method?: string; headers?: Record<string, string> } = {},
  pages: Record<string, string> = {},
) {
  const hash = await sha256HexTextV1(PAGE);
  const url = new URL(`https://bot.example.com/plugin-pages/${hash}.html`);
  return {
    hash,
    response: await servePluginPageV1(
      new Request(url, init),
      url,
      async (contentHash) => ({ [hash]: PAGE, ...pages })[contentHash],
    ),
  };
}

function policy(response: Response): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of (
    response.headers.get("content-security-policy") ?? ""
  ).split(";")) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  return directives;
}

describe("a Plugin page on the app origin", () => {
  test("is served only under /plugin-pages/, named by its hash", () => {
    expect(isPluginPagePathV1(`/plugin-pages/${"a".repeat(64)}.html`)).toBe(
      true,
    );
    for (const path of [
      "/plugin-pages/",
      `/plugin-pages/${"a".repeat(63)}.html`,
      `/plugin-pages/${"A".repeat(64)}.html`,
      `/packages/${"a".repeat(64)}.html`,
      `/plugin-pages/${"a".repeat(64)}.html/x`,
    ]) {
      expect(isPluginPagePathV1(path)).toBe(false);
    }
  });

  test("runs as an opaque origin that may load and reach nothing", async () => {
    const { response } = await served();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
    const directives = policy(response);
    // However it is opened, the document is not the app: no cookie, no
    // storage, no same-origin request of the app's.
    expect(directives.get("sandbox")).toEqual(["allow-scripts"]);
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("connect-src")).toEqual([
      "https://cloudflareinsights.com",
    ]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'self'"]);
    expect(PLUGIN_PAGE_CSP_V1).not.toContain("allow-same-origin");
    expect(PLUGIN_PAGE_CSP_V1).not.toContain("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  test("answers a revalidation without reading the page again", async () => {
    const hash = await sha256HexTextV1(PAGE);
    const url = new URL(`https://bot.example.com/plugin-pages/${hash}.html`);
    let reads = 0;
    const response = await servePluginPageV1(
      new Request(url, { headers: { "if-none-match": `"${hash}"` } }),
      url,
      async () => {
        reads += 1;
        return PAGE;
      },
    );
    expect(response.status).toBe(304);
    expect(reads).toBe(0);
    expect(policy(response).get("sandbox")).toEqual(["allow-scripts"]);
  });

  test("serves nothing it cannot prove, and nothing but GET and HEAD", async () => {
    const hash = "b".repeat(64);
    const url = new URL(`https://bot.example.com/plugin-pages/${hash}.html`);
    expect(
      (await servePluginPageV1(new Request(url), url, async () => PAGE)).status,
    ).toBe(502);
    expect(
      (await servePluginPageV1(new Request(url), url, async () => undefined))
        .status,
    ).toBe(404);
    expect(
      (await servePluginPageV1(new Request(url), url, undefined)).status,
    ).toBe(404);
    expect((await served({ method: "POST" })).response.status).toBe(405);
    const head = (await served({ method: "HEAD" })).response;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

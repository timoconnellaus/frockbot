/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import worker, { canonicalUrl, withSecurityHeaders } from "./index";

function assets(response: Response) {
  return {
    fetch: () => Promise.resolve(response),
  };
}

describe("marketing worker", () => {
  test("redirects www to the apex domain and preserves the request target", async () => {
    const request = new Request("http://www.frockbot.com/features?from=nav");
    expect(canonicalUrl(request)?.toString()).toBe(
      "https://frockbot.com/features?from=nav",
    );

    const response = await worker.fetch(request, {
      ASSETS: assets(new Response("unused")),
    });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://frockbot.com/features?from=nav",
    );
  });

  test("serves static assets with browser security headers", async () => {
    const response = await worker.fetch(
      new Request("https://frockbot.com/"),
      {
        ASSETS: assets(
          new Response("<!doctype html>", {
            headers: { "content-type": "text/html" },
          }),
        ),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  test("preserves an asset response while adding headers", async () => {
    const original = new Response("not found", { status: 404 });
    const secured = withSecurityHeaders(original);
    expect(secured.status).toBe(404);
    expect(await secured.text()).toBe("not found");
    expect(secured.headers.get("x-frame-options")).toBe("DENY");
  });
});

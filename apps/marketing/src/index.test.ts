import { describe, expect, test } from "bun:test";
import worker, { canonicalUrl, withSecurityHeaders } from "./index";

function assets(response: Response) {
  return {
    fetch: () => Promise.resolve(response),
  };
}

const publicFile = (path: string) =>
  Bun.file(new URL(`../public/${path}`, import.meta.url)).text();

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
    const response = await worker.fetch(new Request("https://frockbot.com/"), {
      ASSETS: assets(
        new Response("<!doctype html>", {
          headers: { "content-type": "text/html" },
        }),
      ),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-opener-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
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

  test.each(["privacy", "terms"])(
    "serves the %s policy route through the secured asset worker",
    async (route: string) => {
      let requestedPath = "";
      const response = await worker.fetch(
        new Request(`https://frockbot.com/${route}/`),
        {
          ASSETS: {
            fetch: (request) => {
              requestedPath = new URL(request.url).pathname;
              return Promise.resolve(
                new Response("<!doctype html>", {
                  headers: { "content-type": "text/html" },
                }),
              );
            },
          },
        },
      );

      expect(requestedPath).toBe(`/${route}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain(
        "default-src 'self'",
      );
    },
  );
});

describe("legal policy pages", () => {
  test("homepage links to both legal routes", async () => {
    const homepage = await publicFile("index.html");
    expect(homepage).toContain('href="/privacy/"');
    expect(homepage).toContain('href="/terms/"');
  });

  test.each(["index.html", "privacy/index.html", "terms/index.html"])(
    "%s uses the app icon and pink Bot wordmark",
    async (path: string) => {
      const page = await publicFile(path);
      expect(page).toContain('src="/assets/app-icon.png"');
      expect(page).toContain('Frock<span class="brand-accent">Bot</span>');
    },
  );

  test("brand artwork preserves the full app icon edges", async () => {
    const styles = await publicFile("styles.css");
    expect(styles).toContain(".brand img { object-fit: contain; }");
    expect(styles).not.toContain(".brand img { border-radius: 50%");
  });

  test("privacy policy covers the evidenced data flows and reciprocal navigation", async () => {
    const privacy = await publicFile("privacy/index.html");
    const normalizedPrivacy = privacy.replace(/\s+/g, " ");

    for (const content of [
      "28 August 2026",
      "Tim O'Connell",
      "privacy@frockbot.com",
      "Google sign-in",
      "Cloudflare Workers",
      "Durable Objects",
      "D1",
      "R2",
      "Vectorize",
      "Workers AI",
      "OpenAI-compatible provider",
      "persistent memory files",
      "Fly.io Sprite",
      "Local desktop settings",
    ]) {
      expect(normalizedPrivacy).toContain(content);
    }
    expect(privacy).toContain('href="/"');
    expect(privacy).toContain('href="/terms/"');
    expect(privacy).not.toContain("we do not sell");
  });

  test("terms include every requested core clause and reciprocal navigation", async () => {
    const terms = await publicFile("terms/index.html");

    for (const sectionId of [
      "acceptable-use",
      "content",
      "availability",
      "warranties",
      "termination",
      "terms-changes",
      "contact",
    ]) {
      expect(terms).toContain(`id="${sectionId}"`);
    }
    for (const content of [
      "28 August 2026",
      "Tim O'Connell",
      "privacy@frockbot.com",
      "laws of Australia",
      "Australian Consumer Law",
    ]) {
      expect(terms).toContain(content);
    }
    expect(terms).toContain('href="/"');
    expect(terms).toContain('href="/privacy/"');
    expect(terms.toLowerCase()).not.toContain("arbitration");
  });
});

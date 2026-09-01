import { describe, expect, test } from "bun:test";
import worker, { canonicalUrl, withSecurityHeaders } from "./index";

function assets(response: Response) {
  return {
    fetch: () => Promise.resolve(response),
  };
}

const publicFile = (path: string) =>
  Bun.file(new URL(`../public/${path}`, import.meta.url)).text();

type StyleRule = {
  selectors: string[];
  declarations: Record<string, string>;
};

function parseDeclarations(block: string) {
  const declarations: Record<string, string> = {};
  for (const entry of block.split(";")) {
    const separator = entry.indexOf(":");
    if (separator === -1) continue;
    const property = entry.slice(0, separator).trim().toLowerCase();
    if (!property) continue;
    declarations[property] = entry.slice(separator + 1).trim();
  }
  return declarations;
}

function headerBrandImageAttributes(page: string) {
  const lockup = page.slice(page.indexOf('<a class="brand"'));
  const start = lockup.indexOf("<img");
  const image = lockup.slice(start, lockup.indexOf(">", start));
  const attributes: Record<string, string> = {};
  for (const [, name, value] of image.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
    attributes[name.toLowerCase()] = value;
  }
  return attributes;
}

function parseStyleRules(source: string): StyleRule[] {
  const rules: StyleRule[] = [];
  const preludes: string[] = [];
  let buffer = "";

  for (const character of source.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (character === "{") {
      preludes.push(buffer.trim());
      buffer = "";
      continue;
    }
    if (character === "}") {
      const prelude = preludes.pop() ?? "";
      if (!prelude.startsWith("@") && buffer.trim()) {
        rules.push({
          selectors: prelude
            .split(",")
            .map((selector) => selector.trim().replace(/\s+/g, " "))
            .filter(Boolean),
          declarations: parseDeclarations(buffer),
        });
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }

  return rules;
}

type RepositoryLink = {
  href: string;
  ariaLabel: string;
  text: string;
  marks: { ariaHidden: string; symbol: string }[];
};

const REPOSITORY_ANCHOR = 'a[href^="https://github.com/"]';

async function drain(rewriter: HTMLRewriter, html: string) {
  await rewriter.transform(new Response(html)).text();
}

async function repositoryLinks(html: string, container: string) {
  const links: RepositoryLink[] = [];
  const current = () => links[links.length - 1];

  await drain(
    new HTMLRewriter()
      .on(`${container} ${REPOSITORY_ANCHOR}`, {
        element(element) {
          links.push({
            href: element.getAttribute("href") ?? "",
            ariaLabel: element.getAttribute("aria-label") ?? "",
            text: "",
            marks: [],
          });
        },
        text(chunk) {
          current().text += chunk.text;
        },
      })
      .on(`${container} ${REPOSITORY_ANCHOR} svg`, {
        element(element) {
          current().marks.push({
            ariaHidden: element.getAttribute("aria-hidden") ?? "",
            symbol: "",
          });
        },
      })
      .on(`${container} ${REPOSITORY_ANCHOR} use`, {
        element(element) {
          const marks = current().marks;
          marks[marks.length - 1].symbol = element.getAttribute("href") ?? "";
        },
      }),
    html,
  );

  return links;
}

async function spriteSymbols(html: string) {
  const symbols: { id: string; viewBox: string; paths: string[] }[] = [];

  await drain(
    new HTMLRewriter()
      .on("symbol", {
        element(element) {
          symbols.push({
            id: element.getAttribute("id") ?? "",
            viewBox: element.getAttribute("viewbox") ?? "",
            paths: [],
          });
        },
      })
      .on("symbol path", {
        element(element) {
          symbols[symbols.length - 1].paths.push(
            element.getAttribute("d") ?? "",
          );
        },
      }),
    html,
  );

  return symbols;
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

describe("homepage product depictions", () => {
  test("keeps the marketing page light while rendering the product workspace dark", async () => {
    const rules = parseStyleRules(await publicFile("styles.css"));
    const declarations = (selector: string) =>
      Object.assign(
        {},
        ...rules
          .filter((rule) => rule.selectors.includes(selector))
          .map((rule) => rule.declarations),
      ) as Record<string, string>;

    expect(declarations(":root")["--product-window"]).toBe("#1f1e24");
    expect(declarations("body").background).toBe("var(--paper)");
    expect(declarations(".workspace").background).toBe("var(--product-window)");
    expect(declarations(".workspace aside").background).toBe(
      "var(--product-sidebar)",
    );
    expect(declarations(".bot-row.active").background).toBe(
      "var(--product-raised)",
    );
    expect(declarations(".workspace-thread").background).toBe(
      "var(--product-thread)",
    );
    expect(declarations(".workspace-panel").background).toBe(
      "var(--product-sidebar)",
    );
    expect(declarations(".workspace-bubble-user").background).toBe(
      "var(--pink)",
    );
  });
});

describe("legal policy pages", () => {
  test("homepage links to both legal routes", async () => {
    const homepage = await publicFile("index.html");
    expect(homepage).toContain('href="/privacy/"');
    expect(homepage).toContain('href="/terms/"');
  });

  test.each([
    ["header", ".site-header"],
    ["footer", ".footer"],
  ])(
    "the %s links to the repository with a labelled, decorative GitHub mark",
    async (_region: string, container: string) => {
      const homepage = await publicFile("index.html");
      const links = await repositoryLinks(homepage, container);

      expect(links).toHaveLength(1);
      const [link] = links;
      expect(link.href).toBe("https://github.com/timoconnellaus/frockbot");
      expect(link.ariaLabel).toBe("FrockBot source code on GitHub");
      expect(link.text.trim()).toBe("");
      expect(link.marks).toEqual([
        { ariaHidden: "true", symbol: "#github-mark" },
      ]);
    },
  );

  test("the referenced GitHub symbol is defined once with real artwork", async () => {
    const symbols = await spriteSymbols(await publicFile("index.html"));

    expect(symbols).toHaveLength(1);
    const [symbol] = symbols;
    expect(symbol.id).toBe("github-mark");
    expect(symbol.viewBox).toBe("0 0 24 24");
    expect(symbol.paths).toHaveLength(1);
    expect(symbol.paths[0].trim()).not.toBe("");
  });

  test("the GitHub sprite host stays out of the rendered layout", async () => {
    const spriteRules = parseStyleRules(await publicFile("styles.css")).filter(
      (rule) => rule.selectors.includes(".svg-sprite"),
    );

    expect(spriteRules).toHaveLength(1);
    expect(spriteRules[0].declarations["display"]).toBe("none");
  });

  test.each(["index.html", "privacy/index.html", "terms/index.html"])(
    "%s uses the app icon and pink Bot wordmark",
    async (path: string) => {
      const page = await publicFile(path);
      expect(page).toContain('src="/assets/app-icon.png"');
      expect(page).toContain('Frock<span class="brand-accent">Bot</span>');

      const headerBrandImage = headerBrandImageAttributes(page);
      expect(headerBrandImage["src"]).toBe("/assets/app-icon.png");
      expect(headerBrandImage["width"]).toBe("48");
      expect(headerBrandImage["height"]).toBe("48");
    },
  );

  test("brand artwork preserves the full app icon edges", async () => {
    const brandImageRules = parseStyleRules(
      await publicFile("styles.css"),
    ).filter((rule) => rule.selectors.includes(".brand img"));

    expect(brandImageRules.length).toBeGreaterThan(0);

    const merged: Record<string, string> = {};
    for (const rule of brandImageRules) {
      Object.assign(merged, rule.declarations);
      expect(rule.declarations["border-radius"]).toBeUndefined();
      expect(rule.declarations["clip-path"]).toBeUndefined();
    }

    expect(merged["object-fit"]).toBe("contain");
    expect(merged["width"]).toBe("42px");
    expect(merged["height"]).toBe("42px");
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

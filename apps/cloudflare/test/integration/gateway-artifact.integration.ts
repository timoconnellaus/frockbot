// Seam S2 (browser → gateway → Worker Loader → R2 artifact) and seam S1
// (gateway auth).
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  APPLICATION_HASH,
  asUser,
  freshUserId,
  ORIGIN,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

describe("the gateway serves the built application artifact", () => {
  // Incident 1: an uppercase `<!DOCTYPE` reached the client where JSON was
  // expected. Nothing before this suite ever loaded the real artifact through
  // the loader, so the shape of what the gateway serves was untested.
  it("serves the artifact's HTML shell with the User's identity and its module", async () => {
    const userId = freshUserId("shell");
    const response = await asUser(userId, "/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(`data-frockbot-user-id="${userId}"`);
    expect(html).toContain(`data-frockbot-auth-mode="development"`);
    expect(html).toContain(
      `data-frockbot-user-application="${APPLICATION_HASH}"`,
    );
    expect(html).toContain('<script type="module" src="/app.js"></script>');
  });

  it("serves /app.js as JavaScript and /app.css as CSS", async () => {
    const userId = freshUserId("assets");

    const script = await asUser(userId, "/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const source = await script.text();
    expect(source.length).toBeGreaterThan(1000);
    expect(source.trimStart().startsWith("<")).toBe(false);

    const style = await asUser(userId, "/app.css");
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toContain("text/css");
  });
});

describe("gateway authentication", () => {
  // `gateway.ts` treats exactly `/`, `/app.js` and `/app.css` as public so an
  // unauthenticated browser can boot the client and then sign in.
  it.each(["/", "/app.js", "/app.css"])(
    "serves %s without an identity",
    async (path) => {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect(response.status).toBe(200);
    },
  );

  it("refuses an unauthenticated non-asset request with JSON, not HTML", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/settings`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "authentication required",
    });
  });

  it("names the authenticated User back to the client", async () => {
    const userId = freshUserId("identity");
    const response = await asUser(userId, "/api/identity");
    expect(response.status).toBe(200);
    // `isAdmin` is part of the projection, and this identity is not the
    // canonical `development` one, so the configured allowlist decides: it
    // holds an address no development identity can present.
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      userId,
      isAdmin: false,
    });
  });
});

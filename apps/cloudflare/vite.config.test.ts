import { describe, expect, test } from "bun:test";
import { isDeploymentAdminV1 } from "./src/admin-identities.js";
import { HOSTED_EMBEDDED_BODY_ATTRIBUTES_V1 } from "./src/user-application.js";
import config from "./vite.config.js";

const DEVELOPMENT_USER_ID = "development";

describe("Cloudflare client development proxy", () => {
  test("declares the fixed development identity in the local document", async () => {
    const html = await Bun.file(
      new URL("./index.html", import.meta.url),
    ).text();

    expect(html).toContain('data-frockbot-user-id="development"');
    expect(html).toContain('data-frockbot-auth-mode="development"');
  });

  // The client throws rather than mounting when any embedded attribute is
  // missing, so the development document has to carry every one of them - the
  // same list the Worker-rendered document is held to.
  test("carries every embedded attribute the client decodes", async () => {
    const html = await Bun.file(
      new URL("./index.html", import.meta.url),
    ).text();

    for (const attribute of HOSTED_EMBEDDED_BODY_ATTRIBUTES_V1) {
      expect(html).toContain(`${attribute}="`);
    }
  });

  // The development document is static, so its admin projection is pinned to
  // the gateway rule that decides the same thing for the proxied identity.
  test("projects the development identity's admin standing", async () => {
    const html = await Bun.file(
      new URL("./index.html", import.meta.url),
    ).text();
    const isAdmin = isDeploymentAdminV1(
      { id: DEVELOPMENT_USER_ID, mode: "development" },
      undefined,
    );

    expect(html).toContain(`data-frockbot-is-admin="${String(isAdmin)}"`);
  });

  test("routes hosted API and manifest requests through the Worker", () => {
    expect(config.server?.proxy).toMatchObject({
      "/api": {
        target: "http://127.0.0.1:8787",
        headers: { "x-frockbot-user-id": "development" },
      },
      "/app-manifest": {
        target: "http://127.0.0.1:8787",
        headers: { "x-frockbot-user-id": "development" },
      },
    });
  });
});

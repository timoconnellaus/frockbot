import { describe, expect, test } from "bun:test";
import config from "./vite.config.js";

describe("Cloudflare client development proxy", () => {
  test("declares the fixed development identity in the local document", async () => {
    const html = await Bun.file(
      new URL("./index.html", import.meta.url),
    ).text();

    expect(html).toContain('data-frockbot-user-id="development"');
    expect(html).toContain('data-frockbot-auth-mode="development"');
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

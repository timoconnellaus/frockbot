import { describe, expect, test } from "bun:test";
import config from "./vite.config.js";

describe("Cloudflare client development proxy", () => {
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

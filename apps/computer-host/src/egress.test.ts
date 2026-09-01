import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMPUTER_HOST_EGRESS_V1 } from "./egress.ts";

/**
 * The Computer host shipped with `enableInternet: false` and an allowlist but
 * without HTTPS interception, and every Computer tool call failed with
 * `Network error: fetch failed` — the Sprites SDK's wrapper around a refused
 * connection. The allowlist was never consulted, because the chain that
 * consults it only sees intercepted traffic and interception is HTTP-only
 * unless HTTPS is asked for.
 *
 * These hold the pairing that made it work, in both directions: an allowlist
 * that admits no protocol the SDK speaks blocks the Computer outright.
 */
describe("Computer host egress", () => {
  test("intercepts HTTPS, because every Sprites call is HTTPS or WSS", () => {
    expect(COMPUTER_HOST_EGRESS_V1.interceptHttps).toBe(true);
  });

  test("allows the Sprites API host the SDK is pointed at", () => {
    expect(COMPUTER_HOST_EGRESS_V1.allowedHosts).toContain("api.sprites.dev");
  });

  test("an allowlist while the internet is off requires HTTPS interception", () => {
    const { enableInternet, allowedHosts, interceptHttps } =
      COMPUTER_HOST_EGRESS_V1;
    if (!enableInternet && allowedHosts.length > 0) {
      expect(interceptHttps).toBe(true);
    }
  });

  test("the container trusts the interception CA at start", () => {
    // Ephemeral and mounted at run time, so it cannot be baked into the image:
    // the entrypoint is the only place this can be done.
    const entrypoint = readFileSync(
      new URL("../container/entrypoint.sh", import.meta.url),
      "utf8",
    );

    expect(entrypoint).toContain(
      "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    );
    expect(entrypoint).toContain("NODE_EXTRA_CA_CERTS");
  });
});

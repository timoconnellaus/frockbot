import { describe, expect, test } from "bun:test";
import { hostedBillingEnabledV1 } from "./billing-readiness.js";

describe("the billing switch", () => {
  test("stays off until Stripe is configured", () => {
    expect(
      hostedBillingEnabledV1({ BETTER_AUTH_URL: "https://bot.frockbot.com" }),
    ).toBe(false);
    expect(
      hostedBillingEnabledV1({
        BETTER_AUTH_URL: "https://bot.frockbot.com",
        STRIPE_SECRET_KEY: "  ",
      }),
    ).toBe(false);
  });
  test("turns on for a hosted origin with a Stripe key", () => {
    expect(
      hostedBillingEnabledV1({
        BETTER_AUTH_URL: "https://bot.frockbot.com",
        STRIPE_SECRET_KEY: "sk_test_x",
      }),
    ).toBe(true);
  });
  test("never bills a local origin, even with a key", () => {
    for (const url of [
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
    ])
      expect(
        hostedBillingEnabledV1({
          BETTER_AUTH_URL: url,
          STRIPE_SECRET_KEY: "sk_test_x",
        }),
      ).toBe(false);
    expect(hostedBillingEnabledV1({ STRIPE_SECRET_KEY: "sk_test_x" })).toBe(
      false,
    );
  });
});

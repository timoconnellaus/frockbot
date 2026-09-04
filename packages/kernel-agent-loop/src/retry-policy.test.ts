import { describe, expect, test } from "bun:test";
import { ModelProviderFailureError } from "@frockbot/kernel-contracts";
import {
  MODEL_RETRY_BACKOFF_CAP_MS_V1,
  modelRetryDelayV1,
  nextModelRetryV1,
} from "./retry-policy.js";

describe("model retry backoff", () => {
  test("uses deterministic equal-jitter exponential delays up to the cap", () => {
    expect(
      [1, 2, 3, 4, 5, 6].map((retry) =>
        modelRetryDelayV1({ retry, random: 1 }),
      ),
    ).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000]);
    expect(modelRetryDelayV1({ retry: 1, random: 0 })).toBe(250);
    expect(MODEL_RETRY_BACKOFF_CAP_MS_V1).toBe(8_000);
  });

  test("honours Retry-After even when it is longer than the backoff cap", () => {
    expect(
      modelRetryDelayV1({ retry: 6, random: 0, retryAfterMs: 12_000 }),
    ).toBe(12_000);
  });

  test("allows unknown once, permanent never, and transient while time remains", () => {
    let now = 1_000;
    const runtime = { now: () => now, random: () => 1 };
    const failure = (classification: "transient" | "permanent" | "unknown") =>
      new ModelProviderFailureError({ classification, reason: "test" });

    expect(
      nextModelRetryV1({
        failure: failure("unknown"),
        attempt: 1,
        deadlineAt: 2_000,
        runtime,
      }),
    ).toEqual({ attempt: 2, delayMs: 500 });
    expect(
      nextModelRetryV1({
        failure: failure("unknown"),
        attempt: 2,
        deadlineAt: 10_000,
        runtime,
      }),
    ).toBeUndefined();
    expect(
      nextModelRetryV1({
        failure: failure("permanent"),
        attempt: 1,
        deadlineAt: 10_000,
        runtime,
      }),
    ).toBeUndefined();

    now = 1_600;
    expect(
      nextModelRetryV1({
        failure: failure("transient"),
        attempt: 1,
        deadlineAt: 2_000,
        runtime,
      }),
    ).toBeUndefined();
  });
});

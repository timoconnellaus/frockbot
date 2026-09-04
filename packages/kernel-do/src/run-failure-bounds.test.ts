// A failure the record could not hold, and the transcript it took with it.
//
// A run's `failure` is whatever an error's `message` happened to be, and
// nothing upstream bounds it. A provider that echoed the request back produced
// one past the record's own limit, the settlement wrote it anyway, and every
// later read of that run threw `has invalid failure` — so a Turn that failed
// once went on to 500 the transcript endpoint for ever, and "Try again" could
// not get the person out of it either.
import { describe, expect, test } from "bun:test";
import {
  boundedRunFailureV1,
  MAX_RUN_FAILURE_BYTES_V1,
} from "./run-records.ts";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("the failure a settlement may durably write", () => {
  test("leaves a reason that already fits exactly as it was written", () => {
    const reason = "Reconciliation was explicitly abandoned: response lost";
    expect(boundedRunFailureV1(reason)).toBe(reason);
  });

  test("cuts one the record could not hold, and says it was cut", () => {
    const bounded = boundedRunFailureV1(
      "x".repeat(MAX_RUN_FAILURE_BYTES_V1 * 2),
    );
    expect(bytes(bounded)).toBeLessThanOrEqual(MAX_RUN_FAILURE_BYTES_V1);
    expect(bounded.endsWith("…")).toBe(true);
  });

  test("keeps the opening words, which are the ones a person reads", () => {
    const bounded = boundedRunFailureV1(
      `Model request failed: ${"detail ".repeat(MAX_RUN_FAILURE_BYTES_V1)}`,
    );
    expect(bounded.startsWith("Model request failed: detail")).toBe(true);
  });

  test("never cuts inside a character", () => {
    // Multi-byte throughout: a byte-wise slice would leave a lone surrogate
    // and the decoder would refuse the record for a different reason.
    const bounded = boundedRunFailureV1("🐑".repeat(MAX_RUN_FAILURE_BYTES_V1));
    expect(bytes(bounded)).toBeLessThanOrEqual(MAX_RUN_FAILURE_BYTES_V1);
    expect(bounded).not.toContain("�");
    expect([...bounded].every((character) => character.length <= 2)).toBe(true);
  });
});

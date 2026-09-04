import { describe, expect, test } from "bun:test";
import {
  isCertainSendRefusalV1,
  momentAfterV1,
  uncertainAdmissionDelayMsV1,
  UNCERTAIN_ADMISSION_MAX_ATTEMPTS_V1,
  UNREACHABLE_BOT_MESSAGE_V1,
} from "./uncertain-admission.js";

describe("telling a refusal from a doubt", () => {
  test("a 4xx is certain and a 5xx is not", () => {
    const refused = Object.assign(new Error("Your message is too long."), {
      status: 413,
    });
    const failed = Object.assign(new Error("Agent request failed"), {
      status: 500,
    });
    expect(isCertainSendRefusalV1(refused)).toBe(true);
    expect(isCertainSendRefusalV1(failed)).toBe(false);
  });

  test("an error with no status is a doubt", () => {
    // What a dropped connection throws: no answer was read, so nothing about
    // the send is settled.
    expect(isCertainSendRefusalV1(new TypeError("Failed to fetch"))).toBe(
      false,
    );
    expect(isCertainSendRefusalV1(undefined)).toBe(false);
    expect(isCertainSendRefusalV1({ status: "413" })).toBe(false);
  });
});

describe("the admission retry bound", () => {
  test("backs off and then stops asking", () => {
    const delays = Array.from(
      { length: UNCERTAIN_ADMISSION_MAX_ATTEMPTS_V1 },
      (_unused, index) => uncertainAdmissionDelayMsV1(index + 1),
    );
    // Five waits between six attempts, doubling; the sixth attempt is the last
    // one, so it is followed by no wait at all.
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, undefined]);
  });

  test("never waits past the ceiling", () => {
    expect(uncertainAdmissionDelayMsV1(1)).toBe(250);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const delay = uncertainAdmissionDelayMsV1(attempt);
      if (delay === undefined) continue;
      expect(delay).toBeLessThanOrEqual(5_000);
    }
  });

  test("the terminal copy names the app's own failure", () => {
    expect(UNREACHABLE_BOT_MESSAGE_V1).toContain("Couldn't reach the Bot");
  });
});

describe("placing a line after the one it reports on", () => {
  test("is strictly later, and stays sortable as a string", () => {
    const at = "2026-09-01T00:01:00.000Z";
    const after = momentAfterV1(at);
    expect(after > at).toBe(true);
    expect(after).toBe("2026-09-01T00:01:00.001Z");
  });

  test("leaves a timestamp it cannot read alone", () => {
    expect(momentAfterV1("not a time")).toBe("not a time");
  });
});

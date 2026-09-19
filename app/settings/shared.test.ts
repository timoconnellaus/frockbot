import { describe, expect, test } from "bun:test";
import { requireMatchingConfigurationReceiptV1 } from "./shared.js";

const stored = {
  commandFingerprint: "fingerprint-1",
  receipt: {
    schemaVersion: 1 as const,
    commandId: "command-1",
    revision: 2,
    status: "applied" as const,
  },
};

describe("shared Settings receipt matcher", () => {
  test("returns the stored receipt for the matching command", () => {
    expect(
      requireMatchingConfigurationReceiptV1(
        stored,
        "fingerprint-1",
        "command-1",
      ),
    ).toBe(stored.receipt);
  });

  test("keeps the exact collision wording for a reused command id", () => {
    expect(() =>
      requireMatchingConfigurationReceiptV1(
        stored,
        "fingerprint-2",
        "command-1",
      ),
    ).toThrow(
      'Configuration command idempotency key "command-1" was reused for a different command',
    );
  });
});

import { describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import { requireStoredRunV1, type StoredRun } from "./backend-contracts.js";

function storedRun(): StoredRun {
  return {
    runId: "run-1",
    commandFingerprint: "fingerprint",
    sessionId: "user:primary",
    acceptedAt: "2026-08-29T00:00:00.000Z",
    input: "continue",
    events: [],
    status: "running",
    phase: "admitted",
    compositionGenerationId: "test-composition-generation",
    configurationSnapshot: initializeBotSettingsV1("primary"),
    previousEventCount: 0,
  };
}

describe("StoredRun durable contract", () => {
  test("uses the public run identifier grammar", () => {
    expect(() =>
      requireStoredRunV1({ ...storedRun(), runId: "run:1" }),
    ).toThrow("invalid runId");
  });

  test("rejects compatibility statuses and invalid status fields", () => {
    expect(() =>
      requireStoredRunV1({ ...storedRun(), status: "interrupted" }),
    ).toThrow("valid status");
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        status: "failed",
        phase: "executing",
        failure: "",
      }),
    ).toThrow("invalid failure");
    expect(() =>
      requireStoredRunV1({ ...storedRun(), responseText: "unexpected" }),
    ).toThrow("completion fields");
  });

  test("accepts completed output up to the public wire byte limit", () => {
    expect(
      requireStoredRunV1({
        ...storedRun(),
        status: "completed",
        phase: "executing",
        responseText: "x".repeat(64_000),
      }).responseText,
    ).toHaveLength(64_000);
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        status: "completed",
        phase: "executing",
        responseText: "🧪".repeat(16_001),
      }),
    ).toThrow("invalid responseText");
  });
});

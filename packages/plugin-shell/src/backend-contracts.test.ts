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
    effectAdmissions: [],
    status: "running",
    phase: "admitted",
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

  test("strictly bounds exact durable effect admission outcomes", () => {
    expect(
      requireStoredRunV1({
        ...storedRun(),
        effectAdmissions: [
          { kind: "model", effectId: "request-1", outcome: "fenced" },
          { kind: "tool", effectId: "tool:1:1:0", outcome: "admitted" },
        ],
      }).effectAdmissions,
    ).toEqual([
      { kind: "model", effectId: "request-1", outcome: "fenced" },
      { kind: "tool", effectId: "tool:1:1:0", outcome: "admitted" },
    ]);
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        effectAdmissions: [
          {
            kind: "model",
            effectId: "request-1",
            outcome: "fenced",
            extra: true,
          },
        ],
      }),
    ).toThrow("invalid effect admission fields");
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        effectAdmissions: [
          { kind: "model", effectId: "same", outcome: "fenced" },
          { kind: "tool", effectId: "same", outcome: "admitted" },
        ],
      }),
    ).toThrow("colliding effect admissions");
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        effectAdmissions: Array.from({ length: 257 }, (_, index) => ({
          kind: "model",
          effectId: `request-${index}`,
          outcome: "admitted",
        })),
      }),
    ).toThrow("invalid effect admissions");
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        effectAdmissions: [
          { kind: "model", effectId: "🧪".repeat(129), outcome: "admitted" },
        ],
      }),
    ).toThrow("invalid effect admission id");
    const symbolEntry = {
      kind: "model",
      effectId: "request-1",
      outcome: "admitted",
      [Symbol("hidden")]: true,
    };
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        effectAdmissions: [symbolEntry],
      }),
    ).toThrow("invalid effect admission fields");
  });

  test("rejects hidden and symbol top-level durable fields", () => {
    const hidden = { ...storedRun() };
    Object.defineProperty(hidden, "future", {
      value: true,
      enumerable: false,
    });
    expect(() => requireStoredRunV1(hidden)).toThrow("invalid fields");

    const symbol = { ...storedRun(), [Symbol("future")]: true };
    expect(() => requireStoredRunV1(symbol)).toThrow("invalid fields");
  });

  test("keeps Stop intent orthogonal and required for cancellation", () => {
    expect(
      requireStoredRunV1({
        ...storedRun(),
        phase: "executing",
        stopRequestedAt: "2026-08-29T00:00:05.000Z",
      }),
    ).toMatchObject({
      status: "running",
      phase: "executing",
      stopRequestedAt: "2026-08-29T00:00:05.000Z",
    });
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        status: "cancelled",
        phase: "executing",
      }),
    ).toThrow("no durable stop intent");
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        status: "cancelled",
        phase: "executing",
        stopRequestedAt: "whenever",
      }),
    ).toThrow("invalid stopRequestedAt");
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        status: "cancelled",
        phase: "executing",
        stopRequestedAt: "2026-08-29T00:00:05.000Z",
        failure: "stopped",
      }),
    ).toThrow("invalid failure fields");
    expect(() =>
      requireStoredRunV1({
        ...storedRun(),
        status: "reconciliation-required",
        phase: "executing",
        failure: "uncertain",
      }),
    ).toThrow("inconsistent recovery state");
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

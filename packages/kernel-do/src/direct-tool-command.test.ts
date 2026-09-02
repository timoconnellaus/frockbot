import { describe, expect, test } from "bun:test";
import {
  botTurnCommandFingerprintV1,
  createStoredRunCodecV1,
} from "./run-records.js";
import { planBotRunRecovery } from "./run-recovery.js";

describe("durable direct tool commands", () => {
  const directTool = {
    generationId: "generation-1",
    packageId: "weather-page",
    name: "weather_lookup",
    input: { city: "Sydney" },
  };

  test("survives the exact stored-run codec for eviction recovery", () => {
    const codec = createStoredRunCodecV1({
      decodeRunId: (value) => {
        if (typeof value !== "string") throw new Error("invalid");
        return value;
      },
      decodeConfigurationSnapshot: (value) => value,
    });
    const run = codec.require({
      runId: "command-1",
      commandFingerprint: "fingerprint",
      sessionId: "user:bot",
      acceptedAt: "2026-09-02T00:00:00.000Z",
      input: "Weather page · weather_lookup",
      events: [],
      effectAdmissions: [],
      status: "running",
      phase: "admitted",
      compositionGenerationId: "generation-1",
      configurationSnapshot: {},
      previousEventCount: 0,
      directTool,
    });
    expect(run.directTool).toEqual(directTool);
  });

  test("is part of the admitted command idempotency fingerprint", () => {
    const base = {
      userId: "user",
      botId: "bot",
      runId: "command-1",
      sessionId: "user:bot",
      acceptedAt: "2026-09-02T00:00:00.000Z",
      text: "Weather page · weather_lookup",
    };
    expect(botTurnCommandFingerprintV1({ ...base, directTool })).not.toBe(
      botTurnCommandFingerprintV1(base),
    );
  });

  test("resumes after eviction without requiring a synthetic model request", () => {
    const codec = createStoredRunCodecV1({
      decodeRunId: (value) => {
        if (typeof value !== "string") throw new Error("invalid");
        return value;
      },
      decodeConfigurationSnapshot: (value) => value,
    });
    const run = codec.require({
      runId: "command-1",
      commandFingerprint: "fingerprint",
      sessionId: "user:bot",
      acceptedAt: "2026-09-02T00:00:00.000Z",
      input: "Weather page · weather_lookup",
      events: [],
      effectAdmissions: [],
      status: "running",
      phase: "executing",
      compositionGenerationId: "generation-1",
      configurationSnapshot: {},
      previousEventCount: 0,
      directTool,
    });
    expect(planBotRunRecovery(run, [], codec)).toEqual({ kind: "resume" });
  });
});

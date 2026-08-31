import { describe, expect, test } from "bun:test";
import { type SessionEvent } from "@frockbot/kernel-contracts";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import type { StoredRun } from "@frockbot/plugin-shell/backend-contracts";
import { eventsForFailedRun, planBotRunRecovery } from "./bot-recovery.js";

function run(events: SessionEvent[]): StoredRun {
  return {
    runId: "run-1",
    commandFingerprint: "run-1-fingerprint",
    sessionId: "user:primary",
    acceptedAt: "2026-08-28T00:00:00.000Z",
    input: "hello",
    events,
    status: "running",
    phase: "executing",
    compositionGenerationId: "test-composition-generation",
    configurationSnapshot: initializeBotSettingsV1("primary"),
    previousEventCount: 1,
  };
}

describe("Bot run recovery", () => {
  test("restarts admitted work only before an external effect intent", () => {
    const created = {
      type: "session/created" as const,
      seq: 0,
      timestamp: "2026-08-28T00:00:00.000Z",
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    const queued = {
      type: "input/queued" as const,
      seq: 1,
      timestamp: "2026-08-28T00:00:01.000Z",
      messageId: "message-1",
      text: "hello",
    };
    expect(planBotRunRecovery(run([queued]), [created, queued])).toEqual({
      kind: "restart",
      previous: [created],
    });
  });

  test("reconciles an uncertain model effect without duplicating it", () => {
    const events = [
      {
        type: "session/created" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
      {
        type: "turn/start" as const,
        seq: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
      },
      {
        type: "step/start" as const,
        seq: 2,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
      },
      {
        type: "model/request" as const,
        seq: 3,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        step: 1,
        request: {
          requestId: "request-1",
          provider: "foundation",
          model: "deterministic-v1",
          system: "",
          messages: [],
          tools: [],
        },
      },
    ] satisfies SessionEvent[];
    const plan = planBotRunRecovery(run(events.slice(1)), events);
    expect(plan.kind).toBe("reconcile");
    if (plan.kind !== "reconcile") throw new Error("expected reconciliation");
    expect(plan.repairs).toEqual([]);
  });

  test("fails recovery when the durable Turn ended unsuccessfully", () => {
    const events = [
      {
        type: "turn/start" as const,
        seq: 0,
        timestamp: "2026-08-28T00:00:00.000Z",
        turn: 1,
      },
      {
        type: "turn/end" as const,
        seq: 1,
        timestamp: "2026-08-28T00:00:01.000Z",
        turn: 1,
        outcome: "model-error" as const,
      },
    ] satisfies SessionEvent[];

    expect(planBotRunRecovery(run(events), events)).toEqual({
      kind: "fail",
      failure: "Bot turn ended with outcome model-error",
    });
  });

  test("preserves durable events when a post-execution operation fails", () => {
    const assistant = {
      type: "assistant/message" as const,
      seq: 0,
      timestamp: "2026-08-28T00:00:00.000Z",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "Durable reply",
      toolCalls: [],
    };
    const durableRun = run([assistant]);

    const events = eventsForFailedRun(
      durableRun,
      new Error("notification storage unavailable"),
    );

    expect(events).toEqual([assistant]);
    expect(events).not.toBe(durableRun.events);
  });
});

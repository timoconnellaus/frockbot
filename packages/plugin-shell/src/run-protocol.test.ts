import { describe, expect, test } from "bun:test";
import { type SessionEvent } from "@frockbot/kernel-contracts";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import type { StoredRun } from "./backend-contracts.js";
import { planBotRunRecovery } from "./backend-recovery.js";
import {
  createClientRunStopReceiptV1,
  decodeClientNotificationAcknowledgementCommandV1,
  decodeClientRunAdmissionFenceCommandV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunReconciliationCommandV1,
  decodeClientRunStopCommandV1,
  decodeClientRunStopReceiptV1,
  decodeClientTurnCommandV1,
  decodeClientRunLookupV1,
  decodeClientTurnV1,
  decodeClientRunPageV1,
  decodeClientRunListV1,
  createClientRunListV1,
  projectClientAnnouncementsV1,
  decodeClientRunListQueryV1,
  projectClientRunLookupV1,
  projectClientRunListV1,
  projectClientRunV1,
  projectClientRunOrDegradedV1,
  projectClientTurnV1,
  UNRECORDED_TOOL_RESULT_TEXT_V1,
} from "./run-protocol.js";

const timestamp = "2026-08-29T00:00:00.000Z";

function event<T extends SessionEvent>(value: T): T {
  return value;
}

function toolEvents(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => index).flatMap((index) => [
    event({
      type: "tool/call",
      seq: index * 2,
      timestamp,
      turn: 1,
      step: 1,
      occurrenceId: `tool:1:1:${index}`,
      name: "lookup",
      input: {},
    }),
    event({
      type: "tool/result",
      seq: index * 2 + 1,
      timestamp,
      turn: 1,
      step: 1,
      occurrenceId: `tool:1:1:${index}`,
      name: "lookup",
      content: `result-${index}`,
      isError: false,
      status: "completed",
    }),
  ]);
}

function storedRun(
  events: SessionEvent[],
  status: StoredRun["status"] = "completed",
): StoredRun {
  return {
    runId: "run-events",
    commandFingerprint: "fingerprint",
    sessionId: "user:primary",
    acceptedAt: timestamp,
    input: "continue",
    events,
    effectAdmissions: [],
    status,
    phase: status === "reconciliation-required" ? status : "executing",
    compositionGenerationId: "test-composition-generation",
    configurationSnapshot: initializeBotSettingsV1("primary"),
    previousEventCount: 0,
    ...(status === "completed" ? { responseText: "done" } : {}),
    ...(status === "failed" ? { failure: "failed" } : {}),
    ...(status === "cancelled"
      ? { stopRequestedAt: "2026-08-28T00:00:05.000Z" }
      : {}),
  };
}

describe("client run protocol v1", () => {
  test("rejects durable runs missing current admission fields", () => {
    const complete = storedRun([], "running");
    for (const field of [
      "runId",
      "commandFingerprint",
      "sessionId",
      "acceptedAt",
      "input",
      "events",
      "status",
      "phase",
      "compositionGenerationId",
      "configurationSnapshot",
      "previousEventCount",
    ] as const) {
      const incomplete = structuredClone(complete) as unknown as Record<
        string,
        unknown
      >;
      delete incomplete[field];
      expect(() =>
        projectClientRunLookupV1(incomplete as unknown as StoredRun),
      ).toThrow();
    }
    expect(() =>
      projectClientRunLookupV1({
        ...complete,
        unrecognized: true,
      } as unknown as StoredRun),
    ).toThrow("stored run has invalid fields");
    for (const runId of [42, "", "x".repeat(129)]) {
      expect(() =>
        projectClientRunLookupV1({
          ...complete,
          runId,
        } as unknown as StoredRun),
      ).toThrow("stored run has invalid runId");
    }
    expect(() =>
      projectClientRunLookupV1({
        ...complete,
        events: [{ type: "turn/start" }],
      } as unknown as StoredRun),
    ).toThrow("session event.seq must be an integer");
    expect(() =>
      projectClientRunLookupV1({
        ...complete,
        events: [
          {
            type: "model/request",
            seq: 0,
            timestamp,
            turn: 1,
            step: 1,
          },
        ],
      } as unknown as StoredRun),
    ).toThrow("session event has invalid fields");
  });

  test("projects and strictly decodes command-specific admission state", () => {
    expect(
      decodeClientRunLookupV1(projectClientRunLookupV1(undefined)),
    ).toEqual({ state: "not-admitted" });

    const running = projectClientRunLookupV1(storedRun([], "running"));
    expect(decodeClientRunLookupV1(structuredClone(running))).toMatchObject({
      state: "running",
      run: { runId: "run-events", status: "running" },
    });

    const terminal = projectClientRunLookupV1(storedRun([], "completed"));
    if (terminal.state === "not-admitted") {
      throw new Error("expected an admitted run");
    }
    expect(decodeClientRunLookupV1(structuredClone(terminal))).toMatchObject({
      state: "terminal",
      run: { runId: "run-events", status: "completed" },
    });

    expect(() =>
      decodeClientRunLookupV1({
        ...terminal,
        state: "running",
      }),
    ).toThrow("run lookup.state does not match run.status");
    expect(() =>
      decodeClientRunLookupV1({
        schemaVersion: 1,
        state: "not-admitted",
        run: terminal.run,
      }),
    ).toThrow("not-admitted run lookup must not include a run");
    expect(() =>
      decodeClientRunLookupV1({
        schemaVersion: 1,
        state: "not-admitted",
        commandFingerprint: "private",
      }),
    ).toThrow("run lookup.commandFingerprint is not allowed");
  });

  test("strictly decodes exact Stop commands that target one run", () => {
    expect(
      decodeClientRunStopCommandV1({
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-1",
        runId: "run-1",
      }),
    ).toEqual({
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-1",
      runId: "run-1",
    });
    const hidden = {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-1",
      runId: "run-1",
    };
    Object.defineProperty(hidden, "reason", { value: "user" });
    const symbol = {
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-1",
      runId: "run-1",
      [Symbol("reason")]: "user",
    };
    for (const invalid of [
      { schemaVersion: 2, action: "stop", commandId: "stop-1", runId: "run-1" },
      {
        schemaVersion: 1,
        action: "cancel",
        commandId: "stop-1",
        runId: "run-1",
      },
      { schemaVersion: 1, action: "stop", commandId: "stop-1" },
      { schemaVersion: 1, action: "stop", runId: "run-1" },
      {
        schemaVersion: 1,
        action: "stop",
        commandId: "stop/1",
        runId: "run-1",
      },
      {
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-1",
        runId: "run/1",
      },
      {
        schemaVersion: 1,
        action: "stop",
        commandId: "stop-1",
        runId: "run-1",
        reason: "user",
      },
      hidden,
      symbol,
    ]) {
      expect(() => decodeClientRunStopCommandV1(invalid)).toThrow();
    }
  });

  test("projects Stop intent and cancellation without claiming terminality", () => {
    const command = decodeClientRunStopCommandV1({
      schemaVersion: 1,
      action: "stop",
      commandId: "stop-1",
      runId: "run-events",
    });
    const stopping = {
      ...storedRun([], "running"),
      stopRequestedAt: "2026-08-29T00:00:05.000Z",
    } satisfies StoredRun;

    const accepted = createClientRunStopReceiptV1(
      command,
      projectClientRunV1(stopping),
    );
    expect(accepted).toMatchObject({
      schemaVersion: 1,
      status: "accepted",
      commandId: "stop-1",
      runId: "run-events",
      run: { status: "running", stopRequestedAt: "2026-08-29T00:00:05.000Z" },
    });
    expect(
      decodeClientRunStopReceiptV1(structuredClone(accepted)).run,
    ).toMatchObject({ status: "running" });

    const cancelled = projectClientRunV1(storedRun([], "cancelled"));
    expect(cancelled).toMatchObject({
      status: "cancelled",
      stopRequestedAt: "2026-08-28T00:00:05.000Z",
      outcome: {
        type: "cancelled",
        message: "Stopped by an authenticated Stop command.",
      },
    });
    expect(projectClientRunLookupV1(storedRun([], "cancelled"))).toMatchObject({
      state: "terminal",
    });
    expect(
      decodeClientRunStopReceiptV1(
        createClientRunStopReceiptV1(command, cancelled),
      ).run,
    ).toMatchObject({
      status: "cancelled",
      failure: "Stopped by an authenticated Stop command.",
    });

    expect(() =>
      createClientRunStopReceiptV1(
        command,
        projectClientRunV1({ ...storedRun([], "running"), runId: "other-run" }),
      ),
    ).toThrow("run stop receipt does not match its command");
    expect(() =>
      decodeClientRunStopReceiptV1({ ...accepted, status: "cancelled" }),
    ).toThrow("run stop receipt is invalid");
    expect(() =>
      decodeClientRunStopReceiptV1({
        ...accepted,
        run: { ...accepted.run, status: "cancelled" },
      }),
    ).toThrow();
  });

  test("strictly decodes run lookup queries", () => {
    expect(
      decodeClientRunLookupQueryV1({
        schemaVersion: 1,
        runId: "command-1",
      }),
    ).toEqual({ schemaVersion: 1, runId: "command-1" });
    expect(() =>
      decodeClientRunLookupQueryV1({
        schemaVersion: 1,
        runId: "command/1",
      }),
    ).toThrow("run lookup query.runId is invalid");
    expect(() =>
      decodeClientRunLookupQueryV1({
        schemaVersion: 1,
        runId: "command-1",
        extra: true,
      }),
    ).toThrow("run lookup query.extra is not allowed");
  });

  test("carries invoked Skills on a Turn command, bounded and exact", () => {
    const ref = (slug: string) => ({
      schemaVersion: 1 as const,
      source: "bot" as const,
      slug,
    });
    expect(
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "run it",
        skills: [ref("daily-standup")],
      }),
    ).toEqual({
      schemaVersion: 1,
      commandId: "command-1",
      text: "run it",
      skills: [ref("daily-standup")],
    });
    // Absent and empty mean the same thing, and both leave the field off, so
    // an unchanged client is byte-identical to what it sent before.
    expect(
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "run it",
        skills: [],
      }),
    ).toEqual({ schemaVersion: 1, commandId: "command-1", text: "run it" });
    // The wire admits every declared source, so K1 and K2 add no codec change.
    expect(
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "run it",
        skills: [{ schemaVersion: 1, source: "managed", slug: "teach" }],
      }).skills,
    ).toEqual([{ schemaVersion: 1, source: "managed", slug: "teach" }]);
    for (const skills of [
      [ref("a"), ref("b"), ref("c"), ref("d")],
      [{ schemaVersion: 1, source: "workflow", slug: "a" }],
      [{ schemaVersion: 1, source: "bot", slug: "a", body: "text" }],
      "bot/a",
    ]) {
      expect(() =>
        decodeClientTurnCommandV1({
          schemaVersion: 1,
          commandId: "command-1",
          text: "run it",
          skills,
        }),
      ).toThrow();
    }
  });

  test("strictly decodes hosted Turn, notification, and reconciliation commands", () => {
    expect(
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "  hello  ",
      }),
    ).toEqual({ schemaVersion: 1, commandId: "command-1", text: "hello" });
    expect(() =>
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "hello",
        action: "cancel",
      }),
    ).toThrow("turn command.action is not allowed");
    expect(() =>
      decodeClientTurnCommandV1({
        schemaVersion: 2,
        commandId: "command-1",
        text: "hello",
      }),
    ).toThrow("turn command.schemaVersion is invalid");

    // Supersede intent is carried by the field's presence. The composer sends
    // it on every send, and names a run only when it observed one.
    expect(
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "hello",
        supersedes: {},
      }),
    ).toEqual({
      schemaVersion: 1,
      commandId: "command-1",
      text: "hello",
      supersedes: {},
    });
    expect(
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "hello",
        supersedes: { runId: "run-1" },
      }).supersedes,
    ).toEqual({ runId: "run-1" });
    expect(() =>
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "hello",
        supersedes: { runId: "not a run id" },
      }),
    ).toThrow("turn command.supersedes.runId is invalid");
    expect(() =>
      decodeClientTurnCommandV1({
        schemaVersion: 1,
        commandId: "command-1",
        text: "hello",
        supersedes: { runId: "run-1", extra: 1 },
      }),
    ).toThrow();

    expect(
      decodeClientNotificationAcknowledgementCommandV1({
        schemaVersion: 1,
        action: "acknowledge",
        notificationId: "notification-1",
      }),
    ).toEqual({
      schemaVersion: 1,
      action: "acknowledge",
      notificationId: "notification-1",
    });
    expect(() =>
      decodeClientNotificationAcknowledgementCommandV1({
        schemaVersion: 1,
        action: "acknowledge",
        notificationId: "notification-1",
        extra: true,
      }),
    ).toThrow("notification acknowledgement command.extra is not allowed");

    expect(
      decodeClientRunReconciliationCommandV1({
        schemaVersion: 1,
        action: "resume",
      }),
    ).toEqual({ schemaVersion: 1, action: "resume" });
    expect(() =>
      decodeClientRunReconciliationCommandV1({
        schemaVersion: 2,
        action: "resume",
      }),
    ).toThrow("run reconciliation command is invalid");
  });

  test("strictly decodes authoritative admission fence commands", () => {
    expect(
      decodeClientRunAdmissionFenceCommandV1({
        schemaVersion: 1,
        action: "fence-admission",
      }),
    ).toEqual({ schemaVersion: 1, action: "fence-admission" });
    expect(() =>
      decodeClientRunAdmissionFenceCommandV1({
        schemaVersion: 1,
        action: "fence-admission",
        extra: true,
      }),
    ).toThrow("run admission fence command.extra is not allowed");
    expect(() =>
      decodeClientRunAdmissionFenceCommandV1({
        schemaVersion: 2,
        action: "fence-admission",
      }),
    ).toThrow("run admission fence command is invalid");
  });

  test("projects bounded Turn responses without internal events", () => {
    const providerCallId = "provider-call-private";
    const projected = projectClientTurnV1({
      runId: "run-turn-1",
      text: "✅".repeat(40_000),
      events: [
        event({
          type: "model/request",
          seq: 0,
          timestamp,
          turn: 1,
          step: 1,
          request: {
            requestId: "request-private",
            provider: "provider-private",
            model: "model-private",
            system: "system-prompt-secret",
            messages: [],
            tools: [],
          },
        }),
        event({
          type: "assistant/message",
          seq: 1,
          timestamp,
          turn: 1,
          step: 1,
          requestId: "request-private",
          text: "",
          toolCalls: [
            {
              id: providerCallId,
              name: "calendar_lookup",
              input: { accessToken: "tool-input-secret" },
            },
          ],
        }),
        event({
          type: "tool/call",
          seq: 2,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "calendar_lookup",
          input: { accessToken: "tool-input-secret" },
        }),
        event({
          type: "tool/result",
          seq: 3,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "calendar_lookup",
          content: "visible result",
          isError: false,
          status: "completed",
        }),
      ],
    });

    expect(projected).toMatchObject({
      schemaVersion: 1,
      runId: "run-turn-1",
      events: [
        {
          type: "tool/call",
          call: { id: "tool-1", name: "calendar_lookup" },
        },
        {
          type: "tool/result",
          callId: "tool-1",
          content: "visible result",
          isError: false,
        },
      ],
    });
    expect(
      new TextEncoder().encode(JSON.stringify(projected.text)).length,
    ).toBeLessThanOrEqual(64_000);
    expect(decodeClientTurnV1(structuredClone(projected))).toMatchObject({
      runId: "run-turn-1",
      events: projected.events,
    });
    const wire = JSON.stringify(projected);
    for (const privateValue of [
      "model/request",
      "provider-private",
      "model-private",
      "system-prompt-secret",
      "tool-input-secret",
      providerCallId,
      "occurrenceId",
    ]) {
      expect(wire).not.toContain(privateValue);
    }
  });

  test("projects dynamic call identity so the client can show the inner tool", () => {
    const projected = projectClientTurnV1({
      runId: "run-dynamic-tool",
      text: "",
      events: [
        event({
          type: "tool/call",
          seq: 0,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "call_dynamic_tool",
          input: {
            namespace: "user-Github--acme",
            toolName: "search_issues",
            arguments: { query: "is:open" },
            mcpDetails: { description: "Find open issues." },
          },
        }),
        event({
          type: "tool/result",
          seq: 1,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "call_dynamic_tool",
          content: "[]",
          isError: false,
          status: "completed",
        }),
      ],
    });

    expect(projected.events[0]).toEqual({
      type: "tool/call",
      call: {
        id: "tool-1",
        name: "call_dynamic_tool",
        input: {
          namespace: "user-Github--acme",
          toolName: "search_issues",
          argumentsJson: '{"query":"is:open"}',
        },
      },
    });
    expect(decodeClientTurnV1(structuredClone(projected)).events[0]).toEqual(
      projected.events[0],
    );
  });

  test("projects only bounded user-visible run state", () => {
    const stored = {
      runId: "run-1",
      commandFingerprint: "fingerprint-secret",
      sessionId: "user:private-session",
      acceptedAt: timestamp,
      input: "continue",
      events: [
        event({
          type: "model/request",
          seq: 0,
          timestamp,
          turn: 1,
          step: 1,
          request: {
            requestId: "request-private",
            provider: "provider-private",
            model: "model-private",
            system: "system-prompt-secret",
            messages: [],
            tools: [],
          },
        }),
        event({
          type: "tool/call",
          seq: 1,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "calendar_lookup",
          input: { accessToken: "tool-input-secret" },
        }),
        event({
          type: "tool/result",
          seq: 2,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "calendar_lookup",
          content: "visible result",
          isError: false,
          status: "completed",
        }),
      ],
      effectAdmissions: [],
      status: "reconciliation-required",
      failure: "Provider confirmation required",
      phase: "reconciliation-required",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 17,
    } satisfies StoredRun;

    const projected = projectClientRunListV1([stored]);

    expect(projected).toEqual({
      schemaVersion: 1,
      runs: [
        {
          schemaVersion: 2,
          runId: "run-1",
          admittedAt: timestamp,
          input: "continue",
          status: "reconciliation-required",
          events: [
            {
              type: "tool/call",
              call: { id: "tool-1", name: "calendar_lookup" },
            },
            {
              type: "tool/result",
              callId: "tool-1",
              content: "visible result",
              isError: false,
            },
          ],
          recovery: {
            action: "resume",
            message: "Provider confirmation required",
          },
        },
      ],
      page: { truncated: false },
    });
    expect(decodeClientRunListV1(structuredClone(projected))).toEqual([
      {
        runId: "run-1",
        admittedAt: timestamp,
        input: "continue",
        status: "reconciliation-required",
        events: projected.runs[0]?.events,
        failure: "Provider confirmation required",
        recovery: {
          action: "resume",
          message: "Provider confirmation required",
        },
      },
    ]);
    const wire = JSON.stringify(projected);
    for (const privateValue of [
      "fingerprint-secret",
      "private-session",
      "system-prompt-secret",
      "tool-input-secret",
      "provider-private",
      "model-private",
      "compositionGenerationId",
      "configurationSnapshot",
      "previousEventCount",
      "phase",
    ]) {
      expect(wire).not.toContain(privateValue);
    }
  });

  test("rejects unversioned, extended, and inconsistent wire values", () => {
    const completed = {
      schemaVersion: 1,
      runId: "run-1",
      admittedAt: timestamp,
      input: "continue",
      status: "completed",
      events: [],
      outcome: { type: "completed", text: "done" },
    };

    expect(() => decodeClientRunListV1({ runs: [] })).toThrow(
      "run list.schemaVersion is invalid",
    );
    expect(() =>
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [{ ...completed, commandFingerprint: "secret" }],
        page: { truncated: false },
      }),
    ).toThrow("run.commandFingerprint is not allowed");
    expect(() =>
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [
          {
            ...completed,
            status: "failed",
          },
        ],
        page: { truncated: false },
      }),
    ).toThrow("run.outcome does not match run.status");
    expect(() =>
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [
          {
            ...completed,
            events: [{ type: "model/request" }],
          },
        ],
        page: { truncated: false },
      }),
    ).toThrow("run event.type is invalid");
    expect(() =>
      decodeClientRunPageV1({
        schemaVersion: 1,
        runs: [],
        page: { truncated: true },
      }),
    ).toThrow("truncated run list requires a next cursor");
    expect(() =>
      decodeClientRunListQueryV1({ schemaVersion: 1, before: "" }),
    ).toThrow("run list query.before is invalid");
    expect(() =>
      decodeClientRunListQueryV1({ schemaVersion: 1, before: "garbage" }),
    ).toThrow("run list query.before is invalid");
    expect(
      decodeClientRunListQueryV1({
        schemaVersion: 1,
        before: "run-index:2026-08-29T00:00:00.000Z:run-1",
      }),
    ).toEqual({
      schemaVersion: 1,
      before: "run-index:2026-08-29T00:00:00.000Z:run-1",
    });
  });

  test("bounds projected visible history and messages", () => {
    const stored: StoredRun = {
      runId: "run-bounded",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: timestamp,
      input: "🧪".repeat(8_000),
      events: toolEvents(300),
      effectAdmissions: [],
      status: "failed",
      phase: "executing",
      compositionGenerationId: "test-composition-generation",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
      failure: "💥".repeat(2_000),
    };

    const projected = projectClientRunListV1([stored]).runs[0];

    expect(
      new TextEncoder().encode(JSON.stringify(projected?.input)).length,
    ).toBeLessThanOrEqual(32_000);
    expect(projected?.events).toHaveLength(511);
    expect(projected?.events[0]).toEqual({
      type: "run/events-truncated",
      omittedInteractions: 45,
    });
    expect(projected?.events[1]).toMatchObject({
      type: "tool/call",
      call: { id: "tool-46" },
    });
    expect(projected?.events.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "tool-300",
    });
    const failure =
      projected?.outcome?.type === "failed"
        ? projected.outcome.message
        : undefined;
    expect(
      new TextEncoder().encode(JSON.stringify(failure)).length,
    ).toBeLessThanOrEqual(8_000);
  });

  test("uses the full boundary without splitting an interaction", () => {
    const atBoundary = projectClientRunListV1([storedRun(toolEvents(256))])
      .runs[0];
    const overBoundary = projectClientRunListV1([storedRun(toolEvents(257))])
      .runs[0];

    expect(atBoundary?.events).toHaveLength(512);
    expect(atBoundary?.events[0]).toMatchObject({
      type: "tool/call",
      call: { id: "tool-1" },
    });
    expect(atBoundary?.events.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "tool-256",
    });
    expect(overBoundary?.events).toHaveLength(511);
    expect(overBoundary?.events[0]).toEqual({
      type: "run/events-truncated",
      omittedInteractions: 2,
    });
    expect(overBoundary?.events[1]).toMatchObject({
      type: "tool/call",
      call: { id: "tool-3" },
    });
    expect(overBoundary?.events.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "tool-257",
    });
    expect(overBoundary?.outcome).toEqual({ type: "completed", text: "done" });
    expect(
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [overBoundary],
        page: { truncated: false },
      })[0]?.events[0],
    ).toEqual({
      type: "run/events-truncated",
      omittedInteractions: 2,
    });
  });

  test("projects sends and hand-offs in the order the log wrote them", () => {
    const [call, result] = toolEvents(1) as [SessionEvent, SessionEvent];
    const projected = projectClientRunV1(
      storedRun([
        event({
          type: "send/to-user",
          seq: 10,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:send",
          payload: { type: "text", text: "On it." },
        }),
        call,
        result,
        event({
          type: "send/to-user",
          seq: 13,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:widget",
          payload: {
            type: "widget",
            widget: { prompt: "Which day?", options: ["Tue", "Thu"] },
          },
        }),
        event({
          type: "wake/parent",
          seq: 14,
          timestamp,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:wake",
          message: "Paid.",
        }),
      ]),
    );

    // Version 2 is what carries the two new event types; a client pinned to 1
    // still decodes the body it produces.
    expect(projected.schemaVersion).toBe(2);
    expect(projected.events).toEqual([
      { type: "send/to-user", payload: { type: "text", text: "On it." } },
      { type: "tool/call", call: { id: "tool-1", name: "lookup" } },
      {
        type: "tool/result",
        callId: "tool-1",
        content: "result-0",
        isError: false,
      },
      {
        type: "send/to-user",
        payload: {
          type: "widget",
          widget: { prompt: "Which day?", options: ["Tue", "Thu"] },
        },
      },
      { type: "wake/parent", message: "Paid." },
    ]);
    expect(
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [projected],
        page: { truncated: false },
      })[0]?.events,
    ).toEqual(projected.events);
  });

  test("truncates sends alongside tool interactions, oldest first", () => {
    const sends = Array.from({ length: 600 }, (_, index) =>
      event({
        type: "send/to-user" as const,
        seq: index,
        timestamp,
        turn: 1,
        step: 1,
        occurrenceId: `tool:1:1:${index}`,
        payload: { type: "text" as const, text: `send-${index}` },
      }),
    );

    const projected = projectClientRunV1(storedRun(sends));

    expect(projected.events).toHaveLength(512);
    expect(projected.events[0]).toEqual({
      type: "run/events-truncated",
      omittedInteractions: 89,
    });
    // The newest send survives: truncation drops history, never the latest
    // thing the User is looking at.
    expect(projected.events.at(-1)).toEqual({
      type: "send/to-user",
      payload: { type: "text", text: "send-599" },
    });
    expect(
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [projected],
        page: { truncated: false },
      })[0]?.events,
    ).toHaveLength(512);
  });

  test("refuses a projected send whose payload it cannot decode", () => {
    expect(() =>
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [
          {
            ...projectClientRunV1(storedRun([])),
            events: [{ type: "send/to-user", payload: { type: "sms" } }],
          },
        ],
        page: { truncated: false },
      }),
    ).toThrow("run event.payload.type is invalid");
  });

  test("rejects orphaned tool history at projection", () => {
    const call = toolEvents(1)[0]!;
    const result = toolEvents(1)[1]!;

    expect(() => projectClientRunListV1([storedRun([result])])).toThrow(
      'tool result has no matching occurrence "tool:1:1:0"',
    );
    expect(() =>
      projectClientRunListV1([storedRun([call, call, result])]),
    ).toThrow('tool occurrence "tool:1:1:0" has duplicate intent');
  });

  // A READ never throws on a record that is already durable. A settled Turn
  // whose tool call was never settled used to fail the whole transcript
  // endpoint — a 500 on every later request — so one malformed row bricked the
  // conversation for ever. It degrades to a row saying nothing was recorded.
  test("degrades a settled Turn's unsettled tool call instead of throwing", () => {
    const call = toolEvents(1)[0]!;

    const projected = projectClientRunListV1([storedRun([call])]).runs[0];

    expect(projected?.events).toEqual([
      { type: "tool/call", call: { id: "tool-1", name: "lookup" } },
      {
        type: "tool/result",
        callId: "tool-1",
        content: UNRECORDED_TOOL_RESULT_TEXT_V1,
        isError: true,
      },
    ]);
    // And the degraded row survives the wire decode, which used to refuse it
    // for the same reason the projection did.
    expect(
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [projected],
        page: { truncated: false },
      })[0]?.events,
    ).toHaveLength(2);
  });

  test("accepts a settled Turn on the wire whose call carries no result", () => {
    const projected = projectClientRunListV1([storedRun([])]).runs[0]!;

    expect(
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [
          {
            ...projected,
            events: [
              { type: "tool/call", call: { id: "tool-1", name: "lookup" } },
            ],
          },
        ],
        page: { truncated: false },
      })[0]?.events,
    ).toEqual([{ type: "tool/call", call: { id: "tool-1", name: "lookup" } }]);
  });

  test("retains pending calls only for nonterminal runs", () => {
    const call = toolEvents(1)[0]!;
    const projected = projectClientRunListV1([storedRun([call], "running")])
      .runs[0];

    expect(projected?.events).toEqual([
      { type: "tool/call", call: { id: "tool-1", name: "lookup" } },
    ]);
    expect(
      decodeClientRunListV1({
        schemaVersion: 1,
        runs: [projected],
        page: { truncated: false },
      }),
    ).toMatchObject([{ status: "running", events: [{ type: "tool/call" }] }]);
  });

  test("aliases repeated and oversized provider call identifiers", () => {
    const providerId = "provider-call-".repeat(100);
    const events = [
      event({
        type: "assistant/message",
        seq: 0,
        timestamp,
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "",
        toolCalls: [
          { id: providerId, name: "first", input: {} },
          { id: providerId, name: "second", input: {} },
        ],
      }),
      event({
        type: "tool/call",
        seq: 1,
        timestamp,
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "first",
        input: {},
      }),
      event({
        type: "tool/call",
        seq: 2,
        timestamp,
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:1",
        name: "second",
        input: {},
      }),
      event({
        type: "tool/result",
        seq: 3,
        timestamp,
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "first",
        content: "first-result",
        isError: false,
        status: "completed",
      }),
      event({
        type: "tool/result",
        seq: 4,
        timestamp,
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:1",
        name: "second",
        content: "second-result",
        isError: false,
        status: "completed",
      }),
      event({
        type: "assistant/message",
        seq: 5,
        timestamp,
        turn: 1,
        step: 2,
        requestId: "request-2",
        text: "",
        toolCalls: [{ id: providerId, name: "third", input: {} }],
      }),
      event({
        type: "tool/call",
        seq: 6,
        timestamp,
        turn: 1,
        step: 2,
        occurrenceId: "tool:1:2:0",
        name: "third",
        input: {},
      }),
      event({
        type: "tool/result",
        seq: 7,
        timestamp,
        turn: 1,
        step: 2,
        occurrenceId: "tool:1:2:0",
        name: "third",
        content: "third-result",
        isError: false,
        status: "completed",
      }),
    ] satisfies SessionEvent[];

    const stored = storedRun(events);
    const projected = projectClientRunListV1([stored]);

    expect(projected.runs[0]?.events).toEqual([
      { type: "tool/call", call: { id: "tool-1", name: "first" } },
      {
        type: "tool/result",
        callId: "tool-1",
        content: "first-result",
        isError: false,
      },
      { type: "tool/call", call: { id: "tool-2", name: "second" } },
      {
        type: "tool/result",
        callId: "tool-2",
        content: "second-result",
        isError: false,
      },
      { type: "tool/call", call: { id: "tool-3", name: "third" } },
      {
        type: "tool/result",
        callId: "tool-3",
        content: "third-result",
        isError: false,
      },
    ]);
    expect(stored.events[0]).toMatchObject({
      toolCalls: [{ id: providerId }, { id: providerId }],
    });
    expect(JSON.stringify(projected)).not.toContain(providerId);
  });
  test("surfaces a failed Turn's reason as the client run failure", () => {
    const events = [
      event({ type: "turn/start", seq: 0, timestamp, turn: 1 }),
      event({
        type: "turn/end",
        seq: 1,
        timestamp,
        turn: 1,
        outcome: "model-error",
        reason: "Ollama Cloud responded 401: invalid api key",
      }),
    ];
    const plan = planBotRunRecovery(storedRun(events, "running"), events);
    if (plan.kind !== "fail")
      throw new Error("expected a failed recovery plan");

    const lookup = projectClientRunLookupV1({
      ...storedRun(events, "failed"),
      events,
      failure: plan.failure,
    });
    expect(decodeClientRunLookupV1(structuredClone(lookup))).toMatchObject({
      state: "terminal",
      run: {
        status: "failed",
        failure:
          "Bot turn ended with outcome model-error: Ollama Cloud responded 401: invalid api key",
      },
    });
  });

  test("carries rename announcements beside the Turns, and refuses a bad one", () => {
    const announcements = projectClientAnnouncementsV1([
      { type: "turn/start", seq: 0, timestamp, turn: 1 },
      {
        type: "bot/renamed",
        seq: 3,
        timestamp,
        from: "Housework",
        to: "Atlas",
        namedBy: "bot",
      },
    ]);
    expect(announcements).toEqual([
      {
        type: "bot/renamed",
        announcementId: "announcement-3",
        at: timestamp,
        from: "Housework",
        to: "Atlas",
        namedBy: "bot",
      },
    ]);
    const page = createClientRunListV1([], { truncated: false }, announcements);
    expect(decodeClientRunPageV1(structuredClone(page)).announcements).toEqual(
      announcements,
    );
    // A page written before announcements existed still decodes.
    expect(
      decodeClientRunPageV1({
        schemaVersion: 1,
        runs: [],
        page: { truncated: false },
      }).announcements,
    ).toEqual([]);
    expect(() =>
      decodeClientRunPageV1({
        ...page,
        announcements: [{ ...announcements[0], namedBy: "admin" }],
      }),
    ).toThrow("run list.announcement.namedBy is invalid");
    expect(() =>
      decodeClientRunPageV1({
        ...page,
        announcements: [{ ...announcements[0], at: "not a date" }],
      }),
    ).toThrow("run list.announcement.at is invalid");
  });

  test("announces a compaction without putting its summary on the wire", () => {
    const announcements = projectClientAnnouncementsV1([
      { type: "turn/start", seq: 0, timestamp, turn: 1 },
      {
        type: "conversation/compacted",
        seq: 4,
        timestamp,
        effectId: "compaction-1",
        fromTurn: 1,
        throughTurn: 6,
        summary: "## Summary\nsomething private to the model",
        identifiers: ["applet-9f2c"],
        provider: "ollama-cloud",
        model: "kimi-k2",
      },
    ]);
    expect(announcements).toEqual([
      {
        type: "conversation/compacted",
        announcementId: "compaction-4",
        at: timestamp,
        throughTurn: 6,
      },
    ]);
    const page = createClientRunListV1([], { truncated: false }, announcements);
    expect(JSON.stringify(page)).not.toContain("something private");
    expect(decodeClientRunPageV1(structuredClone(page)).announcements).toEqual(
      announcements,
    );
    expect(() =>
      decodeClientRunPageV1({
        ...page,
        announcements: [{ ...announcements[0], throughTurn: 0 }],
      }),
    ).toThrow("run list.announcement.throughTurn is invalid");
  });
});

describe("dispatched subagents in the run projection", () => {
  const dispatched: SessionEvent = {
    type: "task/dispatched",
    seq: 4,
    timestamp,
    turn: 1,
    step: 1,
    occurrenceId: "tool:1:1:0",
    taskId: "tk-1",
    taskType: "executor",
    description: "Read the release notes",
    model: "provider-ollama-cloud/glm-5.3-flash:cloud",
    background: true,
  };

  test("projects a chip, and round-trips it through the page decoder", () => {
    const projected = projectClientRunV1(storedRun([dispatched]));
    expect(projected.events).toEqual([
      {
        type: "task/dispatched",
        taskId: "tk-1",
        taskType: "executor",
        description: "Read the release notes",
        model: "provider-ollama-cloud/glm-5.3-flash:cloud",
        background: true,
      },
    ]);
    const page = createClientRunListV1([projected], { truncated: false });
    expect(
      decodeClientRunPageV1(structuredClone(page)).runs[0]?.events,
    ).toEqual(projected.events);
  });

  test("stands alone, so it never breaks the tool call/result walk", () => {
    const projected = projectClientRunV1(
      storedRun([...toolEvents(1), dispatched]),
    );
    const page = createClientRunListV1([projected], { truncated: false });
    expect(
      decodeClientRunPageV1(structuredClone(page)).runs[0]?.events,
    ).toHaveLength(3);
  });

  test("carries nothing of the child but its identity — no prompt, no transcript", () => {
    const projected = projectClientRunV1(
      storedRun([
        {
          ...dispatched,
          description: "Read the release notes",
        } as SessionEvent,
      ]),
    );
    expect(JSON.stringify(projected)).not.toContain("summarise");
  });

  test("refuses a chip that carries a field it does not have", () => {
    const page = createClientRunListV1(
      [projectClientRunV1(storedRun([dispatched]))],
      { truncated: false },
    );
    const tampered = structuredClone(page) as {
      runs: Array<{ events: Array<Record<string, unknown>> }>;
    };
    tampered.runs[0]!.events[0]!.prompt = "the child's brief";
    expect(() => decodeClientRunPageV1(tampered)).toThrow();
  });

  test("a run whose record cannot be read degrades instead of failing the list", () => {
    // One badly written record — a resolve that wrote a shape the record does
    // not allow — used to answer 500 for the whole transcript, for good.
    const broken = {
      ...storedRun([], "running"),
      status: "reconciliation-required",
      phase: "executing",
    } as unknown as StoredRun;
    expect(() => projectClientRunV1(broken)).toThrow();

    const degraded = projectClientRunOrDegradedV1(broken);
    expect(degraded).toMatchObject({
      runId: "run-events",
      status: "failed",
      outcome: { type: "failed" },
    });
    // And the degraded row is itself a valid projection, so the page decodes.
    expect(
      decodeClientRunPageV1(
        createClientRunListV1([degraded], { truncated: false }),
      ).runs,
    ).toHaveLength(1);
  });

  test("an interrupted Turn keeps the text it had already streamed", () => {
    const streamed: SessionEvent[] = [
      event({
        type: "assistant/chunk",
        seq: 0,
        timestamp,
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "The three things to know are",
      }),
      event({
        type: "assistant/chunk",
        seq: 1,
        timestamp,
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: " first, that",
      }),
    ];

    for (const status of ["cancelled", "superseded"] as const) {
      const projected = projectClientRunV1({
        ...storedRun(streamed, status),
        ...(status === "superseded"
          ? {
              supersededAt: "2026-08-28T00:00:05.000Z",
              supersededBy: "run-next",
            }
          : {}),
      });
      expect(projected.outcome).toMatchObject({
        type: status,
        text: "The three things to know are first, that",
      });
      // And it survives the wire: the client reads it as the Turn's text, with
      // the notice kept separately as the line that says why it stops there.
      const decoded = decodeClientRunPageV1(
        createClientRunListV1([projected], { truncated: false }),
      ).runs[0];
      expect(decoded?.responseText).toBe(
        "The three things to know are first, that",
      );
      expect(decoded?.failure).toBeDefined();
    }
  });

  test("a running Turn projects the words it has written so far", () => {
    const streamed: SessionEvent[] = [
      event({
        type: "assistant/chunk",
        seq: 0,
        timestamp,
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "Half a",
      }),
      event({
        type: "assistant/chunk",
        seq: 1,
        timestamp,
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: " thought",
      }),
    ];

    const projected = projectClientRunV1(storedRun(streamed, "running"));
    expect(projected.partialText).toBe("Half a thought");
    expect(projected.outcome).toBeUndefined();

    // And it survives the wire, so the thread draws it while the Turn runs.
    const decoded = decodeClientRunPageV1(
      createClientRunListV1([projected], { truncated: false }),
    ).runs[0];
    expect(decoded?.partialText).toBe("Half a thought");
    expect(decoded?.responseText).toBeUndefined();
  });

  test("a running Turn that has said nothing carries no partial text", () => {
    expect(projectClientRunV1(storedRun([], "running")).partialText).toBe(
      undefined,
    );
  });

  test("a later request restarts the partial answer", () => {
    const streamed: SessionEvent[] = [
      event({
        type: "assistant/chunk",
        seq: 0,
        timestamp,
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "scratch",
      }),
      event({
        type: "assistant/chunk",
        seq: 1,
        timestamp,
        turn: 1,
        step: 2,
        requestId: "request-2",
        text: "the answer",
      }),
    ];
    expect(projectClientRunV1(storedRun(streamed, "running")).partialText).toBe(
      "the answer",
    );
  });

  test("a settled Turn carries its answer once, as an outcome", () => {
    const projected = projectClientRunV1(storedRun([], "completed"));
    expect(projected.partialText).toBeUndefined();
    expect(projected.outcome).toMatchObject({ type: "completed" });

    const page = createClientRunListV1([projected], { truncated: false });
    const tampered = structuredClone(page) as unknown as {
      runs: Array<Record<string, unknown>>;
    };
    tampered.runs[0]!.partialText = "words";
    expect(() => decodeClientRunPageV1(tampered)).toThrow(
      "only a running run may carry partial text",
    );
  });

  test("refuses a chip whose background flag is not a boolean", () => {
    const page = createClientRunListV1(
      [projectClientRunV1(storedRun([dispatched]))],
      { truncated: false },
    );
    const tampered = structuredClone(page) as {
      runs: Array<{ events: Array<Record<string, unknown>> }>;
    };
    tampered.runs[0]!.events[0]!.background = "yes";
    expect(() => decodeClientRunPageV1(tampered)).toThrow(
      "run event.background must be a boolean",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { type SessionEvent } from "@frockbot/kernel-contracts";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import type { StoredRun } from "./backend-contracts.js";
import { planBotRunRecovery } from "./backend-recovery.js";
import {
  decodeClientNotificationAcknowledgementCommandV1,
  decodeClientRunAdmissionFenceCommandV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunReconciliationCommandV1,
  decodeClientTurnCommandV1,
  decodeClientRunLookupV1,
  decodeClientTurnV1,
  decodeClientRunPageV1,
  decodeClientRunListV1,
  decodeClientRunListQueryV1,
  projectClientRunLookupV1,
  projectClientRunListV1,
  projectClientTurnV1,
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
    status,
    phase: status === "reconciliation-required" ? status : "executing",
    compositionGenerationId: "test-composition-generation",
    configurationSnapshot: initializeBotSettingsV1("primary"),
    previousEventCount: 0,
    ...(status === "completed" ? { responseText: "done" } : {}),
    ...(status === "failed" ? { failure: "failed" } : {}),
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
          schemaVersion: 1,
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

  test("rejects orphaned tool history at projection", () => {
    const call = toolEvents(1)[0]!;
    const result = toolEvents(1)[1]!;

    expect(() => projectClientRunListV1([storedRun([result])])).toThrow(
      'tool result has no matching occurrence "tool:1:1:0"',
    );
    expect(() => projectClientRunListV1([storedRun([call])])).toThrow(
      'terminal run has no result for tool call "tool-1"',
    );
    expect(() =>
      projectClientRunListV1([storedRun([call, call, result])]),
    ).toThrow('tool occurrence "tool:1:1:0" has duplicate intent');
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
});

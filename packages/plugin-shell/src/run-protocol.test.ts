import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/agent-core";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import type { StoredRun } from "./backend-contracts.js";
import {
  decodeClientRunListV1,
  projectClientRunListV1,
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
      call: { id: `call-${index}`, name: "lookup", input: {} },
    }),
    event({
      type: "tool/result",
      seq: index * 2 + 1,
      timestamp,
      turn: 1,
      step: 1,
      callId: `call-${index}`,
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
    ...(status === "completed" ? { responseText: "done" } : {}),
    ...(status === "failed" ? { failure: "failed" } : {}),
  };
}

describe("client run protocol v1", () => {
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
          call: {
            id: "call-1",
            name: "calendar_lookup",
            input: { accessToken: "tool-input-secret" },
          },
        }),
        event({
          type: "tool/result",
          seq: 2,
          timestamp,
          turn: 1,
          step: 1,
          callId: "call-1",
          name: "calendar_lookup",
          content: "visible result",
          isError: false,
          status: "completed",
        }),
      ],
      status: "reconciliation-required",
      failure: "Provider confirmation required",
      phase: "reconciliation-required",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 17,
      internalDeadline: "2026-08-29T01:00:00.000Z",
      receipt: "receipt-secret",
    } satisfies StoredRun & {
      internalDeadline: string;
      receipt: string;
    };

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
              call: { id: "call-1", name: "calendar_lookup" },
            },
            {
              type: "tool/result",
              callId: "call-1",
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
      "internalDeadline",
      "receipt-secret",
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
      }),
    ).toThrow("run event.type is invalid");
  });

  test("bounds projected visible history and messages", () => {
    const stored: StoredRun = {
      runId: "run-bounded",
      commandFingerprint: "fingerprint",
      sessionId: "user:primary",
      acceptedAt: timestamp,
      input: "i".repeat(40_000),
      events: toolEvents(300),
      status: "failed",
      failure: "f".repeat(10_000),
    };

    const projected = projectClientRunListV1([stored]).runs[0];

    expect(projected?.input).toHaveLength(32_000);
    expect(projected?.events).toHaveLength(511);
    expect(projected?.events[0]).toEqual({
      type: "run/events-truncated",
      omittedInteractions: 45,
    });
    expect(projected?.events[1]).toMatchObject({
      type: "tool/call",
      call: { id: "call-45" },
    });
    expect(projected?.events.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "call-299",
    });
    expect(
      projected?.outcome?.type === "failed"
        ? projected.outcome.message
        : undefined,
    ).toHaveLength(8_000);
  });

  test("uses the full boundary without splitting an interaction", () => {
    const atBoundary = projectClientRunListV1([
      storedRun(toolEvents(256)),
    ]).runs[0];
    const overBoundary = projectClientRunListV1([
      storedRun(toolEvents(257)),
    ]).runs[0];

    expect(atBoundary?.events).toHaveLength(512);
    expect(atBoundary?.events[0]).toMatchObject({
      type: "tool/call",
      call: { id: "call-0" },
    });
    expect(atBoundary?.events.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "call-255",
    });
    expect(overBoundary?.events).toHaveLength(511);
    expect(overBoundary?.events[0]).toEqual({
      type: "run/events-truncated",
      omittedInteractions: 2,
    });
    expect(overBoundary?.events[1]).toMatchObject({
      type: "tool/call",
      call: { id: "call-2" },
    });
    expect(overBoundary?.events.at(-1)).toMatchObject({
      type: "tool/result",
      callId: "call-256",
    });
    expect(overBoundary?.outcome).toEqual({ type: "completed", text: "done" });
    expect(
      decodeClientRunListV1({ schemaVersion: 1, runs: [overBoundary] })[0]
        ?.events[0],
    ).toEqual({
      type: "run/events-truncated",
      omittedInteractions: 2,
    });
  });

  test("rejects orphaned tool history at projection", () => {
    const call = toolEvents(1)[0]!;
    const result = toolEvents(1)[1]!;

    expect(() => projectClientRunListV1([storedRun([result])])).toThrow(
      'tool result "call-0" has no matching call',
    );
    expect(() => projectClientRunListV1([storedRun([call])])).toThrow(
      'terminal run has no result for tool call "call-0"',
    );
    expect(() =>
      projectClientRunListV1([storedRun([call, call, result])]),
    ).toThrow('tool interaction "call-0" has a duplicate call');
  });

  test("retains pending calls only for nonterminal runs", () => {
    const call = toolEvents(1)[0]!;
    const projected = projectClientRunListV1([
      storedRun([call], "running"),
    ]).runs[0];

    expect(projected?.events).toEqual([
      { type: "tool/call", call: { id: "call-0", name: "lookup" } },
    ]);
    expect(
      decodeClientRunListV1({ schemaVersion: 1, runs: [projected] }),
    ).toMatchObject([
      { status: "running", events: [{ type: "tool/call" }] },
    ]);
  });
});

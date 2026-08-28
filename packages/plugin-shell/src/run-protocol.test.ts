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
      events: Array.from({ length: 600 }, (_, index) =>
        event({
          type: "tool/call",
          seq: index,
          timestamp,
          turn: 1,
          step: 1,
          call: { id: `call-${index}`, name: "lookup", input: {} },
        }),
      ),
      status: "failed",
      failure: "f".repeat(10_000),
    };

    const projected = projectClientRunListV1([stored]).runs[0];

    expect(projected?.input).toHaveLength(32_000);
    expect(projected?.events).toHaveLength(512);
    expect(
      projected?.outcome?.type === "failed"
        ? projected.outcome.message
        : undefined,
    ).toHaveLength(8_000);
  });
});

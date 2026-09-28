import { expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import { harvestRunV1 } from "./harvest.js";

const REFUSED = {
  decision: "reject",
  reasonCode: "no_authorization",
  judgments: [],
};

test("a recorded run yields its call reviews with the evidence production built", () => {
  // The snapshot kept only the tail, so the Turn's input is restored from the run.
  const events = [
    {
      type: "tool/call",
      turn: 18,
      step: 23,
      occurrenceId: "tool:18:23:0",
      name: "computer_exec",
      input: { command: "cat /tmp/out.json" },
    },
    {
      type: "tool/result",
      turn: 18,
      step: 23,
      occurrenceId: "tool:18:23:0",
      name: "computer_exec",
      content: "[]",
      isError: false,
      status: "completed",
    },
    {
      type: "tool/call",
      turn: 18,
      step: 24,
      occurrenceId: "tool:18:24:0",
      name: "call_dynamic_tool",
      input: {
        namespace: "gmail",
        toolName: "list_threads",
        arguments: { query: "newer_than:1d" },
      },
    },
    {
      type: "supervision/call",
      turn: 18,
      step: 24,
      occurrenceId: "tool:18:24:0",
      tool: "gmail/list_threads",
      decision: REFUSED,
      latencyMs: 400,
    },
    {
      type: "supervision/call",
      turn: 18,
      step: 24,
      occurrenceId: "tool:18:24:0:egress:0",
      tool: "credentialed_request",
      decision: REFUSED,
      latencyMs: 400,
    },
  ] as unknown as SessionEvent[];
  const [call, egress] = harvestRunV1({
    runId: "rf-1",
    input: 'Routine "Triage" fired (cron).\n\nCheck my inbox.',
    commandFingerprint:
      'bot-turn-command-v2:{"text":"x","origin":{"kind":"routine","routineId":"r","fireId":"f","trigger":"cron"}}',
    events,
    omittedEvents: 12,
  });
  expect(call).toMatchObject({
    kind: "call",
    tool: "gmail/list_threads",
    recorded: REFUSED,
    evidence: {
      origin: "schedule",
      call: {
        tool: "gmail/list_threads",
        arguments: { query: "newer_than:1d" },
      },
      conversation: [
        {
          speaker: "user",
          text: 'Routine "Triage" fired (cron).\n\nCheck my inbox.',
        },
      ],
      priorResults: [{ tool: "computer_exec", content: "[]" }],
    },
  });
  // An egress review's request is not in the journal, so it has no evidence.
  expect(egress).toMatchObject({ kind: "call", tool: "credentialed_request" });
  expect(
    egress && "evidence" in egress ? egress.evidence : undefined,
  ).toBeUndefined();
});

import { describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/core/configuration";
import type { StoredRun } from "@frockbot/app/shell/backend-contracts";
import { projectClientRunV1 } from "@frockbot/app/shell/run-protocol";
import {
  isSettledSearchRunV1,
  searchRowsFromClientRunV1,
  type SearchProjectableRunV1,
} from "./bot.ts";

type TestRun = SearchProjectableRunV1 & { responseText?: string };
function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: "run-1",
    admittedAt: "2026-08-31T00:00:00.000Z",
    input: "How is the gym build going?",
    status: "completed",
    events: [
      {
        type: "send/to-user",
        payload: { type: "text", text: "Framing is done." },
      },
    ],
    responseText: "Framing is done.",
    ...overrides,
  };
}

describe("the settled-run projection", () => {
  test("a completion with no explicit send contributes no assistant message", () => {
    const rows = searchRowsFromClientRunV1(
      "bot-a",
      run({
        events: [],
        responseText: "Private https://private.example/completion",
      }),
    );
    expect(rows.map((row) => row.kind)).toEqual(["user"]);
  });
  test("indexes sent messages and attachments instead of unspoken model text", () => {
    const rows = searchRowsFromClientRunV1(
      "bot-a",
      run({
        responseText: "private model completion",
        events: [
          {
            type: "send/to-user",
            payload: {
              type: "text",
              text: "The school report is ready: https://school.example/report.",
            },
          },
          {
            type: "send/to-user",
            payload: {
              type: "attachment",
              name: "school-report.pdf",
              mediaType: "application/pdf",
              url: "https://files.example/report.pdf",
            },
          },
          {
            type: "send/to-user",
            payload: { type: "text", text: "Second message" },
          },
          { type: "tool/call", call: { id: "call-1", name: "fetch" } },
          {
            type: "tool/result",
            callId: "call-1",
            content: "https://private.example/tool-result",
          },
        ],
      }),
    );
    expect(
      rows.filter((row) => row.kind === "assistant").map((row) => row.body),
    ).toEqual([
      "The school report is ready: https://school.example/report.",
      "Second message",
    ]);
    expect(
      rows.filter((row) => row.kind === "media").map((row) => row.body),
    ).toEqual([
      "school-report.pdf\napplication/pdf\nhttps://files.example/report.pdf",
    ]);
    expect(
      rows.filter((row) => row.kind === "link").map((row) => row.body),
    ).toEqual(["https://school.example/report"]);
    expect(
      rows.some((row) => row.body.includes("private model completion")),
    ).toBe(false);
  });

  test("retains sends made before a failed turn, and deduplicates public links", () => {
    const rows = searchRowsFromClientRunV1(
      "bot-a",
      run({
        status: "failed",
        input:
          "Read [this](https://example.com/report) and https://user:password@example.com/private",
        events: [
          {
            type: "send/to-user",
            payload: {
              type: "text",
              text: "Received https://example.com/report",
            },
          },
        ],
      }),
    );
    expect(
      rows.filter((row) => row.kind === "link").map((row) => row.body),
    ).toEqual(["https://example.com/report"]);
    expect(rows.some((row) => row.kind === "assistant")).toBe(true);
  });

  test("projects the user input and the assistant answer", () => {
    expect(searchRowsFromClientRunV1("bot-a", run())).toEqual([
      {
        botId: "bot-a",
        runId: "run-1",
        seq: 0,
        kind: "user",
        at: "2026-08-31T00:00:00.000Z",
        body: "How is the gym build going?",
      },
      {
        botId: "bot-a",
        runId: "run-1",
        seq: 1,
        kind: "assistant",
        at: "2026-08-31T00:00:00.000Z",
        body: "Framing is done.",
      },
    ]);
  });

  test("projects a tool call with its result as one `tool` row", () => {
    const rows = searchRowsFromClientRunV1(
      "bot-a",
      run({
        events: [
          { type: "tool/call", call: { id: "tool-1", name: "shell" } },
          { type: "tool/result", callId: "tool-1", content: "ok" },
          {
            type: "send/to-user",
            payload: { type: "text", text: "Framing is done." },
          },
        ],
      }),
    );
    expect(rows.map((entry) => entry.kind)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    expect(rows[1]!.body).toBe("shell\nok");
  });

  test("indexes the tool a namespaced call actually ran, not its wrapper", () => {
    const at = "2026-08-31T00:00:00.000Z";
    const dynamicRun = (namespace: string, toolName: string): StoredRun => ({
      runId: "run-dynamic",
      commandFingerprint: "fingerprint",
      sessionId: "user:session",
      acceptedAt: at,
      input: "run the tests",
      events: [
        {
          type: "tool/call",
          seq: 0,
          timestamp: at,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "call_dynamic_tool",
          input: { namespace, toolName, arguments: { command: "npm test" } },
        },
        {
          type: "tool/result",
          seq: 1,
          timestamp: at,
          turn: 1,
          step: 1,
          occurrenceId: "tool:1:1:0",
          name: "call_dynamic_tool",
          content: "ok",
          isError: false,
          status: "completed",
        },
      ],
      effectAdmissions: [],
      status: "completed",
      responseText: "Tests pass.",
      phase: "executing",
      compositionGenerationId: "generation-1",
      configurationSnapshot: initializeBotSettingsV1("primary"),
      previousEventCount: 0,
    });

    const firstParty = searchRowsFromClientRunV1(
      "bot-a",
      projectClientRunV1(dynamicRun("frockbot", "computer_exec")),
    );
    expect(firstParty.find((entry) => entry.kind === "tool")?.body).toBe(
      "frockbot/computer_exec\nok",
    );

    const external = searchRowsFromClientRunV1(
      "bot-a",
      projectClientRunV1(dynamicRun("user-Github--acme", "search_issues")),
    );
    expect(external.find((entry) => entry.kind === "tool")?.body).toBe(
      "user-Github--acme/search_issues\nok",
    );
  });

  test("projects nothing for a run that has not settled", () => {
    expect(isSettledSearchRunV1({ status: "running" })).toBe(false);
    expect(
      searchRowsFromClientRunV1("bot-a", run({ status: "running" })),
    ).toEqual([]);
  });

  test("a failed run still contributes its user input", () => {
    const rows = searchRowsFromClientRunV1(
      "bot-a",
      run({
        status: "failed",
        responseText: undefined,
        events: [],
      }),
    );
    expect(rows.map((entry) => entry.kind)).toEqual(["user"]);
  });

  test("is deterministic, so a rebuild reproduces the settlement-time rows", () => {
    const settled = run({
      events: [
        { type: "tool/call", call: { id: "tool-1", name: "shell" } },
        { type: "tool/result", callId: "tool-1", content: "ok" },
      ],
    });
    expect(searchRowsFromClientRunV1("bot-a", settled)).toEqual(
      searchRowsFromClientRunV1("bot-a", settled),
    );
  });

  test("drops empty bodies without leaving a gap in `seq`", () => {
    const rows = searchRowsFromClientRunV1(
      "bot-a",
      run({
        events: [
          { type: "send/to-user", payload: { type: "text", text: "   " } },
        ],
      }),
    );
    expect(rows.map((entry) => entry.seq)).toEqual([0]);
  });

  test("projects nothing for a run with no admission time to order it by", () => {
    expect(
      searchRowsFromClientRunV1("bot-a", run({ admittedAt: undefined })),
    ).toEqual([]);
  });
});

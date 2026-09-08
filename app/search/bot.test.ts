import { describe, expect, test } from "bun:test";
import {
  isSettledSearchRunV1,
  searchRowsFromClientRunV1,
  type SearchProjectableRunV1,
} from "./bot.ts";

function run(
  overrides: Partial<SearchProjectableRunV1> = {},
): SearchProjectableRunV1 {
  return {
    runId: "run-1",
    admittedAt: "2026-08-31T00:00:00.000Z",
    input: "How is the gym build going?",
    status: "completed",
    events: [],
    responseText: "Framing is done.",
    ...overrides,
  };
}

describe("the settled-run projection", () => {
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
      run({ responseText: "   " }),
    );
    expect(rows.map((entry) => entry.seq)).toEqual([0]);
  });

  test("projects nothing for a run with no admission time to order it by", () => {
    expect(
      searchRowsFromClientRunV1("bot-a", run({ admittedAt: undefined })),
    ).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  decodeRunList,
  decodeTurnResponse,
  listRuns,
  requestTurn,
  toolsFrom,
} from "./transport.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("decodeTurnResponse", () => {
  test("decodes a turn with tool events", () => {
    expect(
      decodeTurnResponse({
        schemaVersion: 1,
        runId: "run-1",
        text: "hello",
        events: [
          {
            type: "tool/call",
            call: { id: "tool-1", name: "echo" },
          },
          {
            type: "tool/result",
            callId: "tool-1",
            content: "hi",
            isError: false,
          },
        ],
      }),
    ).toEqual({
      runId: "run-1",
      text: "hello",
      events: [
        {
          type: "tool/call",
          call: { id: "tool-1", name: "echo" },
        },
        {
          type: "tool/result",
          callId: "tool-1",
          content: "hi",
          isError: false,
        },
      ],
    });
  });

  test("rejects malformed payloads", () => {
    expect(() => decodeTurnResponse(null)).toThrow("turn must be an object");
    expect(() =>
      decodeTurnResponse({ schemaVersion: 1, runId: 1, text: "x", events: [] }),
    ).toThrow("turn.runId must be a bounded string");
    expect(() =>
      decodeTurnResponse({ schemaVersion: 1, runId: "r", text: "x" }),
    ).toThrow("turn.events must be a bounded array");
    expect(() =>
      decodeTurnResponse({
        schemaVersion: 1,
        runId: "r",
        text: "x",
        events: [{ type: 3 }],
      }),
    ).toThrow("run event.type is invalid");
    expect(() =>
      decodeTurnResponse({
        schemaVersion: 1,
        runId: "r",
        text: "x",
        events: [{ type: "tool/call", call: { id: "c" } }],
      }),
    ).toThrow("run event.call.name must be a wire-bounded string");
    expect(() =>
      decodeTurnResponse({
        schemaVersion: 1,
        runId: "r",
        text: "x",
        events: [{ type: "tool/result", isError: "no" }],
      }),
    ).toThrow("run event.isError must be a boolean");
  });
});

describe("decodeRunList", () => {
  test("decodes stored runs", () => {
    expect(
      decodeRunList({
        schemaVersion: 1,
        runs: [
          {
            schemaVersion: 1,
            runId: "run-1",
            admittedAt: "2026-08-27T00:00:00.000Z",
            input: "hello",
            status: "completed",
            events: [],
            outcome: { type: "completed", text: "done" },
          },
        ],
        page: { truncated: false },
      }),
    ).toEqual([
      {
        runId: "run-1",
        admittedAt: "2026-08-27T00:00:00.000Z",
        input: "hello",
        status: "completed",
        events: [],
        responseText: "done",
      },
    ]);
  });

  test("rejects malformed payloads", () => {
    expect(() => decodeRunList({})).toThrow(
      "run list.schemaVersion is invalid",
    );
    expect(() =>
      decodeRunList({
        schemaVersion: 1,
        runs: [{ runId: "run-1" }],
        page: { truncated: false },
      }),
    ).toThrow("run.schemaVersion is invalid");
  });
});

describe("toolsFrom", () => {
  test("pairs calls with their results", () => {
    expect(
      toolsFrom([
        { type: "tool/call", call: { id: "a", name: "echo" } },
        { type: "tool/call", call: { id: "b", name: "clock" } },
        { type: "tool/result", callId: "a", content: "ok", isError: false },
        { type: "tool/result", callId: "b", content: "bad", isError: true },
        { type: "tool/result", callId: "missing", content: "ignored" },
      ]),
    ).toEqual([
      { id: "a", name: "echo", status: "completed", text: "ok" },
      { id: "b", name: "clock", status: "failed", text: "bad" },
    ]);
  });

  test("leaves an unresolved call running", () => {
    expect(
      toolsFrom([{ type: "tool/call", call: { id: "a", name: "echo" } }]),
    ).toEqual([{ id: "a", name: "echo", status: "running" }]);
  });
});

describe("gateway requests", () => {
  test("posts a turn and decodes the response", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const result = await requestTurn(
      (path, init) => {
        calls.push({ path, init });
        return Promise.resolve(
          jsonResponse({
            schemaVersion: 1,
            runId: "run-1",
            text: "hi",
            events: [],
          }),
        );
      },
      "my bot",
      "hello",
      "command-1",
    );

    expect(result).toEqual({ runId: "run-1", text: "hi", events: [] });
    expect(calls[0]?.path).toBe("/api/bots/my%20bot/turns");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ text: "hello", commandId: "command-1" }),
    );
  });

  test("surfaces a gateway error body", async () => {
    let failure: unknown;
    try {
      await requestTurn(
        () => Promise.resolve(jsonResponse({ error: "invalid prompt" }, 400)),
        "default",
        "",
        "command-1",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("invalid prompt");
  });

  test("reports a non-JSON gateway response", async () => {
    let failure: unknown;
    try {
      await requestTurn(
        () => Promise.resolve(new Response("<html>", { status: 502 })),
        "default",
        "hello",
        "command-1",
      );
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe(
      "gateway returned a malformed response (502)",
    );
  });

  test("lists runs", async () => {
    const runs = await listRuns(
      () =>
        Promise.resolve(
          jsonResponse({
            schemaVersion: 1,
            runs: [
              {
                schemaVersion: 1,
                runId: "run-1",
                admittedAt: "2026-08-27T00:00:00.000Z",
                input: "hello",
                status: "completed",
                events: [],
                outcome: { type: "completed", text: "done" },
              },
            ],
            page: { truncated: false },
          }),
        ),
      "default",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-1");
  });
});

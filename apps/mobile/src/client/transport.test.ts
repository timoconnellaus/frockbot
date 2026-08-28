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
        runId: "run-1",
        text: "hello",
        events: [
          { type: "tool/call", call: { id: "call-1", name: "echo" } },
          {
            type: "tool/result",
            callId: "call-1",
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
          call: { id: "call-1", name: "echo" },
          callId: undefined,
          content: undefined,
        },
        {
          type: "tool/result",
          callId: "call-1",
          content: "hi",
          isError: false,
        },
      ],
    });
  });

  test("rejects malformed payloads", () => {
    expect(() => decodeTurnResponse(null)).toThrow(
      "turn response must be an object",
    );
    expect(() =>
      decodeTurnResponse({ runId: 1, text: "x", events: [] }),
    ).toThrow('turn response field "runId" must be a string');
    expect(() => decodeTurnResponse({ runId: "r", text: "x" })).toThrow(
      'turn response field "events" must be an array',
    );
    expect(() =>
      decodeTurnResponse({ runId: "r", text: "x", events: [{ type: 3 }] }),
    ).toThrow('turn event field "type" must be a string');
    expect(() =>
      decodeTurnResponse({
        runId: "r",
        text: "x",
        events: [{ type: "tool/call", call: { id: "c" } }],
      }),
    ).toThrow('tool call field "name" must be a string');
    expect(() =>
      decodeTurnResponse({
        runId: "r",
        text: "x",
        events: [{ type: "tool/result", isError: "no" }],
      }),
    ).toThrow('turn event field "isError" must be a boolean');
  });
});

describe("decodeRunList", () => {
  test("decodes stored runs", () => {
    expect(
      decodeRunList({
        runs: [
          {
            runId: "run-1",
            sessionId: "user:default",
            acceptedAt: "2026-08-27T00:00:00.000Z",
            input: "hello",
            events: [],
          },
        ],
      }),
    ).toEqual([
      {
        runId: "run-1",
        sessionId: "user:default",
        acceptedAt: "2026-08-27T00:00:00.000Z",
        input: "hello",
      },
    ]);
  });

  test("rejects malformed payloads", () => {
    expect(() => decodeRunList({})).toThrow(
      'run list field "runs" must be an array',
    );
    expect(() => decodeRunList({ runs: [{ runId: "run-1" }] })).toThrow(
      'run field "sessionId" must be a string',
    );
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
          jsonResponse({ runId: "run-1", text: "hi", events: [] }),
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
            runs: [
              {
                runId: "run-1",
                sessionId: "s",
                acceptedAt: "2026-08-27T00:00:00.000Z",
                input: "hello",
              },
            ],
          }),
        ),
      "default",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run-1");
  });
});

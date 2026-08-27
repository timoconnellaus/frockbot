import { describe, expect, test } from "bun:test";
import type { NormalizedModelRequest } from "@frockbot/agent-core";
import { OpenAICompatibleProvider, requestToWire } from "./index.js";

const request: NormalizedModelRequest = {
  requestId: "request-1",
  provider: "openai-compatible",
  model: "test-model",
  system: "Be useful.",
  messages: [
    { role: "user", content: "What time is it?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "previous", name: "lookup", input: { query: "time" } }],
    },
    {
      role: "tool",
      callId: "previous",
      name: "lookup",
      content: "noon",
      isError: false,
    },
  ],
  tools: [
    {
      name: "current_time",
      description: "Return the time.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

describe("OpenAICompatibleProvider", () => {
  test("normalizes FrockBot messages and tools to the wire format", () => {
    expect(requestToWire(request)).toMatchObject({
      model: "test-model",
      stream: true,
      messages: [
        { role: "system", content: "Be useful." },
        { role: "user", content: "What time is it?" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "previous",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"time"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "previous", content: "noon" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "current_time", description: "Return the time." },
        },
      ],
    });
  });

  test("streams text and assembles fragmented tool calls", async () => {
    const encoder = new TextEncoder();
    const payloads = [
      'data: {"choices":[{"delta":{"content":"Checking "}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"current_","arguments":"{\\"zone\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"time","arguments":"\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    let capturedUrl = "";
    let capturedAuthorization = "";
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      capturedAuthorization =
        new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const payload of payloads)
              controller.enqueue(encoder.encode(payload));
            controller.close();
          },
        }),
        { status: 200 },
      );
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1/",
      apiKey: "secret",
      fetch: fetcher,
    });

    const events = [];
    for await (const event of provider.stream(
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(capturedUrl).toBe("https://models.example/v1/chat/completions");
    expect(capturedAuthorization).toBe("Bearer secret");
    expect(events).toEqual([
      { type: "text-delta", text: "Checking " },
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "current_time",
          input: { zone: "UTC" },
        },
      },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  test("surfaces bounded HTTP errors", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () =>
        Promise.resolve(new Response("bad credentials", { status: 401 })),
    });

    let failure: unknown;
    try {
      for await (const _event of provider.stream(
        request,
        new AbortController().signal,
      )) {
        // No events are expected from a failed response.
      }
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error ? failure.message : "").toContain(
      "Model request failed (401): bad credentials",
    );
  });
});

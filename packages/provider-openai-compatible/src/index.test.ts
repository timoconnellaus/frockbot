import { describe, expect, test } from "bun:test";
import { LlmRegistry, type NormalizedModelRequest } from "@frockbot/agent-core";
import { Context } from "cordis";
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
    let capturedIdempotencyKey: string | null = null;
    const fetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(input);
      capturedAuthorization =
        new Headers(init?.headers).get("authorization") ?? "";
      capturedIdempotencyKey = new Headers(init?.headers).get(
        "idempotency-key",
      );
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
    expect(capturedIdempotencyKey).toBeNull();
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

  test("rejects a truncated stream without a terminal marker", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () =>
        Promise.resolve(
          new Response(
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
            { status: 200 },
          ),
        ),
    });
    const events = [];
    let failure: unknown;

    try {
      for await (const event of provider.stream(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    } catch (error) {
      failure = error;
    }

    expect(events).toEqual([{ type: "text-delta", text: "partial" }]);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toBe(
      "Model response stream ended before a terminal marker",
    );
  });

  test("cancels an oversized unterminated stream", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(`data: ${"x".repeat(1_048_577)}`),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200 },
          ),
        ),
    });

    let failure: unknown;
    try {
      for await (const _event of provider.stream(
        request,
        new AbortController().signal,
      )) {
        throw new Error("unexpected stream event");
      }
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof Error ? failure.message : "").toBe(
      "Model response stream exceeded its size limit",
    );
    expect(cancelled).toBe(true);
  });

  test("reports retrieval unavailable without another provider request", async () => {
    let requests = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () => {
        requests += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      },
    });
    const root = new Context();
    await root.plugin(LlmRegistry);
    root.llm.register(provider);

    const outcome = await root.llm.reconcile(
      request,
      new AbortController().signal,
    );

    expect(outcome).toEqual({
      status: "unavailable",
      reason:
        'LLM provider "openai-compatible" does not support provider-bound retrieval',
    });
    expect(requests).toBe(0);
    await root.fiber.dispose();
  });

  test("redacts provider response bodies from HTTP errors", async () => {
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
    expect(failure instanceof Error ? failure.message : "").toBe(
      "Model request failed (401)",
    );
  });
});

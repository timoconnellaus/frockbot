import { describe, expect, test } from "bun:test";
import {
  ModelProviderFailureError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import { Context } from "cordis";
import {
  OpenAICompatibleProvider,
  planOpenAICompatibleRequestV1,
  requestToWire,
  retryAfterMillisecondsV1,
  usageFromPayloadV1,
} from "./index.js";

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
  test("maps schemas for OpenAI and OpenRouter-compatible endpoints", () => {
    const structured = {
      ...request,
      responseFormat: {
        type: "json_schema" as const,
        name: "answer",
        schema: {
          type: "object" as const,
          properties: { answer: { type: "string" as const } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    };
    const plan = planOpenAICompatibleRequestV1(structured, {
      structuredOutput: "json_schema",
      responseFormatDialect: "openai",
    });
    expect(plan.note).toBeUndefined();
    expect(plan.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: structured.responseFormat.schema,
      },
    });
    expect(plan.body.stream).toBe(true);
  });

  test("maps the direct Workers AI schema and disables streaming", () => {
    const structured: NormalizedModelRequest = {
      ...request,
      responseFormat: {
        type: "json_schema",
        name: "answer",
        schema: { type: "string" },
      },
    };
    const plan = planOpenAICompatibleRequestV1(structured, {
      structuredOutput: "json_schema",
      responseFormatDialect: "workers-ai",
    });
    expect(plan.body.response_format).toEqual({
      type: "json_schema",
      json_schema: { type: "string" },
    });
    expect(plan.body.stream).toBe(false);
    expect(plan.body.stream_options).toBeUndefined();
  });

  test("downgrades unsupported schemas explicitly and adds prompt guidance", () => {
    const plan = planOpenAICompatibleRequestV1(
      {
        ...request,
        responseFormat: {
          type: "json_schema",
          name: "answer",
          schema: { type: "string" },
        },
      },
      { structuredOutput: "none" },
    );
    expect(plan.note).toMatchObject({
      code: "structured-output-downgraded",
      effective: "prompt",
    });
    expect(JSON.stringify(plan.body.messages)).toContain("Return only JSON");
    expect(plan.body.response_format).toBeUndefined();
  });

  test("normalizes FrockBot messages and tools to the wire format", () => {
    expect(requestToWire(request)).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
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

  test("normalizes OpenAI token details", () => {
    expect(
      usageFromPayloadV1({
        usage: {
          prompt_tokens: 80,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 32 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      }),
    ).toEqual({
      type: "usage",
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 32,
        reasoningTokens: 7,
      },
    });
  });

  test("normalizes Workers AI and Ollama token fields", () => {
    expect(
      usageFromPayloadV1({ usage: { input_tokens: 12, output_tokens: 4 } }),
    ).toEqual({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(
      usageFromPayloadV1({ prompt_eval_count: 18, eval_count: 6 }),
    ).toEqual({
      type: "usage",
      usage: { inputTokens: 18, outputTokens: 6 },
    });
  });

  test("streams text and assembles fragmented tool calls", async () => {
    const encoder = new TextEncoder();
    const payloads = [
      'data: {"choices":[{"delta":{"content":"Checking "}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"current_","arguments":"{\\"zone\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"time","arguments":"\\"UTC\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":10}}}\n\n',
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
        type: "usage",
        usage: { inputTokens: 40, outputTokens: 9, cachedInputTokens: 10 },
      },
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

  test("normalizes a non-streaming structured response", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      structuredOutput: "json_schema",
      responseFormatDialect: "workers-ai",
      fetch: () =>
        Promise.resolve(
          Response.json({
            usage: { input_tokens: 14, output_tokens: 5 },
            choices: [
              {
                message: { content: '{"answer":"yes"}' },
                finish_reason: "stop",
              },
            ],
          }),
        ),
    });
    const events = [];
    for await (const event of provider.stream(
      {
        ...request,
        responseFormat: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", additionalProperties: true },
        },
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 14, outputTokens: 5 },
      },
      { type: "text-delta", text: '{"answer":"yes"}' },
      { type: "finish", reason: "completed" },
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

  test.each([
    "data: [DONE]\n\n",
    'data: {"model":"test-model"}\n\ndata: [DONE]\n\n',
  ])("rejects a terminal stream without a choice", async (body) => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
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
      "Model response stream did not include a valid choice",
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

  test("reports retrieval as not retrievable without another provider request", async () => {
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
      status: "not-retrievable",
      reason:
        'LLM provider "openai-compatible" does not support provider-bound retrieval',
    });
    expect(requests).toBe(0);
    await root.fiber.dispose();
  });

  test.each([
    [400, "permanent"],
    [401, "permanent"],
    [403, "permanent"],
    [404, "permanent"],
    [413, "permanent"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
    [418, "unknown"],
  ] as const)("classifies HTTP %i as %s", async (status, classification) => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { message: "provider reason", code: "provider_code" } },
            {
              status,
              headers: status === 429 ? { "retry-after": "3" } : {},
            },
          ),
        ),
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
    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect((failure as ModelProviderFailureError).classification).toBe(
      classification,
    );
    expect((failure as ModelProviderFailureError).providerReason).toContain(
      "provider reason",
    );
    expect((failure as ModelProviderFailureError).retryAfterMs).toBe(
      status === 429 ? 3_000 : undefined,
    );
  });

  test("classifies content policy and network reset shapes", async () => {
    const content = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                message: "blocked",
                code: "content_policy_violation",
              },
            },
            { status: 422 },
          ),
        ),
    });
    const reset = new OpenAICompatibleProvider({
      baseUrl: "https://models.example/v1",
      fetch: () => Promise.reject(new TypeError("socket reset")),
    });
    for (const [provider, classification] of [
      [content, "permanent"],
      [reset, "transient"],
    ] as const) {
      const failure = await collectFailure(provider);
      expect((failure as ModelProviderFailureError).classification).toBe(
        classification,
      );
    }
  });

  test("parses both Retry-After forms", () => {
    expect(retryAfterMillisecondsV1("1.5", 0)).toBe(1_500);
    expect(
      retryAfterMillisecondsV1("Thu, 01 Jan 1970 00:00:05 GMT", 2_000),
    ).toBe(3_000);
  });
});

async function collectFailure(provider: OpenAICompatibleProvider) {
  try {
    for await (const event of provider.stream(
      request,
      new AbortController().signal,
    )) {
      void event;
    }
  } catch (error) {
    return error;
  }
  throw new Error("provider did not fail");
}

// An image a tool produced, on the wire.
//
// Two behaviours, and the difference between them has to be visible in the
// request: a model that takes images is shown the picture, and a model that
// does not is *told* where it is. Silently dropping it would make a Bot that
// asked for a screenshot indistinguishable from one that got nothing.
describe("tool result attachments", () => {
  const attachment = {
    kind: "image" as const,
    mediaType: "image/png" as const,
    workspacePath: {
      root: {
        kind: "package-declared" as const,
        userId: "user-1",
        packageId: "computer",
        rootId: "screenshots",
      },
      path: "bot-1/run-9-1.png",
    },
    contentHash: "b".repeat(64),
    bytes: 3,
  };

  function requestWith(model: string, dataBase64?: string) {
    return {
      requestId: "request-1",
      provider: "openai-compatible",
      model,
      system: "",
      tools: [],
      messages: [
        {
          role: "tool" as const,
          callId: "call-1",
          name: "computer_screenshot",
          content: '{"path":"bot-1/run-9-1.png"}',
          isError: false,
          attachments: [
            { ...attachment, ...(dataBase64 ? { dataBase64 } : {}) },
          ],
        },
      ],
    };
  }

  test("shows a vision model the image as a following user message", () => {
    const wire = requestToWire(requestWith("gpt-4o", "AAAA"));
    const messages = wire.messages as Record<string, unknown>[];

    expect(messages[0]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(messages[1]).toMatchObject({ role: "user" });
    expect(JSON.stringify(messages[1])).toContain("data:image/png;base64,AAAA");
  });

  test("tells a model that takes no image where the image is", () => {
    const wire = requestToWire(requestWith("llama3-8b", "AAAA"));
    const messages = wire.messages as Record<string, unknown>[];

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("not shown to this model");
    expect(messages[0]!.content).toContain("bot-1/run-9-1.png");
    expect(JSON.stringify(wire)).not.toContain("AAAA");
  });

  test("says so when a vision model's image could not be resolved", () => {
    const wire = requestToWire(requestWith("gpt-4o"));
    const messages = wire.messages as Record<string, unknown>[];

    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("not shown to this model");
  });

  test("lets an explicit acceptsImages override the model-name guess", () => {
    const shown = requestToWire(requestWith("some-local-model", "AAAA"), {
      acceptsImages: true,
    });
    expect((shown.messages as unknown[]).length).toBe(2);

    const withheld = requestToWire(requestWith("gpt-4o", "AAAA"), {
      acceptsImages: false,
    });
    expect((withheld.messages as unknown[]).length).toBe(1);
  });
});

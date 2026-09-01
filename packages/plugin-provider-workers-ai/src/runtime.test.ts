import { describe, expect, test } from "bun:test";
import {
  LlmEffectNotStartedError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import { Context } from "cordis";
import {
  WORKERS_AI_CONNECTION_GENERATION,
  WORKERS_AI_CONNECTION_ID,
  WORKERS_AI_DEFAULT_MODEL,
} from "./catalog.js";
import { createWorkersAiRuntimePlugin } from "./runtime.js";

const request: NormalizedModelRequest = {
  requestId: "effect-1",
  provider: "workers-ai",
  model: WORKERS_AI_DEFAULT_MODEL,
  system: "Be concise.",
  messages: [{ role: "user", content: "hello" }],
  tools: [
    {
      name: "weather",
      description: "Read the weather",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  modelBinding: {
    connectionId: WORKERS_AI_CONNECTION_ID,
    connectionGeneration: WORKERS_AI_CONNECTION_GENERATION,
  },
};

function sse(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (!body) throw new Error("test response stream is unavailable");
  return body;
}

describe("Workers AI runtime Contribution", () => {
  test("translates the request and normalizes text and tool-call deltas", async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createWorkersAiRuntimePlugin({
        connectionId: WORKERS_AI_CONNECTION_ID,
        connectionGeneration: WORKERS_AI_CONNECTION_GENERATION,
        run: (model, input) => {
          calls.push({ model, input });
          return Promise.resolve(
            sse(
              'data: {"choices":[{"delta":{"content":"Working"}}]}\n\n' +
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"weather","arguments":"{\\"city\\":\\"Sydney\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
                "data: [DONE]\n\n",
            ),
          );
        },
      }),
    );

    const events = [];
    for await (const event of root.llm.stream(
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(calls).toEqual([
      {
        model: WORKERS_AI_DEFAULT_MODEL,
        input: {
          stream: true,
          messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "hello" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "weather",
                description: "Read the weather",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        },
      },
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "Working" },
      {
        type: "tool-call",
        call: {
          id: "call-1",
          name: "weather",
          input: { city: "Sydney" },
        },
      },
      { type: "finish", reason: "tool-calls" },
    ]);
    await root.fiber.dispose();
  });

  test("refuses a request outside its pinned Connection generation", async () => {
    let calls = 0;
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createWorkersAiRuntimePlugin({
        connectionId: WORKERS_AI_CONNECTION_ID,
        connectionGeneration: WORKERS_AI_CONNECTION_GENERATION,
        run: () => {
          calls += 1;
          return Promise.resolve(sse(""));
        },
      }),
    );
    const mismatched = {
      ...request,
      modelBinding: {
        ...request.modelBinding!,
        connectionGeneration: "different-generation",
      },
    };

    await expect(
      (async () => {
        for await (const event of root.llm.stream(
          mismatched,
          new AbortController().signal,
        )) {
          void event;
        }
      })(),
    ).rejects.toBeInstanceOf(LlmEffectNotStartedError);
    expect(calls).toBe(0);
    await root.fiber.dispose();
  });

  test("cancels the native response stream when the Turn is aborted", async () => {
    let cancelled = false;
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createWorkersAiRuntimePlugin({
        connectionId: WORKERS_AI_CONNECTION_ID,
        connectionGeneration: WORKERS_AI_CONNECTION_GENERATION,
        run: () =>
          Promise.resolve(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      }),
    );
    const controller = new AbortController();
    const consume = (async () => {
      for await (const event of root.llm.stream(request, controller.signal)) {
        void event;
      }
    })();

    await Promise.resolve();
    controller.abort(new Error("Turn cancelled"));
    await expect(consume).rejects.toThrow("Turn cancelled");
    expect(cancelled).toBe(true);
    await root.fiber.dispose();
  });
});

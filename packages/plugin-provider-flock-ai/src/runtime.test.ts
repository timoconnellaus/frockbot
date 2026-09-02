import { describe, expect, test } from "bun:test";
import {
  LlmEffectNotStartedError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import { Context } from "cordis";
import {
  FLOCK_AI_CONNECTION_GENERATION,
  FLOCK_AI_CONNECTION_ID,
  FLOCK_AI_DEFAULT_MODEL,
} from "./catalog.js";
import { createFlockAiRuntimePlugin } from "./runtime.js";

const request: NormalizedModelRequest = {
  requestId: "effect-1",
  provider: "flock-ai",
  model: FLOCK_AI_DEFAULT_MODEL,
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
    connectionId: FLOCK_AI_CONNECTION_ID,
    connectionGeneration: FLOCK_AI_CONNECTION_GENERATION,
  },
};

function sse(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (!body) throw new Error("test response stream is unavailable");
  return body;
}

function runtimeConfig(
  runChatCompletion: Parameters<
    typeof createFlockAiRuntimePlugin
  >[0]["runChatCompletion"],
) {
  return {
    connectionId: FLOCK_AI_CONNECTION_ID,
    connectionGeneration: FLOCK_AI_CONNECTION_GENERATION,
    autoRoute: "configured-auto",
    runChatCompletion,
  };
}

describe("Flock AI runtime Contribution", () => {
  test.each([
    [FLOCK_AI_DEFAULT_MODEL, "dynamic/configured-auto"],
    [
      "@flock/deepseek-ai/deepseek-v4-flash-0731",
      "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
    ],
  ])("maps %s to gateway model %s", async (model, expectedGatewayModel) => {
    const calls: Array<{
      gatewayModel: string;
      body: Record<string, unknown>;
    }> = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFlockAiRuntimePlugin(
        runtimeConfig((gatewayModel, body) => {
          calls.push({ gatewayModel, body });
          return Promise.resolve(
            sse(
              'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
                "data: [DONE]\n\n",
            ),
          );
        }),
      ),
    );

    for await (const event of root.llm.stream(
      { ...request, model },
      new AbortController().signal,
    )) {
      void event;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.gatewayModel).toBe(expectedGatewayModel);
    expect(calls[0]?.body).not.toHaveProperty("model");
    await root.fiber.dispose();
  });

  test("normalizes gateway text and tool-call deltas", async () => {
    const calls: Array<{
      gatewayModel: string;
      body: Record<string, unknown>;
    }> = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFlockAiRuntimePlugin(
        runtimeConfig((gatewayModel, body) => {
          calls.push({ gatewayModel, body });
          return Promise.resolve(
            sse(
              'data: {"choices":[{"delta":{"content":"Working"}}]}\n\n' +
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"weather","arguments":"{\\"city\\":\\"Sydney\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
                "data: [DONE]\n\n",
            ),
          );
        }),
      ),
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
        gatewayModel: "dynamic/configured-auto",
        body: {
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
      createFlockAiRuntimePlugin(
        runtimeConfig(() => {
          calls += 1;
          return Promise.resolve(sse(""));
        }),
      ),
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

  test("cancels the gateway response stream when the Turn is aborted", async () => {
    let cancelled = false;
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFlockAiRuntimePlugin(
        runtimeConfig(() =>
          Promise.resolve(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
        ),
      ),
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

import { describe, expect, test } from "bun:test";
import {
  MODEL_FIRST_BYTE_DEADLINE_MS_V1,
  MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
  MODEL_IDLE_DEADLINE_MS_V1,
  MODEL_IDLE_DEADLINE_REASON_V1,
  ModelRequestDeadlineError,
  ModelProviderFailureError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import type { Agent } from "@frockbot/kernel-agent-loop/agent";
import { Context } from "cordis";
import {
  FROCK_AI_CONNECTION_GENERATION,
  FROCK_AI_CONNECTION_ID,
  FROCK_AI_DEFAULT_MODEL,
} from "./catalog.js";
import {
  classifyFrockAiFailureV1,
  createFrockAiRuntimePlugin,
  FrockAiTransportErrorV1,
} from "./runtime.js";

const request: NormalizedModelRequest = {
  requestId: "effect-1",
  provider: "flock-ai",
  model: FROCK_AI_DEFAULT_MODEL,
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
    connectionId: FROCK_AI_CONNECTION_ID,
    connectionGeneration: FROCK_AI_CONNECTION_GENERATION,
  },
};

function sse(text: string): ReadableStream<Uint8Array> {
  const body = new Response(text).body;
  if (!body) throw new Error("test response stream is unavailable");
  return body;
}

function runtimeConfig(
  runChatCompletion: Parameters<
    typeof createFrockAiRuntimePlugin
  >[0]["runChatCompletion"],
  deadlines?: Parameters<typeof createFrockAiRuntimePlugin>[0]["deadlines"],
) {
  return {
    connectionId: FROCK_AI_CONNECTION_ID,
    connectionGeneration: FROCK_AI_CONNECTION_GENERATION,
    autoRoute: "configured-auto",
    runChatCompletion,
    ...(deadlines ? { deadlines } : {}),
  };
}

/** A clock the test advances by hand, so a deadline costs no real seconds. */
function manualClock() {
  const pending = new Map<number, { run: () => void; due: number }>();
  let next = 1;
  let now = 0;
  return {
    schedule(run: () => void, milliseconds: number): () => void {
      const id = next++;
      pending.set(id, { run, due: now + milliseconds });
      return () => pending.delete(id);
    },
    advance(milliseconds: number): void {
      now += milliseconds;
      for (const [id, timer] of [...pending]) {
        if (timer.due <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
    get armed(): number {
      return pending.size;
    },
  };
}

/** Let the stream's own pump run: the clock is manual, the event loop is not. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** A gateway body the test feeds one chunk at a time. */
function pushableSse(): {
  body: ReadableStream<Uint8Array>;
  push: (text: string) => void;
} {
  let enqueue: ((text: string) => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = (text) => controller.enqueue(new TextEncoder().encode(text));
    },
  });
  return { body, push: (text) => enqueue?.(text) };
}

describe("Frock AI runtime Contribution", () => {
  test("maps AI Gateway and Workers AI error envelopes", () => {
    expect(
      classifyFrockAiFailureV1(new FrockAiTransportErrorV1("busy", 503, 2_000)),
    ).toMatchObject({
      classification: "transient",
      providerReason: "busy",
      retryAfterMs: 2_000,
    });
    expect(
      classifyFrockAiFailureV1({
        error: { message: "model not found", code: "invalid_model" },
      }),
    ).toMatchObject({
      classification: "permanent",
      providerReason: "model not found",
    });
    expect(
      classifyFrockAiFailureV1({ error: { message: "opaque", code: 7999 } }),
    ).toMatchObject({ classification: "unknown", providerReason: "opaque" });
  });

  test("falls from a permanently rejected manual model to Auto immediately", async () => {
    const calls: string[] = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
        runtimeConfig((gatewayModel) => {
          calls.push(gatewayModel);
          return gatewayModel.startsWith("workers-ai/")
            ? Promise.reject(new FrockAiTransportErrorV1("model missing", 404))
            : Promise.resolve(
                sse(
                  'data: {"choices":[{"delta":{"content":"auto"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ),
              );
        }),
      ),
    );
    const agent = {} as Agent;
    const manual = {
      ...request,
      model: "@frock/deepseek-ai/deepseek-v4-flash-0731",
    };
    let failure: unknown;
    try {
      for await (const event of root.llm.stream(
        manual,
        new AbortController().signal,
      )) {
        void event;
      }
    } catch (error) {
      failure = error;
    }

    const action = await root.waterfall(
      "agent/request-error",
      agent,
      failure,
      new AbortController().signal,
      () => Promise.resolve({ kind: "fail" as const }),
    );
    expect(action).toEqual({ kind: "fallback" });
    const fallback = await root.waterfall(
      "agent/request",
      agent,
      manual,
      new AbortController().signal,
      () => Promise.resolve(manual),
    );
    expect(fallback.model).toBe(FROCK_AI_DEFAULT_MODEL);
    for await (const event of root.llm.stream(
      fallback,
      new AbortController().signal,
    )) {
      void event;
    }
    expect(calls).toEqual([
      "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      "dynamic/configured-auto",
    ]);
    await root.fiber.dispose();
  });

  test("leaves a transient manual-model failure on the retry path", async () => {
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
        runtimeConfig(() =>
          Promise.reject(new FrockAiTransportErrorV1("busy", 503)),
        ),
      ),
    );
    const agent = {} as Agent;
    const manual = {
      ...request,
      model: "@frock/deepseek-ai/deepseek-v4-flash-0731",
    };
    let failure: unknown;
    try {
      for await (const event of root.llm.stream(
        manual,
        new AbortController().signal,
      )) {
        void event;
      }
    } catch (error) {
      failure = error;
    }
    const action = await root.waterfall(
      "agent/request-error",
      agent,
      failure,
      new AbortController().signal,
      () => Promise.resolve({ kind: "retry" as const }),
    );
    expect(action).toEqual({ kind: "retry" });
    const retried = await root.waterfall(
      "agent/request",
      agent,
      manual,
      new AbortController().signal,
      () => Promise.resolve(manual),
    );
    expect(retried.model).toBe(manual.model);
    await root.fiber.dispose();
  });
  test.each([
    [FROCK_AI_DEFAULT_MODEL, "dynamic/configured-auto"],
    [
      "@frock/deepseek-ai/deepseek-v4-flash-0731",
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
      createFrockAiRuntimePlugin(
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
      createFrockAiRuntimePlugin(
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
      createFrockAiRuntimePlugin(
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
    ).rejects.toBeInstanceOf(ModelProviderFailureError);
    expect(calls).toBe(0);
    await root.fiber.dispose();
  });

  test("reports a rejected gateway call as a definitive no-effect", async () => {
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
        runtimeConfig(() =>
          Promise.reject(
            new Error("AI Gateway rejected the request (429): slow down"),
          ),
        ),
      ),
    );

    let failure: unknown;
    try {
      for await (const event of root.llm.stream(
        request,
        new AbortController().signal,
      )) {
        void event;
      }
    } catch (error) {
      failure = error;
    }

    // Uncertain here would park the run on a reconciliation this Package
    // cannot perform, wedging the Bot on a transient gateway error.
    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect((failure as Error).message).toBe(
      "AI Gateway rejected the request (429): slow down",
    );
    await root.fiber.dispose();
  });

  test("cancels the gateway response stream when the Turn is aborted", async () => {
    let cancelled = false;
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
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

// A Stop must end one request and nothing else. The provider is registered
// once and serves every Turn, so anything request-scoped it kept on itself — an
// abort scope, a client, a stream — would let a cancelled Turn take the next
// one down with it.
describe("Frock AI request isolation", () => {
  test("leaves the next request working after one is cancelled", async () => {
    const bodies: Array<ReadableStream<Uint8Array>> = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
        runtimeConfig(() => {
          const body =
            bodies.length === 0
              ? pushableSse().body
              : sse(
                  'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\n' +
                    "data: [DONE]\n\n",
                );
          bodies.push(body);
          return Promise.resolve(body);
        }),
      ),
    );

    const cancelled = new AbortController();
    const abandoned = (async () => {
      for await (const event of root.llm.stream(request, cancelled.signal)) {
        void event;
      }
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();
    cancelled.abort(new Error("Turn cancelled"));
    expect((await abandoned) as Error).toBeInstanceOf(Error);

    const events: unknown[] = [];
    for await (const event of root.llm.stream(
      { ...request, requestId: "effect-2" },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "second" },
      { type: "finish", reason: "completed" },
    ]);
    await root.fiber.dispose();
  });
});

// The gateway binding takes no signal of its own, so before the shared
// deadline seam a gateway that accepted the request and then went quiet was
// bounded by nothing short of the fifteen-minute Turn deadline: an empty
// bubble, for a quarter of an hour, saying nothing about why.
describe("Frock AI deadlines", () => {
  test("fails the step when the gateway produces no first byte", async () => {
    const clock = manualClock();
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
        runtimeConfig(
          () => new Promise<ReadableStream<Uint8Array>>(() => undefined),
          { schedule: clock.schedule },
        ),
      ),
    );

    const consume = (async () => {
      for await (const event of root.llm.stream(
        request,
        new AbortController().signal,
      )) {
        void event;
      }
    })();
    await settle();
    clock.advance(MODEL_FIRST_BYTE_DEADLINE_MS_V1);

    const failure = await consume.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect((failure as ModelProviderFailureError).classification).toBe(
      "transient",
    );
    expect((failure as Error).message).toBe(
      MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
    );
    await root.fiber.dispose();
  });

  test("fails the step when the gateway starts an answer and then stalls", async () => {
    const clock = manualClock();
    const { body, push } = pushableSse();
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
        runtimeConfig(() => Promise.resolve(body), {
          schedule: clock.schedule,
        }),
      ),
    );

    const events: unknown[] = [];
    // The outcome is watched from the moment the stream starts: a failure this
    // test only looked at later would be an unobserved rejection first.
    const outcome = (async () => {
      for await (const event of root.llm.stream(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    push('data: {"choices":[{"delta":{"content":"Half a "}}]}\n\n');
    await settle();
    // The answer has started, so the clock now running is the idle one — well
    // short of the first-byte allowance this never reaches.
    clock.advance(MODEL_IDLE_DEADLINE_MS_V1);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(ModelRequestDeadlineError);
    expect((failure as ModelRequestDeadlineError).phase).toBe("idle");
    expect((failure as Error).message).toBe(MODEL_IDLE_DEADLINE_REASON_V1);
    expect(events).toEqual([{ type: "text-delta", text: "Half a " }]);
    await root.fiber.dispose();
  });

  test("lets a stream that keeps producing chunks finish, leaving no timer armed", async () => {
    const clock = manualClock();
    const { body, push } = pushableSse();
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin(
        runtimeConfig(() => Promise.resolve(body), {
          schedule: clock.schedule,
        }),
      ),
    );

    const events: unknown[] = [];
    const consume = (async () => {
      for await (const event of root.llm.stream(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    })();
    for (const chunk of ["one", "two", "three"]) {
      push(`data: {"choices":[{"delta":{"content":"${chunk}"}}]}\n\n`);
      await settle();
      // Each chunk lands inside the idle allowance, so the clock rearms rather
      // than firing.
      clock.advance(MODEL_IDLE_DEADLINE_MS_V1 - 1);
      await settle();
    }
    push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    await settle();
    await consume;

    expect(events).toEqual([
      { type: "text-delta", text: "one" },
      { type: "text-delta", text: "two" },
      { type: "text-delta", text: "three" },
      { type: "finish", reason: "completed" },
    ]);
    // A live timer in a Worker isolate holds the request open long after
    // anybody is listening for it.
    expect(clock.armed).toBe(0);
    await root.fiber.dispose();
  });
});

describe("Frock AI reconciliation", () => {
  test("reports an interrupted response as not retrievable so the run settles", async () => {
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createFrockAiRuntimePlugin({
        connectionId: FROCK_AI_CONNECTION_ID,
        connectionGeneration: FROCK_AI_CONNECTION_GENERATION,
        autoRoute: "dynamic/auto",
        runChatCompletion: () =>
          Promise.reject(new Error("must not be reached")),
      }),
    );

    const outcome = await root.llm.reconcile(
      request,
      new AbortController().signal,
    );

    expect(outcome).toEqual({
      status: "not-retrievable",
      reason:
        "Frock AI keeps no durable copy of an interrupted response, so it cannot be recovered",
    });
    await root.fiber.dispose();
  });
});

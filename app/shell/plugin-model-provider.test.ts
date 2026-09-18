/**
 * The host's adapter from a Plugin's model provider to the kernel's provider
 * seam (ADR 0032).
 *
 * The Plugin is faked at the one call the host makes into it — the NDJSON
 * event stream — and the dispatch is faked the way the Durable Object mints
 * one. What is under test is everything the host decides for itself: which
 * requests it will serve, what it holds back until an answer has a terminal,
 * what it believes about a failure, and what it cancels when the caller goes
 * away.
 */
import { describe, expect, test } from "bun:test";
import {
  encodePluginModelEventLineV1,
  ModelOutcomeUncertainErrorV1,
  ModelProviderFailureError,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type PluginModelInvocationV1,
  type PluginWorkerModelResultV1,
} from "@frockbot/core/contracts";
import {
  pluginModelProviderV1,
  type PluginModelProviderOptionsV1,
} from "./plugin-model-provider.ts";
import type {
  ModelDispatchHandleV1,
  ModelDispatchRefusalV1,
} from "@frockbot/app/isolates/model-dispatch";

const SCOPE = {
  botId: "bot-1",
  runId: "run-1",
  sessionId: "session-1",
  turnId: "run-1",
  generationId: "generation-1",
};

const BINDING = {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  connectionId: "connection-1",
  connectionGeneration: "generation-1",
};

function request(
  overrides: Partial<NormalizedModelRequest> = {},
): NormalizedModelRequest {
  return {
    requestId: "request-1",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    system: "You are a Bot.",
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "earlier",
        toolCalls: [],
        providerState: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          connectionId: "connection-1",
          connectionGeneration: "generation-1",
          content: '{"kept":true}',
        },
      },
    ],
    tools: [],
    modelBinding: {
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    },
    ...overrides,
  };
}

/** One attempt's dispatch, with the spend and refusal the host recorded. */
function dispatch(options: {
  spent?: boolean;
  refusal?: ModelDispatchRefusalV1;
  onFinish?: () => void;
}): ModelDispatchHandleV1 {
  return {
    transportId: "ticket-1",
    finish: options.onFinish ?? (() => {}),
    spent: () => options.spent === true,
    refusal: () => options.refusal,
  };
}

/** The worker's answer: the events, encoded as the NDJSON lines it sends. */
function worker(
  events: (LlmStreamEvent | Record<string, unknown>)[],
): (invocation: PluginModelInvocationV1) => Promise<PluginWorkerModelResultV1> {
  return async () => ({
    schemaVersion: 1,
    status: "streaming",
    events: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) {
          controller.enqueue(
            encoder.encode(encodePluginModelEventLineV1(event as never)),
          );
        }
        controller.close();
      },
    }),
  });
}

function provider(options: Partial<PluginModelProviderOptionsV1> = {}): {
  stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>;
  invocations: PluginModelInvocationV1[];
} {
  const invocations: PluginModelInvocationV1[] = [];
  const provider = pluginModelProviderV1({
    ...options,
    pluginId: "deepseek",
    binding: BINDING,
    streamModel: async (invocation) => {
      invocations.push(invocation);
      return options.streamModel
        ? options.streamModel(invocation)
        : { schemaVersion: 1, status: "refused", reason: "no fake" };
    },
    begin: options.begin ?? (() => dispatch({})),
    scope: SCOPE,
  });
  return {
    invocations,
    stream: (incoming: NormalizedModelRequest, signal: AbortSignal) =>
      provider.stream(incoming, signal),
  };
}

async function drain(
  stream: AsyncIterable<LlmStreamEvent>,
): Promise<{ events: LlmStreamEvent[]; error?: Error }> {
  const events: LlmStreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events };
  } catch (error) {
    return { events, error: error as Error };
  }
}

describe("what the adapter will serve", () => {
  test("refuses a request bound to another model or Connection, before the worker", async () => {
    const fake = provider();
    for (const wrong of [
      request({ provider: "openai" }),
      request({ model: "deepseek-v4-flash" }),
      request({
        modelBinding: {
          connectionId: "connection-2",
          connectionGeneration: "generation-1",
        },
      }),
      request({
        modelBinding: {
          connectionId: "connection-1",
          connectionGeneration: "generation-2",
        },
      }),
      request({ modelBinding: undefined }),
    ]) {
      const outcome = await drain(
        fake.stream(wrong, new AbortController().signal),
      );
      expect(outcome.error).toBeInstanceOf(ModelProviderFailureError);
      expect((outcome.error as ModelProviderFailureError).classification).toBe(
        "permanent",
      );
    }
    expect(fake.invocations).toHaveLength(0);
  });

  test("hands the Plugin the request without its Connection, and without another scope's replay state", async () => {
    const fake = provider({
      streamModel: worker([
        { type: "text-delta", text: "hi" },
        { type: "finish", reason: "completed" },
      ]),
    });
    await drain(
      fake.stream(
        request({
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: "earlier",
              toolCalls: [],
              providerState: {
                provider: "deepseek",
                model: "deepseek-v4-pro",
                connectionId: "connection-1",
                connectionGeneration: "generation-1",
                content: '{"kept":true}',
              },
            },
            {
              role: "assistant",
              content: "from another connection",
              toolCalls: [],
              providerState: {
                provider: "deepseek",
                model: "deepseek-v4-pro",
                connectionId: "connection-2",
                connectionGeneration: "generation-1",
                content: '{"stale":true}',
              },
            },
          ],
        }),
        new AbortController().signal,
      ),
    );
    const sent = fake.invocations[0]!;
    expect(sent.request.modelBinding).toBeUndefined();
    const assistant = sent.request.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistant[0]).toMatchObject({
      providerState: { content: '{"kept":true}' },
    });
    expect(assistant[1]!.providerState).toBeUndefined();
  });
});

describe("what the adapter believes of an answer", () => {
  test("streams an ordinary answer and its terminal", async () => {
    const fake = provider({
      streamModel: worker([
        { type: "text-delta", text: "Hel" },
        { type: "text-delta", text: "lo" },
        {
          type: "tool-call",
          call: { id: "call-1", name: "note_add", input: { text: "x" } },
        },
        { type: "finish", reason: "tool-calls" },
      ]),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      {
        type: "tool-call",
        call: { id: "call-1", name: "note_add", input: { text: "x" } },
      },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  test("holds tool calls until the terminal, and fails when one never comes", async () => {
    const fake = provider({
      streamModel: worker([
        { type: "text-delta", text: "about to call" },
        {
          type: "tool-call",
          call: { id: "call-1", name: "side_effect", input: {} },
        },
      ]),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelProviderFailureError);
    expect(outcome.events.some((event) => event.type === "tool-call")).toBe(
      false,
    );
  });

  test("refuses events after the terminal", async () => {
    const fake = provider({
      streamModel: worker([
        { type: "finish", reason: "completed" },
        { type: "text-delta", text: "late" },
      ]),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelProviderFailureError);
    expect((outcome.error as Error).message).toMatch(/after its terminal/);
  });

  test("refuses a line that is not an event", async () => {
    const fake = provider({
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("not json\n"));
            controller.close();
          },
        }),
      }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelProviderFailureError);
  });

  test("restates the identity on a replay state", async () => {
    // The Plugin states the provider's opaque content and nothing else: the
    // Connection, provider and model are the host's to add, and the kernel
    // checks them on the event it is handed.
    const fake = provider({
      streamModel: worker([
        { type: "provider-state", state: { content: "{}" } },
        { type: "finish", reason: "completed" },
      ]),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.events[0]).toEqual({
      type: "provider-state",
      state: {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        connectionId: "connection-1",
        connectionGeneration: "generation-1",
        content: "{}",
      },
    });
  });
});

describe("what the adapter believes of a failure", () => {
  const failureEvent = {
    type: "provider-failure",
    classification: "permanent",
    reason: "a refused key",
  };

  test("takes the Plugin's word when nothing was sent", async () => {
    const fake = provider({ streamModel: worker([failureEvent]) });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect((outcome.error as ModelProviderFailureError).classification).toBe(
      "permanent",
    );
  });

  test("takes the host's word when the host saw the provider refuse", async () => {
    const fake = provider({
      streamModel: worker([failureEvent]),
      begin: () =>
        dispatch({
          spent: true,
          refusal: { httpStatus: 429, classification: "transient" },
        }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    const error = outcome.error as ModelProviderFailureError;
    expect(error.classification).toBe("transient");
  });

  test("settles an outcome it cannot account for as uncertain, not as a no-effect failure", async () => {
    // The Plugin made the call, the host saw a 200, and then the Plugin
    // failed: whether the provider billed is not the Plugin's to decide, and
    // a `ModelProviderFailureError` would tell the kernel and Billing that
    // nothing had happened.
    const fake = provider({
      streamModel: worker([failureEvent]),
      begin: () => dispatch({ spent: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(outcome.error).not.toBeInstanceOf(ModelProviderFailureError);
  });
});

describe("the model protocol's allowances", () => {
  test("waits the first-byte allowance for the first event, then the idle one", async () => {
    // Both allowances are driven by the clock the host passes; nothing here
    // waits two real minutes.
    const fake = provider({
      deadlines: { firstByteMs: 40, idleMs: 20 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                encodePluginModelEventLineV1({ type: "text-delta", text: "a" }),
              ),
            );
            // 10ms apart: inside the idle allowance, so the answer streams.
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  encodePluginModelEventLineV1({
                    type: "finish",
                    reason: "completed",
                  }),
                ),
              );
              controller.close();
            }, 10);
          },
        }),
      }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events.at(-1)).toEqual({
      type: "finish",
      reason: "completed",
    });
  });

  test("stops a provider that never starts, with the deadline's own sentence", async () => {
    let finished = 0;
    const fake = provider({
      deadlines: { firstByteMs: 30, idleMs: 20 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: new ReadableStream<Uint8Array>({
          start() {
            // Nothing ever arrives.
          },
        }),
      }),
      begin: () => dispatch({ spent: true, onFinish: () => (finished += 1) }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect((outcome.error as Error).message).toMatch(/did not start replying/);
    expect(finished).toBeGreaterThan(0);
  });

  test("stops a provider that goes quiet part-way through", async () => {
    const fake = provider({
      deadlines: { firstByteMs: 30, idleMs: 20 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                encodePluginModelEventLineV1({ type: "text-delta", text: "a" }),
              ),
            );
          },
        }),
      }),
      begin: () => dispatch({ spent: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect((outcome.error as Error).message).toMatch(/went quiet/);
  });
});

describe("an attempt that hangs", () => {
  test("a worker RPC that never answers settles when the first-byte allowance passes", async () => {
    const fake = provider({
      deadlines: { firstByteMs: 40, idleMs: 30 },
      streamModel: () => new Promise(() => {}),
      begin: () => dispatch({ spent: true }),
    });
    const startedAt = Date.now();
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("a read that never delivers settles when the idle allowance passes", async () => {
    const fake = provider({
      deadlines: { firstByteMs: 40, idleMs: 30 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: new ReadableStream<Uint8Array>({
          start(controller) {
            // One event, then nothing at all — a provider whose socket is
            // open and silent.
            controller.enqueue(
              new TextEncoder().encode(
                encodePluginModelEventLineV1({ type: "text-delta", text: "a" }),
              ),
            );
          },
        }),
      }),
      begin: () => dispatch({ spent: true }),
    });
    const startedAt = Date.now();
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect((outcome.error as Error).message).toMatch(/went quiet/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("a heartbeat keeps a working provider alive past the idle allowance", async () => {
    const fake = provider({
      deadlines: { firstByteMs: 30, idleMs: 30 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            // Reasoning arrives for longer than the idle allowance with no
            // text and no terminal: real bytes, so the answer stands.
            let ticks = 0;
            const timer = setInterval(() => {
              ticks += 1;
              controller.enqueue(
                encoder.encode(
                  encodePluginModelEventLineV1({ type: "progress" }),
                ),
              );
              if (ticks < 4) return;
              clearInterval(timer);
              controller.enqueue(
                encoder.encode(
                  encodePluginModelEventLineV1({
                    type: "text-delta",
                    text: "answer",
                  }),
                ),
              );
              controller.enqueue(
                encoder.encode(
                  encodePluginModelEventLineV1({
                    type: "finish",
                    reason: "completed",
                  }),
                ),
              );
              controller.close();
            }, 20);
          },
        }),
      }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.events).toEqual([
      { type: "text-delta", text: "answer" },
      { type: "finish", reason: "completed" },
    ]);
  });
});

describe("ending an attempt", () => {
  test("finishes the dispatch however the stream ended", async () => {
    let finished = 0;
    const fake = provider({
      streamModel: worker([{ type: "finish", reason: "completed" }]),
      begin: () => dispatch({ onFinish: () => (finished += 1) }),
    });
    await drain(fake.stream(request(), new AbortController().signal));
    expect(finished).toBe(1);
  });

  test("a caller that goes away ends the attempt and stops reading", async () => {
    let finished = 0;
    let cancelled = false;
    const fake = provider({
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                encodePluginModelEventLineV1({ type: "text-delta", text: "a" }),
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
      begin: () => dispatch({ onFinish: () => (finished += 1) }),
    });
    const controller = new AbortController();
    const stream = fake.stream(request(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(new Error("stopped"));
    await iterator.return?.(undefined);
    expect(finished).toBeGreaterThan(0);
    expect(cancelled).toBe(true);
  });
});

describe("the bounds the host holds one answer to", () => {
  const line = (event: Record<string, unknown>): string =>
    encodePluginModelEventLineV1(event as never);

  function streamOf(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const text of lines) controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  test("refuses a stream of more events than the host will count", async () => {
    const fake = provider({
      bounds: { bytes: 1_000_000, events: 3, toolCalls: 8 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: streamOf(
          Array.from({ length: 4 }, () =>
            line({ type: "text-delta", text: "a" }),
          ),
        ),
      }),
      begin: () => dispatch({ spent: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect((outcome.error as Error).message).toMatch(
      /more model events than this deployment accepts/,
    );
  });

  test("refuses more bytes across an answer than the host will hold", async () => {
    const fake = provider({
      bounds: { bytes: 64, events: 100, toolCalls: 8 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: streamOf([line({ type: "text-delta", text: "x".repeat(200) })]),
      }),
      begin: () => dispatch({ spent: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect((outcome.error as Error).message).toMatch(
      /more model bytes than this deployment accepts/,
    );
  });

  test("refuses more tool calls held behind a terminal than the host will hold", async () => {
    const fake = provider({
      bounds: { bytes: 1_000_000, events: 100, toolCalls: 1 },
      streamModel: async () => ({
        schemaVersion: 1,
        status: "streaming",
        events: streamOf([
          line({
            type: "tool-call",
            call: { id: "call-1", name: "side_effect", input: {} },
          }),
          line({
            type: "tool-call",
            call: { id: "call-2", name: "side_effect", input: {} },
          }),
          line({ type: "finish", reason: "tool-calls" }),
        ]),
      }),
      begin: () => dispatch({ spent: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect((outcome.error as Error).message).toMatch(
      /held more tool calls than this deployment accepts/,
    );
  });

  test("a worker answer that arrives after the deadline is cancelled, not leaked", async () => {
    let cancelled = 0;
    const fake = provider({
      deadlines: { firstByteMs: 15, idleMs: 15 },
      streamModel: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                schemaVersion: 1 as const,
                status: "streaming" as const,
                events: new ReadableStream<Uint8Array>({
                  start() {
                    // Never produces anything: the Plugin is waiting on the
                    // upstream body it is holding open.
                  },
                  cancel() {
                    cancelled += 1;
                  },
                }),
              }),
            60,
          ),
        ),
      begin: () => dispatch({ spent: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(cancelled).toBe(1);
  });

  test("a worker answer that arrives after the caller stops is cancelled, not leaked", async () => {
    let cancelled = 0;
    const fake = provider({
      deadlines: { firstByteMs: 5_000, idleMs: 5_000 },
      streamModel: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                schemaVersion: 1 as const,
                status: "streaming" as const,
                events: new ReadableStream<Uint8Array>({
                  start() {},
                  cancel() {
                    cancelled += 1;
                  },
                }),
              }),
            30,
          ),
        ),
      begin: () => dispatch({ spent: true }),
    });
    const controller = new AbortController();
    const stream = fake.stream(request(), controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const reading = iterator.next();
    controller.abort(new Error("stopped"));
    await reading.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(cancelled).toBe(1);
  });
});

describe("a caller that stopped before the attempt began", () => {
  test("opens no worker stream and no dispatch", async () => {
    let opened = 0;
    let began = 0;
    const fake = provider({
      streamModel: async () => {
        opened += 1;
        return {
          schemaVersion: 1,
          status: "streaming",
          events: new ReadableStream<Uint8Array>({ start() {}, cancel() {} }),
        };
      },
      begin: () => {
        began += 1;
        return dispatch({});
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("stopped before the call"));
    const outcome = await drain(fake.stream(request(), controller.signal));
    expect((outcome.error as Error).message).toBe("stopped before the call");
    expect(opened).toBe(0);
    expect(began).toBe(0);
  });
});

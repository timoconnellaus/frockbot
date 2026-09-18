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
  MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
  MODEL_OUTCOME_UNCERTAIN_REASON_V1,
  ModelOutcomeUncertainErrorV1,
  ModelProviderFailureError,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type PluginModelInvocationV1,
  type PluginWorkerModelResultV1,
  type SessionEvent,
} from "@frockbot/core/contracts";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import type { AgentHandle } from "@frockbot/core/agent-loop/agent";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { priorOutcomeUnknownV1 } from "@frockbot/app/isolates/model-transport";
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
  sent?: boolean;
  priorOutcomeUnknown?: boolean;
  refusal?: ModelDispatchRefusalV1;
  onFinish?: () => void;
}): ModelDispatchHandleV1 {
  return {
    transportId: "ticket-1",
    finish: options.onFinish ?? (() => {}),
    sent: () => options.sent === true,
    priorOutcomeUnknown: () => options.priorOutcomeUnknown === true,
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
    // The host reads this from the Turn's journal; here a suite states it.
    priorOutcomeUnknownFor: options.priorOutcomeUnknownFor ?? (() => false),
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

  test("keeps an earlier call's possible cost when the request no longer matches", async () => {
    // The model changed while the run was interrupted, so the request the loop
    // re-dispatches names a binding this mount does not hold. The log shows the
    // effect was dispatched once already and never accounted for: its earlier
    // call may have reached the provider and billed, so refusing this request
    // is an uncertain outcome rather than a definitive no-effect result.
    const fake = provider({
      priorOutcomeUnknownFor: (requestId) => requestId === request().requestId,
    });
    const outcome = await drain(
      fake.stream(
        request({ model: "deepseek-v4-flash" }),
        new AbortController().signal,
      ),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(outcome.error).not.toBeInstanceOf(ModelProviderFailureError);
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
          sent: true,
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
      begin: () => dispatch({ sent: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(outcome.error).not.toBeInstanceOf(ModelProviderFailureError);
    // The sentence a person reads is the product's own, and the Plugin's
    // words about why its answer died stay after it as the diagnostic.
    const message = (outcome.error as Error).message;
    expect(message.startsWith(MODEL_OUTCOME_UNCERTAIN_REASON_V1)).toBe(true);
    expect(message).toContain("a refused key");
  });

  test("keeps a refusal the host made before the fetch, whatever the Plugin states", async () => {
    // A body the host would not send never reached the provider, so nothing
    // can have billed: the host's own decision is the answer, even when the
    // Plugin's own words about the failure say otherwise.
    const fake = provider({
      streamModel: worker([
        {
          type: "provider-failure",
          classification: "transient",
          reason: "a busy provider",
        },
      ]),
      begin: () =>
        dispatch({
          sent: false,
          refusal: { httpStatus: 0, classification: "permanent" },
        }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    const error = outcome.error as ModelProviderFailureError;
    expect(error).toBeInstanceOf(ModelProviderFailureError);
    expect(error.classification).toBe("permanent");
  });

  test("a replay of an unaccounted effect is uncertain even though nothing was sent", async () => {
    // The host refused to send this attempt because the log shows the effect
    // was dispatched once already and says nothing of how that ended. The
    // ticket was never spent, but the earlier call may have reached the
    // provider and billed, so the Plugin's own words cannot make this look
    // like a failure that cost nothing.
    const fake = provider({
      streamModel: worker([
        {
          type: "provider-failure",
          classification: "unknown",
          reason: "not sent twice",
        },
      ]),
      begin: () => dispatch({ sent: false, priorOutcomeUnknown: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(outcome.error).not.toBeInstanceOf(ModelProviderFailureError);
    // The person is told the call went out and the answer was lost; what the
    // host recorded of it stays in the same text, after the sentence.
    const message = (outcome.error as Error).message;
    expect(message.startsWith(MODEL_OUTCOME_UNCERTAIN_REASON_V1)).toBe(true);
    expect(message).toContain("not sent twice");
  });

  test("an accounted effect's replay stays the host's definitive refusal", async () => {
    // The other half of the same decision: when the effect's own usage is
    // already on the log, refusing to send again adds nothing and the refusal
    // is definitive, so no second estimate is ever written for one effect.
    const fake = provider({
      streamModel: worker([
        {
          type: "provider-failure",
          classification: "unknown",
          reason: "not sent twice",
        },
      ]),
      begin: () =>
        dispatch({
          sent: false,
          refusal: { httpStatus: 0, classification: "permanent" },
        }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    const error = outcome.error as ModelProviderFailureError;
    expect(error).toBeInstanceOf(ModelProviderFailureError);
    expect(error.classification).toBe("permanent");
  });

  test("a refusal this attempt never sent cannot erase an earlier call's cost", async () => {
    // The effect was dispatched once already with nothing recorded for it, and
    // this attempt was refused before it sent anything. The refusal is true of
    // this attempt and says nothing about the earlier call, which may have
    // reached the provider and billed: the effect's own history outranks it,
    // so the estimate stands for that earlier call.
    const fake = provider({
      streamModel: worker([
        {
          type: "provider-failure",
          classification: "permanent",
          reason: "nothing was sent this time",
        },
      ]),
      begin: () =>
        dispatch({
          sent: false,
          priorOutcomeUnknown: true,
          refusal: { httpStatus: 0, classification: "permanent" },
        }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(outcome.error).not.toBeInstanceOf(ModelProviderFailureError);
  });

  test("a deadline the host already has a refusal for is still a call that did not happen", async () => {
    // The refusal and the attempt's clock raced: the host read the provider's
    // refusal of a call it never sent, and the attempt ended waiting. What the
    // host saw is the answer, so this is not settled with an estimate.
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
      begin: () =>
        dispatch({
          sent: false,
          refusal: { httpStatus: 401, classification: "permanent" },
        }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    const error = outcome.error as ModelProviderFailureError;
    expect(error).toBeInstanceOf(ModelProviderFailureError);
    expect(error.classification).toBe("permanent");
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
      begin: () => dispatch({ sent: true, onFinish: () => (finished += 1) }),
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
      begin: () => dispatch({ sent: true }),
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
      begin: () => dispatch({ sent: true }),
    });
    const startedAt = Date.now();
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("a worker that hung before anything was dispatched is the timeout, not uncertainty", async () => {
    // The Plugin never reached the transport, so no call left the host and
    // nothing can have billed. The deadline's own sentence is what the person
    // reads, and the failure is definitive: an estimate here would record a
    // cost for a call nobody made.
    const fake = provider({
      deadlines: { firstByteMs: 40, idleMs: 30 },
      streamModel: () => new Promise(() => {}),
      begin: () => dispatch({ sent: false }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    const error = outcome.error as ModelProviderFailureError;
    expect(error).toBeInstanceOf(ModelProviderFailureError);
    expect(error).not.toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(error.classification).toBe("permanent");
    expect(error.message).toBe(MODEL_FIRST_BYTE_DEADLINE_REASON_V1);
  });

  test("a deadline for a replay of an unaccounted effect is still uncertainty", async () => {
    // Nothing was dispatched here either, but the effect's earlier call may
    // have billed, so the estimate belongs to it.
    const fake = provider({
      deadlines: { firstByteMs: 40, idleMs: 30 },
      streamModel: () => new Promise(() => {}),
      begin: () => dispatch({ sent: false, priorOutcomeUnknown: true }),
    });
    const outcome = await drain(
      fake.stream(request(), new AbortController().signal),
    );
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
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
      begin: () => dispatch({ sent: true }),
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
      begin: () => dispatch({ sent: true }),
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
      begin: () => dispatch({ sent: true }),
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
      begin: () => dispatch({ sent: true }),
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
      begin: () => dispatch({ sent: true }),
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
      begin: () => dispatch({ sent: true }),
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
  test("opens no worker stream and no dispatch, and is a call that did not happen", async () => {
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
    // The kernel settles a classified failure without an estimate, which is
    // what makes a Stop before anything opened a call that did not happen.
    const error = outcome.error as ModelProviderFailureError;
    expect(error).toBeInstanceOf(ModelProviderFailureError);
    expect(error).not.toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(error.classification).toBe("permanent");
    expect(error.message).toBe("stopped before the call");
    expect(opened).toBe(0);
    expect(began).toBe(0);
  });

  test("keeps an earlier call's possible cost when the log shows one was never accounted for", async () => {
    // A replay whose effect the log shows was dispatched once already and never
    // accounted for: the earlier call may have been accepted and billed, so the
    // one estimate that stands for it is what this outcome preserves.
    let opened = 0;
    let began = 0;
    const fake = provider({
      priorOutcomeUnknownFor: (requestId) => requestId === request().requestId,
      streamModel: async () => {
        opened += 1;
        return { schemaVersion: 1, status: "refused", reason: "no fake" };
      },
      begin: () => {
        began += 1;
        return dispatch({});
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("stopped before the call"));
    const outcome = await drain(fake.stream(request(), controller.signal));
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(outcome.error).not.toBeInstanceOf(ModelProviderFailureError);
    expect(opened).toBe(0);
    expect(began).toBe(0);
  });
});

/**
 * The accounting, read where it is decided: the kernel's own durable journal,
 * with the adapter mounted as the provider its loop reaches by name. A Stop
 * between the durable `model/request` admission and the provider's first byte
 * is the window this suite is about — nothing was dispatched, so nothing may
 * be billed for it, and only an effect whose earlier dispatch the log never
 * accounted for keeps the one estimate that stands for it.
 */
describe("the accounting a Stop before the provider start leaves behind", () => {
  const KERNEL_SESSION_ID = "user-1:bot-1";
  const REPLAY_REQUEST_ID = "request-replay";

  /**
   * An open Turn whose log already carries a `model/request` with no answer:
   * the step was interrupted mid-call, so a resume re-issues it under the same
   * id. `accounted` adds the `model/usage` a completed dispatch wrote, which is
   * the effect whose cost the log already carries.
   */
  function openTurnWithRequest(accounted: boolean): SessionEvent[] {
    const timestamp = "2026-09-18T00:00:00.000Z";
    return [
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "model/request",
        turn: 1,
        step: 1,
        request: {
          requestId: REPLAY_REQUEST_ID,
          provider: BINDING.provider,
          model: BINDING.model,
          system: "",
          messages: [],
          tools: [],
          modelBinding: {
            connectionId: BINDING.connectionId,
            connectionGeneration: BINDING.connectionGeneration,
          },
        },
      },
      ...(accounted
        ? [
            {
              type: "model/usage" as const,
              turn: 1,
              step: 1,
              requestId: REPLAY_REQUEST_ID,
              provider: BINDING.provider,
              model: BINDING.model,
              inputTokens: 12,
              outputTokens: 3,
              latencyMs: 50,
              estimated: true,
            },
          ]
        : []),
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
  }

  /**
   * Runs the real loop with the real adapter, and stops the Turn from
   * `admitEffect`: the `model/request` is durably admitted and flushed, and the
   * provider has not been reached — exactly where a person's Stop can land.
   * `priorOutcomeUnknownFor` reads the same journal production reads.
   */
  async function stoppedBeforeProviderStart(initial?: SessionEvent[]) {
    const root = createAgentRuntimeHarness(
      initial
        ? { sessions: { initialSessions: { [KERNEL_SESSION_ID]: initial } } }
        : {},
    );
    let opened = 0;
    let began = 0;
    root.llm.register(
      pluginModelProviderV1({
        pluginId: "deepseek",
        binding: BINDING,
        deadlines: { firstByteMs: 5_000, idleMs: 5_000 },
        streamModel: async () => {
          opened += 1;
          return { schemaVersion: 1, status: "refused", reason: "no fake" };
        },
        begin: () => {
          began += 1;
          return dispatch({});
        },
        priorOutcomeUnknownFor: (requestId) => {
          const session = root.sessions.get(KERNEL_SESSION_ID);
          return (
            session !== undefined && priorOutcomeUnknownV1(session, requestId)
          );
        },
        scope: {
          botId: "bot-1",
          runId: "run-1",
          sessionId: KERNEL_SESSION_ID,
          turnId: "run-1",
          generationId: "generation-1",
        },
      }),
    );
    const loop = createAgentLoop(root, {
      maxSteps: 4,
      composition: {
        generationId: "1970-01-01T00:00:00.000000Z:0123456789abcdef",
        artifactSetHash: "a".repeat(64),
      },
    });
    let handle: AgentHandle | undefined;
    handle = await loop.create({
      botId: "bot-1",
      sessionId: KERNEL_SESSION_ID,
      provider: BINDING.provider,
      model: BINDING.model,
      modelBinding: {
        connectionId: BINDING.connectionId,
        connectionGeneration: BINDING.connectionGeneration,
      },
      admitEffect: async (effect) => {
        if (effect.kind === "model") {
          handle!.agent.cancel("user", "Stopped by the user.");
        }
        return true;
      },
    });
    try {
      if (initial) handle.agent.resume();
      else handle.agent.send("hello");
      await handle.agent.whenIdle();
      return {
        events: [...handle.agent.session.events],
        opened,
        began,
      };
    } finally {
      await loop.dispose();
      await root.dispose();
    }
  }

  test("a first dispatch stopped before the provider start writes no usage", async () => {
    const run = await stoppedBeforeProviderStart();
    // The durable intent is on the log, and no ticket, worker call or estimate
    // followed it: nothing was dispatched, so nothing can have billed.
    expect(
      run.events.filter((event) => event.type === "model/request"),
    ).toHaveLength(1);
    expect(run.events.filter((event) => event.type === "model/usage")).toEqual(
      [],
    );
    expect(run.opened).toBe(0);
    expect(run.began).toBe(0);
    expect(run.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
      reason: "Stopped by the user.",
    });
  });

  test("a replay of an effect whose cost is already on the log writes no second usage", async () => {
    // The dispatch before this one was accounted: its `model/usage` is the one
    // estimate for the effect, and a Stop on the replay adds nothing to it.
    const run = await stoppedBeforeProviderStart(openTurnWithRequest(true));
    expect(
      run.events.filter((event) => event.type === "model/usage"),
    ).toHaveLength(1);
    expect(run.opened).toBe(0);
    expect(run.began).toBe(0);
    expect(run.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
      reason: "Stopped by the user.",
    });
  });

  test("a replay of an effect nothing accounted for keeps exactly one estimate", async () => {
    // The earlier dispatch may have billed and the log cannot say: the one
    // estimate written here stands for it, and no retry follows.
    const run = await stoppedBeforeProviderStart(openTurnWithRequest(false));
    const usage = run.events.filter((event) => event.type === "model/usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      requestId: REPLAY_REQUEST_ID,
      provider: BINDING.provider,
      model: BINDING.model,
      estimated: true,
    });
    expect(run.opened).toBe(0);
    expect(run.began).toBe(0);
    expect(
      run.events.filter((event) => event.type === "model/retry"),
    ).toHaveLength(0);
  });
});

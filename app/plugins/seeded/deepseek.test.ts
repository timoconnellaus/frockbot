/**
 * The DeepSeek provider Plugin, driven the way the host drives it (ADR 0032).
 *
 * The module under test is the built artifact — what a Plugin worker actually
 * loads — and the transport is synthetic: these tests are about what the
 * Plugin makes of the bytes an upstream sent, including the bytes that are
 * wrong. Nothing here reaches the network, and no credential exists to reach
 * it with.
 */
import { describe, expect, test } from "bun:test";
import { SEEDED_PLUGIN_ARTIFACTS_V1 } from "./artifacts.generated.ts";

const artifact = SEEDED_PLUGIN_ARTIFACTS_V1.find(
  (entry) => entry.pluginId === "deepseek",
)!;
// Written outside the checkout: it is a build output, not a source file.
const modulePath = `${process.env.TMPDIR ?? "/tmp"}/frockbot-deepseek-${artifact.contentHash.slice(0, 16)}.mjs`;
await Bun.write(modulePath, artifact.module);
const { modelProviders } = (await import(modulePath)) as {
  modelProviders: Record<
    string,
    {
      stream(
        request: unknown,
        ctx: unknown,
      ): AsyncIterable<Record<string, unknown>>;
    }
  >;
};

const REQUEST = {
  requestId: "request-1",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  system: "You are a Bot.",
  messages: [{ role: "user", content: "hello" }],
  tools: [
    {
      name: "note_add",
      description: "Add a note.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

/** One SSE data frame, as DeepSeek writes them. */
function frame(payload: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: payload, finish_reason: finish }],
  })}\n\n`;
}

interface Call {
  body?: string;
}

/** The context a Plugin is handed, with the host transport faked. */
function context(
  body: string | string[] | Uint8Array[],
  calls: Call[] = [],
  outcome?: Record<string, unknown>,
): unknown {
  const chunks =
    typeof body === "string"
      ? [new TextEncoder().encode(body)]
      : body.map((chunk) =>
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        );
  return {
    modelTransport: async (request: { body: string }) => {
      calls.push({ body: request.body });
      if (outcome) return outcome;
      return {
        status: "streaming",
        httpStatus: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
}

async function collect(
  body: string | string[] | Uint8Array[],
  options: { calls?: Call[]; outcome?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for await (const event of modelProviders.deepseek!.stream(
    REQUEST,
    context(body, options.calls ?? [], options.outcome),
  )) {
    events.push(event);
  }
  return events;
}

function failureOf(events: Record<string, unknown>[]): Record<string, unknown> {
  const failure = events.find((event) => event.type === "provider-failure");
  expect(failure).toBeDefined();
  return failure!;
}

function textOf(events: Record<string, unknown>[]): string {
  return events
    .filter((event) => event.type === "text-delta")
    .map((event) => String(event.text))
    .join("");
}

describe("the DeepSeek provider's wire request", () => {
  test("asks the host transport for the provider's inference body", async () => {
    const calls: Call[] = [];
    await collect(frame({ content: "hi" }, "stop") + "data: [DONE]\n\n", {
      calls,
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body.model).toBe(REQUEST.model);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "You are a Bot." },
      { role: "user", content: "hello" },
    ]);
    expect(body.tools).toHaveLength(1);
    expect(body.max_tokens).toBe(4_096);
    expect(body.stream).toBe(true);
  });
});

describe("a well-formed answer", () => {
  test("streams text and reaches one terminal", async () => {
    const events = await collect(
      frame({ content: "Hel" }) +
        frame({ content: "lo" }, "stop") +
        "data: [DONE]\n\n",
    );
    expect(textOf(events)).toBe("Hello");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "completed" });
    expect(events.filter((event) => event.type === "finish")).toHaveLength(1);
  });

  test("assembles a tool call across deltas and stops for tools", async () => {
    const events = await collect(
      frame({
        tool_calls: [
          { index: 0, id: "call-1", function: { name: "note_add" } },
        ],
      }) +
        frame({
          tool_calls: [{ index: 0, function: { arguments: '{"text":"buy ' } }],
        }) +
        frame(
          { tool_calls: [{ index: 0, function: { arguments: 'milk"}' } }] },
          "tool_calls",
        ) +
        "data: [DONE]\n\n",
    );
    expect(events.filter((event) => event.type === "tool-call")).toEqual([
      {
        type: "tool-call",
        call: { id: "call-1", name: "note_add", input: { text: "buy milk" } },
      },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  test("reads a usage frame that arrives after the stop reason", async () => {
    const events = await collect(
      frame({ content: "hi" }, "stop") +
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        })}\n\n` +
        "data: [DONE]\n\n",
    );
    expect(events).toContainEqual({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "completed" });
  });

  test("keeps reasoning content in the replay state and reads it back", async () => {
    const events = await collect(
      frame({ reasoning_content: "thinking" }) +
        frame({ content: "42" }, "stop") +
        "data: [DONE]\n\n",
    );
    const state = events.find((event) => event.type === "provider-state") as
      { state: { content: string } } | undefined;
    expect(state).toBeDefined();
    expect(JSON.parse(state!.state.content)).toEqual({
      role: "assistant",
      content: "42",
      reasoning_content: "thinking",
    });
  });
});

describe("frames that are not what they claim", () => {
  test("refuses a stream that ends before a terminal marker", async () => {
    const events = await collect(frame({ content: "partial" }));
    expect(failureOf(events)).toMatchObject({
      classification: "unknown",
      reason: "the provider's answer ended before a terminal marker",
    });
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });

  test("reads CRLF frames split across chunks", async () => {
    // The break arrives as "\r" and "\n\n", in three reads: the form that made
    // a parser searching for "\n\n" in the raw buffer lose the whole answer.
    const events = await collect([
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"},"finish_reason":null}]}\r',
      '\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ]);
    expect(textOf(events)).toBe("hello");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "completed" });
  });

  test("reads a multi-byte character split across chunks", async () => {
    const utf8 = new TextEncoder().encode(
      frame({ content: "héllo — 🙂" }, "stop") + "data: [DONE]\n\n",
    );
    const events = await collect([
      utf8.slice(0, 30),
      utf8.slice(30, 34),
      utf8.slice(34),
    ]);
    expect(textOf(events)).toBe("héllo — 🙂");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "completed" });
  });

  test("preserves a multi-line CRLF frame split at every byte", async () => {
    // Two `data:` lines make one frame, and a chunk boundary inside a CRLF
    // must not turn the second half of that frame into a frame of its own.
    const data =
      'data: {"choices":\r\ndata: [{"delta":{"content":"hi"},' +
      '"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    for (let split = 1; split < data.length; split += 1) {
      const events = await collect([data.slice(0, split), data.slice(split)]);
      expect(textOf(events), `split ${split}`).toBe("hi");
      expect(events.at(-1), `split ${split}`).toEqual({
        type: "finish",
        reason: "completed",
      });
    }
  });

  test("reasoning before any text is a heartbeat, not silence", async () => {
    const events = await collect(
      frame({ reasoning_content: "thinking" }) +
        frame({ reasoning_content: " still thinking" }) +
        frame({ content: "42" }, "stop") +
        "data: [DONE]\n\n",
    );
    // The thought itself is never shown, and never invented as text.
    expect(textOf(events)).toBe("42");
    expect(events.filter((event) => event.type === "progress")).toHaveLength(2);
    expect(
      JSON.parse(
        (
          events.find((event) => event.type === "provider-state") as {
            state: { content: string };
          }
        ).state.content,
      ),
    ).toMatchObject({ reasoning_content: "thinking still thinking" });
  });

  test("partial tool arguments are a heartbeat before the call lands", async () => {
    const events = await collect(
      frame({
        tool_calls: [
          { index: 0, id: "call-1", function: { name: "note_add" } },
        ],
      }) +
        frame({
          tool_calls: [{ index: 0, function: { arguments: '{"text":' } }],
        }) +
        frame(
          { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] },
          "tool_calls",
        ),
    );
    expect(
      events.filter((event) => event.type === "progress").length,
    ).toBeGreaterThanOrEqual(3);
    expect(events.filter((event) => event.type === "tool-call")).toEqual([
      {
        type: "tool-call",
        call: { id: "call-1", name: "note_add", input: { text: "hi" } },
      },
    ]);
  });

  test("refuses a frame it cannot read rather than dropping it", async () => {
    const events = await collect(
      frame({ content: "hi" }) + "data: {invalid}\n\n",
    );
    expect(failureOf(events)).toMatchObject({
      reason:
        "the provider sent a response frame this deployment could not read",
    });
  });

  test("a stop reason survives the end-of-stream marker that follows it", async () => {
    const events = await collect(
      frame({ content: "hi" }, "length") + "data: [DONE]\n\n",
    );
    expect(events.at(-1)).toEqual({ type: "finish", reason: "max-tokens" });
  });

  test("yields text as each chunk is read, not when the next one arrives", async () => {
    // The second chunk never comes: without yielding per chunk, the words
    // already received would wait on a socket that has gone quiet.
    let release: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({ content: "now" })));
        release = () => controller.close();
      },
    });
    const ctx = {
      modelTransport: async () => ({
        status: "streaming",
        httpStatus: 200,
        body,
      }),
    };
    const iterator = modelProviders
      .deepseek!.stream(REQUEST, ctx)
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "text-delta", text: "now" });
    release?.();
    await iterator.return?.(undefined);
  });

  test("refuses tool arguments that are not JSON", async () => {
    const events = await collect(
      frame({
        tool_calls: [
          { index: 0, id: "call-1", function: { name: "side_effect" } },
        ],
      }) +
        frame(
          {
            tool_calls: [{ index: 0, function: { arguments: "{bad" } }],
          },
          "tool_calls",
        ),
    );
    expect(failureOf(events)).toMatchObject({
      reason: "the model returned invalid tool arguments",
    });
    expect(events.some((event) => event.type === "tool-call")).toBe(false);
  });

  test("refuses a tool call with no id rather than inventing one", async () => {
    const events = await collect(
      frame({
        tool_calls: [{ index: 0, function: { name: "side_effect" } }],
      }) + frame({}, "tool_calls"),
    );
    expect(failureOf(events)).toMatchObject({
      reason: "the model returned a tool call without an id",
    });
  });

  test("refuses a tool call with no name", async () => {
    const events = await collect(
      frame({ tool_calls: [{ index: 0, id: "call-1", function: {} }] }) +
        frame({}, "tool_calls"),
    );
    expect(failureOf(events)).toMatchObject({
      reason: "the model returned a tool call without a name",
    });
  });

  test("refuses a stop reason this deployment does not support", async () => {
    const events = await collect(
      frame({ content: "hi" }, "content_filter") + "data: [DONE]\n\n",
    );
    expect(failureOf(events)).toMatchObject({
      classification: "permanent",
      reason:
        "the provider stopped for a reason this deployment does not support (content_filter)",
    });
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });

  test("refuses content that arrives after the terminal", async () => {
    const events = await collect(
      frame({ content: "hi" }, "stop") + frame({ content: "more" }),
    );
    expect(failureOf(events)).toMatchObject({
      reason: "the provider sent content after its terminal",
    });
  });

  test("refuses an answer with no choice at all", async () => {
    const events = await collect(`data: ${JSON.stringify({ id: "x" })}\n\n`);
    expect(failureOf(events)).toMatchObject({
      reason: "the provider's answer did not include a choice",
    });
  });

  test("refuses an answer larger than this deployment accepts", async () => {
    const events = await collect([
      frame({ content: "x".repeat(2_000_000) }),
      frame({ content: "y" }, "stop"),
    ]);
    expect(failureOf(events)).toMatchObject({
      classification: "permanent",
      reason:
        "the provider sent a response frame larger than this deployment accepts",
    });
  });
});

describe("the upstream call the host actually answers with", () => {
  test("reports the provider's refusal in the host's classification", async () => {
    const events = await collect([], {
      outcome: {
        status: "refused",
        httpStatus: 429,
        reason: "the provider rejected the model request (429)",
      },
    });
    expect(failureOf(events)).toMatchObject({
      classification: "transient",
      reason: "the provider rejected the model request (429)",
    });
  });

  test("reports a transport that never reached the provider as unknown", async () => {
    const events = await collect([], {
      outcome: {
        status: "unavailable",
        reason: "the provider could not be reached",
      },
    });
    expect(failureOf(events)).toMatchObject({ classification: "unknown" });
  });
});

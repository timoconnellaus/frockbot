import type {
  PluginModelContext,
  PluginModelProvider,
  PluginModelRequest,
  PluginModelStreamEvent,
  PluginModule,
  PluginTool,
  ToolResult,
} from "@frockbot/applet-sdk/plugin";

/**
 * DeepSeek, as a model provider Plugin (ADR 0032).
 *
 * The whole of the provider's protocol lives here: the normalized request is
 * turned into DeepSeek's own chat-completions wire, and DeepSeek's SSE frames
 * are turned back into normalized events. What is deliberately not here is
 * the credential, the destination and the decision to send at all: the Plugin
 * composes a body, and the host sends it to the one endpoint and route the
 * deployment's provider catalog names, with the Connection's credential
 * attached server-side.
 *
 * The answer is read strictly, because a half-read answer is worse than a
 * failed one. A frame this parser cannot read, a stream that ends before a
 * terminal marker, a tool call without an id or a name, arguments that are
 * not JSON, and a stop reason this deployment does not know are all failures
 * rather than a plausible-looking reply — an external-effect tool must never
 * be asked to act on an argument the model did not send. The one
 * provider-specific thing worth keeping is the replay state: DeepSeek refuses
 * an assistant message that carried reasoning unless the reasoning comes back
 * with it, so the upstream assistant message is stored whole and replayed
 * whole on the next step.
 */

export const tools: PluginTool[] = [];

export const execute = (): ToolResult =>
  "The DeepSeek plugin serves DeepSeek models; it has no tools.";

/** Bounds on one answer: a frame, and the whole body. */
const MAX_FRAME_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 33_554_432;
/**
 * What this provider asks for at most, in tokens. It is a request, not a
 * licence: the host holds the deployment's ceiling and refuses a body that
 * asks for more than it allows.
 */
const MAX_OUTPUT_TOKENS = 4_096;

interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface StreamChunk {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

type ProviderFailure = Extract<
  PluginModelStreamEvent,
  { type: "provider-failure" }
>;

/** A heartbeat: real bytes that are not the reply. */
type ProviderHeartbeat = Extract<PluginModelStreamEvent, { type: "progress" }>;

function failure(
  classification: ProviderFailure["classification"],
  reason: string,
): ProviderFailure {
  return { type: "provider-failure", classification, reason };
}

/** The messages DeepSeek should receive for one normalized request. */
function wireMessages(request: PluginModelRequest): WireMessage[] {
  const messages: WireMessage[] = [];
  if (request.system)
    messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "assistant") {
      const state = message.providerState as
        { provider?: string; model?: string; content?: string } | undefined;
      // A replay state this request's own provider and model wrote holds the
      // upstream assistant message exactly as DeepSeek sent it, reasoning
      // included. The host has already dropped any state that was written for
      // another provider, model or Connection; the model is checked again
      // here because the request is the Plugin's to read.
      if (
        state?.content &&
        state.provider === request.provider &&
        state.model === request.model
      ) {
        try {
          messages.push(JSON.parse(state.content) as WireMessage);
          continue;
        } catch {
          // A state this Plugin cannot read is one it did not write; fall
          // through to composing the message from what the kernel kept.
        }
      }
      const calls = (message.toolCalls ?? []) as {
        id: string;
        name: string;
        input: unknown;
      }[];
      messages.push({
        role: "assistant",
        content: String(message.content ?? "") || null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input ?? {}),
                },
              })),
            }
          : {}),
      });
      continue;
    }
    messages.push({
      role: "tool",
      tool_call_id: String(message.callId ?? ""),
      content: String(message.content ?? ""),
    });
  }
  return messages;
}

/** One request body, in DeepSeek's own dialect. */
function wireBody(request: PluginModelRequest): string {
  const tools = (request.tools ?? []).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  return JSON.stringify({
    model: request.model,
    messages: wireMessages(request),
    stream: true,
    // The size of the call is stated, never left to the provider's default:
    // the host checks it against the deployment's bound before anything is
    // sent, and a body without it is refused.
    max_tokens: MAX_OUTPUT_TOKENS,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
  });
}

/** One SSE frame's payload, or undefined for a frame that carries none. */
function framePayload(frame: string): string | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  return data.length > 0 ? data : undefined;
}

/** What one tool call was assembled from, across however many deltas. */
interface AssembledCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * The upstream answer, as normalized events.
 *
 * The reader is released on every path, including a failure and the
 * generator being closed early, so an abandoned answer stops the upstream
 * call rather than leaving it running.
 */
async function* deepseekStream(
  request: PluginModelRequest,
  ctx: PluginModelContext,
): AsyncIterable<PluginModelStreamEvent> {
  const response = await ctx.modelTransport({ body: wireBody(request) });
  if (response.status !== "streaming") {
    const status = response.status === "refused" ? response.httpStatus : 0;
    yield failure(
      status === 429 || status >= 500
        ? "transient"
        : status >= 400
          ? "permanent"
          : "unknown",
      response.reason,
    );
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let text = "";
  let reasoning = "";
  let sawChoice = false;
  let stopReason: string | undefined;
  let done = false;
  let refused: ProviderFailure | undefined;
  let usage: PluginModelStreamEvent | undefined;
  const calls = new Map<number, AssembledCall>();
  // Text deltas stream as they arrive — a reply is meant to be read while it
  // is written — and the terminal is what decides whether the call succeeded.
  const deltas: string[] = [];
  // Real bytes that are not the reply: each one is yielded as a heartbeat so
  // the host's silence allowance sees the answer arriving.
  const heartbeats: ProviderHeartbeat[] = [];

  /**
   * One frame, folded into the answer being assembled. A frame the parser
   * cannot read ends the answer: a dropped frame is a silently different
   * reply.
   */
  const readFrame = (frame: string): void => {
    if (frame.length > MAX_FRAME_BYTES) {
      refused = failure(
        "permanent",
        "the provider sent a response frame larger than this deployment accepts",
      );
      return;
    }
    const payload = framePayload(frame);
    if (payload === undefined) return;
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    let parsed: StreamChunk;
    try {
      parsed = JSON.parse(payload) as StreamChunk;
    } catch {
      refused = failure(
        "unknown",
        "the provider sent a response frame this deployment could not read",
      );
      return;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      refused = failure(
        "unknown",
        "the provider sent a response frame this deployment could not read",
      );
      return;
    }
    if (parsed.usage) {
      const cached = parsed.usage.prompt_cache_hit_tokens ?? 0;
      usage = {
        type: "usage",
        usage: {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          ...(cached > 0 ? { cachedInputTokens: cached } : {}),
          ...(parsed.usage.completion_tokens_details?.reasoning_tokens
            ? {
                reasoningTokens:
                  parsed.usage.completion_tokens_details.reasoning_tokens,
              }
            : {}),
        },
      };
    }
    const choice = Array.isArray(parsed.choices)
      ? parsed.choices[0]
      : undefined;
    if (!choice || typeof choice !== "object") return;
    sawChoice = true;
    const delta = choice.delta;
    if (delta && typeof delta === "object") {
      readDelta(delta);
    }
    // The stop reason is read after the frame's own delta: a provider may put
    // the last tool-call fragment and the reason in one chunk, and only what
    // arrives in a *later* frame is content after the terminal.
    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      stopReason = choice.finish_reason;
    }
  };

  /** One frame's delta, folded into the answer. */
  const readDelta = (delta: StreamDelta): void => {
    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content
    ) {
      reasoning += delta.reasoning_content;
      // Thought is not the reply and must not be shown as one, but it is the
      // provider talking: a reasoning model can think for minutes before its
      // first visible token, and the answer must not be cut off for it.
      heartbeats.push({ type: "progress" });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (stopReason !== undefined || done) {
        refused = failure(
          "unknown",
          "the provider sent content after its terminal",
        );
        return;
      }
      text += delta.content;
      deltas.push(delta.content);
    }
    if (
      Array.isArray(delta.tool_calls) &&
      delta.tool_calls.length > 0 &&
      (stopReason !== undefined || done)
    ) {
      refused = failure(
        "unknown",
        "the provider sent tool calls after its terminal",
      );
      return;
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      // Argument fragments arrive one piece at a time and none of them is a
      // tool call yet; the bytes are the provider working.
      heartbeats.push({ type: "progress" });
    }
    for (const part of delta.tool_calls ?? []) {
      const index = typeof part.index === "number" ? part.index : 0;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      calls.set(index, {
        id: typeof part.id === "string" && part.id ? part.id : current.id,
        name:
          typeof part.function?.name === "string"
            ? `${current.name}${part.function.name}`
            : current.name,
        arguments: `${current.arguments}${part.function?.arguments ?? ""}`,
      });
    }
  };

  // Text deltas are held until the answer has a terminal, so nothing is shown
  // for an answer that turns out to have been truncated or unreadable.
  try {
    reading: for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        refused = failure(
          "permanent",
          "the provider's answer was larger than this deployment accepts",
        );
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      // Frame breaks are newlines in either dialect. A CR that ends the buffer
      // is not a break yet — the LF that would make it one has not arrived —
      // so it is held back: normalising it here would turn one frame into two
      // whenever a chunk boundary falls inside a CRLF, and a multi-line data
      // field would be split apart.
      const heldCr = buffer.endsWith("\r");
      const text = (heldCr ? buffer.slice(0, -1) : buffer).replace(
        /\r\n/g,
        "\n",
      );
      let boundary = text.indexOf("\n\n");
      let consumed = 0;
      while (boundary >= 0) {
        const frame = text.slice(consumed, boundary);
        consumed = boundary + 2;
        readFrame(frame);
        if (refused !== undefined || done) break;
        boundary = text.indexOf("\n\n", consumed);
      }
      buffer = text.slice(consumed) + (heldCr ? "\r" : "");
      if (refused !== undefined || done) break reading;
      // Text this chunk carried is yielded before the next read, not after
      // it: a provider that stalls after saying something must not hold the
      // words back until its next frame arrives.
      while (heartbeats.length > 0) yield heartbeats.shift()!;
      while (deltas.length > 0)
        yield { type: "text-delta", text: deltas.shift()! };
      if (buffer.length > MAX_FRAME_BYTES) {
        refused = failure(
          "permanent",
          "the provider sent a response frame larger than this deployment accepts",
        );
        break;
      }
    }
    if (refused === undefined && !done) {
      // The tail is the last frame when the provider closed without a blank
      // line after it; anything left is a frame this parser never finished,
      // which the terminal check below refuses.
      buffer = `${buffer}${decoder.decode()}`
        .replace(/\r\n/g, "\n")
        .replace(/\r$/, "\n");
      const tail = buffer.trim();
      if (tail.length > 0) readFrame(tail);
      while (deltas.length > 0)
        yield { type: "text-delta", text: deltas.shift()! };
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // A stream already closed by its producer has nothing to cancel.
    }
  }
  // Anything the reader was still holding when the answer ended is yielded
  // before the outcome: text that arrived is text the person saw, even when
  // what follows it is a failure.
  while (heartbeats.length > 0) yield heartbeats.shift()!;
  for (const delta of deltas.splice(0))
    yield { type: "text-delta", text: delta };
  if (refused !== undefined) {
    yield refused;
    return;
  }
  if (!sawChoice) {
    yield failure("unknown", "the provider's answer did not include a choice");
    return;
  }
  if (stopReason === undefined && !done) {
    yield failure(
      "unknown",
      "the provider's answer ended before a terminal marker",
    );
    return;
  }
  const assembled = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  for (const call of assembled) {
    if (!call.name) {
      yield failure("unknown", "the model returned a tool call without a name");
      return;
    }
    if (!call.id) {
      yield failure("unknown", "the model returned a tool call without an id");
      return;
    }
  }
  const parsedInputs: unknown[] = [];
  for (const call of assembled) {
    if (call.arguments.length === 0) {
      parsedInputs.push({});
      continue;
    }
    try {
      parsedInputs.push(JSON.parse(call.arguments));
    } catch {
      yield failure("unknown", "the model returned invalid tool arguments");
      return;
    }
  }
  if (stopReason !== undefined && !KNOWN_STOP_REASONS.includes(stopReason)) {
    yield failure(
      "permanent",
      `the provider stopped for a reason this deployment does not support (${stopReason})`,
    );
    return;
  }
  const finishReason =
    assembled.length > 0
      ? "tool-calls"
      : stopReason === "tool_calls"
        ? undefined
        : stopReason === "length"
          ? "max-tokens"
          : "completed";
  if (finishReason === undefined) {
    // The provider said it stopped for tool calls and sent none: there is no
    // answer here to act on, and a Turn that carried on would be inventing one.
    yield failure(
      "unknown",
      "the provider stopped for tool calls but sent none",
    );
    return;
  }
  // The assistant message exactly as this provider would take it back: the
  // kernel stores this opaque and replays it on the next step of the Turn.
  yield {
    type: "provider-state",
    state: {
      content: JSON.stringify({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(assembled.length > 0
          ? {
              tool_calls: assembled.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      }),
    },
  };
  if (usage) yield usage;
  for (const [index, call] of assembled.entries()) {
    yield {
      type: "tool-call",
      call: { id: call.id, name: call.name, input: parsedInputs[index] },
    };
  }
  yield { type: "finish", reason: finishReason };
}

/** The stop reasons this deployment maps to a normalized finish. */
const KNOWN_STOP_REASONS = ["stop", "tool_calls", "length"];

export const modelProviders: PluginModule["modelProviders"] &
  Record<string, PluginModelProvider> = {
  deepseek: { stream: deepseekStream },
};

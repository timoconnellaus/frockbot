import {
  type LlmMessage,
  type LlmProvider,
  type LlmStreamEvent,
  MODEL_REQUEST_DEADLINES_V1,
  type ModelRequestDeadlinesV1,
  ModelRequestDeadlineError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class OpenAICompatibleHttpError extends Error {
  constructor(readonly status: number) {
    super(`Model request failed (${status})`);
    this.name = "OpenAICompatibleHttpError";
  }
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /**
   * Whether this endpoint's model accepts image content. Absent, and the
   * model id decides through {@link modelAcceptsImagesV1}.
   */
  acceptsImages?: boolean;
  /** Overrides {@link MODEL_REQUEST_DEADLINES_V1}. */
  deadlines?: Partial<ModelRequestDeadlinesV1>;
  /**
   * Timer seam, so a deadline test does not have to wait two minutes for one.
   * Defaults to `setTimeout`.
   */
  schedule?: ModelRequestScheduleV1;
}

/**
 * How a deadline arms its timer: run `run` after `milliseconds`, and return
 * the cancel. Injected so a test can drive the deadlines by hand.
 */
export type ModelRequestScheduleV1 = (
  run: () => void,
  milliseconds: number,
) => () => void;

/** The deadline seam every transport's stream is wrapped in. */
export interface ModelRequestDeadlineOptionsV1 {
  /** Overrides {@link MODEL_REQUEST_DEADLINES_V1}. */
  deadlines?: Partial<ModelRequestDeadlinesV1>;
  /** Timer seam. Defaults to `setTimeout`. */
  schedule?: ModelRequestScheduleV1;
}

/**
 * A request's clock, watching for silence.
 *
 * One controller, aborted with a {@link ModelRequestDeadlineError} when the
 * provider says nothing for too long, and rearmed on every stream event. It
 * chains the caller's signal so a Stop still cancels immediately, and it is
 * always disarmed in a `finally`: a live timer in a Worker isolate holds the
 * request open long after anyone is listening.
 */
class ModelRequestClockV1 {
  readonly #controller = new AbortController();
  readonly #deadlines: ModelRequestDeadlinesV1;
  readonly #schedule: (run: () => void, milliseconds: number) => () => void;
  #cancelTimer: (() => void) | undefined;
  #disarmed = false;

  constructor(
    caller: AbortSignal,
    deadlines: ModelRequestDeadlinesV1,
    schedule: (run: () => void, milliseconds: number) => () => void,
  ) {
    this.#deadlines = deadlines;
    this.#schedule = schedule;
    if (caller.aborted) this.#controller.abort(caller.reason);
    else {
      caller.addEventListener(
        "abort",
        () => this.#controller.abort(caller.reason),
        { once: true },
      );
    }
    this.#arm("first-byte");
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** A stream event arrived: the clock restarts on the idle allowance. */
  progressed(): void {
    this.#arm("idle");
  }

  disarm(): void {
    this.#disarmed = true;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  #arm(phase: "first-byte" | "idle"): void {
    if (this.#disarmed) return;
    this.#cancelTimer?.();
    const milliseconds =
      phase === "first-byte"
        ? this.#deadlines.firstByteMs
        : this.#deadlines.idleMs;
    this.#cancelTimer = this.#schedule(() => {
      this.#controller.abort(
        new ModelRequestDeadlineError(phase, milliseconds),
      );
    }, milliseconds);
  }
}

function defaultScheduleV1(run: () => void, milliseconds: number): () => void {
  const timer = setTimeout(run, milliseconds);
  return () => clearTimeout(timer);
}

interface ToolAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Model families this adapter will hand an image to.
 *
 * A guess, and named as one: there is no capability field on the wire and no
 * catalog this adapter can consult, so the default is a list of families whose
 * documented input includes images. `acceptsImages` overrides it in both
 * directions, which is what a deployment that knows better sets.
 */
const VISION_MODEL_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /o[34]\b/i,
  /claude-/i,
  /gemini-/i,
  /vision/i,
  /-vl\b/i,
  /llava/i,
  /pixtral/i,
  /internvl/i,
];

/** Whether this adapter will show `model` an image attachment. */
export function modelAcceptsImagesV1(model: string): boolean {
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function dataUrl(mediaType: string, dataBase64: string): string {
  return `data:${mediaType};base64,${dataBase64}`;
}

function messageToWire(
  message: LlmMessage,
  acceptsImages: boolean,
): Record<string, unknown>[] {
  if (message.role === "user")
    return [{ role: "user", content: message.content }];
  if (message.role === "tool") {
    const attachments = message.attachments ?? [];
    // An attachment this adapter cannot show is said in the text rather than
    // dropped in silence: a Bot that asked for a screenshot has to be able to
    // tell "the model saw it" from "the model was told where it is".
    const shown = acceptsImages
      ? attachments.filter((attachment) => attachment.dataBase64 !== undefined)
      : [];
    const withheld = attachments.filter(
      (attachment) => !shown.includes(attachment),
    );
    const notes = withheld.map(
      (attachment) =>
        `[attachment ${attachment.mediaType} not shown to this model; it is at ${attachment.workspacePath.path} (sha256 ${attachment.contentHash})]`,
    );
    const tool = {
      role: "tool",
      tool_call_id: message.callId,
      content: [message.content, ...notes].filter(Boolean).join("\n"),
    };
    if (shown.length === 0) return [tool];
    // The image travels as a following user message rather than inside the
    // tool result: an OpenAI-shaped `tool` message takes text, and a content
    // array there is refused by the very endpoints that accept the image.
    return [
      tool,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Attachments from ${message.name}:`,
          },
          ...shown.map((attachment) => ({
            type: "image_url",
            image_url: {
              url: dataUrl(attachment.mediaType, attachment.dataBase64!),
            },
          })),
        ],
      },
    ];
  }
  return [
    {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input),
              },
            })),
          }
        : {}),
    },
  ];
}

export function requestToWire(
  request: NormalizedModelRequest,
  options: { acceptsImages?: boolean } = {},
): Record<string, unknown> {
  const acceptsImages =
    options.acceptsImages ?? modelAcceptsImagesV1(request.model);
  const messages: Record<string, unknown>[] = [];
  if (request.system)
    messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    messages.push(...messageToWire(message, acceptsImages));
  }
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    messages,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

const MAX_SSE_EVENT_CHARACTERS = 1_048_576;
const MAX_SSE_RESPONSE_BYTES = 16_777_216;

async function rejectOversizedSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<never> {
  await reader.cancel().catch(() => undefined);
  throw new Error("Model response stream exceeded its size limit");
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseBytes = 0;
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      responseBytes += value?.byteLength ?? 0;
      if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
        await rejectOversizedSse(reader);
      }
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      if (
        buffer.length > MAX_SSE_EVENT_CHARACTERS ||
        blocks.some((block) => block.length > MAX_SSE_EVENT_CHARACTERS)
      ) {
        await rejectOversizedSse(reader);
      }
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function usageIntegerV1(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Model returned invalid ${label}`);
  }
  return value as number;
}

/**
 * Normalizes token accounting returned by OpenAI-shaped, Workers AI/Gateway,
 * and Ollama streams. Unknown payloads are ignored so the Agent loop can use
 * its durable byte-size estimate.
 */
export function usageFromPayloadV1(
  value: unknown,
): Extract<LlmStreamEvent, { type: "usage" }> | undefined {
  const payload = asRecord(value);
  if (!payload) return undefined;
  const usage = asRecord(payload.usage) ?? payload;
  const inputTokens = usageIntegerV1(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.prompt_eval_count ??
      payload.prompt_eval_count,
    "input token count",
  );
  const outputTokens = usageIntegerV1(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.eval_count ??
      payload.eval_count,
    "output token count",
  );
  if (inputTokens === undefined || outputTokens === undefined) return undefined;

  const inputDetails =
    asRecord(usage.prompt_tokens_details) ??
    asRecord(usage.input_tokens_details);
  const outputDetails =
    asRecord(usage.completion_tokens_details) ??
    asRecord(usage.output_tokens_details);
  const cachedInputTokens = usageIntegerV1(
    inputDetails?.cached_tokens ?? usage.cached_input_tokens,
    "cached input token count",
  );
  const reasoningTokens = usageIntegerV1(
    outputDetails?.reasoning_tokens ?? usage.reasoning_tokens,
    "reasoning token count",
  );
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) {
    throw new Error(
      "Model returned cached input tokens above total input tokens",
    );
  }
  if (reasoningTokens !== undefined && reasoningTokens > outputTokens) {
    throw new Error(
      "Model returned reasoning tokens above total output tokens",
    );
  }
  return {
    type: "usage",
    usage: {
      inputTokens,
      outputTokens,
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    },
  };
}

function applyToolDeltas(
  value: unknown,
  tools: Map<number, ToolAccumulator>,
): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) {
    const delta = asRecord(candidate);
    if (!delta || typeof delta.index !== "number") continue;
    const current = tools.get(delta.index) ?? {
      index: delta.index,
      id: "",
      name: "",
      arguments: "",
    };
    if (typeof delta.id === "string") current.id = delta.id;
    const fn = asRecord(delta.function);
    if (typeof fn?.name === "string") current.name += fn.name;
    if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
    tools.set(delta.index, current);
  }
}

function parseJson(value: string, label: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`${label}: ${String(error)}`);
  }
}

function parseToolInput(value: string): JsonValue {
  return value ? parseJson(value, "Model returned invalid tool arguments") : {};
}

/**
 * Normalize an OpenAI-compatible SSE body. Native provider bindings can reuse
 * this wire decoder without pretending their in-process call is HTTP.
 */
export async function* streamOpenAICompatibleBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<LlmStreamEvent> {
  const tools = new Map<number, ToolAccumulator>();
  let finishReason: string | undefined;
  let terminal = false;
  let sawChoice = false;
  for await (const data of readSseData(body, signal)) {
    if (data === "[DONE]") {
      terminal = true;
      break;
    }
    const payload = asRecord(
      parseJson(data, "Model returned an invalid stream event"),
    );
    const usage = usageFromPayloadV1(payload);
    if (usage) yield usage;
    const choices = payload?.choices;
    const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const delta = asRecord(choice?.delta);
    if (choice && (delta || typeof choice.finish_reason === "string")) {
      sawChoice = true;
    }
    if (typeof delta?.content === "string" && delta.content) {
      yield { type: "text-delta", text: delta.content };
    }
    applyToolDeltas(delta?.tool_calls, tools);
    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason;
      terminal = true;
    }
  }
  if (!terminal) {
    throw new Error("Model response stream ended before a terminal marker");
  }
  if (!sawChoice) {
    throw new Error("Model response stream did not include a valid choice");
  }

  for (const tool of [...tools.values()].sort(
    (left, right) => left.index - right.index,
  )) {
    if (!tool.name)
      throw new Error("Model returned a tool call without a name");
    yield {
      type: "tool-call",
      call: {
        id: tool.id || crypto.randomUUID(),
        name: tool.name,
        input: parseToolInput(tool.arguments),
      },
    };
  }
  yield {
    type: "finish",
    reason:
      tools.size > 0 || finishReason === "tool_calls"
        ? "tool-calls"
        : finishReason === "length"
          ? "max-tokens"
          : "completed",
  };
}

/**
 * Wait for `opening`, but give up when the deadline clock does.
 *
 * A transport that cannot be handed a signal — a native binding, say — keeps
 * running after we stop waiting for it, so whatever it eventually produces is
 * cancelled rather than left holding a socket nobody reads.
 */
async function openWithinDeadlineV1(
  opening: Promise<ReadableStream<Uint8Array>>,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  let abandon: (() => void) | undefined;
  try {
    return await new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      abandon = () => {
        reject(signal.reason as Error);
        void opening.then(
          async (body) => {
            // Only a body nobody is reading is ours to cancel; once the decoder
            // holds the lock, its own abort handling closes the stream.
            if (body.locked) return;
            try {
              await body.cancel(signal.reason);
            } catch {
              // A body already closed or errored needs no cancelling.
            }
          },
          () => undefined,
        );
      };
      signal.addEventListener("abort", abandon, { once: true });
      opening.then(resolve, reject);
    });
  } finally {
    // The listener goes with the wait it belonged to. Left attached, a later
    // abort — the idle deadline, a Stop — would reject a promise nobody is
    // waiting on any more, which every runtime reports as a crash.
    if (abandon) signal.removeEventListener("abort", abandon);
  }
}

/**
 * Run one model request under the first-byte and idle deadlines.
 *
 * The single seam every transport goes through, HTTP or native binding: it
 * owns the clock, so a Package supplying its own transport cannot forget the
 * deadlines, and there is one place to change what they are. `open` is handed
 * the deadline-aware signal and returns the response body to decode.
 */
export async function* streamWithModelRequestDeadlinesV1(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
  signal: AbortSignal,
  options: ModelRequestDeadlineOptionsV1 = {},
): AsyncIterable<LlmStreamEvent> {
  const clock = new ModelRequestClockV1(
    signal,
    { ...MODEL_REQUEST_DEADLINES_V1, ...options.deadlines },
    options.schedule ?? defaultScheduleV1,
  );
  try {
    const body = await openWithinDeadlineV1(open(clock.signal), clock.signal);
    for await (const event of streamOpenAICompatibleBody(body, clock.signal)) {
      clock.progressed();
      yield event;
    }
  } catch (error) {
    // The abort reason is the real failure; `AbortError` is only how it
    // reached us. Without this the Turn reports a cancellation nobody asked
    // for instead of the deadline it actually hit.
    if (
      clock.signal.reason instanceof ModelRequestDeadlineError &&
      !signal.aborted
    ) {
      throw clock.signal.reason;
    }
    throw error;
  } finally {
    clock.disarm();
  }
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id: string;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.baseUrl.trim())
      throw new Error("OpenAI-compatible baseUrl is required");
    this.id = config.providerId ?? "openai-compatible";
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
  }

  async *stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    // Workerd rejects a detached global `fetch` ("Illegal invocation"), so the
    // default fetcher forwards through a closure rather than aliasing it.
    const fetcher =
      this.config.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey)
      headers.authorization = `Bearer ${this.config.apiKey}`;
    // Nothing here used to have a time bound: a provider that accepted the
    // request and then went quiet held the Turn open for as long as the socket
    // stayed up — seventeen minutes, in the incident this exists for, with
    // nothing on the person's screen the whole time.
    yield* streamWithModelRequestDeadlinesV1(
      async (deadlineSignal) => {
        const response = await fetcher(
          `${this.config.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(
              requestToWire(request, {
                ...(this.config.acceptsImages === undefined
                  ? {}
                  : { acceptsImages: this.config.acceptsImages }),
              }),
            ),
            signal: deadlineSignal,
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new OpenAICompatibleHttpError(response.status);
        }
        if (!response.body)
          throw new Error("Model response did not include a stream");
        return response.body;
      },
      signal,
      {
        ...(this.config.deadlines ? { deadlines: this.config.deadlines } : {}),
        ...(this.config.schedule ? { schedule: this.config.schedule } : {}),
      },
    );
  }
}

export function createOpenAICompatiblePlugin(
  config: OpenAICompatibleConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.llm.register(new OpenAICompatibleProvider(config));
  plugin.inject = ["llm"];
  return plugin;
}

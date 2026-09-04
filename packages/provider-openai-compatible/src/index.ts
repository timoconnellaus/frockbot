import {
  boundedModelProviderReasonV1,
  type LlmMessage,
  type LlmProvider,
  type LlmStreamEvent,
  MODEL_REQUEST_DEADLINES_V1,
  type ModelRequestDeadlinesV1,
  ModelRequestDeadlineError,
  ModelProviderFailureError,
  type ModelProviderFailureClassV1,
  type NormalizedModelRequest,
  type ResponseFormatNoteV1,
  type StructuredOutputSupportV1,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class OpenAICompatibleHttpError extends ModelProviderFailureError {
  constructor(
    readonly status: number,
    reason = `Model request failed (${status})`,
    retryAfterMs?: number,
    errorCode?: string,
  ) {
    super({
      classification: classifyOpenAICompatibleFailureV1(status, errorCode),
      reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    this.name = "OpenAICompatibleHttpError";
  }
}

const CONTENT_POLICY_CODES = new Set([
  "content_filter",
  "content_policy_violation",
  "moderation_blocked",
  "safety_violation",
]);

export function classifyOpenAICompatibleFailureV1(
  status: number,
  errorCode?: string,
): ModelProviderFailureClassV1 {
  if (errorCode && CONTENT_POLICY_CODES.has(errorCode.toLowerCase())) {
    return "permanent";
  }
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if ([400, 401, 403, 404, 413].includes(status)) return "permanent";
  return "unknown";
}

export function retryAfterMillisecondsV1(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function openAIErrorDetailV1(text: string): {
  reason?: string;
  code?: string;
} {
  if (!text.trim()) return {};
  try {
    const payload = JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { reason: text };
    }
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === "string") return { reason: error };
    if (!error || typeof error !== "object" || Array.isArray(error)) return {};
    const record = error as Record<string, unknown>;
    return {
      ...(typeof record.message === "string" ? { reason: record.message } : {}),
      ...(typeof record.code === "string"
        ? { code: record.code }
        : typeof record.type === "string"
          ? { code: record.type }
          : {}),
    };
  } catch {
    return { reason: text };
  }
}

function networkFailureV1(error: unknown): ModelProviderFailureError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const transient =
    error instanceof TypeError ||
    ["NetworkError", "TimeoutError"].includes(name) ||
    /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|network|socket|gateway timeout)\b/i.test(
      message,
    );
  return new ModelProviderFailureError({
    classification: transient ? "transient" : "unknown",
    reason: message,
  });
}

async function httpFailureV1(response: Response): Promise<never> {
  const text = (await response.text().catch(() => "")).slice(0, 2_000);
  const detail = openAIErrorDetailV1(text);
  const reason = boundedModelProviderReasonV1(
    detail.reason
      ? `Model request failed (${response.status}): ${detail.reason}`
      : `Model request failed (${response.status})`,
  );
  throw new OpenAICompatibleHttpError(
    response.status,
    reason,
    retryAfterMillisecondsV1(response.headers.get("retry-after")),
    detail.code,
  );
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
  /** The strongest structured-output mode this endpoint accepts. */
  structuredOutput?: StructuredOutputSupportV1;
  /** Workers AI takes the schema directly; OpenAI/OpenRouter wrap it by name. */
  responseFormatDialect?: "openai" | "workers-ai";
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
  options: OpenAIRequestOptionsV1 = {},
): Record<string, unknown> {
  return planOpenAICompatibleRequestV1(request, options).body;
}

export interface OpenAIRequestOptionsV1 {
  acceptsImages?: boolean;
  structuredOutput?: StructuredOutputSupportV1;
  responseFormatDialect?: "openai" | "workers-ai";
}

export interface OpenAIRequestPlanV1 {
  body: Record<string, unknown>;
  note?: ResponseFormatNoteV1;
}

/** Maps the provider-neutral format and records any fidelity downgrade. */
export function planOpenAICompatibleRequestV1(
  request: NormalizedModelRequest,
  options: OpenAIRequestOptionsV1 = {},
): OpenAIRequestPlanV1 {
  const acceptsImages =
    options.acceptsImages ?? modelAcceptsImagesV1(request.model);
  const messages: Record<string, unknown>[] = [];
  if (request.system)
    messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    messages.push(...messageToWire(message, acceptsImages));
  }
  const support = options.structuredOutput ?? "none";
  const format = request.responseFormat;
  let responseFormat: Record<string, unknown> | undefined;
  let note: ResponseFormatNoteV1 | undefined;
  if (format?.type === "json_schema" && support === "json_schema") {
    responseFormat =
      options.responseFormatDialect === "workers-ai"
        ? { type: "json_schema", json_schema: format.schema }
        : {
            type: "json_schema",
            json_schema: {
              name: format.name,
              strict: true,
              schema: format.schema,
            },
          };
  } else if (format && support !== "none") {
    responseFormat = { type: "json_object" };
    if (format.type === "json_schema") {
      note = {
        code: "structured-output-downgraded",
        requested: "json_schema",
        effective: "json",
        message: `Provider ${request.provider} supports JSON mode but not JSON Schema; the shared validator remains authoritative`,
      };
    }
  } else if (format) {
    note = {
      code: "structured-output-downgraded",
      requested: format.type,
      effective: "prompt",
      message: `Provider ${request.provider} has no native structured-output mode; the request uses prompt guidance and shared validation`,
    };
  }
  if (format) {
    const instruction =
      format.type === "json_schema"
        ? `Return only JSON matching this schema exactly: ${JSON.stringify(format.schema)}`
        : "Return only one valid JSON value, with no Markdown or commentary.";
    if (request.system) {
      messages[0] = {
        role: "system",
        content: `${request.system}\n\n${instruction}`,
      };
    } else {
      messages.unshift({ role: "system", content: instruction });
    }
  }
  return {
    body: {
      model: request.model,
      // Workers AI documents JSON mode as non-streaming. The decoder accepts
      // both response shapes while the contract remains an event stream.
      stream: !(
        format &&
        support !== "none" &&
        options.responseFormatDialect === "workers-ai"
      ),
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
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
    },
    ...(note ? { note } : {}),
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
  const [probeBody, replayBody] = body.tee();
  const probeReader = probeBody.getReader();
  const probeDecoder = new TextDecoder();
  let prefix = "";
  const cancelProbe = (): void => {
    void probeReader.cancel(signal.reason).catch(() => undefined);
    if (!replayBody.locked) {
      void replayBody.cancel(signal.reason).catch(() => undefined);
    }
  };
  signal.addEventListener("abort", cancelProbe, { once: true });
  try {
    signal.throwIfAborted();
    while (!prefix.trimStart() && prefix.length < 4_096) {
      const { done, value } = await probeReader.read();
      signal.throwIfAborted();
      if (done) break;
      prefix += probeDecoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancelProbe);
    void probeReader.cancel().catch(() => undefined);
    probeReader.releaseLock();
  }
  if (prefix.trimStart().startsWith("{")) {
    yield* readOpenAICompatibleJsonV1(replayBody, signal);
    return;
  }
  const tools = new Map<number, ToolAccumulator>();
  let finishReason: string | undefined;
  let terminal = false;
  let sawChoice = false;
  for await (const data of readSseData(replayBody, signal)) {
    if (data === "[DONE]") {
      terminal = true;
      break;
    }
    const payload = asRecord(
      parseJson(data, "Model returned an invalid stream event"),
    );
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

async function* readOpenAICompatibleJsonV1(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<LlmStreamEvent> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SSE_RESPONSE_BYTES) await rejectOversizedSse(reader);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload = asRecord(
    parseJson(
      new TextDecoder().decode(combined),
      "Model returned an invalid response",
    ),
  );
  const choices = payload?.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const message = asRecord(choice?.message);
  if (!choice || !message) {
    throw new Error("Model response did not include a valid choice");
  }
  if (typeof message.content === "string" && message.content) {
    yield { type: "text-delta", text: message.content };
  }
  const tools = new Map<number, ToolAccumulator>();
  if (Array.isArray(message.tool_calls)) {
    applyToolDeltas(
      message.tool_calls.map((candidate, index) => ({
        ...(asRecord(candidate) ?? {}),
        index,
      })),
      tools,
    );
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
      tools.size > 0 || choice.finish_reason === "tool_calls"
        ? "tool-calls"
        : choice.finish_reason === "length"
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
  readonly supports;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.baseUrl.trim())
      throw new Error("OpenAI-compatible baseUrl is required");
    this.id = config.providerId ?? "openai-compatible";
    this.supports = {
      structuredOutput: config.structuredOutput ?? "none",
    } as const;
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
  }

  async *stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const plan = planOpenAICompatibleRequestV1(request, {
      ...(this.config.acceptsImages === undefined
        ? {}
        : { acceptsImages: this.config.acceptsImages }),
      structuredOutput: this.supports.structuredOutput,
      ...(this.config.responseFormatDialect
        ? { responseFormatDialect: this.config.responseFormatDialect }
        : {}),
    });
    if (plan.note) yield { type: "response-format-note", note: plan.note };
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
    try {
      yield* streamWithModelRequestDeadlinesV1(
        async (deadlineSignal) => {
          const response = await fetcher(
            `${this.config.baseUrl}/chat/completions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(plan.body),
              signal: deadlineSignal,
            },
          );
          if (!response.ok) await httpFailureV1(response);
          if (!response.body)
            throw new Error("Model response did not include a stream");
          return response.body;
        },
        signal,
        {
          ...(this.config.deadlines
            ? { deadlines: this.config.deadlines }
            : {}),
          ...(this.config.schedule ? { schedule: this.config.schedule } : {}),
        },
      );
    } catch (error) {
      if (signal.aborted || error instanceof ModelProviderFailureError) {
        throw error;
      }
      if (error instanceof ModelRequestDeadlineError) {
        if (error.phase === "idle") throw error;
        throw new ModelProviderFailureError({
          classification: "transient",
          reason: error.message,
        });
      }
      throw networkFailureV1(error);
    }
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

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
import { APICallError, type LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";
import type { FetchFunction } from "@ai-sdk/provider-utils";
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

export interface StructuredOutputPlanV1 {
  /** The step down this provider had to take, if it took one. */
  note?: ResponseFormatNoteV1;
  /** Prompt guidance that goes into the system message, whatever the wire. */
  instruction?: string;
}

/**
 * What a provider can and cannot honour about a requested response format.
 *
 * The degradation chain is a promise the Agent loop makes to a Bot, not an
 * OpenAI detail: every provider owes the same note when it steps down, so the
 * decision lives here rather than in each adapter's wire mapping.
 */
export function structuredOutputPlanV1(
  request: NormalizedModelRequest,
  support: StructuredOutputSupportV1,
): StructuredOutputPlanV1 {
  const format = request.responseFormat;
  if (!format) return {};
  const instruction =
    format.type === "json_schema"
      ? `Return only JSON matching this schema exactly: ${JSON.stringify(format.schema)}`
      : "Return only one valid JSON value, with no Markdown or commentary.";
  if (format.type === "json_schema" && support === "json_schema") {
    return { instruction };
  }
  if (support !== "none") {
    return format.type === "json_schema"
      ? {
          instruction,
          note: {
            code: "structured-output-downgraded",
            requested: "json_schema",
            effective: "json",
            message: `Provider ${request.provider} supports JSON mode but not JSON Schema; the shared validator remains authoritative`,
          },
        }
      : { instruction };
  }
  return {
    instruction,
    note: {
      code: "structured-output-downgraded",
      requested: format.type,
      effective: "prompt",
      message: `Provider ${request.provider} has no native structured-output mode; the request uses prompt guidance and shared validation`,
    },
  };
}

/** Prepends `instruction` to a system prompt, or makes one of it. */
export function systemWithInstructionV1(
  system: string | undefined,
  instruction: string | undefined,
): string | undefined {
  if (!instruction) return system || undefined;
  return system ? `${system}\n\n${instruction}` : instruction;
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
  const { note, instruction } = structuredOutputPlanV1(request, support);
  let responseFormat: Record<string, unknown> | undefined;
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
  }
  if (instruction) {
    const system = systemWithInstructionV1(request.system, instruction);
    if (request.system) messages[0] = { role: "system", content: system };
    else messages.unshift({ role: "system", content: system });
  }
  const stream = !(
    format &&
    support !== "none" &&
    options.responseFormatDialect === "workers-ai"
  );
  return {
    body: {
      model: request.model,
      // Workers AI documents JSON mode as non-streaming. The decoder accepts
      // both response shapes while the contract remains an event stream.
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
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

const OVERSIZED_RESPONSE_REASON =
  "Model response stream exceeded its size limit";

/** The data payload of one SSE block, joined the way the wire defines it. */
function sseEventDataV1(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

/**
 * What the raw byte stream says that the decoded parts cannot.
 *
 * `[DONE]` never reaches the decoder as an event, but a stream that ended
 * without either it or a finish reason is a truncated Turn rather than a
 * finished one, and the difference decides whether the run may be retried.
 */
interface SseStreamObservationsV1 {
  sawDone: boolean;
  /**
   * A cap the bounded stream tripped. The decoder reports a broken source as
   * an opaque processing failure, and this is what it was.
   */
  failure?: unknown;
}

/**
 * Bound the provider's stream, and give an index-only tool call an id.
 *
 * The size caps have to be applied to the bytes, before anything buffers a
 * response nobody asked for. The id is repaired here for the same reason it is
 * seen here: several OpenAI-compatible endpoints number their tool-call deltas
 * and never name them, and the decoder rejects the first such delta outright.
 */
function boundedSseStreamV1(
  signal: AbortSignal,
  observations: SseStreamObservationsV1,
): TransformStream<Uint8Array, Uint8Array> {
  const fail = (
    controller: TransformStreamDefaultController<Uint8Array>,
    reason: unknown,
  ): void => {
    observations.failure = reason;
    controller.error(reason);
  };
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const identified = new Set<number>();
  let buffer = "";
  let responseBytes = 0;
  let abort: (() => void) | undefined;

  let done = false;

  // `[DONE]` ends the response, and the socket behind it may stay open for a
  // long time yet: closing here is what lets a finished Turn finish rather
  // than wait out the idle deadline on a provider with nothing left to say.
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    block: string,
    framed: boolean,
  ): void => {
    const data = sseEventDataV1(block);
    const repaired = data.includes("tool_calls")
      ? repairToolCallIdsV1(block, data, identified)
      : block;
    controller.enqueue(encoder.encode(framed ? `${repaired}\n\n` : repaired));
    if (data !== "[DONE]") return;
    observations.sawDone = true;
    done = true;
    if (abort) signal.removeEventListener("abort", abort);
    controller.terminate();
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      if (signal.aborted) {
        fail(controller, signal.reason);
        return;
      }
      abort = () => fail(controller, signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    },
    transform(chunk, controller) {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
        fail(controller, new Error(OVERSIZED_RESPONSE_REASON));
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      if (
        buffer.length > MAX_SSE_EVENT_CHARACTERS ||
        blocks.some((block) => block.length > MAX_SSE_EVENT_CHARACTERS)
      ) {
        fail(controller, new Error(OVERSIZED_RESPONSE_REASON));
        return;
      }
      for (const block of blocks) {
        if (done) break;
        emit(controller, block, true);
      }
    },
    flush(controller) {
      if (abort) signal.removeEventListener("abort", abort);
      if (buffer && !done) emit(controller, buffer, false);
    },
  });
}

/** The cumulative cap alone, for a body that is not an event stream. */
function boundedBodyStreamV1(
  signal: AbortSignal,
  observations: SseStreamObservationsV1,
): TransformStream<Uint8Array, Uint8Array> {
  let responseBytes = 0;
  let abort: (() => void) | undefined;
  const fail = (
    controller: TransformStreamDefaultController<Uint8Array>,
    reason: unknown,
  ): void => {
    observations.failure = reason;
    controller.error(reason);
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      if (signal.aborted) {
        fail(controller, signal.reason);
        return;
      }
      abort = () => fail(controller, signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    },
    transform(chunk, controller) {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_SSE_RESPONSE_BYTES) {
        fail(controller, new Error(OVERSIZED_RESPONSE_REASON));
        return;
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (abort) signal.removeEventListener("abort", abort);
    },
  });
}

function repairToolCallIdsV1(
  block: string,
  data: string,
  identified: Set<number>,
): string {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return block;
  }
  const choices = asRecord(payload)?.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const deltas = asRecord(first?.delta)?.tool_calls;
  if (!Array.isArray(deltas)) return block;
  let repaired = false;
  for (const candidate of deltas) {
    const delta = asRecord(candidate);
    if (!delta || typeof delta.index !== "number") continue;
    if (typeof delta.id === "string" && delta.id) {
      identified.add(delta.index);
      continue;
    }
    if (identified.has(delta.index)) continue;
    delta.id = crypto.randomUUID();
    identified.add(delta.index);
    repaired = true;
  }
  return repaired ? `data: ${JSON.stringify(payload)}` : block;
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
 * The AI SDK model this adapter decodes through.
 *
 * The request is built by {@link planOpenAICompatibleRequestV1} and opened by
 * the caller — a native binding has no URL to fetch — so the model is handed
 * the already-open body through a loopback `fetch` and nothing leaves the
 * isolate. What it is here for is the reading: event framing, tool-call delta
 * accumulation and finish reasons.
 */
function decodingModelV1(
  body: ReadableStream<Uint8Array>,
  contentType: string,
): OpenAICompatibleChatLanguageModel {
  return new OpenAICompatibleChatLanguageModel("frockbot", {
    provider: "openai-compatible",
    url: () => "https://model.invalid/chat/completions",
    headers: () => ({}),
    fetch: loopbackFetchV1(body, contentType),
  });
}

/** `FetchFunction` is `typeof fetch`, whose non-request members go unused. */
function loopbackFetchV1(
  body: ReadableStream<Uint8Array>,
  contentType: string,
): FetchFunction {
  const open = (): Promise<Response> =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType },
      }),
    );
  return open as unknown as FetchFunction;
}

function accumulateToolNamesV1(
  value: unknown,
  ids: Map<number, string>,
  names: Map<string, string>,
): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) {
    const delta = asRecord(candidate);
    if (!delta || typeof delta.index !== "number") continue;
    if (typeof delta.id === "string" && delta.id)
      ids.set(delta.index, delta.id);
    const id = ids.get(delta.index);
    const fn = asRecord(delta.function);
    if (id && typeof fn?.name === "string") {
      names.set(id, `${names.get(id) ?? ""}${fn.name}`);
    }
  }
}

/**
 * A failure the caller's stream raised reaches us wrapped as a provider call
 * error. Unwrapping it keeps the size cap — and a cancelled Turn — reported as
 * itself rather than as an opaque decoding failure.
 */
async function openDecodedStreamV1(
  model: OpenAICompatibleChatLanguageModel,
  observations: SseStreamObservationsV1,
): Promise<ReadableStream<LanguageModelV4StreamPart>> {
  try {
    const { stream } = await model.doStream({
      prompt: [],
      includeRawChunks: true,
    });
    return stream;
  } catch (error) {
    throw unwrapDecodeFailureV1(error, observations);
  }
}

function unwrapDecodeFailureV1(
  error: unknown,
  observations: SseStreamObservationsV1,
): unknown {
  if (observations.failure !== undefined) return observations.failure;
  return error instanceof APICallError && error.cause instanceof Error
    ? error.cause
    : error;
}

function finishReasonV1(
  toolCalls: number,
  raw: string | undefined,
): Extract<LlmStreamEvent, { type: "finish" }>["reason"] {
  if (toolCalls > 0 || raw === "tool_calls") return "tool-calls";
  return raw === "length" ? "max-tokens" : "completed";
}

function toolCallEventV1(
  id: string,
  name: string,
  input: string,
): Extract<LlmStreamEvent, { type: "tool-call" }> {
  if (!name) throw new Error("Model returned a tool call without a name");
  return {
    type: "tool-call",
    call: {
      id: id || crypto.randomUUID(),
      name,
      input: parseToolInput(input),
    },
  };
}

/**
 * Normalize an OpenAI-compatible response body, streamed or whole. Reached
 * only through {@link streamWithModelRequestDeadlinesV1}, so no transport can
 * decode a response without also being on the clock.
 */
async function* streamOpenAICompatibleBody(
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

  const observations: SseStreamObservationsV1 = { sawDone: false };
  const stream = await openDecodedStreamV1(
    decodingModelV1(
      replayBody.pipeThrough(boundedSseStreamV1(signal, observations)),
      "text/event-stream",
    ),
    observations,
  );

  const toolCalls: { id: string; name: string; input: string }[] = [];
  // A tool name may arrive in fragments across deltas, which the decoder's
  // own accumulator does not join; the raw chunks are where the pieces are.
  const toolIds = new Map<number, string>();
  const toolNames = new Map<string, string>();
  let sawChoice = false;
  let sawFinishReason = false;
  let rawFinishReason: string | undefined;
  let failure: unknown;
  try {
    for await (const part of stream) {
      if (part.type === "raw") {
        const payload = asRecord(part.rawValue);
        const usage = usageFromPayloadV1(payload);
        if (usage) yield usage;
        const choices = payload?.choices;
        const choice = Array.isArray(choices)
          ? asRecord(choices[0])
          : undefined;
        const delta = asRecord(choice?.delta);
        if (choice && (delta || typeof choice.finish_reason === "string")) {
          sawChoice = true;
        }
        if (typeof choice?.finish_reason === "string") sawFinishReason = true;
        accumulateToolNamesV1(delta?.tool_calls, toolIds, toolNames);
      } else if (part.type === "text-delta") {
        if (part.delta) yield { type: "text-delta", text: part.delta };
      } else if (part.type === "tool-call") {
        toolCalls.push({
          id: part.toolCallId,
          name: toolNames.get(part.toolCallId) ?? part.toolName,
          input: typeof part.input === "string" ? part.input : "",
        });
      } else if (part.type === "finish") {
        rawFinishReason = part.finishReason.raw ?? undefined;
      } else if (part.type === "error") {
        failure = part.error;
        break;
      }
    }
  } catch (error) {
    throw unwrapDecodeFailureV1(error, observations);
  }

  if (!observations.sawDone && !sawFinishReason) {
    throw new Error("Model response stream ended before a terminal marker");
  }
  if (!sawChoice) {
    throw new Error("Model response stream did not include a valid choice");
  }
  if (failure !== undefined) {
    const error = unwrapDecodeFailureV1(failure, observations);
    throw error instanceof Error ? error : new Error(String(error));
  }

  for (const call of toolCalls) {
    yield toolCallEventV1(call.id, call.name, call.input);
  }
  yield {
    type: "finish",
    reason: finishReasonV1(toolCalls.length, rawFinishReason),
  };
}

async function* readOpenAICompatibleJsonV1(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<LlmStreamEvent> {
  const observations: SseStreamObservationsV1 = { sawDone: false };
  let result;
  try {
    result = await decodingModelV1(
      body.pipeThrough(boundedBodyStreamV1(signal, observations)),
      "application/json",
    ).doGenerate({ prompt: [] });
  } catch (error) {
    const failure = unwrapDecodeFailureV1(error, observations);
    if (failure instanceof APICallError) {
      throw new Error("Model response did not include a valid choice");
    }
    throw failure;
  }
  const usage = usageFromPayloadV1(result.response?.body);
  if (usage) yield usage;
  let toolCalls = 0;
  const emitted: LlmStreamEvent[] = [];
  for (const content of result.content) {
    if (content.type === "text") {
      if (content.text) yield { type: "text-delta", text: content.text };
    } else if (content.type === "tool-call") {
      toolCalls += 1;
      emitted.push(
        toolCallEventV1(
          content.toolCallId,
          content.toolName,
          typeof content.input === "string" ? content.input : "",
        ),
      );
    }
  }
  for (const event of emitted) yield event;
  yield {
    type: "finish",
    reason: finishReasonV1(toolCalls, result.finishReason.raw ?? undefined),
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
export function streamWithModelRequestDeadlinesV1(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>,
  signal: AbortSignal,
  options: ModelRequestDeadlineOptionsV1 = {},
): AsyncIterable<LlmStreamEvent> {
  return streamEventsWithModelRequestDeadlinesV1(
    async (deadlineSignal) =>
      streamOpenAICompatibleBody(
        await openWithinDeadlineV1(open(deadlineSignal), deadlineSignal),
        deadlineSignal,
      ),
    signal,
    options,
  );
}

/**
 * The same clock, for a provider that decodes its own wire.
 *
 * An adapter whose SDK owns the whole request has no byte stream to hand
 * over, only the events it produced; the deadlines are the Turn's, not the
 * dialect's, so they still apply.
 */
export async function* streamEventsWithModelRequestDeadlinesV1(
  open: (signal: AbortSignal) => Promise<AsyncIterable<LlmStreamEvent>>,
  signal: AbortSignal,
  options: ModelRequestDeadlineOptionsV1 = {},
): AsyncIterable<LlmStreamEvent> {
  const clock = new ModelRequestClockV1(
    signal,
    { ...MODEL_REQUEST_DEADLINES_V1, ...options.deadlines },
    options.schedule ?? defaultScheduleV1,
  );
  try {
    for await (const event of await open(clock.signal)) {
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

import type {
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/agent-core";
import type { Plugin } from "cordis";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

interface ToolAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

function messageToWire(message: LlmMessage): Record<string, unknown> {
  if (message.role === "user")
    return { role: "user", content: message.content };
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.callId,
      content: message.content,
    };
  }
  return {
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
  };
}

export function requestToWire(
  request: NormalizedModelRequest,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (request.system)
    messages.push({ role: "system", content: request.system });
  messages.push(...request.messages.map(messageToWire));
  return {
    model: request.model,
    stream: true,
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

async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
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
    const fetcher = this.config.fetch ?? fetch;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.config.headers,
    };
    if (this.config.apiKey)
      headers.authorization = `Bearer ${this.config.apiKey}`;
    const response = await fetcher(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestToWire(request)),
      signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2_000);
      throw new Error(`Model request failed (${response.status}): ${body}`);
    }
    if (!response.body)
      throw new Error("Model response did not include a stream");

    const tools = new Map<number, ToolAccumulator>();
    let finishReason: string | undefined;
    for await (const data of readSseData(response.body)) {
      signal.throwIfAborted();
      if (data === "[DONE]") break;
      const payload = asRecord(
        parseJson(data, "Model returned an invalid stream event"),
      );
      const choices = payload?.choices;
      const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
      const delta = asRecord(choice?.delta);
      if (typeof delta?.content === "string" && delta.content) {
        yield { type: "text-delta", text: delta.content };
      }
      applyToolDeltas(delta?.tool_calls, tools);
      if (typeof choice?.finish_reason === "string")
        finishReason = choice.finish_reason;
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
}

export function createOpenAICompatiblePlugin(
  config: OpenAICompatibleConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.llm.register(new OpenAICompatibleProvider(config));
  plugin.inject = ["llm"];
  return plugin;
}

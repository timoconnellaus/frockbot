import type {
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/core/contracts";
import { ModelProviderFailureError } from "@frockbot/core/contracts";
import { classifyOpenAICompatibleFailureV1 } from "../openai-compatible/index.js";

/** Bedrock's bearer-token Converse API works over fetch in a Worker, without the Node-only SDK loader. */
export async function* bedrockStreamV1(
  request: NormalizedModelRequest,
  options: {
    apiKey: string;
    baseUrl: string;
    maxTokens: number;
    signal: AbortSignal;
    fetch?: typeof fetch;
  },
): AsyncIterable<LlmStreamEvent> {
  const rawMessages = request.messages.map((message) => {
    if (message.role === "user")
      return { role: "user", content: [{ text: message.content }] };
    if (message.role === "tool")
      return {
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: message.callId,
              status: message.isError ? "error" : "success",
              content: [
                { text: message.content },
                ...(message.attachments ?? []).map((attachment) => {
                  const format = attachment.mediaType.replace("image/", "");
                  return attachment.dataBase64 &&
                    ["png", "jpeg", "gif", "webp"].includes(format)
                    ? {
                        image: {
                          format,
                          source: { bytes: attachment.dataBase64 },
                        },
                      }
                    : {
                        text: `[attachment ${attachment.mediaType} at ${attachment.workspacePath.path}]`,
                      };
                }),
              ],
            },
          },
        ],
      };
    const state = message.providerState;
    return {
      role: "assistant",
      content:
        state?.provider === request.provider &&
        state.model === request.model &&
        state.connectionId === request.modelBinding?.connectionId &&
        state.connectionGeneration ===
          request.modelBinding?.connectionGeneration
          ? JSON.parse(state.content)
          : [
              ...(message.content ? [{ text: message.content }] : []),
              ...message.toolCalls.map((call) => ({
                toolUse: {
                  toolUseId: call.id,
                  name: call.name,
                  input: call.input,
                },
              })),
            ],
    };
  });
  const messages: Array<{ role: string; content: unknown[] }> = [];
  for (const message of rawMessages) {
    const previous = messages.at(-1);
    if (previous?.role === message.role)
      previous.content.push(...message.content);
    else messages.push(message);
  }
  const response = await (options.fetch ?? fetch)(
    `${options.baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(request.model)}/converse`,
    {
      method: "POST",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
        "Idempotency-Key": request.requestId,
      },
      body: JSON.stringify({
        messages,
        ...(request.system ? { system: [{ text: request.system }] } : {}),
        inferenceConfig: { maxTokens: options.maxTokens },
        ...(request.tools.length
          ? {
              toolConfig: {
                tools: request.tools.map((tool) => ({
                  toolSpec: {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: { json: tool.inputSchema },
                  },
                })),
              },
            }
          : {}),
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status < 500)
      throw new ModelProviderFailureError({
        classification: classifyOpenAICompatibleFailureV1(response.status),
        reason: `Bedrock rejected the model request (${response.status})`,
      });
    throw new Error(`Bedrock request failed (${response.status})`);
  }
  const body = (await response.json()) as {
    output?: {
      message?: {
        content?: Array<{
          text?: string;
          toolUse?: { toolUseId: string; name: string; input: unknown };
        }>;
      };
    };
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    };
    stopReason?: string;
  };
  const content = body.output?.message?.content;
  if (
    !Array.isArray(content) ||
    !["end_turn", "tool_use", "max_tokens", "stop_sequence"].includes(
      body.stopReason ?? "",
    )
  )
    throw new Error(
      `Bedrock returned an invalid or unsuccessful response (${body.stopReason ?? "missing outcome"})`,
    );
  yield {
    type: "provider-state",
    state: {
      provider: request.provider,
      model: request.model,
      content: JSON.stringify(content),
      ...(request.modelBinding ?? {}),
    },
  };
  if (body.usage)
    yield {
      type: "usage",
      usage: {
        inputTokens:
          body.usage.inputTokens +
          (body.usage.cacheReadInputTokens ?? 0) +
          (body.usage.cacheWriteInputTokens ?? 0),
        outputTokens: body.usage.outputTokens,
        ...(body.usage.cacheReadInputTokens
          ? { cachedInputTokens: body.usage.cacheReadInputTokens }
          : {}),
      },
    };
  for (const block of content) {
    if (block.text) yield { type: "text-delta", text: block.text };
    if (block.toolUse)
      yield {
        type: "tool-call",
        call: {
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: block.toolUse.input,
        },
      };
  }
  yield {
    type: "finish",
    reason:
      body.stopReason === "tool_use"
        ? "tool-calls"
        : body.stopReason === "max_tokens"
          ? "max-tokens"
          : "completed",
  };
}

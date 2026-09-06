import { createAnthropic } from "@ai-sdk/anthropic";
import {
  APICallError,
  type LanguageModelV4Message,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { CredentialLeaseV1 } from "@frockbot/connection-core";
import {
  boundedModelProviderReasonV1,
  type LlmMessage,
  type LlmProvider,
  type LlmReconciliationCapability,
  type LlmStreamEvent,
  ModelProviderFailureError,
  ModelRequestDeadlineError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  classifyOpenAICompatibleFailureV1,
  type ModelRequestDeadlineOptionsV1,
  retryAfterMillisecondsV1,
  streamEventsWithModelRequestDeadlinesV1,
  structuredOutputPlanV1,
  systemWithInstructionV1,
} from "@frockbot/provider-openai-compatible";
import type { Agent } from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";

declare module "cordis" {
  interface Context {
    credentialLease: CredentialLeaseOpener;
  }

  interface Events {
    "agent/model-outcome-committed": (
      agent: Agent,
      requestId: string,
      outcome: "completed" | "not-started",
    ) => Promise<void>;
  }
}

export const ANTHROPIC_PROVIDER = "anthropic";

export const DEFAULT_ANTHROPIC_API_BASE_URL = "https://api.anthropic.com/v1";

/** The outbound seam this Package is handed; the SDK's is `typeof fetch`. */
export type AnthropicFetchV1 = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface CredentialLeaseOpener {
  open(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string>;
}

export interface AnthropicRuntimeConfig {
  accountId: string;
  connectionId: string;
  packageId: "provider-anthropic";
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  /** Messages API root, when the Connection points somewhere else. */
  apiBaseUrl?: string;
  fetch?: AnthropicFetchV1;
  now?: () => number;
  deadlines?: ModelRequestDeadlineOptionsV1;
}

/**
 * Anthropic has no `response_format`, so a schema is prompt guidance and the
 * shared validator stays authoritative — the same step down every provider
 * without a native mode takes, and it owes the same note.
 */
const STRUCTURED_OUTPUT_SUPPORT = "none";

function toolResultMessagesV1(
  message: Extract<LlmMessage, { role: "tool" }>,
): LanguageModelV4Message[] {
  const result: LanguageModelV4Message = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.callId,
        toolName: message.name,
        output: { type: "text", value: message.content },
      },
    ],
  };
  const shown = (message.attachments ?? []).filter(
    (attachment) => attachment.dataBase64 !== undefined,
  );
  const withheld = (message.attachments ?? []).filter(
    (attachment) => attachment.dataBase64 === undefined,
  );
  const notes = withheld.map(
    (attachment) =>
      `[attachment ${attachment.mediaType} not shown to this model; it is at ${attachment.workspacePath.path} (sha256 ${attachment.contentHash})]`,
  );
  if (shown.length === 0 && notes.length === 0) return [result];
  return [
    result,
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [`Attachments from ${message.name}:`, ...notes].join("\n"),
        },
        ...shown.map(
          (attachment) =>
            ({
              type: "file",
              mediaType: attachment.mediaType,
              data: { type: "data", data: attachment.dataBase64! },
            }) as const,
        ),
      ],
    },
  ];
}

/** Maps FrockBot's normalized conversation onto the AI SDK's prompt shape. */
export function anthropicPromptV1(
  request: NormalizedModelRequest,
  instruction?: string,
): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  const system = systemWithInstructionV1(request.system, instruction);
  if (system) prompt.push({ role: "system", content: system });
  for (const message of request.messages) {
    if (message.role === "user") {
      prompt.push({
        role: "user",
        content: [{ type: "text", text: message.content }],
      });
      continue;
    }
    if (message.role === "tool") {
      prompt.push(...toolResultMessagesV1(message));
      continue;
    }
    prompt.push({
      role: "assistant",
      content: [
        ...(message.content
          ? [{ type: "text" as const, text: message.content }]
          : []),
        ...message.toolCalls.map(
          (call) =>
            ({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.name,
              input: JSON.stringify(call.input),
            }) as const,
        ),
      ],
    });
  }
  return prompt;
}

function parsedToolInputV1(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return (value ?? {}) as Record<string, unknown>;
  }
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Model returned invalid tool arguments: ${String(error)}`);
  }
}

/** Anthropic's HTTP semantics are OpenAI's, so the same table decides. */
export function classifyAnthropicFailureV1(
  error: unknown,
): ModelProviderFailureError {
  if (error instanceof ModelProviderFailureError) return error;
  if (!APICallError.isInstance(error)) {
    const message = error instanceof Error ? error.message : String(error);
    const transient =
      error instanceof TypeError ||
      /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|network|socket|gateway timeout)\b/i.test(
        message,
      );
    return new ModelProviderFailureError({
      classification: transient ? "transient" : "unknown",
      reason: boundedModelProviderReasonV1(message),
    });
  }
  const status = error.statusCode;
  const code = (error.data as { error?: { type?: unknown } } | undefined)?.error
    ?.type;
  const retryAfterMs = retryAfterMillisecondsV1(
    error.responseHeaders?.["retry-after"] ?? null,
  );
  return new ModelProviderFailureError({
    classification:
      status === undefined
        ? "unknown"
        : classifyOpenAICompatibleFailureV1(
            status,
            typeof code === "string" ? code : undefined,
          ),
    reason: boundedModelProviderReasonV1(
      status === undefined
        ? error.message
        : `Model request failed (${status}): ${error.message}`,
    ),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * Tool calls are held until the stream terminates. The Agent loop commits a
 * step's calls together, and a call announced before the model finished
 * changing its mind is a call it never made.
 */
async function* decodeAnthropicStreamV1(
  parts: ReadableStream<LanguageModelV4StreamPart>,
): AsyncIterable<LlmStreamEvent> {
  const toolCalls: LlmStreamEvent[] = [];
  let rawFinish: string | undefined;
  for await (const part of parts) {
    if (part.type === "text-delta") {
      if (part.delta) yield { type: "text-delta", text: part.delta };
    } else if (part.type === "tool-call") {
      toolCalls.push({
        type: "tool-call",
        call: {
          id: part.toolCallId || crypto.randomUUID(),
          name: part.toolName,
          input: parsedToolInputV1(part.input),
        },
      });
    } else if (part.type === "error") {
      throw part.error instanceof Error
        ? part.error
        : new Error(String(part.error));
    } else if (part.type === "finish") {
      rawFinish = part.finishReason.unified;
      const usage = usageEventV1(part.usage);
      if (usage) yield usage;
    }
  }
  yield* toolCalls;
  yield {
    type: "finish",
    reason:
      toolCalls.length > 0 || rawFinish === "tool-calls"
        ? "tool-calls"
        : rawFinish === "length"
          ? "max-tokens"
          : "completed",
  };
}

function usageEventV1(
  usage: LanguageModelV4Usage,
): Extract<LlmStreamEvent, { type: "usage" }> | undefined {
  const inputTokens = countV1(usage.inputTokens?.total);
  const outputTokens = countV1(usage.outputTokens?.total);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  // The decoder fills an absent breakdown with zero, which is not the same
  // claim as a provider reporting one, so only a positive count is reported.
  const cachedInputTokens = positiveCountV1(usage.inputTokens?.cacheRead);
  const reasoningTokens = positiveCountV1(usage.outputTokens?.reasoning);
  if (reasoningTokens !== undefined && reasoningTokens > outputTokens) {
    throw new Error(
      "Model returned reasoning tokens above total output tokens",
    );
  }
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) {
    throw new Error(
      "Model returned cached input tokens above total input tokens",
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

function countV1(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveCountV1(value: unknown): number | undefined {
  const count = countV1(value);
  return count && count > 0 ? count : undefined;
}

interface AuthorizedRequest {
  lease: CredentialLeaseV1;
  apiKey: string;
}

class AnthropicProvider implements LlmProvider {
  readonly id = ANTHROPIC_PROVIDER;
  readonly supports = { structuredOutput: STRUCTURED_OUTPUT_SUPPORT } as const;
  private readonly authorized = new Map<string, AuthorizedRequest>();

  constructor(
    private readonly config: AnthropicRuntimeConfig,
    private readonly credentialLease: CredentialLeaseOpener,
  ) {}

  /**
   * Anthropic keeps no addressable copy of an interrupted response, so saying
   * so settles the run as a failure with its partial text rather than parking
   * it on a retrieval that never arrives.
   */
  readonly reconciliation: LlmReconciliationCapability = {
    retrieve: async () => ({
      status: "not-retrievable",
      reason:
        "Anthropic keeps no durable copy of an interrupted response, so it cannot be recovered",
    }),
  };

  private async authorize(request: NormalizedModelRequest): Promise<string> {
    const expectedGeneration = request.modelBinding?.connectionGeneration;
    if (
      !expectedGeneration ||
      request.modelBinding?.connectionId !== this.config.connectionId
    ) {
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: "Anthropic request has invalid Connection authority",
      });
    }
    const existing = this.authorized.get(request.requestId);
    if (existing) {
      if (existing.lease.credentialGeneration !== expectedGeneration) {
        throw new ModelProviderFailureError({
          classification: "permanent",
          reason: "Anthropic request generation changed",
        });
      }
      return existing.apiKey;
    }
    let lease: CredentialLeaseV1 | undefined;
    try {
      lease = await this.config.leaseCredential(
        request.requestId,
        expectedGeneration,
      );
      if (
        lease.effectId !== request.requestId ||
        lease.connectionId !== this.config.connectionId ||
        lease.credentialGeneration !== expectedGeneration ||
        Date.parse(lease.expiresAt) <= (this.config.now ?? Date.now)()
      ) {
        throw new Error("Anthropic credential lease is invalid");
      }
      const apiKey = await this.credentialLease.open({
        accountId: this.config.accountId,
        connectionId: this.config.connectionId,
        packageId: this.config.packageId,
        lease,
      });
      this.authorized.set(request.requestId, { lease, apiKey });
      return apiKey;
    } catch (error) {
      if (lease) {
        await this.config
          .settleCredential(request.requestId)
          .catch(() => undefined);
      }
      throw new ModelProviderFailureError({
        classification: "unknown",
        reason:
          error instanceof Error
            ? error.message
            : "Anthropic credential is unavailable",
      });
    }
  }

  async settle(requestId: string): Promise<void> {
    try {
      await this.config.settleCredential(requestId);
    } finally {
      this.authorized.delete(requestId);
    }
  }

  async *stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const apiKey = await this.authorize(request);
    const { note, instruction } = structuredOutputPlanV1(
      request,
      STRUCTURED_OUTPUT_SUPPORT,
    );
    if (note) yield { type: "response-format-note", note };
    const model = createAnthropic({
      apiKey,
      baseURL: this.config.apiBaseUrl ?? DEFAULT_ANTHROPIC_API_BASE_URL,
      ...(this.config.fetch
        ? { fetch: this.config.fetch as typeof globalThis.fetch }
        : {}),
    }).languageModel(request.model);
    const prompt = anthropicPromptV1(request, instruction);

    // Every failure raised before the first stream event happened before a
    // provider effect existed, so it is definitive rather than uncertain. One
    // raised after is not: reported as "not started" it would let a partly
    // streamed Turn be retried, which is exactly what must not happen.
    let started = false;
    try {
      for await (const event of streamEventsWithModelRequestDeadlinesV1(
        async (deadlineSignal) =>
          decodeAnthropicStreamV1(
            (
              await model.doStream({
                prompt,
                abortSignal: deadlineSignal,
                ...(request.tools.length > 0
                  ? {
                      tools: request.tools.map((tool) => ({
                        type: "function" as const,
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                      })),
                    }
                  : {}),
              })
            ).stream,
          ),
        signal,
        this.config.deadlines ?? {},
      )) {
        started = true;
        yield event;
      }
    } catch (error) {
      if (started || signal.aborted) throw error;
      if (error instanceof ModelRequestDeadlineError) {
        if (error.phase === "idle") throw error;
        throw new ModelProviderFailureError({
          classification: "transient",
          reason: error.message,
        });
      }
      throw classifyAnthropicFailureV1(error);
    }
  }
}

export function createAnthropicRuntimePlugin(
  config: AnthropicRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const provider = new AnthropicProvider(config, ctx.credentialLease);
    const disposeProvider = ctx.llm.register(provider);
    const disposeSettlement = ctx.on(
      "agent/model-outcome-committed",
      async (_agent, requestId) => provider.settle(requestId),
    );
    return () => {
      disposeSettlement();
      disposeProvider();
    };
  };
  plugin.inject = ["llm", "credentialLease"];
  return plugin;
}

export default createAnthropicRuntimePlugin;

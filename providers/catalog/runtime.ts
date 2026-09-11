import { decodeOAuthTokenV1 } from "./oauth-protocol.js";
import { bedrockStreamV1 } from "./bedrock.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import type { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import {
  type AgentRuntimeV1,
  type LlmProvider,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type RuntimeFeatureV1,
  ModelProviderFailureError,
} from "@frockbot/core/contracts";
import {
  classifyOpenAICompatibleFailureV1,
  streamEventsWithModelRequestDeadlinesV1,
  modelReplayBindingV1,
  structuredOutputPlanV1,
  systemWithInstructionV1,
} from "../openai-compatible/index.js";
import { loadProviderModelsV1 } from "./models.js";

const providers = new Map(
  builtinProviders().map((provider) => [provider.id, provider]),
);
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function catalogContextV1(
  request: NormalizedModelRequest,
  model: Model<Api>,
  instruction?: string,
): Context {
  return {
    systemPrompt: systemWithInstructionV1(request.system, instruction),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
    messages: request.messages.map((message) => {
      if (message.role === "user")
        return { role: "user", content: message.content, timestamp: 0 };
      if (message.role === "tool")
        return {
          role: "toolResult",
          toolCallId: message.callId,
          toolName: message.name,
          isError: message.isError,
          timestamp: 0,
          content: [
            { type: "text", text: message.content },
            ...(message.attachments ?? []).map((attachment) =>
              attachment.dataBase64 && model.input.includes("image")
                ? {
                    type: "image" as const,
                    data: attachment.dataBase64,
                    mimeType: attachment.mediaType,
                  }
                : {
                    type: "text" as const,
                    text: `[attachment ${attachment.mediaType} at ${attachment.workspacePath.path}; sha256 ${attachment.contentHash}]`,
                  },
            ),
          ],
        };
      const state = message.providerState;
      const content: AssistantMessage["content"] =
        state?.provider === request.provider &&
        state.model === request.model &&
        state.connectionId === request.modelBinding?.connectionId &&
        state.connectionGeneration ===
          request.modelBinding?.connectionGeneration
          ? JSON.parse(state.content)
          : [
              ...(message.content
                ? [{ type: "text" as const, text: message.content }]
                : []),
              ...message.toolCalls.map((call) => ({
                type: "toolCall" as const,
                id: call.id,
                name: call.name,
                arguments: call.input as Record<string, unknown>,
              })),
            ];
      return {
        role: "assistant",
        content,
        provider: request.provider,
        model: request.model,
        api: model.api,
        usage: zeroUsage,
        stopReason: message.toolCalls.length ? "toolUse" : "stop",
        timestamp: 0,
      };
    }),
  };
}

export async function* decodeCatalogStreamV1(
  events: AsyncIterable<AssistantMessageEvent>,
  request: NormalizedModelRequest,
): AsyncIterable<LlmStreamEvent> {
  for await (const event of events) {
    if (event.type === "text_delta")
      yield { type: "text-delta", text: event.delta };
    if (event.type === "error")
      throw new Error(event.error.errorMessage ?? "Model provider failed");
    if (event.type !== "done") continue;
    const response = event.message;
    if (!["stop", "length", "toolUse"].includes(response.stopReason))
      throw new Error(`Unsupported model outcome: ${response.stopReason}`);
    const calls = response.content.filter((part) => part.type === "toolCall");
    yield {
      type: "provider-state",
      state: {
        provider: request.provider,
        model: request.model,
        content: JSON.stringify(response.content),
        ...modelReplayBindingV1(request),
      },
    };
    const usage = response.usage;
    yield {
      type: "usage",
      usage: {
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
        ...(usage.cacheRead ? { cachedInputTokens: usage.cacheRead } : {}),
        ...(usage.reasoning === undefined
          ? {}
          : { reasoningTokens: usage.reasoning }),
      },
    };
    for (const call of calls)
      yield {
        type: "tool-call",
        call: { id: call.id, name: call.name, input: call.arguments },
      };
    yield {
      type: "finish",
      reason: calls.length
        ? "tool-calls"
        : response.stopReason === "length"
          ? "max-tokens"
          : "completed",
    };
    return;
  }
  throw new Error("Model stream ended without a terminal response");
}

export interface CatalogRuntimeConfigV1 {
  providerId: string;
  accountId: string;
  connectionId: string;
  settings?: Record<string, unknown>;
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  provider?: Provider;
}

class CatalogProvider implements LlmProvider {
  readonly id: string;
  readonly supports = { structuredOutput: "none" } as const;
  constructor(
    private readonly config: CatalogRuntimeConfigV1,
    private readonly credentials: CredentialLeaseRuntime,
  ) {
    this.id = config.providerId;
  }
  async *stream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const config = this.config;
    const generation = request.modelBinding?.connectionGeneration;
    if (
      !generation ||
      request.modelBinding?.connectionId !== config.connectionId ||
      request.provider !== this.id
    )
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: "Model Connection authority is invalid",
      });
    const lease = await config.leaseCredential(request.requestId, generation);
    if (
      lease.effectId !== request.requestId ||
      lease.connectionId !== config.connectionId ||
      lease.credentialGeneration !== generation ||
      Date.parse(lease.expiresAt) <= Date.now()
    )
      throw new Error("Model credential lease is invalid");
    const secret = await this.credentials.open({
      accountId: config.accountId,
      connectionId: config.connectionId,
      packageId: `provider-${this.id}`,
      lease,
    });
    const oauth = decodeOAuthTokenV1(secret);
    const apiKey = oauth?.access ?? secret;
    const endpoint =
      oauth?.baseUrl ??
      (typeof config.settings?.["api-base-url"] === "string"
        ? config.settings["api-base-url"]
        : undefined);
    const catalog = await loadProviderModelsV1(this.id, apiKey, endpoint);
    const selected = catalog.find((model) => model.id === request.model);
    if (!selected)
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: `Model "${request.model}" is unavailable from ${this.id}`,
      });
    const model = endpoint ? { ...selected, baseUrl: endpoint } : selected;
    const provider = config.provider ?? providers.get(this.id);
    if (!provider) throw new Error(`Provider ${this.id} is unavailable`);
    const env: Record<string, string> = {};
    for (const [setting, name] of Object.entries({
      region: "AWS_REGION",
      "account-id": "CLOUDFLARE_ACCOUNT_ID",
      "gateway-id": "CLOUDFLARE_GATEWAY_ID",
      "api-version": "AZURE_OPENAI_API_VERSION",
    })) {
      const value = config.settings?.[setting];
      if (typeof value === "string") env[name] = value;
    }
    const plan = structuredOutputPlanV1(request, "none");
    if (plan.note) yield { type: "response-format-note", note: plan.note };
    if (this.id === "amazon-bedrock") {
      const region =
        typeof config.settings?.region === "string"
          ? config.settings.region
          : "us-east-1";
      if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region))
        throw new Error("AWS region is invalid");
      yield* streamEventsWithModelRequestDeadlinesV1(
        async (deadlineSignal) =>
          bedrockStreamV1(
            {
              ...request,
              system:
                systemWithInstructionV1(request.system, plan.instruction) ?? "",
            },
            {
              apiKey,
              baseUrl:
                endpoint ?? `https://bedrock-runtime.${region}.amazonaws.com`,
              maxTokens: selected.maxTokens,
              signal: deadlineSignal,
            },
          ),
        signal,
        {},
      );
      return;
    }
    let status: number | undefined;
    let started = false;
    try {
      for await (const event of streamEventsWithModelRequestDeadlinesV1(
        async (deadlineSignal) =>
          decodeCatalogStreamV1(
            provider.streamSimple(
              model,
              catalogContextV1(request, model, plan.instruction),
              {
                apiKey: oauth && this.id === "kimi-coding" ? undefined : apiKey,
                env,
                signal: deadlineSignal,
                maxRetries: 0,
                transport: "sse",
                headers: {
                  "Idempotency-Key": request.requestId,
                  ...(oauth && this.id === "kimi-coding"
                    ? { Authorization: `Bearer ${oauth.access}` }
                    : {}),
                },
                onResponse(response) {
                  status = response.status;
                },
              },
            ),
            request,
          ),
        signal,
        {},
      )) {
        started = true;
        yield event;
      }
    } catch (error) {
      if (!started && status !== undefined && status >= 400 && status < 500)
        throw new ModelProviderFailureError({
          classification: classifyOpenAICompatibleFailureV1(status),
          reason: `Provider rejected the model request (${status})`,
        });
      throw error;
    }
  }
}

export function createCatalogProviderFeatureV1(
  config: CatalogRuntimeConfigV1,
): RuntimeFeatureV1<AgentRuntimeV1 & { credentials?: CredentialLeaseRuntime }> {
  return (runtime) => {
    if (!runtime.credentials)
      throw new Error("Credential Store Contribution is not configured");
    const disposeProvider = runtime.llm.register(
      new CatalogProvider(config, runtime.credentials),
    );
    const disposeSettlement = runtime.hooks.add({
      modelOutcomeCommitted: async (_agent, requestId) =>
        config.settleCredential(requestId),
    });
    return () => {
      disposeSettlement();
      disposeProvider();
    };
  };
}

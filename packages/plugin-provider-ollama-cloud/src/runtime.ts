import {
  type LlmProvider,
  type LlmReconciliationCapability,
  type LlmStreamEvent,
  ModelProviderFailureError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { type Agent } from "@frockbot/kernel-agent-loop/agent";
import type { CredentialLeaseV1 } from "@frockbot/connection-core";
import {
  type ModelRequestDeadlineOptionsV1,
  OpenAICompatibleHttpError,
  OpenAICompatibleProvider,
  planOpenAICompatibleRequestV1,
  streamWithModelRequestDeadlinesV1,
} from "@frockbot/provider-openai-compatible";
import type { Plugin } from "cordis";
import {
  DEFAULT_OLLAMA_API_BASE_URL,
  decodeOllamaApiBaseUrl,
  type OllamaFetch,
} from "./client.js";

interface CredentialLeaseOpener {
  open(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string>;
}

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

export const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";

export interface OllamaCloudRuntimeConfig {
  accountId: string;
  connectionId: string;
  packageId: "provider-ollama-cloud";
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  /**
   * OpenAI-compatible chat root for this Connection's endpoint. Defaults to
   * the Package endpoint `https://ollama.com/v1`; a Connection that points
   * elsewhere supplies `<apiBaseUrl>/v1`.
   */
  chatBaseUrl?: string;
  fetch?: OllamaFetch;
  now?: () => number;
  /**
   * Deadline overrides and the timer seam behind them, forwarded to the shared
   * OpenAI-compatible transport. Without forwarding, the deadlines are real but
   * only reachable by waiting two minutes for one.
   */
  deadlines?: ModelRequestDeadlineOptionsV1;
}

/** Compose the OpenAI-compatible chat root from a Connection endpoint root. */
export function ollamaChatBaseUrl(apiBaseUrl?: string): string {
  return `${decodeOllamaApiBaseUrl(apiBaseUrl ?? DEFAULT_OLLAMA_API_BASE_URL)}/v1`;
}

/** Native Ollama accepts either `"json"` or the schema itself as `format`. */
export function ollamaFormatForRequestV1(
  request: NormalizedModelRequest,
): "json" | Record<string, unknown> | undefined {
  if (request.responseFormat?.type === "json") return "json";
  return request.responseFormat?.type === "json_schema"
    ? request.responseFormat.schema
    : undefined;
}

/** Maps a normalized request onto Ollama's native `/api/chat` shape. */
export function ollamaNativeChatBodyV1(
  request: NormalizedModelRequest,
): Record<string, unknown> {
  const openAi = planOpenAICompatibleRequestV1(request, {
    structuredOutput: "json_schema",
  }).body;
  const { response_format: _responseFormat, ...body } = openAi;
  return {
    ...body,
    stream: false,
    ...(ollamaFormatForRequestV1(request)
      ? { format: ollamaFormatForRequestV1(request) }
      : {}),
  };
}

interface AuthorizedRequest {
  lease: CredentialLeaseV1;
  apiKey: string;
}

class OllamaCloudProvider implements LlmProvider {
  readonly id = OLLAMA_CLOUD_PROVIDER;
  readonly supports;
  private readonly authorized = new Map<string, AuthorizedRequest>();

  constructor(
    private readonly config: OllamaCloudRuntimeConfig,
    private readonly credentialLease: CredentialLeaseOpener,
  ) {
    this.supports = {
      structuredOutput: this.usesNativeStructuredOutput()
        ? "json_schema"
        : "none",
    } as const;
  }

  private chatBaseUrl(): string {
    return this.config.chatBaseUrl ?? ollamaChatBaseUrl();
  }

  private usesNativeStructuredOutput(): boolean {
    return new URL(this.chatBaseUrl()).hostname !== "ollama.com";
  }

  async authorize(request: NormalizedModelRequest): Promise<void> {
    const binding = request.modelBinding;
    const expectedGeneration = binding?.connectionGeneration;
    if (
      !expectedGeneration ||
      binding.connectionId !== this.config.connectionId
    ) {
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: "Ollama Cloud request has invalid Connection authority",
      });
    }
    const existing = this.authorized.get(request.requestId);
    if (existing) {
      if (existing.lease.credentialGeneration !== expectedGeneration) {
        throw new ModelProviderFailureError({
          classification: "permanent",
          reason: "Ollama Cloud request generation changed",
        });
      }
      return;
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
        throw new Error("Ollama Cloud credential lease is invalid");
      }
      const apiKey = await this.credentialLease.open({
        accountId: this.config.accountId,
        connectionId: this.config.connectionId,
        packageId: this.config.packageId,
        lease,
      });
      this.authorized.set(request.requestId, { lease, apiKey });
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
            : "Ollama Cloud credential is unavailable",
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

  /**
   * Ollama keeps no addressable copy of a completion, so an interrupted stream
   * can never be read back. Saying so settles the run as a failure with its
   * partial text intact instead of parking it forever.
   */
  readonly reconciliation: LlmReconciliationCapability = {
    retrieve: async () => ({
      status: "not-retrievable",
      reason:
        "Ollama keeps no durable copy of an interrupted response, so it cannot be recovered",
    }),
  };

  async *stream(request: NormalizedModelRequest, signal: AbortSignal) {
    await this.authorize(request);
    const authorization = this.authorized.get(request.requestId);
    if (!authorization) {
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: "Ollama Cloud request authorization is unavailable",
      });
    }
    if (request.responseFormat && this.usesNativeStructuredOutput()) {
      yield* this.streamNativeStructured(request, authorization.apiKey, signal);
      return;
    }
    const provider = new OpenAICompatibleProvider({
      baseUrl: this.chatBaseUrl(),
      apiKey: authorization.apiKey,
      providerId: this.id,
      structuredOutput: "none",
      fetch: this.config.fetch,
      ...(this.config.deadlines?.deadlines
        ? { deadlines: this.config.deadlines.deadlines }
        : {}),
      ...(this.config.deadlines?.schedule
        ? { schedule: this.config.deadlines.schedule }
        : {}),
    });
    // Every failure raised before the first stream event happened before a
    // provider effect existed, so it is definitive rather than uncertain. A 429
    // or a 502 reported as a bare failure would park the run on a retrieval
    // this Package cannot perform; reported as "not started" it fails cleanly
    // and can be retried.
    let started = false;
    try {
      for await (const event of provider.stream(request, signal)) {
        started = true;
        yield event;
      }
    } catch (error) {
      if (started || signal.aborted) throw error;
      if (error instanceof ModelProviderFailureError) throw error;
      throw new ModelProviderFailureError({
        classification: "unknown",
        reason:
          error instanceof OpenAICompatibleHttpError || error instanceof Error
            ? error.message
            : "Ollama Cloud request did not reach the provider",
      });
    }
  }

  private async *streamNativeStructured(
    request: NormalizedModelRequest,
    apiKey: string,
    signal: AbortSignal,
  ): AsyncIterable<LlmStreamEvent> {
    const fetcher =
      this.config.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
    const apiRoot = this.chatBaseUrl().replace(/\/v1\/?$/, "");
    yield* streamWithModelRequestDeadlinesV1(
      async (deadlineSignal) => {
        const response = await fetcher(`${apiRoot}/api/chat`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(ollamaNativeChatBodyV1(request)),
          signal: deadlineSignal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new OpenAICompatibleHttpError(response.status);
        }
        const text = await boundedOllamaModelResponseV1(response);
        const parsed = JSON.parse(text) as {
          message?: { content?: unknown };
          done_reason?: unknown;
        };
        if (typeof parsed.message?.content !== "string") {
          throw new Error("Ollama response did not include message content");
        }
        const translated = JSON.stringify({
          choices: [
            {
              message: { content: parsed.message.content },
              finish_reason:
                parsed.done_reason === "length" ? "length" : "stop",
            },
          ],
        });
        return new Response(translated).body!;
      },
      signal,
      this.config.deadlines ?? {},
    );
  }
}

const MAX_OLLAMA_MODEL_RESPONSE_BYTES_V1 = 16_777_216;

async function boundedOllamaModelResponseV1(
  response: Response,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Ollama response did not include a body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OLLAMA_MODEL_RESPONSE_BYTES_V1) {
      await reader.cancel();
      throw new Error("Ollama response exceeded its size limit");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export function createOllamaCloudRuntimePlugin(
  config: OllamaCloudRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const provider = new OllamaCloudProvider(config, ctx.credentialLease);
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

export default createOllamaCloudRuntimePlugin;

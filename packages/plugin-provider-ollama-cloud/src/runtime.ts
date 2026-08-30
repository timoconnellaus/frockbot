import {
  type Agent,
  LlmEffectNotStartedError,
  type LlmProvider,
  type NormalizedModelRequest,
} from "@frockbot/agent-core";
import {
  type CredentialLeaseV1,
  openCredentialV1,
  parseCredentialKeyringV1,
} from "@frockbot/connection-core";
import {
  OpenAICompatibleHttpError,
  OpenAICompatibleProvider,
} from "@frockbot/provider-openai-compatible";
import type { Plugin } from "cordis";
import type { OllamaFetch } from "./client.js";

declare module "cordis" {
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
  credentialKeyring: string;
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  chatBaseUrl?: string;
  fetch?: OllamaFetch;
  now?: () => number;
}

interface AuthorizedRequest {
  lease: CredentialLeaseV1;
  apiKey: string;
}

class OllamaCloudProvider implements LlmProvider {
  readonly id = OLLAMA_CLOUD_PROVIDER;
  private readonly keyring;
  private readonly authorized = new Map<string, AuthorizedRequest>();

  constructor(private readonly config: OllamaCloudRuntimeConfig) {
    this.keyring = parseCredentialKeyringV1(config.credentialKeyring);
  }

  async authorize(request: NormalizedModelRequest): Promise<void> {
    const expectedGeneration = request.modelBinding?.connectionGeneration;
    if (!expectedGeneration) {
      throw new LlmEffectNotStartedError(
        "Ollama Cloud request is missing its Connection generation",
      );
    }
    const existing = this.authorized.get(request.requestId);
    if (existing) {
      if (existing.lease.credentialGeneration !== expectedGeneration) {
        throw new LlmEffectNotStartedError(
          "Ollama Cloud request generation changed",
        );
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
        lease.credentialGeneration !== expectedGeneration ||
        Date.parse(lease.expiresAt) <= (this.config.now ?? Date.now)()
      ) {
        throw new Error("Ollama Cloud credential lease is invalid");
      }
      const apiKey = await openCredentialV1({
        keyring: this.keyring,
        context: {
          accountId: this.config.accountId,
          connectionId: this.config.connectionId,
          packageId: this.config.packageId,
          credentialGeneration: lease.credentialGeneration,
        },
        envelope: lease.envelope,
      });
      this.authorized.set(request.requestId, { lease, apiKey });
    } catch (error) {
      if (lease) {
        await this.config
          .settleCredential(request.requestId)
          .catch(() => undefined);
      }
      throw new LlmEffectNotStartedError(
        error instanceof Error
          ? error.message
          : "Ollama Cloud credential is unavailable",
      );
    }
  }

  async settle(requestId: string): Promise<void> {
    try {
      await this.config.settleCredential(requestId);
    } finally {
      this.authorized.delete(requestId);
    }
  }

  async *stream(request: NormalizedModelRequest, signal: AbortSignal) {
    await this.authorize(request);
    const authorization = this.authorized.get(request.requestId);
    if (!authorization) {
      throw new LlmEffectNotStartedError(
        "Ollama Cloud request authorization is unavailable",
      );
    }
    const provider = new OpenAICompatibleProvider({
      baseUrl: this.config.chatBaseUrl ?? "https://ollama.com/v1",
      apiKey: authorization.apiKey,
      providerId: this.id,
      fetch: this.config.fetch,
    });
    try {
      yield* provider.stream(request, signal);
    } catch (error) {
      if (
        error instanceof OpenAICompatibleHttpError &&
        (error.status === 401 || error.status === 403 || error.status === 404)
      ) {
        throw new LlmEffectNotStartedError(error.message);
      }
      throw error;
    }
  }
}

export function createOllamaCloudRuntimePlugin(
  config: OllamaCloudRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const provider = new OllamaCloudProvider(config);
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
  plugin.inject = ["llm"];
  return plugin;
}

export default createOllamaCloudRuntimePlugin;

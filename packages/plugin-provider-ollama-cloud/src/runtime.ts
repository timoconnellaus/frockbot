import {
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

export const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";

export interface OllamaCloudRuntimeConfig {
  accountId: string;
  connectionId: string;
  packageId: "provider-ollama-cloud";
  credentialKeyring: string;
  leaseCredential(effectId: string): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  chatBaseUrl?: string;
  fetch?: OllamaFetch;
}

class OllamaCloudProvider implements LlmProvider {
  readonly id = OLLAMA_CLOUD_PROVIDER;
  private readonly keyring;

  constructor(private readonly config: OllamaCloudRuntimeConfig) {
    this.keyring = parseCredentialKeyringV1(config.credentialKeyring);
  }

  async *stream(request: NormalizedModelRequest, signal: AbortSignal) {
    let lease: CredentialLeaseV1;
    let apiKey: string;
    try {
      lease = await this.config.leaseCredential(request.requestId);
      apiKey = await openCredentialV1({
        keyring: this.keyring,
        context: {
          accountId: this.config.accountId,
          connectionId: this.config.connectionId,
          packageId: this.config.packageId,
          credentialGeneration: lease.credentialGeneration,
        },
        envelope: lease.envelope,
      });
    } catch (error) {
      throw new LlmEffectNotStartedError(
        error instanceof Error
          ? error.message
          : "Ollama Cloud credential is unavailable",
      );
    }

    const provider = new OpenAICompatibleProvider({
      baseUrl: this.config.chatBaseUrl ?? "https://ollama.com/v1",
      apiKey,
      providerId: this.id,
      fetch: this.config.fetch,
    });
    try {
      yield* provider.stream(request, signal);
    } catch (error) {
      if (
        error instanceof OpenAICompatibleHttpError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        throw new LlmEffectNotStartedError(error.message);
      }
      throw error;
    } finally {
      await this.config.settleCredential(request.requestId);
    }
  }
}

export function createOllamaCloudRuntimePlugin(
  config: OllamaCloudRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) =>
    ctx.llm.register(new OllamaCloudProvider(config));
  plugin.inject = ["llm"];
  return plugin;
}

export default createOllamaCloudRuntimePlugin;

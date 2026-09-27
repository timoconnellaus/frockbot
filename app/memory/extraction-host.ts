import { LoopHookListV1 } from "@frockbot/core/contracts";
import { LlmRegistry } from "@frockbot/core/models";
import {
  FROCK_AI_CONNECTION_GENERATION,
  FROCK_AI_CONNECTION_ID,
  FROCK_AI_PROVIDER_TYPE,
  FROCK_AI_SUMMARY_MODEL,
} from "@frockbot/providers/frock-ai/catalog";
import {
  createFrockAiProviderV1,
  type FrockAiChatCompletionV1,
} from "@frockbot/providers/frock-ai/runtime";
import { BilledLlmRegistry, type ModelBilling } from "../billing/model.js";
import type { UsageAttributionV1 } from "../billing/ledger.js";
import { createModelMemoryExtractorV1 } from "./extraction.js";
import {
  MemoryExtractionNotSentError,
  type MemoryProcessingAdaptersV1,
} from "./processing.js";

/**
 * The deployment's extractor: the platform's summary model on the ambient
 * Frock AI Connection, billed to the Turn whose words it reads, as a summary.
 * Absent Frock AI, there is none and a job waits, as before.
 */
export function createHostedMemoryExtractorV1(host: {
  readonly gateway?: {
    autoRoute: string | null;
    runChatCompletion: FrockAiChatCompletionV1;
  };
  readonly billing?: (
    userId: string,
    botId: string,
    sessionId: string,
    spend?: UsageAttributionV1,
  ) => ModelBilling;
}): MemoryProcessingAdaptersV1["extract"] {
  const gateway = host.gateway;
  if (!gateway) return undefined;
  return createModelMemoryExtractorV1({
    provider: FROCK_AI_PROVIDER_TYPE,
    model: FROCK_AI_SUMMARY_MODEL,
    modelBinding: {
      connectionId: FROCK_AI_CONNECTION_ID,
      connectionGeneration: FROCK_AI_CONNECTION_GENERATION,
    },
    async *stream(request, dispatch, signal) {
      const { principal } = dispatch;
      const hooks = new LoopHookListV1();
      const registry = host.billing
        ? new BilledLlmRegistry(
            hooks,
            host.billing(
              principal.userId,
              principal.botId,
              principal.sessionId ?? `${principal.userId}:${principal.botId}`,
              {
                ...(principal.runId ? { runId: principal.runId } : {}),
                summary: true,
              },
            ),
          )
        : new LlmRegistry(hooks);
      let sent = false;
      registry.register(
        createFrockAiProviderV1({
          connectionId: FROCK_AI_CONNECTION_ID,
          connectionGeneration: FROCK_AI_CONNECTION_GENERATION,
          autoRoute: gateway.autoRoute,
          runChatCompletion: (...args) => {
            sent = true;
            return gateway.runChatCompletion(...args);
          },
        }),
      );
      try {
        yield* registry.stream(request, signal);
      } catch (error) {
        if (sent) throw error;
        throw new MemoryExtractionNotSentError(
          "The memory extraction call was refused before it was sent.",
          { cause: error },
        );
      }
    },
  });
}

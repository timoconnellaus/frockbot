import {
  type AgentRuntimeV1,
  type LlmProvider,
  ModelProviderFailureError,
  type NormalizedModelRequest,
  type RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import {
  LOCAL_MODEL_DROPPED_V1,
  LOCAL_MODEL_OFFLINE_V1,
} from "@frockbot/core/machine-protocol/relay";
import {
  type ModelRequestDeadlineOptionsV1,
  OpenAICompatibleProvider,
} from "@frockbot/providers/openai-compatible";

import { LOCAL_MODEL_PROVIDER, localModelChatRelayIdV1 } from "./endpoint.js";

export interface LocalModelRelayRequestV1 {
  relayId: string;
  /** The OpenAI-compatible chat body, as JSON text. */
  body: string;
}

export interface LocalModelRuntimeConfig {
  connectionId: string;
  /**
   * Sends one chat request to the Mac the Connection names and answers its
   * streamed response. The User Durable Object reads the Mac and the endpoint
   * from the Connection itself, so nothing here names a destination.
   */
  relay(request: LocalModelRelayRequestV1): Promise<Response>;
  deadlines?: ModelRequestDeadlineOptionsV1;
}

/** The sentence a person reads, when the failure is one written for them. */
function written(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error);
  return [LOCAL_MODEL_OFFLINE_V1, LOCAL_MODEL_DROPPED_V1].find((sentence) =>
    text.includes(sentence),
  );
}

/**
 * A model served from the person's own Mac. It costs nothing and is never a
 * fallback for anything: when the Mac is offline the call fails with the
 * sentence that says so, and nothing else answers in its place.
 */
class LocalModelProvider implements LlmProvider {
  readonly id = LOCAL_MODEL_PROVIDER;
  // Local servers differ in what they honour; the kernel's prompt fallback and
  // validation work with all of them.
  readonly supports = { structuredOutput: "none" } as const;

  constructor(private readonly config: LocalModelRuntimeConfig) {}

  async *stream(request: NormalizedModelRequest, signal: AbortSignal) {
    if (request.modelBinding?.connectionId !== this.config.connectionId) {
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason: "Local model request has invalid Connection authority",
      });
    }
    const relayId = await localModelChatRelayIdV1(request.requestId);
    const provider = new OpenAICompatibleProvider({
      // Never dialled: the relay below is the only transport, and the
      // destination is the Connection's, resolved where it is held.
      baseUrl: "http://localhost/v1",
      providerId: this.id,
      structuredOutput: "none",
      fetch: async (_input, init) => {
        const body = init?.body;
        if (typeof body !== "string") {
          throw new Error("Local model request body is not text");
        }
        const response = await this.config.relay({ relayId, body });
        // The relay answers once the Mac has, so a cancel from here on is the
        // stream's own: cancelling the body tells the Mac to stop.
        init?.signal?.addEventListener(
          "abort",
          () => void response.body?.cancel().catch(() => undefined),
          { once: true },
        );
        return response;
      },
      ...(this.config.deadlines?.deadlines
        ? { deadlines: this.config.deadlines.deadlines }
        : {}),
      ...(this.config.deadlines?.schedule
        ? { schedule: this.config.deadlines.schedule }
        : {}),
    });
    let started = false;
    try {
      for await (const event of provider.stream(request, signal)) {
        started = true;
        yield event;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const sentence = written(error);
      if (sentence) {
        // Sending again changes nothing until the person opens the app.
        throw new ModelProviderFailureError({
          classification: "permanent",
          reason: sentence,
        });
      }
      if (started || error instanceof ModelProviderFailureError) throw error;
      // Nothing had been produced, so nothing is uncertain: the call failed.
      throw new ModelProviderFailureError({
        classification: "permanent",
        reason:
          error instanceof Error
            ? error.message
            : "The local model could not be reached",
      });
    }
  }
}

export function createLocalModelFeature(
  config: LocalModelRuntimeConfig,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => runtime.llm.register(new LocalModelProvider(config));
}

export default createLocalModelFeature;

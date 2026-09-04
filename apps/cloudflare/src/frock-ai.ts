import { FROCK_AI_DEFAULT_AUTO_ROUTE } from "@frockbot/plugin-provider-frock-ai/catalog";

export const DEFAULT_FROCK_AI_GATEWAY_ID_V1 = "flock";

export interface FrockAiGatewayHostV1 {
  autoRoute: string;
  runChatCompletion(
    gatewayModel: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}

/**
 * The Gateway request is bounded so a gateway that accepts the connection and
 * then never answers fails the Turn instead of holding it open. The deadline
 * covers reaching the gateway; the SSE body that follows is bounded per read by
 * the OpenAI-compatible decoder.
 */
export const FROCK_AI_GATEWAY_TIMEOUT_MS_V1 = 60_000;

export interface FrockAiGatewayConfigV1 {
  gatewayId?: string;
  autoRoute?: string;
  /**
   * The Cloudflare account owning the Gateway. Present with `token`, requests
   * take the compat HTTP transport; absent, they take the `AI` binding.
   */
  accountId?: string;
  /** The `cf-aig-authorization` bearer for an authenticated Gateway. */
  token?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Deadline for reaching the Gateway. */
  timeoutMs?: number;
}

export function compatChatCompletionsUrlV1(
  accountId: string,
  gatewayId: string,
): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`;
}

/**
 * A rejected request answers with a JSON error body rather than an SSE stream.
 * Left unchecked it decodes as a stream that ends before its terminal marker,
 * which the Agent reads as an *uncertain* outcome and parks the run on — so the
 * status is what tells the two apart.
 */
async function streamOrThrowV1(
  response: Response,
): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 512);
    throw new Error(
      `AI Gateway rejected the request (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  if (!response.body) {
    throw new Error("AI Gateway did not return a response stream");
  }
  return response.body;
}

/** Keep the generated Cloudflare binding type on the Worker side of the seam. */
export function createFrockAiGatewayHostV1(
  ai: Pick<Ai, "gateway">,
  config: FrockAiGatewayConfigV1,
): FrockAiGatewayHostV1 {
  const gatewayId = config.gatewayId || DEFAULT_FROCK_AI_GATEWAY_ID_V1;
  const autoRoute = config.autoRoute || FROCK_AI_DEFAULT_AUTO_ROUTE;
  const { accountId, token } = config;
  // The `AI` binding's `gateway(...).run()` reaches the Gateway's *universal*
  // endpoint, whose request-shape translation rejects a `dynamic/<route>` model
  // before inference runs — cloudflare/ai#617. Concrete `workers-ai/@cf/...`
  // ids survive that translation, so the binding stays the transport wherever
  // no Gateway credentials are configured, which is every local and CI
  // environment that binds a stand-in for `AI`.
  const useCompat = Boolean(accountId && token);
  const timeoutMs = config.timeoutMs ?? FROCK_AI_GATEWAY_TIMEOUT_MS_V1;
  const doFetch = config.fetch ?? fetch;
  return {
    autoRoute,
    async runChatCompletion(gatewayModel, body, signal) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      const timedOut = (error: unknown): never => {
        if (deadline.aborted && !signal?.aborted) {
          throw new Error(`AI Gateway did not respond within ${timeoutMs}ms`);
        }
        throw error;
      };
      if (useCompat) {
        let response: Response;
        try {
          response = await doFetch(
            compatChatCompletionsUrlV1(accountId!, gatewayId),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "cf-aig-authorization": `Bearer ${token!}`,
              },
              body: JSON.stringify({ ...body, model: gatewayModel }),
              signal: requestSignal,
            },
          );
        } catch (error) {
          return timedOut(error);
        }
        return streamOrThrowV1(response);
      }
      // The `AI` binding takes no signal, so the deadline is raced against the
      // call rather than cancelling it.
      let response: Response;
      try {
        response = await Promise.race([
          ai.gateway(gatewayId).run({
            provider: "compat",
            endpoint: "chat/completions",
            headers: {},
            query: { ...body, model: gatewayModel },
          }),
          new Promise<never>((_resolve, reject) => {
            requestSignal.addEventListener(
              "abort",
              () => reject(requestSignal.reason),
              { once: true },
            );
          }),
        ]);
      } catch (error) {
        return timedOut(error);
      }
      return streamOrThrowV1(response);
    },
  };
}

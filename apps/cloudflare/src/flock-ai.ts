import { FLOCK_AI_DEFAULT_AUTO_ROUTE } from "@frockbot/plugin-provider-flock-ai/catalog";

export const DEFAULT_FLOCK_AI_GATEWAY_ID_V1 = "flock";

export interface FlockAiGatewayHostV1 {
  autoRoute: string;
  runChatCompletion(
    gatewayModel: string,
    body: Record<string, unknown>,
  ): Promise<ReadableStream<Uint8Array>>;
}

/** Keep the generated Cloudflare binding type on the Worker side of the seam. */
export function createFlockAiGatewayHostV1(
  ai: Pick<Ai, "gateway">,
  config: { gatewayId?: string; autoRoute?: string },
): FlockAiGatewayHostV1 {
  const gatewayId = config.gatewayId || DEFAULT_FLOCK_AI_GATEWAY_ID_V1;
  const autoRoute = config.autoRoute || FLOCK_AI_DEFAULT_AUTO_ROUTE;
  return {
    autoRoute,
    async runChatCompletion(gatewayModel, body) {
      const response = await ai.gateway(gatewayId).run({
        provider: "compat",
        endpoint: "chat/completions",
        headers: {},
        query: { ...body, model: gatewayModel },
      });
      if (!response.body) {
        throw new Error("AI Gateway did not return a response stream");
      }
      return response.body;
    },
  };
}

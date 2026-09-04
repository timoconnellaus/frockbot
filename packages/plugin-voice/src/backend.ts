import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";
import type { Plugin } from "cordis";

export interface VoiceGatewayHostV1 {
  readVoiceAssistant(userId: string): Promise<unknown>;
  openVoiceAssistant(userId: string, request: Request): Promise<Response>;
}

export interface VoiceBackendRouteContributionV1 {
  packageId: "voice";
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

export function createVoiceBackendContributionV1(
  host: VoiceGatewayHostV1,
): VoiceBackendRouteContributionV1 {
  return {
    packageId: "voice",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      if (url.pathname === "/api/voice") {
        if (request.method !== "GET") {
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        }
        return Response.json(await host.readVoiceAssistant(context.userId));
      }
      if (url.pathname === "/api/voice/assistant") {
        if (request.method !== "GET") {
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        }
        return host.openVoiceAssistant(context.userId, request);
      }
      return undefined;
    },
  };
}

export namespace createVoiceBackendContributionV1 {
  export function plugin(
    host: VoiceGatewayHostV1,
    lifecycle: { mount(value: VoiceBackendRouteContributionV1): () => void },
  ): Plugin {
    return () => lifecycle.mount(createVoiceBackendContributionV1(host));
  }
}

export const backendContribution = defineGatewayContribution<
  VoiceGatewayHostV1,
  VoiceBackendRouteContributionV1
>({
  specifier: "@frockbot/plugin-voice/backend",
  create: createVoiceBackendContributionV1.plugin,
});

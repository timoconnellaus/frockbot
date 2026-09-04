import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";
import type { Plugin } from "cordis";
import type { UsageReportV1 } from "./shared.js";

export interface BillingGatewayHostV1 {
  readUsage(userId: string): Promise<UsageReportV1>;
}

export interface BillingBackendRouteContributionV1 {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string },
  ): Promise<Response | undefined>;
}

export function createBillingBackendContribution(
  host: BillingGatewayHostV1,
): BillingBackendRouteContributionV1 {
  return {
    packageId: "billing",
    async route(request, url, context) {
      if (url.pathname !== "/api/usage" || !context.userId) return undefined;
      if (request.method !== "GET") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
      }
      try {
        return Response.json(await host.readUsage(context.userId));
      } catch (error) {
        return Response.json(
          {
            error: error instanceof Error ? error.message : "usage read failed",
          },
          { status: 500 },
        );
      }
    },
  };
}

export namespace createBillingBackendContribution {
  export function plugin(
    host: BillingGatewayHostV1,
    lifecycle: { mount(value: BillingBackendRouteContributionV1): () => void },
  ): Plugin {
    return () => lifecycle.mount(createBillingBackendContribution(host));
  }
}

export const backendContribution = defineGatewayContribution<
  BillingGatewayHostV1,
  BillingBackendRouteContributionV1
>({
  specifier: "@frockbot/plugin-billing/backend",
  create: createBillingBackendContribution.plugin,
});

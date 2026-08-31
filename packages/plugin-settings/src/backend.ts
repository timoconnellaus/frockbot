import {
  decodeBotIdV1,
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationIdV1,
  decodeCompositionGenerationListViewV1,
  decodeCompositionGenerationViewV1,
  decodeRevertCompositionCommandV1,
  isPublicIdentifier,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  type CompositionCommandReceiptV1,
  type CompositionGenerationListViewV1,
  type CompositionGenerationViewV1,
  type RevertCompositionCommandV1,
} from "@frockbot/configuration-core";
import {
  decodeConnectionCommandIdV1,
  decodeConnectionCommandReceiptV1,
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/connection-core";
import type { Plugin } from "cordis";

export interface SettingsConnectionGatewayHost {
  executeConnection(
    userId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1>;
  lookupConnectionCommand(
    userId: string,
    packageId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined>;
}

/**
 * The Bot Durable Object is the authority for its Composition generations; the
 * gateway only carries the request. Every method is Bot-scoped and the
 * authority proves directory membership before it answers.
 */
export interface SettingsCompositionGatewayHost {
  listCompositionGenerations(
    userId: string,
    botId: string,
    query: { limit: number; cursor?: string },
  ): Promise<CompositionGenerationListViewV1>;
  getCompositionGeneration(
    userId: string,
    botId: string,
    generationId: string,
  ): Promise<CompositionGenerationViewV1 | undefined>;
  revertComposition(
    userId: string,
    botId: string,
    command: RevertCompositionCommandV1,
  ): Promise<CompositionCommandReceiptV1>;
}

export type SettingsGatewayHost = SettingsConnectionGatewayHost &
  SettingsCompositionGatewayHost;

export interface SettingsBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

const COMPOSITION_GENERATIONS =
  /^\/api\/bots\/([^/]+)\/composition\/generations$/;
const COMPOSITION_GENERATION =
  /^\/api\/bots\/([^/]+)\/composition\/generations\/([^/]+)$/;
const COMPOSITION_REVERT = /^\/api\/bots\/([^/]+)\/composition\/revert$/;

function pathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("request path is invalid");
  }
}

function compositionListQuery(url: URL): { limit: number; cursor?: string } {
  const allowed = new Set(["limit", "cursor"]);
  if (
    [...url.searchParams.keys()].some((field) => !allowed.has(field)) ||
    url.searchParams.getAll("limit").length > 1 ||
    url.searchParams.getAll("cursor").length > 1
  ) {
    throw new Error("Composition generation query is invalid");
  }
  const rawLimit = url.searchParams.get("limit");
  const limit =
    rawLimit === null ? MAX_COMPOSITION_GENERATION_PAGE_V1 : Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_COMPOSITION_GENERATION_PAGE_V1
  ) {
    throw new Error("Composition generation query is invalid");
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > 512)) {
    throw new Error("Composition generation query is invalid");
  }
  return { limit, ...(cursor === null ? {} : { cursor }) };
}

async function routeComposition(
  host: SettingsCompositionGatewayHost,
  request: Request,
  url: URL,
  userId: string,
): Promise<Response | undefined> {
  const list = url.pathname.match(COMPOSITION_GENERATIONS);
  const single = url.pathname.match(COMPOSITION_GENERATION);
  const revert = url.pathname.match(COMPOSITION_REVERT);
  if (!list && !single && !revert) return undefined;
  try {
    const botId = decodeBotIdV1(
      pathSegment((list ?? single ?? revert)![1]!),
      "botId",
    );
    if (revert) {
      if (request.method !== "POST") {
        return jsonError(405, "method not allowed");
      }
      const command = decodeRevertCompositionCommandV1(await request.json());
      if (command.botId !== botId) {
        return jsonError(
          400,
          "Composition revert command does not match the request path",
        );
      }
      return Response.json(
        decodeCompositionCommandReceiptV1(
          await host.revertComposition(userId, botId, command),
        ),
      );
    }
    if (request.method !== "GET") return jsonError(405, "method not allowed");
    if (single) {
      const generationId = decodeCompositionGenerationIdV1(
        pathSegment(single[2]!),
      );
      const generation = await host.getCompositionGeneration(
        userId,
        botId,
        generationId,
      );
      if (!generation) {
        return jsonError(404, "Composition generation is unknown");
      }
      return Response.json(decodeCompositionGenerationViewV1(generation));
    }
    return Response.json(
      decodeCompositionGenerationListViewV1(
        await host.listCompositionGenerations(
          userId,
          botId,
          compositionListQuery(url),
        ),
      ),
    );
  } catch (error) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "Composition request failed",
    );
  }
}

export function createSettingsBackendContribution(
  host: SettingsGatewayHost,
): SettingsBackendRouteContribution {
  return {
    packageId: "settings",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const composition = await routeComposition(
        host,
        request,
        url,
        context.userId,
      );
      if (composition) return composition;
      if (
        url.pathname !== "/api/connections" &&
        url.pathname !== "/api/connection-commands"
      ) {
        return undefined;
      }
      if (url.pathname === "/api/connection-commands") {
        if (request.method !== "GET")
          return jsonError(405, "method not allowed");
        const queryFields = [...url.searchParams.keys()];
        const packageId = url.searchParams.get("packageId");
        const commandId = url.searchParams.get("commandId");
        if (
          queryFields.length !== 2 ||
          url.searchParams.getAll("packageId").length !== 1 ||
          url.searchParams.getAll("commandId").length !== 1 ||
          queryFields.some(
            (field) => field !== "packageId" && field !== "commandId",
          ) ||
          !isPublicIdentifier(packageId)
        ) {
          return jsonError(400, "invalid Connection command lookup");
        }
        try {
          const receipt = await host.lookupConnectionCommand(
            context.userId,
            packageId,
            decodeConnectionCommandIdV1(commandId),
          );
          return Response.json(
            receipt === undefined
              ? null
              : decodeConnectionCommandReceiptV1(receipt),
          );
        } catch (error) {
          return jsonError(
            400,
            error instanceof Error
              ? error.message
              : "Connection command lookup failed",
          );
        }
      }
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      try {
        const command = decodeConnectionCommandV1(await request.json());
        return Response.json(
          decodeConnectionCommandReceiptV1(
            await host.executeConnection(context.userId, command),
          ),
        );
      } catch (error) {
        return jsonError(
          400,
          error instanceof Error ? error.message : "Connection command failed",
        );
      }
    },
  };
}

export namespace createSettingsBackendContribution {
  export function plugin(
    host: SettingsGatewayHost,
    lifecycle: { mount(value: SettingsBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createSettingsBackendContribution(host));
  }
}

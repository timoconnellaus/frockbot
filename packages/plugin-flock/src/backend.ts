import type { Plugin } from "cordis";
import {
  BotNotFoundError,
  FLOCK_ID_PATTERN,
  FlockConflictError,
  FlockDecodeError,
  decodeCreateBotCommandV1,
  decodeUpdateSheepCommandV1,
  type BotDirectoryViewV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
  type SheepIdentityViewV1,
  type UpdateSheepCommandV1,
} from "./shared.js";

export interface FlockGatewayHost {
  listBots(userId: string): Promise<BotDirectoryViewV1>;
  createBot(
    userId: string,
    command: CreateBotCommandV1,
  ): Promise<FlockReceiptV1>;
  readSheep(userId: string, botId: string): Promise<SheepIdentityViewV1>;
  updateSheep(
    userId: string,
    botId: string,
    command: UpdateSheepCommandV1,
  ): Promise<FlockReceiptV1>;
}
export interface FlockBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}
function errorResponse(error: unknown): Response {
  if (error instanceof FlockDecodeError)
    return Response.json(
      { error: error.message, code: "invalid-request", definitive: true },
      { status: 400 },
    );
  if (
    error instanceof BotNotFoundError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "BotNotFoundError")
  )
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Bot not found",
        code: "bot-not-found",
        definitive: true,
      },
      { status: 404 },
    );
  if (
    error instanceof FlockConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "FlockConflictError")
  ) {
    const currentRevision =
      typeof error === "object" &&
      error !== null &&
      "currentRevision" in error &&
      typeof error.currentRevision === "number"
        ? error.currentRevision
        : 0;
    return Response.json(
      {
        error: `flock revision is ${currentRevision}`,
        code: "revision-conflict",
        currentRevision,
        definitive: true,
      },
      { status: 409 },
    );
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "Flock request failed" },
    { status: 500 },
  );
}
function decodePathId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new FlockDecodeError("botId is invalid");
  }
  if (!FLOCK_ID_PATTERN.test(decoded))
    throw new FlockDecodeError("botId is invalid");
  return decoded;
}

export function createFlockBackendContribution(
  host: FlockGatewayHost,
): FlockBackendRouteContribution {
  return {
    packageId: "flock",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const sheep = url.pathname.match(/^\/api\/bots\/([^/]+)\/sheep$/);
      if (url.pathname !== "/api/bots" && !sheep) return undefined;
      try {
        if (url.pathname === "/api/bots") {
          if (request.method === "GET")
            return Response.json(await host.listBots(context.userId));
          if (request.method !== "POST")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          return Response.json(
            await host.createBot(
              context.userId,
              decodeCreateBotCommandV1(await request.json()),
            ),
            { status: 201 },
          );
        }
        const botId = decodePathId(sheep![1]!);
        if (request.method === "GET")
          return Response.json(await host.readSheep(context.userId, botId));
        if (request.method !== "POST")
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        const command = decodeUpdateSheepCommandV1(await request.json());
        if (command.botId !== botId)
          throw new FlockDecodeError(
            "sheep command does not match request path",
          );
        return Response.json(
          await host.updateSheep(context.userId, botId, command),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export namespace createFlockBackendContribution {
  export function plugin(
    host: FlockGatewayHost,
    lifecycle: { mount(value: FlockBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createFlockBackendContribution(host));
  }
}

import type { Plugin } from "cordis";
import {
  BotNotFoundError,
  FlockConflictError,
  isFlockIdentifier,
  FlockDecodeError,
  decodeBotLifecycleCommandV1,
  decodeCreateBotCommandV1,
  decodeUpdateSheepCommandV1,
  type BotDirectoryViewV1,
  type BotIdentityDirectoryViewV1,
  type BotLifecycleCommandV1,
  type BotLifecycleDirectoryViewV1,
  type BotLifecycleReceiptV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
  type SheepIdentityViewV1,
  type UpdateSheepCommandV1,
} from "./shared.js";
import {
  decodeBotUnreadCommandV1,
  UnreadDecodeError,
  type BotNotificationDirectoryViewV1,
  type BotUnreadCommandV1,
  type BotUnreadDirectoryViewV1,
  type BotUnreadReceiptV1,
} from "@frockbot/plugin-shell/unread";
import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";

export interface FlockGatewayHost {
  listBots(userId: string): Promise<BotDirectoryViewV1>;
  createBot(
    userId: string,
    command: CreateBotCommandV1,
  ): Promise<FlockReceiptV1>;
  listBotLifecycles(userId: string): Promise<BotLifecycleDirectoryViewV1>;
  executeBotLifecycle(
    userId: string,
    command: BotLifecycleCommandV1,
  ): Promise<BotLifecycleReceiptV1>;
  readSheep(userId: string, botId: string): Promise<SheepIdentityViewV1>;
  updateSheep(
    userId: string,
    botId: string,
    command: UpdateSheepCommandV1,
  ): Promise<FlockReceiptV1>;
  /** The live identity of every registered Bot, read through to its owner. */
  listBotIdentities(userId: string): Promise<BotIdentityDirectoryViewV1>;
  /**
   * Unread state for every non-archived Bot, through the same bounded fan-out
   * the identity directory uses: one round trip for the whole sidebar.
   */
  listBotUnread(userId: string): Promise<BotUnreadDirectoryViewV1>;
  /**
   * Pending notification intents across every non-archived Bot, so a
   * completion on a Bot the User is not looking at still surfaces.
   */
  listBotNotifications(userId: string): Promise<BotNotificationDirectoryViewV1>;
  /** `bot/mark-read` / `bot/mark-unread`, applied by the Bot Durable Object. */
  executeBotUnreadCommand(
    userId: string,
    botId: string,
    command: BotUnreadCommandV1,
  ): Promise<BotUnreadReceiptV1>;
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
  if (
    error instanceof FlockDecodeError ||
    error instanceof UnreadDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error.name === "FlockDecodeError" || error.name === "UnreadDecodeError"))
  )
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Flock request is invalid",
        code: "invalid-request",
        definitive: true,
      },
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
  if (!isFlockIdentifier(decoded))
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
      const unread = url.pathname.match(/^\/api\/bots\/([^/]+)\/unread$/);
      const lifecycle = url.pathname.match(/^\/api\/bots\/([^/]+)\/lifecycle$/);
      if (
        url.pathname !== "/api/bots" &&
        url.pathname !== "/api/bots/lifecycles" &&
        url.pathname !== "/api/bots/identities" &&
        url.pathname !== "/api/bots/unread" &&
        url.pathname !== "/api/bots/notifications" &&
        !sheep &&
        !unread &&
        !lifecycle
      )
        return undefined;
      try {
        if (url.pathname === "/api/bots/identities") {
          if (request.method !== "GET")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          return Response.json(await host.listBotIdentities(context.userId));
        }
        if (url.pathname === "/api/bots/unread") {
          if (request.method !== "GET")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          return Response.json(await host.listBotUnread(context.userId));
        }
        if (url.pathname === "/api/bots/notifications") {
          if (request.method !== "GET")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          return Response.json(await host.listBotNotifications(context.userId));
        }
        if (unread) {
          const botId = decodePathId(unread[1]!);
          if (request.method !== "POST")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          const command = decodeBotUnreadCommandV1(await request.json());
          if (command.botId !== botId)
            throw new FlockDecodeError(
              "unread command does not match request path",
            );
          return Response.json(
            await host.executeBotUnreadCommand(context.userId, botId, command),
          );
        }
        if (url.pathname === "/api/bots/lifecycles") {
          if (request.method !== "GET")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          return Response.json(await host.listBotLifecycles(context.userId));
        }
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
        if (lifecycle) {
          const botId = decodePathId(lifecycle[1]!);
          if (request.method !== "POST")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          const command = decodeBotLifecycleCommandV1(await request.json());
          if (command.botId !== botId)
            throw new FlockDecodeError(
              "lifecycle command does not match request path",
            );
          const receipt = await host.executeBotLifecycle(
            context.userId,
            command,
          );
          return Response.json(receipt, {
            status: receipt.status === "pending" ? 202 : 200,
          });
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

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  FlockGatewayHost,
  FlockBackendRouteContribution
>({
  specifier: "@frockbot/plugin-flock/backend",
  create: createFlockBackendContribution.plugin,
});

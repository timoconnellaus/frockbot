import {
  BotNotFoundError,
  FlockConflictError,
  isFlockIdentifier,
  FlockDecodeError,
  decodeBotLifecycleCommandV1,
  decodeCreateBotCommandV1,
  decodeUpdateAvatarCommandV1,
  decodeUpdateVoiceCommandV1,
  decodeUpdateLookCommandV1,
  type BotDirectoryViewV1,
  type BotIdentityDirectoryViewV1,
  type BotLifecycleCommandV1,
  type BotLifecycleDirectoryViewV1,
  type BotLifecycleReceiptV1,
  type CreateBotCommandV1,
  type FlockBootstrapViewV1,
  type FlockReceiptV1,
  type AvatarIdentityViewV1,
  type UpdateAvatarCommandV1,
  type VoiceIdentityViewV1,
  type UpdateVoiceCommandV1,
  type LookIdentityViewV1,
  type UpdateLookCommandV1,
} from "./shared.js";
import {
  decodeBotUnreadCommandV1,
  UnreadDecodeError,
  type BotNotificationDirectoryViewV1,
  type BotUnreadCommandV1,
  type BotUnreadDirectoryViewV1,
  type BotUnreadReceiptV1,
} from "@frockbot/app/shell/unread";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";

export interface FlockGatewayHost {
  listBots(userId: string): Promise<BotDirectoryViewV1>;
  createBot(
    userId: string,
    command: CreateBotCommandV1,
  ): Promise<FlockReceiptV1>;
  listBotLifecycles(userId: string): Promise<BotLifecycleDirectoryViewV1>;
  /** Which Bot the account was given as General, while it still exists. */
  readFlockBootstrap(userId: string): Promise<FlockBootstrapViewV1>;
  executeBotLifecycle(
    userId: string,
    command: BotLifecycleCommandV1,
  ): Promise<BotLifecycleReceiptV1>;
  readAvatar(userId: string, botId: string): Promise<AvatarIdentityViewV1>;
  updateAvatar(
    userId: string,
    botId: string,
    command: UpdateAvatarCommandV1,
  ): Promise<FlockReceiptV1>;
  readVoice(userId: string, botId: string): Promise<VoiceIdentityViewV1>;
  updateVoice(
    userId: string,
    botId: string,
    command: UpdateVoiceCommandV1,
  ): Promise<FlockReceiptV1>;
  readLook(userId: string, botId: string): Promise<LookIdentityViewV1>;
  updateLook(
    userId: string,
    botId: string,
    command: UpdateLookCommandV1,
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
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AppletImpactConflictError"
  )
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "this Bot's Applets changed since the deletion was confirmed",
        code: "applet-impact-changed",
        definitive: true,
      },
      { status: 409 },
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
      const avatar = url.pathname.match(/^\/api\/bots\/([^/]+)\/avatar$/);
      const voice = url.pathname.match(/^\/api\/bots\/([^/]+)\/voice$/);
      const look = url.pathname.match(/^\/api\/bots\/([^/]+)\/look$/);
      const unread = url.pathname.match(/^\/api\/bots\/([^/]+)\/unread$/);
      const lifecycle = url.pathname.match(/^\/api\/bots\/([^/]+)\/lifecycle$/);
      if (
        url.pathname !== "/api/bots" &&
        url.pathname !== "/api/bots/lifecycles" &&
        url.pathname !== "/api/bots/bootstrap" &&
        url.pathname !== "/api/bots/identities" &&
        url.pathname !== "/api/bots/unread" &&
        url.pathname !== "/api/bots/notifications" &&
        !avatar &&
        !voice &&
        !look &&
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
        if (url.pathname === "/api/bots/bootstrap") {
          if (request.method !== "GET")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          return Response.json(await host.readFlockBootstrap(context.userId));
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
          // A deletion from a person destroys the Applets its confirmation
          // listed, so it must say which list that was (ADR 0027).
          if (command.type === "bot/delete" && !command.appletImpact)
            throw new FlockDecodeError(
              "a Bot deletion must carry the appletImpact its confirmation showed",
            );
          const receipt = await host.executeBotLifecycle(
            context.userId,
            command,
          );
          return Response.json(receipt, {
            status: receipt.status === "pending" ? 202 : 200,
          });
        }
        if (voice) {
          const voiceBotId = decodePathId(voice[1]!);
          if (request.method === "GET")
            return Response.json(
              await host.readVoice(context.userId, voiceBotId),
            );
          if (request.method !== "POST")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          const command = decodeUpdateVoiceCommandV1(await request.json());
          if (command.botId !== voiceBotId)
            throw new FlockDecodeError(
              "voice command does not match request path",
            );
          return Response.json(
            await host.updateVoice(context.userId, voiceBotId, command),
          );
        }
        if (look) {
          const lookBotId = decodePathId(look[1]!);
          if (request.method === "GET")
            return Response.json(
              await host.readLook(context.userId, lookBotId),
            );
          if (request.method !== "POST")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          const command = decodeUpdateLookCommandV1(await request.json());
          if (command.botId !== lookBotId)
            throw new FlockDecodeError(
              "look command does not match request path",
            );
          return Response.json(
            await host.updateLook(context.userId, lookBotId, command),
          );
        }
        const botId = decodePathId(avatar![1]!);
        if (request.method === "GET")
          return Response.json(await host.readAvatar(context.userId, botId));
        if (request.method !== "POST")
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        const command = decodeUpdateAvatarCommandV1(await request.json());
        if (command.botId !== botId)
          throw new FlockDecodeError(
            "avatar command does not match request path",
          );
        return Response.json(
          await host.updateAvatar(context.userId, botId, command),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
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
  specifier: "@frockbot/app/flock/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createFlockBackendContribution(host)),
});

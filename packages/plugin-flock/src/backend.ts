import type { Plugin } from "cordis";
import {
  BotNotFoundError,
  FlockConflictError,
  isFlockIdentifier,
  FlockDecodeError,
  decodeBotLifecycleCommandV1,
  decodeCreateBotCommandV1,
  decodeUpdateSheepCommandV1,
  type BotAvatarUploadReceiptV1,
  type BotDirectoryViewV1,
  type BotIdentityDirectoryViewV1,
  type BotLifecycleCommandV1,
  type BotLifecycleDirectoryViewV1,
  type BotLifecycleReceiptV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
  type SheepIdentityViewV1,
  type UpdateSheepCommandV1,
  type UploadBotAvatarCommandV1,
} from "./shared.js";
import {
  ConfigurationDecodeError,
  decodeUploadBotAvatarCommandV1,
} from "@frockbot/configuration-core";

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
  /** The stored avatar bytes, or `undefined` when the Bot uses its sheep. */
  readBotAvatar(
    userId: string,
    botId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | undefined>;
  /**
   * Writes the avatar bytes as immutable content-addressed durable content and
   * returns the reference. It changes no Bot state: a `bot/set-profile`
   * command carrying the returned reference is the durable write.
   */
  uploadBotAvatar(
    userId: string,
    botId: string,
    command: UploadBotAvatarCommandV1,
  ): Promise<BotAvatarUploadReceiptV1>;
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
    error instanceof ConfigurationDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error.name === "FlockDecodeError" ||
        error.name === "ConfigurationDecodeError"))
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
      const lifecycle = url.pathname.match(/^\/api\/bots\/([^/]+)\/lifecycle$/);
      const avatar = url.pathname.match(/^\/api\/bots\/([^/]+)\/avatar$/);
      if (
        url.pathname !== "/api/bots" &&
        url.pathname !== "/api/bots/lifecycles" &&
        url.pathname !== "/api/bots/identities" &&
        !sheep &&
        !lifecycle &&
        !avatar
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
        if (avatar) {
          const botId = decodePathId(avatar[1]!);
          if (request.method === "GET") {
            const stored = await host.readBotAvatar(context.userId, botId);
            if (!stored)
              return Response.json(
                {
                  error: `Bot "${botId}" has no uploaded avatar`,
                  code: "avatar-not-found",
                  definitive: true,
                },
                { status: 404 },
              );
            return new Response(stored.bytes as unknown as BodyInit, {
              headers: {
                "content-type": stored.contentType,
                // Content-addressed bytes never change under their digest.
                "cache-control": "private, max-age=31536000, immutable",
                "content-security-policy": "default-src 'none'; sandbox",
                "x-content-type-options": "nosniff",
              },
            });
          }
          if (request.method !== "POST")
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          const command = decodeUploadBotAvatarCommandV1(await request.json());
          if (command.botId !== botId)
            throw new FlockDecodeError(
              "avatar command does not match request path",
            );
          return Response.json(
            await host.uploadBotAvatar(context.userId, botId, command),
            { status: 201 },
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

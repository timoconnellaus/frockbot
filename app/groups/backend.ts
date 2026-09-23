// The Group Chats gateway Contribution: the routes a signed-in client uses.
//
// The route owns no state. A command about which groups exist or who is in
// them goes to the User object; everything about one group's thread goes to
// that group's own object, which is addressed by the User and the group
// together, so no request can reach another User's group.

import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";
import {
  GroupChatConflictError,
  GroupChatDecodeError,
  GroupChatNotFoundError,
  decodeGroupChatCommandV1,
  decodeGroupIdV1,
  decodeGroupMessagePageQueryV1,
  decodeGroupPostCommandV1,
  decodeGroupReadCommandV1,
  decodeGroupRetryCommandV1,
  decodeGroupStopCommandV1,
  type GroupChatCommandV1,
  type GroupChatListV1,
  type GroupChatReceiptV1,
  type GroupChatViewV1,
  type GroupMessagePageV1,
  type GroupMessageV1,
  type GroupPostCommandV1,
  type GroupReadCommandV1,
  type GroupRetryCommandV1,
  type GroupStopCommandV1,
} from "./shared.js";

export interface GroupChatGatewayHost {
  listGroupChats(userId: string): Promise<GroupChatListV1>;
  executeGroupChatCommand(
    userId: string,
    command: GroupChatCommandV1,
  ): Promise<GroupChatReceiptV1>;
  readGroupChat(userId: string, groupId: string): Promise<GroupChatViewV1>;
  readGroupMessages(
    userId: string,
    groupId: string,
    query: { before?: number; after?: number; limit: number },
  ): Promise<GroupMessagePageV1>;
  postGroupMessage(
    userId: string,
    groupId: string,
    command: GroupPostCommandV1,
  ): Promise<{ schemaVersion: 1; message: GroupMessageV1 }>;
  markGroupRead(
    userId: string,
    groupId: string,
    command: GroupReadCommandV1,
  ): Promise<{ schemaVersion: 1; readThrough: number }>;
  stopGroupTurns(
    userId: string,
    groupId: string,
    command: GroupStopCommandV1,
  ): Promise<{ schemaVersion: 1; stopped: string[] }>;
  retryGroupTurn(
    userId: string,
    groupId: string,
    command: GroupRetryCommandV1,
  ): Promise<{ schemaVersion: 1 }>;
  openGroupChannel(
    userId: string,
    groupId: string,
    request: Request,
  ): Promise<Response>;
}

export interface GroupChatBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

function named(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof GroupChatDecodeError ||
    named(error, "GroupChatDecodeError") ||
    error instanceof SyntaxError
  ) {
    return Response.json(
      { error: message, code: "invalid-request", definitive: true },
      { status: 400 },
    );
  }
  if (
    error instanceof GroupChatNotFoundError ||
    named(error, "GroupChatNotFoundError")
  ) {
    return Response.json(
      { error: message, code: "group-not-found", definitive: true },
      { status: 404 },
    );
  }
  if (
    error instanceof GroupChatConflictError ||
    named(error, "GroupChatConflictError")
  ) {
    return Response.json(
      { error: message, code: "group-conflict", definitive: true },
      { status: 409 },
    );
  }
  return Response.json(
    { error: message || "Group Chat request failed" },
    { status: 500 },
  );
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}

function pathGroupId(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new GroupChatDecodeError("groupId is invalid");
  }
  return decodeGroupIdV1(decoded);
}

export function createGroupChatBackendContribution(
  host: GroupChatGatewayHost,
): GroupChatBackendRouteContribution {
  return {
    packageId: "groups",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const userId = context.userId;
      if (url.pathname === "/api/groups") {
        try {
          if (request.method === "GET") {
            return Response.json(await host.listGroupChats(userId));
          }
          if (request.method !== "POST") return methodNotAllowed();
          const command = decodeGroupChatCommandV1(await request.json());
          if (command.type !== "group/create") {
            throw new GroupChatDecodeError(
              "a command about one group is sent to that group",
            );
          }
          return Response.json(
            await host.executeGroupChatCommand(userId, command),
          );
        } catch (error) {
          return errorResponse(error);
        }
      }
      const match = url.pathname.match(
        /^\/api\/groups\/([^/]+)(?:\/(commands|messages|read|stop|retry|channel))?$/,
      );
      if (!match) return undefined;
      try {
        const groupId = pathGroupId(match[1]!);
        switch (match[2]) {
          case undefined:
            if (request.method !== "GET") return methodNotAllowed();
            return Response.json(await host.readGroupChat(userId, groupId));
          case "commands": {
            if (request.method !== "POST") return methodNotAllowed();
            const command = decodeGroupChatCommandV1(await request.json());
            if (
              command.type === "group/create" ||
              command.groupId !== groupId
            ) {
              throw new GroupChatDecodeError(
                "command does not match request path",
              );
            }
            return Response.json(
              await host.executeGroupChatCommand(userId, command),
            );
          }
          case "messages":
            if (request.method === "GET") {
              return Response.json(
                await host.readGroupMessages(
                  userId,
                  groupId,
                  decodeGroupMessagePageQueryV1(url),
                ),
              );
            }
            if (request.method !== "POST") return methodNotAllowed();
            return Response.json(
              await host.postGroupMessage(
                userId,
                groupId,
                decodeGroupPostCommandV1(await request.json()),
              ),
            );
          case "read":
            if (request.method !== "POST") return methodNotAllowed();
            return Response.json(
              await host.markGroupRead(
                userId,
                groupId,
                decodeGroupReadCommandV1(await request.json()),
              ),
            );
          case "stop":
            if (request.method !== "POST") return methodNotAllowed();
            return Response.json(
              await host.stopGroupTurns(
                userId,
                groupId,
                decodeGroupStopCommandV1(await request.json()),
              ),
            );
          case "retry":
            if (request.method !== "POST") return methodNotAllowed();
            return Response.json(
              await host.retryGroupTurn(
                userId,
                groupId,
                decodeGroupRetryCommandV1(await request.json()),
              ),
            );
          case "channel":
            if (request.method !== "GET") return methodNotAllowed();
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
              return Response.json(
                { error: "a Group Chat channel is a WebSocket" },
                { status: 426 },
              );
            }
            return await host.openGroupChannel(userId, groupId, request);
        }
        return undefined;
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

/** The manifest's gateway `backend` entry, resolved by specifier. */
export const backendContribution = defineGatewayContribution<
  GroupChatGatewayHost,
  GroupChatBackendRouteContribution
>({
  specifier: "@frockbot/app/groups/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createGroupChatBackendContribution(host)),
});

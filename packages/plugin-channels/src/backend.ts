// The Channels gateway Contribution: the authenticated routes, and one that is
// not authenticated at all.
//
//   GET  /api/bots/:botId/channels                      the sidebar's list
//   GET  /api/bots/:botId/channels/unread               per-Channel unread
//   POST /api/bots/:botId/channels/:platform            connect
//   GET  /api/channels/:channelId                       one thread
//   POST /api/channels/:channelId/read                  the read position
//   POST /api/channels/:channelId/disconnect            disconnect
//   POST /api/plugins/channels/:platform/:token         one delivery
//
// The second is a `publicRoute`: a remote platform has no session with this
// deployment, so it runs before the gateway authenticates anything. Its only
// credential is the signed token it presents, in two places at once — the path
// and the platform's own echo header — and the token is verified here, in
// constant time, *before* a Durable Object is addressed. The gateway is
// stateless and could not otherwise map a Channel to its User without creating
// an object on an anonymous caller's word.
//
// The edge decides nothing else. Whether the Channel exists, still holds this
// key, and is still active are the User Durable Object's to answer, and it
// answers them after this module has proved only that the token was minted
// here. Every refusal on this door is the same 404: a caller learns nothing
// about which Channels exist.
import type { Plugin } from "cordis";
import {
  CHANNEL_WEBHOOK_PATTERN_V1,
  CHANNEL_WEBHOOK_SECRET_HEADERS_V1,
  type ChannelConnectResultV1,
  type ChannelDeliveryOutcomeV1,
} from "./connect.js";
import {
  decodeChannelReadCommandV1,
  type ChannelReadReceiptV1,
  type ChannelUnreadDirectoryViewV1,
} from "./unread.js";
import type {
  ChannelCommandReceiptV1,
  ChannelListViewV1,
  ChannelThreadPageViewV1,
} from "./shared.js";
import {
  CHANNEL_WEBHOOK_BODY_MAX_BYTES,
  ChannelTokenError,
  verifyChannelTokenV1,
} from "./token.js";
import { ChannelDecodeError } from "./records.js";

const CONNECT = /^\/api\/bots\/([^/]+)\/channels\/([a-z0-9-]{1,32})$/;
const CHANNELS = /^\/api\/bots\/([^/]+)\/channels$/;
const CHANNEL_UNREAD = /^\/api\/bots\/([^/]+)\/channels\/unread$/;
const CHANNEL_THREAD = /^\/api\/channels\/([^/]+)$/;
const CHANNEL_READ = /^\/api\/channels\/([^/]+)\/read$/;
const CHANNEL_DISCONNECT = /^\/api\/channels\/([^/]+)\/disconnect$/;
const CHANNEL_POST = /^\/api\/channels\/([^/]+)\/post$/;

/**
 * How the User appears in a room they are watching.
 *
 * A person is not a Bot and not a member: `senderPeer` is the field the record
 * already has for "someone who is not a member said this", and the store
 * already owes such a message to *every* member — which is what the User
 * speaking into a room has to mean, or the Bot they were addressing would be
 * the one member that never heard it.
 */
export const CHANNEL_USER_PEER_V1 = "you";

export interface ChannelsGatewayHost {
  /**
   * The signing secret for this deployment's Channel tokens, or nothing. Absent
   * means the door is closed: a delivery is refused rather than admitted
   * unverified.
   */
  channelTokenSecret(): Promise<string | undefined>;
  /** One delivery, carried to the User the verified token named. */
  deliverChannelWebhook(
    userId: string,
    request: {
      platform: string;
      token: string;
      presentedSecret: string | null;
      body: unknown;
    },
  ): Promise<ChannelDeliveryOutcomeV1>;
  connectChannel(
    userId: string,
    request: {
      botId: string;
      platform: string;
      connectionId: string;
      name: string;
      commandId: string;
      origin: string;
    },
  ): Promise<ChannelConnectResultV1>;
  /** Every Channel one of this User's Bots is a member of. */
  listChannels(userId: string, botId: string): Promise<ChannelListViewV1>;
  /** One Channel: the record, its members, its thread, a Connection's label. */
  readChannelThreadPage(
    userId: string,
    channelId: string,
  ): Promise<ChannelThreadPageViewV1>;
  /** Per-Channel unread for one Bot's rows, in one round trip. */
  listChannelUnread(
    userId: string,
    botId: string,
  ): Promise<ChannelUnreadDirectoryViewV1>;
  /** The User's own read position. Never a side effect of a listing. */
  markChannelRead(
    userId: string,
    command: { commandId: string; channelId: string; upToSeq: number },
  ): Promise<ChannelReadReceiptV1>;
  /**
   * One message from the User into a room they are watching, carried as a
   * peer rather than as one of its Bots. A person's words are the person's.
   */
  postChannelMessage(
    userId: string,
    command: {
      commandId: string;
      channelId: string;
      botId: string;
      text: string;
    },
  ): Promise<ChannelCommandReceiptV1>;
  /**
   * Disconnect one external Channel, as the User rather than as a Bot. It is
   * the same `channel/disconnect` command `channel_manage` applies: the
   * webhook is deleted, the key revoked, and the record and its history kept.
   */
  disconnectChannel(
    userId: string,
    command: { commandId: string; channelId: string; botId: string },
  ): Promise<ChannelCommandReceiptV1>;
}

export interface ChannelsBackendRouteContribution {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ChannelDecodeError("request path is invalid");
  }
}

/**
 * One delivery, from the open internet.
 *
 * The order of the checks is the whole design: bound the body before reading
 * it, verify the token against the deployment secret, and only then address the
 * User the claims name. Nothing an anonymous caller sends decides which object
 * exists.
 */
async function deliver(
  host: ChannelsGatewayHost,
  request: Request,
  match: RegExpExecArray,
): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  const secret = await host.channelTokenSecret();
  if (!secret) return jsonError(503, "Channel delivery is not configured");
  const platform = pathSegment(match[1]!);
  const token = pathSegment(match[2]!);
  let body: string;
  try {
    body = await request.text();
  } catch {
    return jsonError(400, "delivery body could not be read");
  }
  if (new TextEncoder().encode(body).length > CHANNEL_WEBHOOK_BODY_MAX_BYTES) {
    return jsonError(413, "delivery body is too large");
  }
  try {
    const claims = await verifyChannelTokenV1(secret, token);
    const header = CHANNEL_WEBHOOK_SECRET_HEADERS_V1[platform];
    const outcome = await host.deliverChannelWebhook(claims.u, {
      platform,
      token,
      presentedSecret: header ? request.headers.get(header) : null,
      body: body.length === 0 ? undefined : JSON.parse(body),
    });
    if (outcome.status === "refused") {
      return jsonError(404, "Channel webhook is unknown");
    }
    // 200 either way. A delivery this product has no message for is still a
    // delivery the platform must stop retrying.
    return Response.json(
      {
        schemaVersion: 1,
        status: outcome.status,
        ...(outcome.messageId === undefined
          ? {}
          : { messageId: outcome.messageId }),
      },
      { status: 200 },
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ChannelTokenError"
    ) {
      const tokenError = error as ChannelTokenError;
      return jsonError(tokenError.status, tokenError.message);
    }
    if (error instanceof SyntaxError) {
      return jsonError(400, "delivery body is not JSON");
    }
    // A Channel that is gone, a Bot that is not this User's, a body the
    // connector could not read: the door says the same thing to all of them.
    return jsonError(404, "Channel webhook is unknown");
  }
}

/**
 * The WebUI's half of the Channels door: four authenticated routes.
 *
 *   GET  /api/bots/:botId/channels           the sidebar's list
 *   GET  /api/bots/:botId/channels/unread    per-Channel unread, one trip
 *   GET  /api/channels/:channelId            one thread, members and label
 *   POST /api/channels/:channelId/read       the User's read position
 *   POST /api/channels/:channelId/disconnect `channel_manage disconnect`
 *
 * The gateway owns none of this state and proves nothing about it. Every route
 * carries the authenticated User to the User Durable Object, which is the
 * authority for whether the Bot is theirs and whether the Channel exists — so
 * a Channel that is not this User's is a 404 there, never because this module
 * checked.
 *
 * The unread route is matched before the connect route on purpose: `unread` is
 * a legal platform-shaped path segment, and the more specific path wins.
 */
async function readRoute(
  host: ChannelsGatewayHost,
  request: Request,
  url: URL,
  userId: string,
): Promise<Response | undefined> {
  const unread = CHANNEL_UNREAD.exec(url.pathname);
  const channels = CHANNELS.exec(url.pathname);
  const thread = CHANNEL_THREAD.exec(url.pathname);
  const markRead = CHANNEL_READ.exec(url.pathname);
  const disconnect = CHANNEL_DISCONNECT.exec(url.pathname);
  const post = CHANNEL_POST.exec(url.pathname);
  if (!unread && !channels && !thread && !markRead && !disconnect && !post) {
    return undefined;
  }
  try {
    if (unread) {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return Response.json(
        await host.listChannelUnread(userId, pathSegment(unread[1]!)),
      );
    }
    if (channels) {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return Response.json(
        await host.listChannels(userId, pathSegment(channels[1]!)),
      );
    }
    if (thread) {
      if (request.method !== "GET") return jsonError(405, "method not allowed");
      return Response.json(
        await host.readChannelThreadPage(userId, pathSegment(thread[1]!)),
      );
    }
    if (markRead) {
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      const command = decodeChannelReadCommandV1(await request.json());
      if (command.channelId !== pathSegment(markRead[1]!)) {
        return jsonError(400, "read command does not match request path");
      }
      return Response.json(await host.markChannelRead(userId, command));
    }
    if (request.method !== "POST") return jsonError(405, "method not allowed");
    const payload = (await request.json()) as Record<string, unknown>;
    if (post) {
      if (
        typeof payload.commandId !== "string" ||
        typeof payload.botId !== "string" ||
        typeof payload.text !== "string"
      ) {
        return jsonError(400, "post requires a commandId, a botId and text");
      }
      return Response.json(
        await host.postChannelMessage(userId, {
          commandId: payload.commandId,
          botId: payload.botId,
          text: payload.text,
          channelId: pathSegment(post[1]!),
        }),
      );
    }
    if (
      typeof payload.commandId !== "string" ||
      typeof payload.botId !== "string"
    ) {
      // The Bot is not decoration: only a member may disconnect a Channel, and
      // the User Durable Object refuses on the member the command names.
      return jsonError(400, "disconnect requires a commandId and a botId");
    }
    return Response.json(
      await host.disconnectChannel(userId, {
        commandId: payload.commandId,
        botId: payload.botId,
        channelId: pathSegment(disconnect![1]!),
      }),
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error.name === "BotNotFoundError" || error.name === "ChannelNotFound")
    ) {
      return jsonError(404, "Channel not found");
    }
    return jsonError(
      400,
      error instanceof Error ? error.message : "Channel request failed",
    );
  }
}

export function createChannelsBackendContribution(
  host: ChannelsGatewayHost,
): ChannelsBackendRouteContribution {
  const contribution: ChannelsBackendRouteContribution = {
    packageId: "channels",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const read = await readRoute(host, request, url, context.userId);
      if (read) return read;
      const connect = CONNECT.exec(url.pathname);
      if (!connect) return undefined;
      if (request.method !== "POST")
        return jsonError(405, "method not allowed");
      try {
        const payload = (await request.json()) as Record<string, unknown>;
        const connectionId = payload.connectionId;
        const commandId = payload.commandId;
        if (typeof connectionId !== "string" || typeof commandId !== "string") {
          return jsonError(400, "connect requires connectionId and commandId");
        }
        const result = await host.connectChannel(context.userId, {
          botId: pathSegment(connect[1]!),
          platform: pathSegment(connect[2]!),
          connectionId,
          commandId,
          name:
            typeof payload.name === "string" && payload.name.trim().length > 0
              ? payload.name
              : `${pathSegment(connect[2]!)} channel`,
          origin: url.origin,
        });
        return Response.json({
          schemaVersion: 1,
          channel: result.channel,
          // The webhook path carries the token, which is why it is returned
          // once, to the authenticated User who asked for it, and never stored
          // anywhere a later read could reach.
          webhookPath: result.webhookPath,
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "BotNotFoundError"
        ) {
          return jsonError(404, "Bot not found");
        }
        return jsonError(
          400,
          error instanceof Error ? error.message : "connect failed",
        );
      }
    },
  };
  contribution.publicRoute = async (request, url) => {
    const hook = CHANNEL_WEBHOOK_PATTERN_V1.exec(url.pathname);
    return hook ? deliver(host, request, hook) : undefined;
  };
  return contribution;
}

export namespace createChannelsBackendContribution {
  export function plugin(
    host: ChannelsGatewayHost,
    lifecycle: { mount(value: ChannelsBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createChannelsBackendContribution(host));
  }
}

// The external Channel's lifecycle, in one place.
//
// Connect, deliver, reply, disconnect. Every platform does these four things
// and every platform does them differently only at the four points
// `ChannelConnectorV1` names; everything else — the Channel record, the token,
// the message log, the fan-out, the Turn — is the same, so it is here and not
// duplicated once per platform.
//
// This class holds no storage of its own and no credentials. It is constructed
// with the User Durable Object's `ChannelStore`, the connectors the deployment
// carries, and two seams the adapter owns: one that runs a Channel command
// *and fans it out*, and one that opens a Connection's key for a single
// bounded effect. That last one is what keeps the constitution's "no secrets
// client-side" a structural fact: a key is opened inside the User Durable
// Object, handed to a connector for one call, and never returned to a caller,
// a record, a view or a Turn.
import {
  channelTokenDigestV1,
  channelTokenNonceV1,
  mintChannelTokenV1,
  verifyChannelTokenV1,
  channelConstantTimeEqualsV1,
  ChannelTokenError,
  type ChannelTokenClaimsV1,
} from "./token.js";
import type {
  ChannelConnectorRegistryV1,
  ChannelConnectorV1,
  ChannelOutboundReceiptV1,
} from "./connector.js";
import type { ChannelStore } from "./store.js";
import type { ChannelWriterV1 } from "./records.js";
import { ChannelDecodeError } from "./records.js";
import type {
  ChannelCommandReceiptV1,
  ChannelCommandV1,
  ChannelViewV1,
} from "./shared.js";

/** The webhook path one platform's deliveries arrive on. */
export function channelWebhookPathV1(platform: string, token: string): string {
  return `/api/plugins/channels/${platform}/${encodeURIComponent(token)}`;
}

/** The path pattern the gateway matches before it has any identity at all. */
export const CHANNEL_WEBHOOK_PATTERN_V1 =
  /^\/api\/plugins\/channels\/([a-z0-9-]{1,32})\/([^/]{1,2048})$/;

/** The header a platform echoes the token back in, by platform. */
export const CHANNEL_WEBHOOK_SECRET_HEADERS_V1: Readonly<
  Record<string, string>
> = {
  telegram: "x-telegram-bot-api-secret-token",
};

export interface ChannelConnectorHostV1 {
  store: ChannelStore;
  connectors: ChannelConnectorRegistryV1;
  /**
   * Run one Channel command against the durable record *and* discharge the
   * deliveries it produced. The adapter owns fan-out because fan-out addresses
   * Bot Durable Objects, which this Package never names.
   */
  execute(
    command: ChannelCommandV1,
    writer: ChannelWriterV1,
  ): Promise<ChannelCommandReceiptV1>;
  /**
   * Open one Connection's credential for one bounded effect, inside the
   * backend. The plaintext is handed to a connector and is never returned to
   * this class's callers.
   */
  openConnectionKey(input: {
    connectionId: string;
    effectId: string;
  }): Promise<string>;
  /** Which platform a Connection speaks, resolved from the durable projection. */
  resolvePlatform(connectionId: string): Promise<string | undefined>;
  /** The signing secret for this deployment's Channel tokens. */
  tokenSecret(): Promise<string>;
  now?(): Date;
  newNonce?(): string;
}

export interface ChannelConnectRequestV1 {
  userId: string;
  botId: string;
  platform: string;
  connectionId: string;
  name: string;
  /** The absolute origin the platform should deliver to. */
  origin: string;
  /** The command id the connect is idempotent on. */
  commandId: string;
  /** Absent mints one from the Connection, so reconnecting reuses the record. */
  channelId?: string;
}

export interface ChannelConnectResultV1 {
  channel: ChannelViewV1;
  /** The path Telegram was told to deliver on. Carries the token. */
  webhookPath: string;
}

export interface ChannelDeliveryRequestV1 {
  platform: string;
  /** The token from the path. */
  token: string;
  /** The token the platform echoed back in its own header. */
  presentedSecret: string | null;
  body: unknown;
}

export type ChannelDeliveryOutcomeV1 =
  | { status: "accepted" | "ignored"; channelId: string; messageId?: string }
  /**
   * The delivery was not this Channel's to take. Answered rather than thrown
   * wherever the outcome crosses a Durable Object seam: a rejected RPC promise
   * is not something a caller on the other side can hand to a 404.
   */
  | { status: "refused"; reason: string };

/**
 * The Channel id a Connection's external Channel is recorded under.
 *
 * Derived from the Connection, so reconnecting the same bot token reuses the
 * same Channel and its history rather than accumulating one dead thread per
 * connect. "The record and history survive" is the register's rule for
 * disconnect; making the id derived is what makes it also true of reconnect.
 */
export function externalChannelIdV1(
  platform: string,
  connectionId: string,
): string {
  const id = `${platform}-${connectionId}`;
  if (id.length > 128) {
    throw new ChannelDecodeError("external Channel id is too long to record");
  }
  return id;
}

export class ChannelConnectorService {
  readonly #host: ChannelConnectorHostV1;
  readonly #now: () => Date;
  readonly #nonce: () => string;

  constructor(host: ChannelConnectorHostV1) {
    this.#host = host;
    this.#now = host.now ?? (() => new Date());
    this.#nonce = host.newNonce ?? channelTokenNonceV1;
  }

  #connector(platform: string): ChannelConnectorV1 {
    const connector = this.#host.connectors.get(platform);
    if (!connector) {
      throw new ChannelTokenError(404, `no "${platform}" connector is loaded`);
    }
    return connector;
  }

  /**
   * Connect one Bot to one remote platform.
   *
   * The order is the whole design. The Channel record and the key digest are
   * written *before* the platform is told anything: a `setWebhook` that
   * succeeds against a Channel this deployment has not recorded would deliver
   * messages nothing could admit. If the platform then refuses, the Channel is
   * left inactive and the key revoked, so a half-finished connect is a Channel
   * that takes no delivery rather than one that takes deliveries it cannot
   * place.
   */
  async connect(
    request: ChannelConnectRequestV1,
  ): Promise<ChannelConnectResultV1> {
    const connector = this.#connector(request.platform);
    const channelId =
      request.channelId ??
      externalChannelIdV1(request.platform, request.connectionId);
    const created = await this.#host.execute(
      {
        schemaVersion: 1,
        commandId: `${request.commandId}:create`,
        botId: request.botId,
        type: "channel/create",
        channelId,
        name: request.name,
        members: [request.botId],
        kind: "external",
        connectionId: request.connectionId,
      },
      { kind: "user" },
    );
    if (created.status !== "applied") {
      throw new ChannelDecodeError(
        created.status === "refused"
          ? created.reason
          : "connecting a Channel produced an unexpected receipt",
      );
    }
    const keyVersion = created.channel.revision;
    const token = await mintChannelTokenV1(await this.#host.tokenSecret(), {
      u: request.userId,
      c: channelId,
      k: request.connectionId,
      n: this.#nonce(),
      v: keyVersion,
    });
    await this.#host.store.putTokenKey({
      schemaVersion: 1,
      channelId,
      connectionId: request.connectionId,
      keyVersion,
      digest: await channelTokenDigestV1(token),
      createdAt: this.#now().toISOString(),
    });
    const webhookPath = channelWebhookPathV1(request.platform, token);
    try {
      await connector.register({
        apiKey: await this.#host.openConnectionKey({
          connectionId: request.connectionId,
          effectId: `channel-connect:${channelId}:${keyVersion}`,
        }),
        webhookUrl: `${request.origin}${webhookPath}`,
        secretToken: token,
      });
    } catch (error) {
      // The platform said no. Revoke the key it was never told, so the Channel
      // is durably unreachable rather than reachable by a token nobody holds.
      await this.#host.store.revokeTokenKey(channelId);
      throw error;
    }
    return { channel: created.channel, webhookPath };
  }

  /**
   * One delivery from the open internet.
   *
   * Four checks, in this order and for these reasons: the signature, because a
   * token that was not minted here names nothing; the echoed header, because a
   * URL read out of a log is not a credential; the durable digest, because a
   * token that verified may since have been revoked; and the Channel's own
   * `active`, because a disconnected Channel keeps its record and takes no
   * message. Every refusal is the same 404 — a caller learns nothing about
   * which Channels exist.
   */
  async deliver(
    request: ChannelDeliveryRequestV1,
  ): Promise<ChannelDeliveryOutcomeV1> {
    const connector = this.#connector(request.platform);
    const claims = await verifyChannelTokenV1(
      await this.#host.tokenSecret(),
      request.token,
    );
    const header = CHANNEL_WEBHOOK_SECRET_HEADERS_V1[request.platform];
    if (header) {
      if (
        !request.presentedSecret ||
        !channelConstantTimeEqualsV1(request.presentedSecret, request.token)
      ) {
        throw new ChannelTokenError(404, "Channel webhook is unknown");
      }
    }
    if (
      !(await this.#host.store.holdsTokenDigest(
        claims.c,
        await channelTokenDigestV1(request.token),
        claims.v,
      ))
    ) {
      throw new ChannelTokenError(404, "Channel webhook is unknown");
    }
    const channel = await this.#host.store.read(claims.c);
    if (!channel || !channel.active || channel.kind !== "external") {
      throw new ChannelTokenError(404, "Channel webhook is unknown");
    }
    const inbound = connector.decodeInbound(request.body);
    // A delivery this product has no message for is accepted and dropped, which
    // is what every platform's retry policy expects to be told.
    if (!inbound) return { status: "ignored", channelId: channel.channelId };
    const botId = channel.members[0];
    if (!botId) throw new ChannelTokenError(404, "Channel webhook is unknown");
    const receipt = await this.#host.execute(
      {
        schemaVersion: 1,
        // The platform's own message identity, so its redelivery is one message
        // and one Turn rather than two of each.
        commandId: `inbound:${channel.channelId}:${inbound.externalId}`,
        botId,
        type: "channel/post",
        channelId: channel.channelId,
        messageId: inbound.externalId,
        text: inbound.text,
        senderPeer: inbound.peer,
      },
      { kind: "user" },
    );
    if (receipt.status !== "posted") {
      // A refusal — a quota, an inactive Channel — is already durable. The
      // platform is told the delivery was taken so it stops retrying into a
      // wall the record has already recorded.
      return { status: "ignored", channelId: channel.channelId };
    }
    return {
      status: "accepted",
      channelId: channel.channelId,
      messageId: receipt.message.messageId,
    };
  }

  /**
   * Say one thing back to the peer of an external Channel.
   *
   * Recorded first, sent second. The Channel's own log is the thread a later
   * Turn reads as its history, so a reply the platform accepted but the log
   * never saw would leave the Bot repeating itself. A send the platform
   * refuses leaves a recorded message and a returned failure — visible, as the
   * constitution asks, rather than a silence.
   */
  async reply(request: {
    channelId: string;
    botId: string;
    text: string;
    /** The inbound message this is an answer to; makes the reply idempotent. */
    inReplyTo: string;
    /** Which of this Turn's sends this is. */
    ordinal: number;
    hop: number;
  }): Promise<ChannelOutboundReceiptV1> {
    const channel = await this.#host.store.read(request.channelId);
    if (!channel || channel.kind !== "external" || !channel.connectionId) {
      return {
        status: "failed",
        reason: `Channel "${request.channelId}" is not an external Channel`,
      };
    }
    if (!channel.active) {
      return {
        status: "failed",
        reason: `Channel "${request.channelId}" is disconnected`,
      };
    }
    const platform = await this.#host.resolvePlatform(channel.connectionId);
    if (!platform) {
      return {
        status: "failed",
        reason: `Connection "${channel.connectionId}" speaks no known platform`,
      };
    }
    const connector = this.#connector(platform);
    const thread = await this.#host.store.thread(request.channelId);
    const peer = [...thread.messages]
      .reverse()
      .find((message) => message.senderPeer !== undefined)?.senderPeer;
    if (!peer) {
      return {
        status: "failed",
        reason: `Channel "${request.channelId}" has no peer to answer`,
      };
    }
    const messageId = `out-${request.inReplyTo}-${request.ordinal}`;
    // Already said, already sent. The Bot Durable Object's settlement may run
    // twice for one delivered message — an alarm that fires while another is
    // still draining is ordinary — and the recorded message is the durable
    // statement that this reply has already left. Without this the record would
    // stay correct, because the post is idempotent on its command id, while the
    // platform received the same sentence twice.
    if (thread.messages.some((message) => message.messageId === messageId)) {
      return { status: "sent" };
    }
    const receipt = await this.#host.execute(
      {
        schemaVersion: 1,
        commandId: `outbound:${request.channelId}:${messageId}`,
        botId: request.botId,
        type: "channel/post",
        channelId: request.channelId,
        messageId,
        text: request.text,
        hop: request.hop,
      },
      { kind: "user" },
    );
    if (receipt.status !== "posted") {
      return {
        status: "failed",
        reason:
          receipt.status === "refused"
            ? receipt.reason
            : "the reply was not recorded",
      };
    }
    return connector.send({
      apiKey: await this.#host.openConnectionKey({
        connectionId: channel.connectionId,
        effectId: `channel-send:${messageId}`,
      }),
      peer,
      text: request.text,
    });
  }

  /**
   * Disconnect one external Channel.
   *
   * Three things, in the order that is safe to interrupt: the platform is told
   * to stop, the key is revoked, and the Channel is marked inactive. The record
   * and every message in it survive — the register's `disconnect{platform}` is
   * a door being closed, not a history being deleted. A platform that cannot be
   * reached does not stop the disconnect: revoking the key is what actually
   * makes further deliveries impossible.
   */
  async disconnect(request: {
    channelId: string;
    botId: string;
    commandId: string;
  }): Promise<{ channel: ChannelViewV1; platformFailure?: string }> {
    const channel = await this.#host.store.read(request.channelId);
    if (!channel || channel.kind !== "external" || !channel.connectionId) {
      throw new ChannelDecodeError(
        `Channel "${request.channelId}" is not an external Channel`,
      );
    }
    let platformFailure: string | undefined;
    const platform = await this.#host.resolvePlatform(channel.connectionId);
    if (platform && this.#host.connectors.has(platform)) {
      try {
        await this.#connector(platform).unregister({
          apiKey: await this.#host.openConnectionKey({
            connectionId: channel.connectionId,
            effectId: `channel-disconnect:${request.channelId}:${channel.revision}`,
          }),
        });
      } catch (error) {
        platformFailure =
          error instanceof Error
            ? error.message
            : "the platform could not be told to stop";
      }
    }
    await this.#host.store.revokeTokenKey(request.channelId);
    const receipt = await this.#host.execute(
      {
        schemaVersion: 1,
        commandId: request.commandId,
        botId: request.botId,
        type: "channel/disconnect",
        channelId: request.channelId,
      },
      { kind: "user" },
    );
    if (receipt.status !== "applied") {
      throw new ChannelDecodeError(
        receipt.status === "refused"
          ? receipt.reason
          : "disconnecting produced an unexpected receipt",
      );
    }
    return {
      channel: receipt.channel,
      ...(platformFailure === undefined ? {} : { platformFailure }),
    };
  }
}

export type { ChannelTokenClaimsV1 };

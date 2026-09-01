// The external connector seam.
//
// An external Channel is one Bot and one remote peer. Everything that is the
// *same* for every platform — the Channel record, the message log, the token,
// the fan-out, the Turn — lives in `plugin-channels` and in the User Durable
// Object that owns it. What is different for every platform is four things, and
// they are exactly this interface:
//
//   * how you tell the platform where to deliver (`register`/`unregister`),
//   * how you read one delivery (`decodeInbound`),
//   * how you say something back (`send`).
//
// A connector holds no state and no authority. It is handed a plaintext key
// that the User Durable Object opened from a `CredentialLeaseV1` and it is
// handed a `fetch`; it never reads durable storage, never mints a token and
// never decides whether a Channel exists. That is what keeps "no secret leaves
// the backend" a property of the seam rather than of each implementation
// remembering it: a connector cannot leak a key to a Bot because a Bot never
// calls one.
import { ChannelDecodeError } from "./records.js";

/** One inbound message, as a connector reads it off a platform delivery. */
export interface ChannelInboundMessageV1 {
  /**
   * The remote peer, stable across deliveries and namespaced by platform. It is
   * recorded as `senderPeer` on the message and it is the address `send` is
   * later given, so it must be enough to answer with and nothing more.
   */
  peer: string;
  /** How the thread names the peer, when the platform offers a name. */
  peerLabel?: string;
  text: string;
  /**
   * The platform's own identity for this delivery. It becomes the Channel
   * message id, so the same delivery retried by the platform is one message.
   */
  externalId: string;
}

/** What one outbound send did, as the durable record will remember it. */
export type ChannelOutboundReceiptV1 =
  | { status: "sent"; externalId?: string }
  | {
      status: "failed";
      /** Visible failure: the reason is recorded, never swallowed. */
      reason: string;
      /** The platform's own back-off hint, in seconds, when it gave one. */
      retryAfterSeconds?: number;
    };

export interface ChannelConnectorRegistrationV1 {
  apiKey: string;
  /** The absolute URL the platform is told to deliver to. */
  webhookUrl: string;
  /** The same token, echoed back by the platform on every delivery. */
  secretToken: string;
}

export interface ChannelConnectorSendV1 {
  apiKey: string;
  peer: string;
  text: string;
}

/**
 * One platform's half of an external Channel.
 *
 * `platform` is the path segment the webhook door routes on and the suffix the
 * register's `update_state channel disconnect{platform}` names.
 */
export interface ChannelConnectorV1 {
  readonly platform: string;
  /** The Connection Type whose credential this connector is handed. */
  readonly connectionTypeId: string;
  /** The Package that declares that Connection Type. */
  readonly packageId: string;
  register(request: ChannelConnectorRegistrationV1): Promise<void>;
  /**
   * Stop the platform delivering here. A `disconnect` that cannot reach the
   * platform still revokes the token and deactivates the Channel, so this may
   * fail without the disconnect failing.
   */
  unregister(request: { apiKey: string }): Promise<void>;
  /**
   * One delivery, decoded. `undefined` for a delivery that is well-formed but
   * carries nothing this product turns into a message — an edited message, a
   * reaction, a platform housekeeping update. A delivery that is *not*
   * well-formed throws.
   */
  decodeInbound(body: unknown): ChannelInboundMessageV1 | undefined;
  send(request: ChannelConnectorSendV1): Promise<ChannelOutboundReceiptV1>;
}

/** The connectors a deployment holds, by platform. */
export type ChannelConnectorRegistryV1 = ReadonlyMap<
  string,
  ChannelConnectorV1
>;

/** Longest peer address and label a connector may hand back. */
export const CHANNEL_PEER_MAX = 128;
export const CHANNEL_PEER_LABEL_MAX = 100;

export function channelPeerV1(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > CHANNEL_PEER_MAX
  ) {
    throw new ChannelDecodeError(`${label} is invalid`);
  }
  return value.trim();
}

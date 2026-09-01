// Telegram, as a `ChannelConnector`.
//
// Webhook, not polling. Long polling would need a resident loop or an alarm per
// Connection, and the deployment already has a door an unauthenticated caller
// may knock on — the gateway's `publicRoute`. So `connect` tells Telegram where
// to deliver, and Telegram calls us.
//
// Four methods and no state. This module holds no records, mints no tokens,
// reads no storage and knows nothing about Bots. It is handed a plaintext bot
// token that the User Durable Object opened from a `CredentialLeaseV1`, one
// request at a time; the token is never returned, never logged and never
// reaches a Turn. Everything else about an external Channel — the record, the
// log, the fan-out, the Turn — is `plugin-channels`, unchanged.
import {
  channelPeerV1,
  type ChannelConnectorRegistrationV1,
  type ChannelConnectorSendV1,
  type ChannelConnectorV1,
  type ChannelInboundMessageV1,
  type ChannelOutboundReceiptV1,
} from "@frockbot/plugin-channels/connector";
import {
  ChannelDecodeError,
  CHANNEL_TEXT_MAX,
} from "@frockbot/plugin-channels/records";

export const TELEGRAM_PLATFORM_V1 = "telegram";
export const TELEGRAM_PACKAGE_ID_V1 = "telegram";
export const TELEGRAM_CONNECTION_TYPE_V1 = "telegram-bot";

/**
 * The Bot API root. A constant rather than a Connection setting: Telegram has
 * one, and a per-Connection override would be one more place a key could be
 * sent somewhere it was never meant to go. Tests reach it through the outbound
 * seam, which is where a test belongs.
 */
export const TELEGRAM_API_ORIGIN_V1 = "https://api.telegram.org";

/** Telegram truncates a message above this; we refuse rather than surprise. */
export const TELEGRAM_TEXT_MAX_V1 = 4_096;

/** The only updates this connector asks Telegram for. */
const ALLOWED_UPDATES = ["message"] as const;

export class TelegramApiError extends Error {
  override readonly name = "TelegramApiError";
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

interface TelegramResponse {
  ok?: unknown;
  description?: unknown;
  result?: unknown;
  parameters?: { retry_after?: unknown };
}

/**
 * The peer address one Telegram chat is known by.
 *
 * Prefixed and namespaced, because `senderPeer` is recorded beside Bot ids in
 * one thread and the two must never be confusable. A chat id may be negative —
 * a group — so the dash is part of the address rather than a separator.
 */
export function telegramPeerV1(chatId: number): string {
  if (!Number.isSafeInteger(chatId)) {
    throw new ChannelDecodeError("Telegram chat id is invalid");
  }
  return `tg-${chatId}`;
}

/** The chat one peer address names, or `undefined` when it names none. */
export function telegramChatIdV1(peer: string): number | undefined {
  if (!peer.startsWith("tg-")) return undefined;
  const parsed = Number(peer.slice(3));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * The message id one delivery is remembered by.
 *
 * Telegram numbers messages per chat, so the chat is part of the identity. It
 * becomes the Channel message id and therefore the run id, which is what makes
 * Telegram's own redelivery idempotent rather than merely unlikely.
 */
export function telegramMessageIdV1(chatId: number, messageId: number): string {
  return `tg-${chatId}-${messageId}`;
}

function telegramRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One `Update`, decoded.
 *
 * Strict about what it *uses* and forgiving about what it does not. Telegram
 * adds update kinds and message fields continuously, and a decoder that refused
 * every unfamiliar one would turn a Telegram release into an outage. So an
 * update this product has no message for is `undefined` — silently ignored,
 * exactly as Telegram expects — and only an update that claims to be a text
 * message and then is not is an error.
 */
export function decodeTelegramUpdateV1(
  body: unknown,
): ChannelInboundMessageV1 | undefined {
  const update = telegramRecord(body);
  if (!update)
    throw new ChannelDecodeError("Telegram update must be an object");
  if (!Number.isSafeInteger(update.update_id)) {
    throw new ChannelDecodeError("Telegram update has no update_id");
  }
  const message = telegramRecord(update.message);
  // An edit, a reaction, a member change, a channel post: nothing this product
  // turns into a Channel message today.
  if (!message) return undefined;
  const chat = telegramRecord(message.chat);
  if (!chat || !Number.isSafeInteger(chat.id)) {
    throw new ChannelDecodeError("Telegram message names no chat");
  }
  if (!Number.isSafeInteger(message.message_id)) {
    throw new ChannelDecodeError("Telegram message has no message_id");
  }
  // A photo, a sticker, a document. The delivery is well-formed; there is
  // simply no text to carry, and inventing one would be worse than ignoring it.
  if (typeof message.text !== "string") return undefined;
  const text = message.text.trim();
  if (text.length === 0) return undefined;
  const from = telegramRecord(message.from);
  const label =
    typeof from?.username === "string"
      ? `@${from.username}`
      : typeof from?.first_name === "string"
        ? from.first_name
        : undefined;
  const chatId = chat.id as number;
  return {
    peer: channelPeerV1(telegramPeerV1(chatId), "Telegram peer"),
    text: text.slice(0, CHANNEL_TEXT_MAX),
    externalId: telegramMessageIdV1(chatId, message.message_id as number),
    ...(label === undefined ? {} : { peerLabel: label.slice(0, 100) }),
  };
}

async function telegramCall(
  fetchImpl: typeof fetch,
  apiKey: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(
    // The key is in the path because that is the whole of Telegram's Bot API
    // authentication. It is never put in a log line, an error message or a
    // record: what is thrown below carries the status and Telegram's own
    // description, and neither contains the URL.
    `${TELEGRAM_API_ORIGIN_V1}/bot${apiKey}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  let payload: TelegramResponse | undefined;
  try {
    payload = (await response.json()) as TelegramResponse;
  } catch {
    payload = undefined;
  }
  const retryAfter = payload?.parameters?.retry_after;
  if (!response.ok || payload?.ok !== true) {
    throw new TelegramApiError(
      response.status,
      typeof payload?.description === "string"
        ? `Telegram refused ${method}: ${payload.description}`
        : `Telegram refused ${method} with HTTP ${response.status}`,
      Number.isSafeInteger(retryAfter) ? (retryAfter as number) : undefined,
    );
  }
  return payload.result;
}

export interface TelegramConnectorOptions {
  /** The Package's own outbound seam. Absent uses the ambient `fetch`. */
  fetch?: typeof fetch;
}

export function createTelegramConnectorV1(
  options: TelegramConnectorOptions = {},
): ChannelConnectorV1 {
  // Bound: an unbound global `fetch` called through a captured reference is an
  // illegal invocation in workerd.
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  return {
    platform: TELEGRAM_PLATFORM_V1,
    connectionTypeId: TELEGRAM_CONNECTION_TYPE_V1,
    packageId: TELEGRAM_PACKAGE_ID_V1,

    async register(request: ChannelConnectorRegistrationV1): Promise<void> {
      await telegramCall(fetchImpl, request.apiKey, "setWebhook", {
        url: request.webhookUrl,
        // The same token twice: it is the last path segment of `url`, and it is
        // what Telegram must echo in `X-Telegram-Bot-Api-Secret-Token`. A caller
        // who has read the URL out of a log still cannot forge the header.
        secret_token: request.secretToken,
        allowed_updates: [...ALLOWED_UPDATES],
        // A webhook we are replacing has queued deliveries for a Channel that
        // no longer exists; they would each be refused, loudly, for nothing.
        drop_pending_updates: true,
      });
    },

    async unregister(request: { apiKey: string }): Promise<void> {
      await telegramCall(fetchImpl, request.apiKey, "deleteWebhook", {
        drop_pending_updates: true,
      });
    },

    decodeInbound(body: unknown) {
      return decodeTelegramUpdateV1(body);
    },

    async send(
      request: ChannelConnectorSendV1,
    ): Promise<ChannelOutboundReceiptV1> {
      const chatId = telegramChatIdV1(request.peer);
      if (chatId === undefined) {
        return {
          status: "failed",
          reason: `"${request.peer}" is not a Telegram chat`,
        };
      }
      const text = request.text.trim();
      if (text.length === 0) {
        return { status: "failed", reason: "an empty message was not sent" };
      }
      try {
        const result = telegramRecord(
          await telegramCall(fetchImpl, request.apiKey, "sendMessage", {
            chat_id: chatId,
            text: text.slice(0, TELEGRAM_TEXT_MAX_V1),
          }),
        );
        return {
          status: "sent",
          ...(Number.isSafeInteger(result?.message_id)
            ? {
                externalId: telegramMessageIdV1(
                  chatId,
                  result!.message_id as number,
                ),
              }
            : {}),
        };
      } catch (error) {
        // A failure is recorded, never swallowed: a 429 is the ordinary way
        // Telegram says "not now", and the Channel's record has to be able to
        // say that it happened.
        if (error instanceof TelegramApiError) {
          return {
            status: "failed",
            reason: error.message,
            ...(error.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: error.retryAfterSeconds }),
          };
        }
        return {
          status: "failed",
          reason:
            error instanceof Error
              ? `Telegram could not be reached: ${error.message}`
              : "Telegram could not be reached",
        };
      }
    },
  };
}

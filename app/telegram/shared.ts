// Telegram: talking to a Bot from the deployment's own Telegram bot.
//
// One platform bot per deployment, so a person configures nothing: they link
// their Telegram account once from the app with a one-time code, and that chat
// then talks to one of their Bots at a time. What crosses the seams between
// the gateway, the deployment's directory, the User Durable Object and the Bot
// Durable Object is defined here, with the decoders each side holds the other
// to.

import { isPublicIdentifier } from "@frockbot/core/configuration";

/** Every authenticated route lives under this prefix. */
export const TELEGRAM_ROUTE_PREFIX_V1 = "/api/telegram";

/** The one route Telegram itself calls. Public: its credential is a header. */
export const TELEGRAM_WEBHOOK_PATH_V1 = "/api/telegram/webhook";

/** Longest update the webhook reads. A text message is at most 4096 characters. */
export const TELEGRAM_UPDATE_MAX_BYTES_V1 = 64 * 1024;

/** How long a link code works. Long enough to switch apps, no longer. */
export const TELEGRAM_LINK_CODE_TTL_MS_V1 = 10 * 60 * 1000;

/**
 * A Telegram id as the seams carry it. Telegram's ids fit in 52 bits, which a
 * JavaScript number holds, but a string cannot be rounded by anything that
 * handles it on the way — and a private chat's id is the person's own.
 */
const TELEGRAM_ID = /^-?[0-9]{1,20}$/;

/** The code a link is claimed with: 32 base64url characters, 192 bits. */
const LINK_CODE = /^[A-Za-z0-9_-]{32}$/;

/** The deployment's platform bot. Both halves, or Telegram is off. */
export interface TelegramPlatformBotV1 {
  botToken: string;
  /** What `setWebhook` registered and Telegram echoes on every update. */
  webhookSecret: string;
}

/**
 * The platform bot from the Worker's settings, or nothing.
 *
 * The webhook secret is the webhook's whole credential, so a short one is no
 * credential: rather than register it, the deployment has no Telegram. Its
 * alphabet is the one Telegram accepts for `secret_token`.
 */
export function telegramPlatformBotV1(settings: {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}): TelegramPlatformBotV1 | undefined {
  const botToken = settings.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = settings.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!botToken || !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    return undefined;
  }
  if (!webhookSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
    return undefined;
  }
  return { botToken, webhookSecret };
}

export class TelegramDecodeError extends Error {
  override readonly name = "TelegramDecodeError";
}

export function isTelegramIdV1(value: unknown): value is string {
  return typeof value === "string" && TELEGRAM_ID.test(value);
}

export function isTelegramLinkCodeV1(value: unknown): value is string {
  return typeof value === "string" && LINK_CODE.test(value);
}

/**
 * The User's link, held by their User Durable Object: which Telegram account
 * speaks for them, the chat their Bot answers in, and which Bot that is.
 *
 * `botId` is absent when no Bot is chosen — the one chosen was deleted, or the
 * account had none — and the chat is then told how to pick one.
 */
export interface TelegramLinkV1 {
  schemaVersion: 1;
  telegramUserId: string;
  chatId: string;
  /** The @username, when the person has one. Display only. */
  username?: string;
  /** Their Telegram display name. Display only. */
  name?: string;
  linkedAt: string;
  botId?: string;
}

/** A Bot the chat can talk to: an active Bot in the User's directory. */
export interface TelegramBotChoiceV1 {
  botId: string;
  name: string;
}

/** What the Telegram settings surface is drawn from. */
export interface TelegramStatusViewV1 {
  schemaVersion: 1;
  link?: {
    username?: string;
    name?: string;
    linkedAt: string;
    botId?: string;
  };
  bots: TelegramBotChoiceV1[];
}

/** The one time a link code exists: on this receipt, and nowhere durable. */
export interface TelegramLinkOfferV1 {
  schemaVersion: 1;
  code: string;
  /** `https://t.me/<bot>?start=<code>`: opening it sends the code. */
  url: string;
  expiresAt: string;
}

/** One text message from a linked account, as the User object is asked about it. */
export interface TelegramInboundMessageV1 {
  telegramUserId: string;
  chatId: string;
  messageId: string;
  text: string;
}

/** What the User object decided about one inbound message. */
export type TelegramRouteDecisionV1 =
  /** The User holds no link for this account: the directory was stale. */
  | { kind: "not-linked" }
  /** A command, or nothing to talk to: answered in the chat, no Turn. */
  | { kind: "reply"; text: string }
  /** An ordinary message for this Bot. */
  | { kind: "admit"; botId: string };

/** How one mirrored message went, as the Bot's outbox drain acts on it. */
export type TelegramMirrorOutcomeV1 =
  | { status: "sent" | "skipped" | "failed" | "uncertain" }
  /** Telegram asked to be left alone until then; the entry stays. */
  | { status: "retry"; retryAt: string };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TelegramDecodeError(`${label}.${key} is not allowed`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TelegramDecodeError(`${label}.${key} is required`);
    }
  }
}

function text(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new TelegramDecodeError(`${label} must be a bounded string`);
  }
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TelegramDecodeError(`${label} must be an instant`);
  }
  return value;
}

function telegramId(value: unknown, label: string): string {
  if (!isTelegramIdV1(value)) {
    throw new TelegramDecodeError(`${label} must be a Telegram id`);
  }
  return value;
}

function botId(value: unknown, label: string): string {
  if (!isPublicIdentifier(value)) {
    throw new TelegramDecodeError(`${label} must be a Bot id`);
  }
  return value;
}

export function decodeTelegramLinkV1(value: unknown): TelegramLinkV1 {
  const candidate = record(value, "Telegram link");
  exactKeys(
    candidate,
    ["schemaVersion", "telegramUserId", "chatId", "linkedAt"],
    ["username", "name", "botId"],
    "Telegram link",
  );
  if (candidate.schemaVersion !== 1) {
    throw new TelegramDecodeError("Telegram link schemaVersion is unsupported");
  }
  return {
    schemaVersion: 1,
    telegramUserId: telegramId(
      candidate.telegramUserId,
      "Telegram link.telegramUserId",
    ),
    chatId: telegramId(candidate.chatId, "Telegram link.chatId"),
    ...(candidate.username === undefined
      ? {}
      : { username: text(candidate.username, 64, "Telegram link.username") }),
    ...(candidate.name === undefined
      ? {}
      : { name: text(candidate.name, 200, "Telegram link.name") }),
    linkedAt: instant(candidate.linkedAt, "Telegram link.linkedAt"),
    ...(candidate.botId === undefined
      ? {}
      : { botId: botId(candidate.botId, "Telegram link.botId") }),
  };
}

/** The account half of a link, as the webhook read it off the `/start` update. */
export interface TelegramAccountV1 {
  telegramUserId: string;
  chatId: string;
  username?: string;
  name?: string;
}

export function decodeTelegramAccountV1(value: unknown): TelegramAccountV1 {
  const candidate = record(value, "Telegram account");
  exactKeys(
    candidate,
    ["telegramUserId", "chatId"],
    ["username", "name"],
    "Telegram account",
  );
  return {
    telegramUserId: telegramId(
      candidate.telegramUserId,
      "Telegram account.telegramUserId",
    ),
    chatId: telegramId(candidate.chatId, "Telegram account.chatId"),
    ...(candidate.username === undefined
      ? {}
      : {
          username: text(candidate.username, 64, "Telegram account.username"),
        }),
    ...(candidate.name === undefined
      ? {}
      : { name: text(candidate.name, 200, "Telegram account.name") }),
  };
}

export function decodeTelegramInboundMessageV1(
  value: unknown,
): TelegramInboundMessageV1 {
  const candidate = record(value, "Telegram message");
  exactKeys(
    candidate,
    ["telegramUserId", "chatId", "messageId", "text"],
    [],
    "Telegram message",
  );
  if (
    typeof candidate.messageId !== "string" ||
    !/^[0-9]{1,20}$/.test(candidate.messageId)
  ) {
    throw new TelegramDecodeError("Telegram message.messageId is invalid");
  }
  return {
    telegramUserId: telegramId(
      candidate.telegramUserId,
      "Telegram message.telegramUserId",
    ),
    chatId: telegramId(candidate.chatId, "Telegram message.chatId"),
    messageId: candidate.messageId,
    text: text(candidate.text, 4096, "Telegram message.text"),
  };
}

export function decodeTelegramStatusViewV1(
  value: unknown,
): TelegramStatusViewV1 {
  const candidate = record(value, "Telegram status");
  exactKeys(candidate, ["schemaVersion", "bots"], ["link"], "Telegram status");
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.bots)) {
    throw new TelegramDecodeError("Telegram status is invalid");
  }
  let link: TelegramStatusViewV1["link"];
  if (candidate.link !== undefined) {
    const held = record(candidate.link, "Telegram status.link");
    exactKeys(
      held,
      ["linkedAt"],
      ["username", "name", "botId"],
      "Telegram status.link",
    );
    link = {
      ...(held.username === undefined
        ? {}
        : { username: text(held.username, 64, "Telegram status.username") }),
      ...(held.name === undefined
        ? {}
        : { name: text(held.name, 200, "Telegram status.name") }),
      linkedAt: instant(held.linkedAt, "Telegram status.linkedAt"),
      ...(held.botId === undefined
        ? {}
        : { botId: botId(held.botId, "Telegram status.botId") }),
    };
  }
  return {
    schemaVersion: 1,
    ...(link ? { link } : {}),
    bots: candidate.bots.slice(0, 256).map((entry, index) => {
      const bot = record(entry, `Telegram status.bots[${index}]`);
      exactKeys(bot, ["botId", "name"], [], `Telegram status.bots[${index}]`);
      return {
        botId: botId(bot.botId, `Telegram status.bots[${index}].botId`),
        name: text(bot.name, 200, `Telegram status.bots[${index}].name`),
      };
    }),
  };
}

export function decodeTelegramRouteDecisionV1(
  value: unknown,
): TelegramRouteDecisionV1 {
  const candidate = record(value, "Telegram decision");
  if (candidate.kind === "not-linked") {
    exactKeys(candidate, ["kind"], [], "Telegram decision");
    return { kind: "not-linked" };
  }
  if (candidate.kind === "reply") {
    exactKeys(candidate, ["kind", "text"], [], "Telegram decision");
    return { kind: "reply", text: text(candidate.text, 4096, "reply.text") };
  }
  if (candidate.kind === "admit") {
    exactKeys(candidate, ["kind", "botId"], [], "Telegram decision");
    return { kind: "admit", botId: botId(candidate.botId, "admit.botId") };
  }
  throw new TelegramDecodeError("Telegram decision kind is unknown");
}

export function decodeTelegramMirrorOutcomeV1(
  value: unknown,
): TelegramMirrorOutcomeV1 {
  const candidate = record(value, "Telegram mirror outcome");
  if (candidate.status === "retry") {
    exactKeys(candidate, ["status", "retryAt"], [], "Telegram mirror outcome");
    return {
      status: "retry",
      retryAt: instant(candidate.retryAt, "Telegram mirror outcome.retryAt"),
    };
  }
  exactKeys(candidate, ["status"], [], "Telegram mirror outcome");
  if (
    candidate.status !== "sent" &&
    candidate.status !== "skipped" &&
    candidate.status !== "failed" &&
    candidate.status !== "uncertain"
  ) {
    throw new TelegramDecodeError("Telegram mirror outcome is unknown");
  }
  return { status: candidate.status };
}

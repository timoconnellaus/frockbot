// The Telegram gateway Contribution: four authenticated routes and one door
// the open internet reaches.
//
//   GET  /api/telegram           the link and the Bot it talks to (`?as=document`)
//   POST /api/telegram/link      mint a one-time link code
//   POST /api/telegram/bot       choose which Bot the chat talks to
//   POST /api/telegram/unlink    forget the link
//
//   POST /api/telegram/webhook   one update from Telegram
//
// The webhook is a `publicRoute`: Telegram has no session. Its credential is
// the secret the deployment registered with `setWebhook`, which Telegram
// echoes in `X-Telegram-Bot-Api-Secret-Token` on every call. It is compared in
// constant time before the body is read, and a request that fails it never
// addresses any Durable Object. Only then does the deployment directory say
// which User the sender's account speaks for, and only that User's object is
// asked what the message is. A message for a Bot is admitted into that Bot's
// conversation durably — the Bot Durable Object has recorded the Turn — before
// the webhook answers 200; anything short of that is a 500, and Telegram
// delivers the update again. The run id is derived from the chat and the
// message, so a redelivery is the same Turn.

import {
  base64urlEncodeV1,
  constantTimeEqualsV1,
  sha256HexTextV1,
} from "@frockbot/core/crypto";
import { botTurnRefusalCodeV1 } from "@frockbot/core/durable";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";
import {
  telegramApiV1,
  telegramWebhookReplyV1,
  telegramWebhookTypingV1,
} from "./api.js";
import type { TelegramClaimV1 } from "./directory.js";
import {
  TELEGRAM_LINK_CODE_TTL_MS_V1,
  TELEGRAM_ROUTE_PREFIX_V1,
  TELEGRAM_UPDATE_MAX_BYTES_V1,
  TELEGRAM_WEBHOOK_PATH_V1,
  TelegramDecodeError,
  type TelegramAccountV1,
  type TelegramInboundMessageV1,
  type TelegramLinkOfferV1,
  type TelegramRouteDecisionV1,
  type TelegramStatusViewV1,
} from "./shared.js";
import {
  TELEGRAM_BOT_FIELD_V1,
  telegramDocumentV1,
} from "./telegram-document.js";
import { decodeTelegramUpdateV1, parseTelegramCommandV1 } from "./update.js";
import {
  TELEGRAM_CODE_INVALID_TEXT_V1,
  TELEGRAM_NOT_LINKED_TEXT_V1,
  TELEGRAM_UNSUPPORTED_TEXT_V1,
} from "./user.js";

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

export interface TelegramGatewayHostV1 {
  /** Absent: this deployment has no Telegram bot, and the surface says so. */
  telegram?: TelegramPlatformBotV1;
  /** Outbound to Telegram. The Worker's own `fetch` unless a test says otherwise. */
  telegramFetch?: typeof fetch;
  offerTelegramLink(
    userId: string,
    offer: { codeDigest: string; expiresAt: string },
  ): Promise<void>;
  claimTelegramLink(claim: {
    codeDigest: string;
    telegramUserId: string;
    now: number;
  }): Promise<TelegramClaimV1>;
  resolveTelegramAccount(telegramUserId: string): Promise<string | undefined>;
  releaseTelegramAccount(userId: string, telegramUserId: string): Promise<void>;
  readTelegram(userId: string): Promise<TelegramStatusViewV1>;
  completeTelegramLink(
    userId: string,
    account: TelegramAccountV1,
    now: string,
  ): Promise<{ botName?: string; previousTelegramUserId?: string }>;
  dropTelegramLink(
    userId: string,
    telegramUserId: string,
    claimedAt: string,
  ): Promise<void>;
  unlinkTelegram(userId: string): Promise<{ telegramUserId?: string }>;
  selectTelegramBot(
    userId: string,
    botId: string,
  ): Promise<{ status: "applied" } | { status: "rejected"; reason: string }>;
  routeTelegramMessage(
    userId: string,
    message: TelegramInboundMessageV1,
  ): Promise<TelegramRouteDecisionV1>;
  admitTelegramTurn(
    userId: string,
    botId: string,
    command: { runId: string; text: string; messageId: string },
  ): Promise<void>;
  /**
   * Why this account may not use the product right now, or nothing. The same
   * admission every other external door asks, because a message from
   * Telegram spends the account's model budget like any other Turn.
   */
  telegramAccountRefusal(userId: string): Promise<string | undefined>;
}

export interface TelegramBackendRouteContribution {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client?: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const ACCOUNT_UNAVAILABLE_TEXT =
  "This FrockBot account can’t be used right now.";
const BUSY_TEXT =
  "Your Bot has too many messages waiting. Try again in a moment.";
const BOT_GONE_TEXT =
  "The Bot this chat talks to isn’t available any more. Send /bots to pick another.";
const BOT_GONE_ERRORS = new Set([
  "BotNotFoundError",
  "BotArchivedError",
  "BotDeletedError",
]);

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** Telegram is told the update is handled. It sends nothing more. */
function handled(): Response {
  return new Response(null, { status: 200 });
}

function linkedText(botName: string | undefined): string {
  return botName
    ? `Linked to FrockBot. You’re talking to ${botName}. Send /bots to see your Bots, or /bot and a name to switch.`
    : "Linked to FrockBot. You have no Bots yet — create one in FrockBot, then send /bots here.";
}

/** The run a message becomes: one per chat and message, whoever redelivers it. */
export async function telegramRunIdV1(
  chatId: string,
  messageId: string,
): Promise<string> {
  return `tg-${await sha256HexTextV1(`telegram\u0000${chatId}\u0000${messageId}`)}`;
}

/** A fresh link code: 24 random bytes, 32 base64url characters. */
export function mintTelegramLinkCodeV1(): string {
  return base64urlEncodeV1(crypto.getRandomValues(new Uint8Array(24)));
}

/**
 * The bot's @username, once per isolate per origin — asked of Telegram on the
 * first link offer, together with pointing its webhook here. Both are
 * idempotent, so a cold isolate repeating them costs a round trip and nothing
 * else; a failure is not remembered, so the next offer tries again.
 */
const readiness = new Map<string, Promise<string>>();

function readyBot(
  telegram: TelegramPlatformBotV1,
  request: typeof fetch | undefined,
  origin: string,
): Promise<string> {
  // A deployment has one bot, and a new token is a new deploy and a new
  // isolate, so the origin is the whole key.
  const key = origin;
  let ready = readiness.get(key);
  if (!ready) {
    const api = telegramApiV1(telegram.botToken, request);
    ready = (async () => {
      await api.setWebhook(
        `${origin}${TELEGRAM_WEBHOOK_PATH_V1}`,
        telegram.webhookSecret,
      );
      return api.username();
    })();
    readiness.set(key, ready);
    ready.catch(() => readiness.delete(key));
  }
  return ready;
}

async function onStart(
  host: TelegramGatewayHostV1,
  account: TelegramAccountV1,
  code: string,
): Promise<Response> {
  const now = Date.now();
  const claimedAt = new Date(now).toISOString();
  const claim = await host.claimTelegramLink({
    codeDigest: await sha256HexTextV1(code),
    telegramUserId: account.telegramUserId,
    now,
  });
  if (claim.status === "invalid") {
    return telegramWebhookReplyV1(
      account.chatId,
      TELEGRAM_CODE_INVALID_TEXT_V1,
    );
  }
  // The account moves: the User it spoke for stops mirroring to this chat
  // before the new link exists. A failure here is a 500, and Telegram's
  // redelivery of this `/start` claims the same code again and retries it.
  if (claim.previousUserId) {
    await host.dropTelegramLink(
      claim.previousUserId,
      account.telegramUserId,
      claimedAt,
    );
  }
  const linked = await host.completeTelegramLink(
    claim.userId,
    account,
    claimedAt,
  );
  if (
    linked.previousTelegramUserId &&
    linked.previousTelegramUserId !== account.telegramUserId
  ) {
    // The User linked a different account before; the directory forgets it.
    await host.releaseTelegramAccount(
      claim.userId,
      linked.previousTelegramUserId,
    );
  }
  return telegramWebhookReplyV1(account.chatId, linkedText(linked.botName));
}

async function onUpdate(
  host: TelegramGatewayHostV1,
  body: string,
): Promise<Response> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return handled();
  }
  const update = decodeTelegramUpdateV1(value);
  if (update.kind === "ignored") return handled();
  if (update.kind === "unsupported") {
    return telegramWebhookReplyV1(update.chatId, TELEGRAM_UNSUPPORTED_TEXT_V1);
  }
  const { account, messageId, text } = update;
  const command = parseTelegramCommandV1(text);
  if (command?.name === "start" && command.code) {
    return onStart(host, account, command.code);
  }
  const userId = await host.resolveTelegramAccount(account.telegramUserId);
  if (!userId) {
    return telegramWebhookReplyV1(account.chatId, TELEGRAM_NOT_LINKED_TEXT_V1);
  }
  const refusal = await host.telegramAccountRefusal(userId);
  if (refusal) {
    return telegramWebhookReplyV1(account.chatId, ACCOUNT_UNAVAILABLE_TEXT);
  }
  const decision = await host.routeTelegramMessage(userId, {
    telegramUserId: account.telegramUserId,
    chatId: account.chatId,
    messageId,
    text,
  });
  if (decision.kind === "not-linked") {
    // The User unlinked, and the directory entry outlived it. Forgetting it
    // here is what an unlink that could not reach the directory left owed.
    await host
      .releaseTelegramAccount(userId, account.telegramUserId)
      .catch(() => undefined);
    return telegramWebhookReplyV1(account.chatId, TELEGRAM_NOT_LINKED_TEXT_V1);
  }
  if (decision.kind === "reply") {
    return telegramWebhookReplyV1(account.chatId, decision.text);
  }
  try {
    await host.admitTelegramTurn(userId, decision.botId, {
      runId: await telegramRunIdV1(account.chatId, messageId),
      text,
      messageId,
    });
  } catch (error) {
    const refused = botTurnRefusalCodeV1(error);
    // A full queue is an answer for the person, not a failure to deliver: a
    // redelivery would meet the same queue.
    if (refused === "busy") {
      return telegramWebhookReplyV1(account.chatId, BUSY_TEXT);
    }
    // Already admitted, or fenced by a Stop: the message is where it belongs.
    if (refused) return handled();
    // Archived or deleted between the User object's answer and this call.
    // Every redelivery would meet the same Bot, so the person is told instead.
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      BOT_GONE_ERRORS.has(String(error.name))
    ) {
      return telegramWebhookReplyV1(account.chatId, BOT_GONE_TEXT);
    }
    throw error;
  }
  return telegramWebhookTypingV1(account.chatId);
}

async function webhook(
  host: TelegramGatewayHostV1,
  request: Request,
): Promise<Response> {
  const telegram = host.telegram;
  if (!telegram) return jsonError(404, "not found");
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  const presented =
    request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!constantTimeEqualsV1(presented, telegram.webhookSecret)) {
    return jsonError(401, "webhook secret is invalid");
  }
  let body: string;
  try {
    body = await request.text();
  } catch {
    return handled();
  }
  // Nothing a person can type is this long. Answered, so Telegram does not
  // keep delivering what will never be read.
  if (
    new TextEncoder().encode(body).byteLength > TELEGRAM_UPDATE_MAX_BYTES_V1
  ) {
    return handled();
  }
  try {
    return await onUpdate(host, body);
  } catch (error) {
    // The update is not admitted, so it is not acknowledged: Telegram delivers
    // it again. The reason goes to the log and never to the caller.
    console.error(
      JSON.stringify({
        event: "telegram-update-failed",
        error: error instanceof Error ? error.name : "unknown",
        message: error instanceof Error ? error.message.slice(0, 300) : "",
      }),
    );
    return jsonError(500, "update could not be handled");
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new TelegramDecodeError("request body is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TelegramDecodeError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

export function createTelegramBackendContribution(
  host: TelegramGatewayHostV1,
): TelegramBackendRouteContribution {
  return {
    packageId: "telegram",
    async publicRoute(request, url) {
      if (url.pathname !== TELEGRAM_WEBHOOK_PATH_V1) return undefined;
      return webhook(host, request);
    },
    async route(request, url, context) {
      const userId = context.userId;
      if (!userId) return undefined;
      const path = url.pathname;
      if (
        path !== TELEGRAM_ROUTE_PREFIX_V1 &&
        !path.startsWith(`${TELEGRAM_ROUTE_PREFIX_V1}/`)
      ) {
        return undefined;
      }
      try {
        if (path === TELEGRAM_ROUTE_PREFIX_V1) {
          if (request.method !== "GET") {
            return jsonError(405, "method not allowed");
          }
          const view = await host.readTelegram(userId);
          const available = host.telegram !== undefined;
          return Response.json(
            url.searchParams.get("as") === "document"
              ? telegramDocumentV1(view, { available })
              : { ...view, available },
          );
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        if (path === `${TELEGRAM_ROUTE_PREFIX_V1}/link`) {
          const telegram = host.telegram;
          if (!telegram) {
            return jsonError(503, "Telegram isn’t set up on this deployment.");
          }
          let username: string;
          try {
            username = await readyBot(telegram, host.telegramFetch, url.origin);
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "telegram-bot-unready",
                message:
                  error instanceof Error ? error.message.slice(0, 300) : "",
              }),
            );
            return jsonError(
              502,
              "Telegram couldn’t be reached. Try again in a moment.",
            );
          }
          const code = mintTelegramLinkCodeV1();
          const expiresAt = new Date(
            Date.now() + TELEGRAM_LINK_CODE_TTL_MS_V1,
          ).toISOString();
          await host.offerTelegramLink(userId, {
            codeDigest: await sha256HexTextV1(code),
            expiresAt,
          });
          return Response.json({
            schemaVersion: 1,
            code,
            url: `https://t.me/${encodeURIComponent(username)}?start=${code}`,
            expiresAt,
          } satisfies TelegramLinkOfferV1);
        }
        if (path === `${TELEGRAM_ROUTE_PREFIX_V1}/unlink`) {
          const previous = await host.unlinkTelegram(userId);
          if (previous.telegramUserId) {
            // Best effort: a directory entry that outlives the link is refused
            // by the User's object and forgotten on the account's next message.
            await host
              .releaseTelegramAccount(userId, previous.telegramUserId)
              .catch(() => undefined);
          }
          return Response.json({ schemaVersion: 1, status: "unlinked" });
        }
        if (path === `${TELEGRAM_ROUTE_PREFIX_V1}/bot`) {
          const body = await readJson(request);
          const botId = body.botId ?? body[TELEGRAM_BOT_FIELD_V1];
          if (typeof botId !== "string" || botId.length === 0) {
            throw new TelegramDecodeError("botId is required");
          }
          const outcome = await host.selectTelegramBot(userId, botId);
          if (outcome.status === "rejected") {
            return jsonError(409, outcome.reason);
          }
          return Response.json({ schemaVersion: 1, status: "applied" });
        }
        return jsonError(404, "not found");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "TelegramDecodeError"
        ) {
          return jsonError(
            400,
            error instanceof Error ? error.message : "request is invalid",
          );
        }
        console.error("Telegram request failed", error);
        return jsonError(500, "Telegram request failed");
      }
    },
  };
}

/**
 * The gateway `backend` entry, resolved by specifier from the application's
 * Contribution table.
 */
export const backendContribution = defineGatewayContribution<
  TelegramGatewayHostV1,
  TelegramBackendRouteContribution
>({
  specifier: "@frockbot/app/telegram/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createTelegramBackendContribution(host)),
});

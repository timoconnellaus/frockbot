// One Telegram `Update`, read as the webhook needs it, and the handful of
// commands the chat understands.
//
// Only a text message in a private chat with a person is something a Bot is
// asked about. Everything else Telegram can send — an edit, a channel post, a
// group the bot was added to, a message from another bot — is acknowledged and
// dropped, because answering it would be answering someone who is not the
// linked person talking to their Bot.

import {
  isTelegramIdV1,
  isTelegramLinkCodeV1,
  type TelegramAccountV1,
} from "./shared.js";

export type TelegramUpdateV1 =
  /** Nothing to do, and nobody to tell. */
  | { kind: "ignored"; reason: string }
  /** A private message that is not text: the person is told what is read. */
  | { kind: "unsupported"; chatId: string }
  | {
      kind: "message";
      account: TelegramAccountV1;
      messageId: string;
      text: string;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A Telegram integer id, as the string every seam carries. */
function idOf(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  const id = String(value);
  return isTelegramIdV1(id) ? id : undefined;
}

function displayName(from: Record<string, unknown>): string | undefined {
  const name = [from.first_name, from.last_name]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .trim();
  return name.length > 0 ? name.slice(0, 200) : undefined;
}

export function decodeTelegramUpdateV1(value: unknown): TelegramUpdateV1 {
  const update = record(value);
  if (!update) return { kind: "ignored", reason: "not an update" };
  const message = record(update.message);
  if (!message) return { kind: "ignored", reason: "not a new message" };
  const chat = record(message.chat);
  const from = record(message.from);
  const chatId = idOf(chat?.id);
  const telegramUserId = idOf(from?.id);
  if (!chat || !from || !chatId || !telegramUserId) {
    return { kind: "ignored", reason: "message names no chat or sender" };
  }
  if (chat.type !== "private" || chatId !== telegramUserId) {
    return { kind: "ignored", reason: "not a private chat" };
  }
  if (from.is_bot === true) {
    return { kind: "ignored", reason: "sent by a bot" };
  }
  const messageId = idOf(message.message_id);
  if (!messageId || messageId.startsWith("-")) {
    return { kind: "ignored", reason: "message has no id" };
  }
  if (typeof message.text !== "string" || message.text.trim().length === 0) {
    return { kind: "unsupported", chatId };
  }
  const username =
    typeof from.username === "string" &&
    /^[A-Za-z0-9_]{1,64}$/.test(from.username)
      ? from.username
      : undefined;
  const name = displayName(from);
  return {
    kind: "message",
    account: {
      telegramUserId,
      chatId,
      ...(username ? { username } : {}),
      ...(name ? { name } : {}),
    },
    messageId,
    // Telegram caps a message at 4096 characters; this is the same bound, so a
    // client that sent more cannot make the Turn input larger than it says.
    text: message.text.slice(0, 4096),
  };
}

export type TelegramCommandV1 =
  /** `/start`, and the link code the app's deep link carries. */
  | { name: "start"; code?: string }
  /** Which Bots the chat can talk to, and which one it does. */
  | { name: "bots" }
  /** Talk to another Bot: its number in `/bots`, or its name. */
  | { name: "bot"; argument: string }
  | { name: "help" };

/**
 * The command a message is, or nothing when it is something to say.
 *
 * A slash that names no command here is still something the person said, and
 * goes to the Bot like any other message: `/weather` is theirs to mean.
 */
export function parseTelegramCommandV1(
  text: string,
): TelegramCommandV1 | undefined {
  const match = /^\/([A-Za-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return undefined;
  const name = match[1]!.toLowerCase();
  const argument = (match[2] ?? "").trim();
  if (name === "start") {
    return isTelegramLinkCodeV1(argument)
      ? { name: "start", code: argument }
      : { name: "start" };
  }
  if (name === "bots") return { name: "bots" };
  if (name === "bot") {
    return argument.length > 0 ? { name: "bot", argument } : { name: "bots" };
  }
  if (name === "help") return { name: "help" };
  return undefined;
}

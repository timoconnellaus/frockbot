// The few Bot API calls the deployment makes, and how each answer is read.
//
// The bot token is in the URL of every call — that is how Telegram
// authenticates one — so nothing here puts a URL, a request or a raw error in
// a message that could reach a log. A failure is described by its status and
// Telegram's own description, never by what was sent.

import { withDeadlineV1 } from "@frockbot/core/deadline";

const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const CALL_TIMEOUT_MS = 10_000;

/** A retry Telegram asked for without saying when. */
const DEFAULT_RETRY_AFTER_S = 30;

/**
 * What one `sendMessage` did.
 *
 * `uncertain` is the answer the at-most-once record exists for: the request may
 * have reached Telegram — a dropped connection, a timeout, a server error —
 * and sending it again could show the person the same message twice. It is
 * recorded and not repeated.
 */
export type TelegramSendResultV1 =
  | { status: "sent" }
  /** Telegram refused it; nothing was shown. `description` is Telegram's. */
  | { status: "rejected"; description: string }
  /** Too many requests. Nothing was shown; try again after `retryAfterMs`. */
  | { status: "retry"; retryAfterMs: number }
  | { status: "uncertain" };

export class TelegramApiError extends Error {
  override readonly name = "TelegramApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface TelegramAnswer {
  ok?: unknown;
  result?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

async function readAnswer(response: Response): Promise<TelegramAnswer> {
  try {
    const value = (await response.json()) as unknown;
    return value && typeof value === "object" ? (value as TelegramAnswer) : {};
  } catch {
    return {};
  }
}

export interface TelegramApiV1 {
  sendMessage(chatId: string, text: string): Promise<TelegramSendResultV1>;
  /** The bot's own @username, which the app's deep link names. */
  username(): Promise<string>;
  /** Points Telegram at this deployment's webhook, with the secret it echoes. */
  setWebhook(url: string, secretToken: string): Promise<void>;
}

export function telegramApiV1(
  token: string,
  request: typeof fetch = fetch,
): TelegramApiV1 {
  async function call(method: string, body: unknown): Promise<Response> {
    const deadline = withDeadlineV1(CALL_TIMEOUT_MS);
    try {
      return await request(`${TELEGRAM_API_ORIGIN}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
    } finally {
      deadline.clear();
    }
  }

  /** A call whose failure is simply a failure: nothing it does is shown to anyone. */
  async function settled(method: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await call(method, body);
    } catch {
      throw new TelegramApiError(502, `Telegram did not answer ${method}`);
    }
    const answer = await readAnswer(response);
    if (!response.ok || answer.ok !== true) {
      throw new TelegramApiError(
        response.status,
        `Telegram refused ${method} (${response.status}${
          typeof answer.description === "string"
            ? `: ${answer.description.slice(0, 200)}`
            : ""
        })`,
      );
    }
    return answer.result;
  }

  return {
    async sendMessage(chatId, text) {
      let response: Response;
      try {
        response = await call("sendMessage", {
          chat_id: chatId,
          text,
          // A Bot's links are for the person to open, not for Telegram to
          // fetch and preview on their behalf.
          link_preview_options: { is_disabled: true },
        });
      } catch {
        return { status: "uncertain" };
      }
      const answer = await readAnswer(response);
      if (response.ok && answer.ok === true) return { status: "sent" };
      if (response.status === 429) {
        const after = answer.parameters?.retry_after;
        const seconds =
          typeof after === "number" && Number.isFinite(after) && after > 0
            ? Math.min(after, 3_600)
            : DEFAULT_RETRY_AFTER_S;
        return { status: "retry", retryAfterMs: seconds * 1000 };
      }
      if (response.status >= 400 && response.status < 500) {
        return {
          status: "rejected",
          description:
            typeof answer.description === "string"
              ? answer.description.slice(0, 200)
              : `status ${response.status}`,
        };
      }
      return { status: "uncertain" };
    },
    async username() {
      const me = (await settled("getMe", {})) as { username?: unknown };
      if (typeof me?.username !== "string" || me.username.length === 0) {
        throw new TelegramApiError(502, "Telegram named no bot username");
      }
      return me.username;
    },
    async setWebhook(url, secretToken) {
      await settled("setWebhook", {
        url,
        secret_token: secretToken,
        // Only new messages: an edit, a reaction or a group the bot was added
        // to is nothing a Bot is asked about, so it is never sent at all.
        allowed_updates: ["message"],
      });
    },
  };
}

/**
 * An answer to the webhook that is itself one Bot API call.
 *
 * Telegram runs the method named in a webhook response, and says nothing about
 * whether it worked. That is the right trade for the chat's own replies — a
 * command's answer, "that link has expired" — which are cheap to lose and
 * would otherwise need the token and a round trip each.
 */
export function telegramWebhookReplyV1(chatId: string, text: string): Response {
  return Response.json({
    method: "sendMessage",
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
  });
}

/** The chat's "typing…" while an admitted message waits for its Turn. */
export function telegramWebhookTypingV1(chatId: string): Response {
  return Response.json({
    method: "sendChatAction",
    chat_id: chatId,
    action: "typing",
  });
}

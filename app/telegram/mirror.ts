// What a Bot's visible message becomes in the Telegram chat it talks to.
//
// Telegram shows plain text, and only text: a card, an approval or a file has
// no face there, so each is said in one line that sends the person to the app,
// where the thing itself is. A secret request is never answered in Telegram —
// it would put a credential in a third party's chat log — and the line says so.

import type { SendToUserPayloadV1 } from "@frockbot/core/contracts";

/** Telegram's own ceiling on one message, in characters. */
export const TELEGRAM_MESSAGE_MAX_CHARS_V1 = 4096;

/** Room left under the ceiling for the note that the message was cut. */
const CUT_AT = TELEGRAM_MESSAGE_MAX_CHARS_V1 - 96;

/**
 * One message as Telegram will take it: never empty, never over the ceiling.
 *
 * Measured in UTF-16 units, the larger of the ways the ceiling can be read,
 * and cut on a code point, so a long reply never ends in half a surrogate
 * pair Telegram would refuse as malformed.
 */
export function telegramMessageTextV1(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(empty message)";
  if (trimmed.length <= TELEGRAM_MESSAGE_MAX_CHARS_V1) return trimmed;
  let kept = "";
  for (const point of trimmed) {
    if (kept.length + point.length > CUT_AT) break;
    kept += point;
  }
  return `${kept}…\n\n(The rest is in FrockBot.)`;
}

/** What one `send_to_user` payload says in Telegram. */
export function telegramMirrorTextV1(payload: unknown): string {
  const value = (payload ?? {}) as Partial<SendToUserPayloadV1> &
    Record<string, unknown>;
  switch (value.type) {
    case "text":
      return typeof value.text === "string" ? value.text : "";
    case "widget": {
      const widget = value.widget as
        { prompt?: unknown; options?: unknown } | undefined;
      const prompt =
        typeof widget?.prompt === "string" ? widget.prompt : "A question";
      const options = Array.isArray(widget?.options)
        ? widget.options.filter(
            (option): option is string => typeof option === "string",
          )
        : [];
      return [
        prompt,
        ...options.map((option) => `• ${option}`),
        "Answer here or in FrockBot.",
      ].join("\n");
    }
    case "approval":
      return `Waiting for your approval: ${
        typeof value.action === "string" ? value.action : "an action"
      }. Approve or decline it in FrockBot.`;
    case "secret-request":
      return "This needs a secret. Enter it in FrockBot — never send it here.";
    case "agent-card":
      return [value.title, value.body]
        .filter((part): part is string => typeof part === "string")
        .join("\n");
    case "attachment":
      return `Sent ${
        typeof value.name === "string" ? `“${value.name}”` : "a file"
      }. Open FrockBot to see it.`;
    case "card":
      return "Sent a card. Open FrockBot to see it.";
    default:
      return "Sent a message. Open FrockBot to see it.";
  }
}

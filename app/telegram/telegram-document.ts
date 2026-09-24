// The Telegram surface, projected as the `ViewDocument` the host renders —
// the convention `app/machine/machines-document.ts` follows, reached with
// `?as=document`.
//
// Three commands: link, choose the Bot, unlink. None fences on a revision —
// the link is one record and the last choice wins — so the document derives
// its revision from its own bytes.
//
// The link code is deliberately not here. It exists once, on the receipt the
// link command answers with, and a document can be read twice. The host holds
// it for as long as the person is looking at it, exactly as it holds a
// machine's pairing code.

import {
  decodeProtocol,
  type ActionValueSchema,
  type ViewDocument,
  type ViewNode,
} from "@frockbot/core/protocol-schemas";
import { agoV1 } from "@frockbot/app/shell/moment";
import type { TelegramStatusViewV1 } from "./shared.js";

export const TELEGRAM_ACTION_KINDS_V1 = [
  "telegram-link",
  "telegram-bot",
  "telegram-unlink",
] as const;

export type TelegramActionKindV1 = (typeof TELEGRAM_ACTION_KINDS_V1)[number];

/** The field the Bot choice carries: the chosen Bot's id. */
export const TELEGRAM_BOT_FIELD_V1 = "telegram.bot";

const KIND: ActionValueSchema = {
  type: "string",
  enum: [...TELEGRAM_ACTION_KINDS_V1],
};

function status(text: string): ViewNode {
  return { type: "text", text: text.slice(0, 4000), style: "status" };
}

function revision(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function kindOnly(id: TelegramActionKindV1) {
  return {
    id,
    schema: {
      type: "object" as const,
      properties: { kind: KIND },
      required: ["kind"],
      additionalProperties: false as const,
    },
  };
}

const INTRO =
  "Talk to your Bots from Telegram. Link your Telegram account once, and what you send FrockBot’s Telegram bot reaches the Bot you choose here. What that Bot says in its conversation comes back to the chat.";

/**
 * The Telegram surface.
 *
 * `available` is whether this deployment has a Telegram bot at all. Without
 * one there is nothing to link, and the page says so in a sentence rather
 * than offering a button that can only fail.
 */
export function telegramDocumentV1(
  view: TelegramStatusViewV1,
  options: { available: boolean; now?: string },
): ViewDocument {
  const now = options.now ?? new Date().toISOString();
  const link = view.link;
  const children: ViewNode[] = [{ type: "text", text: INTRO }];
  const actions: ReturnType<typeof kindOnly>[] = [];
  let botAction:
    | {
        id: "telegram-bot";
        schema: {
          type: "object";
          properties: Record<string, ActionValueSchema>;
          required: string[];
          additionalProperties: false;
        };
      }
    | undefined;

  if (!options.available) {
    children.push(status("Telegram isn’t set up on this deployment."));
  } else if (!link) {
    children.push(
      status(
        "You get a link here, once. Open it on the device where you use Telegram and press Start.",
      ),
      {
        type: "action",
        actionId: "telegram-link",
        label: "Link Telegram",
        style: "primary",
        input: { kind: "telegram-link" },
      },
    );
    actions.push(kindOnly("telegram-link"));
  } else {
    const who = [link.username ? `@${link.username}` : undefined, link.name]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
    children.push(
      status(`Linked${who ? ` to ${who}` : ""} · ${agoV1(link.linkedAt, now)}`),
    );
    if (view.bots.length === 0) {
      children.push(
        status("You have no Bots yet. Create one and choose it here."),
      );
    } else {
      children.push({
        type: "group",
        orientation: "column",
        title: "Who answers in Telegram",
        children: [
          {
            type: "field",
            field: {
              id: TELEGRAM_BOT_FIELD_V1,
              label: "Bot",
              kind: "select",
              value: link.botId ?? null,
              editable: true,
              hint: "Messages from Telegram go to this Bot, and everything it says in its conversation is sent back to the chat. In Telegram, /bots lists your Bots and /bot switches.",
              choices: view.bots.map((bot) => ({
                label: bot.name,
                value: bot.botId,
              })),
            },
          },
          {
            type: "action",
            actionId: "telegram-bot",
            label: "Save",
            input: { kind: "telegram-bot" },
          },
        ],
      });
      botAction = {
        id: "telegram-bot",
        schema: {
          type: "object",
          properties: {
            kind: KIND,
            [TELEGRAM_BOT_FIELD_V1]: { type: "string", maxLength: 128 },
          },
          required: ["kind", TELEGRAM_BOT_FIELD_V1],
          additionalProperties: false,
        },
      };
    }
    children.push({
      type: "action",
      actionId: "telegram-unlink",
      label: "Unlink Telegram",
      style: "danger",
      input: { kind: "telegram-unlink" },
    });
    actions.push(kindOnly("telegram-unlink"));
  }

  return decodeProtocol("ViewDocument", {
    schemaVersion: 1,
    surfaceId: "telegram",
    revision: revision(
      JSON.stringify([
        options.available,
        link?.username ?? "",
        link?.name ?? "",
        link?.linkedAt ?? "",
        link?.botId ?? "",
        view.bots.map((bot) => [bot.botId, bot.name]),
      ]),
    ),
    root: { type: "group", orientation: "column", children },
    actions: [...actions, ...(botAction ? [botAction] : [])],
  });
}

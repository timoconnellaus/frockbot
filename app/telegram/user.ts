// The User Durable Object's half of Telegram: the link, which Bot the chat
// talks to, the chat's commands, and the record that makes each mirrored
// message at-most-once.
//
// The link is the authority. The deployment directory only says which User an
// account claims to be; every inbound message is checked here against the
// account and chat this User linked, and every outbound message is sent only
// to the chat the link names now, for the Bot the link names now.

import {
  decodeTelegramLinkV1,
  type TelegramAccountV1,
  type TelegramBotChoiceV1,
  type TelegramInboundMessageV1,
  type TelegramLinkV1,
  type TelegramMirrorOutcomeV1,
  type TelegramRouteDecisionV1,
  type TelegramStatusViewV1,
} from "./shared.js";
import { parseTelegramCommandV1 } from "./update.js";

const LINK_KEY = "telegram:link";
const DELIVERY_PREFIX = "telegram:delivery:";

export interface TelegramUserStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface TelegramUserHostV1 {
  storage: TelegramUserStorageV1 & {
    transaction<T>(
      closure: (transaction: TelegramUserStorageV1) => Promise<T>,
    ): Promise<T>;
  };
  /**
   * The User's active Bots in directory order, and General's id while it is
   * one of them. Archived and deleted Bots are not choices.
   */
  bots(): Promise<{ bots: TelegramBotChoiceV1[]; generalBotId?: string }>;
}

/** A change of which Bot the chat talks to, for the caller to carry to both. */
export interface TelegramSwitchV1 {
  from?: string;
  to?: string;
}

interface DeliveryRecordV1 {
  schemaVersion: 1;
  cursor: string;
  status: "attempting" | "sent" | "failed" | "uncertain" | "retry";
  at: string;
  retryAt?: string;
}

export type TelegramDeliveryClaimV1 =
  | { kind: "claimed"; chatId: string }
  | { kind: "done"; outcome: TelegramMirrorOutcomeV1 };

const HOW_TO_LINK =
  "In FrockBot, open You → Telegram and choose Link Telegram.";

export const TELEGRAM_NOT_LINKED_TEXT_V1 = `This Telegram account isn’t linked to FrockBot. ${HOW_TO_LINK}`;

export const TELEGRAM_UNSUPPORTED_TEXT_V1 =
  "Only text messages reach your Bot from here for now.";

export const TELEGRAM_CODE_INVALID_TEXT_V1 = `That link has expired or was already used. ${HOW_TO_LINK}`;

function listText(
  bots: readonly TelegramBotChoiceV1[],
  current: string | undefined,
): string {
  if (bots.length === 0) {
    return "You have no Bots to talk to yet. Create one in FrockBot.";
  }
  return [
    "Your Bots:",
    ...bots.map(
      (bot, index) =>
        `${index + 1}. ${bot.name}${bot.botId === current ? " (talking now)" : ""}`,
    ),
    "Send /bot and a number or a name to switch.",
  ].join("\n");
}

function helpText(current: TelegramBotChoiceV1 | undefined): string {
  return [
    current
      ? `Messages you send here go to ${current.name}, and what it says comes back here.`
      : "No Bot is answering here yet. Send /bots to pick one.",
    "/bots lists your Bots. /bot and a name switches.",
    "To stop, unlink Telegram in FrockBot under You → Telegram.",
  ].join("\n");
}

/** The Bot `/bot <argument>` means: its number in `/bots`, its name, or a unique start of one. */
function pick(
  bots: readonly TelegramBotChoiceV1[],
  argument: string,
): TelegramBotChoiceV1 | undefined {
  const wanted = argument.trim().toLowerCase();
  if (/^[0-9]{1,3}$/.test(wanted)) return bots[Number(wanted) - 1];
  const exact = bots.filter((bot) => bot.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const prefixed = bots.filter((bot) =>
    bot.name.toLowerCase().startsWith(wanted),
  );
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

function defaultBot(choices: {
  bots: TelegramBotChoiceV1[];
  generalBotId?: string;
}): string | undefined {
  return (
    choices.bots.find((bot) => bot.botId === choices.generalBotId)?.botId ??
    choices.bots[0]?.botId
  );
}

export class TelegramUserStoreV1 {
  constructor(private readonly host: TelegramUserHostV1) {}

  async link(): Promise<TelegramLinkV1 | undefined> {
    const stored = await this.host.storage.get<unknown>(LINK_KEY);
    return stored === undefined ? undefined : decodeTelegramLinkV1(stored);
  }

  async read(): Promise<TelegramStatusViewV1> {
    const [link, choices] = await Promise.all([this.link(), this.host.bots()]);
    return {
      schemaVersion: 1,
      ...(link
        ? {
            link: {
              ...(link.username ? { username: link.username } : {}),
              ...(link.name ? { name: link.name } : {}),
              linkedAt: link.linkedAt,
              ...(link.botId &&
              choices.bots.some((bot) => bot.botId === link.botId)
                ? { botId: link.botId }
                : {}),
            },
          }
        : {}),
      bots: choices.bots,
    };
  }

  /**
   * Link this account, answering with the link and the one it replaced.
   *
   * Linking the account already linked keeps the Bot it was talking to; any
   * other link starts on General, or the first Bot the User has.
   */
  async complete(
    account: TelegramAccountV1,
    now: string,
  ): Promise<{
    link: TelegramLinkV1;
    previous?: TelegramLinkV1;
    botName?: string;
  }> {
    const choices = await this.host.bots();
    return this.host.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LINK_KEY);
      const previous =
        stored === undefined ? undefined : decodeTelegramLinkV1(stored);
      const kept =
        previous?.telegramUserId === account.telegramUserId &&
        previous.botId !== undefined &&
        choices.bots.some((bot) => bot.botId === previous.botId)
          ? previous.botId
          : undefined;
      const botId = kept ?? defaultBot(choices);
      const link: TelegramLinkV1 = {
        schemaVersion: 1,
        telegramUserId: account.telegramUserId,
        chatId: account.chatId,
        ...(account.username ? { username: account.username } : {}),
        ...(account.name ? { name: account.name } : {}),
        // Every claim is a new link, even of the same account: the drop a
        // claim sends to the account's previous User compares against it.
        linkedAt: now,
        ...(botId ? { botId } : {}),
      };
      await transaction.put(LINK_KEY, link);
      const botName = choices.bots.find((bot) => bot.botId === botId)?.name;
      return {
        link,
        ...(previous ? { previous } : {}),
        ...(botName ? { botName } : {}),
      };
    });
  }

  /** Forget the link, answering with what it was. */
  async unlink(): Promise<TelegramLinkV1 | undefined> {
    return this.host.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LINK_KEY);
      if (stored === undefined) return undefined;
      await transaction.delete(LINK_KEY);
      return decodeTelegramLinkV1(stored);
    });
  }

  /**
   * Forget the link because another User claimed its account — but only if
   * it is still that account's: a drop arriving after this User relinked the
   * same account must leave the new link alone.
   */
  async drop(
    telegramUserId: string,
    claimedAt: string,
  ): Promise<TelegramLinkV1 | undefined> {
    return this.host.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LINK_KEY);
      if (stored === undefined) return undefined;
      const link = decodeTelegramLinkV1(stored);
      if (
        link.telegramUserId !== telegramUserId ||
        Date.parse(link.linkedAt) > Date.parse(claimedAt)
      ) {
        return undefined;
      }
      await transaction.delete(LINK_KEY);
      return link;
    });
  }

  /** Which Bot the chat talks to, chosen in the app. */
  async select(
    botId: string,
  ): Promise<
    | { status: "applied"; switched: TelegramSwitchV1 }
    | { status: "rejected"; reason: string }
  > {
    const choices = await this.host.bots();
    if (!choices.bots.some((bot) => bot.botId === botId)) {
      return {
        status: "rejected",
        reason: "That Bot can’t answer in Telegram.",
      };
    }
    return this.host.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LINK_KEY);
      if (stored === undefined) {
        return { status: "rejected", reason: "Telegram isn’t linked." };
      }
      const link = decodeTelegramLinkV1(stored);
      if (link.botId === botId) {
        return { status: "applied", switched: {} };
      }
      await transaction.put(LINK_KEY, { ...link, botId });
      return {
        status: "applied",
        switched: { ...(link.botId ? { from: link.botId } : {}), to: botId },
      };
    });
  }

  /**
   * What one message from Telegram is: a command answered here, or words for
   * the Bot the chat talks to.
   */
  async route(message: TelegramInboundMessageV1): Promise<{
    decision: TelegramRouteDecisionV1;
    switched?: TelegramSwitchV1;
  }> {
    const link = await this.link();
    if (
      !link ||
      link.telegramUserId !== message.telegramUserId ||
      link.chatId !== message.chatId
    ) {
      return { decision: { kind: "not-linked" } };
    }
    const choices = await this.host.bots();
    const current = choices.bots.find((bot) => bot.botId === link.botId);
    const command = parseTelegramCommandV1(message.text);
    if (command?.name === "start" || command?.name === "help") {
      return { decision: { kind: "reply", text: helpText(current) } };
    }
    if (command?.name === "bots") {
      return {
        decision: {
          kind: "reply",
          text: listText(choices.bots, current?.botId),
        },
      };
    }
    if (command?.name === "bot") {
      const target = pick(choices.bots, command.argument);
      if (!target) {
        return {
          decision: {
            kind: "reply",
            text: `No Bot matches “${command.argument.slice(0, 60)}”.\n${listText(choices.bots, current?.botId)}`,
          },
        };
      }
      const outcome = await this.select(target.botId);
      if (outcome.status === "rejected") {
        return { decision: { kind: "reply", text: outcome.reason } };
      }
      return {
        decision: { kind: "reply", text: `Now talking to ${target.name}.` },
        switched: outcome.switched,
      };
    }
    if (!current) {
      return {
        decision: {
          kind: "reply",
          text: `${
            link.botId
              ? "The Bot this chat talked to isn’t available any more."
              : "No Bot is answering here yet."
          }\n${listText(choices.bots, undefined)}`,
        },
      };
    }
    return { decision: { kind: "admit", botId: current.botId } };
  }

  /** A deleted Bot: the chat stops talking to it, and its record goes. */
  async forgetBot(botId: string): Promise<void> {
    await this.host.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LINK_KEY);
      if (stored !== undefined) {
        const link = decodeTelegramLinkV1(stored);
        if (link.botId === botId) {
          const { botId: _gone, ...rest } = link;
          await transaction.put(LINK_KEY, rest);
        }
      }
      await transaction.delete(DELIVERY_PREFIX + botId);
    });
  }

  /**
   * Record the intent to send one message, before it is sent.
   *
   * One record per Bot, holding the newest cursor it was asked about, the way
   * the push receipts are kept: cursors only move forward, so the record never
   * grows. A record still `attempting` when it is asked about again is a send
   * whose outcome was lost with the object; it becomes `uncertain` and is not
   * sent again.
   */
  async claimDelivery(
    botId: string,
    cursor: string,
    now: number,
  ): Promise<TelegramDeliveryClaimV1> {
    const link = await this.link();
    if (!link || link.botId !== botId) {
      return { kind: "done", outcome: { status: "skipped" } };
    }
    const key = DELIVERY_PREFIX + botId;
    return this.host.storage.transaction(async (transaction) => {
      const previous = await transaction.get<DeliveryRecordV1>(key);
      if (previous && previous.cursor > cursor) {
        return { kind: "done", outcome: { status: "skipped" } };
      }
      if (previous && previous.cursor === cursor) {
        if (previous.status === "attempting") {
          await transaction.put(key, { ...previous, status: "uncertain" });
          return { kind: "done", outcome: { status: "uncertain" } };
        }
        if (previous.status !== "retry") {
          return { kind: "done", outcome: { status: previous.status } };
        }
        if (previous.retryAt && Date.parse(previous.retryAt) > now) {
          return {
            kind: "done",
            outcome: { status: "retry", retryAt: previous.retryAt },
          };
        }
      }
      await transaction.put(key, {
        schemaVersion: 1,
        cursor,
        status: "attempting",
        at: new Date(now).toISOString(),
      } satisfies DeliveryRecordV1);
      return { kind: "claimed", chatId: link.chatId };
    });
  }

  /** Record what the send did, unless a newer message already moved the record on. */
  async finishDelivery(
    botId: string,
    cursor: string,
    outcome: TelegramMirrorOutcomeV1,
    now: number,
  ): Promise<void> {
    const key = DELIVERY_PREFIX + botId;
    await this.host.storage.transaction(async (transaction) => {
      const current = await transaction.get<DeliveryRecordV1>(key);
      if (current?.cursor !== cursor) return;
      await transaction.put(key, {
        schemaVersion: 1,
        cursor,
        status: outcome.status === "skipped" ? "failed" : outcome.status,
        at: new Date(now).toISOString(),
        ...(outcome.status === "retry" ? { retryAt: outcome.retryAt } : {}),
      } satisfies DeliveryRecordV1);
    });
  }
}

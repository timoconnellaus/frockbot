// The User Durable Object's half of inbound email: which of the User's Bots
// receive email, the addresses allowed to write to them, and the decision
// about each message that arrives.
//
// The User object is the authority. The deployment directory only says whose
// username a message names; the slug before it is matched here against the
// Bots' names as they are now, and the sender against this User's addresses.
//
// A sender is confirmed by a code shown in the app, sent back from that
// mailbox — never by a link in an email. Receiving the code from the address,
// with a passing DMARC verdict, is what proves the person can send as it.

import { constantTimeEqualsV1 } from "@frockbot/core/crypto";
import {
  botEmailSlugsV1,
  decodeInboundEmailSenderV1,
  INBOUND_EMAIL_CODE_TTL_MS_V1,
  INBOUND_EMAIL_SENDERS_MAX_V1,
  mintSenderCodeV1,
  type BotEmailNameV1,
  type BotEmailSenderV1,
  type InboundEmailRouteDecisionV1,
  type InboundEmailSenderV1,
  type InboundEmailStateV1,
} from "./shared.js";

/** Present while the Bot receives email. */
const ENABLED_PREFIX = "email:enabled:";
const SENDERS_KEY = "email:senders";

export interface InboundEmailUserStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** One of the User's Bots, as its address is derived and its door decided. */
export interface InboundEmailBotV1 extends BotEmailNameV1 {
  active: boolean;
}

export interface InboundEmailUserHostV1 {
  storage: InboundEmailUserStorageV1 & {
    transaction<T>(
      closure: (transaction: InboundEmailUserStorageV1) => Promise<T>,
    ): Promise<T>;
  };
  /** Every Bot the User has, archived ones too: their names hold slugs. */
  bots(): Promise<InboundEmailBotV1[]>;
}

interface StoredSendersV1 {
  schemaVersion: 1;
  senders: InboundEmailSenderV1[];
}

export class InboundEmailCommandError extends Error {
  override readonly name = "InboundEmailCommandError";
}

function storedSenders(value: unknown): InboundEmailSenderV1[] {
  if (value === undefined) return [];
  const record = value as StoredSendersV1;
  if (record?.schemaVersion !== 1 || !Array.isArray(record.senders)) {
    throw new Error("stored email senders are invalid");
  }
  return record.senders.map((sender) => decodeInboundEmailSenderV1(sender));
}

export class InboundEmailUserStoreV1 {
  constructor(private readonly host: InboundEmailUserHostV1) {}

  private async senders(): Promise<InboundEmailSenderV1[]> {
    return storedSenders(await this.host.storage.get<unknown>(SENDERS_KEY));
  }

  private async enabled(botId: string): Promise<boolean> {
    return (
      (await this.host.storage.get<unknown>(ENABLED_PREFIX + botId)) === true
    );
  }

  /** One Bot's email: its slug now, whether it is on, and the senders. */
  async state(botId: string): Promise<InboundEmailStateV1> {
    const [bots, enabled, senders] = await Promise.all([
      this.host.bots(),
      this.enabled(botId),
      this.senders(),
    ]);
    const slug = botEmailSlugsV1(bots).get(botId);
    if (!slug) throw new InboundEmailCommandError("That Bot isn’t yours.");
    return { schemaVersion: 1, slug, enabled, senders };
  }

  /**
   * Whether this Bot receives and sends email. Off until the person turns it
   * on.
   */
  async setEnabled(botId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      const bot = (await this.host.bots()).find(
        (candidate) => candidate.botId === botId,
      );
      if (!bot?.active) {
        throw new InboundEmailCommandError(
          "Only an active Bot can have email.",
        );
      }
      await this.host.storage.put(ENABLED_PREFIX + botId, true);
      return;
    }
    await this.host.storage.delete(ENABLED_PREFIX + botId);
  }

  /**
   * What this Bot sends as, or why it cannot send yet in words the Bot can
   * pass on: its address and name, and the owner's own addresses — the
   * sign-in one first — which it may write to without a draft card.
   */
  async sender(
    botId: string,
    deployment: { domain?: string; username?: string; signInEmail?: string },
  ): Promise<BotEmailSenderV1> {
    const unavailable = (reason: string): BotEmailSenderV1 => ({
      status: "unavailable",
      reason,
    });
    if (!deployment.domain) {
      return unavailable("this deployment sends no email");
    }
    const [bots, enabled, senders] = await Promise.all([
      this.host.bots(),
      this.enabled(botId),
      this.senders(),
    ]);
    const bot = bots.find((candidate) => candidate.botId === botId);
    const slug = botEmailSlugsV1(bots).get(botId);
    if (!bot || !slug || !bot.active) {
      return unavailable("only an active Bot sends email");
    }
    if (!deployment.username) {
      return unavailable(
        "you have no email address yet, because your person has not chosen an email username; they can choose one under Account → Email username",
      );
    }
    if (!enabled) {
      return unavailable(
        "email is switched off for you; your person can switch it on in your settings under Email",
      );
    }
    const owner = [
      ...(deployment.signInEmail ? [deployment.signInEmail] : []),
      ...senders
        .filter((sender) => sender.verifiedAt !== undefined)
        .map((sender) => sender.address)
        .filter((address) => address !== deployment.signInEmail),
    ];
    return {
      status: "ready",
      address: `${slug}.${deployment.username}@${deployment.domain}`,
      name: bot.name,
      owner,
      ...(deployment.signInEmail
        ? { signInEmail: deployment.signInEmail }
        : {}),
    };
  }

  /** What deleting the Bot leaves of its email: nothing. */
  async forgetBot(botId: string): Promise<void> {
    await this.host.storage.delete(ENABLED_PREFIX + botId);
  }

  /**
   * Allow an address to write to the User's Bots once it sends its code back.
   * Adding one already waiting gives it a fresh code; one already confirmed is
   * left alone.
   */
  async addSender(
    address: string,
    options: { signInEmail?: string; now: number },
  ): Promise<void> {
    if (address === options.signInEmail) {
      throw new InboundEmailCommandError(
        "That’s the address you sign in with. It can already email your Bots.",
      );
    }
    await this.host.storage.transaction(async (transaction) => {
      const senders = storedSenders(
        await transaction.get<unknown>(SENDERS_KEY),
      );
      const existing = senders.find((sender) => sender.address === address);
      if (existing?.verifiedAt) return;
      if (!existing && senders.length >= INBOUND_EMAIL_SENDERS_MAX_V1) {
        throw new InboundEmailCommandError(
          `Up to ${INBOUND_EMAIL_SENDERS_MAX_V1} addresses can email your Bots. Remove one first.`,
        );
      }
      const pending: InboundEmailSenderV1 = {
        address,
        addedAt: new Date(options.now).toISOString(),
        code: mintSenderCodeV1(),
        expiresAt: new Date(
          options.now + INBOUND_EMAIL_CODE_TTL_MS_V1,
        ).toISOString(),
      };
      await transaction.put(SENDERS_KEY, {
        schemaVersion: 1,
        senders: existing
          ? senders.map((sender) =>
              sender.address === address ? pending : sender,
            )
          : [...senders, pending],
      } satisfies StoredSendersV1);
    });
  }

  async removeSender(address: string): Promise<void> {
    await this.host.storage.transaction(async (transaction) => {
      const senders = storedSenders(
        await transaction.get<unknown>(SENDERS_KEY),
      );
      const kept = senders.filter((sender) => sender.address !== address);
      if (kept.length === senders.length) return;
      if (kept.length === 0) {
        await transaction.delete(SENDERS_KEY);
        return;
      }
      await transaction.put(SENDERS_KEY, {
        schemaVersion: 1,
        senders: kept,
      } satisfies StoredSendersV1);
    });
  }

  /**
   * What one message is: words from one of this User's senders for one of
   * their Bots, the code that confirms a waiting address, or nothing that may
   * reach them.
   *
   * The caller has already checked the message's DMARC verdict for `sender`;
   * this decides whether that address is one of this User's, and it decides
   * that first. An address is guessable, so anyone else learns nothing here
   * about which Bots there are, or which receive.
   */
  async route(request: {
    slug: string;
    sender: string;
    signInEmail?: string;
    codes: readonly string[];
    now: number;
  }): Promise<InboundEmailRouteDecisionV1> {
    const known =
      request.sender === request.signInEmail ||
      (await this.confirmSender(request));
    if (known === "confirmed") return { kind: "confirmed" };
    if (!known) return { kind: "refused", code: "unverified-sender" };
    const bots = await this.host.bots();
    const slugs = botEmailSlugsV1(bots);
    const bot = bots.find(
      (candidate) => slugs.get(candidate.botId) === request.slug,
    );
    if (!bot) return { kind: "refused", code: "unknown-address" };
    if (!bot.active) return { kind: "refused", code: "bot-unavailable" };
    if (!(await this.enabled(bot.botId))) {
      return { kind: "refused", code: "switched-off" };
    }
    return { kind: "admit", botId: bot.botId };
  }

  /**
   * Whether the sender is a confirmed address of this User's — or, when it
   * is waiting and the message carries its unexpired code, confirms it now.
   */
  private async confirmSender(request: {
    sender: string;
    codes: readonly string[];
    now: number;
  }): Promise<boolean | "confirmed"> {
    return this.host.storage.transaction(async (transaction) => {
      const senders = storedSenders(
        await transaction.get<unknown>(SENDERS_KEY),
      );
      const sender = senders.find(
        (candidate) => candidate.address === request.sender,
      );
      if (sender?.verifiedAt) return true;
      const code = sender?.code;
      if (
        !sender ||
        code === undefined ||
        !(Date.parse(sender.expiresAt ?? "") > request.now) ||
        !request.codes.some((candidate) =>
          constantTimeEqualsV1(candidate, code),
        )
      ) {
        return false;
      }
      await transaction.put(SENDERS_KEY, {
        schemaVersion: 1,
        senders: senders.map((candidate) =>
          candidate.address === request.sender
            ? {
                address: candidate.address,
                addedAt: candidate.addedAt,
                verifiedAt: new Date(request.now).toISOString(),
              }
            : candidate,
        ),
      } satisfies StoredSendersV1);
      return "confirmed";
    });
  }
}

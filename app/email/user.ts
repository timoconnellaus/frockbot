// The User Durable Object's half of inbound email: each Bot's address, the
// addresses allowed to write to the User's Bots, and the decision about each
// message that arrives.
//
// The User object is the authority. The deployment directory only says which
// User and Bot a token claims to be; every message is checked here against
// the address this User holds for that Bot now and against their confirmed
// senders, so a directory entry that outlived a rotation is refused.
//
// A sender is confirmed by a code shown in the app, sent back from that
// mailbox — never by a link in an email. Receiving the code from the address,
// with a passing DMARC verdict, is what proves the person can send as it.

import { constantTimeEqualsV1 } from "@frockbot/core/crypto";
import {
  decodeInboundAddressV1,
  decodeInboundEmailSenderV1,
  INBOUND_EMAIL_CODE_TTL_MS_V1,
  INBOUND_EMAIL_SENDERS_MAX_V1,
  mintInboundAddressTokenV1,
  mintSenderCodeV1,
  type InboundAddressV1,
  type InboundEmailRouteDecisionV1,
  type InboundEmailSenderV1,
  type InboundEmailStateV1,
} from "./shared.js";

const ADDRESS_PREFIX = "email:address:";
const SENDERS_KEY = "email:senders";

export interface InboundEmailUserStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface InboundEmailUserHostV1 {
  storage: InboundEmailUserStorageV1 & {
    transaction<T>(
      closure: (transaction: InboundEmailUserStorageV1) => Promise<T>,
    ): Promise<T>;
  };
  /** Whether this Bot is one of the User's active Bots. */
  botActive(botId: string): Promise<boolean>;
  /** The deployment directory: where a token is looked up by the handler. */
  directory: {
    register(botId: string, token: string): Promise<void>;
    release(botId: string): Promise<void>;
  };
  /**
   * Runs an address change with nothing else let in: it writes this object
   * and the directory, and the two must not interleave with another change.
   */
  exclusive<T>(closure: () => Promise<T>): Promise<T>;
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

  private async address(botId: string): Promise<InboundAddressV1 | undefined> {
    const stored = await this.host.storage.get<unknown>(ADDRESS_PREFIX + botId);
    return stored === undefined ? undefined : decodeInboundAddressV1(stored);
  }

  private async senders(): Promise<InboundEmailSenderV1[]> {
    return storedSenders(await this.host.storage.get<unknown>(SENDERS_KEY));
  }

  async state(botId: string): Promise<InboundEmailStateV1> {
    const [address, senders] = await Promise.all([
      this.address(botId),
      this.senders(),
    ]);
    return { schemaVersion: 1, ...(address ? { address } : {}), senders };
  }

  /**
   * Give this Bot an address, or a new one in place of the old. The directory
   * learns the new token before this object keeps it, and forgets the old one
   * in the same write, so from then on only the new address resolves.
   */
  async setAddress(
    botId: string,
    options: { rotate: boolean; now: string },
  ): Promise<void> {
    await this.host.exclusive(async () => {
      if (!options.rotate && (await this.address(botId))) return;
      if (!(await this.host.botActive(botId))) {
        throw new InboundEmailCommandError(
          "Only an active Bot can have an email address.",
        );
      }
      const token = mintInboundAddressTokenV1();
      await this.host.directory.register(botId, token);
      await this.host.storage.put(ADDRESS_PREFIX + botId, {
        token,
        createdAt: options.now,
      } satisfies InboundAddressV1);
    });
  }

  /** This Bot stops receiving email. Also what deleting the Bot does. */
  async removeAddress(botId: string): Promise<void> {
    // The directory is released before this object forgets, so an address
    // still here is one whose release may not have happened yet.
    if (!(await this.address(botId))) return;
    await this.host.exclusive(async () => {
      await this.host.directory.release(botId);
      await this.host.storage.delete(ADDRESS_PREFIX + botId);
    });
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
   * What one message is: words from a confirmed sender for this Bot, the
   * code that confirms a waiting address, or nothing that may reach it.
   *
   * The caller has already checked the message's DMARC verdict for `sender`;
   * this decides only whether that address is one of this User's.
   */
  async route(request: {
    botId: string;
    token: string;
    sender: string;
    signInEmail?: string;
    codes: readonly string[];
    now: number;
  }): Promise<InboundEmailRouteDecisionV1> {
    const address = await this.address(request.botId);
    if (!address || !constantTimeEqualsV1(address.token, request.token)) {
      return { kind: "refused", code: "unknown-address" };
    }
    if (!(await this.host.botActive(request.botId))) {
      return { kind: "refused", code: "bot-unavailable" };
    }
    if (request.sender === request.signInEmail) return { kind: "admit" };
    return this.host.storage.transaction(async (transaction) => {
      const senders = storedSenders(
        await transaction.get<unknown>(SENDERS_KEY),
      );
      const sender = senders.find(
        (candidate) => candidate.address === request.sender,
      );
      if (sender?.verifiedAt) return { kind: "admit" } as const;
      const code = sender?.code;
      if (
        !sender ||
        code === undefined ||
        !(Date.parse(sender.expiresAt ?? "") > request.now) ||
        !request.codes.some((candidate) =>
          constantTimeEqualsV1(candidate, code),
        )
      ) {
        return { kind: "refused", code: "unverified-sender" } as const;
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
      return { kind: "confirmed" } as const;
    });
  }
}

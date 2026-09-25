// The Bot half of email: mail a Bot sends its own person, and the thread each
// message is in.
//
// Two things send it. A note the Bot chose to write — the email Plugin's
// `owner` card, reaching the kernel through the isolate's email grant — and
// the answer to a Turn the person started by email, which that Turn's
// `reply_to_request` delivers. To the person they are the same thing, a
// message from their Bot in their inbox, so both are held to the same rules
// here: only the owner's own addresses, each message claimed under its key
// before the sender is reached, and a few a day.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  emailThreadIdOfOriginV1,
  type BotIdentity,
  type StoredRunEmailOriginV1,
} from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import type { EmailSenderV1 } from "./sender.js";
import {
  decodeBotEmailSenderV1,
  emailReplySubjectV1,
  emailThreadIdV1,
  inboundMessageIdV1,
  normalizeSenderAddressV1,
  type BotEmailSenderRefusalV1,
  type BotEmailSenderV1,
  type EmailThreadRefsV1,
} from "./shared.js";

/** How many messages a Bot may send its owner in one UTC day. */
export const EMAIL_OWNER_DAILY_LIMIT_V1 = 20;

/** Today's count of messages to the owner: one record, reset by the day. */
export const EMAIL_OWNER_COUNT_KEY_V1 = "email:owner:count";

/** One message's send, recorded under its key before the sender is reached. */
export function emailOwnerNoteKeyV1(keyDigest: string): string {
  return `email:owner:note:${keyDigest}`;
}

/**
 * Every message in this Bot's email threads, by the id it went out or came in
 * under: the thread it belongs to. What a reply names is looked up here, so an
 * answer to the Bot's mail joins the thread that mail was in.
 */
export async function emailThreadIndexKeyV1(
  messageId: string,
): Promise<string> {
  return `email:thread:${await sha256HexTextV1(messageId)}`;
}

interface EmailOwnerNoteRecordV1 {
  schemaVersion: 1;
  status: "claimed" | "sent" | "unknown";
  to: string;
  messageId?: string;
}

interface EmailOwnerCountRecordV1 {
  schemaVersion: 1;
  day: string;
  count: number;
}

/**
 * Why mail to the owner did not leave. The `reason` beside it is worded for
 * the Bot, which passes it on; the code is what the kernel words for the
 * person when a reply falls back to the conversation.
 */
export type OwnerMailRefusalV1 =
  | BotEmailSenderRefusalV1
  | "no-sender"
  | "unreadable"
  | "no-address"
  | "not-owner"
  | "daily-limit"
  | "refused";

export type OwnerMailOutcomeV1 =
  | { status: "sent"; messageId: string; to: string }
  | { status: "unknown"; reason: string }
  | { status: "unavailable"; code: OwnerMailRefusalV1; reason: string };

/** The deployment's sender and what this Bot sends as, once both are known. */
export interface OwnerMailSenderV1 {
  sender: EmailSenderV1;
  from: Extract<BotEmailSenderV1, { status: "ready" }>;
}

/** What this Bot sends as, from its User's object, or why it cannot. */
export async function readBotEmailSenderV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<
  | Extract<BotEmailSenderV1, { status: "ready" }>
  | Extract<OwnerMailOutcomeV1, { status: "unavailable" }>
> {
  try {
    const user = state.env.USER_CONFIGURATIONS.get(
      state.env.USER_CONFIGURATIONS.idFromName(identity.userId),
    );
    return decodeBotEmailSenderV1(
      await user.readBotEmailSender({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
      }),
    );
  } catch {
    return {
      status: "unavailable",
      code: "unreadable",
      reason: "which address you send from could not be read just now",
    };
  }
}

/** The sender and the Bot's address, or why this Bot sends nothing yet. */
export async function ownerMailSenderV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<
  | ({ status: "ready" } & OwnerMailSenderV1)
  | Extract<OwnerMailOutcomeV1, { status: "unavailable" }>
> {
  const sender = state.env.EMAIL_SENDER;
  if (!sender) {
    return {
      status: "unavailable",
      code: "no-sender",
      reason: "this deployment has no sender bound, so it sends no email",
    };
  }
  const from = await readBotEmailSenderV1(state, identity);
  return from.status === "ready" ? { status: "ready", sender, from } : from;
}

/** One message to the owner, as the kernel sends it. */
export interface OwnerMailRequestV1 {
  /** What makes a retried send the same send, and never a second one. */
  key: string;
  /** One of the owner's own addresses; absent, the one they sign in with. */
  to?: string;
  subject: string;
  body: string;
  /** The Message-ID this answers, without brackets, when it answers one. */
  inReplyTo?: string;
  /**
   * The thread the message belongs to, which a reply to it will join. Absent,
   * a reply to it starts a thread of its own.
   */
  threadId?: string;
}

/**
 * Mail from the Bot to its own person, with no card to decide on. What stands
 * in for the decision is who it can reach: only an address the owner signs in
 * with or confirmed, so the worst a confused Bot can do is write to its own
 * person — at most once per key, and at most
 * {@link EMAIL_OWNER_DAILY_LIMIT_V1} times a day, so a loop cannot run up
 * cost. Anyone else is a draft card.
 */
export async function sendOwnerMailV1(
  state: ShellBotStateV1,
  { sender, from }: OwnerMailSenderV1,
  request: OwnerMailRequestV1,
): Promise<OwnerMailOutcomeV1> {
  const to =
    request.to === undefined
      ? from.owner[0]
      : normalizeSenderAddressV1(request.to);
  if (to === undefined) {
    return {
      status: "unavailable",
      code: "no-address",
      reason:
        "your person has no email address you know: they sign in without one and have confirmed none, so draw a draft card for them to send instead",
    };
  }
  if (!from.owner.includes(to)) {
    return {
      status: "unavailable",
      code: "not-owner",
      reason: `${to} is not one of your person's own addresses, so a message to it is a draft card they approve`,
    };
  }
  const key = emailOwnerNoteKeyV1(await sha256HexTextV1(request.key));
  const day = new Date().toISOString().slice(0, 10);
  const claim = await state.ctx.storage.transaction(async (transaction) => {
    const prior = await transaction.get<EmailOwnerNoteRecordV1>(key);
    if (prior !== undefined) return { status: "prior" as const, prior };
    const stored = await transaction.get<EmailOwnerCountRecordV1>(
      EMAIL_OWNER_COUNT_KEY_V1,
    );
    const count = stored?.day === day ? stored.count : 0;
    if (count >= EMAIL_OWNER_DAILY_LIMIT_V1) {
      return { status: "limit" as const };
    }
    await transaction.put(EMAIL_OWNER_COUNT_KEY_V1, {
      schemaVersion: 1,
      day,
      count: count + 1,
    } satisfies EmailOwnerCountRecordV1);
    await transaction.put(key, {
      schemaVersion: 1,
      status: "claimed",
      to,
    } satisfies EmailOwnerNoteRecordV1);
    return { status: "claimed" as const };
  });
  if (claim.status === "prior") {
    // The same message, asked again: never a second one. A claim with no
    // outcome is a send whose answer was lost, which may have left.
    return claim.prior.status === "sent" && claim.prior.messageId
      ? { status: "sent", messageId: claim.prior.messageId, to: claim.prior.to }
      : {
          status: "unknown",
          reason:
            "this message was already sent once and may have arrived, so it was not sent again",
        };
  }
  if (claim.status === "limit") {
    return {
      status: "unavailable",
      code: "daily-limit",
      reason: `you have emailed your person ${EMAIL_OWNER_DAILY_LIMIT_V1} times today, the most a Bot may in a day; tell them here instead`,
    };
  }
  const outcome = await sender.send({
    from: { address: from.address, name: from.name },
    to: [to],
    subject: request.subject,
    body: request.body,
    ...(request.inReplyTo === undefined
      ? {}
      : { inReplyTo: `<${request.inReplyTo}>` }),
  });
  if (outcome.status === "unavailable") {
    // Nothing left: the key and the day's count are given back, so the same
    // message can go once the reason is fixed.
    await state.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(key);
      const stored = await transaction.get<EmailOwnerCountRecordV1>(
        EMAIL_OWNER_COUNT_KEY_V1,
      );
      if (stored?.day === day && stored.count > 0) {
        await transaction.put(EMAIL_OWNER_COUNT_KEY_V1, {
          ...stored,
          count: stored.count - 1,
        });
      }
    });
    return { status: "unavailable", code: "refused", reason: outcome.reason };
  }
  await state.ctx.storage.put(key, {
    schemaVersion: 1,
    status: outcome.status,
    to,
    ...(outcome.status === "sent" ? { messageId: outcome.messageId } : {}),
  } satisfies EmailOwnerNoteRecordV1);
  // The person's reply to this names it, and that is how their reply finds
  // its way into this thread rather than starting one.
  const sentId =
    outcome.status === "sent"
      ? inboundMessageIdV1(outcome.messageId)
      : undefined;
  if (sentId !== undefined && request.threadId !== undefined) {
    await state.ctx.storage.put(
      await emailThreadIndexKeyV1(sentId),
      request.threadId,
    );
  }
  return outcome.status === "sent" ? { ...outcome, to } : outcome;
}

/**
 * The thread an arriving message joins, or nothing when it starts its own —
 * read from what it answers, against the mail this Bot has sent and received.
 */
export async function inboundEmailThreadIdV1(
  state: Pick<ShellBotStateV1, "ctx">,
  messageId: string,
  refs: EmailThreadRefsV1,
): Promise<string | undefined> {
  const thread = await emailThreadIdV1(refs, async (id) => {
    const known = await state.ctx.storage.get<unknown>(
      await emailThreadIndexKeyV1(id),
    );
    return typeof known === "string" ? known : undefined;
  });
  return thread === messageId ? undefined : thread;
}

/** Records an arriving message in its thread, so a reply to it finds it. */
export async function indexInboundEmailV1(
  state: Pick<ShellBotStateV1, "ctx">,
  origin: StoredRunEmailOriginV1,
): Promise<void> {
  await state.ctx.storage.put(
    await emailThreadIndexKeyV1(origin.messageId),
    emailThreadIdOfOriginV1(origin),
  );
}

/** What emailing an email Turn's answer came to, and what it was sent as. */
export type EmailReplyOutcomeV1 = OwnerMailOutcomeV1 & { subject: string };

/**
 * The answer to a Turn the person started by email, emailed back to the
 * address that wrote, in its thread, from the Bot's own address.
 *
 * Keyed on the Turn and the call that answered, so a Turn replayed after an
 * eviction finds its claim and never sends the answer twice.
 */
export async function sendEmailReplyV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  request: { runId: string; occurrenceId: string; body: string },
): Promise<EmailReplyOutcomeV1> {
  const run = await state.authority.readRunHeader(request.runId);
  const origin = run?.admission?.origin;
  if (origin?.kind !== "email") {
    throw new Error(`run "${request.runId}" did not arrive by email`);
  }
  const subject = emailReplySubjectV1(origin.subject);
  const ready = await ownerMailSenderV1(state, identity);
  if (ready.status !== "ready") return { ...ready, subject };
  return {
    ...(await sendOwnerMailV1(state, ready, {
      key: `email-reply\u0000${request.runId}\u0000${request.occurrenceId}`,
      to: origin.from,
      subject,
      body: request.body,
      inReplyTo: origin.messageId,
      threadId: emailThreadIdOfOriginV1(origin),
    })),
    subject,
  };
}

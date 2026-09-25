// One message arriving at the deployment's inbound domain.
//
// The Worker's `email()` handler is the only caller, and the open internet is
// on the other side of it: anyone can send anything, naming anyone in `From`.
// So the order is the point. The size is checked, the recipient read, the
// message parsed and its sender authenticated — every one of those touching
// nothing but the message itself — and only a message whose `From` domain the
// receiving server verified has its username looked up in the directory. Then
// the User's object decides whether that sender is one of theirs, and which of
// their Bots the slug names. Only then is anything written: the files, and the
// Turn.
//
// A refusal is `setReject`, a permanent SMTP error the sending server reports
// to its own sender, so a forged `From` is never written back to. A failure
// to reach durable state throws, and Email Routing delivers the message again;
// the run id is derived from the Message-ID and the recipient, so a
// redelivery replays the admission rather than making a second Turn.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import { botTurnRefusalCodeV1 } from "@frockbot/core/durable";
import {
  MESSAGE_ATTACHMENT_LIMIT_V1,
  UPLOAD_MAX_BYTES_V1,
} from "@frockbot/core/contracts";
import { senderAuthenticationV1 } from "./authentication.js";
import { parseInboundEmailV1, type InboundEmailFileV1 } from "./message.js";
import {
  addressDomainV1,
  EMAIL_SUBJECT_MAX_CHARS_V1,
  emailTurnHeadingV1,
  INBOUND_EMAIL_MAX_BYTES_V1,
  INBOUND_EMAIL_TEXT_MAX_CHARS_V1,
  inboundMessageIdV1,
  parseBotEmailLocalPartV1,
  senderCodesInV1,
  type EmailThreadRefsV1,
  type InboundEmailRouteDecisionV1,
} from "./shared.js";

/** The part of Cloudflare's `ForwardableEmailMessage` this reads. */
export interface InboundEmailMessageV1 {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export type InboundAttachmentStoreV1 =
  | { status: "stored"; uploadId: string }
  | { status: "refused"; reason: string };

export interface InboundEmailHostV1 {
  /** Absent: this deployment receives no email, and every message is refused. */
  domain?: string;
  /** The User a username belongs to, if anyone's. */
  resolveUsername(username: string): Promise<string | undefined>;
  /** The User's verified sign-in address, which may always write to their Bots. */
  signInEmail(userId: string): Promise<string | undefined>;
  /**
   * Why this account may not use the product right now, or nothing. The same
   * admission every external door asks: a message spends the account's model
   * budget like any other Turn.
   */
  accountRefusal(userId: string): Promise<string | undefined>;
  route(
    userId: string,
    request: {
      slug: string;
      sender: string;
      signInEmail?: string;
      codes: string[];
    },
  ): Promise<InboundEmailRouteDecisionV1>;
  /** One file into the Bot's uploads, as the composer's upload would put it. */
  storeAttachment(
    userId: string,
    botId: string,
    file: InboundEmailFileV1,
  ): Promise<InboundAttachmentStoreV1>;
  admit(
    userId: string,
    botId: string,
    command: {
      runId: string;
      text: string;
      messageId: string;
      /** The mailbox that wrote, which the Turn's answer is emailed back to. */
      from: string;
      subject: string;
      /** What the message answers, which the Bot reads its thread from. */
      thread: EmailThreadRefsV1;
      attachments: { uploadId: string }[];
    },
  ): Promise<void>;
}

export type InboundEmailOutcomeV1 =
  | { status: "admitted"; runId: string }
  | { status: "confirmed" }
  | { status: "duplicate"; runId: string }
  | { status: "rejected"; code: InboundEmailRejectionV1 };

export type InboundEmailRejectionV1 =
  | "off"
  | "too-large"
  | "unknown-address"
  | "unreadable"
  | "automatic"
  | "bad-from"
  | "unauthenticated"
  | "no-message-id"
  | "account"
  | "bot-unavailable"
  | "switched-off"
  | "unverified-sender"
  | "empty"
  | "busy";

/**
 * What the sending server is told. The sender may be anyone, so it says what
 * happened and nothing about whose address this is.
 */
const REJECTION_TEXT: Readonly<Record<InboundEmailRejectionV1, string>> = {
  off: "This address does not accept mail.",
  "too-large": `Message is larger than ${INBOUND_EMAIL_MAX_BYTES_V1 / 1024 ** 2} MB.`,
  "unknown-address": "No such address.",
  unreadable: "Message could not be read.",
  automatic: "Automatic messages are not accepted.",
  "bad-from": "Message must name exactly one sender.",
  unauthenticated:
    "Sender could not be verified: the From domain did not pass DMARC.",
  "no-message-id": "Message has no usable Message-ID.",
  account: "This address does not accept mail right now.",
  "bot-unavailable": "This address does not accept mail right now.",
  "switched-off": "This address does not accept mail right now.",
  "unverified-sender":
    "This address only accepts mail from its owner's confirmed addresses.",
  empty: "Message is empty.",
  busy: "Too many messages are waiting. Try again later.",
};

const BOT_GONE_ERRORS = new Set([
  "BotNotFoundError",
  "BotArchivedError",
  "BotDeletedError",
]);

/** The run a message becomes: one per recipient and Message-ID. */
export async function inboundEmailRunIdV1(
  recipient: string,
  messageId: string,
): Promise<string> {
  return `em-${await sha256HexTextV1(`email\u0000${recipient}\u0000${messageId}`)}`;
}

/** The raw message, refused once it passes the bound. */
async function readBounded(
  raw: ReadableStream<Uint8Array>,
): Promise<Uint8Array | "too-large"> {
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > INBOUND_EMAIL_MAX_BYTES_V1) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The Bot address a recipient names, on this deployment's domain. */
function recipientAddress(
  to: string,
  domain: string,
): { recipient: string; slug: string; username: string } | undefined {
  const recipient = to.trim().replace(/^<|>$/g, "").toLowerCase();
  const at = recipient.lastIndexOf("@");
  if (at <= 0 || recipient.slice(at + 1) !== domain) return undefined;
  const named = parseBotEmailLocalPartV1(recipient.slice(0, at));
  return named ? { recipient, ...named } : undefined;
}

/**
 * The most a Turn's text may be in UTF-8. The Bot's door takes 32,000 bytes;
 * a body is cut in characters, and a character can be four of them.
 */
const TEXT_MAX_BYTES = 30_000;

/** How many files a message may try to bring before the rest are only named. */
const FILES_TRIED_MAX = 20;

/** How many files that did not come through are named one by one. */
const FILES_NAMED_MAX = 10;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** What the Bot is told about files that did not come through. */
function notAttached(
  missed: readonly { name: string; reason: string }[],
): string {
  return [
    "Not attached:",
    ...missed
      .slice(0, FILES_NAMED_MAX)
      .map((file) => `- ${file.name}: ${file.reason}`),
    ...(missed.length > FILES_NAMED_MAX
      ? [`- and ${missed.length - FILES_NAMED_MAX} more.`]
      : []),
  ].join("\n");
}

/**
 * The words a Turn carries: the subject, the body cut to fit and saying so,
 * and the files that did not come through.
 */
function turnText(
  subject: string,
  body: string,
  missed: readonly { name: string; reason: string }[],
): string {
  const heading = emailTurnHeadingV1(subject);
  const note = missed.length > 0 ? notAttached(missed) : "";
  let kept = Math.min(body.length, INBOUND_EMAIL_TEXT_MAX_CHARS_V1);
  for (;;) {
    const words =
      kept >= body.length
        ? body
        : `${body.slice(0, kept).trimEnd()}\n\n[The rest of this email was cut: it was ${body.length.toLocaleString("en-US")} characters long.]`;
    const text = [heading, words, note]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (kept === 0 || utf8Bytes(text) <= TEXT_MAX_BYTES) return text;
    kept = Math.floor(kept * 0.8);
  }
}

/** Receive one message. Throws only for what a redelivery could mend. */
export async function receiveInboundEmailV1(
  message: InboundEmailMessageV1,
  host: InboundEmailHostV1,
): Promise<InboundEmailOutcomeV1> {
  const reject = (code: InboundEmailRejectionV1): InboundEmailOutcomeV1 => {
    message.setReject(REJECTION_TEXT[code]);
    return { status: "rejected", code };
  };
  const domain = host.domain;
  if (!domain) return reject("off");
  if (message.rawSize > INBOUND_EMAIL_MAX_BYTES_V1) return reject("too-large");
  const addressed = recipientAddress(message.to, domain);
  if (!addressed) return reject("unknown-address");
  // A bounce carries the null sender; nothing a Bot should answer.
  const envelope = message.from.trim();
  if (envelope === "" || envelope === "<>") return reject("automatic");
  const raw = await readBounded(message.raw);
  if (raw === "too-large") return reject("too-large");
  let email;
  try {
    email = await parseInboundEmailV1(raw);
  } catch {
    return reject("unreadable");
  }
  if (email.automatic) return reject("automatic");
  if (!email.from) return reject("bad-from");
  // Addresses are guessable by design — a Bot's name and the account's
  // username — so this check, with the sender allowlist behind it, is the
  // only lock on a Bot's inbox. Never relax it, never skip it, and never let
  // anything past it before it has passed.
  const authentication = senderAuthenticationV1(
    email.headers,
    addressDomainV1(email.from),
  );
  if (authentication.status !== "pass") return reject("unauthenticated");
  const messageId = inboundMessageIdV1(email.messageId);
  if (!messageId) return reject("no-message-id");
  if (!email.subject && !email.body && email.files.length === 0) {
    return reject("empty");
  }

  // Authenticated: from here the directory and the User's object are asked.
  const userId = await host.resolveUsername(addressed.username);
  if (!userId) return reject("unknown-address");
  if (await host.accountRefusal(userId)) return reject("account");
  const signInEmail = await host.signInEmail(userId);
  const decision = await host.route(userId, {
    slug: addressed.slug,
    sender: email.from,
    ...(signInEmail ? { signInEmail } : {}),
    codes: senderCodesInV1(`${email.subject}\n${email.body.slice(0, 4_000)}`),
  });
  if (decision.kind === "confirmed") return { status: "confirmed" };
  if (decision.kind === "refused") return reject(decision.code);
  const botId = decision.botId;

  // A confirmed sender, to a live address: the files, then the Turn.
  const attachments: { uploadId: string }[] = [];
  const missed: { name: string; reason: string }[] = [];
  for (const [index, file] of email.files.entries()) {
    if (
      attachments.length >= MESSAGE_ATTACHMENT_LIMIT_V1 ||
      index >= FILES_TRIED_MAX
    ) {
      missed.push({
        name: file.name,
        reason: `a message carries at most ${MESSAGE_ATTACHMENT_LIMIT_V1} files.`,
      });
      continue;
    }
    if (file.bytes.byteLength > UPLOAD_MAX_BYTES_V1) {
      missed.push({
        name: file.name,
        reason: `larger than ${UPLOAD_MAX_BYTES_V1 / 1024 ** 2} MB.`,
      });
      continue;
    }
    const stored = await host.storeAttachment(userId, botId, file);
    if (stored.status === "refused") {
      missed.push({ name: file.name, reason: stored.reason });
      continue;
    }
    if (!attachments.some((held) => held.uploadId === stored.uploadId)) {
      attachments.push({ uploadId: stored.uploadId });
    }
  }
  const subject = email.subject.slice(0, EMAIL_SUBJECT_MAX_CHARS_V1);
  const text = turnText(subject, email.body, missed);
  const runId = await inboundEmailRunIdV1(addressed.recipient, messageId);
  try {
    await host.admit(userId, botId, {
      runId,
      text,
      messageId,
      from: email.from,
      subject,
      thread: email.thread,
      attachments,
    });
  } catch (error) {
    const refused = botTurnRefusalCodeV1(error);
    // A full queue would be as full on the next delivery: the sender is told.
    if (refused === "busy") return reject("busy");
    // Already admitted, or fenced by a Stop: the message is where it belongs.
    if (refused) return { status: "duplicate", runId };
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      BOT_GONE_ERRORS.has(String(error.name))
    ) {
      return reject("bot-unavailable");
    }
    throw error;
  }
  return { status: "admitted", runId };
}

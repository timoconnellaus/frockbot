// Email your Bot: the person writing to one of their Bots from their own
// mailbox.
//
// A Bot's address is `<bot-slug>.<username>@<domain>`: the slug is the Bot's
// name, the username is the account's, and the domain is the one the
// deployment routes to this Worker. Addresses are meant to be remembered, so
// they are guessable by design and are no credential at all. What keeps a
// stranger out is the sender: mail reaches a Bot only from the User's sign-in
// address or one they confirmed, and only when the receiving server's own
// authentication verdict says the domain in `From` sent it. What crosses the
// seams between the Worker's `email()` handler, the deployment's directory,
// the User Durable Object and the Bot Durable Object is defined here, with the
// decoders each side holds the other to.

import { isPublicIdentifier } from "@frockbot/core/configuration";
import { cardSurfacePrefixV1 } from "@frockbot/core/contracts";
import { accessEmailV1 } from "../admin/shared.js";

/** One Bot's email: `/api/bots/:botId/email`, and its `/switch` and `/senders`. */
export const INBOUND_EMAIL_ROUTE_V1 =
  /^\/api\/bots\/([^/]+)\/email(\/[a-z]+)?$/;

/** The account's email username. */
export const EMAIL_USERNAME_ROUTE_V1 = "/api/email/username";

/**
 * The largest message read. Cloudflare delivers up to 25 MiB; a message is
 * held whole while it is parsed, and its attachments again once decoded, so
 * the bound stays under that with room for both.
 */
export const INBOUND_EMAIL_MAX_BYTES_V1 = 20 * 1024 * 1024;

/** The most of a message's words a Turn carries. */
export const INBOUND_EMAIL_TEXT_MAX_CHARS_V1 = 16_000;

/** How many addresses besides the sign-in one may email a User's Bots. */
export const INBOUND_EMAIL_SENDERS_MAX_V1 = 10;

/** How long a confirmation code works. A day, to find the other mailbox. */
export const INBOUND_EMAIL_CODE_TTL_MS_V1 = 24 * 60 * 60 * 1000;

/**
 * The authentication services whose verdict is believed: the enabled
 * server's own. Any other `Authentication-Results` line in a message was
 * written by someone on the way, and the sender can write those.
 */
export const INBOUND_EMAIL_TRUSTED_AUTHSERV_IDS_V1: readonly string[] = [
  "mx.cloudflare.net",
];

/**
 * Usernames nobody may hold: the mailboxes a domain is expected to answer
 * for, and names that would read as the product speaking.
 */
export const RESERVED_EMAIL_USERNAMES_V1: ReadonlySet<string> = new Set([
  "admin",
  "support",
  "postmaster",
  "abuse",
  "noreply",
  "no-reply",
  "bot",
  "bots",
  "frockbot",
  "help",
  "security",
  "hostmaster",
  "webmaster",
  "mailer-daemon",
]);

/** A username's shape: a letter, then letters, digits and single dashes. */
const EMAIL_USERNAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A slug's shape, which is also why a local part splits at its last dot. */
const BOT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The longest slug. With a dot and the longest username it leaves the local
 * part inside the 64 characters mail allows.
 */
const BOT_SLUG_MAX_LENGTH = 32;

/** A confirmation code as stored: eight characters of Crockford's base32. */
const SENDER_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The deployment's inbound domain, or nothing: then email is off. */
export function emailDomainV1(settings: {
  EMAIL_DOMAIN?: string;
}): string | undefined {
  const domain = settings.EMAIL_DOMAIN?.trim().toLowerCase();
  return domain &&
    domain.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      domain,
    )
    ? domain
    : undefined;
}

export class InboundEmailDecodeError extends Error {
  override readonly name = "InboundEmailDecodeError";
}

/** Why a username cannot be held, in the person's words, or nothing. */
export function emailUsernameProblemV1(value: unknown): string | undefined {
  if (typeof value !== "string") return "Choose a username.";
  if (value.length < 3 || value.length > 30) {
    return "A username is 3 to 30 characters.";
  }
  if (!EMAIL_USERNAME.test(value)) {
    return "A username starts with a letter and has only lowercase letters, digits and single dashes between them.";
  }
  if (RESERVED_EMAIL_USERNAMES_V1.has(value)) {
    return "That username is reserved. Choose another.";
  }
  return undefined;
}

export function isEmailUsernameV1(value: unknown): value is string {
  return emailUsernameProblemV1(value) === undefined;
}

export function isBotEmailSlugV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= BOT_SLUG_MAX_LENGTH &&
    BOT_SLUG.test(value)
  );
}

/** Letters a name commonly carries that do not decompose into ASCII. */
const TRANSLITERATED: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  ø: "o",
  œ: "oe",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ı: "i",
};

function slugOf(text: string, maximum: number): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ßæøœđðłþı]/g, (letter) => TRANSLITERATED[letter] ?? "")
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximum)
    .replace(/-+$/g, "");
}

/** One Bot as its address is derived: its current name and when it came. */
export interface BotEmailNameV1 {
  botId: string;
  name: string;
  registeredAt: string;
}

/**
 * Every Bot's slug, from its current name: lowercased, spaces as dashes,
 * accents folded, anything else dropped. A name that leaves nothing is
 * `bot-` and the start of the Bot's id. Two Bots that come out the same are
 * told apart in the order they were created: the later one is `-2`, then
 * `-3`, so a Bot's address changes only when a name does.
 */
export function botEmailSlugsV1(
  bots: readonly BotEmailNameV1[],
): Map<string, string> {
  const ordered = [...bots].sort(
    (a, b) =>
      Date.parse(a.registeredAt) - Date.parse(b.registeredAt) ||
      (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0),
  );
  const taken = new Set<string>();
  const slugs = new Map<string, string>();
  for (const bot of ordered) {
    const base =
      slugOf(bot.name, BOT_SLUG_MAX_LENGTH) ||
      `bot-${slugOf(bot.botId.slice(0, 6), 6) || "0"}`;
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) {
      const tail = `-${suffix}`;
      slug = `${base.slice(0, BOT_SLUG_MAX_LENGTH - tail.length).replace(/-+$/g, "")}${tail}`;
    }
    taken.add(slug);
    slugs.set(bot.botId, slug);
  }
  return slugs;
}

/**
 * The slug and username a recipient's local part names, or nothing. It splits
 * at the last dot, and neither half may hold one, so the split is the only
 * reading. A local part with no dot is never a Bot's: a plain mailbox at the
 * same domain is not something this handler touches. `+anything` is the same
 * address, as a person would expect.
 */
export function parseBotEmailLocalPartV1(
  local: string,
): { slug: string; username: string } | undefined {
  const plain = local.toLowerCase().split("+")[0]!;
  const dot = plain.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const slug = plain.slice(0, dot);
  const username = plain.slice(dot + 1);
  return isBotEmailSlugV1(slug) && isEmailUsernameV1(username)
    ? { slug, username }
    : undefined;
}

/** A fresh confirmation code, as stored: `7K3P9QXM`. */
export function mintSenderCodeV1(): string {
  let code = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
    code += CROCKFORD[byte & 31];
  }
  return code;
}

/** A code as the person reads and types it: `FROCK-7K3P-9QXM`. */
export function displaySenderCodeV1(code: string): string {
  return `FROCK-${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The codes a message carries, as stored, in the order written. A code is
 * only ever compared with the one pending for the address that sent it, so a
 * word that happens to look like one costs nothing.
 */
export function senderCodesInV1(text: string): string[] {
  const codes: string[] = [];
  for (const match of text.matchAll(/FROCK-([0-9A-Z]{4})-?([0-9A-Z]{4})/gi)) {
    const code = `${match[1]}${match[2]}`.toUpperCase();
    if (SENDER_CODE.test(code) && !codes.includes(code)) codes.push(code);
    if (codes.length === 3) break;
  }
  return codes;
}

/** A mailbox as it is compared: trimmed and lowercased, or nothing. */
export function normalizeSenderAddressV1(value: unknown): string | undefined {
  const address = accessEmailV1(value);
  return address && address.length <= 254 ? address : undefined;
}

/** The domain half of a normalized address. */
export function addressDomainV1(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** One address the User added, confirmed or waiting for its code. */
export interface InboundEmailSenderV1 {
  address: string;
  addedAt: string;
  /** Set once the code came back from this address. */
  verifiedAt?: string;
  /** While unconfirmed: the code to send, as stored. */
  code?: string;
  expiresAt?: string;
}

/** What the User object answers about one Bot's email. */
export interface InboundEmailStateV1 {
  schemaVersion: 1;
  /** The Bot's slug now: it follows the Bot's name. */
  slug: string;
  /** Whether the Bot receives email. Off until the person turns it on. */
  enabled: boolean;
  senders: InboundEmailSenderV1[];
}

/** One row of the senders list, as the settings page draws it. */
export type InboundEmailSenderViewV1 =
  | { address: string; status: "sign-in" }
  | { address: string; status: "verified"; verifiedAt: string }
  | {
      address: string;
      status: "pending" | "expired";
      /** `FROCK-XXXX-XXXX`, while it still works. */
      code?: string;
      expiresAt: string;
    };

/** What `GET /api/bots/:botId/email` answers. */
export interface InboundEmailViewV1 {
  schemaVersion: 1;
  /** Whether this deployment receives email at all. */
  available: boolean;
  /** The account's username, once the person chose one. */
  username?: string;
  /** `<slug>.<username>@<domain>`, once there is a username. */
  address?: string;
  enabled: boolean;
  senders: InboundEmailSenderViewV1[];
}

/** What `GET /api/email/username` answers. */
export interface EmailUsernameViewV1 {
  schemaVersion: 1;
  available: boolean;
  domain?: string;
  username?: string;
}

/** The view, from the User object's state and what only the gateway knows. */
export function inboundEmailViewV1(
  state: InboundEmailStateV1,
  options: {
    domain?: string;
    username?: string;
    signInEmail?: string;
    now: number;
  },
): InboundEmailViewV1 {
  const senders: InboundEmailSenderViewV1[] = [];
  if (options.signInEmail) {
    senders.push({ address: options.signInEmail, status: "sign-in" });
  }
  for (const sender of state.senders) {
    if (sender.address === options.signInEmail) continue;
    if (sender.verifiedAt) {
      senders.push({
        address: sender.address,
        status: "verified",
        verifiedAt: sender.verifiedAt,
      });
      continue;
    }
    const expiresAt = sender.expiresAt ?? sender.addedAt;
    const live = Date.parse(expiresAt) > options.now;
    senders.push({
      address: sender.address,
      status: live ? "pending" : "expired",
      ...(live && sender.code
        ? { code: displaySenderCodeV1(sender.code) }
        : {}),
      expiresAt,
    });
  }
  return {
    schemaVersion: 1,
    available: options.domain !== undefined,
    ...(options.username ? { username: options.username } : {}),
    ...(options.domain && options.username
      ? { address: `${state.slug}.${options.username}@${options.domain}` }
      : {}),
    enabled: state.enabled,
    senders,
  };
}

/**
 * What a Bot sends as, as the User object answers the Bot's kernel: its own
 * address and name, and the owner's addresses — the sign-in one first — it
 * may write to without a draft card. Or why it cannot send yet, in words the
 * Bot passes on.
 */
export type BotEmailSenderV1 =
  | {
      status: "ready";
      address: string;
      name: string;
      owner: string[];
      /** Where a reply to a draft card's mail goes: the person, not the Bot. */
      signInEmail?: string;
    }
  | { status: "unavailable"; code: BotEmailSenderRefusalV1; reason: string };

/**
 * Why a Bot cannot send yet. The `reason` beside it is worded for the Bot;
 * the code is what lets the kernel say it to the person instead, when a reply
 * falls back to the conversation.
 */
export type BotEmailSenderRefusalV1 =
  "off" | "inactive" | "no-username" | "switched-off";

const BOT_EMAIL_SENDER_REFUSALS_V1: readonly BotEmailSenderRefusalV1[] = [
  "off",
  "inactive",
  "no-username",
  "switched-off",
];

export function decodeBotEmailSenderV1(value: unknown): BotEmailSenderV1 {
  const candidate = record(value, "email sender");
  if (candidate.status === "unavailable") {
    exactKeys(candidate, ["status", "code", "reason"], [], "email sender");
    const code = BOT_EMAIL_SENDER_REFUSALS_V1.find(
      (known) => known === candidate.code,
    );
    if (typeof candidate.reason !== "string" || code === undefined) {
      throw new InboundEmailDecodeError("email sender.reason is invalid");
    }
    return {
      status: "unavailable",
      code,
      reason: candidate.reason.slice(0, 500),
    };
  }
  if (candidate.status !== "ready") {
    throw new InboundEmailDecodeError("email sender.status is unknown");
  }
  exactKeys(
    candidate,
    ["status", "address", "name", "owner"],
    ["signInEmail"],
    "email sender",
  );
  if (typeof candidate.name !== "string" || !Array.isArray(candidate.owner)) {
    throw new InboundEmailDecodeError("email sender is invalid");
  }
  if (candidate.owner.length > INBOUND_EMAIL_SENDERS_MAX_V1 + 1) {
    throw new InboundEmailDecodeError("email sender has too many owners");
  }
  return {
    status: "ready",
    address: senderAddress(candidate.address, "email sender.address"),
    name: candidate.name.slice(0, 200),
    owner: candidate.owner.map((address, index) =>
      senderAddress(address, `email sender.owner[${index}]`),
    ),
    ...(candidate.signInEmail === undefined
      ? {}
      : {
          signInEmail: senderAddress(
            candidate.signInEmail,
            "email sender.signInEmail",
          ),
        }),
  };
}

/** Why the User object refused one message. */
export type InboundEmailRefusalV1 =
  "unverified-sender" | "unknown-address" | "bot-unavailable" | "switched-off";

/** What the User object decided about one message to one of its Bots. */
export type InboundEmailRouteDecisionV1 =
  /** A confirmed sender, to the address of an active Bot that receives. */
  | { kind: "admit"; botId: string }
  /** The message carried the code for a waiting address: it is confirmed. */
  | { kind: "confirmed" }
  | { kind: "refused"; code: InboundEmailRefusalV1 };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InboundEmailDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new InboundEmailDecodeError(`${label}.${key} is not allowed`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new InboundEmailDecodeError(`${label}.${key} is required`);
    }
  }
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new InboundEmailDecodeError(`${label} must be an instant`);
  }
  return value;
}

function senderAddress(value: unknown, label: string): string {
  const address = normalizeSenderAddressV1(value);
  if (address === undefined || address !== value) {
    throw new InboundEmailDecodeError(`${label} must be an email address`);
  }
  return address;
}

export function decodeInboundEmailSenderV1(
  value: unknown,
  label = "sender",
): InboundEmailSenderV1 {
  const candidate = record(value, label);
  exactKeys(
    candidate,
    ["address", "addedAt"],
    ["verifiedAt", "code", "expiresAt"],
    label,
  );
  if (
    candidate.code !== undefined &&
    (typeof candidate.code !== "string" || !SENDER_CODE.test(candidate.code))
  ) {
    throw new InboundEmailDecodeError(`${label}.code is invalid`);
  }
  return {
    address: senderAddress(candidate.address, `${label}.address`),
    addedAt: instant(candidate.addedAt, `${label}.addedAt`),
    ...(candidate.verifiedAt === undefined
      ? {}
      : { verifiedAt: instant(candidate.verifiedAt, `${label}.verifiedAt`) }),
    ...(candidate.code === undefined ? {} : { code: candidate.code as string }),
    ...(candidate.expiresAt === undefined
      ? {}
      : { expiresAt: instant(candidate.expiresAt, `${label}.expiresAt`) }),
  };
}

export function decodeInboundEmailStateV1(value: unknown): InboundEmailStateV1 {
  const candidate = record(value, "inbound email");
  exactKeys(
    candidate,
    ["schemaVersion", "slug", "enabled", "senders"],
    [],
    "inbound email",
  );
  if (
    candidate.schemaVersion !== 1 ||
    !isBotEmailSlugV1(candidate.slug) ||
    typeof candidate.enabled !== "boolean" ||
    !Array.isArray(candidate.senders)
  ) {
    throw new InboundEmailDecodeError("inbound email is invalid");
  }
  if (candidate.senders.length > INBOUND_EMAIL_SENDERS_MAX_V1) {
    throw new InboundEmailDecodeError("inbound email has too many senders");
  }
  return {
    schemaVersion: 1,
    slug: candidate.slug,
    enabled: candidate.enabled,
    senders: candidate.senders.map((sender, index) =>
      decodeInboundEmailSenderV1(sender, `inbound email.senders[${index}]`),
    ),
  };
}

const REFUSALS: ReadonlySet<string> = new Set([
  "unverified-sender",
  "unknown-address",
  "bot-unavailable",
  "switched-off",
]);

export function decodeInboundEmailRouteDecisionV1(
  value: unknown,
): InboundEmailRouteDecisionV1 {
  const candidate = record(value, "inbound email decision");
  if (candidate.kind === "admit") {
    exactKeys(candidate, ["kind", "botId"], [], "inbound email decision");
    if (!isPublicIdentifier(candidate.botId)) {
      throw new InboundEmailDecodeError("inbound email decision.botId");
    }
    return { kind: "admit", botId: candidate.botId };
  }
  if (candidate.kind === "confirmed") {
    exactKeys(candidate, ["kind"], [], "inbound email decision");
    return { kind: "confirmed" };
  }
  if (candidate.kind === "refused") {
    exactKeys(candidate, ["kind", "code"], [], "inbound email decision");
    if (typeof candidate.code !== "string" || !REFUSALS.has(candidate.code)) {
      throw new InboundEmailDecodeError("inbound email refusal is unknown");
    }
    return {
      kind: "refused",
      code: candidate.code as InboundEmailRefusalV1,
    };
  }
  throw new InboundEmailDecodeError("inbound email decision kind is unknown");
}

/**
 * The Message-ID a Turn's origin records: the id without its angle brackets,
 * printable and bounded, or nothing. A message without a usable one is
 * refused, because redelivery is only recognised by it.
 */
export function inboundMessageIdV1(
  value: string | undefined,
): string | undefined {
  const id = value?.trim().replace(/^<|>$/g, "");
  return id && /^[\x21-\x3b\x3d\x3f-\x7e]{1,250}$/.test(id) ? id : undefined;
}

/** How many ids of a thread's history one message is read for. */
export const EMAIL_THREAD_REFS_MAX_V1 = 20;

/**
 * The Message-IDs one `In-Reply-To` or `References` value names, brackets
 * off, in the order written. Past the bound it keeps the first, which is the
 * thread's start, and the latest, which are what the message answers.
 */
export function messageIdsInV1(value: string | undefined): string[] {
  if (!value) return [];
  const bounded = value.slice(0, 16_000);
  const bracketed = [...bounded.matchAll(/<([^<>\s]+)>/g)].map(
    (match) => match[1]!,
  );
  const ids: string[] = [];
  for (const candidate of bracketed.length > 0
    ? bracketed
    : bounded.split(/[\s,]+/)) {
    const id = inboundMessageIdV1(candidate);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length > EMAIL_THREAD_REFS_MAX_V1
    ? [ids[0]!, ...ids.slice(-(EMAIL_THREAD_REFS_MAX_V1 - 1))]
    : ids;
}

/** What one message says it answers, each id without its brackets. */
export interface EmailThreadRefsV1 {
  /** The message it replies to. */
  inReplyTo?: string;
  /** The thread it is in, from its first message to its parent. */
  references: string[];
}

/**
 * Which thread a message belongs to, or nothing when it starts its own.
 *
 * Mail the Bot sent is known by the id the provider gave it, so a reply to a
 * note the Bot wrote joins that note's thread however the person's mail app
 * wrote its headers: `known` looks one id up, parent first. Anything else is
 * the thread its `References` start with, which is how every mail app keeps a
 * conversation together.
 */
export async function emailThreadIdV1(
  refs: EmailThreadRefsV1,
  known: (messageId: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const asked = new Set([
    ...(refs.inReplyTo ? [refs.inReplyTo] : []),
    ...refs.references.toReversed(),
  ]);
  for (const id of asked) {
    const thread = await known(id);
    if (thread !== undefined) return thread;
  }
  return refs.references[0] ?? refs.inReplyTo;
}

/**
 * The surface every note the Bot emails its person is drawn on starts with
 * this: the email Plugin's `owner` card. The card is the note's receipt, and
 * the thread it starts is named by its surface.
 */
export const EMAIL_NOTE_SURFACE_PREFIX_V1 = cardSurfacePrefixV1(
  "email",
  "owner",
);

/** The longest subject an email Turn keeps, and the reply repeats. */
export const EMAIL_SUBJECT_MAX_CHARS_V1 = 300;

/** The line an email Turn's words open with, when the message had a subject. */
export function emailTurnHeadingV1(subject: string): string {
  return subject ? `Subject: ${subject}` : "";
}

/**
 * The words of an email Turn without the subject line they open with: what
 * the person wrote, as the thread draws it under that subject.
 */
export function emailTurnBodyV1(input: string, subject: string): string {
  const heading = emailTurnHeadingV1(subject);
  if (!heading || !input.startsWith(heading)) return input;
  return input.slice(heading.length).replace(/^\n+/, "");
}

/** The subject a reply in a thread carries: one `Re: `, never two. */
export function emailReplySubjectV1(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: your email";
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

// Email your Bot: the person writing to one of their Bots from their own
// mailbox.
//
// Each Bot may have one inbound address, `<token>@<domain>`, on the domain the
// deployment routes to this Worker. The token is random and rotatable, and it
// is only half of the door: mail reaches the Bot only from one of the User's
// confirmed sender addresses, and only when the receiving server's own
// authentication verdict says the domain in `From` sent it. What crosses the
// seams between the Worker's `email()` handler, the deployment's directory,
// the User Durable Object and the Bot Durable Object is defined here, with the
// decoders each side holds the other to.

import { isPublicIdentifier } from "@frockbot/core/configuration";
import { accessEmailV1 } from "../admin/shared.js";

/** Every authenticated route lives under a Bot: `/api/bots/:botId/email`. */
export const INBOUND_EMAIL_ROUTE_V1 =
  /^\/api\/bots\/([^/]+)\/email(\/[a-z]+)?$/;

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
 * The authentication services whose verdict is believed: the receiving
 * server's own. Any other `Authentication-Results` line in a message was
 * written by someone on the way, and the sender can write those.
 */
export const INBOUND_EMAIL_TRUSTED_AUTHSERV_IDS_V1: readonly string[] = [
  "mx.cloudflare.net",
];

/**
 * An address token: 26 base32 characters, 130 random bits. Lowercase only,
 * because mail systems fold a local part's case more often than they keep it.
 */
const ADDRESS_TOKEN = /^[a-z2-7]{26}$/;

/** A confirmation code as stored: eight characters of Crockford's base32. */
const SENDER_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The deployment's inbound domain, or nothing: then email is off. */
export function inboundEmailDomainV1(settings: {
  INBOUND_EMAIL_DOMAIN?: string;
}): string | undefined {
  const domain = settings.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
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

export function isInboundAddressTokenV1(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_TOKEN.test(value);
}

/** A fresh address token. */
export function mintInboundAddressTokenV1(): string {
  let token = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(26))) {
    token += BASE32[byte & 31];
  }
  return token;
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

/** One Bot's inbound address as the User object keeps it. */
export interface InboundAddressV1 {
  token: string;
  createdAt: string;
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
  address?: InboundAddressV1;
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
  /** `<token>@<domain>`, once the person made one. */
  address?: string;
  createdAt?: string;
  senders: InboundEmailSenderViewV1[];
}

/** The view, from the User object's state and what only the gateway knows. */
export function inboundEmailViewV1(
  state: InboundEmailStateV1,
  options: { domain?: string; signInEmail?: string; now: number },
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
    ...(options.domain && state.address
      ? {
          address: `${state.address.token}@${options.domain}`,
          createdAt: state.address.createdAt,
        }
      : {}),
    senders,
  };
}

/** What the User object decided about one message for one of its Bots. */
export type InboundEmailRouteDecisionV1 =
  /** A confirmed sender, to a live address of an active Bot. */
  | { kind: "admit" }
  /** The message carried the code for a waiting address: it is confirmed. */
  | { kind: "confirmed" }
  | {
      kind: "refused";
      code: "unknown-address" | "bot-unavailable" | "unverified-sender";
    };

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

export function decodeInboundAddressV1(value: unknown): InboundAddressV1 {
  const candidate = record(value, "inbound address");
  exactKeys(candidate, ["token", "createdAt"], [], "inbound address");
  if (!isInboundAddressTokenV1(candidate.token)) {
    throw new InboundEmailDecodeError("inbound address.token is invalid");
  }
  return {
    token: candidate.token,
    createdAt: instant(candidate.createdAt, "inbound address.createdAt"),
  };
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
    ["schemaVersion", "senders"],
    ["address"],
    "inbound email",
  );
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.senders)) {
    throw new InboundEmailDecodeError("inbound email is invalid");
  }
  if (candidate.senders.length > INBOUND_EMAIL_SENDERS_MAX_V1) {
    throw new InboundEmailDecodeError("inbound email has too many senders");
  }
  return {
    schemaVersion: 1,
    ...(candidate.address === undefined
      ? {}
      : { address: decodeInboundAddressV1(candidate.address) }),
    senders: candidate.senders.map((sender, index) =>
      decodeInboundEmailSenderV1(sender, `inbound email.senders[${index}]`),
    ),
  };
}

export function decodeInboundEmailRouteDecisionV1(
  value: unknown,
): InboundEmailRouteDecisionV1 {
  const candidate = record(value, "inbound email decision");
  if (candidate.kind === "admit" || candidate.kind === "confirmed") {
    exactKeys(candidate, ["kind"], [], "inbound email decision");
    return { kind: candidate.kind };
  }
  if (candidate.kind === "refused") {
    exactKeys(candidate, ["kind", "code"], [], "inbound email decision");
    if (
      candidate.code !== "unknown-address" &&
      candidate.code !== "bot-unavailable" &&
      candidate.code !== "unverified-sender"
    ) {
      throw new InboundEmailDecodeError("inbound email refusal is unknown");
    }
    return { kind: "refused", code: candidate.code };
  }
  throw new InboundEmailDecodeError("inbound email decision kind is unknown");
}

/** Which User and Bot a token names, as the directory answers it. */
export interface InboundEmailRecipientV1 {
  userId: string;
  botId: string;
}

export function decodeInboundEmailRecipientV1(
  value: unknown,
): InboundEmailRecipientV1 | undefined {
  if (value === null || value === undefined) return undefined;
  const candidate = record(value, "inbound email recipient");
  exactKeys(candidate, ["userId", "botId"], [], "inbound email recipient");
  if (
    typeof candidate.userId !== "string" ||
    candidate.userId.length === 0 ||
    candidate.userId.length > 128 ||
    !isPublicIdentifier(candidate.botId)
  ) {
    throw new InboundEmailDecodeError("inbound email recipient is invalid");
  }
  return { userId: candidate.userId, botId: candidate.botId };
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

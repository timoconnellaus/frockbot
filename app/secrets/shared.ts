// Secrets a person types on a Bot's secret-request card, and the terms a Bot
// may fill one into a web page under.
//
// A secret is the person's, held in the User's credential store under the
// label the Bot asked with. The Bot learns only its reference — `secret-…` —
// and that it exists; the value crosses to the Bot Durable Object as an
// expiring lease for one fill and nowhere else. This module is the shapes and
// the policy words both sides share; nothing here stores or opens anything.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import { decodeCardViewV1, type CardViewV1 } from "@frockbot/app/shell/cards";

/**
 * The Package id the credential store seals a secret under. It is part of
 * the sealed envelope's context, so a secret can only ever be opened as one.
 */
export const SECRETS_PACKAGE_ID_V1 = "secrets";

export const SECRET_LIMITS_V1 = {
  /** The longest value a person may save. A passphrase, not a document. */
  value: 4_096,
  label: 128,
  /** Secrets one User may hold. */
  perUser: 100,
  /** Unanswered and answered requests one Bot keeps the record of. */
  requestsPerBot: 100,
} as const;

/** How long a fill's lease on a value lasts. One action, not a session. */
export const SECRET_LEASE_MS_V1 = 60_000;

/**
 * How long a person has to answer a payment fill's Approval, and how long an
 * approved one stays usable. Fresh means minutes: the page it was approved
 * for is the page in front of them now.
 */
export const SECRET_FILL_APPROVAL_SECONDS_V1 = 10 * 60;

const SECRET_ID_PATTERN_V1 = /^secret-[0-9a-f]{32}$/;
const SECRET_REQUEST_ID_PATTERN_V1 = /^secret-request-[0-9a-f]{32}$/;

export function isSecretIdV1(value: unknown): value is string {
  return typeof value === "string" && SECRET_ID_PATTERN_V1.test(value);
}

export function isSecretRequestIdV1(value: unknown): value is string {
  return typeof value === "string" && SECRET_REQUEST_ID_PATTERN_V1.test(value);
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function mintSecretIdV1(): string {
  return `secret-${randomHex(16)}`;
}

export function mintSecretGenerationV1(): string {
  return `g${randomHex(12)}`;
}

/**
 * The request one secret-request send is recorded under.
 *
 * Stable and unguessable for the reason a Card's Approval ids are: the send
 * is deduped by its effect, so a replayed call must land on the same request,
 * and the id is what the submit route names, so nothing outside the Bot
 * Durable Object may be able to compute it.
 */
export async function secretRequestIdV1(
  secret: string,
  sessionId: string,
  effectId: string,
): Promise<string> {
  const digest = await sha256HexTextV1(
    `secret-request\n${secret}\n${sessionId}\n${effectId}`,
  );
  return `secret-request-${digest.slice(0, 32)}`;
}

export class SecretDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecodeError";
  }
}

/** A secret request this Bot never recorded. A route answers it 404. */
export class SecretRequestNotFoundError extends Error {
  constructor() {
    super("That secret request was not found.");
    this.name = "SecretRequestNotFoundError";
  }
}

/** A saved secret the User does not hold. */
export class SecretNotFoundError extends Error {
  constructor() {
    super("That saved secret was not found.");
    this.name = "SecretNotFoundError";
  }
}

/** The User already holds as many secrets as one account may. */
export class SecretLimitError extends Error {
  constructor() {
    super(
      `You already have ${SECRET_LIMITS_V1.perUser} saved secrets. Delete one in Settings to save another.`,
    );
    this.name = "SecretLimitError";
  }
}

/**
 * The origin a secret may be filled into, or a refusal.
 *
 * A site is named by its origin and nothing narrower: a login page and the
 * checkout that follows it share one. `https` only, except the loopback a
 * Bot's own preview server runs on.
 */
export function secretOriginV1(value: unknown, label = "origin"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new SecretDecodeError(`${label} must be a web address`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecretDecodeError(`${label} must be a web address`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new SecretDecodeError(`${label} must be an https address`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new SecretDecodeError(`${label} must not carry a user name`);
  }
  return url.origin;
}

/** The origin of a page's address, or nothing for one that has none. */
export function pageOriginV1(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a typed value is a payment card number: 12 to 19 digits, spaces and
 * dashes aside, that pass the Luhn check.
 *
 * Asked of the value when it is saved, so a card number is payment-sensitive
 * whatever the Bot said it was asking for.
 */
export function looksLikePaymentCardV1(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Whether a form field is asking for a payment detail, by its label.
 *
 * The other half of the payment class: a secret saved as a password that a
 * Bot tries to type into a field called "Card number" is being used as a
 * payment detail, and is asked about as one.
 */
export function paymentFieldV1(label: string): boolean {
  return /\b(card\s*(number|no\.?|#)|credit|debit|cvc|cvv|csc|cvn|security\s*code|expir|iban|account\s*(number|no\.?)|routing|sort\s*code|bsb|swift|bic)\b/i.test(
    label,
  );
}

/** One saved secret as anyone but the credential store may see it. */
export interface SecretViewV1 {
  secretId: string;
  label: string;
  payment: boolean;
  origin?: string;
  /** The Bot that asked for it. */
  botId: string;
  createdAt: string;
}

export interface SecretListViewV1 {
  schemaVersion: 1;
  secrets: SecretViewV1[];
}

/** One secret's record in the User Durable Object, beside its sealed value. */
export interface SecretItemV1 extends SecretViewV1 {
  schemaVersion: 1;
  requestId: string;
  generation: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecretDecodeError(`${label} must be an object`);
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
      throw new SecretDecodeError(`${label} has an unexpected key "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new SecretDecodeError(`${label} is missing "${key}"`);
    }
  }
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretDecodeError(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new SecretDecodeError(`${label} exceeds ${maximum} characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const stamp = text(value, 64, label);
  if (Number.isNaN(Date.parse(stamp))) {
    throw new SecretDecodeError(`${label} is not a timestamp`);
  }
  return stamp;
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new SecretDecodeError(`${label} must be a boolean`);
  }
  return value;
}

export function decodeSecretViewV1(
  value: unknown,
  label = "secret",
): SecretViewV1 {
  const candidate = object(value, label);
  exactKeys(
    candidate,
    ["secretId", "label", "payment", "botId", "createdAt"],
    ["origin"],
    label,
  );
  if (!isSecretIdV1(candidate.secretId)) {
    throw new SecretDecodeError(`${label} secretId is invalid`);
  }
  return {
    secretId: candidate.secretId,
    label: text(candidate.label, SECRET_LIMITS_V1.label, `${label} label`),
    payment: flag(candidate.payment, `${label} payment`),
    ...(candidate.origin === undefined
      ? {}
      : { origin: secretOriginV1(candidate.origin, `${label} origin`) }),
    botId: text(candidate.botId, 256, `${label} botId`),
    createdAt: timestamp(candidate.createdAt, `${label} createdAt`),
  };
}

export function decodeSecretItemV1(value: unknown): SecretItemV1 {
  const candidate = object(value, "stored secret");
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "secretId",
      "label",
      "payment",
      "botId",
      "createdAt",
      "requestId",
      "generation",
    ],
    ["origin"],
    "stored secret",
  );
  if (candidate.schemaVersion !== 1) {
    throw new SecretDecodeError("stored secret schemaVersion is unsupported");
  }
  const { schemaVersion: _, requestId, generation, ...view } = candidate;
  return {
    schemaVersion: 1,
    ...decodeSecretViewV1(view, "stored secret"),
    requestId: text(requestId, 128, "stored secret requestId"),
    generation: text(generation, 128, "stored secret generation"),
  };
}

export function secretViewV1(item: SecretItemV1): SecretViewV1 {
  return {
    secretId: item.secretId,
    label: item.label,
    payment: item.payment,
    ...(item.origin === undefined ? {} : { origin: item.origin }),
    botId: item.botId,
    createdAt: item.createdAt,
  };
}

export function decodeSecretListViewV1(value: unknown): SecretListViewV1 {
  const candidate = object(value, "secret list");
  exactKeys(candidate, ["schemaVersion", "secrets"], [], "secret list");
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.secrets)) {
    throw new SecretDecodeError("secret list is invalid");
  }
  return {
    schemaVersion: 1,
    secrets: candidate.secrets.map((secret) => decodeSecretViewV1(secret)),
  };
}

/**
 * What a person typing a secret posts. The value is never echoed in an
 * error: a refusal names the field and says what is wrong with its shape.
 */
export interface SecretSubmitCommandV1 {
  schemaVersion: 1;
  /** Minted once per value typed, so a retried post is the same save. */
  commandId: string;
  value: string;
}

const COMMAND_ID_PATTERN_V1 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function decodeSecretSubmitCommandV1(
  value: unknown,
): SecretSubmitCommandV1 {
  const candidate = object(value, "secret");
  exactKeys(candidate, ["schemaVersion", "commandId", "value"], [], "secret");
  if (candidate.schemaVersion !== 1) {
    throw new SecretDecodeError("secret schemaVersion is unsupported");
  }
  if (
    typeof candidate.commandId !== "string" ||
    !COMMAND_ID_PATTERN_V1.test(candidate.commandId)
  ) {
    throw new SecretDecodeError("secret commandId is invalid");
  }
  const typed = candidate.value;
  if (typeof typed !== "string" || typed.trim().length === 0) {
    throw new SecretDecodeError("Type the value before saving it.");
  }
  if (typed.length > SECRET_LIMITS_V1.value) {
    throw new SecretDecodeError(
      `A saved secret is at most ${SECRET_LIMITS_V1.value} characters.`,
    );
  }
  return { schemaVersion: 1, commandId: candidate.commandId, value: typed };
}

/**
 * One request as the Bot Durable Object recorded it when the card was drawn:
 * the terms the person is asked under, and where its field sits on the card.
 */
export interface SecretRequestRecordV1 {
  schemaVersion: 1;
  requestId: string;
  surfaceId: string;
  /** The ids of the card's `SecretField` components, which a save settles. */
  fieldIds: string[];
  label: string;
  prompt: string;
  origin?: string;
  payment: boolean;
  sessionId: string;
  runId: string;
  createdAt: string;
  state: "waiting" | "saved";
  secretId?: string;
  savedAt?: string;
}

export const SECRET_REQUEST_PREFIX_V1 = "secret-request:";

export function secretRequestKeyV1(requestId: string): string {
  return `${SECRET_REQUEST_PREFIX_V1}${requestId}`;
}

export function decodeSecretRequestRecordV1(
  value: unknown,
): SecretRequestRecordV1 {
  const label = "secret request";
  const candidate = object(value, label);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "requestId",
      "surfaceId",
      "fieldIds",
      "label",
      "prompt",
      "payment",
      "sessionId",
      "runId",
      "createdAt",
      "state",
    ],
    ["origin", "secretId", "savedAt"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new SecretDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isSecretRequestIdV1(candidate.requestId)) {
    throw new SecretDecodeError(`${label} requestId is invalid`);
  }
  if (candidate.state !== "waiting" && candidate.state !== "saved") {
    throw new SecretDecodeError(`${label} state is invalid`);
  }
  if (!Array.isArray(candidate.fieldIds)) {
    throw new SecretDecodeError(`${label} fieldIds is invalid`);
  }
  if (candidate.secretId !== undefined && !isSecretIdV1(candidate.secretId)) {
    throw new SecretDecodeError(`${label} secretId is invalid`);
  }
  return {
    schemaVersion: 1,
    requestId: candidate.requestId,
    surfaceId: text(candidate.surfaceId, 128, `${label} surfaceId`),
    fieldIds: candidate.fieldIds.map((id) =>
      text(id, 128, `${label} fieldIds`),
    ),
    label: text(candidate.label, SECRET_LIMITS_V1.label, `${label} label`),
    prompt: text(candidate.prompt, 2_000, `${label} prompt`),
    ...(candidate.origin === undefined
      ? {}
      : { origin: secretOriginV1(candidate.origin, `${label} origin`) }),
    payment: flag(candidate.payment, `${label} payment`),
    sessionId: text(candidate.sessionId, 512, `${label} sessionId`),
    runId: text(candidate.runId, 256, `${label} runId`),
    createdAt: timestamp(candidate.createdAt, `${label} createdAt`),
    state: candidate.state,
    ...(candidate.secretId === undefined
      ? {}
      : { secretId: candidate.secretId }),
    ...(candidate.savedAt === undefined
      ? {}
      : { savedAt: timestamp(candidate.savedAt, `${label} savedAt`) }),
  };
}

/**
 * One fill a person was asked to approve: which secret, into which field, on
 * which site. The approval is released against this record and nothing the
 * Bot says later, so an approved fill cannot be moved to another page.
 */
export interface SecretFillIntentV1 {
  schemaVersion: 1;
  approvalId: string;
  secretId: string;
  field: string;
  origin: string;
  runId: string;
  createdAt: string;
}

export const SECRET_FILL_INTENT_PREFIX_V1 = "secret-fill:";

export function secretFillIntentKeyV1(approvalId: string): string {
  return `${SECRET_FILL_INTENT_PREFIX_V1}${approvalId}`;
}

/** Where one fill Approval's single use is recorded as spent. */
export function secretFillUseKeyV1(approvalId: string): string {
  return `secret-fill-used:${approvalId}`;
}

export function decodeSecretFillIntentV1(value: unknown): SecretFillIntentV1 {
  const label = "secret fill";
  const candidate = object(value, label);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "approvalId",
      "secretId",
      "field",
      "origin",
      "runId",
      "createdAt",
    ],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1 || !isSecretIdV1(candidate.secretId)) {
    throw new SecretDecodeError(`${label} is invalid`);
  }
  return {
    schemaVersion: 1,
    approvalId: text(candidate.approvalId, 128, `${label} approvalId`),
    secretId: candidate.secretId,
    field: text(candidate.field, 512, `${label} field`),
    origin: secretOriginV1(candidate.origin, `${label} origin`),
    runId: text(candidate.runId, 256, `${label} runId`),
    createdAt: timestamp(candidate.createdAt, `${label} createdAt`),
  };
}

/**
 * Removes every occurrence of a value from text on its way out.
 *
 * The structural rule is that a value is never put into anything that leaves
 * — a result, an error, a log line. This is the belt for a failure the rule
 * did not foresee, like a browser echoing what it was asked to type.
 */
export function withoutSecretV1(text: string, value: string): string {
  return value.length === 0 ? text : text.split(value).join("[secret]");
}

/** What the save route answers: whether this post saved it, and the card. */
export interface SecretSubmitReceiptV1 {
  schemaVersion: 1;
  status: "saved" | "replayed";
  /** The card as it stands after the save, when this Bot still holds it. */
  card?: CardViewV1;
}

export function decodeSecretSubmitReceiptV1(
  value: unknown,
): SecretSubmitReceiptV1 {
  const candidate = object(value, "secret receipt");
  exactKeys(candidate, ["schemaVersion", "status"], ["card"], "secret receipt");
  if (
    candidate.schemaVersion !== 1 ||
    (candidate.status !== "saved" && candidate.status !== "replayed")
  ) {
    throw new SecretDecodeError("secret receipt is invalid");
  }
  return {
    schemaVersion: 1,
    status: candidate.status,
    ...(candidate.card === undefined
      ? {}
      : { card: decodeCardViewV1(candidate.card, "secret receipt card") }),
  };
}

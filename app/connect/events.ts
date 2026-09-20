// The deployment-wide door Connected app events arrive at, and the check
// that stands between the open internet and a User Durable Object.
//
// Composio POSTs every trigger and account event to one URL. The signature is
// HMAC-SHA256 of the raw body with `COMPOSIO_WEBHOOK_SECRET`. A body that does
// not verify never addresses an object. The User id in a verified event is
// the one this deployment passed when the account was connected, so it is
// the id we stub.

import { bytesToHexV1, constantTimeEqualsV1 } from "@frockbot/core/crypto";

/** Longest event body the door reads. */
export const CONNECT_EVENT_BODY_MAX_BYTES = 64 * 1024;

const TEXT = new TextEncoder();

export type ConnectEventKindV1 =
  | "trigger.message"
  | "trigger.disabled"
  | "connected_account.expired";

export interface ConnectEventV1 {
  kind: ConnectEventKindV1;
  eventId: string;
  userId: string;
  triggerInstanceId?: string;
  connectedAccountId?: string;
  triggerSlug?: string;
  payload: unknown;
}

export class ConnectEventError extends Error {
  override readonly name = "ConnectEventError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

/** HMAC-SHA256 of UTF-8 text, lower-case hex. */
export async function connectEventSignatureV1(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHexV1(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, TEXT.encode(body))),
  );
}

/**
 * The presented signature, stripped of the prefixes a sender may attach.
 * `sha256=<hex>`, `v1,<hex>` and a bare hex all mean the same bytes.
 */
export function normalizeConnectEventSignatureV1(presented: string): string {
  const trimmed = presented.trim();
  const prefixed = /^(?:sha256=|v1,)/i.exec(trimmed);
  return (prefixed ? trimmed.slice(prefixed[0].length) : trimmed)
    .trim()
    .toLowerCase();
}

/** Verify the body against the deployment secret. A miss is a 401. */
export async function verifyConnectEventSignatureV1(
  secret: string,
  body: string,
  presented: string,
): Promise<void> {
  if (!secret.trim() || !presented.trim()) {
    throw new ConnectEventError(401, "event signature is invalid");
  }
  const expected = await connectEventSignatureV1(secret, body);
  const given = normalizeConnectEventSignatureV1(presented);
  if (!constantTimeEqualsV1(expected, given)) {
    throw new ConnectEventError(401, "event signature is invalid");
  }
}

/**
 * The event the door can act on. Unknown kinds are refused rather than
 * silently dropped: a new kind we have not opened is a visible failure.
 */
export function decodeConnectEventV1(value: unknown): ConnectEventV1 {
  const root = asRecord(value);
  if (!root) throw new ConnectEventError(400, "event is invalid");
  const data = asRecord(root.data) ?? asRecord(root.metadata) ?? {};
  const type = stringField(root, "type", "event_type") ?? "";
  const kind = eventKindV1(type);
  if (!kind) throw new ConnectEventError(400, "event kind is unknown");
  const eventId = stringField(
    root,
    "id",
    "event_id",
    "log_id",
    "logId",
  );
  const userId = stringField(data, "user_id", "userId") ??
    stringField(root, "user_id", "userId");
  if (!eventId || !userId) {
    throw new ConnectEventError(400, "event omitted its id or user");
  }
  const triggerInstanceId = stringField(
    data,
    "trigger_nano_id",
    "trigger_id",
    "triggerId",
    "id",
  );
  const connectedAccountId = stringField(
    data,
    "connected_account_id",
    "connectedAccountId",
  );
  const triggerSlug = stringField(
    data,
    "trigger_slug",
    "triggerSlug",
    "trigger_name",
  );
  return {
    kind,
    eventId: eventId.slice(0, 256),
    userId: userId.slice(0, 256),
    ...(triggerInstanceId
      ? { triggerInstanceId: triggerInstanceId.slice(0, 256) }
      : {}),
    ...(connectedAccountId
      ? { connectedAccountId: connectedAccountId.slice(0, 256) }
      : {}),
    ...(triggerSlug ? { triggerSlug: triggerSlug.slice(0, 256) } : {}),
    payload: data.payload ?? data,
  };
}

function eventKindV1(type: string): ConnectEventKindV1 | undefined {
  const normalised = type
    .trim()
    .toLowerCase()
    .replace(/^composio\./, "");
  if (
    normalised === "trigger.message" ||
    normalised === "trigger_instance.payload" ||
    normalised === "trigger"
  ) {
    return "trigger.message";
  }
  if (
    normalised === "trigger.disabled" ||
    normalised === "trigger_instance.disabled"
  ) {
    return "trigger.disabled";
  }
  if (
    normalised === "connected_account.expired" ||
    normalised === "connected_account.inactive"
  ) {
    return "connected_account.expired";
  }
  return undefined;
}

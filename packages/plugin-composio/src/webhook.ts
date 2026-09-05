import { object } from "./tool-contracts.js";

export interface ComposioTriggerEventV1 {
  schemaVersion: 1;
  eventId: string;
  accountId: string;
  triggerId: string;
  triggerType: string;
  data: unknown;
}
export class TriggerWebhookError extends Error {
  constructor(readonly status: number) {
    super("Event delivery was refused");
  }
}
/** Verify the raw bytes before parsing; neither payload identity nor a session routes this event. */
export async function verifyComposioWebhook(
  request: Request,
  secret: string,
  now = Date.now(),
): Promise<ComposioTriggerEventV1> {
  const id = request.headers.get("webhook-id"),
    timestamp = request.headers.get("webhook-timestamp"),
    signatures = request.headers.get("webhook-signature");
  if (
    !id ||
    id.length > 200 ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !signatures ||
    signatures.length > 4096 ||
    Math.abs(now - Number(timestamp) * 1000) > 300_000
  )
    throw new TriggerWebhookError(401);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader)
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 64_000) {
        await reader.cancel();
        throw new TriggerWebhookError(413);
      }
      chunks.push(chunk.value);
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const message = new Uint8Array(prefix.length + bytes.length);
  message.set(prefix);
  message.set(bytes, prefix.length);
  let verified = false;
  for (const candidate of signatures.split(" ")) {
    if (!candidate.startsWith("v1,")) continue;
    try {
      const signature = Uint8Array.from(atob(candidate.slice(3)), (character) =>
        character.charCodeAt(0),
      );
      if (
        signature.length === 32 &&
        (await crypto.subtle.verify("HMAC", key, signature, message))
      )
        verified = true;
    } catch {
      /* Another rotated signature may match. */
    }
  }
  if (!verified) throw new TriggerWebhookError(401);
  try {
    return decodeComposioTriggerEvent(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new TriggerWebhookError(400);
  }
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
}
export function decodeComposioTriggerEvent(
  value: unknown,
): ComposioTriggerEventV1 {
  if (
    !object(value) ||
    value.type !== "composio.trigger.message" ||
    !identifier(value.id) ||
    !object(value.metadata) ||
    !identifier(value.metadata.connected_account_id) ||
    !identifier(value.metadata.trigger_id) ||
    !identifier(value.metadata.trigger_slug) ||
    !Object.hasOwn(value, "data")
  )
    throw new TriggerWebhookError(400);
  return {
    schemaVersion: 1,
    eventId: value.id,
    accountId: value.metadata.connected_account_id,
    triggerId: value.metadata.trigger_id,
    triggerType: value.metadata.trigger_slug,
    data: value.data,
  };
}

/** The private User RPC and stored receipt share this bounded current DTO. */
export function decodeStoredComposioTriggerEvent(
  value: unknown,
): ComposioTriggerEventV1 {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some(
      (key) =>
        ![
          "schemaVersion",
          "eventId",
          "accountId",
          "triggerId",
          "triggerType",
          "data",
        ].includes(key),
    ) ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 64_000
  )
    throw new TriggerWebhookError(400);
  return decodeComposioTriggerEvent({
    id: value.eventId,
    type: "composio.trigger.message",
    metadata: {
      connected_account_id: value.accountId,
      trigger_id: value.triggerId,
      trigger_slug: value.triggerType,
    },
    data: value.data,
  });
}

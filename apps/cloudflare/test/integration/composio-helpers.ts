import { SELF } from "cloudflare:test";

/** A provider delivery at the real public gateway; identity claims have no authority. */
export async function deliverComposioEvent(input: {
  eventId: string;
  accountId: string;
  triggerId: string;
  triggerType: string;
  data: Record<string, unknown>;
  secret?: string;
}): Promise<Response> {
  const body = JSON.stringify({
    id: input.eventId,
    type: "composio.trigger.message",
    metadata: {
      connected_account_id: input.accountId,
      trigger_id: input.triggerId,
      trigger_slug: input.triggerType,
      user_id: "another-user",
      bot_id: "another-bot",
      routine_id: "another-routine",
    },
    data: input.data,
  });
  const id = `delivery-${input.eventId}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret ?? "test-provider-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${id}.${timestamp}.${body}`),
        ),
      ),
    ),
  );
  return SELF.fetch("https://frockbot.test/api/plugins/composio/events", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
    body,
  });
}

export async function toolkitNamespace(
  toolkit: string,
  connectionId: string,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(connectionId),
  );
  return `${toolkit}--${Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)}`;
}

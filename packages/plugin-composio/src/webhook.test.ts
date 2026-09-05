import { expect, test } from "bun:test";
import { verifyComposioWebhook } from "./webhook.js";

const secret = "whsec_literal-secret-not-base64";
const event = {
  id: "msg_event",
  type: "composio.trigger.message",
  metadata: {
    trigger_id: "ti_one",
    trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
    connected_account_id: "ca_one",
    user_id: "untrusted-user",
    botId: "untrusted-bot",
  },
  data: { subject: "Café ☕" },
};
async function signed(
  body = JSON.stringify(event),
  timestamp = Math.floor(Date.now() / 1000),
) {
  const headers = new Headers({
    "webhook-id": "msg_delivery",
    "webhook-timestamp": String(timestamp),
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`msg_delivery.${timestamp}.${body}`),
    ),
  );
  headers.set("webhook-signature", `v1,${btoa(String.fromCharCode(...mac))}`);
  return new Request("https://bot.test/api/plugins/composio/events", {
    method: "POST",
    headers,
    body,
  });
}
test("verifies literal-secret signatures over raw UTF-8 and drops event-supplied routing identities", async () => {
  expect(await verifyComposioWebhook(await signed(), secret)).toEqual({
    schemaVersion: 1,
    eventId: "msg_event",
    accountId: "ca_one",
    triggerId: "ti_one",
    triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    data: event.data,
  });
});
test("tampering, stale timestamps, future timestamps and unsigned bytes fail before routing", async () => {
  const original = await signed();
  await expect(
    verifyComposioWebhook(
      new Request(original.url, {
        method: "POST",
        headers: original.headers,
        body: "{}",
      }),
      secret,
    ),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    verifyComposioWebhook(await signed(), "different"),
  ).rejects.toMatchObject({ status: 401 });
  for (const seconds of [-301, 301])
    await expect(
      verifyComposioWebhook(
        await signed(undefined, Math.floor(Date.now() / 1000) + seconds),
        secret,
      ),
    ).rejects.toMatchObject({ status: 401 });
  await expect(
    verifyComposioWebhook(await signed("x".repeat(64_001)), secret),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    verifyComposioWebhook(await signed("not json"), secret),
  ).rejects.toMatchObject({ status: 400 });
});
test("a rotated signature list accepts its matching entry", async () => {
  const request = await signed();
  request.headers.set(
    "webhook-signature",
    `v1,invalid ${request.headers.get("webhook-signature")}`,
  );
  expect((await verifyComposioWebhook(request, secret)).eventId).toBe(event.id);
});

test("the public route checks the signature before any provider or User call and binds routing to provider lookup", async () => {
  const { composioEventRoute } = await import("./webhook-route.js");
  let providerReads = 0;
  const routed: Array<{ userId: string; input: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      providerReads++;
      return Response.json({
        id: "ca_one",
        user_id: "durable-owner",
        alias: "frock-issued-connection",
        status: "ACTIVE",
        toolkit: { slug: "gmail" },
      });
    },
  });
  const host = {
    callbackBaseUrl: "https://bot.test",
    readSecret: (name: string) =>
      ({
        COMPOSIO_API_KEY: "backend-only",
        COMPOSIO_WEBHOOK_SECRET: secret,
        COMPOSIO_TEST_URL: `${server.url}api/v3.1`,
      })[name],
    composioRequest: async (userId: string, input: unknown) => {
      routed.push({ userId, input });
      return { schemaVersion: 1, status: "accepted" };
    },
  };
  try {
    const url = new URL("https://bot.test/api/plugins/composio/events");
    expect(
      (
        await composioEventRoute(
          host,
          new Request(url, { method: "POST", body: "{}" }),
          url,
        )
      )?.status,
    ).toBe(401);
    expect(providerReads).toBe(0);
    expect(routed).toHaveLength(0);
    expect((await composioEventRoute(host, await signed(), url))?.status).toBe(
      202,
    );
    expect(providerReads).toBe(1);
    expect(routed).toEqual([
      {
        userId: "durable-owner",
        input: {
          schemaVersion: 1,
          operation: "deliver-event",
          event: {
            schemaVersion: 1,
            eventId: "msg_event",
            accountId: "ca_one",
            triggerId: "ti_one",
            triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
            data: event.data,
          },
        },
      },
    ]);
    expect(
      (
        await composioEventRoute(
          {
            ...host,
            composioRequest: async () => {
              throw new Error("not durable yet");
            },
          },
          await signed(),
          url,
        )
      )?.status,
    ).toBe(503);
    expect(
      (
        await composioEventRoute(
          { ...host, readSecret: () => undefined },
          await signed(),
          url,
        )
      )?.status,
    ).toBe(503);
  } finally {
    await server.stop(true);
  }
});

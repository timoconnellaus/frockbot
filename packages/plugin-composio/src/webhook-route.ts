import { ComposioClient } from "./composio-client.js";
import { TriggerWebhookError, verifyComposioWebhook } from "./webhook.js";
import type { ComposioBackendHost } from "./backend.js";

/** The edge verifies provenance and obtains only a routing hint; the User binds durable subscriptions. */
export async function composioEventRoute(
  host: ComposioBackendHost,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (url.pathname !== "/api/plugins/composio/events") return undefined;
  if (request.method !== "POST")
    return Response.json({ error: "method not allowed" }, { status: 405 });
  const apiKey = host.readSecret?.("COMPOSIO_API_KEY"),
    secret = host.readSecret?.("COMPOSIO_WEBHOOK_SECRET");
  if (!apiKey || !secret || !host.composioRequest)
    return Response.json(
      { error: "Event delivery is unavailable" },
      { status: 503 },
    );
  try {
    const event = await verifyComposioWebhook(request, secret);
    const client = new ComposioClient({
      apiKey,
      baseUrl: host.readSecret?.("COMPOSIO_TEST_URL"),
    });
    const account = await client.getConnectedAccount(event.accountId);
    if (account.id !== event.accountId || !account.userId || !account.alias)
      throw new TriggerWebhookError(400);
    const receipt = await host.composioRequest(account.userId, {
      schemaVersion: 1,
      operation: "deliver-event",
      event,
    });
    if (
      !receipt ||
      typeof receipt !== "object" ||
      !("schemaVersion" in receipt) ||
      receipt.schemaVersion !== 1 ||
      !("status" in receipt) ||
      receipt.status !== "accepted"
    )
      throw new Error("Event was not admitted");
    return Response.json(
      { schemaVersion: 1, status: "accepted" },
      { status: 202 },
    );
  } catch (error) {
    return Response.json(
      { error: "Event delivery was refused" },
      { status: error instanceof TriggerWebhookError ? error.status : 503 },
    );
  }
}

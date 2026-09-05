import {
  SELF,
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it } from "vitest";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  listStoredRunsWithEventsV1,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  settledRoutineFiringV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";
useApplicationArtifact();

async function delivery(
  connectionId: string,
  eventId: string,
  signatureSecret = "test-provider-webhook-secret",
) {
  const body = JSON.stringify({
    id: eventId,
    type: "composio.trigger.message",
    metadata: {
      connected_account_id: `ca_${connectionId}`,
      trigger_id: `ti_ca_${connectionId}`,
      trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE",
      // These signed provider claims are deliberately wrong: neither can choose a destination.
      user_id: "another-user",
      bot_id: "another-bot",
      routine_id: "another-routine",
    },
    data: {
      subject: "A new message for the Routine",
      from: "hello@example.com",
    },
  });
  const id = `delivery-${eventId}`,
    timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signatureSecret),
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
it("a Bot creates a Gmail event Routine from chat; signed delivery survives eviction and replay fires once", async () => {
  const userId = freshUserId("gmail-events"),
    botId = "event-bot",
    connectionId = "routine-gmail";
  await provisionThroughGateway({ userId, botId });
  const start = await postAsUser(userId, "/api/plugins/composio/connections", {
    schemaVersion: 1,
    type: "connection/start",
    commandId: connectionId,
    connectionTypeId: "app",
    connectorId: "gmail",
    alias: "Work inbox",
  });
  expect(start.status).toBe(201);
  const link = (await start.json()) as { redirectUrl: string };
  expect(
    (await SELF.fetch(link.redirectUrl, { redirect: "manual" })).status,
  ).toBe(303);
  const catalog = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/routines/triggers`),
  )) as { items: unknown[] };
  expect(catalog.items).toEqual([
    expect.objectContaining({
      connectionId,
      name: "When a new email arrives in Gmail",
    }),
  ]);
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "create-event-routine",
      text:
        "When a new email arrives in Gmail, summarize it for me.\n" +
        toolCallTriggerPrompt(
          ["routine_manage", { action: "list_triggers" }],
          [
            "routine_manage",
            {
              action: "create",
              routineId: "email-summary",
              name: "New email summary",
              prompt: "Summarize the new email in the event input.",
              trigger: {
                composio: {
                  connectionId,
                  triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
                  config: {},
                },
              },
            },
          ],
        ),
    }),
  );
  const chat = await readStoredRunWithEventsV1<{ events: SessionEvent[] }>(
    userId,
    botId,
    "create-event-routine",
  );
  const results = chat!.events.filter(
    (event) => event.type === "tool/result" && event.name === "routine_manage",
  );
  expect(results).toHaveLength(2);
  expect(
    results.every((event) => event.type === "tool/result" && !event.isError),
  ).toBe(true);
  const list = () =>
    asUser(userId, `/api/bots/${botId}/routines`).then(
      expectOkJson,
    ) as Promise<{
      routines: Array<{
        eventStatus: string;
        createdBy: unknown;
        hookKeyVersion?: number;
      }>;
    }>;
  expect((await list()).routines[0]).toMatchObject({
    eventStatus: "active",
    createdBy: { kind: "bot", botId },
  });
  expect((await list()).routines[0]?.hookKeyVersion).toBeUndefined();
  expect(
    (await delivery(connectionId, "msg_invalid", "wrong-secret")).status,
  ).toBe(401);
  const bot = env.BOT_STATES.getByName(`${userId}:${botId}`);
  await evictDurableObject(bot);
  expect((await delivery(connectionId, "msg_first")).status).toBe(202);
  await evictDurableObject(bot);
  await runDurableObjectAlarm(bot);
  const firing = await settledRoutineFiringV1<{
    runId: string;
    status: string;
    events: SessionEvent[];
    admission: { turnType: string; origin?: { routineId?: string } };
  }>(userId, botId, "email-summary");
  expect(firing.admission.turnType).toBe("automation");
  expect(
    JSON.stringify(
      firing.events.filter((event) => event.type === "user/message"),
    ),
  ).toContain("A new message for the Routine");
  expect(JSON.stringify(firing.events)).not.toContain(
    "test-provider-webhook-secret",
  );
  expect((await delivery(connectionId, "msg_first")).status).toBe(202);
  await runDurableObjectAlarm(bot);
  const runs = await listStoredRunsWithEventsV1<{
    admission?: { turnType: string };
  }>(userId, botId);
  expect(
    runs.filter((run) => run.admission?.turnType === "automation"),
  ).toHaveLength(1);
  const command = async (type: string, commandId: string) =>
    expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type,
        commandId,
        botId,
        routineId: "email-summary",
      }),
    );
  await command("routine/pause", "pause-event");
  expect((await list()).routines[0]?.eventStatus).toBe("paused");
  expect((await delivery(connectionId, "msg_paused")).status).toBe(202);
  await command("routine/resume", "resume-event");
  expect((await list()).routines[0]?.eventStatus).toBe("active");
  // The replay tombstone persists after a pause and a fresh object instance.
  await evictDurableObject(bot);
  expect((await delivery(connectionId, "msg_paused")).status).toBe(202);
  expect((await delivery(connectionId, "msg_first")).status).toBe(202);
  await command("routine/delete", "delete-event");
  expect((await list()).routines).toHaveLength(0);
  await runInDurableObject(
    env.USER_CONFIGURATIONS.getByName(userId),
    async (_instance, state) => {
      const groups = await state.storage.list<{ status: string }>({
        prefix: "composio:trigger-group:",
      });
      expect([...groups.values()].map((item) => item.status)).toEqual([
        "deleted",
      ]);
    },
  );
});

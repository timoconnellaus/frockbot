import { expect, test } from "bun:test";
import type { RoutineSubscriptionIntentV1 } from "@frockbot/connection-core";
import { RoutineStore } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import {
  flushRoutineSubscriptionsV1,
  routineSubscriptionDeadlinesV1,
} from "./subscriptions.js";

const trigger = {
  kind: "connection" as const,
  connectionId: "gmail-work",
  triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
  config: {},
};
test("the Routine and its subscription outbox survive reconstruction; a lost acknowledgement resends the same intent", async () => {
  const storage = createMemoryRoutineStorageV1();
  const make = () => new RoutineStore(storage);
  await make().execute(
    {
      schemaVersion: 1,
      type: "routine/create",
      commandId: "create",
      botId: "bot",
      routineId: "email",
      name: "Email",
      prompt: "Read the new message",
      trigger,
    },
    { kind: "user" },
  );
  const sent: RoutineSubscriptionIntentV1[] = [];
  await flushRoutineSubscriptionsV1(
    storage,
    async (intent) => {
      sent.push(intent);
      throw new Error("ack lost");
    },
    true,
  );
  expect(await routineSubscriptionDeadlinesV1(storage)).toHaveLength(1);
  await flushRoutineSubscriptionsV1(
    storage,
    async (intent) => {
      sent.push(intent);
      return { schemaVersion: 1, status: "recorded" };
    },
    true,
  );
  expect(sent[0]).toEqual(sent[1]);
  expect(await routineSubscriptionDeadlinesV1(storage)).toHaveLength(0);
  await make().execute(
    {
      schemaVersion: 1,
      type: "routine/pause",
      commandId: "pause",
      botId: "bot",
      routineId: "email",
    },
    { kind: "user" },
  );
  await flushRoutineSubscriptionsV1(
    storage,
    async (intent) => {
      sent.push(intent);
      return { schemaVersion: 1, status: "recorded" };
    },
    true,
  );
  expect(sent[2]).toMatchObject({
    subscriptionId: sent[0]!.subscriptionId,
    enabled: false,
    revision: 2,
  });
  await make().execute(
    {
      schemaVersion: 1,
      type: "routine/delete",
      commandId: "delete",
      botId: "bot",
      routineId: "email",
    },
    { kind: "user" },
  );
  await flushRoutineSubscriptionsV1(
    storage,
    async (intent) => {
      sent.push(intent);
      return { schemaVersion: 1, status: "recorded" };
    },
    true,
  );
  expect(sent[3]).toMatchObject({
    subscriptionId: sent[0]!.subscriptionId,
    enabled: false,
    deleted: true,
    revision: 3,
  });
});

test("event admission uses the hook queue, keeps replay receipts beyond a day, and fences changed subscriptions", async () => {
  const storage = createMemoryRoutineStorageV1();
  let now = new Date("2026-09-05T00:00:00Z"),
    firings = 0;
  const make = () =>
    new RoutineStore(storage, {
      now: () => now,
      firings: {
        enqueueWithin: async () => ({
          fireId: `fire-${++firings}`,
          queued: false,
        }),
      },
    });
  await make().execute(
    {
      schemaVersion: 1,
      type: "routine/create",
      commandId: "create",
      botId: "bot",
      routineId: "email",
      name: "Email",
      prompt: "Read the new message",
      trigger,
    },
    { kind: "user" },
  );
  const subscriptionId = await storage.get<string>(
    "routine-subscription-current:email",
  );
  const event = {
    routineId: "email",
    subscriptionId: subscriptionId!,
    deliveryId: "a".repeat(64),
    body: '{"subject":"Hello"}',
  };
  expect((await make().deliverHook(event)).status).toBe("accepted");
  now = new Date("2026-09-09T00:00:00Z");
  expect((await make().deliverHook(event)).status).toBe("duplicate");
  expect(firings).toBe(1);
  await make().execute(
    {
      schemaVersion: 1,
      type: "routine/update",
      commandId: "change",
      botId: "bot",
      routineId: "email",
      trigger: { ...trigger, config: { label: "Important" } },
    },
    { kind: "user" },
  );
  expect(await storage.get("routine-subscription-current:email")).not.toBe(
    subscriptionId,
  );
  await expect(
    make().deliverHook({ ...event, deliveryId: "b".repeat(64) }),
  ).rejects.toMatchObject({ status: 401 });
  expect(firings).toBe(1);
});

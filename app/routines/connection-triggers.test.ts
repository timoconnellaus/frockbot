import { describe, expect, test } from "bun:test";
import { RoutineScheduler } from "./scheduler.js";
import { RoutineStore } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import type { RoutineCommandV1 } from "./shared.js";

const USER = { kind: "user" as const };

function harness() {
  const storage = createMemoryRoutineStorageV1();
  const scheduler = new RoutineScheduler(storage);
  const store = new RoutineStore(storage, { firings: scheduler });
  const create: RoutineCommandV1 = {
    schemaVersion: 1,
    type: "routine/create",
    commandId: "cmd-create",
    botId: "scout",
    routineId: "inbox",
    name: "New mail",
    prompt: "Tell the User what arrived.",
    trigger: {
      kind: "connection",
      connectionId: "conn-gmail",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    },
  };
  return { store, create };
}

describe("a connected-app Routine firing", () => {
  test("accepts one event and replays a second copy as a duplicate", async () => {
    const { store, create } = harness();
    await store.execute(create, USER, "Australia/Sydney");
    const first = await store.deliverConnectEvent({
      routineId: "inbox",
      eventId: "evt_1",
      payload: { subject: "Hello" },
    });
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted") throw new Error("unreachable");
    const again = await store.deliverConnectEvent({
      routineId: "inbox",
      eventId: "evt_1",
      payload: { subject: "Hello" },
    });
    expect(again).toEqual({ status: "duplicate", fireId: first.fireId });
  });

  test("refuses a paused Routine and one that is not an app-event trigger", async () => {
    const { store, create } = harness();
    await store.execute(create, USER, "Australia/Sydney");
    await store.execute(
      {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: "cmd-pause",
        botId: "scout",
        routineId: "inbox",
      },
      USER,
      "Australia/Sydney",
    );
    await expect(
      store.deliverConnectEvent({
        routineId: "inbox",
        eventId: "evt_2",
        payload: {},
      }),
    ).rejects.toThrow(/paused/);

    const scheduled = new RoutineStore(createMemoryRoutineStorageV1(), {
      firings: new RoutineScheduler(createMemoryRoutineStorageV1()),
    });
    await scheduled.execute(
      {
        schemaVersion: 1,
        type: "routine/create",
        commandId: "cmd-cron",
        botId: "scout",
        routineId: "brief",
        name: "Brief",
        prompt: "Do it",
        schedule: "@daily",
      },
      USER,
      "Australia/Sydney",
    );
    await expect(
      scheduled.deliverConnectEvent({
        routineId: "brief",
        eventId: "evt_3",
        payload: {},
      }),
    ).rejects.toThrow(/app-event/);
  });
});

import { describe, expect, test } from "bun:test";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  executeRoutineCommand,
  routineIdFromCommandV1,
  type RoutineConnectionTriggerSeamV1,
} from "./bot.js";
import { routineEventEvidenceV1 } from "./event-judge.js";
import { ROUTINE_HOOK_CUE_MAX_BYTES } from "./hook.js";
import { RoutineScheduler } from "./scheduler.js";
import { RoutineStore } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import type { RoutineCommandV1 } from "./shared.js";

const USER = { kind: "user" as const };
const IDENTITY = { userId: "owner", botId: "scout" };

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
  return { store, create, scheduler, storage };
}

function commandHarness() {
  const { store, create, storage } = harness();
  const deletes: string[] = [];
  const upserts: string[] = [];
  const connectionTriggers: RoutineConnectionTriggerSeamV1 = {
    list: async () => [],
    upsert: async (input) => {
      upserts.push(input.routineId);
      return { routineId: upserts[0] ?? input.routineId };
    },
    delete: async (input) => {
      deletes.push(input.routineId);
    },
  };
  const state = {
    routines: store,
    ctx: { storage },
    authority: {
      refreshRecoveryAlarm: async () => undefined,
    },
  } as unknown as ShellBotStateV1;
  return { create, deletes, upserts, connectionTriggers, state };
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

  test("drops a paused Routine and one that is not an app-event trigger", async () => {
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
    expect(
      await store.deliverConnectEvent({
        routineId: "inbox",
        eventId: "evt_2",
        payload: {},
      }),
    ).toEqual({ status: "dropped", reason: "Routine is paused" });

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
    expect(
      await scheduled.deliverConnectEvent({
        routineId: "brief",
        eventId: "evt_3",
        payload: {},
      }),
    ).toEqual({
      status: "dropped",
      reason: "Routine is not an app-event trigger",
    });
  });

  test("classification sees the standalone event, not the webhook wrapper", async () => {
    const { store, create, scheduler } = harness();
    await store.execute(create, USER, "Australia/Sydney");
    const payload = {
      payload: {
        mimeType: "multipart/alternative",
        parts: Array.from({ length: 80 }, (_, index) => ({
          mimeType: "text/plain",
          body: `part-${index}-${"x".repeat(80)}`,
        })),
      },
      subject: "Your Amazon order has shipped",
      sender: "ship-confirm@amazon.com",
      snippet: "Track your package.",
      labels: ["INBOX"],
    };
    expect(JSON.stringify(payload).length).toBeGreaterThan(
      ROUTINE_HOOK_CUE_MAX_BYTES,
    );
    expect(
      await store.deliverConnectEvent({
        routineId: "inbox",
        eventId: "evt_ship",
        payload,
      }),
    ).toMatchObject({ status: "accepted" });
    const routine = await store.read("inbox");
    let projected: ReturnType<typeof routineEventEvidenceV1>;
    await scheduler.settle(async (fire) => {
      projected = routineEventEvidenceV1({ fire, routine });
      return { status: "ok", summary: "done" };
    }, "Australia/Sydney");
    expect(projected?.payload).toEqual({
      subject: "Your Amazon order has shipped",
      sender: "ship-confirm@amazon.com",
      snippet: "Track your package.",
      labels: ["INBOX"],
    });
  });
});

describe("a connected-app Routine leaving that state", () => {
  test("deletes the provider instance on pause and on rewrite to webhook", async () => {
    const { create, deletes, upserts, connectionTriggers, state } =
      commandHarness();
    await executeRoutineCommand(
      state,
      IDENTITY,
      create,
      USER,
      connectionTriggers,
    );
    expect(upserts).toEqual(["inbox"]);
    await executeRoutineCommand(
      state,
      IDENTITY,
      {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: "cmd-pause",
        botId: "scout",
        routineId: "inbox",
      },
      USER,
      connectionTriggers,
    );
    expect(deletes).toEqual(["inbox"]);

    const rewritten = commandHarness();
    await executeRoutineCommand(
      rewritten.state,
      IDENTITY,
      rewritten.create,
      USER,
      rewritten.connectionTriggers,
    );
    await executeRoutineCommand(
      rewritten.state,
      IDENTITY,
      {
        schemaVersion: 1,
        type: "routine/update",
        commandId: "cmd-webhook",
        botId: "scout",
        routineId: "inbox",
        trigger: { kind: "webhook" },
      },
      USER,
      rewritten.connectionTriggers,
    );
    expect(rewritten.deletes).toEqual(["inbox"]);
  });

  test("keeps the instance when only the name changes, and upserts again on resume", async () => {
    const { create, deletes, upserts, connectionTriggers, state } =
      commandHarness();
    await executeRoutineCommand(
      state,
      IDENTITY,
      create,
      USER,
      connectionTriggers,
    );
    await executeRoutineCommand(
      state,
      IDENTITY,
      {
        schemaVersion: 1,
        type: "routine/update",
        commandId: "cmd-rename",
        botId: "scout",
        routineId: "inbox",
        name: "Inbox watch",
      },
      USER,
      connectionTriggers,
    );
    expect(deletes).toEqual([]);
    await executeRoutineCommand(
      state,
      IDENTITY,
      {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: "cmd-pause",
        botId: "scout",
        routineId: "inbox",
      },
      USER,
      connectionTriggers,
    );
    expect(deletes).toEqual(["inbox"]);
    await executeRoutineCommand(
      state,
      IDENTITY,
      {
        schemaVersion: 1,
        type: "routine/resume",
        commandId: "cmd-resume",
        botId: "scout",
        routineId: "inbox",
      },
      USER,
      connectionTriggers,
    );
    expect(upserts).toEqual(["inbox", "inbox"]);
    expect(deletes).toEqual(["inbox"]);
  });
});

describe("a connected-app create that names no Routine id", () => {
  test("a retried command writes one Routine and one instance", async () => {
    const { connectionTriggers, state, upserts } = commandHarness();
    const unnamed: RoutineCommandV1 = {
      schemaVersion: 1,
      type: "routine/create",
      commandId: "cmd-create",
      botId: "scout",
      name: "New mail",
      prompt: "Tell the User what arrived.",
      trigger: {
        kind: "connection",
        connectionId: "conn-gmail",
        triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
      },
    };
    const first = await executeRoutineCommand(
      state,
      IDENTITY,
      unnamed,
      USER,
      connectionTriggers,
    );
    const again = await executeRoutineCommand(
      state,
      IDENTITY,
      unnamed,
      USER,
      connectionTriggers,
    );
    const expected = routineIdFromCommandV1("cmd-create");
    expect(first).toMatchObject({
      status: "applied",
      routine: { routineId: expected },
    });
    expect(again).toMatchObject({
      status: "applied",
      routine: { routineId: expected },
    });
    expect(upserts).toEqual([expected, expected]);
    expect(
      (await state.routines.list("scout", undefined, "Australia/Sydney"))
        .routines,
    ).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import type { CompositionGenerationV1 } from "@frockbot/core/durable";
import {
  MACHINE_LIMITS_V1,
  type MachineModuleEventV1,
} from "@frockbot/core/machine-protocol";
import {
  ROUTINE_DELIVERY_TTL_MS,
  ROUTINE_HOOK_BODY_MAX_BYTES,
} from "@frockbot/app/routines/hook";
import { machineModulesV1 } from "@frockbot/app/machine/modules";
import { createMemoryRoutineStorageV1 } from "@frockbot/app/routines/testing";
import {
  MODULE_EVENT_SEEN_LIMIT_V1,
  moduleEventDeliveryV1,
  moduleEventSeenV1,
  moduleEventTargetsV1,
  pluginTriggerIndexBuiltV1,
  readModuleEventLastKeysV1,
  readModuleRoutingV1,
  readPluginTriggerRoutinesV1,
  rebuildPluginTriggerIndexV1,
  recordModuleEventV1,
  refuseModuleEventV1,
  syncPluginTriggerRoutineV1,
  trimModuleEventsSeenV1,
} from "./module-events.js";

const generation = {
  members: [
    {
      packageId: "beeper",
      descriptor: {
        device: {
          abilities: [],
          modules: [
            {
              id: "bridge",
              platforms: ["macos"],
              read: [],
              net: [],
              appleEvents: [],
              calls: [],
              events: ["message", "typing"],
            },
          ],
        },
      },
      modules: [{ id: "bridge", contentHash: "b".repeat(64), size: 10 }],
    },
    { packageId: "tuner", descriptor: {} },
  ],
} as unknown as CompositionGenerationV1;

const event: MachineModuleEventV1 = {
  pluginId: "beeper",
  moduleId: "bridge",
  event: "message",
  key: "evt-1",
  payload: { text: "hi" },
};

const NOW = new Date("2026-09-25T00:00:00.000Z");

describe("a module event's admission", () => {
  test("the payload ceiling is the webhook door's", () => {
    expect(MACHINE_LIMITS_V1.moduleEventPayloadBytes).toBe(
      ROUTINE_HOOK_BODY_MAX_BYTES,
    );
  });

  test("needs the Plugin, the module and the event in the active generation", () => {
    expect(refuseModuleEventV1(generation, event)).toBeUndefined();
    expect(
      refuseModuleEventV1(generation, { ...event, pluginId: "stranger" }),
    ).toBe('plugin "stranger" is not in the active generation');
    expect(
      refuseModuleEventV1(generation, { ...event, pluginId: "tuner" }),
    ).toBe('plugin "tuner" carries no module "bridge"');
    expect(
      refuseModuleEventV1(generation, { ...event, moduleId: "other" }),
    ).toBe('plugin "beeper" carries no module "other"');
    expect(refuseModuleEventV1(generation, { ...event, event: "read" })).toBe(
      'module "bridge" declares no event "read"',
    );
  });

  test("a key is seen once per machine and Plugin, inside the window", async () => {
    const storage = createMemoryRoutineStorageV1();
    const origin = { machineId: "mac-1", pluginId: "beeper", key: "evt-1" };
    expect(await moduleEventSeenV1(storage, { ...origin, now: NOW })).toBe(
      false,
    );
    await recordModuleEventV1(storage, {
      machineId: "mac-1",
      event,
      now: NOW,
    });
    expect(await moduleEventSeenV1(storage, { ...origin, now: NOW })).toBe(
      true,
    );
    // Another machine's copy of the same occurrence is its own.
    expect(
      await moduleEventSeenV1(storage, {
        ...origin,
        machineId: "mac-2",
        now: NOW,
      }),
    ).toBe(false);
    const later = new Date(NOW.getTime() + ROUTINE_DELIVERY_TTL_MS + 1);
    expect(await moduleEventSeenV1(storage, { ...origin, now: later })).toBe(
      false,
    );
  });

  test("the replay guard is bounded, oldest out first", async () => {
    const storage = createMemoryRoutineStorageV1();
    for (let index = 0; index <= MODULE_EVENT_SEEN_LIMIT_V1; index += 1) {
      await recordModuleEventV1(storage, {
        machineId: "mac-1",
        event: { ...event, key: `evt-${index}` },
        now: new Date(NOW.getTime() + index),
      });
    }
    await trimModuleEventsSeenV1(
      storage,
      new Date(NOW.getTime() + MODULE_EVENT_SEEN_LIMIT_V1),
    );
    const at = new Date(NOW.getTime() + MODULE_EVENT_SEEN_LIMIT_V1);
    const seen = (key: string) =>
      moduleEventSeenV1(storage, {
        machineId: "mac-1",
        pluginId: "beeper",
        key,
        now: at,
      });
    expect(await seen("evt-0")).toBe(false);
    expect(await seen("evt-1")).toBe(true);
    expect(await seen(`evt-${MODULE_EVENT_SEEN_LIMIT_V1}`)).toBe(true);
  });

  test("the last key moves per module and event, and says when it did", async () => {
    const storage = createMemoryRoutineStorageV1();
    const record = (next: MachineModuleEventV1) =>
      recordModuleEventV1(storage, {
        machineId: "mac-1",
        event: next,
        now: NOW,
      });
    expect(await record(event)).toBe(true);
    expect(await record({ ...event, key: "evt-2" })).toBe(true);
    expect(await record({ ...event, event: "typing", key: "evt-3" })).toBe(
      true,
    );
    expect(await record({ ...event, key: "evt-2" })).toBe(false);
    expect(await readModuleEventLastKeysV1(storage)).toEqual({
      "beeper/bridge": { message: "evt-2", typing: "evt-3" },
    });
  });
});

describe("the Routines a module event fires", () => {
  test("are the listening ones on a Bot the directory still holds", async () => {
    const storage = createMemoryRoutineStorageV1();
    const listen = (botId: string, routineId: string, trigger: string) =>
      syncPluginTriggerRoutineV1(storage, {
        botId,
        routineId,
        listening: { pluginId: "beeper", trigger },
      });
    await listen("bot-1", "family", "message");
    await listen("bot-2", "work", "message");
    await listen("bot-1", "typing", "typing");
    await listen("gone", "old", "message");
    await syncPluginTriggerRoutineV1(storage, {
      botId: "bot-2",
      routineId: "paused",
      listening: { pluginId: "beeper", trigger: "message" },
    });
    // Paused: the Routine says it no longer listens.
    await syncPluginTriggerRoutineV1(storage, {
      botId: "bot-2",
      routineId: "paused",
    });
    const targets = moduleEventTargetsV1(
      await readPluginTriggerRoutinesV1(storage),
      event,
      new Set(["bot-1", "bot-2"]),
    );
    expect(
      targets.map((routine) => `${routine.botId}/${routine.routineId}`).sort(),
    ).toEqual(["bot-1/family", "bot-2/work"]);
  });

  test("a rebuild replaces the index with what each Bot holds", async () => {
    const storage = createMemoryRoutineStorageV1();
    await syncPluginTriggerRoutineV1(storage, {
      botId: "bot-1",
      routineId: "stale",
      listening: { pluginId: "beeper", trigger: "message" },
    });
    expect(await pluginTriggerIndexBuiltV1(storage)).toBe(false);
    await rebuildPluginTriggerIndexV1(storage, [
      {
        botId: "bot-1",
        routines: [
          { routineId: "family", pluginId: "beeper", trigger: "message" },
        ],
      },
    ]);
    expect(await pluginTriggerIndexBuiltV1(storage)).toBe(true);
    expect(await readPluginTriggerRoutinesV1(storage)).toEqual([
      {
        botId: "bot-1",
        routineId: "family",
        pluginId: "beeper",
        trigger: "message",
      },
    ]);
  });

  test("each Routine is handed the payload as JSON, keyed per Routine", async () => {
    const routine = {
      botId: "bot-1",
      routineId: "family",
      pluginId: "beeper",
      trigger: "message",
    };
    const one = await moduleEventDeliveryV1({
      machineId: "mac-1",
      event,
      routine,
    });
    expect(one).toMatchObject({
      routineId: "family",
      pluginId: "beeper",
      trigger: "message",
      body: '{"text":"hi"}',
      source: {
        kind: "device-module",
        moduleId: "bridge",
        machineId: "mac-1",
        key: "evt-1",
      },
    });
    expect(one.deliveryId).toMatch(/^[0-9a-f]{64}$/);
    const other = await moduleEventDeliveryV1({
      machineId: "mac-1",
      event,
      routine: { ...routine, routineId: "work" },
    });
    expect(other.deliveryId).not.toBe(one.deliveryId);
  });
});

describe("the modules frame", () => {
  test("flags the listened events and carries the last keys", async () => {
    const storage = createMemoryRoutineStorageV1();
    await syncPluginTriggerRoutineV1(storage, {
      botId: "bot-1",
      routineId: "family",
      listening: { pluginId: "beeper", trigger: "message" },
    });
    await recordModuleEventV1(storage, {
      machineId: "mac-1",
      event: { ...event, key: "evt-9" },
      now: NOW,
    });
    const [bridge] = machineModulesV1(
      generation,
      "macos",
      await readModuleRoutingV1(
        storage,
        await readPluginTriggerRoutinesV1(storage),
      ),
    );
    expect(bridge?.listening).toEqual(["message"]);
    expect(bridge?.lastKeys).toEqual({ message: "evt-9" });
  });
});

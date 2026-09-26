// A device module's events, on their way to the Routines that listen (ADR
// 0037).
//
// The desktop posts each event to the User Durable Object, the one object
// that sees every Bot. It keeps three things here: which Routines on which
// Bots name a Plugin trigger (each Routine tells it when it changes), which
// event keys it has already admitted from which machine, and the last key it
// admitted for each module's event, which the module is handed on start so it
// can fetch what arrived while the app was closed.

import type { CompositionGenerationV1 } from "@frockbot/core/durable";
import type { MachineModuleEventV1 } from "@frockbot/core/machine-protocol";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  ROUTINE_DELIVERY_TTL_MS,
  moduleEventDeliveryIdV1,
} from "@frockbot/app/routines/hook";
import type { MachineModuleRoutingV1 } from "@frockbot/app/machine/modules";

/** Keys one account keeps against a replay, across every machine. */
export const MODULE_EVENT_SEEN_LIMIT_V1 = 1_000;

const TRIGGER_ROUTINE_PREFIX_V1 = "plugin:trigger-routine:v1:";
const TRIGGER_ROUTINES_BUILT_KEY_V1 = "plugin:trigger-routines:v1:built";
const EVENT_SEEN_PREFIX_V1 = "plugin:module-event-seen:v1:";
const LAST_KEYS_KEY_V1 = "plugin:module-event-last-keys:v1";

/** One Routine, on one Bot, whose trigger names a Plugin's trigger. */
export interface PluginTriggerRoutineEntryV1 {
  botId: string;
  routineId: string;
  pluginId: string;
  trigger: string;
}

export interface ModuleEventStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

function entryKey(botId: string, routineId: string): string {
  return `${TRIGGER_ROUTINE_PREFIX_V1}${botId}/${routineId}`;
}

/** Every indexed Routine, in no particular order. */
export async function readPluginTriggerRoutinesV1(
  storage: ModuleEventStorageV1,
): Promise<PluginTriggerRoutineEntryV1[]> {
  return [
    ...(
      await storage.list<PluginTriggerRoutineEntryV1>({
        prefix: TRIGGER_ROUTINE_PREFIX_V1,
      })
    ).values(),
  ];
}

/** Records whether one Routine listens, and to what. */
export async function syncPluginTriggerRoutineV1(
  storage: ModuleEventStorageV1,
  input: {
    botId: string;
    routineId: string;
    listening?: { pluginId: string; trigger: string };
  },
): Promise<void> {
  const key = entryKey(input.botId, input.routineId);
  if (input.listening === undefined) {
    await storage.delete(key);
    return;
  }
  await storage.put(key, {
    botId: input.botId,
    routineId: input.routineId,
    pluginId: input.listening.pluginId,
    trigger: input.listening.trigger,
  } satisfies PluginTriggerRoutineEntryV1);
}

/**
 * Whether the index has been built from the Bots themselves. Routines written
 * before the index existed never told it, so the first read rebuilds it once.
 */
export async function pluginTriggerIndexBuiltV1(
  storage: ModuleEventStorageV1,
): Promise<boolean> {
  return (await storage.get<boolean>(TRIGGER_ROUTINES_BUILT_KEY_V1)) === true;
}

/** Replaces the index with what each Bot said it holds. */
export async function rebuildPluginTriggerIndexV1(
  storage: ModuleEventStorageV1,
  bots: ReadonlyArray<{
    botId: string;
    routines: ReadonlyArray<{
      routineId: string;
      pluginId: string;
      trigger: string;
    }>;
  }>,
): Promise<void> {
  for (const key of (
    await storage.list<unknown>({ prefix: TRIGGER_ROUTINE_PREFIX_V1 })
  ).keys()) {
    await storage.delete(key);
  }
  for (const bot of bots) {
    for (const routine of bot.routines) {
      await syncPluginTriggerRoutineV1(storage, {
        botId: bot.botId,
        routineId: routine.routineId,
        listening: { pluginId: routine.pluginId, trigger: routine.trigger },
      });
    }
  }
  await storage.put(TRIGGER_ROUTINES_BUILT_KEY_V1, true);
}

/** `pluginId/trigger` for every event some Routine listens to. */
export function listeningEventsV1(
  routines: readonly PluginTriggerRoutineEntryV1[],
): Set<string> {
  return new Set(
    routines.map((routine) => `${routine.pluginId}/${routine.trigger}`),
  );
}

/**
 * The Routines one event fires. A Bot the directory no longer holds is not
 * addressed: deleting a Bot does not reach back to tell this index.
 */
export function moduleEventTargetsV1(
  routines: readonly PluginTriggerRoutineEntryV1[],
  event: Pick<MachineModuleEventV1, "pluginId" | "event">,
  liveBots: ReadonlySet<string>,
): PluginTriggerRoutineEntryV1[] {
  return routines.filter(
    (routine) =>
      routine.pluginId === event.pluginId &&
      routine.trigger === event.event &&
      liveBots.has(routine.botId),
  );
}

/**
 * Why the active generation refuses an event, or undefined when it carries
 * the Plugin, the module and the module's declaration of the event. A desktop
 * still running the last generation says something stale for a moment; that
 * is a drop, not an error.
 */
export function refuseModuleEventV1(
  generation: CompositionGenerationV1,
  event: Pick<MachineModuleEventV1, "pluginId" | "moduleId" | "event">,
): string | undefined {
  const member = generation.members.find(
    (candidate) => candidate.packageId === event.pluginId,
  );
  if (!member) {
    return `plugin "${event.pluginId}" is not in the active generation`;
  }
  const declared = member.descriptor.device?.modules?.find(
    (module) => module.id === event.moduleId,
  );
  if (
    !declared ||
    !member.modules?.some((module) => module.id === event.moduleId)
  ) {
    return `plugin "${event.pluginId}" carries no module "${event.moduleId}"`;
  }
  if (!declared.events.includes(event.event)) {
    return `module "${event.moduleId}" declares no event "${event.event}"`;
  }
  return undefined;
}

async function seenKey(input: {
  machineId: string;
  pluginId: string;
  key: string;
}): Promise<string> {
  return `${EVENT_SEEN_PREFIX_V1}${await sha256HexTextV1(
    `${input.machineId}\u0000${input.pluginId}\u0000${input.key}`,
  )}`;
}

/** Whether this machine's key for this Plugin was admitted inside the window. */
export async function moduleEventSeenV1(
  storage: ModuleEventStorageV1,
  input: { machineId: string; pluginId: string; key: string; now: Date },
): Promise<boolean> {
  const at = await storage.get<string>(await seenKey(input));
  return (
    at !== undefined &&
    Date.parse(at) > input.now.getTime() - ROUTINE_DELIVERY_TTL_MS
  );
}

/**
 * Records one admitted event: the replay guard, and the module's last key
 * for the event. Answers whether the last key moved.
 */
export async function recordModuleEventV1(
  storage: ModuleEventStorageV1,
  input: { machineId: string; event: MachineModuleEventV1; now: Date },
): Promise<boolean> {
  const { event } = input;
  await storage.put(
    await seenKey({ machineId: input.machineId, ...event }),
    input.now.toISOString(),
  );
  const lastKeys = await readModuleEventLastKeysV1(storage);
  const module = `${event.pluginId}/${event.moduleId}`;
  if (lastKeys[module]?.[event.event] === event.key) return false;
  await storage.put(LAST_KEYS_KEY_V1, {
    ...lastKeys,
    [module]: { ...lastKeys[module], [event.event]: event.key },
  });
  return true;
}

/** Keep the replay guard bounded, and drop what is past its window. */
export async function trimModuleEventsSeenV1(
  storage: ModuleEventStorageV1,
  now: Date,
): Promise<void> {
  const live: Array<[string, number]> = [];
  for (const [key, at] of await storage.list<string>({
    prefix: EVENT_SEEN_PREFIX_V1,
  })) {
    const time = Date.parse(at);
    if (Number.isNaN(time) || time <= now.getTime() - ROUTINE_DELIVERY_TTL_MS) {
      await storage.delete(key);
    } else {
      live.push([key, time]);
    }
  }
  if (live.length <= MODULE_EVENT_SEEN_LIMIT_V1) return;
  live.sort(([, left], [, right]) => left - right);
  for (const [key] of live.slice(0, live.length - MODULE_EVENT_SEEN_LIMIT_V1)) {
    await storage.delete(key);
  }
}

/** Per `pluginId/moduleId`, the last key admitted for each event. */
export async function readModuleEventLastKeysV1(
  storage: ModuleEventStorageV1,
): Promise<Record<string, Record<string, string>>> {
  return (
    (await storage.get<Record<string, Record<string, string>>>(
      LAST_KEYS_KEY_V1,
    )) ?? {}
  );
}

/** What the modules frame says beyond the generation. */
export async function readModuleRoutingV1(
  storage: ModuleEventStorageV1,
  routines: readonly PluginTriggerRoutineEntryV1[],
): Promise<MachineModuleRoutingV1> {
  return {
    listening: listeningEventsV1(routines),
    lastKeys: await readModuleEventLastKeysV1(storage),
  };
}

/** The Bot-side delivery for one target, keyed so a replay fires once. */
export async function moduleEventDeliveryV1(input: {
  machineId: string;
  event: MachineModuleEventV1;
  routine: PluginTriggerRoutineEntryV1;
}) {
  const { event, routine } = input;
  return {
    routineId: routine.routineId,
    deliveryId: await moduleEventDeliveryIdV1({
      routineId: routine.routineId,
      machineId: input.machineId,
      pluginId: event.pluginId,
      key: event.key,
    }),
    pluginId: event.pluginId,
    trigger: event.event,
    body: JSON.stringify(event.payload),
    source: {
      kind: "device-module" as const,
      moduleId: event.moduleId,
      machineId: input.machineId,
      key: event.key,
    },
  };
}

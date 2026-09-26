// The device modules a desktop runs (ADR 0037), read off the account's active
// Composition generation.
//
// The source is the generation's members, not each Bot's switch: whether a
// Bot turned a Plugin on lives in that Bot's own Durable Object, which the
// User Durable Object that holds the socket never reads. A module is the
// account's, like the Plugin it belongs to.

import type { CompositionGenerationV1 } from "@frockbot/core/durable";
import type {
  MachineModuleV1,
  MachinePlatformV1,
} from "@frockbot/core/machine-protocol";

/** What the cloud knows of each module's events, beyond the generation. */
export interface MachineModuleRoutingV1 {
  /** `pluginId/event` for every event at least one active Routine listens to. */
  listening: ReadonlySet<string>;
  /** Per `pluginId/moduleId`, the last key admitted for each event. */
  lastKeys: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export const NO_MODULE_ROUTING_V1: MachineModuleRoutingV1 = {
  listening: new Set(),
  lastKeys: {},
};

/** Every module the generation carries that runs on `platform`. */
export function machineModulesV1(
  generation: CompositionGenerationV1,
  platform: MachinePlatformV1,
  routing: MachineModuleRoutingV1 = NO_MODULE_ROUTING_V1,
): MachineModuleV1[] {
  return generation.members.flatMap((member) =>
    (member.modules ?? []).flatMap((artifact) => {
      const declared = member.descriptor.device?.modules?.find(
        (module) => module.id === artifact.id,
      );
      if (
        !declared ||
        !(declared.platforms as readonly string[]).includes(platform)
      ) {
        return [];
      }
      return [
        {
          pluginId: member.packageId,
          moduleId: artifact.id,
          contentHash: artifact.contentHash,
          size: artifact.size,
          read: [...declared.read],
          net: [...declared.net],
          appleEvents: [...declared.appleEvents],
          calls: [...declared.calls],
          events: [...declared.events],
          listening: declared.events.filter((event) =>
            routing.listening.has(`${member.packageId}/${event}`),
          ),
          lastKeys: Object.fromEntries(
            Object.entries(
              routing.lastKeys[`${member.packageId}/${artifact.id}`] ?? {},
            ).filter(([event]) => declared.events.includes(event)),
          ),
        },
      ];
    }),
  );
}

/** Whether `contentHash` names a module the generation carries. */
export function generationCarriesModuleV1(
  generation: CompositionGenerationV1,
  contentHash: string,
): boolean {
  return generation.members.some((member) =>
    (member.modules ?? []).some(
      (artifact) => artifact.contentHash === contentHash,
    ),
  );
}

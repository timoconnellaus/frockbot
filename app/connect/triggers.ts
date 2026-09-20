// Connected-app events a Routine may fire on: the offer a Bot is shown, the
// instance the provider holds, and the mapping that routes a delivery back
// to the Routine that subscribed.
//
// The instance lives at the provider. What we keep is the id and who owns
// it, keyed so a retried command replays the same instance and a delivery
// names a User, a Bot and a Routine without asking the provider again.

import type { ConnectionView } from "@frockbot/core/configuration";
import {
  CONNECT_PACKAGE_ID,
  connectToolkitForConnectionTypeV1,
} from "./catalog.js";
import type { ConnectTriggerTypeV1 } from "./composio.js";
import { connectSafeMetadataV1 } from "./user.js";

export const CONNECT_TRIGGER_INSTANCE_PREFIX = "connect:trigger:v1:";
export const CONNECT_TRIGGER_BY_ROUTINE_PREFIX =
  "connect:trigger-by-routine:v1:";
export const CONNECT_TRIGGER_EFFECT_PREFIX = "connect:trigger-effect:v1:";

/** One event a connected app can start a Routine with. */
export interface ConnectTriggerOfferV1 {
  connectionId: string;
  connectionLabel: string;
  toolkitSlug: string;
  toolkitName: string;
  slug: string;
  name: string;
  description: string;
}

export interface ConnectTriggerInstanceRecordV1 {
  schemaVersion: 1;
  instanceId: string;
  botId: string;
  routineId: string;
  connectionId: string;
  triggerType: string;
}

export interface ConnectTriggerEffectReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  instanceId?: string;
  botId: string;
  routineId: string;
  status: "upserted" | "deleted";
}

export function connectTriggerInstanceKeyV1(instanceId: string): string {
  return `${CONNECT_TRIGGER_INSTANCE_PREFIX}${instanceId}`;
}

export function connectTriggerByRoutineKeyV1(
  botId: string,
  routineId: string,
): string {
  return `${CONNECT_TRIGGER_BY_ROUTINE_PREFIX}${botId}:${routineId}`;
}

export function connectTriggerEffectKeyV1(commandId: string): string {
  return `${CONNECT_TRIGGER_EFFECT_PREFIX}${commandId}`;
}

export function decodeConnectTriggerInstanceRecordV1(
  value: unknown,
): ConnectTriggerInstanceRecordV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.instanceId !== "string" ||
    typeof record.botId !== "string" ||
    typeof record.routineId !== "string" ||
    typeof record.connectionId !== "string" ||
    typeof record.triggerType !== "string"
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    instanceId: record.instanceId,
    botId: record.botId,
    routineId: record.routineId,
    connectionId: record.connectionId,
    triggerType: record.triggerType,
  };
}

export function decodeConnectTriggerEffectReceiptV1(
  value: unknown,
): ConnectTriggerEffectReceiptV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.commandId !== "string" ||
    typeof record.botId !== "string" ||
    typeof record.routineId !== "string" ||
    (record.status !== "upserted" && record.status !== "deleted")
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    commandId: record.commandId,
    botId: record.botId,
    routineId: record.routineId,
    status: record.status,
    ...(typeof record.instanceId === "string"
      ? { instanceId: record.instanceId }
      : {}),
  };
}

/** Ready Connections of this Package, as the trigger list walks them. */
export function connectReadyConnectionsV1(
  connections: readonly ConnectionView[],
): Array<ConnectionView & { toolkitSlug: string; toolkitName: string }> {
  const ready: Array<
    ConnectionView & { toolkitSlug: string; toolkitName: string }
  > = [];
  for (const connection of connections) {
    if (
      connection.packageId !== CONNECT_PACKAGE_ID ||
      connection.state !== "ready"
    ) {
      continue;
    }
    const metadata = connectSafeMetadataV1(connection);
    const toolkit = connectToolkitForConnectionTypeV1(
      connection.connectionTypeId,
    );
    if (!metadata || !toolkit) continue;
    ready.push({
      ...connection,
      toolkitSlug: metadata.toolkitSlug,
      toolkitName: metadata.toolkitName,
    });
  }
  return ready;
}

/** Offers for one Connection from the types the provider listed. */
export function connectTriggerOffersV1(
  connection: ConnectionView & { toolkitSlug: string; toolkitName: string },
  types: readonly ConnectTriggerTypeV1[],
): ConnectTriggerOfferV1[] {
  return types.map((type) => ({
    connectionId: connection.connectionId,
    connectionLabel: connection.displayName,
    toolkitSlug: connection.toolkitSlug,
    toolkitName: connection.toolkitName,
    slug: type.slug,
    name: type.name,
    description: type.description,
  }));
}

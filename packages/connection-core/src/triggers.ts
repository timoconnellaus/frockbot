/** Credential-free service events available on the User's existing Connections. */
export interface ConnectionTriggerTypeV1 {
  connectionId: string;
  connectorName: string;
  accountName: string;
  triggerType: string;
  name: string;
  description: string;
  configSchema: Record<string, unknown>;
  version: string;
}
export interface ConnectionTriggerCatalogV1 {
  schemaVersion: 1;
  items: ConnectionTriggerTypeV1[];
}
export interface ConnectionTriggerV1 {
  connectionId: string;
  triggerType: string;
  config: Record<string, unknown>;
}
/** A Bot's durable desired subscription, sent only through its backend binding. */
export interface RoutineSubscriptionIntentV1 {
  schemaVersion: 1;
  subscriptionId: string;
  routineId: string;
  revision: number;
  enabled: boolean;
  deleted: boolean;
  trigger?: ConnectionTriggerV1;
}
export type ConnectionTriggerStatusV1 =
  "starting" | "active" | "paused" | "missing" | "failed" | "unavailable";
export interface ConnectionEventDeliveryV1 {
  routineId: string;
  subscriptionId: string;
  deliveryId: string;
  body: string;
  contentType: "application/json";
}
export function decodeConnectionEventDeliveryV1(
  value: unknown,
): ConnectionEventDeliveryV1 {
  if (
    !triggerObject(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "routineId",
          "subscriptionId",
          "deliveryId",
          "body",
          "contentType",
        ].includes(key),
    ) ||
    !text(value.routineId, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.routineId) ||
    !text(value.subscriptionId, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.subscriptionId) ||
    !text(value.deliveryId, 64) ||
    !/^[a-f0-9]{64}$/.test(value.deliveryId) ||
    typeof value.body !== "string" ||
    new TextEncoder().encode(value.body).byteLength > 64_000 ||
    value.contentType !== "application/json"
  )
    throw new Error("Routine event delivery is invalid");
  return {
    routineId: value.routineId,
    subscriptionId: value.subscriptionId,
    deliveryId: value.deliveryId,
    body: value.body,
    contentType: "application/json",
  };
}
export function decodeRoutineSubscriptionIntentV1(
  value: unknown,
): RoutineSubscriptionIntentV1 {
  if (
    !triggerObject(value) ||
    value.schemaVersion !== 1 ||
    !text(value.subscriptionId, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.subscriptionId) ||
    !text(value.routineId, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.routineId) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.enabled !== "boolean" ||
    typeof value.deleted !== "boolean" ||
    (!value.deleted && value.trigger === undefined)
  )
    throw new Error("Routine subscription is invalid");
  return {
    schemaVersion: 1,
    subscriptionId: value.subscriptionId,
    routineId: value.routineId,
    revision: Number(value.revision),
    enabled: value.enabled,
    deleted: value.deleted,
    ...(value.trigger === undefined
      ? {}
      : { trigger: decodeConnectionTriggerV1(value.trigger) }),
  };
}
export function triggerObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 200): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}
export function decodeConnectionTriggerV1(value: unknown): ConnectionTriggerV1 {
  if (
    !triggerObject(value) ||
    Object.keys(value).some(
      (key) => !["connectionId", "triggerType", "config"].includes(key),
    ) ||
    !text(value.connectionId, 128) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.connectionId) ||
    !text(value.triggerType) ||
    !/^[A-Z][A-Z0-9_]*$/.test(value.triggerType) ||
    !triggerObject(value.config) ||
    new TextEncoder().encode(JSON.stringify(value.config)).byteLength > 16_000
  )
    throw new Error("Choose an available account and event");
  return {
    connectionId: value.connectionId,
    triggerType: value.triggerType,
    config: value.config,
  };
}
export function decodeConnectionTriggerCatalogV1(
  value: unknown,
): ConnectionTriggerCatalogV1 {
  if (
    !triggerObject(value) ||
    value.schemaVersion !== 1 ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_000_000 ||
    !Array.isArray(value.items) ||
    value.items.length > 1000
  )
    throw new Error("Available events could not be read");
  const seen = new Set<string>();
  const items = value.items.map((item): ConnectionTriggerTypeV1 => {
    if (
      !triggerObject(item) ||
      !text(item.connectorName) ||
      !text(item.accountName) ||
      !text(item.name, 500) ||
      typeof item.description !== "string" ||
      item.description.length > 16_000 ||
      !triggerObject(item.configSchema) ||
      item.configSchema.type !== "object" ||
      !text(item.version) ||
      !/^\d{8}_\d+$/.test(item.version)
    )
      throw new Error("This event is unavailable");
    const trigger = decodeConnectionTriggerV1({
      connectionId: item.connectionId,
      triggerType: item.triggerType,
      config: {},
    });
    const key = `${trigger.connectionId}:${trigger.triggerType}`;
    if (seen.has(key)) throw new Error("Repeated event in catalog");
    seen.add(key);
    return {
      connectionId: trigger.connectionId,
      triggerType: trigger.triggerType,
      connectorName: item.connectorName,
      accountName: item.accountName,
      name: item.name,
      description: item.description,
      configSchema: item.configSchema,
      version: item.version,
    };
  });
  return { schemaVersion: 1, items };
}

export interface ConnectionTriggerStatusesV1 {
  schemaVersion: 1;
  routines: Record<string, { status: ConnectionTriggerStatusV1; name: string }>;
}
export function decodeConnectionTriggerStatusV1(
  value: unknown,
): ConnectionTriggerStatusV1 {
  if (
    value === "starting" ||
    value === "active" ||
    value === "paused" ||
    value === "missing" ||
    value === "failed" ||
    value === "unavailable"
  )
    return value;
  throw new Error("Event status is unavailable");
}
export function decodeConnectionTriggerStatusesV1(
  value: unknown,
): ConnectionTriggerStatusesV1 {
  if (
    !triggerObject(value) ||
    value.schemaVersion !== 1 ||
    !triggerObject(value.routines) ||
    Object.keys(value.routines).length > 1000
  )
    throw new Error("Event statuses are unavailable");
  const routines: ConnectionTriggerStatusesV1["routines"] = {};
  for (const [id, item] of Object.entries(value.routines)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ||
      !triggerObject(item) ||
      !text(item.name, 500)
    )
      throw new Error("Event status is unavailable");
    routines[id] = {
      status: decodeConnectionTriggerStatusV1(item.status),
      name: item.name,
    };
  }
  return { schemaVersion: 1, routines };
}

/** Bot-issued current bindings, never inferred from User record insertion order. */
export function decodeRoutineSubscriptionBindingsV1(
  value: unknown,
): Record<string, string> {
  if (!triggerObject(value) || Object.keys(value).length > 1000)
    throw new Error("Routine event bindings are invalid");
  const bindings: Record<string, string> = {};
  for (const [routineId, subscriptionId] of Object.entries(value)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(routineId) ||
      typeof subscriptionId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(subscriptionId)
    )
      throw new Error("Routine event binding is invalid");
    bindings[routineId] = subscriptionId;
  }
  return bindings;
}

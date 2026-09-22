// The Session's focused conversation panel (ADR 0034).
//
// One pointer on the Bot Durable Object: which Plugin surface the Canvas
// shows. Absent or `pluginId: null` means the region is closed. The person
// clicking a tab, a `bot.nav` press, and the Bot's `panel_focus` tool write
// the same record. The cloud is the authority; a client does not keep a
// private selection.

export const PANEL_FOCUSED_KEY = "panels:focused";

/** Most conversation.panel surfaces the host offers at once. */
export const MAX_PLUGIN_PANEL_BAG_V1 = 8;

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * One Session's focused conversation panel. `pluginId: null` closes the
 * region. `surfaceId` is present exactly when a surface is selected.
 */
export interface FocusedPanelV1 {
  schemaVersion: 1;
  pluginId: string | null;
  surfaceId?: string;
  changedAt: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
}

function pluginId(value: unknown, label: string): string {
  const id = boundedString(value, label, 64);
  if (!PLUGIN_ID.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function surfaceId(value: unknown, label: string): string {
  const id = boundedString(value, label, 128);
  if (!SURFACE_ID.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

export function decodeFocusedPanelV1(
  input: unknown,
  label = "focused panel",
): FocusedPanelV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["schemaVersion", "pluginId", "changedAt"],
    ["surfaceId"],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.pluginId === null) {
    if (value.surfaceId !== undefined) {
      throw new Error(`${label}.surfaceId is only valid when a panel is open`);
    }
    return {
      schemaVersion: 1,
      pluginId: null,
      changedAt: timestamp(value.changedAt, `${label}.changedAt`),
    };
  }
  const decoded: FocusedPanelV1 = {
    schemaVersion: 1,
    pluginId: pluginId(value.pluginId, `${label}.pluginId`),
    changedAt: timestamp(value.changedAt, `${label}.changedAt`),
  };
  if (value.surfaceId === undefined) {
    throw new Error(`${label}.surfaceId is required when a panel is open`);
  }
  decoded.surfaceId = surfaceId(value.surfaceId, `${label}.surfaceId`);
  return decoded;
}

export function focusedPanelV1(
  pluginIdValue: string | null,
  surfaceIdValue: string | undefined,
  changedAt: string,
): FocusedPanelV1 {
  if (pluginIdValue === null) {
    return { schemaVersion: 1, pluginId: null, changedAt };
  }
  if (surfaceIdValue === undefined) {
    throw new Error("a focused panel needs a surface id");
  }
  return decodeFocusedPanelV1({
    schemaVersion: 1,
    pluginId: pluginIdValue,
    surfaceId: surfaceIdValue,
    changedAt,
  });
}

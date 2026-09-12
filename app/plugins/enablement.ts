// Which Plugins one Bot runs. A Plugin is installed per User — the User's
// Composition generation lists it — and enabled per Bot, because "make this
// Bot able to do X" is what a person says (ADR 0026). This is the Bot's half:
// a revisioned map from Plugin id to on or off, read at every mount.
//
// Absent means the Plugin's default: a User who never touched the switch gets
// what the generation installed, and what a seeded Plugin's seed state says
// (`catalog.ts`). The map holds only what someone said, on or off.

export const PLUGIN_ENABLEMENT_KEY_V1 = "plugins:enablement";

export interface PluginEnablementV1 {
  schemaVersion: 1;
  revision: number;
  /**
   * Only the Plugins a person switched, on or off. Absent is the Plugin's own
   * default: what the generation installed, and what a seeded Plugin's seed
   * state says (`catalog.ts`) — so an explicit `true` is what turns a
   * `default-off` Plugin on.
   */
  enabled: Record<string, boolean>;
  updatedAt: string;
}

/** A Plugin id, one rule: the decoder here and the RPC envelope share it. */
export const PLUGIN_ID_V1 = /^[a-z][a-z0-9-]{0,63}$/;
export const PLUGIN_ID_MAX_LENGTH_V1 = 64;
const MAX_PLUGIN_SWITCHES_V1 = 256;

export function decodePluginEnablementV1(input: unknown): PluginEnablementV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("plugin enablement must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    ["enabled", "revision", "schemaVersion", "updatedAt"].join(",")
  ) {
    throw new Error("plugin enablement has invalid fields");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("plugin enablement schemaVersion is unsupported");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error(
      "plugin enablement revision must be a non-negative integer",
    );
  }
  if (
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new Error("plugin enablement updatedAt must be a timestamp");
  }
  if (
    !value.enabled ||
    typeof value.enabled !== "object" ||
    Array.isArray(value.enabled)
  ) {
    throw new Error("plugin enablement enabled must be an object");
  }
  const enabled: Record<string, boolean> = {};
  const entries = Object.entries(value.enabled as Record<string, unknown>);
  if (entries.length > MAX_PLUGIN_SWITCHES_V1) {
    throw new Error("plugin enablement exceeds its bound");
  }
  for (const [pluginId, flag] of entries) {
    if (!PLUGIN_ID_V1.test(pluginId)) {
      throw new Error(
        `plugin enablement names an invalid plugin "${pluginId}"`,
      );
    }
    if (typeof flag !== "boolean") {
      throw new Error(`plugin enablement for "${pluginId}" must be a boolean`);
    }
    enabled[pluginId] = flag;
  }
  return {
    schemaVersion: 1,
    revision: value.revision as number,
    enabled,
    updatedAt: value.updatedAt as string,
  };
}

export function emptyPluginEnablementV1(now = new Date()): PluginEnablementV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    enabled: {},
    updatedAt: now.toISOString(),
  };
}

export interface PluginEnablementStorageV1 {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export async function readPluginEnablementV1(
  storage: PluginEnablementStorageV1,
): Promise<PluginEnablementV1> {
  const stored = await storage.get(PLUGIN_ENABLEMENT_KEY_V1);
  return stored === undefined
    ? emptyPluginEnablementV1()
    : decodePluginEnablementV1(stored);
}

export class PluginEnablementConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `plugin enablement is at revision ${currentRevision}, not ${expectedRevision}`,
    );
    this.name = "PluginEnablementConflictError";
  }
}

/**
 * Switches one Plugin for this Bot. Fenced on the revision the caller read,
 * so two people flipping switches from stale pages do not silently undo each
 * other. The map records what was said, on or off: absent still reads as
 * the Plugin's default, and an explicit on is what turns a default-off
 * Plugin on.
 */
export async function setPluginEnabledV1(
  storage: PluginEnablementStorageV1,
  input: {
    pluginId: string;
    enabled: boolean;
    expectedRevision: number;
    now?: Date;
  },
): Promise<PluginEnablementV1> {
  if (!PLUGIN_ID_V1.test(input.pluginId)) {
    throw new Error(`plugin id "${input.pluginId}" is invalid`);
  }
  const current = await readPluginEnablementV1(storage);
  if (input.expectedRevision !== current.revision) {
    throw new PluginEnablementConflictError(
      input.expectedRevision,
      current.revision,
    );
  }
  const enabled = { ...current.enabled, [input.pluginId]: input.enabled };
  const next: PluginEnablementV1 = {
    schemaVersion: 1,
    revision: current.revision + 1,
    enabled,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  await storage.put(PLUGIN_ENABLEMENT_KEY_V1, next);
  return next;
}

/** The Plugins this Bot runs out of the ones its User installed, in order. */
export function enabledPluginIdsV1(
  installed: readonly { packageId: string }[],
  enablement: PluginEnablementV1,
): string[] {
  return installed
    .map((member) => member.packageId)
    .filter((pluginId) => enablement.enabled[pluginId] !== false);
}

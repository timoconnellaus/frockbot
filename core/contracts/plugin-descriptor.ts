// What untrusted code declares about itself.
//
// A plugin is code that runs at runtime and was not there at build time:
// Bot-authored extensions, Applets, third-party installs. It reaches only what
// the app deliberately opened, and the vocabulary below is that opening — the
// same four lists `AGENTS.md` names, and nothing else. Adding a name here is a
// deliberate widening of the plugin surface, not a side effect of a feature.
//
// Everything decoded here is untrusted: the descriptor travels with a
// Composition member and is read back on the Bot's own authority.

/** Loop behaviour a plugin may wrap. */
export const PLUGIN_ACTIONS_V1 = [
  "context.assemble",
  "tools.expose",
  "tool.call",
  "turn.terminate",
  "memory.read",
  "memory.write",
] as const;

export type PluginActionV1 = (typeof PLUGIN_ACTIONS_V1)[number];

/** Authority a plugin may hold. */
export const PLUGIN_GRANTS_V1 = [
  "storage",
  "http",
  "schedule",
  "ai",
  "files",
  "memory",
  "workspace",
  "computer",
] as const;

export type PluginGrantV1 = (typeof PLUGIN_GRANTS_V1)[number];

/** Where a plugin may render. Trust chrome is never a slot. */
export const PLUGIN_SLOTS_V1 = [
  "composer.toolbar",
  "message.actions",
  "sidebar.entries",
  "settings.sections",
  "bot.profile",
] as const;

export type PluginSlotV1 = (typeof PLUGIN_SLOTS_V1)[number];

/** What the isolate context names. */
export const PLUGIN_CONTEXT_KEYS_V1 = ["user", "bot", "session"] as const;

export type PluginContextKeyV1 = (typeof PLUGIN_CONTEXT_KEYS_V1)[number];

/** One tool a plugin offers the Bot; the isolate's health report must match. */
export interface PluginToolV1 {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * One view a plugin offers in a slot. The plugin returns a `ViewDocument` for
 * `surfaceId` and the host renders it with the host's own widgets; the plugin
 * ships no markup. Account-scoped, like every other thing a User enables.
 */
export interface PluginViewV1 {
  slot: PluginSlotV1;
  surfaceId: string;
}

export interface PluginDescriptorV1 {
  id: string;
  displayName: string;
  version: string;
  tools: PluginToolV1[];
  actions: PluginActionV1[];
  grants: PluginGrantV1[];
  slots?: PluginSlotV1[];
  views?: PluginViewV1[];
  /** Always all three: a plugin sees the whole context or none of it. */
  contextKeys: readonly ["user", "bot", "session"];
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** The `Identifier` the client wire schema accepts as a `ViewDocument.surfaceId`. */
const PLUGIN_SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_PLUGIN_TOOLS_V1 = 64;
const MAX_PLUGIN_VIEWS_V1 = 16;

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
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function vocabulary<T extends string>(
  input: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  if (!Array.isArray(input) || input.length > allowed.length) {
    throw new Error(`${label} must be a bounded array`);
  }
  const decoded = input.map((entry, index) => {
    const match = allowed.find((candidate) => candidate === entry);
    if (!match) throw new Error(`${label}[${index}] is not a declared name`);
    return match;
  });
  if (new Set(decoded).size !== decoded.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return decoded;
}

function decodePluginToolV1(input: unknown, label: string): PluginToolV1 {
  const value = record(input, label);
  exactKeys(value, ["name", "description", "inputSchema"], [], label);
  const name = boundedString(value.name, `${label}.name`, 64);
  if (!PLUGIN_TOOL_NAME.test(name)) throw new Error(`${label}.name is invalid`);
  return {
    name,
    description: boundedString(
      value.description,
      `${label}.description`,
      1_024,
    ),
    // The round trip is the normalization: what survives it is JSON, and what
    // does not was never a schema.
    inputSchema: JSON.parse(
      JSON.stringify(record(value.inputSchema, `${label}.inputSchema`)),
    ) as Record<string, unknown>,
  };
}

function decodePluginViewV1(input: unknown, label: string): PluginViewV1 {
  const value = record(input, label);
  exactKeys(value, ["slot", "surfaceId"], [], label);
  const surfaceId = boundedString(value.surfaceId, `${label}.surfaceId`, 128);
  if (!PLUGIN_SURFACE_ID.test(surfaceId)) {
    throw new Error(`${label}.surfaceId is invalid`);
  }
  return {
    slot: vocabulary([value.slot], PLUGIN_SLOTS_V1, `${label}.slot`)[0]!,
    surfaceId,
  };
}

export function decodePluginDescriptorV1(
  input: unknown,
  label = "plugin descriptor",
): PluginDescriptorV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "id",
      "displayName",
      "version",
      "tools",
      "actions",
      "grants",
      "contextKeys",
    ],
    ["slots", "views"],
    label,
  );
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!PLUGIN_ID.test(id)) throw new Error(`${label}.id is invalid`);
  if (!Array.isArray(value.tools) || value.tools.length > MAX_PLUGIN_TOOLS_V1) {
    throw new Error(`${label}.tools must be a bounded array`);
  }
  const tools = value.tools.map((tool, index) =>
    decodePluginToolV1(tool, `${label}.tools[${index}]`),
  );
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error(`${label}.tools contains duplicate names`);
  }
  const contextKeys = vocabulary(
    value.contextKeys,
    PLUGIN_CONTEXT_KEYS_V1,
    `${label}.contextKeys`,
  );
  if (contextKeys.length !== PLUGIN_CONTEXT_KEYS_V1.length) {
    throw new Error(`${label}.contextKeys must name every context key`);
  }
  const slots =
    value.slots === undefined
      ? undefined
      : vocabulary(value.slots, PLUGIN_SLOTS_V1, `${label}.slots`);
  if (
    value.views !== undefined &&
    (!Array.isArray(value.views) || value.views.length > MAX_PLUGIN_VIEWS_V1)
  ) {
    throw new Error(`${label}.views must be a bounded array`);
  }
  const views = (value.views as unknown[] | undefined)?.map((view, index) =>
    decodePluginViewV1(view, `${label}.views[${index}]`),
  );
  if (
    views &&
    new Set(views.map((view) => view.surfaceId)).size !== views.length
  ) {
    throw new Error(`${label}.views contains duplicate surface ids`);
  }
  return {
    id,
    displayName: boundedString(value.displayName, `${label}.displayName`, 128),
    version: boundedString(value.version, `${label}.version`, 64),
    tools,
    actions: vocabulary(value.actions, PLUGIN_ACTIONS_V1, `${label}.actions`),
    grants: vocabulary(value.grants, PLUGIN_GRANTS_V1, `${label}.grants`),
    ...(slots === undefined ? {} : { slots }),
    ...(views === undefined ? {} : { views }),
    contextKeys: [...PLUGIN_CONTEXT_KEYS_V1],
  };
}

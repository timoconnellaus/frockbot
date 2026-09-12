// What a Plugin declares about itself.
//
// A Plugin is code that runs at runtime and was not there at build time: one
// the deployment seeded, or one a Bot wrote. It reaches only what the app
// deliberately opened, and the vocabulary below is that opening — the lists
// `AGENTS.md` names, and nothing else. Adding a name here is a deliberate
// widening of the plugin surface, not a side effect of a feature.
//
// Everything decoded here is untrusted: the descriptor travels with a
// Composition member and is read back on the Bot's own authority.
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  type BotIsolateHookEventNameV1,
} from "./loop-events.js";
import {
  ISOLATE_CONTRACT_VERSION,
  type IsolateContractVersion,
} from "./isolate.js";

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

/** One tool a plugin offers the Bot; the worker's health report must match. */
export interface PluginToolV1 {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * One view a plugin offers in a slot. The plugin returns a `ViewDocument` for
 * `surfaceId` and the host renders it with the host's own widgets; the plugin
 * ships no markup.
 */
export interface PluginViewV1 {
  slot: PluginSlotV1;
  surfaceId: string;
}

/**
 * The shape of the `http` grant. A plugin either names the hosts it needs, or
 * asks for open access. Either one is approved by the User on the plugin's
 * card; open access is described there as held by every plugin on the
 * account, because plugins in one worker share a realm.
 */
export type PluginNetworkV1 = { hosts: string[] } | { open: true };

/** A typed service one plugin offers another, or needs from another. */
export interface PluginServiceV1 {
  name: string;
  /** The service's major version; a consumer needs the same one. */
  version: number;
}

/** One kind of event a plugin can receive through the app-owned hooks route. */
export interface PluginTriggerV1 {
  name: string;
  description: string;
}

export interface PluginDescriptorV1 {
  id: string;
  displayName: string;
  version: string;
  /** The hook and capability contract the plugin was built against. */
  contractVersion: IsolateContractVersion;
  tools: PluginToolV1[];
  /** The loop events the plugin wraps, in the vocabulary's order. */
  hooks: BotIsolateHookEventNameV1[];
  grants: PluginGrantV1[];
  /** Present exactly when `grants` holds `http`. */
  network?: PluginNetworkV1;
  /** A JSON Schema for the plugin's per-Bot settings; never a secret. */
  settingsSchema?: Record<string, unknown>;
  provides?: PluginServiceV1[];
  consumes?: PluginServiceV1[];
  triggers?: PluginTriggerV1[];
  slots?: PluginSlotV1[];
  views?: PluginViewV1[];
  /** Always all three: a plugin sees the whole context or none of it. */
  contextKeys: readonly ["user", "bot", "session"];
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PLUGIN_SERVICE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_TRIGGER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** A lowercase hostname, optionally with one leading wildcard label. */
const PLUGIN_HOST =
  /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The `Identifier` the client wire schema accepts as a `ViewDocument.surfaceId`. */
const PLUGIN_SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_PLUGIN_TOOLS_V1 = 64;
const MAX_PLUGIN_VIEWS_V1 = 16;
const MAX_PLUGIN_HOSTS_V1 = 32;
const MAX_PLUGIN_SERVICES_V1 = 32;
const MAX_PLUGIN_TRIGGERS_V1 = 16;
const MAX_PLUGIN_SETTINGS_SCHEMA_BYTES_V1 = 65_536;

/**
 * The contract versions this deployment serves: the current one and the one
 * before it. A plugin built against an older contract is disabled with a
 * notice and rebuilt on request; it is never rebuilt silently at deploy.
 */
export function servedPluginContractVersionsV1(): IsolateContractVersion[] {
  const previous = (ISOLATE_CONTRACT_VERSION - 1) as IsolateContractVersion;
  return previous >= 1
    ? [previous, ISOLATE_CONTRACT_VERSION]
    : [ISOLATE_CONTRACT_VERSION];
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
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value;
}

function vocabulary<T extends string>(
  input: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  const entries = boundedArray(input, label, allowed.length);
  const decoded = entries.map((entry, index) => {
    const match = allowed.find((candidate) => candidate === entry);
    if (!match) throw new Error(`${label}[${index}] is not a declared name`);
    return match;
  });
  if (new Set(decoded).size !== decoded.length) {
    throw new Error(`${label} contains duplicates`);
  }
  // Vocabulary order, whatever order the plugin wrote them in: two descriptors
  // naming the same set are the same descriptor.
  return allowed.filter((candidate) => decoded.includes(candidate));
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

export function decodePluginNetworkV1(
  input: unknown,
  label = "plugin network",
): PluginNetworkV1 {
  const value = record(input, label);
  if (Object.hasOwn(value, "open")) {
    exactKeys(value, ["open"], [], label);
    if (value.open !== true) throw new Error(`${label}.open must be true`);
    return { open: true };
  }
  exactKeys(value, ["hosts"], [], label);
  const hosts = boundedArray(
    value.hosts,
    `${label}.hosts`,
    MAX_PLUGIN_HOSTS_V1,
  ).map((host, index) => {
    const decoded = boundedString(host, `${label}.hosts[${index}]`, 253);
    if (!PLUGIN_HOST.test(decoded)) {
      throw new Error(`${label}.hosts[${index}] is not a hostname`);
    }
    return decoded;
  });
  if (hosts.length === 0) throw new Error(`${label}.hosts must name a host`);
  if (new Set(hosts).size !== hosts.length) {
    throw new Error(`${label}.hosts contains duplicates`);
  }
  return { hosts: hosts.toSorted() };
}

/**
 * Whether a request host is one a plugin declared. A wildcard label matches
 * one or more subdomain labels and never the bare domain, so `*.example.com`
 * admits `api.example.com` and refuses `example.com`.
 */
export function pluginNetworkAdmitsHostV1(
  network: PluginNetworkV1,
  host: string,
): boolean {
  if ("open" in network) return true;
  const candidate = host.toLowerCase();
  return network.hosts.some((declared) =>
    declared.startsWith("*.")
      ? candidate.endsWith(declared.slice(1)) &&
        candidate.length > declared.length - 1
      : candidate === declared,
  );
}

function decodePluginServicesV1(
  input: unknown,
  label: string,
): PluginServiceV1[] {
  const services = boundedArray(input, label, MAX_PLUGIN_SERVICES_V1).map(
    (service, index) => {
      const itemLabel = `${label}[${index}]`;
      const value = record(service, itemLabel);
      exactKeys(value, ["name", "version"], [], itemLabel);
      const name = boundedString(value.name, `${itemLabel}.name`, 64);
      if (!PLUGIN_SERVICE_NAME.test(name)) {
        throw new Error(`${itemLabel}.name is invalid`);
      }
      const version = value.version;
      if (!Number.isSafeInteger(version) || (version as number) < 1) {
        throw new Error(`${itemLabel}.version must be a positive integer`);
      }
      return { name, version: version as number };
    },
  );
  if (
    new Set(services.map((service) => service.name)).size !== services.length
  ) {
    throw new Error(`${label} contains duplicate names`);
  }
  return services;
}

function decodePluginTriggersV1(
  input: unknown,
  label: string,
): PluginTriggerV1[] {
  const triggers = boundedArray(input, label, MAX_PLUGIN_TRIGGERS_V1).map(
    (trigger, index) => {
      const itemLabel = `${label}[${index}]`;
      const value = record(trigger, itemLabel);
      exactKeys(value, ["name", "description"], [], itemLabel);
      const name = boundedString(value.name, `${itemLabel}.name`, 64);
      if (!PLUGIN_TRIGGER_NAME.test(name)) {
        throw new Error(`${itemLabel}.name is invalid`);
      }
      return {
        name,
        description: boundedString(
          value.description,
          `${itemLabel}.description`,
          1_024,
        ),
      };
    },
  );
  if (
    new Set(triggers.map((trigger) => trigger.name)).size !== triggers.length
  ) {
    throw new Error(`${label} contains duplicate names`);
  }
  return triggers;
}

function decodePluginSettingsSchemaV1(
  input: unknown,
  label: string,
): Record<string, unknown> {
  const value = record(input, label);
  if (value.type !== "object") {
    throw new Error(`${label} must describe an object`);
  }
  const text = JSON.stringify(value);
  if (text.length > MAX_PLUGIN_SETTINGS_SCHEMA_BYTES_V1) {
    throw new Error(`${label} exceeds its bound`);
  }
  return JSON.parse(text) as Record<string, unknown>;
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
      "contractVersion",
      "tools",
      "hooks",
      "grants",
      "contextKeys",
    ],
    [
      "network",
      "settingsSchema",
      "provides",
      "consumes",
      "triggers",
      "slots",
      "views",
    ],
    label,
  );
  const id = boundedString(value.id, `${label}.id`, 64);
  if (!PLUGIN_ID.test(id)) throw new Error(`${label}.id is invalid`);
  const contractVersion = value.contractVersion;
  if (
    !Number.isSafeInteger(contractVersion) ||
    (contractVersion as number) < 1 ||
    (contractVersion as number) > ISOLATE_CONTRACT_VERSION
  ) {
    throw new Error(`${label}.contractVersion is not a known contract`);
  }
  const tools = boundedArray(
    value.tools,
    `${label}.tools`,
    MAX_PLUGIN_TOOLS_V1,
  ).map((tool, index) => decodePluginToolV1(tool, `${label}.tools[${index}]`));
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
  const grants = vocabulary(value.grants, PLUGIN_GRANTS_V1, `${label}.grants`);
  const network =
    value.network === undefined
      ? undefined
      : decodePluginNetworkV1(value.network, `${label}.network`);
  if ((network !== undefined) !== grants.includes("http")) {
    throw new Error(
      `${label}.network is present exactly when the http grant is declared`,
    );
  }
  const settingsSchema =
    value.settingsSchema === undefined
      ? undefined
      : decodePluginSettingsSchemaV1(
          value.settingsSchema,
          `${label}.settingsSchema`,
        );
  const provides =
    value.provides === undefined
      ? undefined
      : decodePluginServicesV1(value.provides, `${label}.provides`);
  const consumes =
    value.consumes === undefined
      ? undefined
      : decodePluginServicesV1(value.consumes, `${label}.consumes`);
  if (
    provides &&
    consumes &&
    provides.some((offered) =>
      consumes.some((needed) => needed.name === offered.name),
    )
  ) {
    throw new Error(`${label} provides a service it also consumes`);
  }
  const triggers =
    value.triggers === undefined
      ? undefined
      : decodePluginTriggersV1(value.triggers, `${label}.triggers`);
  const slots =
    value.slots === undefined
      ? undefined
      : vocabulary(value.slots, PLUGIN_SLOTS_V1, `${label}.slots`);
  const views =
    value.views === undefined
      ? undefined
      : boundedArray(value.views, `${label}.views`, MAX_PLUGIN_VIEWS_V1).map(
          (view, index) => decodePluginViewV1(view, `${label}.views[${index}]`),
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
    contractVersion: contractVersion as IsolateContractVersion,
    tools,
    hooks: vocabulary(
      value.hooks,
      BOT_ISOLATE_HOOK_EVENTS_V1,
      `${label}.hooks`,
    ),
    grants,
    ...(network === undefined ? {} : { network }),
    ...(settingsSchema === undefined ? {} : { settingsSchema }),
    ...(provides === undefined ? {} : { provides }),
    ...(consumes === undefined ? {} : { consumes }),
    ...(triggers === undefined ? {} : { triggers }),
    ...(slots === undefined ? {} : { slots }),
    ...(views === undefined ? {} : { views }),
    contextKeys: [...PLUGIN_CONTEXT_KEYS_V1],
  };
}

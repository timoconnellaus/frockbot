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
import {
  ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1,
  isSkillReferenceNameV1,
  isSkillRefSlugV1,
} from "./skills.js";
import { assertEnforceableJsonSchemaV1 } from "./json-schema.js";
import {
  PLUGIN_MODEL_PROTOCOL_VERSIONS_V1,
  type PluginModelProviderV1,
} from "./plugin-model.js";
import { PLUGIN_CARD_ACTION_NAME_PATTERN_V1 } from "./plugin-card-contract.js";
import { PLUGIN_PAGE_PATH_V1 } from "./plugin-page.js";
import { exactKeysV1, recordV1 } from "./records.js";

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
  "device",
] as const;

export type PluginGrantV1 = (typeof PLUGIN_GRANTS_V1)[number];

/**
 * What the `device` grant may name (ADR 0035): abilities the host opens on the
 * person's device for a Plugin's page, never the page itself. Only the local
 * tier, and only what a client draws today.
 */
export const PLUGIN_DEVICE_ABILITIES_V1 = ["microphone"] as const;

export type PluginDeviceAbilityV1 = (typeof PLUGIN_DEVICE_ABILITIES_V1)[number];

/** Where a device module can run (ADR 0037). Desktop only. */
export const PLUGIN_DEVICE_MODULE_PLATFORMS_V1 = ["macos"] as const;

export type PluginDeviceModulePlatformV1 =
  (typeof PLUGIN_DEVICE_MODULE_PLATFORMS_V1)[number];

/**
 * Code a Plugin ships for the desktop to run (ADR 0037). Everything it may
 * reach is named here: its process is started with exactly these reads,
 * these hosts and these Apple Event targets, and nothing else.
 */
export interface PluginDeviceModuleV1 {
  /** The module's source is `modules/<id>.ts`. */
  id: string;
  platforms: PluginDeviceModulePlatformV1[];
  /** Absolute or `~/` paths it may read and watch. */
  read: string[];
  /** `host:port` it may reach; today only the loopback. */
  net: string[];
  /** Applications it may script, by bundle id. */
  appleEvents: string[];
  /** What the Plugin's cloud code may ask it to do. */
  calls: string[];
  /** Events it may send, each one of the Plugin's `triggers`. */
  events: string[];
}

/** The shape of the `device` grant: what the User approves. */
export interface PluginDeviceV1 {
  /** Abilities the host opens for the Plugin's page. May be empty. */
  abilities: PluginDeviceAbilityV1[];
  /** Code the desktop runs for the Plugin (ADR 0037). */
  modules?: PluginDeviceModuleV1[];
}

/** Where a plugin may render. Trust chrome is never a slot. */
export const PLUGIN_SLOTS_V1 = [
  "composer.toolbar",
  "message.actions",
  "settings.sections",
  "bot.profile",
  "conversation.panel",
  "bot.nav",
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
 * `surfaceId` and the host renders it with the host's own widgets. `label` is
 * the tab or door the host draws. `opens` is only on `bot.nav`: a press
 * focuses that `conversation.panel` surface (ADR 0034).
 *
 * `page` is only on `conversation.panel`: the HTML file in the plugin's source
 * the host draws in its sandboxed frame instead, when the surface is its own
 * drawing or interaction (ADR 0036). The view's function then returns the
 * page's state rather than a document.
 */
export interface PluginViewV1 {
  slot: PluginSlotV1;
  surfaceId: string;
  label?: string;
  opens?: string;
  page?: string;
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

/**
 * One Skill a plugin ships (ADR 0030): a `SKILL.md` and the Markdown files
 * beside it, bundled in the artifact the way a managed Skill is bundled in the
 * app's. The text is bounded and named here; whether it parses as a `SKILL.md`
 * is the Skills Package's question, answered as a recorded refusal on the Turn
 * that loaded it, because a plugin's bad document must not fail a descriptor
 * decode the whole Composition depends on.
 */
export interface PluginSkillV1 {
  slug: string;
  text: string;
  /** Loaded on their own by `skill_load`; `path` is one `.md` file name. */
  references?: { path: string; text: string }[];
}

/**
 * One Card a plugin declares (ADR 0030): the values the Bot sends and the
 * names a person may press on the surface those values are drawn as.
 *
 * The surface itself is deliberately not here. A plugin's card may look one
 * way with an approval pending and another once it has settled, so the
 * components are what `renderCard` answers with — the descriptor declares
 * only what the Bot must fill in and what the card may ask for back.
 */
export interface PluginCardV1 {
  id: string;
  displayName: string;
  description: string;
  /** A JSON Schema for the values the Bot sends; the kernel validates against it. */
  dataSchema: Record<string, unknown>;
  /** The `<action>` half of every `plugin/<pluginId>/<action>` this card may raise. */
  actions: { name: string; description: string }[];
}

/**
 * The tool one card is offered to the Bot as. Plugin tools are registered in
 * the plugin's own Tool Namespace, so the id is qualified rather than
 * prefixed: `email_draft`, not `card_email_draft`.
 *
 * A plugin id may hold a dash and a tool name may not, so the dashes become
 * underscores. Nothing collides: a plugin id holds no underscore, so the two
 * spellings cannot both exist.
 */
export function pluginCardToolNameV1(pluginId: string, cardId: string): string {
  return `${pluginId.replaceAll("-", "_")}_${cardId}`;
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
  /** Present exactly when `grants` holds `device`. */
  device?: PluginDeviceV1;
  /** A JSON Schema for the plugin's per-Bot settings; never a secret. */
  settingsSchema?: Record<string, unknown>;
  provides?: PluginServiceV1[];
  consumes?: PluginServiceV1[];
  triggers?: PluginTriggerV1[];
  /** Offered to a Bot with this plugin enabled, as `plugin/<id>/<slug>`. */
  skills?: PluginSkillV1[];
  /** The Cards the plugin draws, one Bot-facing tool each. */
  cards?: PluginCardV1[];
  /**
   * The model providers this Plugin serves (ADR 0032). Selecting a provider
   * is what runs its contribution — the Plugin's tools and hooks still need
   * the Bot's own switch — and only a provider this deployment opens to
   * Plugins may be declared.
   */
  modelProviders?: PluginModelProviderV1[];
  slots?: PluginSlotV1[];
  views?: PluginViewV1[];
  /** Always all three: a plugin sees the whole context or none of it. */
  contextKeys: readonly ["user", "bot", "session"];
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PLUGIN_SERVICE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_TRIGGER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** A card id, short enough that `<pluginId>_<cardId>` is still a tool name. */
const PLUGIN_CARD_ID = /^[a-z][a-z0-9_]{0,31}$/;
const PLUGIN_CARD_ACTION_NAME = new RegExp(PLUGIN_CARD_ACTION_NAME_PATTERN_V1);
/** A lowercase hostname, optionally with one leading wildcard label. */
const PLUGIN_HOST =
  /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The `Identifier` the client wire schema accepts as a `ViewDocument.surfaceId`. */
const PLUGIN_SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_PLUGIN_TOOLS_V1 = 64;
const MAX_PLUGIN_VIEWS_V1 = 16;
/** Tab and door copy; matches a settings-section title. */
export const MAX_PLUGIN_VIEW_LABEL_V1 = 80;
const MAX_PLUGIN_HOSTS_V1 = 32;
const MAX_PLUGIN_SERVICES_V1 = 32;
const MAX_PLUGIN_TRIGGERS_V1 = 16;
const MAX_PLUGIN_SKILLS_V1 = 8;
const MAX_PLUGIN_SKILL_REFERENCES_V1 = 32;
const MAX_PLUGIN_SKILL_BYTES_V1 = 65_536;
const MAX_PLUGIN_SETTINGS_SCHEMA_BYTES_V1 = 65_536;
const MAX_PLUGIN_CARDS_V1 = 16;
const MAX_PLUGIN_CARD_ACTIONS_V1 = 16;
const MAX_PLUGIN_CARD_SCHEMA_BYTES_V1 = 65_536;
const MAX_PLUGIN_MODEL_PROVIDERS_V1 = 4;
const MAX_PLUGIN_DEVICE_MODULES_V1 = 4;
const MAX_PLUGIN_DEVICE_MODULE_ENTRIES_V1 = 32;
/** A module id: its source file is `modules/<id>.ts`. */
const PLUGIN_DEVICE_MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PLUGIN_DEVICE_MODULE_CALL = /^[a-z][a-z0-9_-]{0,63}$/;
/** `~/…` or `/…`, with no `..` segment, no `//` and no control characters. */
const PLUGIN_DEVICE_MODULE_PATH =
  /^(?!.*\/\.\.(?:\/|$))(?!.*\/\/)(?:~\/|\/)[^\u0000-\u001f]{0,510}$/;
const PLUGIN_DEVICE_MODULE_NET = /^(?:localhost|127\.0\.0\.1):([0-9]{1,5})$/;
const PLUGIN_BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const PLUGIN_DESCRIPTOR_TEXT_ENCODER_V1 = new TextEncoder();
/** A model provider type: the id a model binding names. */
const PLUGIN_PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;

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
  return recordV1(value, label);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  exactKeysV1(value, required, optional, label);
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
  exactKeys(value, ["slot", "surfaceId"], ["label", "opens", "page"], label);
  const surfaceId = boundedString(value.surfaceId, `${label}.surfaceId`, 128);
  if (!PLUGIN_SURFACE_ID.test(surfaceId)) {
    throw new Error(`${label}.surfaceId is invalid`);
  }
  const slot = vocabulary([value.slot], PLUGIN_SLOTS_V1, `${label}.slot`)[0]!;
  const decoded: PluginViewV1 = { slot, surfaceId };
  if (value.label !== undefined) {
    decoded.label = boundedString(
      value.label,
      `${label}.label`,
      MAX_PLUGIN_VIEW_LABEL_V1,
    );
  }
  if (value.opens !== undefined) {
    const opens = boundedString(value.opens, `${label}.opens`, 128);
    if (!PLUGIN_SURFACE_ID.test(opens)) {
      throw new Error(`${label}.opens is invalid`);
    }
    if (slot !== "bot.nav") {
      throw new Error(`${label}.opens is only valid on bot.nav`);
    }
    decoded.opens = opens;
  }
  if (value.page !== undefined) {
    const page = boundedString(value.page, `${label}.page`, 140);
    if (!PLUGIN_PAGE_PATH_V1.test(page)) {
      throw new Error(
        `${label}.page must be an .html file in the plugin's source, such as "page.html"`,
      );
    }
    if (slot !== "conversation.panel") {
      throw new Error(`${label}.page is only valid on conversation.panel`);
    }
    decoded.page = page;
  }
  return decoded;
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
  // An empty list is the http grant with no outbound network: a Plugin that
  // opens a kernel loopback (`ctx.email`) and nothing else. It admits no host,
  // so the approval card has no reach to name.
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

function decodeModuleNamesV1(
  input: unknown,
  label: string,
  valid: (entry: string) => boolean,
): string[] {
  const names = boundedArray(
    input,
    label,
    MAX_PLUGIN_DEVICE_MODULE_ENTRIES_V1,
  ).map((entry, index) => {
    const name = boundedString(entry, `${label}[${index}]`, 512);
    if (!valid(name)) throw new Error(`${label}[${index}] is invalid`);
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return names;
}

function decodePluginDeviceModulesV1(
  input: unknown,
  label: string,
): PluginDeviceModuleV1[] {
  const modules = boundedArray(input, label, MAX_PLUGIN_DEVICE_MODULES_V1).map(
    (module, index) => {
      const itemLabel = `${label}[${index}]`;
      const value = record(module, itemLabel);
      exactKeys(
        value,
        ["id", "platforms", "read", "net", "appleEvents", "calls", "events"],
        [],
        itemLabel,
      );
      const id = boundedString(value.id, `${itemLabel}.id`, 32);
      if (!PLUGIN_DEVICE_MODULE_ID.test(id)) {
        throw new Error(`${itemLabel}.id is invalid`);
      }
      const platforms = vocabulary(
        value.platforms,
        PLUGIN_DEVICE_MODULE_PLATFORMS_V1,
        `${itemLabel}.platforms`,
      );
      if (platforms.length === 0) {
        throw new Error(`${itemLabel}.platforms names no platform`);
      }
      return {
        id,
        platforms,
        read: decodeModuleNamesV1(value.read, `${itemLabel}.read`, (path) =>
          PLUGIN_DEVICE_MODULE_PATH.test(path),
        ),
        net: decodeModuleNamesV1(value.net, `${itemLabel}.net`, (address) => {
          const port = PLUGIN_DEVICE_MODULE_NET.exec(address)?.[1];
          return (
            port !== undefined && Number(port) >= 1 && Number(port) <= 65_535
          );
        }),
        appleEvents: decodeModuleNamesV1(
          value.appleEvents,
          `${itemLabel}.appleEvents`,
          (bundleId) =>
            bundleId.length <= 255 && PLUGIN_BUNDLE_ID.test(bundleId),
        ),
        calls: decodeModuleNamesV1(value.calls, `${itemLabel}.calls`, (call) =>
          PLUGIN_DEVICE_MODULE_CALL.test(call),
        ),
        events: decodeModuleNamesV1(
          value.events,
          `${itemLabel}.events`,
          (event) => PLUGIN_TRIGGER_NAME.test(event),
        ),
      };
    },
  );
  if (new Set(modules.map((module) => module.id)).size !== modules.length) {
    throw new Error(`${label} contains duplicate ids`);
  }
  return modules;
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

function decodePluginSkillsV1(input: unknown, label: string): PluginSkillV1[] {
  const skills = boundedArray(input, label, MAX_PLUGIN_SKILLS_V1).map(
    (skill, index) => {
      const itemLabel = `${label}[${index}]`;
      const value = record(skill, itemLabel);
      exactKeys(value, ["slug", "text"], ["references"], itemLabel);
      const slug = boundedString(value.slug, `${itemLabel}.slug`, 64);
      if (!isSkillRefSlugV1(slug)) {
        throw new Error(`${itemLabel}.slug is invalid`);
      }
      const text = boundedString(
        value.text,
        `${itemLabel}.text`,
        MAX_PLUGIN_SKILL_BYTES_V1,
      );
      if (value.references === undefined) return { slug, text };
      const references = boundedArray(
        value.references,
        `${itemLabel}.references`,
        MAX_PLUGIN_SKILL_REFERENCES_V1,
      ).map((reference, position) => {
        const referenceLabel = `${itemLabel}.references[${position}]`;
        const entry = record(reference, referenceLabel);
        exactKeys(entry, ["path", "text"], [], referenceLabel);
        const path = boundedString(entry.path, `${referenceLabel}.path`, 64);
        if (!isSkillReferenceNameV1(path)) {
          throw new Error(`${referenceLabel}.path is invalid`);
        }
        return {
          path,
          text: boundedString(
            entry.text,
            `${referenceLabel}.text`,
            MAX_PLUGIN_SKILL_BYTES_V1,
          ),
        };
      });
      if (
        new Set(references.map((reference) => reference.path)).size !==
        references.length
      ) {
        throw new Error(`${itemLabel}.references contains duplicate names`);
      }
      return { slug, text, references };
    },
  );
  if (new Set(skills.map((skill) => skill.slug)).size !== skills.length) {
    throw new Error(`${label} contains duplicate slugs`);
  }
  const total = skills.reduce(
    (bytes, skill) =>
      bytes +
      PLUGIN_DESCRIPTOR_TEXT_ENCODER_V1.encode(skill.text).byteLength +
      (skill.references ?? []).reduce(
        (referenced, reference) =>
          referenced +
          PLUGIN_DESCRIPTOR_TEXT_ENCODER_V1.encode(reference.text).byteLength,
        0,
      ),
    0,
  );
  if (total > ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1) {
    throw new Error(
      `${label} carries ${total} bytes of Skill text; the bound is ${ARTIFACT_SKILLS_MAX_TOTAL_BYTES_V1}`,
    );
  }
  return skills;
}

function decodePluginCardsV1(input: unknown, label: string): PluginCardV1[] {
  const cards = boundedArray(input, label, MAX_PLUGIN_CARDS_V1).map(
    (card, index) => {
      const itemLabel = `${label}[${index}]`;
      const value = record(card, itemLabel);
      exactKeys(
        value,
        ["id", "displayName", "description", "dataSchema", "actions"],
        [],
        itemLabel,
      );
      const id = boundedString(value.id, `${itemLabel}.id`, 32);
      if (!PLUGIN_CARD_ID.test(id))
        throw new Error(`${itemLabel}.id is invalid`);
      const dataSchema = record(value.dataSchema, `${itemLabel}.dataSchema`);
      if (dataSchema.type !== "object") {
        throw new Error(`${itemLabel}.dataSchema must describe an object`);
      }
      const schemaText = JSON.stringify(dataSchema);
      if (schemaText.length > MAX_PLUGIN_CARD_SCHEMA_BYTES_V1) {
        throw new Error(`${itemLabel}.dataSchema exceeds its bound`);
      }
      // Walked whole here, not per value at draw time: a card declaring a
      // constraint the kernel cannot check is a card that never mounts.
      assertEnforceableJsonSchemaV1(dataSchema, `${itemLabel}.dataSchema`);
      const actions = boundedArray(
        value.actions,
        `${itemLabel}.actions`,
        MAX_PLUGIN_CARD_ACTIONS_V1,
      ).map((action, position) => {
        const actionLabel = `${itemLabel}.actions[${position}]`;
        const entry = record(action, actionLabel);
        exactKeys(entry, ["name", "description"], [], actionLabel);
        const name = boundedString(entry.name, `${actionLabel}.name`, 64);
        if (!PLUGIN_CARD_ACTION_NAME.test(name)) {
          throw new Error(`${actionLabel}.name is invalid`);
        }
        return {
          name,
          description: boundedString(
            entry.description,
            `${actionLabel}.description`,
            1_024,
          ),
        };
      });
      if (
        new Set(actions.map((action) => action.name)).size !== actions.length
      ) {
        throw new Error(`${itemLabel}.actions contains duplicate names`);
      }
      return {
        id,
        displayName: boundedString(
          value.displayName,
          `${itemLabel}.displayName`,
          128,
        ),
        description: boundedString(
          value.description,
          `${itemLabel}.description`,
          1_024,
        ),
        dataSchema: JSON.parse(schemaText) as Record<string, unknown>,
        actions,
      };
    },
  );
  if (new Set(cards.map((card) => card.id)).size !== cards.length) {
    throw new Error(`${label} contains duplicate ids`);
  }
  // The action namespace is `plugin/<pluginId>/<action>` and has no card in
  // it, so an action name is the plugin's, not one card's: two cards claiming
  // one name would be two handlers behind one press.
  const actionNames = cards.flatMap((card) =>
    card.actions.map((action) => action.name),
  );
  if (new Set(actionNames).size !== actionNames.length) {
    throw new Error(`${label} declares one action name on two cards`);
  }
  return cards;
}

function decodePluginModelProvidersV1(
  input: unknown,
  label: string,
): PluginModelProviderV1[] {
  const providers = boundedArray(
    input,
    label,
    MAX_PLUGIN_MODEL_PROVIDERS_V1,
  ).map((provider, index) => {
    const itemLabel = `${label}[${index}]`;
    const value = record(provider, itemLabel);
    exactKeys(value, ["id", "protocolVersion"], [], itemLabel);
    const id = boundedString(value.id, `${itemLabel}.id`, 64);
    if (!PLUGIN_PROVIDER_ID.test(id)) {
      throw new Error(`${itemLabel}.id is invalid`);
    }
    const protocolVersion = value.protocolVersion;
    if (
      !Number.isSafeInteger(protocolVersion) ||
      !PLUGIN_MODEL_PROTOCOL_VERSIONS_V1.includes(protocolVersion as number)
    ) {
      throw new Error(`${itemLabel}.protocolVersion is not served`);
    }
    return { id, protocolVersion: protocolVersion as number };
  });
  if (
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  ) {
    throw new Error(`${label} contains duplicate provider ids`);
  }
  return providers;
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
      "device",
      "settingsSchema",
      "provides",
      "consumes",
      "triggers",
      "skills",
      "cards",
      "modelProviders",
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
  let device: PluginDeviceV1 | undefined;
  if (value.device !== undefined) {
    const shape = record(value.device, `${label}.device`);
    exactKeys(shape, ["abilities"], ["modules"], `${label}.device`);
    const abilities = vocabulary(
      shape.abilities,
      PLUGIN_DEVICE_ABILITIES_V1,
      `${label}.device.abilities`,
    );
    const modules =
      shape.modules === undefined
        ? undefined
        : decodePluginDeviceModulesV1(shape.modules, `${label}.device.modules`);
    if (abilities.length === 0 && !modules?.length) {
      throw new Error(`${label}.device names no ability and no module`);
    }
    device = { abilities, ...(modules?.length ? { modules } : {}) };
  }
  if ((device !== undefined) !== grants.includes("device")) {
    throw new Error(
      `${label}.device is present exactly when the device grant is declared`,
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
  const skills =
    value.skills === undefined
      ? undefined
      : decodePluginSkillsV1(value.skills, `${label}.skills`);
  const cards =
    value.cards === undefined
      ? undefined
      : decodePluginCardsV1(value.cards, `${label}.cards`);
  const modelProviders =
    value.modelProviders === undefined
      ? undefined
      : decodePluginModelProvidersV1(
          value.modelProviders,
          `${label}.modelProviders`,
        );
  // A card is offered as a tool of its own in the plugin's namespace, so a
  // declared tool of that name would be two tools with one name — and a card
  // whose tool name would not be a tool name at all is refused here rather
  // than mounted as a card nothing can call.
  const cardTools = (cards ?? []).map((card) => {
    const toolName = pluginCardToolNameV1(id, card.id);
    if (!PLUGIN_TOOL_NAME.test(toolName)) {
      throw new Error(
        `${label}.cards names a card whose tool "${toolName}" is not a tool name`,
      );
    }
    return toolName;
  });
  const shadowed = tools.find((tool) => cardTools.includes(tool.name));
  if (shadowed) {
    throw new Error(
      `${label}.tools declares "${shadowed.name}", which a card of the same name is offered as`,
    );
  }
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
  if (views) {
    const panels = views.filter((view) => view.slot === "conversation.panel");
    if (panels.length > 1 && panels.some((view) => view.label === undefined)) {
      throw new Error(
        `${label}.views: each conversation.panel view needs a label when a plugin declares more than one`,
      );
    }
    const panelIds = new Set(panels.map((view) => view.surfaceId));
    for (const [index, view] of views.entries()) {
      if (view.opens !== undefined && !panelIds.has(view.opens)) {
        throw new Error(
          `${label}.views[${index}].opens must name a conversation.panel surface of this plugin`,
        );
      }
    }
  }
  // A module's events feed the Plugin's own triggers, so an event the Plugin
  // exports no trigger for would arrive at nothing.
  const triggerNames = new Set((triggers ?? []).map((trigger) => trigger.name));
  for (const [index, module] of (device?.modules ?? []).entries()) {
    const unknown = module.events.find((event) => !triggerNames.has(event));
    if (unknown !== undefined) {
      throw new Error(
        `${label}.device.modules[${index}].events names "${unknown}", which is not one of the Plugin's triggers`,
      );
    }
  }
  // A device ability is opened by the host for a page, so a Plugin with no
  // page has nothing to open one for.
  if (
    device &&
    device.abilities.length > 0 &&
    !views?.some((view) => view.page !== undefined)
  ) {
    throw new Error(
      `${label}.device needs a conversation.panel view that names a page`,
    );
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
    ...(device === undefined ? {} : { device }),
    ...(settingsSchema === undefined ? {} : { settingsSchema }),
    ...(provides === undefined ? {} : { provides }),
    ...(consumes === undefined ? {} : { consumes }),
    ...(triggers === undefined ? {} : { triggers }),
    ...(skills === undefined ? {} : { skills }),
    ...(cards === undefined ? {} : { cards }),
    ...(modelProviders === undefined ? {} : { modelProviders }),
    ...(slots === undefined ? {} : { slots }),
    ...(views === undefined ? {} : { views }),
    contextKeys: [...PLUGIN_CONTEXT_KEYS_V1],
  };
}

/** The model provider contribution a descriptor makes for one provider id. */
export function pluginModelProviderV1(
  descriptor: PluginDescriptorV1,
  providerId: string,
): PluginModelProviderV1 | undefined {
  return descriptor.modelProviders?.find(
    (provider) => provider.id === providerId,
  );
}

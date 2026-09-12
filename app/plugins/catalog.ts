// What a deployment ships as Plugins, and what a User may switch (ADR 0026).
//
// Two kinds of thing appear on the Plugins page beside what a Bot wrote:
//
//  * First-party features a User may turn off per Bot. They are app code
//    behind a flag — never an artifact, never in the worker — listed here so
//    the page shows one list. Custom models is deliberately not one: choosing
//    a model is a Settings decision, not a per-Bot switch.
//  * Seeded Plugins: artifacts the deployment installs into every User's
//    Composition, each with a seed state that says whether a User may switch
//    it, and whether an admin has to open it for the account first.
//
// The catalog is a deployment constant. This deployment seeds nothing yet;
// the machinery is exercised by tests with a fixture catalog, and a seeded
// entry arrives with a built artifact.
import {
  decodePluginDescriptorV1,
  type PluginDescriptorV1,
} from "@frockbot/core/contracts";
import type {
  ArtifactRefV1,
  CompositionMemberV1,
} from "@frockbot/core/durable";
import { CAPABILITY_DESCRIPTIONS } from "@frockbot/app/settings/catalog-copy";
import type { PluginEnablementV1 } from "./enablement.js";

export const PLUGIN_SEED_STATES_V1 = [
  "locked",
  "default-on",
  "default-off",
  "admin-gated",
] as const;

export type PluginSeedStateV1 = (typeof PLUGIN_SEED_STATES_V1)[number];

/** One Plugin the deployment ships, as the catalog lists it. */
export interface SeededPluginV1 {
  pluginId: string;
  displayName: string;
  description: string;
  seed: PluginSeedStateV1;
  artifact: ArtifactRefV1;
  descriptor: PluginDescriptorV1;
}

/**
 * The first-party features a User may switch per Bot, in the order the page
 * shows them. Ids are Package ids; the runtime masks a Package's Capabilities
 * out of a Bot's plan, and leaves its hosted seam unmounted, when the Bot's
 * map says it is off. The words each card shows are the Account features
 * surface's own, so the two cannot drift.
 */
export const FIRST_PARTY_TOGGLEABLE_PLUGINS_V1: readonly {
  packageId: string;
  displayName: string;
  description: string;
}[] = [
  { packageId: "web", displayName: "Web" },
  { packageId: "routines", displayName: "Routines" },
  { packageId: "image", displayName: "Image" },
  { packageId: "subagents", displayName: "Subagents" },
  { packageId: "machine-messages", displayName: "Messages" },
].map((feature) => ({
  ...feature,
  description: CAPABILITY_DESCRIPTIONS[feature.packageId] ?? "",
}));

export function isFirstPartyToggleableV1(packageId: string): boolean {
  return FIRST_PARTY_TOGGLEABLE_PLUGINS_V1.some(
    (plugin) => plugin.packageId === packageId,
  );
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

export function decodeSeededPluginV1(
  input: unknown,
  label = "seeded plugin",
): SeededPluginV1 {
  const value = record(input, label);
  const keys = Object.keys(value).sort();
  if (
    keys.join(",") !==
    [
      "artifact",
      "description",
      "descriptor",
      "displayName",
      "pluginId",
      "seed",
    ].join(",")
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  const pluginId = boundedString(value.pluginId, `${label}.pluginId`, 64);
  if (!PLUGIN_ID.test(pluginId))
    throw new Error(`${label}.pluginId is invalid`);
  // The enable map is one flat record keyed by id, so a seeded Plugin sharing
  // an id with a first-party feature would share its switch.
  if (isFirstPartyToggleableV1(pluginId)) {
    throw new Error(`${label}.pluginId names a first-party feature`);
  }
  const seed = PLUGIN_SEED_STATES_V1.find(
    (candidate) => candidate === value.seed,
  );
  if (!seed) throw new Error(`${label}.seed is not a seed state`);
  const descriptor = decodePluginDescriptorV1(
    value.descriptor,
    `${label}.descriptor`,
  );
  if (descriptor.id !== pluginId) {
    throw new Error(`${label}.descriptor does not name the Plugin`);
  }
  const artifact = record(value.artifact, `${label}.artifact`);
  const contentHash = boundedString(
    artifact.contentHash,
    `${label}.artifact.contentHash`,
    64,
  );
  if (!HEX_64.test(contentHash)) {
    throw new Error(`${label}.artifact.contentHash must be sha-256 hex`);
  }
  if (
    !Number.isSafeInteger(artifact.size) ||
    (artifact.size as number) <= 0 ||
    artifact.mediaType !== "application/javascript"
  ) {
    throw new Error(`${label}.artifact is invalid`);
  }
  return {
    pluginId,
    displayName: boundedString(value.displayName, `${label}.displayName`, 128),
    description: boundedString(
      value.description,
      `${label}.description`,
      1_024,
    ),
    seed,
    artifact: {
      contentHash,
      size: artifact.size as number,
      mediaType: "application/javascript",
      bundlerVersion: boundedString(
        artifact.bundlerVersion,
        `${label}.artifact.bundlerVersion`,
        64,
      ),
    },
    descriptor,
  };
}

export function decodePluginCatalogV1(input: unknown): SeededPluginV1[] {
  if (!Array.isArray(input) || input.length > 64) {
    throw new Error("plugin catalog must be a bounded array");
  }
  const catalog = input.map((entry, index) =>
    decodeSeededPluginV1(entry, `plugin catalog[${index}]`),
  );
  if (
    new Set(catalog.map((plugin) => plugin.pluginId)).size !== catalog.length
  ) {
    throw new Error("plugin catalog contains duplicate ids");
  }
  return catalog;
}

/** What this deployment seeds. Nothing yet: an entry arrives with its artifact. */
export const DEPLOYMENT_PLUGIN_CATALOG_V1: readonly SeededPluginV1[] = [];

/**
 * The catalog entries one account's Composition carries: every seeded Plugin
 * except an admin-gated one the admin has not opened for this account.
 */
export function seededPluginsForAccountV1(
  catalog: readonly SeededPluginV1[],
  adminOpened: readonly string[],
): SeededPluginV1[] {
  return catalog.filter(
    (plugin) =>
      plugin.seed !== "admin-gated" || adminOpened.includes(plugin.pluginId),
  );
}

/** A seeded Plugin as a Composition member; provenance is the deployment's. */
export function seededMemberV1(
  plugin: SeededPluginV1,
  userId: string,
  installedAt: string,
): CompositionMemberV1 {
  return {
    packageId: plugin.pluginId,
    version: plugin.descriptor.version,
    provenance: {
      kind: "user",
      packageId: plugin.pluginId,
      version: plugin.descriptor.version,
      userId,
      authoredAt: installedAt,
    },
    artifact: plugin.artifact,
    descriptor: plugin.descriptor,
  };
}

/**
 * Whether one Bot runs a Plugin, from its seed state and the Bot's map.
 * `locked` always runs; `default-off` runs only when switched on; anything
 * else — `default-on`, an opened `admin-gated`, a Plugin a Bot wrote — runs
 * unless switched off.
 */
export function pluginRunsForBotV1(
  seed: PluginSeedStateV1 | undefined,
  pluginId: string,
  enablement: PluginEnablementV1,
): boolean {
  if (seed === "locked") return true;
  const flag = enablement.enabled[pluginId];
  if (seed === "default-off") return flag === true;
  return flag !== false;
}

/** Whether a User may flip this Plugin's switch on the page. */
export function pluginSwitchableV1(
  seed: PluginSeedStateV1 | undefined,
): boolean {
  return seed !== "locked";
}

/** The Plugins one Bot runs out of the ones its User's generation lists, in order. */
export function enabledSeededPluginIdsV1(
  installed: readonly { packageId: string }[],
  enablement: PluginEnablementV1,
  catalog: readonly SeededPluginV1[],
): string[] {
  return installed
    .map((member) => member.packageId)
    .filter((pluginId) =>
      pluginRunsForBotV1(
        catalog.find((plugin) => plugin.pluginId === pluginId)?.seed,
        pluginId,
        enablement,
      ),
    );
}

/**
 * A first-party feature the Bot's map switched off contributes none of its
 * Capabilities to this Bot's Turn. The account-wide installation is the
 * precondition, as before; the Bot's map is the mask on top of it.
 */
export function maskPlanForBotV1<
  Plan extends { capabilities: { packageId: string }[] },
>(plan: Plan, enablement: PluginEnablementV1): Plan {
  return {
    ...plan,
    capabilities: plan.capabilities.filter(
      (capability) =>
        !isFirstPartyToggleableV1(capability.packageId) ||
        firstPartyFeatureOnForBotV1(capability.packageId, enablement),
    ),
  };
}

/**
 * Whether one first-party feature runs for this Bot. Absent is on, as for any
 * Plugin the catalog does not seed. The plan mask above reads it, and so does
 * every hosted seam whose Package is one of these features: a feature mounted
 * through `runtime.hosted` never touches the plan, so masking alone would
 * leave its tools registered on a Turn the page reports as off.
 */
export function firstPartyFeatureOnForBotV1(
  packageId: string,
  enablement: PluginEnablementV1,
): boolean {
  return enablement.enabled[packageId] !== false;
}

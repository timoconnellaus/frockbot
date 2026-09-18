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
// The catalog is a deployment constant, built from source: each seeded entry
// is an artifact `scripts/build-seeded-plugins.ts` produced from a directory
// under `seeded/`, so nothing here names an artifact that does not exist.
import {
  decodePluginDescriptorV1,
  type PluginDescriptorV1,
} from "@frockbot/core/contracts";
import type {
  ArtifactRefV1,
  CompositionMemberV1,
} from "@frockbot/core/durable";
import {
  CAPABILITY_DESCRIPTIONS,
  PROVIDER_PLUGIN_DESCRIPTIONS_V1,
} from "@frockbot/app/settings/catalog-copy";
import type { PluginEnablementV1 } from "./enablement.js";
import { SEEDED_PLUGIN_ARTIFACTS_V1 } from "./seeded/artifacts.generated.js";

export const PLUGIN_SEED_STATES_V1 = [
  "locked",
  "default-on",
  "default-off",
  "admin-gated",
  /**
   * Shipped in the catalog and seeded on no account: an `installable` Plugin
   * joins a User's Composition when the account installs the Package it
   * belongs to, with its own command (ADR 0032). It is the state a provider
   * Plugin has until there is a marketplace to browse.
   */
  "installable",
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

/** How one seeded Plugin is described on the Plugins page, and how it ships. */
export interface SeededPluginWordsV1 {
  displayName: string;
  description: string;
  seed: PluginSeedStateV1;
}

/** How each seeded Plugin is described on the Plugins page, and how it ships. */
const SEEDED_PLUGIN_WORDS_V1: Record<string, SeededPluginWordsV1> = {
  // The five locked card Plugins (ADR 0030 step 7). Each draws one of the
  // rich things a Bot could say in the conversation before Cards existed, so
  // the deployment's own cards go through the path a User's Plugin goes
  // through. They are `locked` because the conversation cannot lose the
  // ability to ask for a decision, hand over a file, or say a credential is
  // missing: a switch on one of these would be a switch on the Bot's voice.
  agents: {
    displayName: "Agent cards",
    description:
      "Draws what one of your Bots tells you about a Bot \u2014 a staged template, a hand-off. Always on.",
    seed: "locked",
  },
  approvals: {
    displayName: "Approval cards",
    description:
      "Draws the card that asks you to allow or refuse one action, and shows what you decided. The decision itself is FrockBot's own record, never this plugin's. Always on.",
    seed: "locked",
  },
  attachments: {
    displayName: "Attachment cards",
    description:
      "Draws a file one of your Bots is handing you, with a way to open it. Always on.",
    seed: "locked",
  },
  credentials: {
    displayName: "Credential cards",
    description:
      "Draws the card that says a credential is missing and where you add it. A secret never crosses the conversation. Always on.",
    seed: "locked",
  },
  questions: {
    displayName: "Question cards",
    description:
      "Draws a question with up to six answers and sends the one you pick back to your Bot. Always on.",
    seed: "locked",
  },
  /**
   * The first provider Plugin (ADR 0032). It is `installable`: shipped in the
   * catalog, seeded on no account, and installed by the account's own
   * `user/install-package` command for the provider Package it belongs to —
   * which is the closest thing this deployment has to a marketplace until one
   * exists.
   */
  deepseek: {
    displayName: "DeepSeek",
    // The account Plugins row describes the same Plugin when the account
    // installs its Package, so the words come from one place (catalog-copy).
    description: PROVIDER_PLUGIN_DESCRIPTIONS_V1["provider-deepseek"],
    seed: "installable",
  },
  email: {
    displayName: "Email",
    description:
      "Draft an email as a card in the conversation, and send it through this deployment once you have approved it. Off until you switch it on.",
    // Off until a person switches it on: a Bot that can put a draft in front
    // of you is not something every Bot should start with.
    seed: "default-off",
  },
};

/**
 * The deployment's words for one seeded Plugin.
 *
 * A directory built without an entry above is the build's mistake and not a
 * Composition read's, so `scripts/build-seeded-plugins.ts` asks this before it
 * writes an artifact and says which file to edit.
 */
export function seededPluginWordsV1(pluginId: string): SeededPluginWordsV1 {
  const words = SEEDED_PLUGIN_WORDS_V1[pluginId];
  if (!words) {
    throw new Error(
      `seeded plugin "${pluginId}" has no entry in app/plugins/catalog.ts`,
    );
  }
  return words;
}

/**
 * What this deployment seeds.
 *
 * One entry per directory under `app/plugins/seeded/`, built by
 * `scripts/build-seeded-plugins.ts` — the artifact, its content hash and the
 * descriptor all come from that build, so a catalog entry cannot name an
 * artifact nobody built. The words each card shows are here, because they are
 * the deployment's, not the Plugin's.
 */
export const DEPLOYMENT_PLUGIN_CATALOG_V1: readonly SeededPluginV1[] =
  SEEDED_PLUGIN_ARTIFACTS_V1.map((artifact) =>
    decodeSeededPluginV1({
      pluginId: artifact.pluginId,
      ...seededPluginWordsV1(artifact.pluginId),
      artifact: {
        contentHash: artifact.contentHash,
        size: artifact.size,
        mediaType: "application/javascript",
        bundlerVersion: artifact.bundlerVersion,
      },
      descriptor: artifact.descriptor,
    }),
  );

/**
 * The content hash of the deployment's own artifact for one Plugin, when the
 * deployment ships it. It is what makes "this Plugin serves this provider" a
 * fact about bytes rather than about a descriptor a member carries.
 */
/**
 * What a Worker entry may set before the first request. The catalog is the
 * one option a second product has to keep the five locked card Plugins and
 * add its own without forking a Durable Object (ADR 0028).
 */
export interface WorkerAppOptionsV1 {
  pluginCatalog?: readonly SeededPluginV1[];
}

let configuredPluginCatalogV1: readonly SeededPluginV1[] | undefined;

/**
 * The Worker factory's options object. Omitted catalog keeps FrockBot's
 * seeded set. A consumer calls this from its thin entry, once, at load.
 */
export function configureWorkerAppV1(options: WorkerAppOptionsV1 = {}): void {
  if (options.pluginCatalog === undefined) return;
  configuredPluginCatalogV1 = Object.freeze(
    decodePluginCatalogV1(options.pluginCatalog),
  );
}

/** Test-only: drop a catalog a previous case configured. */
export function resetWorkerAppV1(): void {
  configuredPluginCatalogV1 = undefined;
}

/**
 * The catalog this Worker is running. A consumer override wins; otherwise
 * this is FrockBot's seeded set.
 */
export function deploymentPluginCatalogV1(): readonly SeededPluginV1[] {
  return configuredPluginCatalogV1 ?? DEPLOYMENT_PLUGIN_CATALOG_V1;
}

export function deploymentPluginArtifactHashV1(
  pluginId: string,
): string | undefined {
  return deploymentPluginCatalogV1().find(
    (plugin) => plugin.pluginId === pluginId,
  )?.artifact.contentHash;
}

/**
 * The catalog entries one account's Composition carries: every seeded Plugin
 * except an admin-gated one the admin has not opened for this account.
 */
export function seededPluginsForAccountV1(
  catalog: readonly SeededPluginV1[],
  adminOpened: readonly string[],
): SeededPluginV1[] {
  return catalog.filter((plugin) => {
    // An installable Plugin is never seeded: the account's own install
    // command is what puts it in a generation, and reconciliation there
    // leaves it exactly where that command put it.
    if (plugin.seed === "installable") return false;
    return (
      plugin.seed !== "admin-gated" || adminOpened.includes(plugin.pluginId)
    );
  });
}

/**
 * An installable Plugin as a Composition member, installed by the account's
 * own command. The provenance is what keeps it: reconciliation rewrites the
 * seeded members and the Bot-authored ones, and leaves this one alone.
 */
export function installedMemberV1(
  plugin: SeededPluginV1,
  userId: string,
  installedAt: string,
): CompositionMemberV1 {
  return {
    packageId: plugin.pluginId,
    version: plugin.descriptor.version,
    provenance: {
      kind: "installed",
      packageId: plugin.pluginId,
      version: plugin.descriptor.version,
      userId,
      installedAt,
    },
    artifact: plugin.artifact,
    descriptor: plugin.descriptor,
  };
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
 * `locked` always runs; `default-off` runs only when switched on; `default-on`
 * and an opened `admin-gated` run unless switched off.
 *
 * A Plugin a Bot wrote — no seed, because the catalog never lists it — runs
 * only when switched on, like `default-off`. The switch is the User's answer
 * to the approval card the authoring Bot asked for, or the switch on a
 * sibling Bot's Plugins page; a publish on its own runs nowhere, which is
 * what "self-modification never widens authority by itself" means here.
 */
export function pluginRunsForBotV1(
  seed: PluginSeedStateV1 | undefined,
  pluginId: string,
  enablement: PluginEnablementV1,
): boolean {
  if (seed === "locked") return true;
  const flag = enablement.enabled[pluginId];
  if (seed === undefined || seed === "default-off" || seed === "installable") {
    return flag === true;
  }
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

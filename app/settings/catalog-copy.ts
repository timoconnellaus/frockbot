import {
  FOUNDATION_PACKAGES_V1,
  foundationPackageV1,
} from "@frockbot/app/packages";
import { PLUGIN_SERVED_PROVIDERS_V1 } from "@frockbot/providers/catalog/definition";

export const BUILT_IN_PACKAGE_IDS = new Set(
  FOUNDATION_PACKAGES_V1.map((pkg) => pkg.id),
);

/**
 * What a provider Plugin does, keyed by the Package whose installation puts it
 * in an account (ADR 0032).
 *
 * Two surfaces read this sentence — the account Plugins row, where the thing
 * the person installed is the Package, and the Bot's Plugins card, where it is
 * the Plugin — so it is written once and neither can drift from the other. It
 * is a description of the Plugin, which is the code that answers a Turn: the
 * Package beside it owns the Connections and the model list.
 */
export const PROVIDER_PLUGIN_DESCRIPTIONS_V1: Record<string, string> = {
  "provider-deepseek":
    "Run replies on DeepSeek models. Connect a DeepSeek API key in Models, then choose a DeepSeek model. The key is held by the deployment and never reaches the Plugin.",
};

/**
 * Whether this Package is one whose provider is served by an installed Plugin
 * (ADR 0032), which is a fact about the deployment's compiled provider entry
 * rather than about any copy. A compiled provider — one this application still
 * answers with its own adapter — is not one of these.
 */
export function providerPluginPackageV1(packageId: string): boolean {
  return PLUGIN_SERVED_PROVIDERS_V1.some(
    (entry) => entry.packageId === packageId,
  );
}

/**
 * Whether a Package's row belongs on the account Plugins page.
 *
 * Every first-party Package has a surface of its own — Models for a provider,
 * Account features for a capability — and listing it here as well is how the
 * same switch ends up in two places. A provider Plugin is the exception: its
 * code is an installed artifact that runs a Turn, so once the account has it,
 * it is one of the Plugins and is listed where the Plugins are.
 *
 * The state that counts is `installed`, not merely a row's existence: every
 * account starts holding a disabled row for each Package the deployment turns
 * on by default, which is not an installation of anything. Before the account
 * installs a provider Plugin there is nothing here to list — the Marketplace
 * is the separate surface that offers installable catalog entries.
 */
export function pluginsPageRowV1(plugin: {
  packageId: string;
  state: string;
}): boolean {
  if (!BUILT_IN_PACKAGE_IDS.has(plugin.packageId)) return true;
  return (
    providerPluginPackageV1(plugin.packageId) && plugin.state === "installed"
  );
}

export const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  "custom-models":
    "Choose a different model for an individual Bot in its settings.",
  "machine-messages":
    "Read and send Messages through your Mac. Setup and your approval are required.",
  web: "Read public web pages to help answer your questions.",
  routines: "Run a Bot’s instructions at scheduled times.",
  image: "Create images from a description.",
  subagents:
    "Let a Bot delegate parts of a task to helper agents. May use additional model calls.",
};

/**
 * Whether this Package answers model calls, as the compiled catalog states it:
 * a provider is the thing that contributes a model capability.
 *
 * The distinction matters because a Package whose configuration lives in
 * Models is not necessarily one: Custom models also routes there — it is the
 * model-role setting a Bot's own choice is stored in — and it is a capability
 * this surface offers like any other.
 */
function providerPackageV1(packageId: string): boolean {
  return (foundationPackageV1(packageId)?.capabilities ?? []).some(
    (capability) => capability.kind === "model",
  );
}

/**
 * Which built-in Packages the Account features surface offers.
 *
 * The described capabilities are the offer. A built-in a User turned off while
 * Plugins still listed it is offered too: Plugins no longer shows a built-in,
 * so this is the only surface that can hand back a choice the User already
 * made. A provider is never offered: an account is connected and turned on in
 * Models, and a second switch for the same Package would disagree with it.
 */
export function capabilityIsOfferedV1(plugin: {
  packageId: string;
  state: string;
}): boolean {
  if (providerPackageV1(plugin.packageId)) return false;
  return (
    Object.hasOwn(CAPABILITY_DESCRIPTIONS, plugin.packageId) ||
    plugin.state === "disabled"
  );
}

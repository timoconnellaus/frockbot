import { FOUNDATION_PACKAGES_V1 } from "@frockbot/app/packages";

export const BUILT_IN_PACKAGE_IDS = new Set(
  FOUNDATION_PACKAGES_V1.map((pkg) => pkg.id),
);

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
 * Which built-in Packages the Account features surface offers.
 *
 * The described capabilities are the offer. A built-in a User turned off while
 * Plugins still listed it is offered too: Plugins no longer shows a built-in,
 * so this is the only surface that can hand back a choice the User already
 * made. Providers are not here — an account is connected and turned on in
 * Models, and a second switch for the same Package would disagree with it.
 */
export function capabilityIsOfferedV1(plugin: {
  packageId: string;
  state: string;
  home: string;
}): boolean {
  return (
    Object.hasOwn(CAPABILITY_DESCRIPTIONS, plugin.packageId) ||
    (plugin.state === "disabled" && plugin.home !== "models")
  );
}

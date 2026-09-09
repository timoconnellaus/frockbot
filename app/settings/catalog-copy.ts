import { FOUNDATION_PACKAGES_V1 } from "@frockbot/app/packages";

export const BUILT_IN_PACKAGE_IDS = new Set(
  FOUNDATION_PACKAGES_V1.map((pkg) => pkg.id),
);

export const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  "custom-models":
    "Choose a different model for an individual Bot in its settings.",
  search: "Find past messages and work across your Bots.",
  "machine-messages":
    "Read and send Messages through your Mac. Setup and your approval are required.",
  web: "Read public web pages to help answer your questions.",
  routines: "Run a Bot’s instructions at scheduled times.",
  image: "Create images from a description.",
  subagents:
    "Let a Bot delegate parts of a task to helper agents. May use additional model calls.",
};

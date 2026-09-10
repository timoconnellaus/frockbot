import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

/**
 * Voice: the composer's dictation and the account-wide voice session. No
 * settings, Capabilities or Connection Types of its own — the provider keys
 * are deployment secrets, never a User's — so this is the id and the name.
 */
export const voiceDefinitionV1: PackageDefinitionV1 = {
  id: "voice",
  displayName: "Voice",
  dependencies: ["shell"],
  platformOwned: true,
};

// The Packages this application ships.
//
// First-party code has no manifest and no compiler: the list below *is* the
// declaration that a Package exists, and a Package that carries data —
// settings, Capabilities, Connection Types, durable roots, dependencies —
// exports that data from its own package as a `PackageDefinitionV1`. A
// Package with none of it appears here as an id and a display name, which is
// all the product ever needed to know about it.
import type { PackageDefinitionV1 } from "@frockbot/core/contracts";
import { adminDefinitionV1 } from "@frockbot/plugin-admin/definition";
import { appletsDefinitionV1 } from "@frockbot/applets/definition";
import { auditDefinitionV1 } from "@frockbot/plugin-audit/definition";
import { authDefinitionV1 } from "@frockbot/plugin-auth/definition";
import { botTemplateDefinitionV1 } from "@frockbot/plugin-bot-template/definition";
import { computerDefinitionV1 } from "@frockbot/plugin-computer/definition";
import { credentialsDefinitionV1 } from "@frockbot/plugin-credentials/definition";
import { customModelsDefinitionV1 } from "@frockbot/plugin-custom-models/definition";
import { flockDefinitionV1 } from "@frockbot/plugin-flock/definition";
import { imageDefinitionV1 } from "@frockbot/plugin-image/definition";
import { machineMessagesDefinitionV1 } from "@frockbot/plugin-machine-messages/definition";
import { providerAnthropicDefinitionV1 } from "@frockbot/providers/anthropic/definition";
import { providerFlockAiDefinitionV1 } from "@frockbot/providers/frock-ai/definition";
import { providerOllamaCloudDefinitionV1 } from "@frockbot/providers/ollama-cloud/definition";
import { routinesDefinitionV1 } from "@frockbot/plugin-routines/definition";
import { searchDefinitionV1 } from "@frockbot/plugin-search/definition";
import { settingsDefinitionV1 } from "@frockbot/plugin-settings/definition";
import { shellDefinitionV1 } from "@frockbot/plugin-shell/definition";
import { subagentsDefinitionV1 } from "@frockbot/plugin-subagents/definition";
import { uiThemeDefinitionV1 } from "@frockbot/plugin-ui-theme/definition";
import { userMachineDefinitionV1 } from "@frockbot/plugin-user-machine/definition";
import { webDefinitionV1 } from "@frockbot/plugin-web/definition";

/**
 * The version a first-party Package's durable installation row records.
 *
 * A first-party Package's version *is* the deploy: there is no separate
 * artifact to pin and nothing to resolve a range against. The User's
 * installation model still carries a version, so it carries this one.
 */
export const FOUNDATION_PACKAGE_VERSION_V1 = "0.0.1";

export const FOUNDATION_PACKAGES_V1: readonly PackageDefinitionV1[] = [
  uiThemeDefinitionV1,
  authDefinitionV1,
  adminDefinitionV1,
  { id: "identity", displayName: "FrockBot Identity" },
  { id: "provider-foundation", displayName: "Built-in models" },
  { id: "skills", displayName: "Skills" },
  { id: "echo", displayName: "Echo" },
  shellDefinitionV1,
  settingsDefinitionV1,
  customModelsDefinitionV1,
  routinesDefinitionV1,
  credentialsDefinitionV1,
  webDefinitionV1,
  providerOllamaCloudDefinitionV1,
  providerFlockAiDefinitionV1,
  providerAnthropicDefinitionV1,
  flockDefinitionV1,
  botTemplateDefinitionV1,
  searchDefinitionV1,
  auditDefinitionV1,
  { id: "clock", displayName: "Clock" },
  { id: "memory", displayName: "Memory" },
  imageDefinitionV1,
  computerDefinitionV1,
  { id: "fly-sprite", displayName: "Computer" },
  userMachineDefinitionV1,
  machineMessagesDefinitionV1,
  subagentsDefinitionV1,
  appletsDefinitionV1,
];

/** One Package's definition, or `undefined` when this deployment has none. */
export function foundationPackageV1(
  packageId: string,
): PackageDefinitionV1 | undefined {
  return FOUNDATION_PACKAGES_V1.find(
    (definition) => definition.id === packageId,
  );
}

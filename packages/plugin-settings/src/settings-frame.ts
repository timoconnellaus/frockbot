import { resolveUserDisplayName } from "./user-display-name.js";
import {
  decodeConfigurationCommandV1,
  packageConfigurationHomeV1,
  ConfigurationDecodeError,
  ConfigurationConflictError,
  modelBindingFailureV1,
  MAX_PACKAGE_SETTING_TEXT_V1,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  decodeProtocol,
  type SettingField,
  type SettingsFrame,
  type SettingChoice,
  type SettingsOptionsPage,
} from "@frockbot/protocol-schemas";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import type { AvailableUserPackage } from "./user.js";

function field(
  definition: PackageSettingDefinition,
  value: unknown,
): SettingField {
  const schema = definition.schema;
  const kind = schema.enum
    ? "select"
    : schema.type === "boolean"
      ? "boolean"
      : schema.type === "number" || schema.type === "integer"
        ? "number"
        : schema.type === "string"
          ? "text"
          : undefined;
  if (!kind) throw new Error("Unsupported setting kind");
  return decodeProtocol("SettingField", {
    id: definition.id,
    label: schema.title ?? definition.id,
    kind,
    value: value ?? null,
    editable: true,
    isSet: value !== undefined,
    canReset: true,
    ...(schema.description ? { hint: schema.description } : {}),
    ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
    ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
    ...(kind === "text"
      ? {
          maxLength: Math.min(
            schema.maxLength ?? MAX_PACKAGE_SETTING_TEXT_V1,
            MAX_PACKAGE_SETTING_TEXT_V1,
          ),
        }
      : {}),
    ...(schema.enum
      ? {
          choices: schema.enum.map((value) => ({
            label: String(value),
            value,
          })),
        }
      : {}),
  });
}

/** The owner projects trusted declarations, never credentials or executable UI. */
export function applicationSettingsFrame(
  userId: string,
  settings: UserSettingsViewV1,
  catalog: readonly AvailableUserPackage[],
  identity?: { name?: string; email?: string },
): SettingsFrame {
  const sections: SettingsFrame["sections"] = [
    {
      id: "profile",
      label: "Your profile",
      fields: [
        {
          id: "name",
          label: "Name",
          kind: "text",
          value: resolveUserDisplayName({
            savedName: settings.profile.name,
            sessionName: identity?.name,
            sessionEmail: identity?.email,
          }).slice(0, 100),
          editable: true,
          required: true,
          maxLength: 100,
        },
        {
          id: "email",
          label: "Email",
          kind: "text",
          value: settings.profile.email ?? identity?.email ?? "",
          editable: true,
          hint: "Optional",
          maxLength: 320,
        },
      ],
    },
  ];
  for (const installed of settings.packages) {
    if (installed.state !== "installed") continue;
    const item = catalog.find(
      (candidate) =>
        candidate.packageId === installed.packageId &&
        candidate.version === installed.version,
    );
    if (!item || packageConfigurationHomeV1(item) !== "user-settings") continue;
    if (sections.length === 63) {
      sections.push({
        id: "overflow",
        label: "More settings",
        fields: [],
        failure:
          "Some plugin settings need a newer app. Your profile and the settings above are still available.",
      });
      break;
    }
    const section = {
      id: `package.${item.packageId}`,
      packageId: item.packageId,
      label: item.displayName ?? item.packageId,
    };
    try {
      const fields = (item.settings ?? [])
        .filter(
          (setting) =>
            setting.scopes.includes("user") && setting.role !== "model",
        )
        .map((setting) => field(setting, installed.values?.[setting.id]));
      const valid = decodeProtocol("SettingsFrame", {
        schemaVersion: 1,
        home: "application",
        ownerId: userId,
        revision: settings.revision,
        title: "Settings",
        sections: [{ ...section, fields }],
      });
      sections.push(valid.sections[0]!);
    } catch {
      sections.push({
        ...section,
        fields: [],
        failure:
          "These settings need a newer app. Your profile and other settings are still available.",
      });
    }
  }
  return decodeProtocol("SettingsFrame", {
    schemaVersion: 1,
    home: "application",
    ownerId: userId,
    revision: settings.revision,
    title: "Settings",
    sections,
  });
}

/** Stable translation: no current values are merged into a retried command. */
export function applicationSettingsCommand(
  input: unknown,
): UserConfigurationCommandV1 {
  const command = decodeProtocol("SettingsChangeCommand", input);
  const meta = {
    schemaVersion: 1,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
  };
  if (command.sectionId === "profile") {
    if (
      (command.values.email !== undefined &&
        typeof command.values.email !== "string") ||
      command.unset?.length ||
      Object.keys(command.values).some(
        (key) => key !== "name" && key !== "email",
      )
    )
      throw new ConfigurationDecodeError("Invalid profile fields");
    return userCommand({
      ...meta,
      type: "user/update-profile",
      profile: {
        name: command.values.name,
        ...(command.values.email ? { email: command.values.email } : {}),
      },
    });
  }
  if (!command.sectionId.startsWith("package."))
    throw new ConfigurationDecodeError("Unknown settings section");
  return userCommand({
    ...meta,
    type: "user/set-package-settings",
    packageId: command.sectionId.slice(8),
    values: command.values,
    ...(command.unset ? { unset: command.unset } : {}),
  });
}

function userCommand(value: unknown): UserConfigurationCommandV1 {
  const command = decodeConfigurationCommandV1(value);
  if ("botId" in command)
    throw new ConfigurationDecodeError("Expected User command");
  return command;
}

function* modelChoices(
  settings: UserSettingsViewV1,
  catalog: readonly AvailableUserPackage[],
): Generator<SettingChoice> {
  const platform = settings.connections.find(
    (connection) =>
      connection.connectionId === settings.platformModel?.connectionId,
  );
  const label =
    catalog.find((pkg) => pkg.packageId === platform?.packageId)?.displayName ??
    "Platform";
  yield { label: `${label} · Auto`.slice(0, 200), value: null };
  const packages = catalog.map((pkg) => ({
    ...pkg,
    settings: [...(pkg.settings ?? [])],
    capabilities: [...(pkg.capabilities ?? [])],
    connectionTypes: [...(pkg.connectionTypes ?? [])],
  }));
  for (const connection of settings.connections) {
    if (!connection.providerType) continue;
    for (const model of connection.modelCatalog?.models ?? []) {
      // The platform's current binding is already represented by Auto.
      if (
        connection.connectionId === settings.platformModel?.connectionId &&
        model.providerModelId === settings.platformModel.providerModelId
      )
        continue;
      const value = {
        connectionId: connection.connectionId,
        providerModelId: model.providerModelId,
      };
      if (modelBindingFailureV1({ model: value, user: settings, packages }))
        continue;
      yield {
        label: `${model.displayName} · ${connection.displayName}`.slice(0, 200),
        value,
      };
    }
  }
}

export function modelSettingsOptions(
  userId: string,
  settings: UserSettingsViewV1,
  catalog: readonly AvailableUserPackage[],
  input: unknown,
): SettingsOptionsPage {
  const query = decodeProtocol("SettingsOptionsQuery", input);
  if (query.revision !== settings.revision)
    throw new ConfigurationConflictError(settings.revision);
  const needle = query.query.trim().toLocaleLowerCase();
  const offset = query.cursor ?? 0;
  const items: SettingChoice[] = [];
  let matched = 0;
  let more = false;
  for (const choice of modelChoices(settings, catalog)) {
    if (
      needle &&
      !choice.label.toLocaleLowerCase().includes(needle) &&
      !JSON.stringify(choice.value).toLocaleLowerCase().includes(needle)
    )
      continue;
    if (matched++ < offset) continue;
    if (items.length === 50) {
      more = true;
      break;
    }
    items.push(choice);
  }
  return decodeProtocol("SettingsOptionsPage", {
    schemaVersion: 1,
    ownerId: userId,
    source: query.source,
    revision: settings.revision,
    items,
    ...(more ? { nextCursor: offset + items.length } : {}),
  });
}

export function modelsSettingsFrame(
  userId: string,
  settings: UserSettingsViewV1,
  catalog: readonly AvailableUserPackage[],
): SettingsFrame {
  const providers = catalog.filter(
    (pkg) =>
      !pkg.platformOwned &&
      pkg.capabilities?.some((capability) => capability.kind === "model"),
  );
  const selected = settings.accountModel ? { ...settings.accountModel } : null;
  const choices: SettingChoice[] = [];
  for (const choice of modelChoices(settings, catalog)) {
    if (
      choice.value === null ||
      JSON.stringify(choice.value) === JSON.stringify(selected)
    )
      choices.push(choice);
  }
  if (selected && choices.length === 1)
    choices.push({
      label: "Your saved model · currently unavailable",
      value: selected,
    });
  const sections: SettingsFrame["sections"] = [
    {
      id: "model",
      label: "Default model",
      fields: [
        {
          id: "account-model",
          label: "Model",
          kind: "select",
          value: selected,
          editable: true,
          choices,
          choiceSource: "account-models",
          hint: "Used by all your Bots. Auto follows the platform model.",
        },
      ],
    },
  ];
  for (const provider of providers) {
    if (sections.length === 63) {
      sections.push({
        id: "provider-overflow",
        label: "More providers",
        fields: [],
        failure:
          "Additional provider setup is unavailable in this version. Your default model is still available.",
      });
      break;
    }
    const installed = settings.packages.find(
      (pkg) => pkg.packageId === provider.packageId,
    );
    const connections = settings.connections.filter(
      (connection) => connection.packageId === provider.packageId,
    );
    sections.push({
      id: `provider.${provider.packageId}`,
      packageId: provider.packageId,
      label: provider.displayName ?? provider.packageId,
      fields: [],
      credentialStatus: connections.some(
        (connection) => connection.state === "ready",
      )
        ? "connected"
        : "missing",
      ...(installed?.state === "failed"
        ? { failure: "This provider needs recovery before it can be chosen." }
        : {
            actions: [
              {
                kind:
                  installed?.state === "installed"
                    ? "manage-provider"
                    : "choose-provider",
                label:
                  installed?.state === "installed"
                    ? "Manage account"
                    : "Choose provider",
                packageId: provider.packageId,
              },
            ],
          }),
    });
  }
  return decodeProtocol("SettingsFrame", {
    schemaVersion: 1,
    home: "models",
    ownerId: userId,
    revision: settings.revision,
    title: "Models",
    sections,
  });
}

export function modelsSettingsCommand(
  input: unknown,
): UserConfigurationCommandV1 {
  const command = decodeProtocol("SettingsChangeCommand", input);
  const meta = {
    schemaVersion: 1,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
  };
  if (command.unset?.length)
    throw new ConfigurationDecodeError("Invalid model command");
  if (
    command.sectionId === "model" &&
    Object.keys(command.values).join() === "account-model"
  )
    return userCommand({
      ...meta,
      type: "user/set-account-model",
      model: command.values["account-model"],
    });
  if (
    command.sectionId.startsWith("provider.") &&
    Object.keys(command.values).length === 0
  )
    return userCommand({
      ...meta,
      type: "user/choose-model-provider",
      packageId: command.sectionId.slice(9),
    });
  throw new ConfigurationDecodeError("Unknown model section");
}

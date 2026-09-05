import {
  decodeConfigurationCommandV1,
  packageConfigurationHomeV1,
  ConfigurationDecodeError,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  decodeProtocol,
  type SettingField,
  type SettingsFrame,
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
    ...(schema.description ? { hint: schema.description } : {}),
    ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
    ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
    ...(schema.maxLength === undefined ? {} : { maxLength: schema.maxLength }),
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
          value: settings.profile.name,
          editable: true,
          required: true,
          maxLength: 100,
        },
        {
          id: "email",
          label: "Email",
          kind: "text",
          value: settings.profile.email ?? "",
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

export function modelsSettingsFrame(
  userId: string,
  settings: UserSettingsViewV1,
  catalog: readonly AvailableUserPackage[],
): SettingsFrame {
  const providers = catalog.filter((pkg) =>
    pkg.capabilities?.some((capability) => capability.kind === "model"),
  );
  const choices: NonNullable<SettingField["choices"]> = [
    { label: "FrockBot · Auto", value: null },
  ];
  for (const connection of settings.connections) {
    if (
      connection.state !== "ready" ||
      !settings.packages.some(
        (pkg) =>
          pkg.packageId === connection.packageId && pkg.state === "installed",
      )
    )
      continue;
    const provider = providers.find(
      (pkg) => pkg.packageId === connection.packageId,
    );
    if (!provider) continue;
    for (const model of connection.modelCatalog?.models ?? []) {
      if (choices.length === 99) break;
      choices.push({
        label: `${model.displayName} · ${connection.displayName}`,
        value: {
          connectionId: connection.connectionId,
          providerModelId: model.providerModelId,
        },
      });
    }
  }
  const selected = settings.accountModel ? { ...settings.accountModel } : null;
  if (
    selected &&
    !choices.some(
      (choice) => JSON.stringify(choice.value) === JSON.stringify(selected),
    )
  )
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
          hint: "Used by all your Bots. Auto follows FrockBot’s platform model.",
        },
      ],
    },
  ];
  for (const provider of providers.slice(0, 63)) {
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

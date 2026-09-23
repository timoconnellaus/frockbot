import { resolveUserDisplayName } from "./user-display-name.js";
import {
  decodeConfigurationCommandV1,
  packageConfigurationHomeV1,
  ConfigurationDecodeError,
  ConfigurationConflictError,
  modelBindingFailureV1,
  resolveEffectiveBotModelV1,
  userTimezoneV1,
  modelRuntimeLabel,
  MAX_PACKAGE_SETTING_TEXT_V1,
  type ConnectionView,
  type UserConfigurationCommandV1,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";
import {
  decodeProtocol,
  type SettingField,
  type SettingsFrame,
  type ConnectionsFrame,
  type SettingChoice,
  type SettingsOptionsPage,
} from "@frockbot/core/protocol-schemas";

import type { PackageSettingDefinition } from "@frockbot/core/contracts";
import type { AvailableUserPackage } from "./user.js";

const IMAGE_MODEL_LABELS: Record<string, string> = {
  "@cf/black-forest-labs/flux-1-schnell": "FLUX.1 Schnell",
  "@cf/black-forest-labs/flux-2-klein-4b": "FLUX.2 Klein",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0": "Stable Diffusion XL",
  "@cf/bytedance/stable-diffusion-xl-lightning":
    "Stable Diffusion XL Lightning",
};

/**
 * Most choices one setting field may carry on the wire (`SettingField.choices`
 * in the client schema). The zone catalog comes from the host ICU build and
 * grows with tzdata, and a catalog one entry over the bound would fail the
 * whole Settings document rather than one row.
 */
const MAX_SETTING_CHOICES_V1 = 600;

const PROFILE_TIMEZONES_V1 = Object.freeze(
  [
    "UTC",
    ...Intl.supportedValuesOf("timeZone").filter(
      (timezone) => timezone !== "UTC",
    ),
    // One slot is left for a saved selection the catalog does not name.
  ].slice(0, MAX_SETTING_CHOICES_V1 - 1),
);

function timezoneLabelV1(timezone: string): string {
  return timezone
    .split("/")
    .map((part) => part.replaceAll("_", " "))
    .join(" / ");
}

function timezoneChoicesV1(current: string): SettingChoice[] {
  const timezones = PROFILE_TIMEZONES_V1.includes(current)
    ? PROFILE_TIMEZONES_V1
    : [...PROFILE_TIMEZONES_V1, current];
  return timezones.map((timezone) => ({
    label: timezoneLabelV1(timezone),
    value: timezone,
  }));
}

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
            label: IMAGE_MODEL_LABELS[String(value)] ?? String(value),
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
  identity?: { name?: string; email?: string; image?: string },
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
          hint: "Optional contact email. This does not change your sign-in account.",
          maxLength: 320,
        },
        {
          id: "timezone",
          label: "Time zone",
          kind: "select",
          value: userTimezoneV1(settings.profile),
          editable: true,
          required: true,
          hint: "Your Routines use this time zone.",
          choices: timezoneChoicesV1(userTimezoneV1(settings.profile)),
        },
        // The Google photo, when the identity provider has one. Settings
        // does not edit it; the client reads it for the person's face.
        ...(typeof identity?.image === "string" &&
        identity.image.startsWith("https://")
          ? [
              {
                id: "photo",
                label: "Photo",
                kind: "text" as const,
                value: identity.image.slice(0, 2048),
                editable: false,
                maxLength: 2048,
              },
            ]
          : []),
      ],
    },
    {
      id: "appearance",
      label: "Appearance",
      fields: [
        {
          id: "look",
          label: "Look",
          kind: "select",
          value: settings.appearance?.look ?? "ink",
          editable: true,
          required: true,
          hint: "Ink is the dark look, Paper the light one. System follows your device.",
          choices: [
            { label: "Ink", value: "ink" },
            { label: "Paper", value: "paper" },
            { label: "System", value: "system" },
          ],
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
        (key) => key !== "name" && key !== "email" && key !== "timezone",
      )
    )
      throw new ConfigurationDecodeError("Invalid profile fields");
    return userCommand({
      ...meta,
      type: "user/update-profile",
      profile: {
        name: command.values.name,
        ...(command.values.email ? { email: command.values.email } : {}),
        timezone: command.values.timezone,
      },
    });
  }
  if (command.sectionId === "appearance") {
    if (
      command.unset?.length ||
      Object.keys(command.values).some((key) => key !== "look") ||
      (command.values.look !== "ink" &&
        command.values.look !== "paper" &&
        command.values.look !== "system")
    )
      throw new ConfigurationDecodeError("Invalid appearance fields");
    return userCommand({
      ...meta,
      type: "user/update-appearance",
      appearance: { look: command.values.look },
    });
  }
  if (!command.sectionId.startsWith("package."))
    throw new ConfigurationDecodeError("Unknown settings section");
  return userCommand({
    ...meta,
    type: "user/set-package-settings",
    packageId: command.sectionId.slice(8),
    ...(Object.keys(command.values).length ? { values: command.values } : {}),
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
  yield { label: "Automatic — recommended", value: null };
  const packages = catalog.map((pkg) => ({
    ...pkg,
    settings: [...(pkg.settings ?? [])],
    capabilities: [...(pkg.capabilities ?? [])],
    connectionTypes: [...(pkg.connectionTypes ?? [])],
  }));
  for (const connection of settings.connections) {
    if (!connection.providerType) continue;
    // A platform model needs no key and was never added from the Marketplace,
    // so it says so rather than reading as a provider someone connected.
    const source = packages.find(
      (pkg) => pkg.packageId === connection.packageId,
    )?.platformOwned
      ? `${connection.displayName} · built in, no key needed`
      : connection.displayName;
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
        label: `${model.displayName} · ${source}`.slice(0, 200),
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
  const modelProviders = catalog.filter(
    (pkg) =>
      !pkg.platformOwned &&
      pkg.capabilities?.some((capability) => capability.kind === "model"),
  );
  // A provider earns its own section once a person has added it from the
  // Marketplace. Catalog providers are seeded disabled for everyone, and a
  // key left behind by a provider that was removed is not an addition, so
  // neither shows here: the Marketplace is the catalog and the way back, and
  // this page is only what is set up now.
  const providers = modelProviders.filter((pkg) =>
    settings.packages.some(
      (installation) =>
        installation.packageId === pkg.packageId &&
        installation.state !== "disabled",
    ),
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
          hint: "Default for Bots without their own model choice. Automatic lets FrockBot choose; no setup needed.",
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
    let providerFields: SettingField[] = [];
    let fieldFailure: string | undefined;
    if (
      installed?.state === "installed" &&
      installed.version === provider.version
    ) {
      try {
        providerFields = (provider.settings ?? [])
          .filter(
            (setting) =>
              setting.scopes.includes("user") && setting.role !== "model",
          )
          .map((setting) => field(setting, installed.values?.[setting.id]));
        if (providerFields.length > 32) throw new Error("Provider field limit");
      } catch {
        providerFields = [];
        fieldFailure =
          "These provider settings need a newer app. Account setup is still available.";
      }
    }
    const connected = connections.some(
      (connection) => connection.state === "ready",
    );
    sections.push({
      id: `provider.${provider.packageId}`,
      label: provider.displayName ?? provider.packageId,
      fields: providerFields,
      ...(fieldFailure ? { failure: fieldFailure } : {}),
      credentialStatus: connected ? "connected" : "missing",
      ...(installed?.state === "failed"
        ? { failure: "This provider needs recovery before it can be chosen." }
        : {
            actions: [
              {
                kind: "manage-provider",
                label: connected ? "Manage provider" : "Connect account",
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
  if (
    !command.unset?.length &&
    command.sectionId === "model" &&
    Object.keys(command.values).join() === "account-model"
  )
    return userCommand({
      ...meta,
      type: "user/set-account-model",
      model: command.values["account-model"],
    });
  if (command.sectionId.startsWith("provider."))
    return userCommand({
      ...meta,
      type: "user/set-package-settings",
      packageId: command.sectionId.slice(9),
      ...(Object.keys(command.values).length ? { values: command.values } : {}),
      ...(command.unset ? { unset: command.unset } : {}),
    });
  throw new ConfigurationDecodeError("Unknown model section");
}

/** A Connection's state, in words rather than in the field name. */
function connectionStateLineV1(connection: ConnectionView): string {
  const state =
    connection.state === "ready"
      ? "Ready"
      : connection.state === "disabled"
        ? "Turned off"
        : connection.state === "failed"
          ? "Not working"
          : connection.state === "revoking"
            ? "Disconnecting\u2026"
            : connection.state === "reconciliation-required"
              ? "Needs attention"
              : "Connecting\u2026";
  const catalog = connection.modelCatalog?.state;
  if (!catalog) return state;
  const models =
    catalog === "fresh"
      ? "model list up to date"
      : catalog === "stale"
        ? "model list out of date"
        : catalog === "refreshing"
          ? "refreshing its model list"
          : `model list ${catalog}`;
  return `${state} \u00b7 ${models}`;
}

/**
 * The line the Models surface prints as "Model in use", written where the
 * settings live rather than in a client. The account's own effective model is
 * the answer: Connectors is User-scoped and names no Bot.
 */
function modelInUseLineV1(
  settings: UserSettingsViewV1,
  catalog: readonly AvailableUserPackage[],
): string {
  const effective = resolveEffectiveBotModelV1({
    bot: { packageValues: {} },
    user: settings,
    packages: catalog.map((pkg) => ({
      ...pkg,
      settings: [...(pkg.settings ?? [])],
      capabilities: [...(pkg.capabilities ?? [])],
      connectionTypes: [...(pkg.connectionTypes ?? [])],
    })),
  });
  const connection = effective.binding?.connection;
  const model = connection?.modelCatalog?.models.find(
    (candidate) =>
      candidate.providerModelId === effective.model?.providerModelId,
  );
  const provider = catalog.find(
    (pkg) => pkg.packageId === effective.binding?.packageId,
  );
  return modelRuntimeLabel({
    source: effective.source,
    ...(model?.displayName ? { modelDisplayName: model.displayName } : {}),
    ...(effective.model?.providerModelId
      ? { providerModelId: effective.model.providerModelId }
      : {}),
    ...(provider?.displayName
      ? { packageDisplayName: provider.displayName }
      : {}),
    ...(connection?.displayName
      ? { connectionDisplayName: connection.displayName }
      : {}),
    ...(effective.binding?.failure
      ? { failure: effective.binding.failure }
      : {}),
    fallback: Boolean(effective.fallback),
  }).slice(0, 300);
}

/**
 * Connectors: every account a User holds, and every Package they could hold
 * one against.
 *
 * The frame carries both homes \u2014 a model provider's accounts and a connector
 * Package's \u2014 because the surface a person opens to connect something is one
 * surface. Which home a Package belongs to is still
 * `packageConfigurationHomeV1`; it travels as the row's `kind` so a projection
 * can group by it. Credentials never travel: an account is a name, a state and
 * a line saying what that state means.
 *
 * `catalog` is the Marketplace storefront: every model and connector offer,
 * including Packages nobody has added yet. An uninstalled model row cannot
 * connect (`mayConnect: false`); Add installs the Package, then Connect
 * opens. The ordinary connections read stays installed-only, so Manage
 * provider and older clients do not grow a catalog they cannot add from.
 */
export function connectionsFrame(
  userId: string,
  settings: UserSettingsViewV1,
  catalog: readonly AvailableUserPackage[],
  options: { catalog?: boolean } = {},
): ConnectionsFrame {
  const offerCatalog = options.catalog === true;
  const homes = new Map<string, "model" | "connector">();
  const providers: ConnectionsFrame["providers"] = [];
  for (const item of catalog) {
    if (offerCatalog && item.platformOwned) continue;
    const home = packageConfigurationHomeV1(item);
    if (home !== "models" && home !== "connections") continue;
    const installed = settings.packages.find(
      (installation) =>
        installation.packageId === item.packageId &&
        installation.version === item.version &&
        installation.state === "installed",
    );
    if (!installed && !offerCatalog) continue;
    const kind = home === "models" ? "model" : "connector";
    homes.set(item.packageId, kind);
    for (const type of item.connectionTypes ?? []) {
      // A Connection Type whose variants come from a backend catalog is a list
      // of accounts to pick from before connecting one. That read belongs to
      // the surface that owns the catalog, so it is not a provider row here.
      if (type.catalogPath) continue;
      const connected = settings.connections.filter(
        (connection) =>
          connection.packageId === item.packageId &&
          connection.connectionTypeId === type.id &&
          connection.state !== "revoked",
      ).length;
      // A Connection setting whose schema this projection has no field for
      // leaves the row rather than taking the whole surface down with it: the
      // account can still be connected, on the Connection Type's own defaults.
      const fields: SettingField[] = [];
      if (installed) {
        for (const definition of (type.settings ?? []).slice(0, 8)) {
          try {
            fields.push(field(definition, undefined));
          } catch {
            continue;
          }
        }
      }
      const displayName = (
        (item.connectionTypes?.length ?? 0) > 1
          ? type.displayName
          : (item.displayName ?? type.displayName)
      ).slice(0, 200);
      const description = (
        type.description ??
        (kind === "model"
          ? `Use ${displayName} models with your own key.`
          : undefined)
      )?.slice(0, 300);
      providers.push({
        packageId: item.packageId,
        connectionTypeId: type.id,
        // A Package with one Connection Type is the row; a Package that
        // declares several — one per connectable app — is a grouping, and the
        // type is what a person is connecting.
        displayName,
        kind,
        authorization: type.authorization.kind,
        connected,
        mayConnect:
          Boolean(installed) && (connected === 0 || type.allowMultiple),
        // Added is a fact about the Package, not about its keys: a provider
        // removed with a key left behind is one the Marketplace offers again.
        installed: Boolean(installed),
        ...(fields.length ? { settings: fields } : {}),
        ...(description ? { description } : {}),
        ...(type.icon ? { icon: type.icon } : {}),
      });
    }
  }
  if (offerCatalog) {
    providers.sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  const accounts: ConnectionsFrame["accounts"] = [];
  for (const connection of settings.connections) {
    if (connection.state === "revoked") continue;
    const kind = homes.get(connection.packageId);
    if (!kind) continue;
    const item = catalog.find(
      (candidate) => candidate.packageId === connection.packageId,
    );
    const declared = item?.connectionTypes?.find(
      (type) => type.id === connection.connectionTypeId,
    );
    if (!declared) continue;
    const failure = connection.failure ?? connection.modelCatalog?.failure;
    accounts.push({
      id: connection.connectionId,
      label: connection.displayName.slice(0, 200),
      state: connection.state,
      packageId: connection.packageId,
      connectionTypeId: connection.connectionTypeId,
      kind,
      authorization:
        connection.authorization?.kind ?? declared.authorization.kind,
      detail: connectionStateLineV1(connection).slice(0, 200),
      ...(failure ? { failure: failure.slice(0, 2000) } : {}),
    });
  }

  return decodeProtocol("ConnectionsFrame", {
    schemaVersion: 1,
    ownerId: userId,
    revision: settings.revision,
    accounts,
    providers: providers.slice(0, 100),
    modelInUse: modelInUseLineV1(settings, catalog),
  });
}

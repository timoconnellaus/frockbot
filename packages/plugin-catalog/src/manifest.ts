export type ContributionKind =
  "backend" | "runtime" | "client" | "desktop" | "mobile";

export interface BackendContribution {
  entry: string;
  host: "gateway" | "bot" | "user";
}

export interface RuntimeContribution {
  entry: string;
}

export interface ClientMount {
  slot: string;
  order?: number;
}

export interface ClientContribution {
  entry: string;
  mounts: ClientMount[];
  outlets: string[];
}

export interface DesktopContribution {
  entry: string;
  execution: "sandboxed-renderer" | "trusted-main-legacy";
  commands: string[];
}

export interface MobileContribution {
  entry: string;
}

export type SettingScope = "user" | "bot";

export interface PackageSettingDefinition {
  id: string;
  schemaVersion: number;
  scopes: SettingScope[];
  schema: Record<string, unknown>;
}

export interface ConnectionTypeDefinition {
  id: string;
  displayName: string;
  allowMultiple: boolean;
  authorization: {
    kind: "oauth2" | "api-key" | "custom";
    driverId: string;
  };
  capabilities: string[];
}

export interface CapabilityDefinition {
  id: string;
  kind: "tool" | "model" | "memory" | "notification";
  connectionTypes: string[];
}

export interface PackageConfiguration {
  settings: PackageSettingDefinition[];
  connectionTypes: ConnectionTypeDefinition[];
  capabilities: CapabilityDefinition[];
}

export interface FrockBotManifest {
  schemaVersion: 2 | 3;
  id: string;
  displayName: string;
  version: string;
  compatibility: { frockbot: string };
  dependencies: Record<string, string>;
  contributions: {
    backend?: BackendContribution;
    runtime?: RuntimeContribution;
    client?: ClientContribution;
    desktop?: DesktopContribution;
    mobile?: MobileContribution;
  };
  permissions: string[];
  configuration?: PackageConfiguration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`manifest field "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key] ?? [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw new Error(`manifest field "${key}" must contain non-empty strings`);
  }
  return [...value];
}

function relativeEntry(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!value.startsWith("./")) {
    throw new Error(
      `manifest contribution "${key}" must be a relative export path`,
    );
  }
  return value;
}

function optionalLegacyEntry(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.startsWith("./")) {
    throw new Error(
      `manifest contribution "${key}" must be a relative export path`,
    );
  }
  return value;
}

function decodeDependencies(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new Error("manifest dependencies must be an object");
  const dependencies: Record<string, string> = {};
  for (const [id, range] of Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || typeof range !== "string" || !range) {
      throw new Error("manifest dependencies must map package ids to versions");
    }
    dependencies[id] = range;
  }
  return dependencies;
}

function decodeIdentity(
  value: Record<string, unknown>,
): Pick<FrockBotManifest, "id" | "displayName" | "version" | "permissions"> {
  const id = requiredString(value, "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("manifest id must be lowercase kebab-case");
  }
  return {
    id,
    displayName: requiredString(value, "displayName"),
    version: requiredString(value, "version"),
    permissions: optionalStringArray(value, "permissions"),
  };
}

function decodeV1(value: Record<string, unknown>): FrockBotManifest {
  const identity = decodeIdentity(value);
  if (!isRecord(value.contributions)) {
    throw new Error("manifest contributions must be an object");
  }
  const agent = optionalLegacyEntry(value.contributions, "agent");
  const desktop = optionalLegacyEntry(value.contributions, "desktop");
  const mobile = optionalLegacyEntry(value.contributions, "mobile");
  let client: ClientContribution | undefined;
  if (value.contributions.web !== undefined) {
    const web = value.contributions.web;
    if (!isRecord(web))
      throw new Error("manifest web contribution must be an object");
    const slots = optionalStringArray(web, "slots");
    client = {
      entry: relativeEntry(web, "entry"),
      mounts: slots.map((slot) => ({ slot })),
      outlets: [],
    };
  }
  const contributions: FrockBotManifest["contributions"] = {
    runtime: agent ? { entry: agent } : undefined,
    client,
    desktop: desktop
      ? { entry: desktop, execution: "trusted-main-legacy", commands: [] }
      : undefined,
    mobile: mobile ? { entry: mobile } : undefined,
  };
  if (
    !contributions.backend &&
    !contributions.runtime &&
    !contributions.client &&
    !contributions.desktop &&
    !contributions.mobile
  ) {
    throw new Error("manifest has no contributions");
  }
  return {
    schemaVersion: 2,
    ...identity,
    compatibility: { frockbot: "*" },
    dependencies: {},
    contributions,
  };
}

function decodeV2(value: Record<string, unknown>): FrockBotManifest {
  const identity = decodeIdentity(value);
  if (!isRecord(value.compatibility)) {
    throw new Error("manifest compatibility must be an object");
  }
  if (!isRecord(value.contributions)) {
    throw new Error("manifest contributions must be an object");
  }
  const contributions: FrockBotManifest["contributions"] = {};
  if (value.schemaVersion === 3 && value.contributions.backend !== undefined) {
    if (!isRecord(value.contributions.backend)) {
      throw new Error("manifest backend contribution must be an object");
    }
    if (
      value.contributions.backend.host !== "gateway" &&
      value.contributions.backend.host !== "bot" &&
      value.contributions.backend.host !== "user"
    ) {
      throw new Error("manifest backend host is invalid");
    }
    contributions.backend = {
      entry: relativeEntry(value.contributions.backend, "entry"),
      host: value.contributions.backend.host,
    };
  }
  if (value.contributions.runtime !== undefined) {
    if (!isRecord(value.contributions.runtime)) {
      throw new Error("manifest runtime contribution must be an object");
    }
    contributions.runtime = {
      entry: relativeEntry(value.contributions.runtime, "entry"),
    };
  }
  if (value.contributions.client !== undefined) {
    const client = value.contributions.client;
    if (!isRecord(client))
      throw new Error("manifest client contribution must be an object");
    const mounts = client.mounts;
    if (!Array.isArray(mounts)) {
      throw new Error("manifest client mounts must be an array");
    }
    contributions.client = {
      entry: relativeEntry(client, "entry"),
      mounts: mounts.map((mount) => {
        if (!isRecord(mount))
          throw new Error("manifest client mount must be an object");
        const order = mount.order;
        if (
          order !== undefined &&
          (typeof order !== "number" || !Number.isFinite(order))
        ) {
          throw new Error("manifest client mount order must be finite");
        }
        return { slot: requiredString(mount, "slot"), order };
      }),
      outlets: optionalStringArray(client, "outlets"),
    };
  }
  if (value.contributions.mobile !== undefined) {
    const mobile = value.contributions.mobile;
    if (!isRecord(mobile)) {
      throw new Error("manifest mobile contribution must be an object");
    }
    contributions.mobile = { entry: relativeEntry(mobile, "entry") };
  }
  if (value.contributions.desktop !== undefined) {
    const desktop = value.contributions.desktop;
    if (!isRecord(desktop)) {
      throw new Error("manifest desktop contribution must be an object");
    }
    if (desktop.execution !== "sandboxed-renderer") {
      throw new Error(
        'manifest desktop execution must be "sandboxed-renderer"',
      );
    }
    contributions.desktop = {
      entry: relativeEntry(desktop, "entry"),
      execution: "sandboxed-renderer",
      commands: optionalStringArray(desktop, "commands"),
    };
  }
  if (
    !contributions.backend &&
    !contributions.runtime &&
    !contributions.client &&
    !contributions.desktop &&
    !contributions.mobile
  ) {
    throw new Error("manifest has no contributions");
  }
  return {
    schemaVersion: 2,
    ...identity,
    compatibility: {
      frockbot: requiredString(value.compatibility, "frockbot"),
    },
    dependencies: decodeDependencies(value.dependencies),
    contributions,
  };
}

function definitionArray(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const candidate = value[key] ?? [];
  if (!Array.isArray(candidate) || !candidate.every(isRecord)) {
    throw new Error(`manifest configuration "${key}" must be an array`);
  }
  return candidate;
}

function definitionId(value: Record<string, unknown>): string {
  const id = requiredString(value, "id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("manifest configuration id must be lowercase kebab-case");
  }
  return id;
}

function safeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error("manifest setting schema must be an object");
  if (depth > 12)
    throw new Error("manifest setting schema is too deeply nested");
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref") {
      throw new Error("remote schema references are not supported");
    }
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (isRecord(item)) safeSchema(item, depth + 1);
      }
    } else if (isRecord(nested)) {
      safeSchema(nested, depth + 1);
    }
  }
  if (JSON.stringify(value).length > 50_000) {
    throw new Error("manifest setting schema is too large");
  }
  return structuredClone(value);
}

function decodeConfiguration(value: unknown): PackageConfiguration {
  if (value === undefined) {
    return { settings: [], connectionTypes: [], capabilities: [] };
  }
  if (!isRecord(value))
    throw new Error("manifest configuration must be an object");
  const settings = definitionArray(value, "settings").map((setting) => {
    const schemaVersion = setting.schemaVersion;
    if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) {
      throw new Error(
        "manifest setting schemaVersion must be a positive integer",
      );
    }
    const scopes = optionalStringArray(setting, "scopes");
    if (
      scopes.length === 0 ||
      !scopes.every((scope) => scope === "user" || scope === "bot")
    ) {
      throw new Error("manifest setting scopes must contain user or bot");
    }
    return {
      id: definitionId(setting),
      schemaVersion: schemaVersion as number,
      scopes: scopes as SettingScope[],
      schema: safeSchema(setting.schema),
    };
  });
  const connectionTypes = definitionArray(value, "connectionTypes").map(
    (connection) => {
      if (!isRecord(connection.authorization)) {
        throw new Error("manifest connection authorization must be an object");
      }
      const rawKind = requiredString(connection.authorization, "kind");
      if (
        rawKind !== "oauth2" &&
        rawKind !== "api-key" &&
        rawKind !== "custom"
      ) {
        throw new Error(
          "manifest connection authorization kind is unsupported",
        );
      }
      const kind: ConnectionTypeDefinition["authorization"]["kind"] = rawKind;
      if (typeof connection.allowMultiple !== "boolean") {
        throw new Error("manifest connection allowMultiple must be boolean");
      }
      return {
        id: definitionId(connection),
        displayName: requiredString(connection, "displayName"),
        allowMultiple: connection.allowMultiple,
        authorization: {
          kind,
          driverId: requiredString(connection.authorization, "driverId"),
        },
        capabilities: optionalStringArray(connection, "capabilities"),
      };
    },
  );
  const capabilities = definitionArray(value, "capabilities").map(
    (capability) => {
      const rawKind = requiredString(capability, "kind");
      if (
        rawKind !== "tool" &&
        rawKind !== "model" &&
        rawKind !== "memory" &&
        rawKind !== "notification"
      ) {
        throw new Error("manifest capability kind is unsupported");
      }
      const kind: CapabilityDefinition["kind"] = rawKind;
      return {
        id: definitionId(capability),
        kind,
        connectionTypes: optionalStringArray(capability, "connectionTypes"),
      };
    },
  );
  return { settings, connectionTypes, capabilities };
}

function decodeV3(value: Record<string, unknown>): FrockBotManifest {
  const base = decodeV2(value);
  return {
    ...base,
    schemaVersion: 3,
    configuration: decodeConfiguration(value.configuration),
  };
}

export function decodeFrockBotManifest(value: unknown): FrockBotManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schemaVersion === 1) return decodeV1(value);
  if (value.schemaVersion === 2) return decodeV2(value);
  if (value.schemaVersion === 3) return decodeV3(value);
  throw new Error("unsupported FrockBot manifest version");
}

export function declaredContributionKinds(
  manifest: FrockBotManifest,
): ContributionKind[] {
  const kinds: ContributionKind[] = [];
  if (manifest.contributions.backend) kinds.push("backend");
  if (manifest.contributions.runtime) kinds.push("runtime");
  if (manifest.contributions.client) kinds.push("client");
  if (manifest.contributions.desktop) kinds.push("desktop");
  if (manifest.contributions.mobile) kinds.push("mobile");
  return kinds;
}

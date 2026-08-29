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
  execution: "sandboxed-renderer" | "trusted-main" | "trusted-main-legacy";
  commands: string[];
}

export interface MobileContribution {
  entry: string;
}

export type SettingScope = "user" | "bot";

export type PackageSettingSchemaType =
  "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export type PackageSettingSchemaValue = string | number | boolean | null;

export interface PackageSettingSchema {
  type?: PackageSettingSchemaType;
  title?: string;
  description?: string;
  enum?: PackageSettingSchemaValue[];
  const?: PackageSettingSchemaValue;
  properties?: Record<string, PackageSettingSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PackageSettingSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
}

export interface PackageSettingDefinition {
  id: string;
  schemaVersion: number;
  scopes: SettingScope[];
  schema: PackageSettingSchema;
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
    backend?: BackendContribution[];
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
    const backend = Array.isArray(value.contributions.backend)
      ? value.contributions.backend
      : [value.contributions.backend];
    if (backend.length === 0 || !backend.every(isRecord)) {
      throw new Error("manifest backend contributions must contain objects");
    }
    contributions.backend = backend.map((contribution) => {
      if (
        contribution.host !== "gateway" &&
        contribution.host !== "bot" &&
        contribution.host !== "user"
      ) {
        throw new Error("manifest backend host is invalid");
      }
      return {
        entry: relativeEntry(contribution, "entry"),
        host: contribution.host,
      };
    });
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
    const execution = desktop.execution;
    if (
      execution !== "sandboxed-renderer" &&
      (value.schemaVersion !== 3 || execution !== "trusted-main")
    ) {
      throw new Error(
        value.schemaVersion === 3
          ? 'manifest desktop execution must be "sandboxed-renderer" or "trusted-main"'
          : 'manifest v2 desktop execution must be "sandboxed-renderer"',
      );
    }
    contributions.desktop = {
      entry: relativeEntry(desktop, "entry"),
      execution,
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

const PACKAGE_SETTING_SCHEMA_TYPES = new Set<PackageSettingSchemaType>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const PACKAGE_SETTING_SCHEMA_KEYWORDS = new Set([
  "type",
  "title",
  "description",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

function schemaKeywordError(keyword: string, message: string): Error {
  return new Error(`manifest setting schema "${keyword}" ${message}`);
}

function invalidSchemaJson(message: string): never {
  throw new Error(`manifest setting schema ${message}`);
}

function validateSchemaJsonValue(value: unknown, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalidSchemaJson("numbers must be finite");
    }
    return;
  }
  if (typeof value !== "object") {
    invalidSchemaJson("must contain only JSON values");
  }
  if (ancestors.has(value)) {
    invalidSchemaJson("must be acyclic");
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      invalidSchemaJson("arrays must not inherit custom entries");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)),
      )
    ) {
      invalidSchemaJson("arrays must contain only indexed entries");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        invalidSchemaJson("arrays must be dense");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalidSchemaJson("arrays must contain plain JSON entries");
      }
      validateSchemaJsonValue(descriptor.value, ancestors);
    }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        invalidSchemaJson("arrays must not inherit entries");
      }
    }
    ancestors.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidSchemaJson("objects must not inherit custom entries");
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      invalidSchemaJson("objects must not inherit entries");
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      invalidSchemaJson("objects must use string keys");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      invalidSchemaJson("objects must contain plain JSON entries");
    }
    validateSchemaJsonValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function schemaString(
  value: Record<string, unknown>,
  keyword: "title" | "description",
): string | undefined {
  const candidate = value[keyword];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw schemaKeywordError(keyword, "must be a string");
  }
  return candidate;
}

function schemaNonNegativeInteger(
  value: Record<string, unknown>,
  keyword:
    | "minLength"
    | "maxLength"
    | "minItems"
    | "maxItems"
    | "minProperties"
    | "maxProperties",
): number | undefined {
  const candidate = value[keyword];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw schemaKeywordError(keyword, "must be a non-negative integer");
  }
  return candidate as number;
}

function schemaFiniteNumber(
  value: Record<string, unknown>,
  keyword:
    | "minimum"
    | "maximum"
    | "exclusiveMinimum"
    | "exclusiveMaximum"
    | "multipleOf",
): number | undefined {
  const candidate = value[keyword];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw schemaKeywordError(keyword, "must be a finite number");
  }
  if (keyword === "multipleOf" && candidate <= 0) {
    throw schemaKeywordError(keyword, "must be greater than zero");
  }
  return candidate;
}

function schemaValue(
  value: unknown,
  keyword: "enum" | "const",
): PackageSettingSchemaValue {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw schemaKeywordError(keyword, "must contain only primitive values");
  }
  return value as PackageSettingSchemaValue;
}

function schemaValueMatchesType(
  value: PackageSettingSchemaValue,
  type: PackageSettingSchemaType,
): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "object" || type === "array") return false;
  return typeof value === type;
}

function decodeSafeSchema(value: unknown, depth: number): PackageSettingSchema {
  if (!isRecord(value)) {
    throw new Error("manifest setting schema must be an object");
  }
  if (depth > 12) {
    throw new Error("manifest setting schema is too deeply nested");
  }
  const source = Object.fromEntries(Object.entries(value));
  for (const keyword of Object.keys(source)) {
    if (keyword === "default") {
      throw schemaKeywordError(keyword, "is not supported");
    }
    if (keyword === "format") {
      throw schemaKeywordError(keyword, "is not supported");
    }
    if (keyword.startsWith("$")) {
      throw schemaKeywordError(keyword, "is not supported");
    }
    if (!PACKAGE_SETTING_SCHEMA_KEYWORDS.has(keyword)) {
      throw schemaKeywordError(keyword, "is not supported");
    }
  }

  const schema: PackageSettingSchema = {};
  const rawType = source.type;
  if (rawType !== undefined) {
    if (
      typeof rawType !== "string" ||
      !PACKAGE_SETTING_SCHEMA_TYPES.has(rawType as PackageSettingSchemaType)
    ) {
      throw schemaKeywordError("type", "is unsupported");
    }
    schema.type = rawType as PackageSettingSchemaType;
  }
  const title = schemaString(source, "title");
  if (title !== undefined) schema.title = title;
  const description = schemaString(source, "description");
  if (description !== undefined) schema.description = description;

  if (source.enum !== undefined) {
    if (!Array.isArray(source.enum) || source.enum.length === 0) {
      throw schemaKeywordError("enum", "must be a non-empty array");
    }
    schema.enum = source.enum.map((candidate) =>
      schemaValue(candidate, "enum"),
    );
    if (
      new Set(schema.enum.map((candidate) => JSON.stringify(candidate)))
        .size !== schema.enum.length
    ) {
      throw schemaKeywordError("enum", "must contain unique values");
    }
  }
  if (Object.hasOwn(source, "const")) {
    schema.const = schemaValue(source.const, "const");
  }
  if (
    schema.type &&
    schema.enum?.some((item) => !schemaValueMatchesType(item, schema.type!))
  ) {
    throw schemaKeywordError("enum", "values must match type");
  }
  if (
    schema.type &&
    Object.hasOwn(schema, "const") &&
    !schemaValueMatchesType(schema.const!, schema.type)
  ) {
    throw schemaKeywordError("const", "must match type");
  }

  if (source.properties !== undefined) {
    if (!isRecord(source.properties)) {
      throw schemaKeywordError("properties", "must be an object");
    }
    schema.properties = Object.fromEntries(
      Object.entries(source.properties).map(([name, nested]) => {
        if (!name) {
          throw schemaKeywordError(
            "properties",
            "must use non-empty property names",
          );
        }
        return [name, decodeSafeSchema(nested, depth + 1)];
      }),
    );
  }
  if (source.required !== undefined) {
    if (
      !Array.isArray(source.required) ||
      !source.required.every(
        (item) => typeof item === "string" && item.length > 0,
      )
    ) {
      throw schemaKeywordError(
        "required",
        "must contain non-empty property names",
      );
    }
    schema.required = [...source.required];
    if (new Set(schema.required).size !== schema.required.length) {
      throw schemaKeywordError("required", "must contain unique names");
    }
    if (
      !schema.properties ||
      schema.required.some((name) => !Object.hasOwn(schema.properties!, name))
    ) {
      throw schemaKeywordError("required", "must name declared properties");
    }
  }
  if (source.additionalProperties !== undefined) {
    if (typeof source.additionalProperties !== "boolean") {
      throw schemaKeywordError("additionalProperties", "must be a boolean");
    }
    schema.additionalProperties = source.additionalProperties;
  }
  if (source.items !== undefined) {
    schema.items = decodeSafeSchema(source.items, depth + 1);
  }

  for (const keyword of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ] as const) {
    const candidate = schemaNonNegativeInteger(source, keyword);
    if (candidate !== undefined) schema[keyword] = candidate;
  }
  for (const keyword of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ] as const) {
    const candidate = schemaFiniteNumber(source, keyword);
    if (candidate !== undefined) schema[keyword] = candidate;
  }
  if (source.uniqueItems !== undefined) {
    if (typeof source.uniqueItems !== "boolean") {
      throw schemaKeywordError("uniqueItems", "must be a boolean");
    }
    schema.uniqueItems = source.uniqueItems;
  }

  const objectKeywords = [
    schema.properties,
    schema.required,
    schema.additionalProperties,
    schema.minProperties,
    schema.maxProperties,
  ];
  const arrayKeywords = [
    schema.items,
    schema.minItems,
    schema.maxItems,
    schema.uniqueItems,
  ];
  const stringKeywords = [schema.minLength, schema.maxLength];
  const numberKeywords = [
    schema.minimum,
    schema.maximum,
    schema.exclusiveMinimum,
    schema.exclusiveMaximum,
    schema.multipleOf,
  ];
  if (
    objectKeywords.some((item) => item !== undefined) &&
    schema.type !== "object"
  ) {
    throw new Error(
      "manifest setting schema object keywords require object type",
    );
  }
  if (
    arrayKeywords.some((item) => item !== undefined) &&
    schema.type !== "array"
  ) {
    throw new Error(
      "manifest setting schema array keywords require array type",
    );
  }
  if (
    stringKeywords.some((item) => item !== undefined) &&
    schema.type !== "string"
  ) {
    throw new Error(
      "manifest setting schema string keywords require string type",
    );
  }
  if (
    numberKeywords.some((item) => item !== undefined) &&
    schema.type !== "number" &&
    schema.type !== "integer"
  ) {
    throw new Error(
      "manifest setting schema number keywords require numeric type",
    );
  }
  if (
    schema.minLength !== undefined &&
    schema.maxLength !== undefined &&
    schema.minLength > schema.maxLength
  ) {
    throw new Error("manifest setting schema minLength exceeds maxLength");
  }
  if (
    schema.minItems !== undefined &&
    schema.maxItems !== undefined &&
    schema.minItems > schema.maxItems
  ) {
    throw new Error("manifest setting schema minItems exceeds maxItems");
  }
  if (
    schema.minProperties !== undefined &&
    schema.maxProperties !== undefined &&
    schema.minProperties > schema.maxProperties
  ) {
    throw new Error(
      "manifest setting schema minProperties exceeds maxProperties",
    );
  }
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    schema.minimum > schema.maximum
  ) {
    throw new Error("manifest setting schema minimum exceeds maximum");
  }
  return schema;
}

function safeSchema(value: unknown): PackageSettingSchema {
  if (!isRecord(value)) {
    throw new Error("manifest setting schema must be an object");
  }
  validateSchemaJsonValue(value, new Set());
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    invalidSchemaJson("must contain only JSON values");
  }
  if (serialized.length > 50_000) {
    throw new Error("manifest setting schema is too large");
  }
  return decodeSafeSchema(value, 0);
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

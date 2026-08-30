import { isBotIdV1 } from "./bot-id.js";
import { isConnectionIdentifier, isPublicIdentifier } from "./identifiers.js";
export { isBotIdV1 } from "./bot-id.js";
export {
  isApplicationDeploymentHash,
  isConnectionIdentifier,
  isPublicIdentifier,
  isRpcIdentifier,
} from "./identifiers.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface UserPrincipal {
  userId: string;
}

export interface BotAuthority extends UserPrincipal {
  botId: string;
  invocationId: string;
}

export interface BotProfile {
  name: string;
  label?: string;
  description?: string;
}

export interface BotNotificationPolicy {
  enabled: boolean;
}

export interface ModelAssignment {
  connectionId: string;
  providerModelId: string;
}

export interface PackageInstallationView {
  packageId: string;
  version: string;
  state: "installed" | "disabled" | "failed";
  failure?: string;
}

export interface ConnectionView {
  connectionId: string;
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  state:
    | "authorizing"
    | "ready"
    | "revoking"
    | "revoked"
    | "reconciliation-required"
    | "failed";
  safeMetadata: Record<string, JsonValue>;
  failure?: string;
}

export interface StartConnectionCommandV1 {
  schemaVersion: 1;
  type: "connection/start";
  commandId: string;
  connectionTypeId: string;
  alias?: string;
  nativeReturnNonce?: string;
}

export interface RevokeConnectionCommandV1 {
  schemaVersion: 1;
  type: "connection/revoke";
}

export interface UserSettingsViewV1 {
  schemaVersion: 1;
  revision: number;
  profile: { name: string; email?: string };
  packages: PackageInstallationView[];
  connections: ConnectionView[];
  newBotModelTemplate?: ModelAssignment;
}

export interface CapabilityAssignmentView {
  assignmentId: string;
  packageId: string;
  capabilityId: string;
  connectionId?: string;
  state: "enabled" | "disabled" | "unavailable";
}

export interface ConnectionDependencyRequirementV1 {
  schemaVersion: 1;
  packageId: string;
  packageVersion: string;
  capabilityId: string;
  connectionTypeIds: string[];
}

export interface CapabilityAssignmentOperationViewV1 {
  commandId: string;
  kind: "assigning" | "replacing" | "unassigning";
  assignmentId: string;
  state: "pending" | "retrying";
  target?: Omit<CapabilityAssignmentView, "state">;
}

export interface BotSettingsViewV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  profile: BotProfile;
  notifications: BotNotificationPolicy;
  assignments: CapabilityAssignmentView[];
  assignmentOperations: CapabilityAssignmentOperationViewV1[];
  model?: ModelAssignment;
}

export function initializeBotSettingsV1(
  botId: string,
  model?: ModelAssignment,
): BotSettingsViewV1 {
  return {
    schemaVersion: 1,
    botId,
    revision: 0,
    profile: { name: botId === "default" ? "Barebones" : botId },
    notifications: { enabled: false },
    assignments: [],
    assignmentOperations: [],
    model: model ? structuredClone(model) : undefined,
  };
}

export type ConfigurationViewV1 = UserSettingsViewV1 | BotSettingsViewV1;

export type ConfigurationQueryV1 =
  | { schemaVersion: 1; type: "user/get" }
  | { schemaVersion: 1; type: "bot/get"; botId: string };

interface CommandMetaV1 {
  schemaVersion: 1;
  commandId: string;
  expectedRevision: number;
}

export type ConfigurationCommandV1 =
  | (CommandMetaV1 & {
      type: "user/update-profile";
      profile: UserSettingsViewV1["profile"];
    })
  | (CommandMetaV1 & {
      type: "user/set-new-bot-model";
      model?: ModelAssignment;
    })
  | (CommandMetaV1 & {
      type: "user/install-package";
      packageId: string;
      version: string;
    })
  | (CommandMetaV1 & {
      type: "user/set-package-enabled";
      packageId: string;
      enabled: boolean;
    })
  | (CommandMetaV1 & {
      type: "bot/update-profile";
      botId: string;
      profile: BotProfile;
    })
  | (CommandMetaV1 & {
      type: "bot/update-notifications";
      botId: string;
      notifications: BotNotificationPolicy;
    })
  | (CommandMetaV1 & {
      type: "bot/select-model";
      botId: string;
      model: ModelAssignment;
    })
  | (CommandMetaV1 & {
      type: "bot/assign-capability";
      botId: string;
      assignment: Omit<CapabilityAssignmentView, "state">;
    })
  | (CommandMetaV1 & {
      type: "bot/replace-capability";
      botId: string;
      assignment: Omit<CapabilityAssignmentView, "state">;
    })
  | (CommandMetaV1 & {
      type: "bot/unassign-capability";
      botId: string;
      assignmentId: string;
    });

export type UserConfigurationCommandV1 = Exclude<
  ConfigurationCommandV1,
  { botId: string }
>;

export type BotConfigurationCommandV1 = Extract<
  ConfigurationCommandV1,
  { botId: string }
>;

function canonicalFingerprintValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalFingerprintValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalFingerprintValue(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Configuration command fingerprint value is not JSON");
}

export function configurationCommandFingerprintV1(
  command: ConfigurationCommandV1,
): string {
  const { commandId: _commandId, ...semanticCommand } = command;
  return `configuration-command-v1:${canonicalFingerprintValue(semanticCommand)}`;
}

export interface UserConfigurationReadRpcV1 {
  schemaVersion: 1;
  userId: string;
}

export interface UserConfigurationExecuteRpcV1 {
  schemaVersion: 1;
  userId: string;
  command: UserConfigurationCommandV1;
}

export interface BotConfigurationReadRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
}

export interface BotConfigurationExecuteRpcV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  command: BotConfigurationCommandV1;
}

export type OperationReceiptV1 =
  | {
      schemaVersion: 1;
      commandId: string;
      revision: number;
      status: "pending" | "applied";
    }
  | {
      schemaVersion: 1;
      commandId: string;
      revision: number;
      status: "rejected";
      failure: string;
    };

export interface BotExecutionPlanV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  model?: ModelAssignment;
  assignments: CapabilityAssignmentView[];
}

export interface ExecutionPackageDefinition {
  packageId: string;
  version: string;
  capabilities: Array<{
    id: string;
    connectionTypes: string[];
  }>;
  connectionTypes: Array<{
    id: string;
    capabilities: string[];
  }>;
}

export function capabilityAssignmentFailureV1(input: {
  assignment: Omit<CapabilityAssignmentView, "state">;
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): string | undefined {
  const installation = input.user.packages.find(
    (pkg) =>
      pkg.packageId === input.assignment.packageId && pkg.state === "installed",
  );
  const pkg = input.packages.find(
    (candidate) =>
      candidate.packageId === input.assignment.packageId &&
      candidate.version === installation?.version,
  );
  if (!installation || !pkg) {
    return `Package "${input.assignment.packageId}" is not installed and enabled`;
  }
  const capability = pkg.capabilities.find(
    (candidate) => candidate.id === input.assignment.capabilityId,
  );
  if (!capability) {
    return `Capability "${input.assignment.capabilityId}" is not declared by Package "${input.assignment.packageId}"`;
  }
  if (capability.connectionTypes.length === 0) {
    return input.assignment.connectionId
      ? `Capability "${input.assignment.capabilityId}" does not accept a Connection`
      : undefined;
  }
  if (!input.assignment.connectionId) {
    return `Capability "${input.assignment.capabilityId}" requires a Connection`;
  }
  const connection = input.user.connections.find(
    (candidate) => candidate.connectionId === input.assignment.connectionId,
  );
  if (
    !connection ||
    connection.packageId !== input.assignment.packageId ||
    connection.state !== "ready"
  ) {
    return `Connection "${input.assignment.connectionId}" is not a ready Connection for Package "${input.assignment.packageId}"`;
  }
  const connectionType = pkg.connectionTypes.find(
    (candidate) => candidate.id === connection.connectionTypeId,
  );
  if (
    !connectionType ||
    !capability.connectionTypes.includes(connectionType.id) ||
    !connectionType.capabilities.includes(capability.id)
  ) {
    return `Connection "${input.assignment.connectionId}" has an incompatible Connection Type`;
  }
  return undefined;
}

export function resolveBotExecutionPlanV1(input: {
  bot: BotSettingsViewV1;
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): BotExecutionPlanV1 {
  const assignments = input.bot.assignments.map((assignment) => {
    if (assignment.state !== "enabled") return structuredClone(assignment);
    if (
      capabilityAssignmentFailureV1({
        assignment,
        user: input.user,
        packages: input.packages,
      })
    ) {
      return { ...assignment, state: "unavailable" as const };
    }
    return structuredClone(assignment);
  });
  return {
    schemaVersion: 1,
    botId: input.bot.botId,
    revision: input.bot.revision,
    model: input.bot.model ? structuredClone(input.bot.model) : undefined,
    assignments,
  };
}

export interface ConfigurationApplication {
  read(
    principal: UserPrincipal,
    query: ConfigurationQueryV1,
  ): Promise<ConfigurationViewV1>;
  execute(
    principal: UserPrincipal,
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1>;
  resolveBot(authority: BotAuthority): Promise<BotExecutionPlanV1>;
}

export class ConfigurationDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationDecodeError";
  }
}

export class ConfigurationConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`configuration revision is ${currentRevision}`);
    this.name = "ConfigurationConflictError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function decodeBotIdV1(value: unknown, label = "botId"): string {
  if (!isBotIdV1(value))
    throw new ConfigurationDecodeError(`${label} is invalid`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (!isPublicIdentifier(value)) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return value;
}

function connectionIdentifier(value: unknown, label: string): string {
  if (!isConnectionIdentifier(value)) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly PropertyKey[],
  optional: readonly PropertyKey[] = [],
): Record<string, unknown> {
  const decoded = record(value, label);
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(decoded, key)) ||
    Reflect.ownKeys(decoded).some((key) => !allowed.has(key))
  ) {
    throw new ConfigurationDecodeError(`${label} has invalid fields`);
  }
  return decoded;
}

export function decodeStartConnectionCommandV1(
  input: unknown,
): StartConnectionCommandV1 {
  const value = exactRecord(
    input,
    "Connection start command",
    ["schemaVersion", "type", "commandId", "connectionTypeId"],
    ["alias", "nativeReturnNonce"],
  );
  if (value.schemaVersion !== 1 || value.type !== "connection/start") {
    throw new ConfigurationDecodeError("unsupported Connection start command");
  }
  if (
    value.alias !== undefined &&
    (typeof value.alias !== "string" || value.alias.length > 100)
  ) {
    throw new ConfigurationDecodeError("alias is invalid");
  }
  return {
    schemaVersion: 1,
    type: "connection/start",
    commandId: connectionIdentifier(value.commandId, "commandId"),
    connectionTypeId: connectionIdentifier(
      value.connectionTypeId,
      "connectionTypeId",
    ),
    ...(value.alias === undefined ? {} : { alias: value.alias }),
    ...(value.nativeReturnNonce === undefined
      ? {}
      : {
          nativeReturnNonce: connectionIdentifier(
            value.nativeReturnNonce,
            "nativeReturnNonce",
          ),
        }),
  };
}

export function decodeRevokeConnectionCommandV1(
  input: unknown,
): RevokeConnectionCommandV1 {
  const value = exactRecord(input, "Connection revoke command", [
    "schemaVersion",
    "type",
  ]);
  if (value.schemaVersion !== 1 || value.type !== "connection/revoke") {
    throw new ConfigurationDecodeError("unsupported Connection revoke command");
  }
  return { schemaVersion: 1, type: "connection/revoke" };
}

export function decodeConnectionDependencyRequirementV1(
  input: unknown,
): ConnectionDependencyRequirementV1 {
  const value = exactRecord(input, "Connection dependency requirement", [
    "schemaVersion",
    "packageId",
    "packageVersion",
    "capabilityId",
    "connectionTypeIds",
  ]);
  schemaVersion(value);
  if (
    !Array.isArray(value.connectionTypeIds) ||
    value.connectionTypeIds.length === 0
  ) {
    throw new ConfigurationDecodeError(
      "Connection dependency requirement connectionTypeIds are invalid",
    );
  }
  return {
    schemaVersion: 1,
    packageId: identifier(value.packageId, "packageId"),
    packageVersion: text(value.packageVersion, "packageVersion", 128),
    capabilityId: identifier(value.capabilityId, "capabilityId"),
    connectionTypeIds: value.connectionTypeIds.map((item) =>
      identifier(item, "connectionTypeId"),
    ),
  };
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ConfigurationDecodeError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum);
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ConfigurationDecodeError("expectedRevision is invalid");
  }
  return value as number;
}

const COMMAND_META_FIELDS = [
  "schemaVersion",
  "type",
  "commandId",
  "expectedRevision",
] as const;

function exactCommand(
  input: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  return exactRecord(
    input,
    "command",
    [...COMMAND_META_FIELDS, ...fields],
    optional,
  );
}

function commandMeta(value: Record<string, unknown>): CommandMetaV1 {
  if (value.schemaVersion !== 1) {
    throw new ConfigurationDecodeError("unsupported configuration schema");
  }
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "commandId"),
    expectedRevision: revision(value.expectedRevision),
  };
}

function botProfile(value: unknown): BotProfile {
  const profile = exactRecord(
    value,
    "profile",
    ["name"],
    ["label", "description"],
  );
  return {
    name: text(profile.name, "profile.name", 100),
    label: optionalText(profile.label, "profile.label", 120),
    description: optionalText(
      profile.description,
      "profile.description",
      10_000,
    ),
  };
}

function notifications(value: unknown): BotNotificationPolicy {
  const policy = exactRecord(value, "notifications", ["enabled"]);
  if (typeof policy.enabled !== "boolean") {
    throw new ConfigurationDecodeError("notifications.enabled is invalid");
  }
  return { enabled: policy.enabled };
}

function model(value: unknown): ModelAssignment {
  const assignment = exactRecord(value, "model", [
    "connectionId",
    "providerModelId",
  ]);
  return {
    connectionId: identifier(assignment.connectionId, "model.connectionId"),
    providerModelId: text(
      assignment.providerModelId,
      "model.providerModelId",
      200,
    ),
  };
}

export function decodeConfigurationQueryV1(
  input: unknown,
): ConfigurationQueryV1 {
  const value = record(input, "query");
  if (value.schemaVersion !== 1) {
    throw new ConfigurationDecodeError("unsupported configuration schema");
  }
  if (value.type === "user/get") {
    exactRecord(input, "query", ["schemaVersion", "type"]);
    return { schemaVersion: 1, type: "user/get" };
  }
  if (value.type === "bot/get") {
    const query = exactRecord(input, "query", [
      "schemaVersion",
      "type",
      "botId",
    ]);
    return {
      schemaVersion: 1,
      type: "bot/get",
      botId: identifier(query.botId, "botId"),
    };
  }
  throw new ConfigurationDecodeError("unknown configuration query");
}

export function decodeConfigurationCommandV1(
  input: unknown,
): ConfigurationCommandV1 {
  const value = record(input, "command");
  switch (value.type) {
    case "user/update-profile": {
      const command = exactCommand(input, ["profile"]);
      const profile = exactRecord(
        command.profile,
        "profile",
        ["name"],
        ["email"],
      );
      return {
        ...commandMeta(command),
        type: value.type,
        profile: {
          name: text(profile.name, "profile.name", 100),
          email: optionalText(profile.email, "profile.email", 320),
        },
      };
    }
    case "user/set-new-bot-model": {
      const command = exactCommand(input, [], ["model"]);
      return {
        ...commandMeta(command),
        type: value.type,
        model: command.model === undefined ? undefined : model(command.model),
      };
    }
    case "user/install-package": {
      const command = exactCommand(input, ["packageId", "version"]);
      return {
        ...commandMeta(command),
        type: value.type,
        packageId: identifier(command.packageId, "packageId"),
        version: text(command.version, "version", 100),
      };
    }
    case "user/set-package-enabled": {
      const command = exactCommand(input, ["packageId", "enabled"]);
      if (typeof command.enabled !== "boolean") {
        throw new ConfigurationDecodeError("enabled is invalid");
      }
      return {
        ...commandMeta(command),
        type: value.type,
        packageId: identifier(command.packageId, "packageId"),
        enabled: command.enabled,
      };
    }
    case "bot/update-profile": {
      const command = exactCommand(input, ["botId", "profile"]);
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        profile: botProfile(command.profile),
      };
    }
    case "bot/update-notifications": {
      const command = exactCommand(input, ["botId", "notifications"]);
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        notifications: notifications(command.notifications),
      };
    }
    case "bot/select-model": {
      const command = exactCommand(input, ["botId", "model"]);
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        model: model(command.model),
      };
    }
    case "bot/assign-capability":
    case "bot/replace-capability": {
      const command = exactCommand(input, ["botId", "assignment"]);
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        assignment: assignmentTarget(command.assignment, "assignment"),
      };
    }
    case "bot/unassign-capability": {
      const command = exactCommand(input, ["botId", "assignmentId"]);
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        assignmentId: identifier(command.assignmentId, "assignmentId"),
      };
    }
    default:
      throw new ConfigurationDecodeError("unknown configuration command");
  }
}

export function decodeUserConfigurationReadRpcV1(
  input: unknown,
): UserConfigurationReadRpcV1 {
  const value = exactRecord(input, "User configuration read RPC", [
    "schemaVersion",
    "userId",
  ]);
  schemaVersion(value);
  return {
    schemaVersion: 1,
    userId: identifier(value.userId, "userId"),
  };
}

export function decodeUserConfigurationExecuteRpcV1(
  input: unknown,
): UserConfigurationExecuteRpcV1 {
  const value = exactRecord(input, "User configuration execute RPC", [
    "schemaVersion",
    "userId",
    "command",
  ]);
  schemaVersion(value);
  const command = decodeConfigurationCommandV1(value.command);
  if ("botId" in command) {
    throw new ConfigurationDecodeError(
      "User configuration RPC requires a User command",
    );
  }
  return {
    schemaVersion: 1,
    userId: identifier(value.userId, "userId"),
    command,
  };
}

export function decodeBotConfigurationReadRpcV1(
  input: unknown,
): BotConfigurationReadRpcV1 {
  const value = exactRecord(input, "Bot configuration read RPC", [
    "schemaVersion",
    "userId",
    "botId",
  ]);
  schemaVersion(value);
  return {
    schemaVersion: 1,
    userId: identifier(value.userId, "userId"),
    botId: identifier(value.botId, "botId"),
  };
}

export function decodeBotConfigurationExecuteRpcV1(
  input: unknown,
): BotConfigurationExecuteRpcV1 {
  const value = exactRecord(input, "Bot configuration execute RPC", [
    "schemaVersion",
    "userId",
    "botId",
    "command",
  ]);
  schemaVersion(value);
  const botId = identifier(value.botId, "botId");
  const command = decodeConfigurationCommandV1(value.command);
  if (!("botId" in command)) {
    throw new ConfigurationDecodeError(
      "Bot configuration RPC requires a Bot command",
    );
  }
  if (command.botId !== botId) {
    throw new ConfigurationDecodeError(
      "Bot configuration command does not match its authority",
    );
  }
  return {
    schemaVersion: 1,
    userId: identifier(value.userId, "userId"),
    botId,
    command,
  };
}

function safeJsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeJsonValue(item, label));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        safeJsonValue(item, label),
      ]),
    );
  }
  throw new ConfigurationDecodeError(`${label} is not JSON`);
}

function viewRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ConfigurationDecodeError("configuration revision is invalid");
  }
  return value as number;
}

function packageInstallation(value: unknown): PackageInstallationView {
  const installation = exactRecord(
    value,
    "Package installation",
    ["packageId", "version", "state"],
    ["failure"],
  );
  if (
    installation.state !== "installed" &&
    installation.state !== "disabled" &&
    installation.state !== "failed"
  ) {
    throw new ConfigurationDecodeError("Package installation state is invalid");
  }
  return {
    packageId: identifier(installation.packageId, "packageId"),
    version: text(installation.version, "version", 100),
    state: installation.state,
    failure: optionalText(installation.failure, "failure", 2_000),
  };
}

function connectionView(value: unknown): ConnectionView {
  const connection = exactRecord(
    value,
    "Connection",
    [
      "connectionId",
      "packageId",
      "connectionTypeId",
      "displayName",
      "state",
      "safeMetadata",
    ],
    ["failure"],
  );
  const states: ConnectionView["state"][] = [
    "authorizing",
    "ready",
    "revoking",
    "revoked",
    "reconciliation-required",
    "failed",
  ];
  if (!states.includes(connection.state as ConnectionView["state"])) {
    throw new ConfigurationDecodeError("Connection state is invalid");
  }
  const safeMetadata = record(connection.safeMetadata, "safeMetadata");
  return {
    connectionId: identifier(connection.connectionId, "connectionId"),
    packageId: identifier(connection.packageId, "packageId"),
    connectionTypeId: identifier(
      connection.connectionTypeId,
      "connectionTypeId",
    ),
    displayName: text(connection.displayName, "displayName", 200),
    state: connection.state as ConnectionView["state"],
    safeMetadata: Object.fromEntries(
      Object.entries(safeMetadata).map(([key, item]) => [
        key,
        safeJsonValue(item, `safeMetadata.${key}`),
      ]),
    ),
    failure: optionalText(connection.failure, "failure", 2_000),
  };
}

function capabilityAssignment(value: unknown): CapabilityAssignmentView {
  const assignment = exactRecord(
    value,
    "Capability Assignment",
    ["assignmentId", "packageId", "capabilityId", "state"],
    ["connectionId"],
  );
  if (
    assignment.state !== "enabled" &&
    assignment.state !== "disabled" &&
    assignment.state !== "unavailable"
  ) {
    throw new ConfigurationDecodeError(
      "Capability Assignment state is invalid",
    );
  }
  return {
    assignmentId: identifier(assignment.assignmentId, "assignmentId"),
    packageId: identifier(assignment.packageId, "assignment.packageId"),
    capabilityId: identifier(
      assignment.capabilityId,
      "assignment.capabilityId",
    ),
    connectionId:
      assignment.connectionId === undefined
        ? undefined
        : identifier(assignment.connectionId, "assignment.connectionId"),
    state: assignment.state,
  };
}

function assignmentTarget(
  value: unknown,
  label = "assignment target",
): Omit<CapabilityAssignmentView, "state"> {
  const assignment = exactRecord(
    value,
    label,
    ["assignmentId", "packageId", "capabilityId"],
    ["connectionId"],
  );
  return {
    assignmentId: identifier(assignment.assignmentId, `${label}.assignmentId`),
    packageId: identifier(assignment.packageId, `${label}.packageId`),
    capabilityId: identifier(assignment.capabilityId, `${label}.capabilityId`),
    connectionId:
      assignment.connectionId === undefined
        ? undefined
        : identifier(assignment.connectionId, `${label}.connectionId`),
  };
}

function assignmentOperation(
  value: unknown,
): CapabilityAssignmentOperationViewV1 {
  const operation = exactRecord(
    value,
    "Assignment operation",
    ["commandId", "kind", "assignmentId", "state"],
    ["target"],
  );
  if (
    operation.kind !== "assigning" &&
    operation.kind !== "replacing" &&
    operation.kind !== "unassigning"
  ) {
    throw new ConfigurationDecodeError("Assignment operation kind is invalid");
  }
  if (operation.state !== "pending" && operation.state !== "retrying") {
    throw new ConfigurationDecodeError("Assignment operation state is invalid");
  }
  if (operation.kind !== "unassigning" && operation.target === undefined) {
    throw new ConfigurationDecodeError(
      "Assignment operation target is required",
    );
  }
  if (operation.kind === "unassigning" && operation.target !== undefined) {
    throw new ConfigurationDecodeError(
      "Unassign operation cannot have a target",
    );
  }
  return {
    commandId: identifier(operation.commandId, "operation.commandId"),
    kind: operation.kind,
    assignmentId: identifier(operation.assignmentId, "operation.assignmentId"),
    state: operation.state,
    target:
      operation.target === undefined
        ? undefined
        : assignmentTarget(operation.target),
  };
}

function schemaVersion(value: Record<string, unknown>): void {
  if (value.schemaVersion !== 1) {
    throw new ConfigurationDecodeError("unsupported configuration schema");
  }
}

export function decodeUserSettingsViewV1(input: unknown): UserSettingsViewV1 {
  const value = exactRecord(
    input,
    "User settings",
    ["schemaVersion", "revision", "profile", "packages", "connections"],
    ["newBotModelTemplate"],
  );
  schemaVersion(value);
  const profile = exactRecord(value.profile, "profile", ["name"], ["email"]);
  if (!Array.isArray(value.packages) || !Array.isArray(value.connections)) {
    throw new ConfigurationDecodeError(
      "User settings Packages and Connections must be arrays",
    );
  }
  return {
    schemaVersion: 1,
    revision: viewRevision(value.revision),
    profile: {
      name: text(profile.name, "profile.name", 100),
      email: optionalText(profile.email, "profile.email", 320),
    },
    packages: value.packages.map(packageInstallation),
    connections: value.connections.map(connectionView),
    newBotModelTemplate:
      value.newBotModelTemplate === undefined
        ? undefined
        : model(value.newBotModelTemplate),
  };
}

export function decodeBotSettingsViewV1(input: unknown): BotSettingsViewV1 {
  const value = exactRecord(
    input,
    "Bot settings",
    [
      "schemaVersion",
      "botId",
      "revision",
      "profile",
      "notifications",
      "assignments",
      "assignmentOperations",
    ],
    ["model"],
  );
  schemaVersion(value);
  if (
    !Array.isArray(value.assignments) ||
    !Array.isArray(value.assignmentOperations)
  ) {
    throw new ConfigurationDecodeError(
      "Bot settings Assignments and operations must be arrays",
    );
  }
  return {
    schemaVersion: 1,
    botId: identifier(value.botId, "botId"),
    revision: viewRevision(value.revision),
    profile: botProfile(value.profile),
    notifications: notifications(value.notifications),
    assignments: value.assignments.map(capabilityAssignment),
    assignmentOperations: value.assignmentOperations.map(assignmentOperation),
    model: value.model === undefined ? undefined : model(value.model),
  };
}

export function decodeConfigurationViewV1(input: unknown): ConfigurationViewV1 {
  const value = record(input, "configuration");
  return "botId" in value
    ? decodeBotSettingsViewV1(value)
    : decodeUserSettingsViewV1(value);
}

export function decodeOperationReceiptV1(input: unknown): OperationReceiptV1 {
  const candidate = record(input, "operation receipt");
  if (
    candidate.status !== "pending" &&
    candidate.status !== "applied" &&
    candidate.status !== "rejected"
  ) {
    throw new ConfigurationDecodeError("operation receipt status is invalid");
  }
  const value = exactRecord(
    input,
    "operation receipt",
    candidate.status === "rejected"
      ? ["schemaVersion", "commandId", "revision", "status", "failure"]
      : ["schemaVersion", "commandId", "revision", "status"],
  );
  schemaVersion(value);
  const receipt = {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "commandId"),
    revision: viewRevision(value.revision),
  } as const;
  if (value.status === "rejected") {
    return {
      ...receipt,
      status: "rejected",
      failure: text(value.failure, "operation receipt failure", 1_000),
    };
  }
  return {
    ...receipt,
    status: value.status as "pending" | "applied",
  };
}

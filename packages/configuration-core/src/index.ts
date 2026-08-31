import type {
  ConnectionAuthorizationViewV1,
  ConnectionModelCatalogV1,
} from "@frockbot/connection-core";
import {
  decodeConnectionAuthorizationViewV1,
  decodeConnectionModelCatalogV1,
} from "@frockbot/connection-core";
import { isBotIdV1 } from "./bot-id.js";
import {
  isConnectionIdentifier,
  isPublicIdentifier,
  isRpcIdentifier,
} from "./identifiers.js";
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
    | "disabled"
    | "revoking"
    | "revoked"
    | "reconciliation-required"
    | "failed";
  generation?: string;
  providerType?: string;
  authorization?: ConnectionAuthorizationViewV1;
  modelCatalog?: ConnectionModelCatalogV1;
  settings?: Record<string, JsonValue>;
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

export const MAX_USER_CONNECTIONS_V1 = 100;

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

export interface BotSettingsViewV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  profile: BotProfile;
  notifications: BotNotificationPolicy;
  assignments: CapabilityAssignmentView[];
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
      model?: ModelAssignment;
    })
  | (CommandMetaV1 & {
      type: "bot/unbind-model";
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
      status: "applied";
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
    kind?: "tool" | "model" | "memory" | "notification";
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

export interface ResolvedModelBindingV1 {
  assignment: ModelAssignment;
  state: "ready" | "requires-resolution" | "unavailable";
  connection?: ConnectionView;
  packageId?: string;
  providerType?: string;
  failure?: string;
}

export function resolveBotModelBindingV1(input: {
  model: ModelAssignment;
  assignments: readonly CapabilityAssignmentView[];
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): ResolvedModelBindingV1 {
  const unavailable = (failure: string): ResolvedModelBindingV1 => ({
    assignment: structuredClone(input.model),
    state: "unavailable",
    failure,
  });
  const connection = input.user.connections.find(
    (candidate) => candidate.connectionId === input.model.connectionId,
  );
  if (!connection) return unavailable("Connection is unavailable");
  if (connection.state !== "ready") {
    return unavailable(`Connection is ${connection.state}`);
  }
  const installation = input.user.packages.find(
    (candidate) => candidate.packageId === connection.packageId,
  );
  if (!installation || installation.state !== "installed") {
    return unavailable("Connection Package is not installed and enabled");
  }
  const pkg = input.packages.find(
    (candidate) =>
      candidate.packageId === connection.packageId &&
      candidate.version === installation.version,
  );
  const connectionType = pkg?.connectionTypes.find(
    (candidate) => candidate.id === connection.connectionTypeId,
  );
  const modelCapability = pkg?.capabilities.find(
    (candidate) =>
      candidate.kind === "model" &&
      connectionType?.capabilities.includes(candidate.id) &&
      candidate.connectionTypes.includes(connection.connectionTypeId),
  );
  if (!pkg || !connectionType || !modelCapability) {
    return unavailable("Connection does not provide models");
  }
  const assignment = input.assignments.find(
    (candidate) =>
      candidate.packageId === pkg.packageId &&
      candidate.capabilityId === modelCapability.id &&
      candidate.connectionId === connection.connectionId &&
      candidate.state === "enabled",
  );
  if (!assignment) {
    return unavailable("Bot is not assigned the Connection model capability");
  }
  if (!connection.providerType) {
    return unavailable("Connection provider type is unavailable");
  }
  const knownModel = connection.modelCatalog?.models.some(
    (candidate: { providerModelId: string }) =>
      candidate.providerModelId === input.model.providerModelId,
  );
  return {
    assignment: structuredClone(input.model),
    state: knownModel ? "ready" : "requires-resolution",
    connection: structuredClone(connection),
    packageId: pkg.packageId,
    providerType: connection.providerType,
  };
}

export interface EffectiveBotModelV1 {
  /**
   * "bot" when the Bot overrides the User default, "default" when the Bot
   * follows `UserSettingsViewV1.newBotModelTemplate`, "none" when neither is
   * set.
   */
  source: "bot" | "default" | "none";
  model?: ModelAssignment;
  binding?: ResolvedModelBindingV1;
}

/**
 * The model a Bot actually runs on. A Bot without its own `model` follows the
 * User's default dynamically, so changing the default changes every Bot that
 * has not overridden it. Authority is unchanged: the returned binding is still
 * resolved against the Bot's own Assignments, so a Bot that has never claimed
 * the Connection's model Capability resolves "unavailable" until it does.
 */
export function resolveEffectiveBotModelV1(input: {
  bot: Pick<BotSettingsViewV1, "model" | "assignments">;
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): EffectiveBotModelV1 {
  const model = input.bot.model ?? input.user.newBotModelTemplate;
  if (!model) return { source: "none" };
  return {
    source: input.bot.model ? "bot" : "default",
    model: structuredClone(model),
    binding: resolveBotModelBindingV1({
      model,
      assignments: input.bot.assignments,
      user: input.user,
      packages: input.packages,
    }),
  };
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
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const decoded = record(value, label);
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(decoded, key)) ||
    Object.keys(decoded).some((key) => !allowed.has(key))
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
      256,
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
    case "bot/assign-capability": {
      const command = exactCommand(input, ["botId", "assignment"], ["model"]);
      const assignment = exactRecord(
        command.assignment,
        "assignment",
        ["assignmentId", "packageId", "capabilityId"],
        ["connectionId"],
      );
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        assignment: {
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
        },
        model: command.model === undefined ? undefined : model(command.model),
      };
    }
    case "bot/unbind-model": {
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
    [
      "failure",
      "generation",
      "providerType",
      "authorization",
      "modelCatalog",
      "settings",
    ],
  );
  const states: ConnectionView["state"][] = [
    "authorizing",
    "ready",
    "disabled",
    "revoking",
    "revoked",
    "reconciliation-required",
    "failed",
  ];
  if (!states.includes(connection.state as ConnectionView["state"])) {
    throw new ConfigurationDecodeError("Connection state is invalid");
  }
  const safeMetadata = record(connection.safeMetadata, "safeMetadata");
  const settings =
    connection.settings === undefined
      ? undefined
      : record(connection.settings, "settings");
  return {
    connectionId: identifier(connection.connectionId, "connectionId"),
    packageId: identifier(connection.packageId, "packageId"),
    connectionTypeId: identifier(
      connection.connectionTypeId,
      "connectionTypeId",
    ),
    displayName: text(connection.displayName, "displayName", 200),
    state: connection.state as ConnectionView["state"],
    generation: optionalText(connection.generation, "generation", 128),
    providerType: optionalText(connection.providerType, "providerType", 128),
    ...(connection.authorization === undefined
      ? {}
      : {
          authorization: decodeConnectionAuthorizationViewV1(
            connection.authorization,
          ),
        }),
    ...(connection.modelCatalog === undefined
      ? {}
      : {
          modelCatalog: decodeConnectionModelCatalogV1(connection.modelCatalog),
        }),
    ...(settings === undefined
      ? {}
      : {
          settings: Object.fromEntries(
            Object.entries(settings).map(([key, item]) => [
              key,
              safeJsonValue(item, `settings.${key}`),
            ]),
          ),
        }),
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
  if (
    !Array.isArray(value.packages) ||
    !Array.isArray(value.connections) ||
    value.connections.length > MAX_USER_CONNECTIONS_V1
  ) {
    throw new ConfigurationDecodeError(
      "User settings Packages and Connections must be bounded arrays",
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
    ],
    ["model"],
  );
  schemaVersion(value);
  if (!Array.isArray(value.assignments)) {
    throw new ConfigurationDecodeError(
      "Bot settings Assignments must be an array",
    );
  }
  return {
    schemaVersion: 1,
    botId: identifier(value.botId, "botId"),
    revision: viewRevision(value.revision),
    profile: botProfile(value.profile),
    notifications: notifications(value.notifications),
    assignments: value.assignments.map(capabilityAssignment),
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
  if (candidate.status !== "applied" && candidate.status !== "rejected") {
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
  return { ...receipt, status: "applied" };
}

// ---------------------------------------------------------------------------
// Composition generations: the redacted Bot-scoped projection of the durable
// `CompositionGenerationV1` records the Bot Durable Object owns. Artifact bytes
// never cross this seam; a member carries its content hash, and its recorded
// source text only when the Bot object holds an authorship record for it.
// ---------------------------------------------------------------------------

export const MAX_COMPOSITION_GENERATION_PAGE_V1 = 50;
export const MAX_COMPOSITION_MEMBERS_V1 = 512;
export const MAX_COMPOSITION_MEMBER_SOURCE_V1 = 262_144;

export type CompositionGenerationStatusViewV1 =
  "pending" | "active" | "superseded" | "failed" | "quarantined";

const COMPOSITION_GENERATION_STATUSES_V1: readonly CompositionGenerationStatusViewV1[] =
  ["pending", "active", "superseded", "failed", "quarantined"];

export type CompositionProvenanceViewV1 =
  | { kind: "first-party" }
  | { kind: "user"; userId: string; authoredAt: string }
  | {
      kind: "bot";
      botId: string;
      sessionId: string;
      turnId: string;
      runId: string;
      authoredAt: string;
    };

export type CompositionOriginViewV1 =
  | { kind: "bootstrap" }
  | { kind: "bot-authored"; runId: string; sessionId: string; turnId: string }
  | { kind: "user-install"; userId: string }
  | { kind: "revert"; revertsTo: string; userId: string };

export interface CompositionMemberViewV1 {
  packageId: string;
  version: string;
  provenance: CompositionProvenanceViewV1;
  /** Artifact identity only; the bundled bytes never reach a client. */
  contentHash?: string;
  /** Recorded source text for an isolate member, when authorship holds it. */
  source?: string;
}

export type CompositionFailurePhaseViewV1 =
  "resolve" | "bundle" | "mount" | "health";

const COMPOSITION_FAILURE_PHASES_V1: readonly CompositionFailurePhaseViewV1[] =
  ["resolve", "bundle", "mount", "health"];

export const MAX_COMPOSITION_FAILURE_PAGE_V1 = 32;

/**
 * One recorded activation failure. Diagnostics stay durable-side: they name
 * artifact content hashes and loader identities, which never cross this seam.
 */
export interface CompositionFailureViewV1 {
  attempt: number;
  at: string;
  phase: CompositionFailurePhaseViewV1;
  message: string;
}

export interface CompositionQuarantineViewV1 {
  quarantinedAt: string;
  reason: string;
  failures: number;
}

export interface CompositionGenerationViewV1 {
  schemaVersion: 1;
  botId: string;
  generationId: string;
  createdAt: string;
  status: CompositionGenerationStatusViewV1;
  origin: CompositionOriginViewV1;
  parentGenerationId?: string;
  isCurrent: boolean;
  members: CompositionMemberViewV1[];
  /** Oldest attempt first; empty for a generation that never failed. */
  failures: CompositionFailureViewV1[];
  /** Present once three consecutive failures quarantined this generation. */
  quarantine?: CompositionQuarantineViewV1;
}

export interface CompositionGenerationListViewV1 {
  schemaVersion: 1;
  botId: string;
  currentGenerationId: string;
  generations: CompositionGenerationViewV1[];
  cursor?: string;
}

export interface CompositionMemberVersionV1 {
  version: string;
  contentHash?: string;
}

export interface CompositionMemberDiffV1 {
  packageId: string;
  change: "added" | "removed" | "changed" | "unchanged";
  from?: CompositionMemberVersionV1;
  to?: CompositionMemberVersionV1;
}

export interface CompositionDiffV1 {
  fromGenerationId: string;
  toGenerationId: string;
  members: CompositionMemberDiffV1[];
}

export interface RevertCompositionCommandV1 {
  schemaVersion: 1;
  type: "composition/revert";
  commandId: string;
  botId: string;
  toGenerationId: string;
  /** Optimistic check, mirroring `expectedRevision` on configuration commands. */
  expectedGenerationId: string;
}

export type CompositionCommandReceiptV1 =
  | {
      schemaVersion: 1;
      commandId: string;
      status: "applied";
      generationId: string;
      currentGenerationId: string;
    }
  | {
      schemaVersion: 1;
      commandId: string;
      status: "rejected";
      failure: string;
      currentGenerationId: string;
    };

export function decodeCompositionGenerationIdV1(
  value: unknown,
  label = "generationId",
): string {
  if (!isRpcIdentifier(value)) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return value;
}

function compositionTimestamp(value: unknown, label: string): string {
  const candidate = text(value, label, 64);
  if (!Number.isFinite(Date.parse(candidate))) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return candidate;
}

function compositionHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return value;
}

function compositionProvenanceView(
  input: unknown,
): CompositionProvenanceViewV1 {
  const kind = record(input, "Composition provenance").kind;
  if (kind === "first-party") {
    exactRecord(input, "Composition provenance", ["kind"]);
    return { kind: "first-party" };
  }
  if (kind === "user") {
    const value = exactRecord(input, "Composition provenance", [
      "kind",
      "userId",
      "authoredAt",
    ]);
    return {
      kind: "user",
      userId: text(value.userId, "Composition provenance userId", 256),
      authoredAt: compositionTimestamp(
        value.authoredAt,
        "Composition provenance authoredAt",
      ),
    };
  }
  if (kind === "bot") {
    const value = exactRecord(input, "Composition provenance", [
      "kind",
      "botId",
      "sessionId",
      "turnId",
      "runId",
      "authoredAt",
    ]);
    return {
      kind: "bot",
      botId: decodeBotIdV1(value.botId),
      sessionId: text(value.sessionId, "Composition provenance sessionId", 257),
      turnId: text(value.turnId, "Composition provenance turnId", 128),
      runId: text(value.runId, "Composition provenance runId", 128),
      authoredAt: compositionTimestamp(
        value.authoredAt,
        "Composition provenance authoredAt",
      ),
    };
  }
  throw new ConfigurationDecodeError("Composition provenance kind is invalid");
}

function compositionOriginView(input: unknown): CompositionOriginViewV1 {
  const kind = record(input, "Composition origin").kind;
  if (kind === "bootstrap") {
    exactRecord(input, "Composition origin", ["kind"]);
    return { kind: "bootstrap" };
  }
  if (kind === "bot-authored") {
    const value = exactRecord(input, "Composition origin", [
      "kind",
      "runId",
      "sessionId",
      "turnId",
    ]);
    return {
      kind: "bot-authored",
      runId: text(value.runId, "Composition origin runId", 128),
      sessionId: text(value.sessionId, "Composition origin sessionId", 257),
      turnId: text(value.turnId, "Composition origin turnId", 128),
    };
  }
  if (kind === "user-install") {
    const value = exactRecord(input, "Composition origin", ["kind", "userId"]);
    return {
      kind: "user-install",
      userId: text(value.userId, "Composition origin userId", 256),
    };
  }
  if (kind === "revert") {
    const value = exactRecord(input, "Composition origin", [
      "kind",
      "revertsTo",
      "userId",
    ]);
    return {
      kind: "revert",
      revertsTo: decodeCompositionGenerationIdV1(
        value.revertsTo,
        "Composition origin revertsTo",
      ),
      userId: text(value.userId, "Composition origin userId", 256),
    };
  }
  throw new ConfigurationDecodeError("Composition origin kind is invalid");
}

function compositionMemberView(input: unknown): CompositionMemberViewV1 {
  const value = exactRecord(
    input,
    "Composition member",
    ["packageId", "version", "provenance"],
    ["contentHash", "source"],
  );
  if (
    value.source !== undefined &&
    (typeof value.source !== "string" ||
      value.source.length === 0 ||
      value.source.length > MAX_COMPOSITION_MEMBER_SOURCE_V1)
  ) {
    throw new ConfigurationDecodeError("Composition member source is invalid");
  }
  return {
    packageId: identifier(value.packageId, "Composition member packageId"),
    version: text(value.version, "Composition member version", 64),
    provenance: compositionProvenanceView(value.provenance),
    ...(value.contentHash === undefined
      ? {}
      : {
          contentHash: compositionHash(
            value.contentHash,
            "Composition member contentHash",
          ),
        }),
    ...(value.source === undefined ? {} : { source: value.source as string }),
  };
}

function compositionFailureView(input: unknown): CompositionFailureViewV1 {
  const value = exactRecord(input, "Composition failure", [
    "attempt",
    "at",
    "phase",
    "message",
  ]);
  if (
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    (value.attempt as number) > 1_000
  ) {
    throw new ConfigurationDecodeError(
      "Composition failure attempt is invalid",
    );
  }
  if (
    !COMPOSITION_FAILURE_PHASES_V1.includes(
      value.phase as CompositionFailurePhaseViewV1,
    )
  ) {
    throw new ConfigurationDecodeError("Composition failure phase is invalid");
  }
  return {
    attempt: value.attempt as number,
    at: compositionTimestamp(value.at, "Composition failure at"),
    phase: value.phase as CompositionFailurePhaseViewV1,
    message: text(value.message, "Composition failure message", 2_000),
  };
}

function compositionQuarantineView(
  input: unknown,
): CompositionQuarantineViewV1 {
  const value = exactRecord(input, "Composition quarantine", [
    "quarantinedAt",
    "reason",
    "failures",
  ]);
  if (
    !Number.isSafeInteger(value.failures) ||
    (value.failures as number) < 1 ||
    (value.failures as number) > 1_000
  ) {
    throw new ConfigurationDecodeError(
      "Composition quarantine failures is invalid",
    );
  }
  return {
    quarantinedAt: compositionTimestamp(
      value.quarantinedAt,
      "Composition quarantine quarantinedAt",
    ),
    reason: text(value.reason, "Composition quarantine reason", 2_000),
    failures: value.failures as number,
  };
}

export function decodeCompositionGenerationViewV1(
  input: unknown,
): CompositionGenerationViewV1 {
  const value = exactRecord(
    input,
    "Composition generation",
    [
      "schemaVersion",
      "botId",
      "generationId",
      "createdAt",
      "status",
      "origin",
      "isCurrent",
      "members",
      "failures",
    ],
    ["parentGenerationId", "quarantine"],
  );
  if (
    !Array.isArray(value.failures) ||
    value.failures.length > MAX_COMPOSITION_FAILURE_PAGE_V1
  ) {
    throw new ConfigurationDecodeError(
      "Composition generation failures are invalid",
    );
  }
  schemaVersion(value);
  if (
    !COMPOSITION_GENERATION_STATUSES_V1.includes(
      value.status as CompositionGenerationStatusViewV1,
    )
  ) {
    throw new ConfigurationDecodeError(
      "Composition generation status is invalid",
    );
  }
  if (typeof value.isCurrent !== "boolean") {
    throw new ConfigurationDecodeError(
      "Composition generation isCurrent is invalid",
    );
  }
  if (
    !Array.isArray(value.members) ||
    value.members.length > MAX_COMPOSITION_MEMBERS_V1
  ) {
    throw new ConfigurationDecodeError(
      "Composition generation members are invalid",
    );
  }
  const members = value.members.map(compositionMemberView);
  if (
    new Set(members.map((member) => member.packageId)).size !== members.length
  )
    throw new ConfigurationDecodeError(
      "Composition generation members are invalid",
    );
  return {
    schemaVersion: 1,
    botId: decodeBotIdV1(value.botId),
    generationId: decodeCompositionGenerationIdV1(value.generationId),
    createdAt: compositionTimestamp(
      value.createdAt,
      "Composition generation createdAt",
    ),
    status: value.status as CompositionGenerationStatusViewV1,
    origin: compositionOriginView(value.origin),
    isCurrent: value.isCurrent,
    members,
    failures: value.failures.map(compositionFailureView),
    ...(value.quarantine === undefined
      ? {}
      : { quarantine: compositionQuarantineView(value.quarantine) }),
    ...(value.parentGenerationId === undefined
      ? {}
      : {
          parentGenerationId: decodeCompositionGenerationIdV1(
            value.parentGenerationId,
            "parentGenerationId",
          ),
        }),
  };
}

export function decodeCompositionGenerationListViewV1(
  input: unknown,
): CompositionGenerationListViewV1 {
  const value = exactRecord(
    input,
    "Composition generation list",
    ["schemaVersion", "botId", "currentGenerationId", "generations"],
    ["cursor"],
  );
  schemaVersion(value);
  if (
    !Array.isArray(value.generations) ||
    value.generations.length > MAX_COMPOSITION_GENERATION_PAGE_V1
  ) {
    throw new ConfigurationDecodeError(
      "Composition generation list is invalid",
    );
  }
  const botId = decodeBotIdV1(value.botId);
  const generations = value.generations.map(decodeCompositionGenerationViewV1);
  if (generations.some((generation) => generation.botId !== botId)) {
    throw new ConfigurationDecodeError(
      "Composition generation list is invalid",
    );
  }
  return {
    schemaVersion: 1,
    botId,
    currentGenerationId: decodeCompositionGenerationIdV1(
      value.currentGenerationId,
      "currentGenerationId",
    ),
    generations,
    ...(value.cursor === undefined
      ? {}
      : { cursor: text(value.cursor, "cursor", 512) }),
  };
}

export function decodeRevertCompositionCommandV1(
  input: unknown,
): RevertCompositionCommandV1 {
  const value = exactRecord(input, "Composition revert command", [
    "schemaVersion",
    "type",
    "commandId",
    "botId",
    "toGenerationId",
    "expectedGenerationId",
  ]);
  schemaVersion(value);
  if (value.type !== "composition/revert") {
    throw new ConfigurationDecodeError(
      "unsupported Composition revert command",
    );
  }
  const toGenerationId = decodeCompositionGenerationIdV1(
    value.toGenerationId,
    "toGenerationId",
  );
  const expectedGenerationId = decodeCompositionGenerationIdV1(
    value.expectedGenerationId,
    "expectedGenerationId",
  );
  if (toGenerationId === expectedGenerationId) {
    throw new ConfigurationDecodeError(
      "Composition revert command targets the current generation",
    );
  }
  return {
    schemaVersion: 1,
    type: "composition/revert",
    commandId: connectionIdentifier(value.commandId, "commandId"),
    botId: decodeBotIdV1(value.botId),
    toGenerationId,
    expectedGenerationId,
  };
}

export function decodeCompositionCommandReceiptV1(
  input: unknown,
): CompositionCommandReceiptV1 {
  const candidate = record(input, "Composition command receipt");
  if (candidate.status !== "applied" && candidate.status !== "rejected") {
    throw new ConfigurationDecodeError(
      "Composition command receipt status is invalid",
    );
  }
  const value = exactRecord(
    input,
    "Composition command receipt",
    candidate.status === "applied"
      ? [
          "schemaVersion",
          "commandId",
          "status",
          "generationId",
          "currentGenerationId",
        ]
      : [
          "schemaVersion",
          "commandId",
          "status",
          "failure",
          "currentGenerationId",
        ],
  );
  schemaVersion(value);
  const shared = {
    schemaVersion: 1,
    commandId: connectionIdentifier(value.commandId, "commandId"),
    currentGenerationId: decodeCompositionGenerationIdV1(
      value.currentGenerationId,
      "currentGenerationId",
    ),
  } as const;
  if (value.status === "rejected") {
    return {
      ...shared,
      status: "rejected",
      failure: text(value.failure, "Composition command failure", 1_000),
    };
  }
  return {
    ...shared,
    status: "applied",
    generationId: decodeCompositionGenerationIdV1(value.generationId),
  };
}

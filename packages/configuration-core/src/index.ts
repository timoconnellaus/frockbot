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
    });

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

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return value;
}

export function decodeConnectionDependencyRequirementV1(
  input: unknown,
): ConnectionDependencyRequirementV1 {
  const value = record(input, "Connection dependency requirement");
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
  const profile = record(value, "profile");
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
  const policy = record(value, "notifications");
  if (typeof policy.enabled !== "boolean") {
    throw new ConfigurationDecodeError("notifications.enabled is invalid");
  }
  return { enabled: policy.enabled };
}

function model(value: unknown): ModelAssignment {
  const assignment = record(value, "model");
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
  if (value.type === "user/get") return { schemaVersion: 1, type: "user/get" };
  if (value.type === "bot/get") {
    return {
      schemaVersion: 1,
      type: "bot/get",
      botId: identifier(value.botId, "botId"),
    };
  }
  throw new ConfigurationDecodeError("unknown configuration query");
}

export function decodeConfigurationCommandV1(
  input: unknown,
): ConfigurationCommandV1 {
  const value = record(input, "command");
  const meta = commandMeta(value);
  switch (value.type) {
    case "user/update-profile": {
      const profile = record(value.profile, "profile");
      return {
        ...meta,
        type: value.type,
        profile: {
          name: text(profile.name, "profile.name", 100),
          email: optionalText(profile.email, "profile.email", 320),
        },
      };
    }
    case "user/set-new-bot-model":
      return {
        ...meta,
        type: value.type,
        model: value.model === undefined ? undefined : model(value.model),
      };
    case "user/install-package":
      return {
        ...meta,
        type: value.type,
        packageId: identifier(value.packageId, "packageId"),
        version: text(value.version, "version", 100),
      };
    case "user/set-package-enabled":
      if (typeof value.enabled !== "boolean") {
        throw new ConfigurationDecodeError("enabled is invalid");
      }
      return {
        ...meta,
        type: value.type,
        packageId: identifier(value.packageId, "packageId"),
        enabled: value.enabled,
      };
    case "bot/update-profile":
      return {
        ...meta,
        type: value.type,
        botId: identifier(value.botId, "botId"),
        profile: botProfile(value.profile),
      };
    case "bot/update-notifications":
      return {
        ...meta,
        type: value.type,
        botId: identifier(value.botId, "botId"),
        notifications: notifications(value.notifications),
      };
    case "bot/select-model":
      return {
        ...meta,
        type: value.type,
        botId: identifier(value.botId, "botId"),
        model: model(value.model),
      };
    case "bot/assign-capability": {
      const assignment = record(value.assignment, "assignment");
      return {
        ...meta,
        type: value.type,
        botId: identifier(value.botId, "botId"),
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
      };
    }
    default:
      throw new ConfigurationDecodeError("unknown configuration command");
  }
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
  const installation = record(value, "Package installation");
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
  const connection = record(value, "Connection");
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
  const assignment = record(value, "Capability Assignment");
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
  const value = record(input, "User settings");
  schemaVersion(value);
  const profile = record(value.profile, "profile");
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
  const value = record(input, "Bot settings");
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
  const value = record(input, "operation receipt");
  schemaVersion(value);
  if (value.status !== "applied" && value.status !== "rejected") {
    throw new ConfigurationDecodeError("operation receipt status is invalid");
  }
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

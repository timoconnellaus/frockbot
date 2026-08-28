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

export interface BotSettingsViewV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  profile: BotProfile;
  notifications: BotNotificationPolicy;
  assignments: CapabilityAssignmentView[];
  model?: ModelAssignment;
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

export interface OperationReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  revision: number;
  status: "applied";
}

export interface BotExecutionPlanV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  model?: ModelAssignment;
  assignments: CapabilityAssignmentView[];
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

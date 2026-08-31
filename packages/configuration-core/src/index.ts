import type {
  ConnectionAuthorizationViewV1,
  ConnectionModelCatalogV1,
} from "@frockbot/connection-core";
import {
  decodeConnectionAuthorizationViewV1,
  decodeConnectionModelCatalogV1,
} from "@frockbot/connection-core";
import { ConfigurationDecodeError } from "./errors.js";
import {
  MAX_PACKAGE_SETTINGS_V1,
  MAX_PACKAGE_SETTING_TEXT_V1,
  type PackageSettingValueV1,
} from "./package-settings.js";
export { ConfigurationDecodeError } from "./errors.js";
import { isBotIdV1 } from "./bot-id.js";
import {
  isConnectionIdentifier,
  isPublicIdentifier,
  isRpcIdentifier,
} from "./identifiers.js";
export { isBotIdV1 } from "./bot-id.js";
export {
  decodePackageSettingsPatchV1,
  decodePackageSettingValueV1,
  decodePackageSettingValuesV1,
  emptyPackageSettingValuesV1,
  MAX_PACKAGE_SETTINGS_V1,
  MAX_PACKAGE_SETTING_TEXT_V1,
  resolvePackageSettingValuesV1,
  type PackageSettingValueV1,
  type PackageSettingValuesV1,
} from "./package-settings.js";
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

/**
 * Who wrote the Bot's current name. A User rename and a Bot self-rename are
 * both durable writes of the same field, and "every durable write records its
 * writer", so the provenance travels with the name rather than beside it.
 */
export type BotNameProvenanceV1 = "user" | "bot";

/**
 * The Bot that made a durable Bot-scoped write, and the admitted Turn it made
 * it in. `namedBy` says *which kind* of writer changed a name; this says
 * *which* Bot, in which Session and Turn, so a self-management write is
 * reconstructable from durable state alone rather than only from the fact that
 * something Bot-shaped touched it.
 *
 * It is optional everywhere it appears: a record written by a User carries no
 * Bot writer, and a record written before this existed still decodes.
 */
export interface BotSelfWriterV1 {
  kind: "bot";
  botId: string;
  sessionId: string;
  turnId: string;
}

/** The content types an uploaded Bot avatar may carry. */
export const BOT_AVATAR_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
] as const;

export type BotAvatarContentTypeV1 = (typeof BOT_AVATAR_CONTENT_TYPES)[number];

/** 5 MB, the largest avatar an upload may carry. */
export const BOT_AVATAR_MAX_BYTES = 5_242_880;

/** Length of the lowercase hexadecimal SHA-256 digest an avatar is keyed by. */
const AVATAR_DIGEST_LENGTH = 64;

/**
 * The Bot's avatar. Absent means the default: the Flock's generated sheep
 * recipe. `{ kind: "sheep" }` says the same thing explicitly, so a clear can be
 * expressed as a value rather than as a missing field on a partial update.
 *
 * An uploaded image is a reference, never bytes: the bytes are immutable,
 * content-addressed durable content and the durable Bot state holds only the
 * digest that addresses them.
 */
export type BotAvatarV1 =
  | { kind: "sheep" }
  | {
      kind: "image";
      digest: string;
      contentType: BotAvatarContentTypeV1;
      size: number;
    };

export interface BotProfile {
  name: string;
  label?: string;
  description?: string;
  /** A short role line shown under the Bot's name. */
  title?: string;
  /** Provenance of the current `name`. Absent on records written before it. */
  namedBy?: BotNameProvenanceV1;
  /** Absent means the generated sheep avatar. */
  avatar?: BotAvatarV1;
  /** Keeps the Bot out of the default sidebar list without archiving it. */
  hiddenFromSidebar?: boolean;
}

/**
 * A partial Bot profile. Only the keys that are present change; an absent key
 * leaves the durable field exactly as it was. An empty string clears an
 * optional text field, and `{ kind: "sheep" }` clears an uploaded avatar.
 */
export interface BotProfilePatchV1 {
  name?: string;
  label?: string;
  description?: string;
  title?: string;
  avatar?: BotAvatarV1;
  hiddenFromSidebar?: boolean;
}

export interface BotNotificationPolicy {
  enabled: boolean;
}

export interface ModelAssignment {
  connectionId: string;
  providerModelId: string;
}

/**
 * Where an installed Package came from. `first-party` is a Package compiled
 * into the running application; `catalog` is one admitted from a pinned remote
 * Catalog generation, whose manifest is data and whose executing code is still
 * a reviewed first-party Package (ADR 0014). Absent means `first-party`, so
 * every installation recorded before the Catalog existed keeps its meaning.
 */
export type PackageProvenanceV1 = "first-party" | "catalog";

export interface PackageInstallationView {
  packageId: string;
  version: string;
  state: "installed" | "disabled" | "failed";
  failure?: string;
  /** The Catalog identity this installation was admitted from, if any. */
  catalogId?: string;
  /** The immutable Catalog generation `catalogId` was read from. */
  catalogGeneration?: string;
  provenance?: PackageProvenanceV1;
  /** The setup values the install carried, as GrokBot's `InstallPlugin{values}`. */
  values?: Record<string, JsonValue>;
}

/**
 * A durable pending decision for the User: this Connection needs authorizing
 * before it will do anything again.
 *
 * It carries **no URL**, and that is the whole design. A Bot may write one —
 * `mcp_authenticate_server` does, and so does a mount that met a 401 — but a
 * redirect is minted only by an authenticated User action. A single-use
 * ten-minute link stored in a projection every client reads, and replayed into
 * every transcript, would outlive the decision it belonged to and would let a
 * Bot hand its User a link it authored. The card is drawn from this record and
 * the link is authored when the User presses it.
 */
export interface PendingAuthorizationV1 {
  /** Why it is pending, in the Package's own vocabulary (`needs-auth`). */
  reason: string;
  /** When it became pending, ISO-8601. */
  since: string;
  connectionId: string;
  label: string;
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
  /** Set while this Connection is waiting on a User authorization. */
  pendingAuthorization?: PendingAuthorizationV1;
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
  /**
   * The remote Catalog generation this User is pinned to, and the content hash
   * of that generation's index. Pinned on the first read that finds a Catalog
   * and never moved by an install, so a Catalog install is always validated
   * against an immutable, content-addressed generation. Both are absent for a
   * User whose deployment has no Catalog, so the decoder must accept absence.
   */
  catalogGeneration?: string;
  catalogIndexHash?: string;
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
      /**
       * A Catalog install names the entry and the generation it was read
       * from. The User Durable Object refuses a generation other than the one
       * it pinned, so a stale browser cannot install off a moved index. All
       * three absent is the unchanged compiled-in install path.
       */
      catalogId?: string;
      catalogGeneration?: string;
      values?: Record<string, JsonValue>;
    })
  | (CommandMetaV1 & {
      /**
       * Removes the installation. Dependent Assignments are never deleted:
       * they resolve as unavailable tombstones the User can repair (ADR 0003).
       * Connections are untouched.
       */
      type: "user/uninstall-package";
      packageId: string;
    })
  | (CommandMetaV1 & {
      type: "user/set-package-enabled";
      packageId: string;
      enabled: boolean;
    })
  | (CommandMetaV1 & {
      /**
       * A partial update of one installed Package's setting values: only the
       * ids it names change, and an id it omits keeps the value it had.
       *
       * The values are shape-checked here and schema-checked by the User
       * Durable Object, which is the only place that knows which settings the
       * installed version of that Package declares.
       */
      type: "user/set-package-settings";
      packageId: string;
      values: Record<string, PackageSettingValueV1>;
    })
  | (CommandMetaV1 & {
      type: "bot/update-profile";
      botId: string;
      profile: BotProfile;
    })
  | (CommandMetaV1 & {
      /**
       * Partial profile update: only the fields the command carries change.
       * `namedBy` records the writer of a name change and defaults to the
       * User, so a Bot renaming itself states so explicitly.
       */
      type: "bot/set-profile";
      botId: string;
      namedBy?: BotNameProvenanceV1;
      /**
       * The Bot and Turn that wrote this patch, when a Bot wrote it. A User
       * edit carries none: the authenticated principal is already the writer.
       */
      writer?: BotSelfWriterV1;
      profile: BotProfilePatchV1;
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
      type: "bot/replace-capability";
      botId: string;
      assignment: Omit<CapabilityAssignmentView, "state">;
      model?: ModelAssignment;
    })
  | (CommandMetaV1 & {
      type: "bot/unassign-capability";
      botId: string;
      assignmentId: string;
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

/**
 * The idempotency fingerprint of any command, under a caller-chosen namespace.
 *
 * One canonicalization serves every command family so a replayed idempotency
 * key is compared the same way everywhere, and the namespace keeps two families
 * from ever producing the same bytes for different meanings.
 */
export function canonicalCommandFingerprintV1(
  namespace: string,
  command: unknown,
): string {
  return `${namespace}:${canonicalFingerprintValue(command)}`;
}

export function configurationCommandFingerprintV1(
  command: ConfigurationCommandV1,
): string {
  const { commandId: _commandId, ...semanticCommand } = command;
  return canonicalCommandFingerprintV1(
    "configuration-command-v1",
    semanticCommand,
  );
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
    kind?:
      "tool" | "model" | "memory" | "notification" | "computer" | "channel";
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

const rpcDisposalKeys: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  Symbol.dispose,
  Symbol.asyncDispose,
]);

function exactRecord(
  value: unknown,
  label: string,
  required: readonly PropertyKey[],
  optional: readonly PropertyKey[] = [],
): Record<string, unknown> {
  const decoded = record(value, label);
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  // Values returned over Durable Object RPC carry a disposal symbol as an own
  // key; it is transport, not a field. Every other own key must be declared.
  if (
    !required.every((key) => Object.hasOwn(decoded, key)) ||
    Reflect.ownKeys(decoded).some(
      (key) => !allowed.has(key) && !rpcDisposalKeys.has(key),
    )
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

function nameProvenance(value: unknown, label: string): BotNameProvenanceV1 {
  if (value !== "user" && value !== "bot") {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return value;
}

/**
 * The exact Bot writer DTO. It crosses the Bot Durable Object seam and the
 * session event log, so — like every other cross-runtime value — it decodes
 * exactly once, here, with no extra fields tolerated.
 */
export function decodeBotSelfWriterV1(
  value: unknown,
  label = "writer",
): BotSelfWriterV1 {
  const writer = exactRecord(value, label, [
    "kind",
    "botId",
    "sessionId",
    "turnId",
  ]);
  if (writer.kind !== "bot") {
    throw new ConfigurationDecodeError(`${label}.kind is invalid`);
  }
  return {
    kind: "bot",
    botId: decodeBotIdV1(writer.botId, `${label}.botId`),
    sessionId: text(writer.sessionId, `${label}.sessionId`, 256),
    turnId: text(writer.turnId, `${label}.turnId`, 128),
  };
}

function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigurationDecodeError(`${label} must be a boolean`);
  }
  return value;
}

/**
 * The exact avatar DTO. It crosses the Bot Durable Object seam, the gateway
 * seam, and (in a later slice) the Bot isolate seam, so it decodes exactly
 * once, here.
 */
export function decodeBotAvatarV1(
  value: unknown,
  label = "avatar",
): BotAvatarV1 {
  const avatar = record(value, label);
  if (avatar.kind === "sheep") {
    exactRecord(value, label, ["kind"]);
    return { kind: "sheep" };
  }
  const image = exactRecord(value, label, [
    "kind",
    "digest",
    "contentType",
    "size",
  ]);
  if (image.kind !== "image") {
    throw new ConfigurationDecodeError(`${label}.kind is invalid`);
  }
  const digest = image.digest;
  if (
    typeof digest !== "string" ||
    digest.length !== AVATAR_DIGEST_LENGTH ||
    !/^[0-9a-f]+$/.test(digest)
  ) {
    throw new ConfigurationDecodeError(`${label}.digest is invalid`);
  }
  const contentType = image.contentType;
  if (
    typeof contentType !== "string" ||
    !(BOT_AVATAR_CONTENT_TYPES as readonly string[]).includes(contentType)
  ) {
    throw new ConfigurationDecodeError(`${label}.contentType is invalid`);
  }
  const size = image.size;
  if (
    !Number.isSafeInteger(size) ||
    (size as number) < 1 ||
    (size as number) > BOT_AVATAR_MAX_BYTES
  ) {
    throw new ConfigurationDecodeError(`${label}.size is invalid`);
  }
  return {
    kind: "image",
    digest,
    contentType: contentType as BotAvatarContentTypeV1,
    size: size as number,
  };
}

const BOT_PROFILE_OPTIONAL_FIELDS = [
  "label",
  "description",
  "title",
  "namedBy",
  "avatar",
  "hiddenFromSidebar",
] as const;

function botProfile(value: unknown): BotProfile {
  const profile = exactRecord(
    value,
    "profile",
    ["name"],
    BOT_PROFILE_OPTIONAL_FIELDS,
  );
  return {
    name: text(profile.name, "profile.name", 100),
    label: optionalText(profile.label, "profile.label", 120),
    description: optionalText(
      profile.description,
      "profile.description",
      10_000,
    ),
    ...(profile.title === undefined
      ? {}
      : { title: text(profile.title, "profile.title", 120) }),
    ...(profile.namedBy === undefined
      ? {}
      : { namedBy: nameProvenance(profile.namedBy, "profile.namedBy") }),
    ...(profile.avatar === undefined
      ? {}
      : { avatar: decodeBotAvatarV1(profile.avatar, "profile.avatar") }),
    ...(profile.hiddenFromSidebar === undefined
      ? {}
      : {
          hiddenFromSidebar: flag(
            profile.hiddenFromSidebar,
            "profile.hiddenFromSidebar",
          ),
        }),
  };
}

/**
 * A patch field that carries text: a non-empty string sets it, and the empty
 * string clears it. A partial update has no other way to say "remove this".
 */
function patchText(
  value: unknown,
  label: string,
  maximum: number,
): string | "" {
  if (typeof value !== "string") {
    throw new ConfigurationDecodeError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new ConfigurationDecodeError(`${label} is invalid`);
  }
  return normalized;
}

function botProfilePatch(value: unknown): BotProfilePatchV1 {
  const patch = exactRecord(
    value,
    "profile",
    [],
    ["name", "label", "description", "title", "avatar", "hiddenFromSidebar"],
  );
  if (Reflect.ownKeys(patch).length === 0) {
    throw new ConfigurationDecodeError("profile has invalid fields");
  }
  const optional = (key: "label" | "description" | "title", maximum: number) =>
    patch[key] === undefined
      ? {}
      : { [key]: patchText(patch[key], `profile.${key}`, maximum) };
  return {
    // The name is the one field a partial update may not blank.
    ...(patch.name === undefined
      ? {}
      : { name: text(patch.name, "profile.name", 100) }),
    ...optional("label", 120),
    ...optional("description", 10_000),
    ...optional("title", 120),
    ...(patch.avatar === undefined
      ? {}
      : { avatar: decodeBotAvatarV1(patch.avatar, "profile.avatar") }),
    ...(patch.hiddenFromSidebar === undefined
      ? {}
      : {
          hiddenFromSidebar: flag(
            patch.hiddenFromSidebar,
            "profile.hiddenFromSidebar",
          ),
        }),
  };
}

/**
 * Apply a partial profile update. Only the keys the patch carries change; an
 * empty string clears an optional text field, and a `sheep` avatar clears an
 * uploaded one. `namedBy` is recorded only when the name actually changes, so
 * an unrelated edit never rewrites the provenance of the current name.
 */
export function applyBotProfilePatchV1(
  current: BotProfile,
  patch: BotProfilePatchV1,
  namedBy: BotNameProvenanceV1,
): BotProfile {
  const next: BotProfile = { ...structuredClone(current) };
  if (patch.name !== undefined && patch.name !== current.name) {
    next.name = patch.name;
    next.namedBy = namedBy;
  }
  for (const key of ["label", "description", "title"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === "") delete next[key];
    else next[key] = value;
  }
  if (patch.avatar !== undefined) {
    if (patch.avatar.kind === "sheep") delete next.avatar;
    else next.avatar = { ...patch.avatar };
  }
  if (patch.hiddenFromSidebar !== undefined) {
    if (patch.hiddenFromSidebar) next.hiddenFromSidebar = true;
    else delete next.hiddenFromSidebar;
  }
  return next;
}

function notifications(value: unknown): BotNotificationPolicy {
  const policy = exactRecord(value, "notifications", ["enabled"]);
  if (typeof policy.enabled !== "boolean") {
    throw new ConfigurationDecodeError("notifications.enabled is invalid");
  }
  return { enabled: policy.enabled };
}

/** The exact Bot model DTO, decoded wherever it crosses a durable seam. */
export function decodeModelAssignmentV1(value: unknown): ModelAssignment {
  return model(value);
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
      const command = exactCommand(
        input,
        ["packageId", "version"],
        ["catalogId", "catalogGeneration", "values"],
      );
      // A Catalog install is all three of identity, generation and (optional)
      // values or none of them: half a Catalog install would be an install
      // against no pinned generation at all.
      if (
        (command.catalogId === undefined) !==
        (command.catalogGeneration === undefined)
      ) {
        throw new ConfigurationDecodeError(
          "a Catalog install requires both catalogId and catalogGeneration",
        );
      }
      if (command.catalogId === undefined && command.values !== undefined) {
        throw new ConfigurationDecodeError(
          "install values require a Catalog entry",
        );
      }
      return {
        ...commandMeta(command),
        type: value.type,
        packageId: identifier(command.packageId, "packageId"),
        version: text(command.version, "version", 100),
        ...(command.catalogId === undefined
          ? {}
          : {
              catalogId: identifier(command.catalogId, "catalogId"),
              catalogGeneration: identifier(
                command.catalogGeneration,
                "catalogGeneration",
              ),
            }),
        ...(command.values === undefined
          ? {}
          : { values: installValues(command.values) }),
      };
    }
    case "user/uninstall-package": {
      const command = exactCommand(input, ["packageId"]);
      return {
        ...commandMeta(command),
        type: value.type,
        packageId: identifier(command.packageId, "packageId"),
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
    case "user/set-package-settings": {
      const command = exactCommand(input, ["packageId", "values"]);
      return {
        ...commandMeta(command),
        type: value.type,
        packageId: identifier(command.packageId, "packageId"),
        values: packageSettingsPatch(command.values),
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
    case "bot/set-profile": {
      const command = exactCommand(
        input,
        ["botId", "profile"],
        ["namedBy", "writer"],
      );
      const botId = identifier(command.botId, "botId");
      const writer =
        command.writer === undefined
          ? undefined
          : decodeBotSelfWriterV1(command.writer);
      // A Bot writes only its own profile. The command names the target twice,
      // so the seam refuses a writer aimed at anything but itself rather than
      // recording a provenance the authority never granted.
      if (writer && writer.botId !== botId) {
        throw new ConfigurationDecodeError("writer.botId is invalid");
      }
      return {
        ...commandMeta(command),
        type: "bot/set-profile",
        botId,
        ...(command.namedBy === undefined
          ? {}
          : { namedBy: nameProvenance(command.namedBy, "namedBy") }),
        ...(writer ? { writer } : {}),
        profile: botProfilePatch(command.profile),
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
      const command = exactCommand(input, ["botId", "assignment"], ["model"]);
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        assignment: assignmentTarget(command.assignment, "assignment"),
        model: command.model === undefined ? undefined : model(command.model),
      };
    }
    case "bot/unassign-capability":
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

/** Most setup values one Catalog install may carry. */
const MAX_INSTALL_VALUES_V1 = 32;
const MAX_INSTALL_VALUES_BYTES_V1 = 16_384;

/**
 * The `values` a Catalog install carries. Bounded and JSON-only, because they
 * become durable User state: the User Durable Object stores them on the
 * installation, and nothing here may become a prototype or a function.
 */
function installValues(value: unknown): Record<string, JsonValue> {
  const values = record(value, "values");
  const entries = Object.entries(values);
  if (entries.length > MAX_INSTALL_VALUES_V1) {
    throw new ConfigurationDecodeError("values is too large");
  }
  const decoded = Object.fromEntries(
    entries.map(([key, item]) => [
      identifier(key, "values key"),
      safeJsonValue(item, `values.${key}`),
    ]),
  );
  const serialized = JSON.stringify(decoded);
  if (
    serialized === undefined ||
    serialized.length > MAX_INSTALL_VALUES_BYTES_V1
  ) {
    throw new ConfigurationDecodeError("values is too large");
  }
  return decoded;
}

/**
 * The shape of a `user/set-package-settings` payload, before anything knows
 * which Package it is for.
 *
 * Only the shape: ids are identifiers, values are scalars, and the bag is
 * bounded. Whether a named setting exists, and whether its value satisfies the
 * schema the Package declared, is the User Durable Object's answer — it is the
 * authority that holds the installed version.
 */
function packageSettingsPatch(
  value: unknown,
): Record<string, PackageSettingValueV1> {
  const values = record(value, "values");
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new ConfigurationDecodeError("values names no setting");
  }
  if (entries.length > MAX_PACKAGE_SETTINGS_V1) {
    throw new ConfigurationDecodeError("values is too large");
  }
  return Object.fromEntries(
    entries.map(([key, item]) => {
      if (
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean"
      ) {
        throw new ConfigurationDecodeError(`values.${key} is invalid`);
      }
      if (typeof item === "number" && !Number.isFinite(item)) {
        throw new ConfigurationDecodeError(`values.${key} is invalid`);
      }
      if (
        typeof item === "string" &&
        item.length > MAX_PACKAGE_SETTING_TEXT_V1
      ) {
        throw new ConfigurationDecodeError(`values.${key} is too long`);
      }
      return [identifier(key, "values key"), item];
    }),
  );
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
    ["failure", "catalogId", "catalogGeneration", "provenance", "values"],
  );
  if (
    installation.state !== "installed" &&
    installation.state !== "disabled" &&
    installation.state !== "failed"
  ) {
    throw new ConfigurationDecodeError("Package installation state is invalid");
  }
  if (
    installation.provenance !== undefined &&
    installation.provenance !== "first-party" &&
    installation.provenance !== "catalog"
  ) {
    throw new ConfigurationDecodeError(
      "Package installation provenance is invalid",
    );
  }
  return {
    packageId: identifier(installation.packageId, "packageId"),
    version: text(installation.version, "version", 100),
    state: installation.state,
    failure: optionalText(installation.failure, "failure", 2_000),
    ...(installation.catalogId === undefined
      ? {}
      : { catalogId: identifier(installation.catalogId, "catalogId") }),
    ...(installation.catalogGeneration === undefined
      ? {}
      : {
          catalogGeneration: identifier(
            installation.catalogGeneration,
            "catalogGeneration",
          ),
        }),
    ...(installation.provenance === undefined
      ? {}
      : { provenance: installation.provenance }),
    ...(installation.values === undefined
      ? {}
      : { values: installValues(installation.values) }),
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
      "pendingAuthorization",
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
    ...(connection.pendingAuthorization === undefined
      ? {}
      : {
          pendingAuthorization: decodePendingAuthorizationV1(
            connection.pendingAuthorization,
          ),
        }),
  };
}

/**
 * The pending decision, decoded strictly — and refused outright if it carries
 * anything that looks like a redirect. The rule that a Bot never hands its
 * User a link it authored is worth an assertion rather than a convention.
 */
export function decodePendingAuthorizationV1(
  input: unknown,
): PendingAuthorizationV1 {
  const value = exactRecord(input, "pendingAuthorization", [
    "reason",
    "since",
    "connectionId",
    "label",
  ]);
  return {
    reason: text(value.reason, "pendingAuthorization.reason", 64),
    since: text(value.since, "pendingAuthorization.since", 64),
    connectionId: identifier(
      value.connectionId,
      "pendingAuthorization.connectionId",
    ),
    label: text(value.label, "pendingAuthorization.label", 200),
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
    ["newBotModelTemplate", "catalogGeneration", "catalogIndexHash"],
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
    // The pin is optional — a deployment with no Catalog has none — but never
    // half present: one field alone is a corrupt pin, not a pin.
    ...(value.catalogGeneration === undefined &&
    value.catalogIndexHash === undefined
      ? {}
      : {
          catalogGeneration: identifier(
            value.catalogGeneration,
            "catalogGeneration",
          ),
          catalogIndexHash: text(
            value.catalogIndexHash,
            "catalogIndexHash",
            64,
          ),
        }),
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

/**
 * An avatar upload. The bytes travel base64-encoded because the hosted client
 * transport carries a string body; they are written once as immutable,
 * content-addressed durable content, and the Bot's durable profile then holds
 * only the digest that addresses them.
 */
export interface UploadBotAvatarCommandV1 {
  schemaVersion: 1;
  type: "bot/upload-avatar";
  botId: string;
  contentType: BotAvatarContentTypeV1;
  bytes: string;
}

export interface BotAvatarUploadReceiptV1 {
  schemaVersion: 1;
  botId: string;
  avatar: Extract<BotAvatarV1, { kind: "image" }>;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The byte count a base64 payload decodes to, computed without decoding it, so
 * an oversized upload is refused before it is materialized.
 */
function base64ByteLength(value: string): number {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new ConfigurationDecodeError("avatar bytes are not base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function decodeUploadBotAvatarCommandV1(
  input: unknown,
): UploadBotAvatarCommandV1 {
  const value = exactRecord(input, "avatar upload command", [
    "schemaVersion",
    "type",
    "botId",
    "contentType",
    "bytes",
  ]);
  if (value.schemaVersion !== 1 || value.type !== "bot/upload-avatar") {
    throw new ConfigurationDecodeError("unsupported avatar upload command");
  }
  if (
    typeof value.contentType !== "string" ||
    !(BOT_AVATAR_CONTENT_TYPES as readonly string[]).includes(value.contentType)
  ) {
    throw new ConfigurationDecodeError(
      "avatar contentType is not a supported image",
    );
  }
  if (typeof value.bytes !== "string") {
    throw new ConfigurationDecodeError("avatar bytes are invalid");
  }
  const size = base64ByteLength(value.bytes);
  if (size < 1) throw new ConfigurationDecodeError("avatar bytes are empty");
  if (size > BOT_AVATAR_MAX_BYTES) {
    throw new ConfigurationDecodeError(
      `avatar exceeds ${BOT_AVATAR_MAX_BYTES} bytes`,
    );
  }
  return {
    schemaVersion: 1,
    type: "bot/upload-avatar",
    botId: decodeBotIdV1(value.botId),
    contentType: value.contentType as BotAvatarContentTypeV1,
    bytes: value.bytes,
  };
}

/** The exact bytes an upload command carries, decoded once at the seam. */
export function decodeBotAvatarBytesV1(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodeBotAvatarUploadReceiptV1(
  input: unknown,
): BotAvatarUploadReceiptV1 {
  const value = exactRecord(input, "avatar upload receipt", [
    "schemaVersion",
    "botId",
    "avatar",
  ]);
  if (value.schemaVersion !== 1) {
    throw new ConfigurationDecodeError("unsupported avatar upload receipt");
  }
  const avatar = decodeBotAvatarV1(value.avatar, "avatar");
  if (avatar.kind !== "image") {
    throw new ConfigurationDecodeError(
      "avatar upload receipt avatar is invalid",
    );
  }
  return {
    schemaVersion: 1,
    botId: decodeBotIdV1(value.botId),
    avatar,
  };
}

/**
 * The object key an avatar's bytes live at. Content-addressed, and namespaced
 * by the owning User so one User's avatar is never served for another's Bot.
 */
export function botAvatarObjectKeyV1(userId: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new ConfigurationDecodeError("avatar digest is invalid");
  }
  return `bot-avatars/${encodeURIComponent(userId)}/${digest}`;
}

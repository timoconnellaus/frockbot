import type {
  ConnectionAuthorizationViewV1,
  ConnectionModelCatalogV1,
} from "@frockbot/connection-core";
import {
  decodeConnectionAuthorizationViewV1,
  decodeConnectionModelCatalogV1,
} from "@frockbot/connection-core";
import type { PackageSettingDefinition } from "@frockbot/kernel-composition";
import { ConfigurationDecodeError } from "./errors.js";
import {
  decodeInstalledPackageSettingsPatchV1,
  decodeInstalledPackageSettingIdsV1,
  decodeModelBindingV1,
  MAX_PACKAGE_SETTINGS_V1,
  MAX_PACKAGE_SETTING_TEXT_V1,
  resolvePackageSettingValuesV1,
  type InstalledPackageSettingsV1,
  type ModelBindingV1,
  type PackageSettingsDefinitionV1,
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
  decodeInstalledPackageSettingsPatchV1,
  decodeInstalledPackageSettingIdsV1,
  decodeModelBindingV1,
  decodePackageSettingsPatchV1,
  decodePackageSettingIdsV1,
  decodePackageSettingValueV1,
  decodePackageSettingValuesV1,
  emptyPackageSettingValuesV1,
  MAX_PACKAGE_SETTINGS_V1,
  MAX_PACKAGE_SETTING_TEXT_V1,
  resolvePackageSettingValuesV1,
  type InstalledPackageSettingsV1,
  type ModelBindingV1,
  type PackageSettingsDefinitionV1,
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

export interface BotProfile {
  name: string;
  label?: string;
  description?: string;
  /** A short role line shown under the Bot's name. */
  title?: string;
  /** Provenance of the current `name`. Absent on records written before it. */
  namedBy?: BotNameProvenanceV1;
  /** Keeps the Bot out of the default sidebar list without archiving it. */
  hiddenFromSidebar?: boolean;
}

/**
 * A partial Bot profile. Only the keys that are present change; an absent key
 * leaves the durable field exactly as it was. An empty string clears an
 * optional text field.
 */
export interface BotProfilePatchV1 {
  name?: string;
  label?: string;
  description?: string;
  title?: string;
  hiddenFromSidebar?: boolean;
}

export interface BotNotificationPolicy {
  enabled: boolean;
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
  /** Exact non-first-party bundle admitted from the Catalog, when it carries code. */
  contentHash?: string;
  provenance?: PackageProvenanceV1;
  /** The setup values the install carried, as GrokBot's `InstallPlugin{values}`. */
  values?: Record<string, JsonValue | ModelBindingV1>;
}

/**
 * A durable pending decision for the User: this Connection needs authorizing
 * before it will do anything again.
 *
 * It carries **no URL**, and that is the whole design. A mount that meets a
 * 401 may write one, but a Bot has no command that requests authorization and
 * a redirect is minted only by an authenticated User action. A single-use
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

/**
 * The stored name of a User who has not chosen one. The contract requires a
 * non-empty name, so "unset" is spelled with this sentinel.
 */
export const USER_PROFILE_PLACEHOLDER_NAME_V1 = "FrockBot user";

/** Whether a profile name is one the User actually chose (not blank, not the sentinel). */
export function isChosenUserName(name: string | undefined): name is string {
  const candidate = name?.trim();
  return Boolean(candidate && candidate !== USER_PROFILE_PLACEHOLDER_NAME_V1);
}

export interface UserSettingsViewV1 {
  schemaVersion: 1;
  revision: number;
  profile: { name: string; email?: string };
  packages: PackageInstallationView[];
  connections: ConnectionView[];
  /**
   * The model the platform chose for this User. Only a provider bootstrap
   * writes it; no User command may do so (AGENTS.md Configuration shape).
   */
  platformModel?: ModelBindingV1;
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

export interface BotSettingsViewV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  profile: BotProfile;
  notifications: BotNotificationPolicy;
  /**
   * Package-owned Bot overrides. Disabling a Package leaves these durable but
   * inert so re-enabling restores them (ADR 0019).
   */
  packageValues: Record<string, Record<string, unknown>>;
}

export function initializeBotSettingsV1(botId: string): BotSettingsViewV1 {
  return {
    schemaVersion: 1,
    botId,
    revision: 0,
    profile: { name: botId === "default" ? "Barebones" : botId },
    notifications: { enabled: true },
    packageValues: {},
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
      /**
       * Only a backend Contribution may issue this command. The User gateway
       * enforces that authority; a User can choose a model only by enabling a
       * Package that owns model-role settings.
       */
      type: "user/set-platform-model";
      model: ModelBindingV1;
    })
  | (CommandMetaV1 & {
      type: "user/install-package";
      packageId: string;
      version: string;
      /** Installs enabled unless the caller explicitly asks otherwise. */
      enabled?: boolean;
      /**
       * A Catalog install names the entry and the generation it was read
       * from. The User Durable Object refuses a generation other than the one
       * it pinned, so a stale browser cannot install off a moved index. All
       * three absent is the unchanged compiled-in install path.
       */
      catalogId?: string;
      catalogGeneration?: string;
      contentHash?: string;
      values?: Record<string, JsonValue>;
    })
  | (CommandMetaV1 & {
      /** Removes the installation; Connections remain User-owned (ADR 0019). */
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
      values?: Record<string, PackageSettingValueV1>;
      /** Setting ids whose stored values are removed by this command. */
      unset?: string[];
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
      /**
       * A partial update of one installed Package's Bot-scoped setting bag.
       * The Bot authority validates it against that installed version's
       * manifest through the same codec as User-scoped Package settings.
       */
      type: "bot/set-package-settings";
      botId: string;
      packageId: string;
      values?: Record<string, PackageSettingValueV1>;
      /** Setting ids whose stored values are removed by this command. */
      unset?: string[];
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
  model?: ModelBindingV1;
  capabilities: EnabledCapabilityV1[];
}

/** One Capability granted account-wide by an enabled Package (ADR 0019). */
export interface EnabledCapabilityV1 {
  packageId: string;
  capabilityId: string;
  kind: "tool" | "model" | "memory" | "notification" | "computer";
  connectionId?: string;
}

export interface ExecutionPackageDefinition {
  packageId: string;
  version: string;
  settings: PackageSettingDefinition[];
  capabilities: Array<{
    id: string;
    kind: "tool" | "model" | "memory" | "notification" | "computer";
    connectionTypes: string[];
  }>;
  connectionTypes: Array<{
    id: string;
    capabilities: string[];
  }>;
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function modelBindingFailureV1(input: {
  model: ModelBindingV1;
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): string | undefined {
  const connection = input.user.connections.find(
    (candidate) => candidate.connectionId === input.model.connectionId,
  );
  if (!connection) {
    return "That account is no longer connected. Reconnect it, or pick another model.";
  }
  if (connection.state !== "ready") {
    return "That account needs reconnecting before this Bot can reply.";
  }
  const installation = input.user.packages.find(
    (candidate) => candidate.packageId === connection.packageId,
  );
  if (!installation || installation.state !== "installed") {
    return "Turn this model's plugin back on in Plugins to use it.";
  }
  const pkg = input.packages.find(
    (candidate) =>
      candidate.packageId === connection.packageId &&
      candidate.version === installation.version,
  );
  if (!pkg) {
    return "This model's plugin is unavailable. Pick another model.";
  }
  const connectionType = pkg.connectionTypes.find(
    (candidate) => candidate.id === connection.connectionTypeId,
  );
  const modelCapability = pkg.capabilities.find(
    (candidate) =>
      candidate.kind === "model" &&
      candidate.connectionTypes.includes(connection.connectionTypeId) &&
      connectionType?.capabilities.includes(candidate.id),
  );
  if (!connectionType || !modelCapability) {
    return "That account can't provide this model. Pick another one in Models.";
  }
  return undefined;
}

export interface ResolvedModelBindingV1 {
  model?: ModelBindingV1;
  state: "ready" | "requires-resolution" | "unavailable";
  connection?: ConnectionView;
  packageId?: string;
  providerType?: string;
  failure?: string;
}

export function resolveBotModelBindingV1(input: {
  model: ModelBindingV1;
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): ResolvedModelBindingV1 {
  const unavailable = (failure: string): ResolvedModelBindingV1 => ({
    model: structuredClone(input.model),
    state: "unavailable",
    failure,
  });
  const failure = modelBindingFailureV1(input);
  if (failure) return unavailable(failure);
  const connection = input.user.connections.find(
    (candidate) => candidate.connectionId === input.model.connectionId,
  )!;
  const installation = input.user.packages.find(
    (candidate) => candidate.packageId === connection.packageId,
  )!;
  const pkg = input.packages.find(
    (candidate) =>
      candidate.packageId === connection.packageId &&
      candidate.version === installation.version,
  )!;
  if (!connection.providerType) {
    return unavailable("That account isn't set up for models yet.");
  }
  const knownModel = connection.modelCatalog?.models.some(
    (candidate: { providerModelId: string }) =>
      candidate.providerModelId === input.model.providerModelId,
  );
  return {
    model: structuredClone(input.model),
    state: knownModel ? "ready" : "requires-resolution",
    connection: structuredClone(connection),
    packageId: pkg.packageId,
    providerType: connection.providerType,
  };
}

export interface EffectiveBotModelV1 {
  /**
   * The Package setting scope that supplied the model, or the platform
   * bootstrap when no enabled model-choice Package supplied one.
   */
  source: "bot" | "account" | "platform" | "none";
  model?: ModelBindingV1;
  binding?: ResolvedModelBindingV1;
}

/**
 * The model a Bot actually runs on. The kernel knows only the manifest role:
 * Bot value, User value, then platform bootstrap. Disabled Package values stay
 * present but are inert, as required by AGENTS.md Configuration shape.
 */
export function resolveEffectiveBotModelV1(input: {
  bot: Pick<BotSettingsViewV1, "packageValues">;
  user: UserSettingsViewV1;
  packages: readonly ExecutionPackageDefinition[];
}): EffectiveBotModelV1 {
  const enabled = input.user.packages
    .filter((installation) => installation.state === "installed")
    .map((installation) => ({
      installation,
      pkg: input.packages.find(
        (candidate) =>
          candidate.packageId === installation.packageId &&
          candidate.version === installation.version,
      ),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        installation: PackageInstallationView;
        pkg: ExecutionPackageDefinition;
      } => candidate.pkg !== undefined,
    );

  const fromScope = (
    scope: "user" | "bot",
  ): { model?: ModelBindingV1; conflict?: string } | undefined => {
    const declarations = enabled
      .map(({ installation, pkg }) => ({
        installation,
        pkg,
        definition: pkg.settings
          .filter(
            (definition) =>
              definition.role === "model" && definition.scopes.includes(scope),
          )
          .sort((left, right) => compareIdentifiers(left.id, right.id))[0],
      }))
      .filter(
        (
          candidate,
        ): candidate is typeof candidate & {
          definition: PackageSettingDefinition;
        } => candidate.definition !== undefined,
      )
      .sort((left, right) =>
        compareIdentifiers(left.pkg.packageId, right.pkg.packageId),
      );
    if (declarations.length > 1) {
      const names = declarations.map(({ pkg }) => `"${pkg.packageId}"`);
      return {
        conflict:
          "Two plugins are both set as your model. Turn one off in Plugins.",
      };
    }
    const declaration = declarations[0];
    if (!declaration) return undefined;
    const stored =
      scope === "bot"
        ? Object.hasOwn(input.bot.packageValues, declaration.pkg.packageId)
          ? input.bot.packageValues[declaration.pkg.packageId]
          : undefined
        : declaration.installation.values;
    const value = resolvePackageSettingValuesV1(
      declaration.pkg.settings,
      stored,
      scope,
    )[declaration.definition.id];
    return {
      ...(typeof value === "object" && value !== null ? { model: value } : {}),
    };
  };

  for (const scope of ["bot", "user"] as const) {
    const resolved = fromScope(scope);
    if (resolved?.conflict) {
      return {
        source: scope === "bot" ? "bot" : "account",
        binding: { state: "unavailable", failure: resolved.conflict },
      };
    }
    if (resolved?.model) {
      return {
        source: scope === "bot" ? "bot" : "account",
        model: structuredClone(resolved.model),
        binding: resolveBotModelBindingV1({
          model: resolved.model,
          user: input.user,
          packages: input.packages,
        }),
      };
    }
  }

  const model = input.user.platformModel;
  if (!model) return { source: "none" };
  return {
    source: "platform",
    model: structuredClone(model),
    binding: resolveBotModelBindingV1({
      model,
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
  const capabilities = input.user.packages.flatMap((installation) => {
    if (installation.state !== "installed") return [];
    const pkg = input.packages.find(
      (candidate) =>
        candidate.packageId === installation.packageId &&
        candidate.version === installation.version,
    );
    if (!pkg) return [];
    return pkg.capabilities.flatMap((capability): EnabledCapabilityV1[] => {
      const base = {
        packageId: pkg.packageId,
        capabilityId: capability.id,
        kind: capability.kind,
      };
      if (capability.connectionTypes.length === 0) return [base];
      return input.user.connections
        .filter((connection) => {
          if (
            connection.packageId !== pkg.packageId ||
            connection.state !== "ready" ||
            !capability.connectionTypes.includes(connection.connectionTypeId)
          ) {
            return false;
          }
          return pkg.connectionTypes
            .find((candidate) => candidate.id === connection.connectionTypeId)
            ?.capabilities.includes(capability.id);
        })
        .map((connection) => ({
          ...base,
          connectionId: connection.connectionId,
        }));
    });
  });
  capabilities.sort(
    (left, right) =>
      compareIdentifiers(left.packageId, right.packageId) ||
      compareIdentifiers(left.capabilityId, right.capabilityId) ||
      compareIdentifiers(left.connectionId ?? "", right.connectionId ?? ""),
  );
  const effective = resolveEffectiveBotModelV1(input);
  return {
    schemaVersion: 1,
    botId: input.bot.botId,
    revision: input.bot.revision,
    ...(effective.model ? { model: structuredClone(effective.model) } : {}),
    capabilities,
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
  const candidate = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ConfigurationDecodeError(`${label} must be a plain object`);
  }
  for (const key in candidate) {
    if (!Object.hasOwn(candidate, key)) {
      throw new ConfigurationDecodeError(`${label} has inherited fields`);
    }
  }
  return candidate;
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

const BOT_PROFILE_OPTIONAL_FIELDS = [
  "label",
  "description",
  "title",
  "namedBy",
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
    ["name", "label", "description", "title", "hiddenFromSidebar"],
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
 * empty string clears an optional text field. `namedBy` is recorded only when
 * the name actually changes, so
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
    case "user/set-platform-model": {
      const command = exactCommand(input, ["model"]);
      return {
        ...commandMeta(command),
        type: value.type,
        model: decodeModelBindingV1(command.model),
      };
    }
    case "user/install-package": {
      const command = exactCommand(
        input,
        ["packageId", "version"],
        ["catalogId", "catalogGeneration", "contentHash", "values", "enabled"],
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
      if (
        command.catalogId === undefined &&
        command.contentHash !== undefined
      ) {
        throw new ConfigurationDecodeError(
          "install contentHash requires a Catalog entry",
        );
      }
      if (
        command.enabled !== undefined &&
        typeof command.enabled !== "boolean"
      ) {
        throw new ConfigurationDecodeError("enabled is invalid");
      }
      return {
        ...commandMeta(command),
        type: value.type,
        packageId: identifier(command.packageId, "packageId"),
        version: text(command.version, "version", 100),
        ...(command.enabled === undefined ? {} : { enabled: command.enabled }),
        ...(command.catalogId === undefined
          ? {}
          : {
              catalogId: identifier(command.catalogId, "catalogId"),
              catalogGeneration: identifier(
                command.catalogGeneration,
                "catalogGeneration",
              ),
              ...(command.contentHash === undefined
                ? {}
                : {
                    contentHash: compositionHash(
                      command.contentHash,
                      "contentHash",
                    ),
                  }),
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
      const command = exactCommand(input, ["packageId"], ["values", "unset"]);
      const values =
        command.values === undefined
          ? undefined
          : packageSettingsPatch(command.values);
      const unset =
        command.unset === undefined
          ? undefined
          : packageSettingIds(command.unset);
      requirePackageSettingsChange(values, unset);
      return {
        ...commandMeta(command),
        type: value.type,
        packageId: identifier(command.packageId, "packageId"),
        ...(values ? { values } : {}),
        ...(unset ? { unset } : {}),
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
    case "bot/set-package-settings": {
      const command = exactCommand(
        input,
        ["botId", "packageId"],
        ["values", "unset"],
      );
      const values =
        command.values === undefined
          ? undefined
          : packageSettingsPatch(command.values);
      const unset =
        command.unset === undefined
          ? undefined
          : packageSettingIds(command.unset);
      requirePackageSettingsChange(values, unset);
      return {
        ...commandMeta(command),
        type: value.type,
        botId: identifier(command.botId, "botId"),
        packageId: identifier(command.packageId, "packageId"),
        ...(values ? { values } : {}),
        ...(unset ? { unset } : {}),
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
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" &&
            (!/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= value.length ||
              !Object.getOwnPropertyDescriptor(value, key)?.enumerable)),
      ) ||
      Array.from({ length: value.length }, (_item, index) => index).some(
        (index) => !Object.hasOwn(value, index),
      )
    ) {
      throw new ConfigurationDecodeError(`${label} is not plain JSON`);
    }
    return value.map((item) => safeJsonValue(item, label));
  }
  if (typeof value === "object" && value !== null) {
    const object = record(value, label);
    if (
      Reflect.ownKeys(object).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return (
          typeof key !== "string" ||
          !descriptor ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        );
      })
    ) {
      throw new ConfigurationDecodeError(`${label} is not plain JSON`);
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [
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
 * Only the shape: ids are identifiers, ordinary values are scalars, the model
 * role may carry its exact binding object, and the bag is bounded. Whether a
 * named setting exists, and whether its value satisfies the schema the Package
 * declared, is the owning Durable Object's answer — it validates against the
 * installed version through `decodeInstalledPackageSettingsPatchV1`.
 */
function packageSettingsPatch(
  value: unknown,
): Record<string, PackageSettingValueV1> {
  const values = record(value, "values");
  if (
    Reflect.ownKeys(values).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(values, key);
      return (
        typeof key !== "string" ||
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      );
    })
  ) {
    throw new ConfigurationDecodeError("values has invalid fields");
  }
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new ConfigurationDecodeError("values names no setting");
  }
  if (entries.length > MAX_PACKAGE_SETTINGS_V1) {
    throw new ConfigurationDecodeError("values is too large");
  }
  return Object.fromEntries(
    entries.map(([key, item]) => {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        return [identifier(key, "values key"), decodeModelBindingV1(item)];
      }
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

function packageSettingIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationDecodeError("unset names no setting");
  }
  if (value.length > MAX_PACKAGE_SETTINGS_V1) {
    throw new ConfigurationDecodeError("unset is too large");
  }
  const decoded = value.map((item) => identifier(item, "unset setting id"));
  if (new Set(decoded).size !== decoded.length) {
    throw new ConfigurationDecodeError("unset repeats a setting");
  }
  return decoded;
}

function requirePackageSettingsChange(
  values: Record<string, PackageSettingValueV1> | undefined,
  unset: readonly string[] | undefined,
): void {
  if (!values && !unset) {
    throw new ConfigurationDecodeError("Package settings command is empty");
  }
  if (values && unset?.some((settingId) => Object.hasOwn(values, settingId))) {
    throw new ConfigurationDecodeError(
      "Package settings command both sets and unsets a setting",
    );
  }
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
    [
      "failure",
      "catalogId",
      "catalogGeneration",
      "contentHash",
      "provenance",
      "values",
    ],
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
    ...(installation.contentHash === undefined
      ? {}
      : {
          contentHash: compositionHash(installation.contentHash, "contentHash"),
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

function schemaVersion(value: Record<string, unknown>): void {
  if (value.schemaVersion !== 1) {
    throw new ConfigurationDecodeError("unsupported configuration schema");
  }
}

function storedPlainRecordV1(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function storedDataValueV1(
  value: Record<string, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function cloneStoredRecordV1(
  value: Record<string, unknown>,
  changes: Readonly<Record<string, unknown>>,
  removed: readonly string[] = [],
): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of removed) delete descriptors[key];
  for (const [key, next] of Object.entries(changes)) {
    const descriptor = descriptors[key];
    descriptors[key] =
      descriptor && "value" in descriptor
        ? { ...descriptor, value: next }
        : {
            configurable: true,
            enumerable: true,
            value: next,
            writable: true,
          };
  }
  return Object.create(Object.getPrototypeOf(value), descriptors) as Record<
    string,
    unknown
  >;
}

const PRE_ACCOUNT_WIDE_USER_FIELDS_V1 = [
  "newBotModelTemplate",
  "newBotModelTemplateSource",
] as const;
const PRE_ACCOUNT_WIDE_CONNECTION_METADATA_FIELDS_V1 = [
  "dependentAssignments",
] as const;

/**
 * The immutable Package facts the stored User-settings migration needs. The
 * migration deliberately knows no Package names: absence from this Catalog is
 * what retires an installation, and these dependency edges are what identify
 * an enablement state an older writer could not have represented safely.
 */
export interface StoredUserSettingsPackageV1 {
  packageId: string;
  version: string;
  dependencies?: Readonly<Record<string, string>>;
  /** Platform infrastructure is repaired to one enabled first-party row. */
  platformOwned?: boolean;
}

/**
 * How much of the Catalog-relative pass a reader may apply.
 *
 * `migrate` is the one-shot marker upgrade: it retires installations absent
 * from the Catalog, drops their orphaned Connections, disables dependents whose
 * dependency is not enabled, and clears a platform binding that no longer
 * resolves. `repair` runs on every read and touches only platform-owned rows,
 * because a deployment that temporarily omits a Package must not erase current
 * durable state, and a User disabling one Package must not silently disable
 * another that merely declares it as a dependency.
 */
export type StoredUserSettingsMigrationScopeV1 = "migrate" | "repair";

function migrateCatalogRelativeUserSettingsV1(
  settings: Record<string, unknown>,
  packages: readonly StoredUserSettingsPackageV1[],
  scope: StoredUserSettingsMigrationScopeV1,
): Record<string, unknown> {
  const migrate = scope === "migrate";
  const availableVersions = new Map(
    packages.map((pkg) => [`${pkg.packageId}\u0000${pkg.version}`, pkg]),
  );
  const availablePackageIds = new Set(packages.map((pkg) => pkg.packageId));
  const storedPackages = storedDataValueV1(settings, "packages");
  const storedConnections = storedDataValueV1(settings, "connections");
  if (!Array.isArray(storedPackages) || !Array.isArray(storedConnections)) {
    return settings;
  }

  let changed = false;
  const retiredFirstPartyPackageIds = new Set<string>();
  let installations = storedPackages.filter((storedInstallation) => {
    const installation = storedPlainRecordV1(storedInstallation);
    if (!installation) return true;
    const packageId = storedDataValueV1(installation, "packageId");
    const version = storedDataValueV1(installation, "version");
    const provenance = storedDataValueV1(installation, "provenance");
    if (typeof packageId !== "string" || typeof version !== "string") {
      return true;
    }
    // The facts supplied here are the running application's first-party
    // Catalog. Remote Catalog installations have a separate pinned authority
    // and must never be inferred retired from absence here.
    if (provenance === "catalog") return true;
    // A different immutable version remains a visible, repairable Catalog
    // mismatch. Only an id absent from the Catalog proves that the Package was
    // retired and that its row is now orphaned durable state.
    const retained = !migrate || availablePackageIds.has(packageId);
    if (!retained) retiredFirstPartyPackageIds.add(packageId);
    changed ||= !retained;
    return retained;
  });

  // Platform infrastructure is not a User preference. Repair it on every
  // catalog-relative read, including records that already carry the latest
  // one-shot bootstrap marker, and collapse any duplicate rows to one current
  // first-party installation.
  const platformPackages = new Map(
    packages
      .filter((pkg) => pkg.platformOwned)
      .map((pkg) => [pkg.packageId, pkg]),
  );
  const repairedPlatformPackageIds = new Set<string>();
  installations = installations.flatMap((storedInstallation) => {
    const installation = storedPlainRecordV1(storedInstallation);
    const packageId = installation
      ? storedDataValueV1(installation, "packageId")
      : undefined;
    const platformPackage =
      typeof packageId === "string"
        ? platformPackages.get(packageId)
        : undefined;
    if (!installation || !platformPackage) return [storedInstallation];
    if (repairedPlatformPackageIds.has(platformPackage.packageId)) {
      changed = true;
      return [];
    }
    repairedPlatformPackageIds.add(platformPackage.packageId);
    const needsRepair =
      storedDataValueV1(installation, "version") !== platformPackage.version ||
      storedDataValueV1(installation, "state") !== "installed" ||
      storedDataValueV1(installation, "provenance") !== "first-party" ||
      storedDataValueV1(installation, "failure") !== undefined ||
      Object.hasOwn(installation, "catalogId") ||
      Object.hasOwn(installation, "catalogGeneration") ||
      Object.hasOwn(installation, "contentHash");
    if (!needsRepair) return [storedInstallation];
    changed = true;
    return [
      cloneStoredRecordV1(
        installation,
        {
          version: platformPackage.version,
          state: "installed",
          provenance: "first-party",
        },
        ["failure", "catalogId", "catalogGeneration", "contentHash"],
      ),
    ];
  });
  for (const platformPackage of platformPackages.values()) {
    if (repairedPlatformPackageIds.has(platformPackage.packageId)) continue;
    changed = true;
    installations.push({
      packageId: platformPackage.packageId,
      version: platformPackage.version,
      state: "installed",
      provenance: "first-party",
    });
  }

  // Disable inconsistent installed dependents to the least-authority state.
  // Iterate to a fixed point so A -> B -> missing C leaves both A and B off.
  while (migrate) {
    const enabledIds = new Set(
      installations.flatMap((storedInstallation) => {
        const installation = storedPlainRecordV1(storedInstallation);
        const packageId = installation
          ? storedDataValueV1(installation, "packageId")
          : undefined;
        return typeof packageId === "string" &&
          storedDataValueV1(installation!, "state") === "installed"
          ? [packageId]
          : [];
      }),
    );
    let disabledInPass = false;
    installations = installations.map((storedInstallation) => {
      const installation = storedPlainRecordV1(storedInstallation);
      if (
        !installation ||
        storedDataValueV1(installation, "state") !== "installed"
      ) {
        return storedInstallation;
      }
      const packageId = storedDataValueV1(installation, "packageId");
      const version = storedDataValueV1(installation, "version");
      if (typeof packageId !== "string" || typeof version !== "string") {
        return storedInstallation;
      }
      const pkg = availableVersions.get(`${packageId}\u0000${version}`);
      if (
        !pkg ||
        Object.keys(pkg.dependencies ?? {}).every((id) => enabledIds.has(id))
      ) {
        return storedInstallation;
      }
      changed = true;
      disabledInPass = true;
      return cloneStoredRecordV1(installation, {
        state: "disabled",
        failure: undefined,
      });
    });
    if (!disabledInPass) break;
  }

  const connections = storedConnections.filter((storedConnection) => {
    const connection = storedPlainRecordV1(storedConnection);
    if (!connection) return true;
    const packageId = storedDataValueV1(connection, "packageId");
    if (typeof packageId !== "string") return true;
    // Connections ordinarily outlive uninstalls. This one is removed only
    // because the migration retired its first-party owning installation in
    // the same pass, which is the evidence that it is the requested orphan.
    const retained = !retiredFirstPartyPackageIds.has(packageId);
    changed ||= !retained;
    return retained;
  });

  let platformModel = storedDataValueV1(settings, "platformModel");
  if (migrate && platformModel !== undefined) {
    let binding: ModelBindingV1 | undefined;
    try {
      binding = decodeModelBindingV1(platformModel);
    } catch {
      // This migration only repairs a valid old binding that is unavailable
      // against the current Catalog. Malformed current data must still reach
      // the exact decoder and fail visibly instead of being laundered away.
    }
    const connectionId = binding?.connectionId;
    const connection =
      typeof connectionId === "string"
        ? connections.find((storedConnection) => {
            const candidate = storedPlainRecordV1(storedConnection);
            return (
              candidate &&
              storedDataValueV1(candidate, "connectionId") === connectionId
            );
          })
        : undefined;
    const connectionRecord = storedPlainRecordV1(connection);
    const ownerId = connectionRecord
      ? storedDataValueV1(connectionRecord, "packageId")
      : undefined;
    const owner =
      typeof ownerId === "string"
        ? installations.find((storedInstallation) => {
            const candidate = storedPlainRecordV1(storedInstallation);
            return (
              candidate &&
              storedDataValueV1(candidate, "packageId") === ownerId &&
              storedDataValueV1(candidate, "state") === "installed"
            );
          })
        : undefined;
    const ownerRecord = storedPlainRecordV1(owner);
    const ownerVersion = ownerRecord
      ? storedDataValueV1(ownerRecord, "version")
      : undefined;
    const resolvable =
      connectionRecord !== undefined &&
      storedDataValueV1(connectionRecord, "state") === "ready" &&
      typeof ownerId === "string" &&
      typeof ownerVersion === "string" &&
      availableVersions.has(`${ownerId}\u0000${ownerVersion}`);
    if (binding && !resolvable) {
      changed = true;
      platformModel = undefined;
    }
  }

  if (!changed) return settings;
  return cloneStoredRecordV1(
    settings,
    { packages: installations, connections },
    platformModel === undefined && Object.hasOwn(settings, "platformModel")
      ? ["platformModel"]
      : [],
  );
}

/**
 * Migrates one raw User settings record across known durable shapes before the
 * current exact-field decoder sees it. Commit 1571b62 removed the model
 * template and commit d6730ad removed the Connection dependency ledger along
 * with the Assignment feature; migration drops those fields without
 * interpreting them.
 */
export function migrateStoredUserSettingsV1(
  stored: unknown,
  packages?: readonly StoredUserSettingsPackageV1[],
  scope: StoredUserSettingsMigrationScopeV1 = "migrate",
): unknown {
  const settings = storedPlainRecordV1(stored);
  if (!settings || storedDataValueV1(settings, "schemaVersion") !== 1) {
    return stored;
  }

  let changed = false;
  const removedSettingsFields = PRE_ACCOUNT_WIDE_USER_FIELDS_V1.filter((key) =>
    Object.hasOwn(settings, key),
  );
  changed ||= removedSettingsFields.length > 0;

  const storedConnections = storedDataValueV1(settings, "connections");
  let connections = storedConnections;
  if (Array.isArray(storedConnections)) {
    let connectionsChanged = false;
    const nextConnections = storedConnections.map((storedConnection) => {
      const connection = storedPlainRecordV1(storedConnection);
      if (!connection) return storedConnection;
      const storedMetadata = storedDataValueV1(connection, "safeMetadata");
      const metadata = storedPlainRecordV1(storedMetadata);
      if (!metadata) return storedConnection;
      const removedMetadataFields =
        PRE_ACCOUNT_WIDE_CONNECTION_METADATA_FIELDS_V1.filter((key) =>
          Object.hasOwn(metadata, key),
        );
      if (removedMetadataFields.length === 0) return storedConnection;
      connectionsChanged = true;
      const safeMetadata = cloneStoredRecordV1(
        metadata,
        {},
        removedMetadataFields,
      );
      return cloneStoredRecordV1(connection, { safeMetadata });
    });
    if (connectionsChanged) {
      changed = true;
      connections = nextConnections;
    }
  }

  const migrated = changed
    ? cloneStoredRecordV1(
        settings,
        connections === storedConnections ? {} : { connections },
        removedSettingsFields,
      )
    : settings;
  return packages
    ? migrateCatalogRelativeUserSettingsV1(migrated, packages, scope)
    : migrated;
}

export function decodeUserSettingsViewV1(input: unknown): UserSettingsViewV1 {
  const value = exactRecord(
    input,
    "User settings",
    ["schemaVersion", "revision", "profile", "packages", "connections"],
    ["platformModel", "catalogGeneration", "catalogIndexHash"],
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
    ...(value.platformModel === undefined
      ? {}
      : { platformModel: decodeModelBindingV1(value.platformModel) }),
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

function packageValueBags(
  input: unknown,
): Record<string, Record<string, unknown>> {
  const packages = record(input, "packageValues");
  if (
    Reflect.ownKeys(packages).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(packages, key);
      return (
        typeof key !== "string" ||
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      );
    })
  ) {
    throw new ConfigurationDecodeError("packageValues has invalid fields");
  }
  return Object.fromEntries(
    Object.entries(packages).map(([packageId, stored]) => {
      identifier(packageId, "packageValues packageId");
      const values = record(stored, `packageValues.${packageId}`);
      if (
        Reflect.ownKeys(values).length > MAX_PACKAGE_SETTINGS_V1 ||
        Reflect.ownKeys(values).some((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(values, key);
          return (
            typeof key !== "string" ||
            !descriptor ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          );
        })
      ) {
        throw new ConfigurationDecodeError(
          `packageValues.${packageId} has invalid fields`,
        );
      }
      return [
        packageId,
        Object.fromEntries(
          Object.entries(values).map(([settingId, value]) => [
            identifier(settingId, "packageValues settingId"),
            safeJsonValue(value, `packageValues.${packageId}.${settingId}`),
          ]),
        ),
      ];
    }),
  );
}

export function decodeBotSettingsViewV1(input: unknown): BotSettingsViewV1 {
  const value = exactRecord(input, "Bot settings", [
    "schemaVersion",
    "botId",
    "revision",
    "profile",
    "notifications",
    "packageValues",
  ]);
  schemaVersion(value);
  return {
    schemaVersion: 1,
    botId: identifier(value.botId, "botId"),
    revision: viewRevision(value.revision),
    profile: botProfile(value.profile),
    notifications: notifications(value.notifications),
    packageValues: packageValueBags(value.packageValues),
  };
}

const PRE_ACCOUNT_WIDE_BOT_FIELDS_V1 = [
  "assignments",
  "assignmentOperations",
  "model",
  // Some pre-release records used this name for the same removed feature.
  "modelAssignment",
] as const;

/**
 * Migrates one raw Bot settings record across known durable shapes before the
 * current exact-field decoder sees it. The removed Assignment/model fields are
 * discarded; their presence identifies the shape that predates packageValues.
 */
export function migrateStoredBotSettingsV1(stored: unknown): unknown {
  const settings = storedPlainRecordV1(stored);
  if (!settings || storedDataValueV1(settings, "schemaVersion") !== 1) {
    return stored;
  }
  const removed = PRE_ACCOUNT_WIDE_BOT_FIELDS_V1.filter((key) =>
    Object.hasOwn(settings, key),
  );
  if (removed.length === 0) return stored;
  return cloneStoredRecordV1(
    settings,
    Object.hasOwn(settings, "packageValues") ? {} : { packageValues: {} },
    removed,
  );
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
  | {
      kind: "catalog";
      catalogId: string;
      catalogGeneration: string;
    }
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
  | { kind: "revert"; revertsTo: string; userId: string }
  | {
      kind: "revert";
      revertsTo: string;
      botId: string;
      runId: string;
      turnId: string;
    };

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
  if (kind === "catalog") {
    const value = exactRecord(input, "Composition provenance", [
      "kind",
      "catalogId",
      "catalogGeneration",
    ]);
    return {
      kind: "catalog",
      catalogId: identifier(
        value.catalogId,
        "Composition provenance catalogId",
      ),
      catalogGeneration: text(
        value.catalogGeneration,
        "Composition provenance catalogGeneration",
        256,
      ),
    };
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
    const value = record(input, "Composition origin");
    const revertsTo = decodeCompositionGenerationIdV1(
      value.revertsTo,
      "Composition origin revertsTo",
    );
    if (Object.hasOwn(value, "userId")) {
      exactRecord(input, "Composition origin", ["kind", "revertsTo", "userId"]);
      return {
        kind: "revert",
        revertsTo,
        userId: text(value.userId, "Composition origin userId", 256),
      };
    }
    const bot = exactRecord(input, "Composition origin", [
      "kind",
      "revertsTo",
      "botId",
      "runId",
      "turnId",
    ]);
    return {
      kind: "revert",
      revertsTo,
      botId: decodeBotIdV1(bot.botId),
      runId: text(bot.runId, "Composition origin runId", 128),
      turnId: text(bot.turnId, "Composition origin turnId", 128),
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

// One Turn's prepared inputs: references and data, not a mounted runtime.
//
// Account configuration, features and Composition are one User Durable Object.
// Bot settings, Plugin enablement and the working-context head are the Bot's.
// Admission reads them together, retries a bounded number of times when a
// semantically relevant revision moves, and stores the value on the run. A
// queued or recovered Turn restores that value. A later revocation is not
// frozen into it: use still checks the Connection's current state.

import { createConcurrencyLimiterV1 } from "@frockbot/core/concurrency";
import {
  decodeBotSettingsViewV1,
  decodeUserSettingsViewV1,
  migrateStoredBotSettingsV1,
  migrateStoredUserSettingsV1,
  type BotSettingsViewV1,
  type ConnectionView,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";
import {
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import {
  decodeUserFeaturesV1,
  type UserFeaturesV1,
} from "@frockbot/app/admin/shared";
import type { UserCompositionSnapshotV1 } from "@frockbot/app/composition/user";
import { botMemoryRootV1, userMemoryRootV1 } from "@frockbot/app/memory/roots";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  enabledSeededPluginIdsV1,
} from "@frockbot/app/plugins/catalog";
import {
  decodePluginEnablementV1,
  type PluginEnablementV1,
} from "@frockbot/app/plugins/enablement";
import type { PluginSkillContributionV1 } from "@frockbot/app/skills/plugin";
import type { PluginSkillV1 } from "@frockbot/core/contracts";

/** How many times admission may re-read before it reports the account busy. */
export const PREPARATION_ATTEMPTS_V1 = 3;

/** The largest prepared-input value a run record will carry. */
export const PREPARATION_MAX_BYTES_V1 = 512_000;

const MAX_ID_BYTES = 128;
const MAX_SKILL_INDEXES_V1 = 300;
const MAX_MEMORY_CORES_V1 = 8;

export class PreparationConflictError extends Error {
  constructor(readonly field: string) {
    super(`preparation changed (${field})`);
    this.name = "PreparationConflictError";
  }
}

export class PreparationUnavailableError extends Error {
  constructor() {
    super("Account preparation changed before this Turn could be admitted.");
    this.name = "PreparationUnavailableError";
  }
}

export interface PreparedConnectionRefV1 {
  connectionId: string;
  packageId: string;
  generation: string;
  state: ConnectionView["state"];
  catalogGeneration?: string;
  safeMetadata: Record<string, unknown>;
}

export interface PreparedSkillIndexRefV1 {
  source: "plugin" | "bot" | "user";
  id: string;
  /** Content hash of a mounted Plugin artifact. Empty until a workspace index is published. */
  revision: string;
}

export interface PreparedMemoryCoreRefV1 {
  scope: "user" | "bot";
  root: string;
}

export interface PreparedTurnInputsV1 {
  schemaVersion: 1;
  identity: { userId: string; botId: string };
  account: {
    revision: number;
    settings: UserSettingsViewV1;
    features: UserFeaturesV1;
  };
  bot: {
    revision: number;
    pluginEnablementRevision: number;
    enablement: PluginEnablementV1;
    settings: BotSettingsViewV1;
  };
  composition: {
    requestedGenerationId: string;
    mountedGenerationId: string;
  };
  connections: PreparedConnectionRefV1[];
  skills: { indexes: PreparedSkillIndexRefV1[] };
  context: { revision: number; sequence: number };
  memory: { cores: PreparedMemoryCoreRefV1[] };
}

export interface AccountPreparationV1 {
  schemaVersion: 1;
  settings: UserSettingsViewV1;
  features: UserFeaturesV1;
  composition?: UserCompositionSnapshotV1;
}

export interface AccountPreparationStampV1 {
  schemaVersion: 1;
  revision: number;
  features: {
    applets: boolean;
    pluginAuthoring: boolean;
    plugins: string[];
  };
  compositionGenerationId: string;
}

export interface BotLocalPreparationV1 {
  settings: BotSettingsViewV1;
  enablement: PluginEnablementV1;
  contextRevision: number;
  contextSequence: number;
}

export interface PreparationPortsV1 {
  readAccount(): Promise<AccountPreparationV1>;
  readAccountStamp(): Promise<AccountPreparationStampV1>;
  readBot(): Promise<BotLocalPreparationV1>;
  readBotStamp(): Promise<{
    settingsRevision: number;
    pluginEnablementRevision: number;
    compositionGenerationId: string;
  }>;
  adoptComposition(snapshot: UserCompositionSnapshotV1): Promise<void>;
  /** Materialize the Bot mirror and return the generation admission will pin. */
  ensureComposition(): Promise<CompositionGenerationV1>;
}

const CONNECTION_STATES = new Set<ConnectionView["state"]>([
  "authorizing",
  "ready",
  "disabled",
  "revoking",
  "revoked",
  "reconciliation-required",
  "failed",
]);

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_BYTES
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function featureKey(features: {
  applets: boolean;
  pluginAuthoring: boolean;
  plugins: readonly string[];
}): string {
  return `${features.applets ? 1 : 0}:${features.pluginAuthoring ? 1 : 0}:${[...features.plugins].sort().join(",")}`;
}

export function preparedConnectionRefsV1(
  settings: UserSettingsViewV1,
): PreparedConnectionRefV1[] {
  return settings.connections.map((connection) => ({
    connectionId: connection.connectionId,
    packageId: connection.packageId,
    generation: connection.generation ?? "",
    state: connection.state,
    ...(connection.modelCatalog
      ? { catalogGeneration: connection.modelCatalog.generation }
      : {}),
    safeMetadata: structuredClone(connection.safeMetadata) as Record<
      string,
      unknown
    >,
  }));
}

/**
 * Plugin Skill documents from one Composition generation.
 *
 * The generation argument is the one activation is mounting, including a
 * fail-closed fallback. A newer generation's artifact is not consulted.
 */
export function pluginSkillsFromMembersV1(
  members: readonly CompositionMemberV1[],
  enablement: PluginEnablementV1,
): PluginSkillContributionV1[] {
  const enabled = new Set(
    enabledSeededPluginIdsV1(members, enablement, DEPLOYMENT_PLUGIN_CATALOG_V1),
  );
  return members.flatMap((member) => {
    const skills = member.descriptor.skills;
    if (!enabled.has(member.packageId) || !skills || skills.length === 0) {
      return [];
    }
    return [
      {
        pluginId: member.packageId,
        displayName: member.descriptor.displayName,
        skills,
      },
    ];
  });
}

export function preparedSkillIndexesV1(
  members: readonly CompositionMemberV1[],
  enablement: PluginEnablementV1,
  identity: { userId: string; botId: string },
): PreparedSkillIndexRefV1[] {
  const enabled = new Set(
    enabledSeededPluginIdsV1(members, enablement, DEPLOYMENT_PLUGIN_CATALOG_V1),
  );
  const plugins = members.flatMap((member): PreparedSkillIndexRefV1[] => {
    const skills = member.descriptor.skills;
    if (!enabled.has(member.packageId) || !skills || skills.length === 0) {
      return [];
    }
    return [
      {
        source: "plugin",
        id: member.packageId,
        revision: member.artifact.contentHash,
      },
    ];
  });
  return [
    ...plugins,
    { source: "bot", id: identity.botId, revision: "" },
    { source: "user", id: identity.userId, revision: "" },
  ];
}

export function preparedMemoryCoresV1(identity: {
  userId: string;
  botId: string;
}): PreparedMemoryCoreRefV1[] {
  return [
    {
      scope: "user",
      root: JSON.stringify(userMemoryRootV1(identity)),
    },
    {
      scope: "bot",
      root: JSON.stringify(botMemoryRootV1(identity)),
    },
  ];
}

function decodeConnectionRef(value: unknown): PreparedConnectionRefV1 {
  const record = plainRecord(value, "prepared connection");
  const state = record.state;
  if (
    typeof state !== "string" ||
    !CONNECTION_STATES.has(state as ConnectionView["state"])
  ) {
    throw new Error("prepared connection state is invalid");
  }
  const metadata = plainRecord(
    record.safeMetadata ?? {},
    "prepared connection metadata",
  );
  return {
    connectionId: boundedId(record.connectionId, "connectionId"),
    packageId: boundedId(record.packageId, "packageId"),
    generation: typeof record.generation === "string" ? record.generation : "",
    state: state as ConnectionView["state"],
    ...(typeof record.catalogGeneration === "string"
      ? { catalogGeneration: record.catalogGeneration }
      : {}),
    safeMetadata: metadata,
  };
}

function decodeSkillIndex(value: unknown): PreparedSkillIndexRefV1 {
  const record = plainRecord(value, "prepared skill index");
  const source = record.source;
  if (source !== "plugin" && source !== "bot" && source !== "user") {
    throw new Error("prepared skill index source is invalid");
  }
  if (typeof record.revision !== "string" || record.revision.length > 128) {
    throw new Error("prepared skill index revision is invalid");
  }
  return {
    source,
    id: boundedId(record.id, "skill index id"),
    revision: record.revision,
  };
}

function decodeMemoryCore(value: unknown): PreparedMemoryCoreRefV1 {
  const record = plainRecord(value, "prepared memory core");
  if (record.scope !== "user" && record.scope !== "bot") {
    throw new Error("prepared memory core scope is invalid");
  }
  if (
    typeof record.root !== "string" ||
    record.root.length === 0 ||
    record.root.length > 512
  ) {
    throw new Error("prepared memory core root is invalid");
  }
  return { scope: record.scope, root: record.root };
}

export function decodeAccountPreparationV1(
  input: unknown,
): AccountPreparationV1 {
  const record = plainRecord(input, "account preparation");
  if (record.schemaVersion !== 1) {
    throw new Error("account preparation schemaVersion is unsupported");
  }
  const settings = decodeUserSettingsViewV1(
    migrateStoredUserSettingsV1(record.settings),
  );
  const features = decodeUserFeaturesV1(record.features);
  let composition: UserCompositionSnapshotV1 | undefined;
  if (record.composition !== undefined) {
    const snapshot = plainRecord(record.composition, "account composition");
    composition = {
      current: decodeCompositionGenerationV1(snapshot.current),
      lastKnownGood: decodeCompositionGenerationV1(snapshot.lastKnownGood),
    };
  }
  return {
    schemaVersion: 1,
    settings,
    features,
    ...(composition ? { composition } : {}),
  };
}

export function decodeAccountPreparationStampV1(
  input: unknown,
): AccountPreparationStampV1 {
  const record = plainRecord(input, "account preparation stamp");
  if (record.schemaVersion !== 1) {
    throw new Error("account preparation stamp schemaVersion is unsupported");
  }
  const features = plainRecord(record.features, "account preparation features");
  if (!Array.isArray(features.plugins)) {
    throw new Error("account preparation features are invalid");
  }
  return {
    schemaVersion: 1,
    revision: nonNegative(record.revision, "account revision"),
    features: {
      applets: features.applets === true,
      pluginAuthoring: features.pluginAuthoring === true,
      plugins: features.plugins.map((plugin, index) =>
        boundedId(plugin, `plugins[${index}]`),
      ),
    },
    compositionGenerationId:
      typeof record.compositionGenerationId === "string"
        ? record.compositionGenerationId
        : "",
  };
}

export function decodePreparedTurnInputsV1(
  input: unknown,
): PreparedTurnInputsV1 {
  const record = plainRecord(input, "prepared turn inputs");
  const keys = [
    "account",
    "bot",
    "composition",
    "connections",
    "context",
    "identity",
    "memory",
    "schemaVersion",
    "skills",
  ];
  const present = Object.keys(record).sort();
  if (present.join(",") !== keys.join(",")) {
    throw new Error("prepared turn inputs has invalid fields");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("prepared turn inputs schemaVersion is unsupported");
  }
  const identity = plainRecord(record.identity, "prepared identity");
  const account = plainRecord(record.account, "prepared account");
  const bot = plainRecord(record.bot, "prepared bot");
  const composition = plainRecord(record.composition, "prepared composition");
  const skills = plainRecord(record.skills, "prepared skills");
  const context = plainRecord(record.context, "prepared context");
  const memory = plainRecord(record.memory, "prepared memory");
  if (!Array.isArray(record.connections) || record.connections.length > 100) {
    throw new Error("prepared connections are invalid");
  }
  if (
    !Array.isArray(skills.indexes) ||
    skills.indexes.length > MAX_SKILL_INDEXES_V1
  ) {
    throw new Error("prepared skill indexes are invalid");
  }
  if (
    !Array.isArray(memory.cores) ||
    memory.cores.length > MAX_MEMORY_CORES_V1
  ) {
    throw new Error("prepared memory cores are invalid");
  }
  const decoded: PreparedTurnInputsV1 = {
    schemaVersion: 1,
    identity: {
      userId: boundedId(identity.userId, "userId"),
      botId: boundedId(identity.botId, "botId"),
    },
    account: {
      revision: nonNegative(account.revision, "account revision"),
      settings: decodeUserSettingsViewV1(
        migrateStoredUserSettingsV1(account.settings),
      ),
      features: decodeUserFeaturesV1(account.features),
    },
    bot: {
      revision: nonNegative(bot.revision, "bot revision"),
      pluginEnablementRevision: nonNegative(
        bot.pluginEnablementRevision,
        "plugin enablement revision",
      ),
      enablement: decodePluginEnablementV1(bot.enablement),
      settings: decodeBotSettingsViewV1(
        migrateStoredBotSettingsV1(bot.settings),
      ),
    },
    composition: {
      requestedGenerationId: boundedId(
        composition.requestedGenerationId,
        "requestedGenerationId",
      ),
      mountedGenerationId: boundedId(
        composition.mountedGenerationId,
        "mountedGenerationId",
      ),
    },
    connections: record.connections.map(decodeConnectionRef),
    skills: { indexes: skills.indexes.map(decodeSkillIndex) },
    context: {
      revision: nonNegative(context.revision, "context revision"),
      sequence: nonNegative(context.sequence, "context sequence"),
    },
    memory: { cores: memory.cores.map(decodeMemoryCore) },
  };
  assertPreparationBytesV1(decoded);
  return decoded;
}

export function assertPreparationBytesV1(value: PreparedTurnInputsV1): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > PREPARATION_MAX_BYTES_V1) {
    throw new Error(
      `account preparation is ${bytes} bytes, above ${PREPARATION_MAX_BYTES_V1}`,
    );
  }
}

export function clonePreparedTurnInputsV1(
  value: PreparedTurnInputsV1,
): PreparedTurnInputsV1 {
  return decodePreparedTurnInputsV1(structuredClone(value));
}

/**
 * Reads account and Bot preparation concurrently, then confirms the revisions
 * that decide what a Turn mounts. A mismatch throws {@link PreparationConflictError}
 * so the caller can retry. Adoption failure keeps the mirror the Bot already
 * has: a Composition read is not, by itself, a reason to refuse the Turn.
 */
export async function gatherPreparedTurnInputsV1(
  identity: { userId: string; botId: string },
  ports: PreparationPortsV1,
): Promise<PreparedTurnInputsV1> {
  const limit = createConcurrencyLimiterV1();
  const [account, bot] = await Promise.all([
    limit(() => ports.readAccount()),
    limit(() => ports.readBot()),
  ]);
  let adopted = false;
  if (account.composition) {
    try {
      await ports.adoptComposition(account.composition);
      adopted = true;
    } catch {
      adopted = false;
    }
  }
  // Materialize before the stamp. The kernel materializes again inside
  // admission; doing it here means a Bot with no mirror yet still has a
  // generation id to compare, and a failed adopt does not refuse the Turn.
  const ensured = await ports.ensureComposition();
  const generation =
    adopted && account.composition ? account.composition.current : ensured;
  const requestedGenerationId = generation.generationId;
  const [accountStamp, botStamp] = await Promise.all([
    limit(() => ports.readAccountStamp()),
    limit(() => ports.readBotStamp()),
  ]);
  if (accountStamp.revision !== account.settings.revision) {
    throw new PreparationConflictError("account");
  }
  if (featureKey(accountStamp.features) !== featureKey(account.features)) {
    throw new PreparationConflictError("features");
  }
  if (
    adopted &&
    account.composition &&
    accountStamp.compositionGenerationId !==
      account.composition.current.generationId
  ) {
    throw new PreparationConflictError("composition");
  }
  if (botStamp.settingsRevision !== bot.settings.revision) {
    throw new PreparationConflictError("bot");
  }
  if (botStamp.pluginEnablementRevision !== bot.enablement.revision) {
    throw new PreparationConflictError("plugin enablement");
  }
  if (botStamp.compositionGenerationId !== requestedGenerationId) {
    throw new PreparationConflictError("composition");
  }
  const members = generation?.members ?? [];
  const prepared: PreparedTurnInputsV1 = {
    schemaVersion: 1,
    identity: { userId: identity.userId, botId: identity.botId },
    account: {
      revision: account.settings.revision,
      settings: account.settings,
      features: account.features,
    },
    bot: {
      revision: bot.settings.revision,
      pluginEnablementRevision: bot.enablement.revision,
      enablement: bot.enablement,
      settings: bot.settings,
    },
    composition: {
      requestedGenerationId,
      mountedGenerationId: requestedGenerationId,
    },
    connections: preparedConnectionRefsV1(account.settings),
    skills: {
      indexes: preparedSkillIndexesV1(members, bot.enablement, identity),
    },
    context: {
      revision: bot.contextRevision,
      sequence: bot.contextSequence,
    },
    memory: { cores: preparedMemoryCoresV1(identity) },
  };
  return decodePreparedTurnInputsV1(prepared);
}

/**
 * Runs `work` until preparation is stable or the attempt budget is spent.
 * Anything other than a revision conflict propagates immediately.
 */
export async function withStablePreparationV1<T>(
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= PREPARATION_ATTEMPTS_V1; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof PreparationConflictError &&
        attempt < PREPARATION_ATTEMPTS_V1
      ) {
        continue;
      }
      if (error instanceof PreparationConflictError) {
        throw new PreparationUnavailableError();
      }
      throw error;
    }
  }
  throw new PreparationUnavailableError();
}

/** The Skill documents a mounted generation contributes, for tests and the mount. */
export function pluginSkillTextsV1(
  skills: readonly PluginSkillContributionV1[],
): string[] {
  return skills.flatMap((contribution) =>
    contribution.skills.map((skill: PluginSkillV1) => skill.text),
  );
}

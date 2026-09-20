// A Bot's own configuration, inside its Durable Object: the stored settings,
// the idempotent command that changes them, the User Durable Object RPC every
// Bot-side read of account-shaped configuration goes through, and the execution
// plan a Turn is admitted under.

import {
  applyBotProfilePatchV1,
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeBotSettingsViewV1,
  decodeOperationReceiptV1,
  decodeInstalledPackageSettingIdsV1,
  decodeInstalledPackageSettingsPatchV1,
  decodeUserSettingsViewV1,
  initializeBotSettingsV1,
  migrateStoredBotSettingsV1,
  resolveBotExecutionPlanV1,
  type BotExecutionPlanV1,
  type BotSelfWriterV1,
  type BotSettingsViewV1,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";
import {
  decodeCredentialLeaseV1,
  type CredentialLeaseV1,
} from "@frockbot/core/connection";
import { IDENTITY_KEY, type BotIdentity } from "@frockbot/core/durable";
import {
  decodeUserFeaturesV1,
  type UserFeaturesV1,
} from "@frockbot/app/admin/shared";
import { appletRpcSnapshotV1 } from "@frockbot/app/applets-host/records";
import {
  decodeDirectoryViewV1,
  decodeFlockReceiptV1,
  decodeVoiceIdentityViewV1,
  type BotDirectoryViewV1,
  type BotLookV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
  type ThemeDocumentV1,
  type UpdateVoiceCommandV1,
  type VoiceIdentityViewV1,
} from "@frockbot/app/flock/shared";
import {
  decodeTemplateShareReceiptV1,
  type TemplateCommandV1,
  type TemplateShareReceiptV1,
} from "@frockbot/app/bot-template/shared";
import {
  decodeMachineDispatchAnswerV1,
  type MachineDispatchAnswerV1,
} from "@frockbot/app/machine/approval";
import {
  decodeMachineTargetViewV1,
  type MachineTargetViewV1,
} from "@frockbot/app/machine/target";
import {
  decodeMachineListViewV1,
  decodeMachineCommandResultV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
  type MachineListViewV1,
} from "@frockbot/core/machine-protocol";
import {
  appendAnnouncement,
  type BotAnnouncementTransaction,
} from "@frockbot/app/shell/reads";
import {
  executionPackagesV1,
  type ShellBotStateV1,
} from "@frockbot/app/shell/backend-state";
import {
  requireMatchingConfigurationReceiptV1,
  type StoredConfigurationReceiptV1,
} from "./shared.js";

/** The Bot Durable Object key holding this Bot's durable configuration. */
export const BOT_CONFIGURATION_KEY = "bot-configuration";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";

const HIDDEN_BOT_NOTIFICATIONS_FAILURE =
  "A Bot hidden from the sidebar can’t send notifications. Show it in the sidebar first.";

/**
 * A Bot hidden from the sidebar never alerts. Unread state is untouched: the
 * mute changes whether a message wakes a device, not whether it counts.
 */
function hiddenBotSettingsV1(settings: BotSettingsViewV1): BotSettingsViewV1 {
  return settings.profile.hiddenFromSidebar === true &&
    settings.notifications.enabled
    ? { ...settings, notifications: { enabled: false } }
    : settings;
}

/** One configuration command in flight on this object, for in-memory dedupe. */
export interface ConfigurationActivityV1 {
  commandFingerprint: string;
  promise: Promise<OperationReceiptV1>;
}

/** This Bot's settings as stored. A Bot that was never materialized has none. */
export async function readBotSettingsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<BotSettingsViewV1> {
  await state.authority.validateIdentity(identity);
  const stored = await state.ctx.storage.get<unknown>(BOT_CONFIGURATION_KEY);
  if (stored === undefined)
    throw new Error(`Bot "${identity.botId}" is not materialized`);
  return decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
}

/** The settings a Bot starts life with. */
export function initialBotSettingsV1(botId: string): BotSettingsViewV1 {
  return initializeBotSettingsV1(botId);
}

/** The settings as they stand inside the admission transaction. */
export async function admittedBotSettingsV1(
  transaction: DurableObjectTransaction,
  resolved: BotSettingsViewV1,
): Promise<BotSettingsViewV1> {
  const stored = await transaction.get<unknown>(BOT_CONFIGURATION_KEY);
  return stored === undefined
    ? resolved
    : decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
}

/** Writes this Bot's first settings record, or returns the one it already has. */
export async function materializeBotSettingsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  initial: {
    name: string;
    /** The persona the Bot's profile is seeded with, when its creator gave one. */
    description?: string;
  },
): Promise<BotSettingsViewV1> {
  return state.ctx.storage.transaction(async (transaction) => {
    const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
    if (
      durableIdentity &&
      (durableIdentity.userId !== identity.userId ||
        durableIdentity.botId !== identity.botId)
    ) {
      throw new Error("Bot authority does not match its durable identity");
    }
    const stored = await transaction.get<unknown>(BOT_CONFIGURATION_KEY);
    if (stored !== undefined) {
      return decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
    }
    const settings = {
      ...initialBotSettingsV1(identity.botId),
      profile: {
        name: initial.name,
        ...(initial.description === undefined
          ? {}
          : { description: initial.description }),
      },
    } satisfies BotSettingsViewV1;
    await transaction.put({
      [IDENTITY_KEY]: durableIdentity ?? identity,
      [BOT_CONFIGURATION_KEY]: settings,
    });
    return settings;
  });
}

export async function readConfiguration(
  state: ShellBotStateV1,
  input: unknown,
): Promise<BotSettingsViewV1> {
  const request = decodeBotConfigurationReadRpcV1(input);
  return readBotSettingsV1(state, {
    userId: request.userId,
    botId: request.botId,
  });
}

export async function executeConfiguration(
  state: ShellBotStateV1,
  input: unknown,
): Promise<OperationReceiptV1> {
  const request = decodeBotConfigurationExecuteRpcV1(input);
  await assertLifecycleActiveV1(state, request.botId);
  return executeConfigurationCommand(
    state,
    { userId: request.userId, botId: request.botId },
    request.command,
  );
}

/** Refuses a write to a Bot the host has archived or deleted. */
export async function assertLifecycleActiveV1(
  state: ShellBotStateV1,
  botId: string,
): Promise<void> {
  if (!state.lifecycleAdmission) return;
  await state.ctx.storage.transaction((transaction) =>
    state.lifecycleAdmission!(transaction, botId),
  );
}

export async function executeConfigurationCommand(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: Extract<ConfigurationCommandV1, { botId: string }>,
): Promise<OperationReceiptV1> {
  const commandFingerprint = configurationCommandFingerprintV1(command);
  const activities = state.configurationActivities;
  const active = activities.get(command.commandId);
  if (active) {
    if (active.commandFingerprint !== commandFingerprint) {
      throw new Error(
        `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
      );
    }
    return active.promise;
  }
  const activity: Promise<OperationReceiptV1> = executeConfigurationDurably(
    state,
    identity,
    command,
    commandFingerprint,
  ).finally(() => {
    if (activities.get(command.commandId)?.promise === activity) {
      activities.delete(command.commandId);
    }
  });
  activities.set(command.commandId, { commandFingerprint, promise: activity });
  return activity;
}

async function executeConfigurationDurably(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: Extract<ConfigurationCommandV1, { botId: string }>,
  commandFingerprint: string,
): Promise<OperationReceiptV1> {
  const settings = await readBotSettingsV1(state, identity);
  const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
  const existing =
    await state.ctx.storage.get<StoredConfigurationReceiptV1>(receiptKey);
  if (existing) {
    return requireMatchingConfigurationReceiptV1(
      existing,
      commandFingerprint,
      command.commandId,
    );
  }
  if (command.expectedRevision !== settings.revision) {
    throw new ConfigurationConflictError(settings.revision);
  }
  let packageValues: Record<string, unknown> | undefined;
  let packageUnset: string[] | undefined;
  if (command.type === "bot/set-package-settings") {
    const user = await userConfigurationV1(state, identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const packages = executionPackagesV1(state.application);
    if (command.values) {
      packageValues = decodeInstalledPackageSettingsPatchV1({
        packageId: command.packageId,
        values: command.values,
        scope: "bot",
        installations: user.packages,
        packages,
      });
    }
    if (command.unset) {
      packageUnset = decodeInstalledPackageSettingIdsV1({
        packageId: command.packageId,
        unset: command.unset,
        scope: "bot",
        installations: user.packages,
        packages,
      });
    }
  }
  return applySimpleConfigurationCommand(
    state,
    identity,
    command,
    commandFingerprint,
    packageValues,
    packageUnset,
  );
}

async function applySimpleConfigurationCommand(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: Extract<
    ConfigurationCommandV1,
    {
      type:
        | "bot/update-profile"
        | "bot/set-profile"
        | "bot/update-notifications"
        | "bot/set-package-settings";
    }
  >,
  commandFingerprint: string,
  packageValues?: Record<string, unknown>,
  packageUnset: readonly string[] = [],
): Promise<OperationReceiptV1> {
  return state.ctx.storage.transaction(async (transaction) => {
    await state.lifecycleAdmission?.(transaction, identity.botId);
    const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
    const existing =
      await transaction.get<StoredConfigurationReceiptV1>(receiptKey);
    if (existing) {
      return requireMatchingConfigurationReceiptV1(
        existing,
        commandFingerprint,
        command.commandId,
      );
    }
    const stored = await transaction.get<unknown>(BOT_CONFIGURATION_KEY);
    const current =
      stored === undefined
        ? initialBotSettingsV1(identity.botId)
        : decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
    if (command.expectedRevision !== current.revision) {
      throw new ConfigurationConflictError(current.revision);
    }
    if (
      command.type === "bot/update-notifications" &&
      command.notifications.enabled &&
      current.profile.hiddenFromSidebar === true
    ) {
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: current.revision,
        status: "rejected",
        failure: HIDDEN_BOT_NOTIFICATIONS_FAILURE,
      };
      await transaction.put(receiptKey, { commandFingerprint, receipt });
      return receipt;
    }
    const revision = current.revision + 1;
    const written: BotSettingsViewV1 =
      command.type === "bot/update-profile"
        ? { ...current, revision, profile: command.profile }
        : command.type === "bot/set-profile"
          ? {
              ...current,
              revision,
              profile: applyBotProfilePatchV1(
                current.profile,
                command.profile,
                command.namedBy ?? "user",
              ),
            }
          : command.type === "bot/update-notifications"
            ? { ...current, revision, notifications: command.notifications }
            : (() => {
                const values = {
                  ...(current.packageValues[command.packageId] ?? {}),
                  ...structuredClone(packageValues ?? {}),
                };
                for (const settingId of packageUnset) delete values[settingId];
                const nextPackageValues = { ...current.packageValues };
                if (Object.keys(values).length > 0) {
                  nextPackageValues[command.packageId] = values;
                } else {
                  delete nextPackageValues[command.packageId];
                }
                return {
                  ...current,
                  revision,
                  packageValues: nextPackageValues,
                };
              })();
    // Hiding mutes in the same write, whoever hid the Bot, so a client that
    // changes both sends one command and nothing can leave a hidden Bot alerting.
    const next = hiddenBotSettingsV1(written);
    const receipt: OperationReceiptV1 = {
      schemaVersion: 1,
      commandId: command.commandId,
      revision,
      status: "applied",
    };
    await transaction.put({
      [BOT_CONFIGURATION_KEY]: next,
      [receiptKey]: { commandFingerprint, receipt },
    });
    // A rename is durable history, not a settings side effect: the Session
    // records it so the conversation shows who renamed the Bot and when.
    if (next.profile.name !== current.profile.name) {
      const namedBy = next.profile.namedBy ?? "user";
      await appendRenameAnnouncement(transaction, {
        from: current.profile.name,
        to: next.profile.name,
        namedBy,
        // The writer travels only with a Bot's own rename: a User edit is
        // already attributed to the authenticated principal that made it.
        ...(namedBy === "bot" &&
        command.type === "bot/set-profile" &&
        command.writer
          ? { writer: command.writer }
          : {}),
      });
    }
    await state.authority.refreshRecoveryAlarm(transaction);
    return receipt;
  });
}

/**
 * Appends a rename announcement to the Bot's durable announcement log, in the
 * same transaction that wrote the name.
 */
async function appendRenameAnnouncement(
  transaction: BotAnnouncementTransaction,
  rename: {
    from: string;
    to: string;
    namedBy: "user" | "bot";
    writer?: BotSelfWriterV1;
  },
): Promise<void> {
  await appendAnnouncement(transaction, (seq) => ({
    type: "bot/renamed",
    seq,
    timestamp: new Date().toISOString(),
    from: rename.from,
    to: rename.to,
    namedBy: rename.namedBy,
    ...(rename.writer ? { writer: rename.writer } : {}),
  }));
}

/** The narrow User Durable Object RPC a Bot reads its User's account through. */
export interface UserConfigurationRpcV1 {
  readConfiguration(input: {
    schemaVersion: 1;
    userId: string;
  }): Promise<UserSettingsViewV1>;
  executeConfiguration(
    input: Extract<ConfigurationCommandV1, { type: `user/${string}` }>,
  ): Promise<OperationReceiptV1>;
  leaseModelCredential(
    userId: string,
    connectionId: string,
    providerModelId: string,
    effectId: string,
    connectionGeneration: string,
  ): Promise<CredentialLeaseV1>;
  leaseToolCredential(
    userId: string,
    connectionId: string,
    effectId: string,
    connectionGeneration: string,
  ): Promise<CredentialLeaseV1>;
  settleToolCredential(
    userId: string,
    connectionId: string,
    effectId: string,
  ): Promise<void>;
  settleModelCredential(
    userId: string,
    connectionId: string,
    packageId: string,
    effectId: string,
  ): Promise<void>;
  listBots(userId: string): Promise<BotDirectoryViewV1>;
  readBotVoice(userId: string, botId: string): Promise<VoiceIdentityViewV1>;
  updateBotVoice(
    userId: string,
    botId: string,
    command: UpdateVoiceCommandV1,
  ): Promise<FlockReceiptV1>;
  mirrorBotLook(
    userId: string,
    botId: string,
    look: BotLookV1,
    document: ThemeDocumentV1 | undefined,
  ): Promise<BotDirectoryViewV1>;
  createBot(
    userId: string,
    command: CreateBotCommandV1,
  ): Promise<FlockReceiptV1>;
  executeTemplateCommand(
    userId: string,
    command: TemplateCommandV1,
  ): Promise<TemplateShareReceiptV1>;
  listMachines(userId: string): Promise<MachineListViewV1>;
  describeMachineTarget(
    userId: string,
    machineId: string,
  ): Promise<MachineTargetViewV1>;
  dispatchMachineCommand(
    userId: string,
    command: MachineCommandV1,
  ): Promise<MachineDispatchAnswerV1>;
  readMachineResult(
    userId: string,
    commandId: string,
  ): Promise<MachineCommandResultV1 | undefined>;
  listConnectTriggers(): Promise<
    import("@frockbot/app/connect/triggers").ConnectTriggerOfferV1[]
  >;
  upsertConnectTrigger(input: {
    commandId: string;
    routineId: string;
    connectionId: string;
    triggerType: string;
    config?: Record<string, string | number | boolean>;
  }): Promise<void>;
  deleteConnectTrigger(input: {
    commandId: string;
    routineId: string;
  }): Promise<void>;
}

/**
 * One Turn's reading of the account features, shared by every gate that asks.
 *
 * The switches are still read from the User object on every Turn — what this
 * removes is asking three times inside one mount. The User Durable Object is
 * single-threaded and shared by every Bot of that User, so each avoided round
 * trip is also one less chance to queue behind a sibling Bot's Turn, which is
 * where the tail of the admitted-to-`turn/start` gap came from.
 *
 * Deliberately not a cache on the Bot: it lives exactly as long as the mount
 * that made it, so a Turn admitted after an admin moved a switch still sees
 * where the switch is now.
 */
export type UserAccountFeaturesReadV1 = () => Promise<UserFeaturesV1>;

/**
 * A {@link UserAccountFeaturesReadV1} that reads once and shares that answer.
 * A failed read is not kept, so a later gate gets its own attempt.
 */
export function userAccountFeaturesReaderV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): UserAccountFeaturesReadV1 {
  let pending: Promise<UserFeaturesV1> | undefined;
  return () =>
    (pending ??= userAccountFeaturesV1(state, identity).catch(
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    ));
}

/**
 * The account features record, read from the User Durable Object every time it
 * is asked and never cached in the Bot: the switches are the admin's, and a
 * Turn admitted after one moved should see where it is now. Throws when the
 * User object cannot answer; each caller decides what an unanswerable switch
 * means for it.
 *
 * One read answers every feature gate, so a Turn asks the User object once
 * rather than once per switch.
 */
export async function userAccountFeaturesV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<UserFeaturesV1> {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  const rpc = state.env.USER_CONFIGURATIONS.get(id);
  return decodeUserFeaturesV1(
    appletRpcSnapshotV1(
      await rpc.readFeatures({ schemaVersion: 1, userId: identity.userId }),
    ),
  );
}

export function userConfigurationV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): UserConfigurationRpcV1 {
  const id = state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
  const rpc = state.env.USER_CONFIGURATIONS.get(id);
  return {
    readConfiguration: async (input) =>
      decodeUserSettingsViewV1(
        await rpc.readConfiguration({ ...input, view: 2 }),
      ),
    executeConfiguration: async (command) =>
      decodeOperationReceiptV1(
        await rpc.executeConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
          command,
        }),
      ),
    // A machine is a User asset, so every one of these crosses the seam and
    // is decoded on arrival rather than trusted in the shape RPC returned.
    listMachines: async (userId) =>
      decodeMachineListViewV1(
        await rpc.listMachines({ schemaVersion: 1, userId }),
      ),
    describeMachineTarget: async (userId, machineId) =>
      decodeMachineTargetViewV1(
        await rpc.describeMachineTarget({
          schemaVersion: 1,
          userId,
          machineId,
        }),
      ),
    dispatchMachineCommand: async (userId, command) =>
      decodeMachineDispatchAnswerV1(
        await rpc.dispatchMachineCommand({
          schemaVersion: 1,
          userId,
          command,
        }),
      ),
    readMachineResult: async (userId, commandId) => {
      const stored = await rpc.readMachineResult({
        schemaVersion: 1,
        userId,
        commandId,
      });
      return stored === undefined || stored === null
        ? undefined
        : decodeMachineCommandResultV1(stored, "machine command result");
    },
    // Flock state crosses a Durable Object seam, so it decodes on arrival
    // rather than being trusted in the shape RPC happened to return.
    listBots: async (userId) =>
      decodeDirectoryViewV1(await rpc.listBots({ schemaVersion: 1, userId })),
    createBot: async (userId, command) =>
      decodeFlockReceiptV1(
        await rpc.createBot({ schemaVersion: 1, userId, command }),
      ),
    readBotVoice: async (userId, botId) =>
      decodeVoiceIdentityViewV1(
        await rpc.readBotVoice({ schemaVersion: 1, userId, botId }),
      ),
    updateBotVoice: async (userId, botId, command) =>
      decodeFlockReceiptV1(
        await rpc.updateBotVoice({ schemaVersion: 1, userId, botId, command }),
      ),
    mirrorBotLook: async (userId, botId, look, document) =>
      decodeDirectoryViewV1(
        await rpc.mirrorBotLook({
          schemaVersion: 1,
          userId,
          botId,
          look,
          ...(document === undefined ? {} : { document }),
        }),
      ),
    executeTemplateCommand: async (userId, command) =>
      decodeTemplateShareReceiptV1(
        await rpc.executeTemplateCommand({
          schemaVersion: 1,
          userId,
          command,
        }),
      ),
    leaseModelCredential: async (
      userId,
      connectionId,
      providerModelId,
      effectId,
      connectionGeneration,
    ) =>
      decodeCredentialLeaseV1(
        await rpc.leaseModelCredential({
          schemaVersion: 1,
          userId,
          connectionId,
          providerModelId,
          effectId,
          connectionGeneration,
        }),
      ),
    leaseToolCredential: async (
      userId,
      connectionId,
      effectId,
      connectionGeneration,
    ) =>
      decodeCredentialLeaseV1(
        await rpc.leaseToolCredential({
          schemaVersion: 1,
          userId,
          connectionId,
          effectId,
          connectionGeneration,
        }),
      ),
    settleToolCredential: (userId, connectionId, effectId) =>
      rpc.settleToolCredential({
        schemaVersion: 1,
        userId,
        connectionId,
        effectId,
      }),
    settleModelCredential: (userId, connectionId, packageId, effectId) =>
      rpc.settleModelCredential({
        schemaVersion: 1,
        userId,
        connectionId,
        packageId,
        effectId,
      }),
    listConnectTriggers: async () => {
      const offers = await rpc.listConnectTriggers({
        schemaVersion: 1,
        userId: identity.userId,
      });
      return Array.isArray(offers) ? offers : [];
    },
    upsertConnectTrigger: async (input) => {
      await rpc.upsertConnectTrigger({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        ...input,
      });
    },
    deleteConnectTrigger: (input) =>
      rpc.deleteConnectTrigger({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        ...input,
      }),
  };
}

/** The Bot's settings, its User's account, and the plan the two resolve to. */
export async function resolveExecutionContextV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<{
  settings: BotSettingsViewV1;
  user: UserSettingsViewV1;
  plan: BotExecutionPlanV1;
}> {
  const settings = await readBotSettingsV1(state, identity);
  const user = await userConfigurationV1(state, identity).readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
  });
  const plan = resolveBotExecutionPlanV1({
    bot: settings,
    user,
    packages: executionPackagesV1(state.application),
  });
  return { settings, user, plan };
}

export async function resolveConfiguration(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<BotExecutionPlanV1> {
  return (await resolveExecutionContextV1(state, identity)).plan;
}

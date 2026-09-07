import type { RoutineWriterV1 } from "@frockbot/app/routines/records";
import { turnToolCatalogPin } from "./tool-catalog-pin.js";
import type { AgentEffectAdmission } from "@frockbot/core/agent-loop/agent";
import {
  decodeIsolateMemoryReadRequestV1,
  decodeIsolateMemoryWriteRequestV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeSendToUserPayloadV1,
  decodeWorkspacePathV1,
  decodeWorkspaceRootV1,
  type IsolateConnectionOutcomeV1,
  type IsolateConnectionV1,
  type IsolateMemoryOutcomeV1,
  type IsolateScheduleOutcomeV1,
  type IsolateWorkspaceOutcomeV1,
  type SessionEvent,
  type WorkspacePathV1,
  type WorkspaceRootV1,
  validateToolOccurrenceJournal,
  type BotCapabilitiesStub,
  type IsolateModelInvocationV1,
  type NormalizedModelRequest,
  type PackageIframeCompositionV1,
  type PackageIframeToolCommandV1,
  type TurnTypeV1,
  type WorkspaceFilesV1,
} from "@frockbot/core/contracts";
import {
  appletSourceFilePathV1,
  appletsSourceRootV1,
} from "@frockbot/applets/root";
import type {
  AppletCapabilityHostV1,
  AppletsRuntimeHostV1,
} from "@frockbot/applets/feature";
import { firstPartyPackageToolAllowedV1 } from "@frockbot/applets/pages";
import { syncWorkspaceRootNowV1 } from "@frockbot/computer/agent";
import {
  ACTIVE_RUN_KEY,
  IDENTITY_KEY,
  RUN_PREFIX,
  SessionEventLog,
  storedRunRecordV2,
  type BotIdentity,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "@frockbot/core/durable";
import type {
  FoundationAgentPackage,
  RuntimeModelSelection,
} from "@frockbot/app/agent-runtime";
import {
  decodeCredentialLeaseV1,
  type CredentialLeaseV1,
} from "@frockbot/core/connection";
import {
  applyBotProfilePatchV1,
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeBotSettingsViewV1,
  decodeCompositionCommandReceiptV1,
  decodeOperationReceiptV1,
  decodeInstalledPackageSettingIdsV1,
  decodeInstalledPackageSettingsPatchV1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  type CompositionCommandReceiptV1,
  type CompositionGenerationListViewV1,
  type CompositionGenerationViewV1,
  type RevertCompositionCommandV1,
  type BotExecutionPlanV1,
  type BotSelfWriterV1,
  type BotSettingsViewV1,
  type EnabledCapabilityV1,
  type ConnectionView,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
  type PackageSettingValueV1,
  type ResolvedModelBindingV1,
  initializeBotSettingsV1,
  migrateStoredBotSettingsV1,
  resolvePackageSettingValuesV1,
  resolveBotExecutionPlanV1,
  resolveEffectiveBotModelV1,
  type UserSettingsViewV1,
} from "@frockbot/core/configuration";
import { latestModelRequestJournalState } from "./backend-recovery.js";
import {
  bootstrapCompositionGeneration,
  createShellCompositionHost,
  type ShellAppletMountOptions,
  type ShellIsolateMountOptions,
  type ShellMountedComposition,
} from "./backend-composition.js";
import {
  createAppletCapabilityHostV1,
  createAppletInstanceBindingV1,
  APPLET_DIST_FILES_V1,
  appletRpcSnapshotV1 as rpcJsonSnapshotV1,
  resolveAppletCompositionV1,
  type AppletUserDirectoryV1,
} from "./backend-applets.js";
import {
  APPLET_FOCUSED_KEY,
  decodeFocusedAppletV1,
  type FocusedAppletV1,
} from "@frockbot/core/durable";
import {
  decodeAppletProvenanceV1,
  decodeAppletSummaryV1,
  decodeAppletToolDeclarationV1,
} from "@frockbot/core/contracts";
import { compositionFailureTurnTextV1 } from "./backend-composition-input.js";
import {
  activateCompositionV1,
  type CompositionFailureV1,
  type CompositionMountHost,
  type CompositionQuarantineV1,
} from "@frockbot/core/durable";
import {
  createBotComputerSyncHost,
  declaredPackageRootsV1,
} from "./backend-computer.js";
import {
  decodeDirectoryViewV1,
  decodeFlockReceiptV1,
  type BotDirectoryViewV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
} from "@frockbot/app/flock/shared";
import { createBotSelfManagementHost } from "./backend-flock.js";
import {
  decodeTemplateShareReceiptV1,
  type TemplateCommandV1,
  type TemplateShareReceiptV1,
} from "@frockbot/app/bot-template/shared";
import { createBotMemoryHost } from "./backend-memory.js";
import { createBotImageHost } from "./backend-image.js";
import { createBotSkillsHost, createBotSkillsReads } from "./backend-skills.js";
import {
  loadFullSkillCatalogV1,
  loadSkillCatalogV1,
  skillRefForLoadedSkillV1,
} from "@frockbot/app/skills/catalog";
import { writeSkillDocumentV1 } from "@frockbot/app/skills/write";
import {
  clientSkillCatalogEntryV1,
  type ClientSkillCatalogEntryV1,
  type ClientSkillCatalogV1,
} from "./skill-protocol.js";
import {
  createBotRoutinesHost,
  routineFireOutcomeV1,
  routineInboxEntryViewV1,
  routineRunDetailViewV1,
  routineTurnCommandV1,
  settledRoutineOriginV1,
} from "./backend-routines.js";
import {
  ROUTINE_INBOX_LIMIT,
  ROUTINE_INBOX_PREFIX,
} from "@frockbot/app/routines/storage-keys";
import {
  decodeRoutineInboxEntryV1,
  routineFailureSentenceV1,
} from "@frockbot/app/routines/inbox";
import {
  taskDesktopLeaseOwnerV1,
  type TaskRecordV1,
} from "@frockbot/app/subagents/records";
import {
  taskKeyV1,
  TASK_ACTIVE_PREFIX,
  TASK_CONTEXT_PREFIX,
} from "@frockbot/app/subagents/storage-keys";
import { decodeAgentTurnSlotReceiptV1 } from "@frockbot/app/flock/quota";
import {
  subagentModelCatalogV1,
  type SubagentModelOptionV1,
} from "@frockbot/app/subagents/models";
import { decodeSubagentTaskContextV1 } from "@frockbot/app/subagents/durable-binding";
import {
  approvalKeyV1,
  approvalNotificationBodyV1,
  approvalNotificationIdV1,
  approvalSendsV1,
  decodeApprovalRecordV1,
  projectApprovalCardV1,
  trimmableApprovalKeysV1,
  APPROVAL_PREFIX,
  ApprovalDecodeError,
  type ApprovalDecisionCommandV1,
  type ApprovalDecisionReceiptV1,
  type ApprovalListViewV1,
  type ApprovalRecordV1,
} from "./approvals.js";
import { enqueuePendingBotInputV1 } from "@frockbot/app/routines/inbox-store";
import {
  createBotMachineHost,
  createBotMachineMessagesHost,
  dispatchApprovedMachineIntentV1,
  resolveBotMachineMessagesGateV1,
  type BotMachineSeamV1,
} from "./backend-machine.js";
import { settleMachineIntentV1 } from "@frockbot/app/machine/approval";
import type { MachineIntentRecordV1 } from "@frockbot/app/machine/intent";
import { type MachineResultDeliveryV1 } from "@frockbot/app/machine/delivery";
import {
  decodeMachineListViewV1,
  decodeMachineCommandResultV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
  type MachineListViewV1,
} from "@frockbot/core/machine-protocol";
import { decodeMachineTargetViewV1 } from "@frockbot/app/machine/target";
import type { MachineTargetViewV1 } from "@frockbot/app/machine/target";
import {
  decodeMachineDispatchAnswerV1,
  type MachineDispatchAnswerV1,
} from "@frockbot/app/machine/approval";
import {
  pendingBotInputPreambleV1,
  routineHandoffTextV1,
} from "@frockbot/app/routines/inbox";
import type { RoutineFireOutcomeV1 } from "@frockbot/app/routines/scheduler";
import type { RoutineFireV1 } from "@frockbot/app/routines/firing";
import { RoutineNotFoundError } from "@frockbot/app/routines/store";
import type {
  RoutineCommandReceiptV1,
  RoutineCommandV1,
  RoutineInboxCommandV1,
  RoutineInboxReceiptV1,
  RoutineInboxViewV1,
  RoutineListViewV1,
  RoutineRunDetailViewV1,
  RoutineRunListViewV1,
} from "@frockbot/app/routines/shared";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  createIsolateCapabilityHost,
  createR2PackageArtifactStore,
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
  type IsolateCapabilityHost,
  type IsolateModelBindingV1,
  type IsolateModelPath,
} from "./backend-isolate.js";
import { memoryScopeRootV1 } from "@frockbot/app/memory/roots";
import type { CompositionGenerationV1 } from "@frockbot/core/durable";
import {
  projectCompositionGenerationV1,
  projectFirstPartyPackageIframeV1,
} from "./composition-views.js";
import { executeBotTurn, executeDirectToolTurn } from "./backend-runner.js";
import { yieldCompactionWorkV1 } from "./compaction-scheduler.js";
import {
  shellTerminalRecordsV1,
  supersededTurnRecordsV1,
} from "./terminal-records.js";
import {
  createClientRunStopReceiptV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  decodeClientTurnV1,
  projectClientRunLookupV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientRunLookupV1,
  type ClientConversationListV1,
  type ClientConversationOutcomeV1,
  type ClientRunListV1,
  type ClientRunStopReceiptV1,
  type ClientTurnV1,
} from "./run-protocol.js";
import { notificationIdV1 } from "./notification-id.js";
import { runFailureCopyV1 } from "./run-failure-copy.js";
import { type BotDebugSnapshotV1 } from "./debug-protocol.js";
import {
  botStopCommandFingerprintV1,
  requireStoredRunV1,
  type BotNotificationIntent,
  type BotTurnCompletion,
  type StoredRun,
  type StoredRunStatus,
} from "./backend-contracts.js";

/** The Bot Durable Object key holding this Bot's durable configuration. */
import {
  botUnreadCommandFingerprintV1,
  markUnreadReadV1,
  markUnreadV1,
  optionalSidebarMessagePreviewV1,
  optionalUnreadStateV1,
  projectBotUnreadViewV1,
  sidebarMessagePreviewFromRunsV1,
  SIDEBAR_PREVIEW_KEY,
  unreadReceiptKeyV1,
  UNREAD_COUNT_CAP,
  UNREAD_STATE_KEY,
  type BotUnreadCommandV1,
  type BotUnreadReceiptV1,
  type BotUnreadViewV1,
  type SidebarMessagePreviewV1,
  type SidebarPreviewRunV1,
} from "./unread.js";
import { defineBotBackendContribution } from "@frockbot/core/contracts/contributions";
import { debugSnapshot } from "./debug.js";
import {
  BOT_CONFIGURATION_KEY,
  readBotSettingsV1,
} from "@frockbot/app/settings/bot";
import {
  reconcileOverdueTasks,
  runOwedSubagentTurns,
  subagentsRuntimeHost,
} from "@frockbot/app/subagents/bot";
import {
  announcementsFromSession,
  appendAnnouncement,
  type BotAnnouncementTransaction,
  BOT_ANNOUNCEMENT_RETENTION,
  listConversations,
  listRunEventPage,
  listRuns,
  lookupRun,
  runWorkingV1,
  startConversation,
} from "./reads.js";
import {
  executionPackagesV1,
  ShellBotStateV1,
  type ActiveTurnV1,
  type ShellBotBackendHost,
} from "./backend-state.js";

const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
const STOP_RECEIPT_PREFIX = "stop-receipt:";
/** Idempotency records for Composition commands this Package admits. */
const COMPOSITION_COMMAND_PREFIX = "composition-command:";

interface StoredConfigurationReceipt {
  commandFingerprint: string;
  receipt: OperationReceiptV1;
}

/** Durable idempotency receipt for one exact Stop command. */
interface StoredStopReceipt {
  schemaVersion: 1;
  commandFingerprint: string;
  commandId: string;
  runId: string;
  stopRequestedAt: string;
}

function isTerminalStoredRunStatus(status: StoredRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "superseded"
  );
}

interface ConfigurationActivity {
  commandFingerprint: string;
  promise: Promise<OperationReceiptV1>;
}

interface IsolateCallScopeV1 {
  userId: string;
  botId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  packageId: string;
  generationId: string;
  request: unknown;
}

function requireMatchingConfigurationReceipt(
  stored: StoredConfigurationReceipt,
  commandFingerprint: string,
  commandId: string,
): OperationReceiptV1 {
  if (stored.commandFingerprint !== commandFingerprint) {
    throw new Error(
      `Configuration command idempotency key "${commandId}" was reused for a different command`,
    );
  }
  return stored.receipt;
}

export type { BotIdentity, OwnedBotTurnCommand };

function optionalStoredRun(input: unknown): StoredRun | undefined {
  return input === undefined ? undefined : requireStoredRunV1(input);
}

/** Server-side allowlist for the untrusted page's only effectful message. */
export function requirePackageUiToolDeclarationV1(
  catalog: PackageIframeCompositionV1,
  command: Pick<PackageIframeToolCommandV1, "packageId" | "name">,
): PackageIframeCompositionV1["contributions"][number] {
  const contribution = catalog.contributions.find(
    (candidate) => candidate.packageId === command.packageId,
  );
  if (!contribution || !contribution.declaredTools.includes(command.name)) {
    throw new Error(
      `Package "${command.packageId}" did not declare tool "${command.name}"`,
    );
  }
  return contribution;
}

export class ShellBotBackendContribution {
  readonly state: ShellBotStateV1;
  private readonly configurationActivities = new Map<
    string,
    ConfigurationActivity
  >();

  constructor(host: ShellBotBackendHost) {
    this.state = new ShellBotStateV1(host, () => ({
      resolveAdmissionSnapshot: (command) =>
        this.resolveAdmissionSnapshot(command),
      bootstrapComposition: () => this.bootstrapComposition(),
      admittedSnapshot: (transaction, resolved) =>
        this.admittedSnapshot(transaction, resolved),
      executeTurn: (input) => this.executeTurn(input),
      notification: (snapshot, result) =>
        this.createNotification(snapshot, result),
      failureNotification: (snapshot, failed) =>
        this.createFailureNotification(snapshot, failed),
      terminalRecords: (input) => this.terminalPackageRecords(input),
      supersededRecords: (input) => this.supersededPackageRecords(input),
      interruptTurn: (runId, reason) => this.interruptActiveTurn(runId, reason),
      scheduledDeadlines: (transaction) => this.scheduledDeadlines(transaction),
      scheduledWorkInFlight: () =>
        this.state.hostScheduled.inFlight?.() ?? false,
      deferScheduledWork: (transaction) => this.deferScheduledWork(transaction),
      settleScheduledWork: () => this.settleScheduledWork(),
    }));
  }

  async materializeSettings(
    identity: BotIdentity,
    initial: {
      name: string;
      /** The persona the Bot's profile is seeded with, when its creator gave one. */
      description?: string;
    },
  ): Promise<BotSettingsViewV1> {
    return this.state.ctx.storage.transaction(async (transaction) => {
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
        ...this.initialBotSettings(identity.botId),
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

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    return readBotSettingsV1(this.state, identity);
  }

  async readConfiguration(input: unknown): Promise<BotSettingsViewV1> {
    const request = decodeBotConfigurationReadRpcV1(input);
    return this.getSettings({ userId: request.userId, botId: request.botId });
  }

  async executeConfiguration(input: unknown): Promise<OperationReceiptV1> {
    const request = decodeBotConfigurationExecuteRpcV1(input);
    await this.assertLifecycleActive(request.botId);
    return this.executeConfigurationCommand(
      { userId: request.userId, botId: request.botId },
      request.command,
    );
  }

  private async executeConfigurationCommand(
    identity: BotIdentity,
    command: Extract<ConfigurationCommandV1, { botId: string }>,
  ): Promise<OperationReceiptV1> {
    const commandFingerprint = configurationCommandFingerprintV1(command);
    const active = this.configurationActivities.get(command.commandId);
    if (active) {
      if (active.commandFingerprint !== commandFingerprint) {
        throw new Error(
          `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
        );
      }
      return active.promise;
    }
    const activity: Promise<OperationReceiptV1> =
      this.executeConfigurationDurably(
        identity,
        command,
        commandFingerprint,
      ).finally(() => {
        if (
          this.configurationActivities.get(command.commandId)?.promise ===
          activity
        ) {
          this.configurationActivities.delete(command.commandId);
        }
      });
    this.configurationActivities.set(command.commandId, {
      commandFingerprint,
      promise: activity,
    });
    return activity;
  }

  private async executeConfigurationDurably(
    identity: BotIdentity,
    command: Extract<ConfigurationCommandV1, { botId: string }>,
    commandFingerprint: string,
  ): Promise<OperationReceiptV1> {
    const settings = await readBotSettingsV1(this.state, identity);
    const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
    const existing =
      await this.state.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
    if (existing) {
      return requireMatchingConfigurationReceipt(
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
      const user = await this.userConfiguration(identity).readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      });
      const packages = executionPackagesV1(this.state.application);
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
    return this.applySimpleConfigurationCommand(
      identity,
      command,
      commandFingerprint,
      packageValues,
      packageUnset,
    );
  }

  private async applySimpleConfigurationCommand(
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
    return this.state.ctx.storage.transaction(async (transaction) => {
      await this.state.lifecycleAdmission?.(transaction, identity.botId);
      const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
      const existing =
        await transaction.get<StoredConfigurationReceipt>(receiptKey);
      if (existing) {
        return requireMatchingConfigurationReceipt(
          existing,
          commandFingerprint,
          command.commandId,
        );
      }
      const stored = await transaction.get<unknown>(BOT_CONFIGURATION_KEY);
      const current =
        stored === undefined
          ? this.initialBotSettings(identity.botId)
          : decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      const revision = current.revision + 1;
      const next: BotSettingsViewV1 =
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
                  for (const settingId of packageUnset)
                    delete values[settingId];
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
        await this.appendRenameAnnouncement(transaction, {
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
      await this.refreshRecoveryAlarm(transaction);
      return receipt;
    });
  }

  /**
   * Appends a rename announcement to the Bot's durable announcement log, in
   * the same transaction that wrote the name. The log is append-only and
   * bounded: the oldest entries beyond {@link BOT_ANNOUNCEMENT_RETENTION} are
   * dropped, because an announcement is conversational history, not authority.
   */
  private async appendRenameAnnouncement(
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

  async listAnnouncements(): Promise<SessionEvent[]> {
    const sessionId = await this.state.authority.readConversationSessionId();
    const session = sessionId
      ? await this.state.authority.readSessionEvents(sessionId)
      : [];
    return announcementsFromSession(this.state, session);
  }

  private async refreshRecoveryAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    await this.state.authority.refreshRecoveryAlarm(transaction);
  }

  async resolveConfiguration(
    identity: BotIdentity,
  ): Promise<BotExecutionPlanV1> {
    return (await this.resolveExecutionContext(identity)).plan;
  }

  async run(command: OwnedBotTurnCommand): Promise<ClientTurnV1> {
    // Before the authority reads the session log, so a compaction detached
    // from the previous Turn has already handed the log back.
    await yieldCompactionWorkV1(command.sessionId);
    // Before admission, so the pin this Turn takes already carries whatever
    // the User's Applet directory says now.
    await this.resolveAppletComposition(
      { userId: command.userId, botId: command.botId },
      command,
    );
    return projectClientTurnV1(await this.state.authority.run(command));
  }

  async runPackageUiTool(
    identity: BotIdentity,
    command: PackageIframeToolCommandV1,
  ): Promise<ClientTurnV1> {
    await this.validateIdentity(identity);
    const catalog = await this.listPackageUi(identity);
    const contribution = requirePackageUiToolDeclarationV1(catalog, command);
    return projectClientTurnV1(
      await this.state.authority.run({
        ...identity,
        runId: command.commandId,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: `${contribution.displayName} · ${command.name}`,
        directTool: {
          packageId: command.packageId,
          name: command.name,
          input: command.input,
        },
      }),
    );
  }

  /**
   * The Bot's invocable Skills, for the composer's `/` and `@` popover.
   *
   * A read of the same instruction root the Turn loader reads, through the
   * same `WorkspaceReadsV1`, so the popover can never offer a Skill a Turn
   * would refuse as an instruction: a refused candidate is not in the catalog
   * here either. Names and descriptions only — never a body.
   *
   * An unbound Workspace surface is an empty catalog, not a failure: the
   * Skills Package is not mounted in that host either, so "no Skills" is the
   * true answer rather than an error the composer has to explain.
   */
  async listSkills(identity: BotIdentity): Promise<ClientSkillCatalogV1> {
    await this.validateIdentity(identity);
    const reads = createBotSkillsReads(this.state.env);
    if (!reads) return { schemaVersion: 1, skills: [] };
    const catalog = await loadFullSkillCatalogV1(reads, {
      userId: identity.userId,
      botId: identity.botId,
    });
    const entries: ClientSkillCatalogEntryV1[] = [];
    for (const skill of catalog.skills) {
      const ref = skillRefForLoadedSkillV1(skill);
      // A Skill whose directory is not a well-formed slug has no ref, so it
      // cannot be invoked and is not offered. It is still listed to the model
      // in `<agent_skills>` and still loadable by path.
      if (!ref) continue;
      entries.push(
        clientSkillCatalogEntryV1({
          skill: ref,
          name: skill.name,
          description: skill.description,
          path: skill.path,
        }),
      );
    }
    return { schemaVersion: 1, skills: entries };
  }

  /** The first-party page registry, as inert iframe metadata for one Bot. */
  async listPackageUi(
    identity: BotIdentity,
  ): Promise<PackageIframeCompositionV1> {
    await this.validateIdentity(identity);
    return projectFirstPartyPackageIframeV1(identity.botId);
  }

  /**
   * Write one Skill into this Bot's own instruction root as its **User**.
   *
   * The importing User authored the recipe by choosing to materialize it, and
   * no Turn of the new Bot has run yet, so there is no Bot writer to record.
   * `isLoadableSkillSourceV1` admits a `user` writer under the Bot's own
   * instruction root, so an imported Skill is loadable on the Bot's first Turn
   * and its provenance says who put it there. The write goes through the same
   * `writeSkillDocumentV1` the Bot's own `skill_write` uses, quota included.
   */
  /**
   * One file written into one of the User's durable roots, as the User.
   *
   * This is the stand-in for the Computer's sync in an environment that has
   * no Computer: an end-to-end run lands the bytes `applet build` would have
   * written, at the path the sync would have mirrored them to, through the
   * same store and with the same generation record. The writer is the User —
   * the authority the sync's `unattributed` mirror is *narrower* than — so
   * nothing here is a write the User could not have made from their own
   * Computer. A root belonging to another User is refused by the store.
   */
  async writeUserWorkspaceFile(
    identity: BotIdentity,
    request: {
      root: WorkspaceRootV1;
      path: string;
      bytes: Uint8Array;
      mediaType?: string;
    },
  ): Promise<
    | { status: "written"; generationId: string }
    | { status: "refused"; reason: string }
  > {
    await this.validateIdentity(identity);
    const files = (this.state.env as { WORKSPACE_FILES?: WorkspaceFilesV1 })
      .WORKSPACE_FILES;
    if (!files) {
      return { status: "refused", reason: "this Bot has no Workspace store" };
    }
    if (request.root.userId !== identity.userId) {
      return { status: "refused", reason: "the root belongs to another User" };
    }
    const path = { root: request.root, path: request.path };
    const existing = await files.stat(path);
    const outcome = await files.write({
      path,
      bytes: request.bytes,
      writer: { kind: "user", userId: identity.userId },
      expectedGenerationId:
        existing.status === "ok"
          ? existing.entry.generation.generationId
          : null,
      ...(request.mediaType ? { mediaType: request.mediaType } : {}),
    });
    if (outcome.status === "ok") {
      return {
        status: "written",
        generationId: outcome.generation.generationId,
      };
    }
    return { status: "refused", reason: outcome.reason };
  }

  async writeUserSkill(
    identity: BotIdentity,
    draft: { slug: string; name: string; description: string; body: string },
  ): Promise<
    | { status: "written"; generationId: string }
    | { status: "refused"; reason: string }
  > {
    await this.validateIdentity(identity);
    // The same binding `createBotSkillsHost` hands the Skills Package for a
    // Turn. Absent, and there is no writable instruction root to import into.
    const files = (this.state.env as { WORKSPACE_FILES?: WorkspaceFilesV1 })
      .WORKSPACE_FILES;
    if (!files) {
      return {
        status: "refused",
        reason: "this Bot has no writable instruction root",
      };
    }
    const outcome = await writeSkillDocumentV1(
      files,
      { userId: identity.userId, botId: identity.botId },
      { kind: "user", userId: identity.userId },
      draft,
    );
    return outcome.status === "written"
      ? { status: "written", generationId: outcome.generationId }
      : outcome;
  }

  /**
   * The Bot's own instruction root, bodies included.
   *
   * `listSkills` above is deliberately body-free: the composer's popover needs
   * names, and a body it does not need is a body it should not carry. This is
   * the other read — the one an export needs — and it is narrower in exactly
   * the way that matters: it calls `loadSkillCatalogV1`, which walks *only*
   * the Bot's own instruction root, so the managed set and the plugin-borne
   * index are not merely filtered out afterwards, they are never loaded. A
   * candidate the authority predicate refuses is not here either, and a Skill
   * whose body could not be read is absent rather than half-present.
   *
   * A Skill with no well-formed slug is dropped: the importing Bot needs a
   * directory name to write it under, and inventing one from a path that means
   * something only in this deployment would be a fallback, which the register
   * forbids.
   */
  async listOwnSkillDocuments(identity: BotIdentity): Promise<
    {
      slug: string;
      name: string;
      description?: string;
      body: string;
    }[]
  > {
    await this.validateIdentity(identity);
    const reads = createBotSkillsReads(this.state.env);
    if (!reads) return [];
    const catalog = await loadSkillCatalogV1(reads, {
      userId: identity.userId,
      botId: identity.botId,
    });
    return catalog.skills.flatMap((skill) =>
      skill.ref
        ? [
            {
              slug: skill.ref.slug,
              name: skill.name,
              ...(skill.description ? { description: skill.description } : {}),
              body: skill.body,
            },
          ]
        : [],
    );
  }

  /**
   * Durably records Stop intent and an idempotency receipt before signalling
   * the resident Agent. The acknowledged projection reports the run's current
   * durable state and never claims terminal cancellation.
   */
  async stopRun(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunStopReceiptV1> {
    const command = decodeClientRunStopCommandV1(input);
    await this.validateIdentity(identity);
    const commandFingerprint = botStopCommandFingerprintV1({
      userId: identity.userId,
      botId: identity.botId,
      commandId: command.commandId,
      runId: command.runId,
    });
    const key = `${RUN_PREFIX}${command.runId}`;
    const receiptKey = `${STOP_RECEIPT_PREFIX}${command.commandId}`;
    const admitted = await this.state.ctx.storage.transaction(
      async (transaction) => {
        const durableIdentity =
          await transaction.get<BotIdentity>(IDENTITY_KEY);
        if (
          durableIdentity &&
          (durableIdentity.userId !== identity.userId ||
            durableIdentity.botId !== identity.botId)
        ) {
          throw new Error("Bot authority does not match its durable identity");
        }
        const existing = await transaction.get<StoredStopReceipt>(receiptKey);
        if (existing && existing.commandFingerprint !== commandFingerprint) {
          throw new Error(
            `Stop idempotency key "${command.commandId}" was reused for a different command`,
          );
        }
        const run = optionalStoredRun(await transaction.get<unknown>(key));
        if (!run) throw new Error(`run "${command.runId}" was not admitted`);
        if (existing) return run;
        if (
          isTerminalStoredRunStatus(run.status) ||
          run.events.some((event) => event.type === "turn/end")
        ) {
          throw new Error(`run "${command.runId}" is already terminal`);
        }
        const stopRequestedAt = run.stopRequestedAt ?? new Date().toISOString();
        const stopped = requireStoredRunV1({
          ...run,
          stopRequestedAt,
        } satisfies StoredRun);
        await transaction.put({
          [key]: structuredClone(stopped),
          [receiptKey]: {
            schemaVersion: 1,
            commandFingerprint,
            commandId: command.commandId,
            runId: command.runId,
            stopRequestedAt,
          } satisfies StoredStopReceipt,
        });
        await this.refreshRecoveryAlarm(transaction);
        return stopped;
      },
    );
    // The Agent signal is advisory and always follows the durable intent.
    this.state.turn.cancel({
      sessionId: admitted.sessionId,
      runId: command.runId,
    });
    // Hydrated, like every other read the transcript is drawn from. A run
    // record stores its journal by range, not inline, so reading the record on
    // its own gives a Turn with no events — and a Turn with no events has said
    // nothing. The receipt is what the thread redraws the stopped Turn from,
    // so that erased the words the person had just watched arrive and left
    // "You stopped this." standing alone over an empty bubble.
    const current =
      (await this.state.authority.readStoredRunForDisplay(command.runId)) ??
      admitted;
    return createClientRunStopReceiptV1(command, projectClientRunV1(current));
  }

  private async executeTurn(
    input: BotTurnExecutionInput<BotSettingsViewV1>,
  ): Promise<BotTurnCompletion> {
    // A compaction detached from the previous Turn yields to this one rather
    // than holding it. Free when none is running, and an abort when one is, so
    // this Turn is the only writer of the session log.
    await yieldCompactionWorkV1(input.command.sessionId);
    const settings = input.configurationSnapshot;
    const turn = {
      runId: input.command.runId,
      // One admitted Turn is one run; the Turn ordinal lives in the session log.
      turnId: input.command.runId,
      sessionId: input.command.sessionId,
      // The admitted configuration snapshot is durable, so a recovered
      // bot_message reuses the same sender display name in its target command.
      fromBotName: settings.profile.name,
      // The pin this Turn was admitted under, and the type it was admitted as.
      // A subagent dispatched from here runs on this generation, and the model
      // catalog it is offered is narrowed by this turn type.
      compositionGenerationId: input.compositionGenerationId,
      turnType: input.command.turnType ?? "chat",
      // The role half of the same admission. A `subagent` Turn carries one; no
      // other turn type ever does.
      ...(input.command.subagentRole
        ? { subagentRole: input.command.subagentRole }
        : {}),
      // In a Subagent Durable Object, which task this Turn *is*. It is what
      // lets the child claim the messages its parent queued for it.
      ...(input.command.origin?.kind === "subagent"
        ? { subagentTaskId: input.command.origin.taskId }
        : {}),
      ...(input.command.origin?.kind === "bot"
        ? {
            inboundAgent: {
              kind: "bot" as const,
              fromBotId: input.command.origin.fromBotId,
              fromBotName: input.command.origin.fromBotName,
            },
          }
        : {}),
    };
    const runtime = await this.agentRuntime(
      input.identity,
      settings,
      input.admittedRequest,
      turn,
    );
    const promptParts = [
      `You are ${settings.profile.name}.`,
      settings.profile.description,
    ].filter((part): part is string => Boolean(part?.trim()));
    // The pin, never the current generation: activation takes effect at the
    // next admitted Turn, and an in-flight Turn completes on what it pinned.
    // The isolate bindings follow the generation actually being mounted, so a
    // fail-closed fallback loads the last known good's members, not the
    // pinned generation's.
    // Applet tools route to the Applet Durable Object, which forwards to the
    // facet. The instance binding is minted once per Turn; the facet stub
    // itself never leaves that object.
    const appletInstances = this.state.env.APPLET_STATES
      ? createAppletInstanceBindingV1(
          this.state.env.APPLET_STATES,
          input.identity.userId,
        )
      : undefined;
    const appletRouting: ShellAppletMountOptions | undefined = appletInstances
      ? {
          invokeTool: (request) =>
            appletInstances(request.appletId).invokeTool(request),
        }
      : undefined;
    const host: CompositionMountHost<ShellMountedComposition> = {
      mount: async (mounting, signal) => {
        const isolate = await this.isolateMountOptions(input.identity, {
          runId: input.command.runId,
          sessionId: input.command.sessionId,
          generationId: mounting.generationId,
          settings,
        });
        const mounted = await createShellCompositionHost({
          botId: input.identity.botId,
          sessionId: input.command.sessionId,
          sessionEvents: input.previousEvents,
          persistSessionEvents: input.persistSessionEvents,
          agentPackages: runtime.agentPackages,
          modelSelection: runtime.modelSelection,
          systemPromptSection: promptParts.join("\n\n"),
          // The turn type the run was admitted as; recovery reads it back from
          // the durable record, so a resumed Turn mounts the same catalog.
          turnType: input.command.turnType ?? "chat",
          // And the role it was admitted under, read back the same way.
          ...(input.command.subagentRole
            ? { subagentRole: input.command.subagentRole }
            : {}),
          // Durable Stop fences every provider and tool effect immediately
          // before it is used, in the Bot Durable Object's own transaction.
          admitEffect: (effect) =>
            this.admitRunEffect(
              input.identity,
              input.command.runId,
              input.command.sessionId,
              effect,
            ),
          ...(isolate ? { isolate } : {}),
          ...(appletRouting ? { applets: appletRouting } : {}),
        }).mount(mounting, signal);
        return mounted;
      },
    };
    const controller = new AbortController();
    // Composition fails closed: a generation that does not resolve, mount, or
    // pass `health()` leaves the last known good resident, records a durable
    // failure, raises a visible one, and the Turn is admitted anyway.
    const activation = await activateCompositionV1({
      generationId: input.compositionGenerationId,
      store: {
        read: (generationId) =>
          this.state.authority.composition.read(generationId),
        lastKnownGood: () => this.state.authority.composition.lastKnownGood(),
        commit: (generationId) =>
          this.state.authority.composition.commit(generationId),
        fail: (generationId, options) =>
          this.state.authority.composition.fail(generationId, options),
      },
      failures: this.state.authority.compositionFailures,
      host,
      signal: controller.signal,
      onFailure: (failure, fallback) =>
        this.recordCompositionFailureNotification(
          settings,
          input.command.runId,
          failure,
          fallback,
        ),
    });
    if (activation.status === "failed-closed") {
      // The durable record names what the Turn actually ran under.
      await this.state.authority.repinRun(
        input.command.runId,
        activation.fallback.generationId,
      );
    }
    // The exact resident Agent this Turn runs on, so a durable Stop reaches
    // that run and never a different one.
    const active = {
      runId: input.command.runId,
      sessionId: input.command.sessionId,
      turnId: input.command.runId,
      generationId: activation.mounted.generation.generationId,
      turnType: input.command.turnType ?? "chat",
      ...(input.command.subagentRole
        ? { subagentRole: input.command.subagentRole }
        : {}),
      mounted: activation.mounted,
      signal: controller.signal,
      cancel: (detail?: string) => {
        controller.abort("user");
        activation.mounted.runtime.agent.agent.cancel("user", detail);
      },
    };
    this.state.turn.set(active);
    try {
      const directTool = input.command.directTool;
      if (directTool) {
        // The page registry is the declaration, and it is checked again here
        // rather than trusted from the admitted command: a durable run replayed
        // after a deploy that withdrew a page must not still run its tool.
        if (
          !firstPartyPackageToolAllowedV1(directTool.packageId, directTool.name)
        ) {
          throw new Error(
            `Package "${directTool.packageId}" did not declare tool "${directTool.name}" for its pages`,
          );
        }
        return await executeDirectToolTurn({
          command: { ...input.command, directTool },
          previousEvents: input.previousEvents,
          composition: activation.mounted,
          admitEffect: (effect) =>
            this.admitRunEffect(
              input.identity,
              input.command.runId,
              input.command.sessionId,
              effect,
            ),
          signal: controller.signal,
        });
      }
      const ordinaryInput = await this.turnInputTextV1(input.command);
      const durableInput =
        activation.status === "failed-closed"
          ? compositionFailureTurnTextV1(ordinaryInput, {
              attemptedGenerationId: input.compositionGenerationId,
              ...(activation.generation
                ? { generation: activation.generation }
                : {}),
              ...(activation.failure ? { failure: activation.failure } : {}),
              quarantined: activation.quarantined,
            })
          : ordinaryInput;
      return await executeBotTurn({
        command: {
          ...input.command,
          text: durableInput,
        },
        previousEvents: input.previousEvents,
        composition: activation.mounted,
        resume: input.resume,
      });
    } finally {
      this.state.turn.clear(active);
    }
  }

  /**
   * The text one admitted Turn actually runs on.
   *
   * A chat Turn drains the pending-input queue first — "its outcome is
   * delivered to the Bot's next conversational Turn as durable input" — and
   * carries the hand-offs as a preamble ahead of the person's own words. The
   * drain is a durable receipt named by the run, so a resumed or recovered Turn
   * reads back exactly the inputs it drained rather than draining a second
   * time, and the recorded `model/request` stays reconstructible.
   *
   * An automation Turn drains nothing: a firing is not the conversation, and a
   * hand-off addressed to the parent must not be consumed by another firing.
   */
  private async turnInputTextV1(command: {
    runId: string;
    text: string;
    turnType?: TurnTypeV1;
  }): Promise<string> {
    if ((command.turnType ?? "chat") !== "chat") return command.text;
    const drained = await this.state.routineInbox.drainInto(command.runId);
    const preamble = pendingBotInputPreambleV1(drained);
    return preamble.length === 0
      ? command.text
      : `${preamble}\n${command.text}`;
  }

  /**
   * Cancels the Agent of one exact admitted run. A late Stop that names a run
   * this object is not executing changes nothing.
   */

  /**
   * The kernel's advisory interrupt, bound to this object's resident Agent.
   *
   * It runs only after the durable intent that justifies it is written, and it
   * changes nothing durable itself: a Turn whose Agent is no longer resident
   * is stopped by the effect fence on its next external effect instead, which
   * is the same outcome by a slower road.
   */
  private interruptActiveTurn(runId: string, reason: string): void {
    this.state.turn.interrupt(runId, reason);
  }

  /** The visible half of failing closed, through the Bot's notifications. */
  private async recordCompositionFailureNotification(
    settings: BotSettingsViewV1,
    runId: string,
    failure: CompositionFailureV1,
    fallback: CompositionGenerationV1,
  ): Promise<void> {
    await this.state.authority.recordNotification({
      notificationId: notificationIdV1(
        "composition-failure",
        failure.generationId,
        failure.attempt,
      ),
      runId,
      createdAt: failure.at,
      title: `${settings.profile.name} kept its last working Packages`,
      body: `Composition generation "${failure.generationId}" failed to activate at ${failure.phase} (attempt ${failure.attempt}); running "${fallback.generationId}" instead: ${failure.message}`.slice(
        0,
        240,
      ),
    });
  }

  /**
   * Everything a Bot isolate member needs. Package identity is attribution
   * only; Connections and model are resolved once for the Bot and every member
   * receives the same list.
   */
  private async isolateMountOptions(
    identity: BotIdentity,
    turn: {
      runId: string;
      sessionId: string;
      generationId: string;
      settings: BotSettingsViewV1;
    },
  ): Promise<ShellIsolateMountOptions | undefined> {
    const loader = this.state.env.BOT_PACKAGES;
    const artifacts = this.state.env.APPLICATION_ARTIFACTS;
    const exports = (
      this.state.ctx as unknown as {
        exports?: {
          BotCapabilities?: (options: {
            props: BotCapabilitiesPropsV1;
          }) => BotCapabilitiesStub;
        };
      }
    ).exports;
    if (!loader || !artifacts || !exports?.BotCapabilities) return undefined;
    const authority = await this.isolateAuthoritySnapshot(
      identity,
      turn.settings,
    );
    const mintCapabilities = exports.BotCapabilities;
    return {
      userId: identity.userId,
      runId: turn.runId,
      turnId: turn.runId,
      loader,
      artifacts: createR2PackageArtifactStore(artifacts),
      capabilitiesFor: (member) =>
        mintCapabilities({
          props: {
            userId: identity.userId,
            botId: identity.botId,
            runId: turn.runId,
            sessionId: turn.sessionId,
            turnId: turn.runId,
            generationId: turn.generationId,
            packageId: member.packageId,
            connections: structuredClone(authority.connections),
            ...(authority.model
              ? { model: structuredClone(authority.model) }
              : {}),
            memory: authority.memory,
            workspace: authority.workspace,
          },
        }),
      bindingDigest: await isolateBindingDigestV1({
        userId: identity.userId,
        botId: identity.botId,
        runId: turn.runId,
        connections: authority.connections,
        ...(authority.model ? { model: authority.model } : {}),
        compositionGenerationId: turn.generationId,
      }),
      compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
    };
  }

  private async isolateAuthoritySnapshot(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
  ): Promise<{
    connections: IsolateConnectionV1[];
    model?: IsolateModelBindingV1;
    memory: boolean;
    workspace: boolean;
  }> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const connections = user.connections.flatMap((connection) =>
      connection.state === "ready" && connection.generation
        ? [
            {
              connectionId: connection.connectionId,
              packageId: connection.packageId,
              connectionTypeId: connection.connectionTypeId,
              displayName: connection.displayName,
              generation: connection.generation,
              safeMetadata: structuredClone(connection.safeMetadata),
            } satisfies IsolateConnectionV1,
          ]
        : [],
    );
    const effective = resolveEffectiveBotModelV1({
      bot: settings,
      user,
      packages: executionPackagesV1(this.state.application),
    });
    const binding = effective.binding;
    const model =
      effective.model &&
      binding?.state === "ready" &&
      binding.connection?.generation &&
      binding.packageId &&
      binding.providerType
        ? {
            connectionId: binding.connection.connectionId,
            packageId: binding.packageId,
            provider: binding.providerType,
            providerModelId: effective.model.providerModelId,
            connectionGeneration: binding.connection.generation,
            ...(binding.connection.modelCatalog?.generation
              ? {
                  catalogGeneration: binding.connection.modelCatalog.generation,
                }
              : {}),
          }
        : undefined;
    return {
      connections,
      ...(model ? { model } : {}),
      memory: Boolean(this.state.env.MEMORY_WORKSPACE_FILES),
      workspace: Boolean(this.state.env.WORKSPACE_FILES),
    };
  }

  async isolateInvokeModel(
    identity: BotIdentity,
    input: {
      runId: string;
      sessionId: string;
      turnId: string;
      packageId: string;
      generationId: string;
      request: NormalizedModelRequest;
    },
  ): Promise<IsolateModelInvocationV1> {
    if (!this.activeIsolateTurn(input)) {
      return {
        status: "unavailable",
        reason: "the Package is not running in this Bot's active Composition",
      };
    }
    const settings = await readBotSettingsV1(this.state, identity);
    const authority = await this.isolateAuthoritySnapshot(identity, settings);
    let runtime:
      | {
          agentPackages: FoundationAgentPackage[];
          modelSelection: RuntimeModelSelection;
        }
      | undefined;
    if (authority.model) {
      try {
        runtime = await this.agentRuntime(identity, settings);
      } catch {
        runtime = undefined;
      }
    }
    return this.isolateCapabilities(
      {
        botId: identity.botId,
        packageId: input.packageId,
        generationId: input.generationId,
      },
      authority,
      runtime && authority.model
        ? {
            path: this.isolateModelPath(identity, runtime, input.generationId),
          }
        : undefined,
    ).invokeModel(input.request);
  }

  /**
   * The Bot's own tool dispatch, reached only by the `schedule` grant.
   *
   * Calling the Bot's tools is not a grant a plugin may name, so this is
   * private: `routine_manage` is the one tool a granted plugin reaches, and it
   * reaches it through `isolateSchedule`.
   */
  private async invokeBotToolForIsolateV1(input: {
    userId: string;
    botId: string;
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: { callId: string; name: string; input: unknown };
  }): Promise<IsolateScheduleOutcomeV1> {
    const request = input.request;
    const active = this.activeIsolateTurn(input);
    if (!active) {
      return {
        status: "unavailable",
        reason: "the Package is not running in this Bot's active Composition",
      };
    }
    const session = active.mounted.runtime.services.sessions.get(
      input.sessionId,
    );
    if (!session) {
      return {
        status: "unavailable",
        reason: "the active Session is unavailable",
      };
    }
    const started = session.events.findLast(
      (event) => event.type === "step/start",
    );
    const ended = session.events.findLast((event) => event.type === "step/end");
    if (
      started?.type !== "step/start" ||
      (ended?.type === "step/end" &&
        ended.turn === started.turn &&
        ended.step === started.step)
    ) {
      return {
        status: "unavailable",
        reason: "the active step is unavailable",
      };
    }
    const effectId = await this.isolateToolEffectId(
      input.packageId,
      request.callId,
    );
    const priorCall = session.events.find(
      (event) =>
        event.type === "package/tool-call" && event.effectId === effectId,
    );
    const priorResult = session.events.find(
      (event) =>
        event.type === "package/tool-result" && event.effectId === effectId,
    );
    if (priorResult?.type === "package/tool-result") {
      return {
        status: "completed",
        content: priorResult.content,
        isError: priorResult.isError,
      };
    }
    if (
      priorCall?.type === "package/tool-call" &&
      (priorCall.packageId !== input.packageId ||
        priorCall.callId !== request.callId ||
        priorCall.name !== request.name ||
        JSON.stringify(priorCall.input) !== JSON.stringify(request.input))
    ) {
      return {
        status: "unavailable",
        reason: "the Package tool idempotency key was reused",
      };
    }
    if (!priorCall) {
      session.append({
        type: "package/tool-call",
        turn: started.turn,
        step: started.step,
        effectId,
        packageId: input.packageId,
        callId: request.callId,
        name: request.name,
        input: request.input,
      });
      await session.flush();
    }
    const call = {
      id: request.callId,
      name: request.name,
      input: request.input,
    };
    const context = {
      botId: input.botId,
      agentId: input.botId,
      sessionId: input.sessionId,
      compositionGenerationId: input.generationId,
      effectId,
      toolCall: call,
      turnType: active.turnType,
      ...(active.subagentRole ? { subagentRole: active.subagentRole } : {}),
      signal: active.signal,
    };
    const preparation = await active.mounted.runtime.services.tools.prepare(
      call,
      context,
    );
    let result: { content: string; isError: boolean };
    if (preparation.kind === "denied") {
      result = preparation.result;
    } else {
      const admitted = await this.admitRunEffect(
        { userId: input.userId, botId: input.botId },
        input.runId,
        input.sessionId,
        { kind: "tool", effectId },
      );
      if (!admitted) {
        result = {
          content: "The tool effect was stopped before it started.",
          isError: true,
        };
      } else {
        // A call the object had already started is dispatched again under the
        // same effect id rather than investigated.
        result = await active.mounted.runtime.services.tools.executePrepared(
          preparation,
          context,
        );
      }
    }
    session.append({
      type: "package/tool-result",
      turn: started.turn,
      step: started.step,
      effectId,
      packageId: input.packageId,
      callId: request.callId,
      name: request.name,
      content: result.content,
      isError: result.isError,
    });
    await session.flush();
    return {
      status: "completed",
      content: result.content,
      isError: result.isError,
    };
  }

  async isolateMemoryRead(input: {
    userId: string;
    botId: string;
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: unknown;
  }): Promise<IsolateMemoryOutcomeV1> {
    const request = decodeIsolateMemoryReadRequestV1(input.request);
    const memory = await this.isolateMemoryHost(input, request);
    if (!memory)
      return { status: "unavailable", reason: "Memory is unavailable" };
    return {
      status: "available",
      value: await memory.store.read(
        memoryScopeRootV1(request.scope, memory.owner, request.projectId),
      ),
    };
  }

  async isolateMemoryWrite(input: {
    userId: string;
    botId: string;
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: unknown;
  }): Promise<IsolateMemoryOutcomeV1> {
    const request = decodeIsolateMemoryWriteRequestV1(input.request);
    const memory = await this.isolateMemoryHost(input, request);
    if (!memory?.writer) {
      return { status: "unavailable", reason: "Memory is unavailable" };
    }
    return {
      status: "available",
      value: await memory.store.write({
        root: memoryScopeRootV1(request.scope, memory.owner, request.projectId),
        tier: request.tier ?? "log",
        fact: request.fact,
        writer: {
          kind: "bot",
          botId: input.botId,
          ...memory.writer,
        },
      }),
    };
  }

  async isolateMemoryForget(input: {
    userId: string;
    botId: string;
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: unknown;
  }): Promise<IsolateMemoryOutcomeV1> {
    const request = decodeIsolateMemoryWriteRequestV1(input.request);
    const memory = await this.isolateMemoryHost(input, request);
    if (!memory?.writer) {
      return { status: "unavailable", reason: "Memory is unavailable" };
    }
    return {
      status: "available",
      value: await memory.store.forget({
        root: memoryScopeRootV1(request.scope, memory.owner, request.projectId),
        fact: request.fact,
        writer: {
          kind: "bot",
          botId: input.botId,
          ...memory.writer,
        },
      }),
    };
  }

  // --- Applets -------------------------------------------------------------

  /**
   * `ctx.applets` for one Bot, or `undefined` when this host cannot reach
   * Applets at all — no instance namespace, no artifact bucket, or no
   * Workspace. An absent capability is an `unavailable` outcome at the isolate
   * boundary, never a thrown error inside Bot code.
   */
  private appletCapabilityHost(
    identity: BotIdentity,
    active?: ActiveTurnV1,
  ): AppletCapabilityHostV1 | undefined {
    const namespace = this.state.env.APPLET_STATES;
    const artifacts = this.state.env.APPLICATION_ARTIFACTS;
    const workspace = this.state.env.WORKSPACE_FILES;
    if (!namespace || !artifacts || !workspace) return undefined;
    const bucket = artifacts;
    return createAppletCapabilityHostV1({
      userId: identity.userId,
      botId: identity.botId,
      storage: {
        get: (key) => this.state.ctx.storage.get(key),
        put: (entries) => this.state.ctx.storage.put(entries),
      },
      directory: this.appletUserDirectory(identity),
      instanceFor: createAppletInstanceBindingV1(namespace, identity.userId),
      artifacts: {
        putPackageArtifact: async (contentHash, module) => {
          await bucket.put(`packages/${contentHash}.mjs`, module, {
            httpMetadata: { contentType: "application/javascript" },
          });
        },
        putPackageUiArtifact: async (contentHash, html) => {
          await bucket.put(`packages/${contentHash}.html`, html, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          });
        },
      },
      workspace,
      // A publish reads `dist/` from the store, and `applet build` wrote it on
      // the Computer moments earlier in this very Turn — before the Turn's own
      // `turn-end` push. So the one root is reconciled first, through the one
      // sanctioned extra caller of the Computer's sync. It wakes nothing new: a
      // User with no Computer assignment has no root to pull, and the Bot that
      // just built on its Computer has it open already.
      syncSourceRootNow: active
        ? async (appletId) => {
            const root = active.mounted.runtime.services;
            const computerIdentity = { userId: identity.userId };
            if (!root.computers.assignment(computerIdentity)) {
              return { status: "skipped", detail: "" } as const;
            }
            const session = root.sessions.get(active.sessionId);
            const started = session?.events.findLast(
              (event) => event.type === "step/start",
            );
            const turn = started?.type === "step/start" ? started.turn : 0;
            const computer = await root.computers.open(
              computerIdentity,
              { botId: identity.botId },
              { signal: active.signal },
            );
            const summary = await syncWorkspaceRootNowV1({
              computer,
              sessions: root.sessions,
              sessionId: active.sessionId,
              turn,
              root: appletsSourceRootV1(identity.userId),
              requiredPaths: APPLET_DIST_FILES_V1.map(
                (path) => `${appletId}/${path}`,
              ),
              signal: active.signal,
            });
            return {
              status: summary.status,
              detail: summary.detail,
              ...(summary.required ? { required: summary.required } : {}),
            };
          }
        : undefined,
      composition: {
        current: () => this.state.authority.composition.current(),
        lastKnownGood: () => this.state.authority.composition.lastKnownGood(),
        propose: (generation, options) =>
          this.state.authority.composition.propose(generation, options),
      },
    });
  }

  /**
   * The Applets feature's seam for one admitted Turn, or `undefined` when this
   * host cannot reach Applets at all.
   *
   * The capability host is built per call rather than once: it closes over the
   * Turn's mounted runtime, which is what lets a publish pull the Applet's
   * `dist/` off the Computer, and that runtime does not exist yet when a Turn's
   * features are assembled.
   */
  private appletsRuntimeHost(
    identity: BotIdentity,
    turn: { sessionId: string; runId: string; turnId: string },
  ): AppletsRuntimeHostV1 | undefined {
    const files = this.state.env.WORKSPACE_FILES;
    if (
      !this.state.env.APPLET_STATES ||
      !this.state.env.APPLICATION_ARTIFACTS ||
      !files
    ) {
      return undefined;
    }
    const capability = (): AppletCapabilityHostV1 => {
      const host = this.appletCapabilityHost(identity, this.state.turn.current);
      if (!host) throw new Error("Applets are unavailable");
      return host;
    };
    return {
      applets: {
        list: () => capability().list(),
        create: (input, scope) => capability().create(input, scope),
        publish: (input, scope) => capability().publish(input, scope),
        revert: (input, scope) => capability().revert(input, scope),
        delete: (input) => capability().delete(input),
        focus: (input) => capability().focus(input),
        generations: (input) => capability().generations(input),
        readFocused: () => capability().readFocused(),
      },
      turn,
      writeSource: async (input) => {
        const outcome = await files.write({
          path: appletSourceFilePathV1(
            identity.userId,
            input.appletId,
            input.path,
          ),
          bytes: input.bytes,
          writer: {
            kind: "bot",
            botId: identity.botId,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            runId: turn.runId,
          },
          expectedGenerationId: null,
          mediaType: input.mediaType,
        });
        if (outcome.status !== "ok") {
          throw new Error(
            `the Applet was created but "${input.path}" could not be written: ${outcome.status}`,
          );
        }
      },
    };
  }

  /** The User Durable Object's Applet directory, decoded on arrival. */
  private appletUserDirectory(identity: BotIdentity): AppletUserDirectoryV1 {
    const id = this.state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker
    // types do not expose its Applet directory RPC surface.
    const rpc = this.state.env.USER_CONFIGURATIONS.get(id) as unknown as {
      listApplets(input: unknown): Promise<unknown>;
      readAppletCompositionInput(input: unknown): Promise<unknown>;
      createApplet(input: unknown): Promise<unknown>;
      recordAppletGeneration(input: unknown): Promise<unknown>;
      deleteApplet(input: unknown): Promise<unknown>;
    };
    const userId = identity.userId;
    return {
      async list() {
        const answer = rpcJsonSnapshotV1(
          await rpc.listApplets({ schemaVersion: 1, userId }),
        ) as { revision?: unknown; applets?: unknown };
        return {
          revision: Number(answer.revision ?? 0),
          applets: Array.isArray(answer.applets)
            ? answer.applets.map((applet) => decodeAppletSummaryV1(applet))
            : [],
        };
      },
      async compositionInput() {
        const answer = rpcJsonSnapshotV1(
          await rpc.readAppletCompositionInput({ schemaVersion: 1, userId }),
        ) as { revision?: unknown; applets?: unknown };
        return {
          revision: Number(answer.revision ?? 0),
          applets: (Array.isArray(answer.applets) ? answer.applets : []).map(
            (applet) => {
              const entry = applet as Record<string, unknown>;
              return {
                appletId: String(entry.appletId),
                generationId: String(entry.generationId),
                tools: (Array.isArray(entry.tools) ? entry.tools : []).map(
                  (tool, index) =>
                    decodeAppletToolDeclarationV1(
                      tool,
                      `Applet tool declaration[${index}]`,
                    ),
                ),
                provenance: decodeAppletProvenanceV1(entry.provenance),
              };
            },
          ),
        };
      },
      async create(input) {
        return decodeAppletSummaryV1(
          rpcJsonSnapshotV1(
            await rpc.createApplet({
              schemaVersion: 1,
              userId,
              displayName: input.displayName,
              provenance: input.provenance,
            }),
          ),
        );
      },
      async recordGeneration(input) {
        return decodeAppletSummaryV1(
          rpcJsonSnapshotV1(
            await rpc.recordAppletGeneration({
              schemaVersion: 1,
              userId,
              appletId: input.appletId,
              generationId: input.generationId,
              tools: input.tools,
            }),
          ),
        );
      },
      async delete(appletId) {
        return decodeAppletSummaryV1(
          rpcJsonSnapshotV1(
            await rpc.deleteApplet({ schemaVersion: 1, userId, appletId }),
          ),
        );
      },
    };
  }

  /** The Session's focused Applet, as the shell and its route read it. */
  async readFocusedApplet(identity: BotIdentity): Promise<FocusedAppletV1> {
    await this.validateIdentity(identity);
    const stored =
      await this.state.ctx.storage.get<unknown>(APPLET_FOCUSED_KEY);
    return stored === undefined
      ? {
          schemaVersion: 1,
          appletId: null,
          changedAt: new Date(0).toISOString(),
        }
      : decodeFocusedAppletV1(stored);
  }

  async setFocusedApplet(
    identity: BotIdentity,
    appletId: string | null,
  ): Promise<FocusedAppletV1> {
    await this.validateIdentity(identity);
    const focused = decodeFocusedAppletV1({
      schemaVersion: 1,
      appletId,
      changedAt: new Date().toISOString(),
    });
    await this.state.ctx.storage.put({ [APPLET_FOCUSED_KEY]: focused });
    return focused;
  }

  /**
   * Resolve the User's Applet directory into this Bot's next Composition
   * generation, before a Turn is admitted.
   *
   * Outside the admission transaction on purpose: the pin is taken in one
   * storage transaction, which cannot make a cross-object call. A publish or a
   * delete therefore activates at the *next* admitted Turn, and an in-flight
   * Turn keeps the set it pinned. A directory that cannot be read leaves the
   * Bot on the generation it has; an Applet change is never a reason a Turn
   * cannot start.
   */
  private async resolveAppletComposition(
    identity: BotIdentity,
    command: OwnedBotTurnCommand,
  ): Promise<void> {
    if (!this.state.env.APPLET_STATES) return;
    try {
      await resolveAppletCompositionV1({
        directory: this.appletUserDirectory(identity),
        composition: {
          current: () => this.state.authority.composition.current(),
          propose: (generation, options) =>
            this.state.authority.composition.propose(generation, options),
        },
        storage: {
          get: (key) => this.state.ctx.storage.get(key),
          put: (entries) => this.state.ctx.storage.put(entries),
        },
        origin: {
          kind: "bot-authored",
          runId: command.runId,
          sessionId: command.sessionId,
          turnId: command.runId,
        },
      });
    } catch {
      // Visible through the Applet's own failure records; never a wedged Turn.
    }
  }

  async isolateWorkspaceRead(
    input: IsolateCallScopeV1,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    const active = this.activeIsolateTurn(input);
    const files = this.state.env.WORKSPACE_FILES;
    if (!active || !files) {
      return { status: "unavailable", reason: "Workspace is unavailable" };
    }
    const path = this.isolateWorkspacePath(
      input.userId,
      decodeIsolateWorkspacePathV1(input.request),
    );
    return { status: "available", value: await files.read(path) };
  }

  async isolateWorkspaceList(
    input: IsolateCallScopeV1,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    const active = this.activeIsolateTurn(input);
    const files = this.state.env.WORKSPACE_FILES;
    if (!active || !files) {
      return { status: "unavailable", reason: "Workspace is unavailable" };
    }
    const request = decodeIsolateWorkspaceListRequestV1(input.request);
    const root = this.isolateWorkspaceRoot(input.userId, request.root);
    return {
      status: "available",
      value: await files.list({
        root,
        ...(request.prefix === undefined ? {} : { prefix: request.prefix }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      }),
    };
  }

  async isolateWorkspaceStat(
    input: IsolateCallScopeV1,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    const active = this.activeIsolateTurn(input);
    const files = this.state.env.WORKSPACE_FILES;
    if (!active || !files) {
      return { status: "unavailable", reason: "Workspace is unavailable" };
    }
    const path = this.isolateWorkspacePath(
      input.userId,
      decodeIsolateWorkspacePathV1(input.request),
    );
    return { status: "available", value: await files.stat(path) };
  }

  async isolateWorkspaceWrite(
    input: IsolateCallScopeV1,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    const active = this.activeIsolateTurn(input);
    const files = this.state.env.WORKSPACE_FILES;
    if (!active || !files) {
      return { status: "unavailable", reason: "Workspace is unavailable" };
    }
    const request = decodeIsolateWorkspaceWriteRequestV1(input.request);
    return {
      status: "available",
      value: await files.write({
        path: this.isolateWorkspacePath(input.userId, request.path),
        bytes: request.bytes,
        writer: this.isolateWorkspaceWriter(input),
        expectedGenerationId: request.expectedGenerationId,
        ...(request.mediaType ? { mediaType: request.mediaType } : {}),
      }),
    };
  }

  async isolateWorkspaceDelete(
    input: IsolateCallScopeV1,
  ): Promise<IsolateWorkspaceOutcomeV1> {
    const active = this.activeIsolateTurn(input);
    const files = this.state.env.WORKSPACE_FILES;
    if (!active || !files) {
      return { status: "unavailable", reason: "Workspace is unavailable" };
    }
    const request = decodeIsolateWorkspaceDeleteRequestV1(input.request);
    return {
      status: "available",
      value: await files.delete({
        path: this.isolateWorkspacePath(input.userId, request.path),
        writer: this.isolateWorkspaceWriter(input),
        expectedGenerationId: request.expectedGenerationId,
      }),
    };
  }

  async isolateConnection(
    input: IsolateCallScopeV1,
  ): Promise<IsolateConnectionOutcomeV1> {
    if (!this.activeIsolateTurn(input) || typeof input.request !== "string") {
      return { status: "unavailable", reason: "the Connection is unavailable" };
    }
    const identity = { userId: input.userId, botId: input.botId };
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: input.userId,
    });
    const connection = user.connections.find(
      (candidate) =>
        candidate.connectionId === input.request &&
        candidate.state === "ready" &&
        candidate.generation,
    );
    if (!connection?.generation) {
      await this.state.authority.recordNotification({
        notificationId: notificationIdV1(
          "package-connection-unavailable",
          input.runId,
          input.packageId,
          input.request,
        ),
        runId: input.runId,
        createdAt: new Date().toISOString(),
        title: "Connection unavailable",
        body: `Package "${input.packageId}" could not use Connection "${input.request}". The User can enable or repair it on Connections.`.slice(
          0,
          240,
        ),
      });
      return { status: "unavailable", reason: "the Connection is unavailable" };
    }
    return {
      status: "available",
      leaseId: crypto.randomUUID(),
      connectionId: connection.connectionId,
      generation: connection.generation,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  async isolateSchedule(
    input: IsolateCallScopeV1,
  ): Promise<IsolateScheduleOutcomeV1> {
    const request = decodeIsolateScheduleRequestV1(input.request);
    return this.invokeBotToolForIsolateV1({
      ...input,
      request: {
        callId: request.callId,
        name: "routine_manage",
        input: request.input,
      },
    });
  }

  private async isolateMemoryHost(
    input: IsolateCallScopeV1,
    request: { scope: "bot" | "user" | "project"; projectId?: string },
  ) {
    if (!this.activeIsolateTurn(input)) return undefined;
    const host = createBotMemoryHost(
      { userId: input.userId, botId: input.botId },
      {
        runId: input.runId,
        sessionId: input.sessionId,
        turnId: input.turnId,
      },
      this.state.env,
    );
    if (!host) return undefined;
    if (request.scope === "project") {
      const projects = await host.projects?.joined();
      if (
        !request.projectId ||
        !projects?.some((project) => project.projectId === request.projectId)
      ) {
        return undefined;
      }
    }
    return host;
  }

  private activeIsolateTurn(input: {
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
  }) {
    const active = this.state.turn.current;
    if (
      !active ||
      active.runId !== input.runId ||
      active.sessionId !== input.sessionId ||
      active.turnId !== input.turnId ||
      active.generationId !== input.generationId ||
      !active.mounted.generation.members.some(
        (member) => member.packageId === input.packageId && member.artifact,
      )
    ) {
      return undefined;
    }
    return active;
  }

  private async isolateToolEffectId(
    packageId: string,
    callId: string,
  ): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${packageId}\0${callId}`),
    );
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `package-tool:${hex}`;
  }

  private isolateWorkspaceRoot(
    userId: string,
    root: ReturnType<typeof decodeIsolateWorkspacePathV1>["root"],
  ) {
    return decodeWorkspaceRootV1(
      root.kind === "user-instructions"
        ? { kind: root.kind, userId }
        : root.kind === "bot-instructions"
          ? { kind: root.kind, userId, botId: root.botId }
          : {
              kind: root.kind,
              userId,
              packageId: root.packageId,
              rootId: root.rootId,
            },
    );
  }

  private isolateWorkspacePath(
    userId: string,
    path: ReturnType<typeof decodeIsolateWorkspacePathV1>,
  ): WorkspacePathV1 {
    return decodeWorkspacePathV1({
      root: this.isolateWorkspaceRoot(userId, path.root),
      path: path.path,
    });
  }

  private isolateWorkspaceWriter(input: IsolateCallScopeV1) {
    return {
      kind: "bot" as const,
      botId: input.botId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.runId,
    };
  }

  private isolateCapabilities(
    scope: {
      botId: string;
      packageId: string;
      generationId: string;
    },
    authority: {
      connections: readonly IsolateConnectionV1[];
      model?: IsolateModelBindingV1;
      memory: boolean;
      workspace: boolean;
    },
    model?: { path: IsolateModelPath },
  ): IsolateCapabilityHost {
    return createIsolateCapabilityHost({
      storage: {
        put: (key, value) => this.state.ctx.storage.put(key, value),
        list: (options) => this.state.ctx.storage.list(options),
      },
      botId: scope.botId,
      packageId: scope.packageId,
      generationId: scope.generationId,
      connections: authority.connections,
      ...(authority.model ? { modelBinding: authority.model } : {}),
      ...(model ? { modelPath: model.path } : {}),
      memory: authority.memory,
      workspace: authority.workspace,
    });
  }

  /**
   * Streams through the pinned Composition's mounted `ctx.llm` — the same
   * provider path a Turn uses, so whichever provider Plugin serves the request
   * is the one that takes the credential lease.
   */
  private isolateModelPath(
    identity: BotIdentity,
    runtime: {
      agentPackages: FoundationAgentPackage[];
      modelSelection: RuntimeModelSelection;
    },
    generationId: string,
  ): IsolateModelPath {
    const state = this.state;
    return {
      async *stream(request, signal) {
        const generation = await state.authority.composition.read(generationId);
        if (!generation) {
          throw new Error(
            `isolate model invocation pins unknown Composition generation "${generationId}"`,
          );
        }
        const composition = await createShellCompositionHost({
          botId: identity.botId,
          sessionId: `isolate-model:${request.requestId}`,
          sessionEvents: [],
          agentPackages: runtime.agentPackages,
          modelSelection: runtime.modelSelection,
          admitEffect: () => Promise.resolve(true),
        }).mount(generation, signal);
        try {
          yield* composition.runtime.services.llm.stream(request, signal);
        } finally {
          await composition.dispose();
        }
      },
    };
  }

  /** The generation this Bot starts on: empty until it installs or authors. */
  private async bootstrapComposition() {
    return bootstrapCompositionGeneration(new Date().toISOString());
  }

  private async resolveAdmissionSnapshot(
    command: OwnedBotTurnCommand,
  ): Promise<BotSettingsViewV1> {
    return (await this.resolveExecutionContext(command)).settings;
  }

  private async admittedSnapshot(
    transaction: DurableObjectTransaction,
    resolved: BotSettingsViewV1,
  ): Promise<BotSettingsViewV1> {
    const stored = await transaction.get<unknown>(BOT_CONFIGURATION_KEY);
    return stored === undefined
      ? resolved
      : decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
  }

  private async scheduledDeadlines(
    transaction: DurableObjectTransaction,
  ): Promise<number[]> {
    // A pending approval is a deadline like any other: the object already owns
    // one alarm, and expiry rides it rather than inventing a second clock.
    const approvals = await transaction.list<unknown>({
      prefix: APPROVAL_PREFIX,
    });
    const expiries: number[] = [];
    for (const stored of approvals.values()) {
      const approval = decodeApprovalRecordV1(stored);
      if (approval.decision !== "pending") continue;
      expiries.push(Date.parse(approval.expiresAt));
    }
    return [
      ...(await this.state.routineScheduler.deadlines(transaction)),
      ...expiries.filter((at) => Number.isFinite(at)),
      // A dispatched task's 30-minute lifetime, and a child's own owed Turn,
      // both ride the one alarm this object already has: the parent reconciles
      // a child that never reported, and the child runs the Turn it was handed
      // on its next alarm rather than on a floating promise.
      ...(await this.subagentDeadlines(transaction)),
      ...(this.state.hostScheduled.deadlines
        ? await this.state.hostScheduled.deadlines(transaction)
        : []),
    ];
  }

  /**
   * The deadlines subagent work contributes to this object's one alarm.
   *
   * Two kinds, and which one an object has says which side of the dispatch it
   * is on. A *parent* has task records whose `deadlineAt` is when it must go
   * and ask what became of a child. A *child* has one task context, and while
   * that context is `queued` its deadline is *now*: accepting a task arms the
   * alarm, and the alarm is what runs the Turn.
   */
  private async subagentDeadlines(
    transaction: DurableObjectTransaction,
  ): Promise<number[]> {
    const deadlines: number[] = [];
    const active = await transaction.list<unknown>({
      prefix: TASK_ACTIVE_PREFIX,
    });
    for (const key of active.keys()) {
      const stored = await transaction.get<unknown>(
        taskKeyV1(key.slice(TASK_ACTIVE_PREFIX.length)),
      );
      if (stored === undefined) continue;
      const at = Date.parse((stored as TaskRecordV1).deadlineAt);
      if (Number.isFinite(at)) deadlines.push(at);
    }
    const contexts = await transaction.list<unknown>({
      prefix: TASK_CONTEXT_PREFIX,
    });
    for (const stored of contexts.values()) {
      const context = decodeSubagentTaskContextV1(stored);
      if (context.status === "queued") deadlines.push(Date.now());
    }
    return deadlines;
  }

  private async deferScheduledWork(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    // A Routine's deadline is a debt, so the scheduler holds it rather than
    // moving it while other durable work remains in flight.
    await this.state.routineScheduler.defer(transaction);
    await this.state.hostScheduled.defer?.(transaction);
  }

  private async settleScheduledWork(): Promise<void> {
    // The re-arm is in a `finally` because it is the object's only way back.
    // The alarm that woke this object has already been consumed by the
    // platform; a throw in any one settler used to skip the re-arm, and then
    // nothing — no Routine, no approval expiry, no owed subagent Turn — ever
    // woke this Bot again except by a caller's luck. One producer failing must
    // cost that producer its pass, never the clock.
    try {
      await this.settleRoutineFirings();
      await runOwedSubagentTurns(this.state);
      await reconcileOverdueTasks(this.state);
      await this.expireDueApprovals();
      await this.replayPendingWakeNotifications();
      await this.state.hostScheduled.settle?.();
    } finally {
      await this.state.ctx.storage.transaction((transaction) =>
        this.state.authority.refreshRecoveryAlarm(transaction),
      );
    }
  }

  /**
   * Drain the Routines that are owed a firing.
   *
   * The scheduler mints the durable firing; this closure is the only thing that
   * admits a Turn for it, and it does so with `authority.run` — a direct call
   * inside the Durable Object. `turnType: "automation"` and the recorded origin
   * come from `routineTurnCommandV1`, and the fire id *is* the run id, so a
   * retry after eviction is refused by the kernel's own idempotency rather than
   * running the Routine a second time.
   */
  private async settleRoutineFirings(): Promise<void> {
    const identity = await this.state.authority.readDurableIdentity();
    if (!identity) return;
    // A run already occupies the object. `alarm()` defers before it reaches
    // here whenever the Turn is executing in this isolate, but a durable active
    // run outlives an eviction, and admitting a firing against one would burn
    // the occurrence on an error instead of holding the debt.
    //
    // Returning was not enough: the debt stayed past-due, so `deadlines()`
    // re-armed on a moment already gone and the alarm spun straight back into
    // this same bail-out — which is how a Routine racing a long chat Turn
    // failed once a minute for ever. The hold is what turns the bail-out into
    // a deferral: `dueAt` does not move, so the firing still lands.
    if (await this.state.authority.readActiveRunId()) {
      await this.state.ctx.storage.transaction((transaction) =>
        this.state.routineScheduler.defer(transaction),
      );
      return;
    }
    await this.state.routineScheduler.settle(async (fire) => {
      const outcome = await this.runOneFiring(identity, fire);
      await this.notifyFailedFiring(identity, fire, outcome);
      return outcome;
    });
  }

  private async runOneFiring(
    identity: BotIdentity,
    fire: RoutineFireV1,
  ): Promise<RoutineFireOutcomeV1> {
    try {
      await this.state.authority.run(
        routineTurnCommandV1(identity, fire, new Date().toISOString()),
      );
    } catch (error) {
      return routineFireOutcomeV1(
        await this.state.authority.readStoredRun(fire.fireId),
        error,
      );
    }
    return routineFireOutcomeV1(
      await this.state.authority.readStoredRun(fire.fireId),
    );
  }

  /**
   * Tell the person that a firing did not work.
   *
   * The scheduler has already written the durable completion-inbox entry in
   * the transaction that settled the firing; this is the delivery half — the
   * same seam a hand-off uses, so a Routine that breaks reaches the same place
   * a Routine that finishes does instead of only a `failed` row nobody opens.
   * `notifications.enabled` is honoured: it is the mute on updates, and a
   * broken Routine is an update, not a decision the Bot is waiting on.
   */
  private async notifyFailedFiring(
    identity: BotIdentity,
    fire: RoutineFireV1,
    outcome: RoutineFireOutcomeV1,
  ): Promise<void> {
    if (outcome.status === "ok") return;
    const settings = await this.getSettings(identity);
    if (!settings.notifications.enabled) return;
    await this.state.authority.recordNotification({
      // The same id shape the completion path uses, so one firing is one
      // intent however many times the alarm retries it.
      notificationId: notificationIdV1("routine-failed", fire.fireId),
      runId: fire.fireId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} could not run a Routine`,
      // The same sentence the inbox entry carries. A notification is the one
      // surface a person reads without asking for it, so it is the last place
      // a kernel invariant belongs.
      body: routineFailureSentenceV1(outcome.summary).slice(0, 240),
    });
  }
  // -------------------------------------------------------------------------
  // Subagents. The parent Bot Durable Object is the authority; the Subagent
  // Durable Object is an execution host with no authority of its own.
  // -------------------------------------------------------------------------

  /** Narrow RPC for the User-wide agent-lane concurrency lease. */
  private agentTurnSlots(identity: BotIdentity) {
    const id = this.state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    const rpc = this.state.env.USER_CONFIGURATIONS.get(id) as unknown as {
      reserveAgentTurnSlot(input: unknown): Promise<unknown>;
      releaseAgentTurnSlot(input: unknown): Promise<unknown>;
    };
    return {
      reserve: async (request: unknown) =>
        decodeAgentTurnSlotReceiptV1(await rpc.reserveAgentTurnSlot(request)),
      release: async (request: unknown) => {
        await rpc.releaseAgentTurnSlot(request);
      },
    };
  }

  private async agentRuntime(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
    admittedRequest?: NormalizedModelRequest,
    turn?: {
      runId: string;
      turnId: string;
      sessionId: string;
      fromBotName: string;
      /**
       * The generation this Turn pinned, and the type it was admitted as. A
       * dispatched subagent runs on the generation its parent pinned, and the
       * models it may be given are narrowed by the turn type — so both travel
       * with the Turn rather than being resolved a second time.
       */
      compositionGenerationId?: string;
      turnType?: TurnTypeV1;
      /** The subagent role, on a `subagent` Turn that was admitted with one. */
      subagentRole?: string;
      /** The task a child Turn is running, in a Subagent Durable Object. */
      subagentTaskId?: string;
    },
  ): Promise<{
    agentPackages: FoundationAgentPackage[];
    capabilities: EnabledCapabilityV1[];
    modelSelection: RuntimeModelSelection;
  }> {
    const userConfiguration = this.userConfiguration(identity);
    const user = await userConfiguration.readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const packageDefinitions = executionPackagesV1(this.state.application);
    const plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: packageDefinitions,
    });
    // The durable roots this User's enabled Packages declare, read from the
    // same installations the Composition is resolved from. Handed to the
    // Computer sync below; nothing else reads it.
    const packageRoots = declaredPackageRootsV1({
      installations: user.packages,
      packages: this.state.application.packages,
    });
    const readSecret = (name: string) => {
      // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
      const value = (this.state.env as unknown as Record<string, unknown>)[
        name
      ];
      return typeof value === "string" ? value : undefined;
    };
    const authorizeEnabledConnection = (
      capability: EnabledCapabilityV1,
    ): Promise<ConnectionView> => {
      const enabled = plan.capabilities.some(
        (candidate) =>
          candidate.packageId === capability.packageId &&
          candidate.capabilityId === capability.capabilityId &&
          candidate.connectionId === capability.connectionId,
      );
      const connection = user.connections.find(
        (candidate) =>
          candidate.connectionId === capability.connectionId &&
          candidate.packageId === capability.packageId &&
          candidate.state === "ready",
      );
      if (!enabled || !connection) {
        return Promise.reject(
          new Error("Enabled effect is no longer authorized"),
        );
      }
      return Promise.resolve(structuredClone(connection));
    };
    // The Package-level settings this User holds, resolved against the manifest
    // of the Composition this Turn is pinned to. They come from the same `user`
    // read the rest of this Composition uses, so a value the User changed is
    // picked up when the next Turn resolves its Composition and never inside
    // one already running.
    const packageSettings = (
      packageId: string,
    ): Record<string, PackageSettingValueV1> => {
      const installation = user.packages.find(
        (candidate) => candidate.packageId === packageId,
      );
      const declared = this.state.application.packages.find(
        (definition) => definition.id === packageId,
      );
      return resolvePackageSettingValuesV1(
        [...(declared?.settings ?? [])],
        installation?.values,
      );
    };
    const primitivePackageSettings = (
      packageId: string,
    ): Record<string, string | number | boolean> =>
      Object.fromEntries(
        Object.entries(packageSettings(packageId)).filter(
          (entry): entry is [string, string | number | boolean] =>
            typeof entry[1] !== "object",
        ),
      );
    // The `image.model` Package setting, already checked against the enum the
    // Image Package's definition declares.
    const configuredImageModel = packageSettings("image").model;
    // Row 57g. Resolved before the Composition is built, because the answer
    // decides whether a Package is mounted at all: a feature gate that let the
    // tools exist and refuse would still have told the model they were there.
    // The registry is read only when the setting is on.
    const machineSeam = turn ? this.machineSeam(identity) : undefined;
    const messagesGate = machineSeam
      ? await resolveBotMachineMessagesGateV1(
          primitivePackageSettings("machine-messages"),
          () => machineSeam.list(),
        )
      : ({ status: "off" } as const);
    // Filled in once this Turn's model binding is resolved, below. The tool
    // and the prompt section both read it lazily, from inside the Turn.
    const subagentModels: SubagentModelOptionV1[] = [];
    const resolvedAgentPackages: FoundationAgentPackage[] = [
      ...this.state.application.runtime.hosted({
        userId: identity.userId,
        readSecret,
        ...(turn
          ? {
              skills: createBotSkillsHost(identity, turn, this.state.env),
            }
          : {}),
        ...(turn
          ? { memory: createBotMemoryHost(identity, turn, this.state.env) }
          : {}),
        // A Bot generates an image only inside an admitted Turn, whose Session
        // and Turn the Workspace write names as its writer.
        ...(turn
          ? {
              image: createBotImageHost(
                identity,
                turn,
                this.state.env,
                typeof configuredImageModel === "string"
                  ? configuredImageModel
                  : undefined,
              ),
            }
          : {}),
        // A Bot builds an Applet only inside an admitted Turn: the publish is
        // a durable effect whose intent record has to name the Session and Turn
        // that asked for it, and the scaffold write names the same writer.
        ...(turn
          ? (() => {
              const applets = this.appletsRuntimeHost(identity, turn);
              return applets ? { applets } : {};
            })()
          : {}),
        // A Bot changes its own identity, or adds a Bot to its User's flock,
        // only inside an admitted Turn whose Session and Turn the write names.
        ...(turn
          ? {
              botSelfManagement: createBotSelfManagementHost(identity, turn, {
                readSettings: (target) => this.getSettings(target),
                executeConfiguration: (target, command) =>
                  this.executeConfigurationCommand(target, command),
                listBots: (userId) =>
                  this.userConfiguration(identity).listBots(userId),
                createBot: (userId, command) =>
                  this.userConfiguration(identity).createBot(userId, command),
                reserveAgentTurn: (request) =>
                  this.agentTurnSlots(identity).reserve(request),
                releaseAgentTurn: (request) =>
                  this.agentTurnSlots(identity).release(request),
                runAgent: async (request) => {
                  if (!this.state.env.BOT_STATES) {
                    throw new Error("Bot-to-Bot messaging is unavailable");
                  }
                  const id = this.state.env.BOT_STATES.idFromName(
                    `${request.userId}:${request.botId}`,
                  );
                  const rpc = this.state.env.BOT_STATES.get(id) as unknown as {
                    runAgent(input: unknown): Promise<unknown>;
                  };
                  const completed = decodeClientTurnV1(
                    structuredClone(await rpc.runAgent(request)),
                  );
                  let sentText: string | undefined;
                  for (const event of completed.events) {
                    if (event.type !== "send/to-user") continue;
                    const payload = decodeSendToUserPayloadV1(
                      event.payload,
                      "agent send/to-user payload",
                    );
                    if (payload.type === "text") {
                      sentText = payload.text;
                      break;
                    }
                  }
                  return {
                    text: sentText ?? completed.text,
                  };
                },
              }),
            }
          : {}),
        // A Bot packs itself into a template only inside an admitted Turn, and
        // only through its User's own staging command: the seam it is handed
        // has no way to publish, so the Bot cannot.
        ...(turn
          ? {
              botTemplate: {
                owner: {
                  userId: identity.userId,
                  botId: identity.botId,
                },
                stageTemplate: (input: { commandId: string; botId: string }) =>
                  this.userConfiguration(identity).executeTemplateCommand(
                    identity.userId,
                    {
                      schemaVersion: 1,
                      type: "template/stage",
                      commandId: input.commandId,
                      botId: input.botId,
                    },
                  ),
              },
            }
          : {}),
        // A Bot writes a Routine only inside a Turn, so the record's writer can
        // name the Session and Turn that produced it.
        ...(turn
          ? {
              routines: {
                ...createBotRoutinesHost(identity, turn, this.state.routines),
                list: () => this.listRoutines(identity),
                execute: (command, writer) =>
                  this.executeRoutineCommand(identity, command, writer),
              },
            }
          : {}),
        // A Bot dispatches a subagent only inside an admitted Turn, whose run
        // the task record names, and only where a Subagent Durable Object can
        // actually be addressed.
        ...(turn && turn.compositionGenerationId && this.state.subagentBinding
          ? {
              subagents: subagentsRuntimeHost(
                this.state,
                identity,
                turn,
                turn.compositionGenerationId,
                turn.turnType ?? "chat",
                () => subagentModels,
                turn.subagentTaskId,
              ),
            }
          : {}),
        // The registered machine (rows 48, 49). The control tools mount only
        // inside a Turn, because the intent record they write has to name the
        // Session and Turn that asked — and because the approval that gates
        // them is a send onto that Turn's own durable log.
        ...(turn
          ? {
              machines: createBotMachineHost(
                identity,
                turn,
                this.state.ctx.storage,
                this.machineSeam(identity),
              ),
            }
          : {}),
        // Row 57g, mounted only behind its whole gate: the User setting on, and
        // a connected macOS machine that reports the `messages` capability.
        ...(turn && machineSeam && messagesGate.status === "ready"
          ? {
              machineMessages: createBotMachineMessagesHost(
                {
                  ...createBotMachineHost(
                    identity,
                    turn,
                    this.state.ctx.storage,
                    machineSeam,
                  ),
                  writer: {
                    sessionId: turn.sessionId,
                    turnId: turn.turnId,
                    runId: turn.runId,
                  },
                },
                machineSeam,
              ),
            }
          : {}),
        // The durable-root sync runs only inside a Turn that uses the
        // Computer. It attributes nothing: a file a shell wrote there reaches
        // object storage with an unattributed writer.
        ...(turn
          ? {
              computerSync: createBotComputerSyncHost(
                this.state.env,
                packageRoots,
              ),
              // The same Turn, as the writer a durable Computer write records.
              computerWriter: {
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                runId: turn.runId,
              },
              // A background process is Bot-scoped durable state, so its
              // record lives in this Bot's own Durable Object storage.
              computerProcesses: this.state.ctx.storage,
              // Prompt assembly reads the Bot DO's Step 1 lease record
              // directly; passing storage wakes no Computer.
              computerControlRecords: this.state.ctx.storage,
              ...(this.state.invalidateComputerProjectionFile
                ? {
                    computerProjectionFiles: {
                      invalidate: (
                        botId: string,
                        kind: "screenshots" | "doctor",
                      ) =>
                        this.state.invalidateComputerProjectionFile?.(
                          identity.userId,
                          botId,
                          kind,
                        ),
                    },
                  }
                : {}),
              // A computerUse child is the holder of the User-wide lease its
              // parent acquired. Its guarded commands must name that same
              // durable task owner or the shared fence would refuse itself.
              ...(turn.subagentRole === "computerUse" && turn.subagentTaskId
                ? {
                    computerAgentControlOwnerId: taskDesktopLeaseOwnerV1(
                      identity.botId,
                      turn.subagentTaskId,
                    ),
                  }
                : {}),
            }
          : {}),
        // The Computer host, when this deployment has one. Both halves or
        // neither: a binding with no token reaches a host that refuses.
        ...(this.state.env.COMPUTER_HOST && this.state.env.COMPUTER_HOST_TOKEN
          ? {
              computerHostBinding: {
                fetcher: this.state.env.COMPUTER_HOST,
                hostToken: this.state.env.COMPUTER_HOST_TOKEN,
              },
            }
          : {}),
      }),
      ...(await this.state.application.runtime.enabled(plan, {
        userId: identity.userId,
        readSecret,
        authorizeConnection: authorizeEnabledConnection,
        ...(turn
          ? {
              pinToolCatalog: turnToolCatalogPin(
                this.state.ctx.storage,
                turn.turnId,
              ),
            }
          : {}),
        packageSettings,
        // Enabled Contributions reach the network through the same
        // outbound seam the model provider uses, so a deployment that stubs
        // it stubs every one of them.
        ...(this.state.outboundFetch
          ? { fetch: this.state.outboundFetch }
          : {}),
        leaseCredential: async (
          capability: EnabledCapabilityV1,
          effectId: string,
          expectedGeneration?: string,
        ): Promise<CredentialLeaseV1> => {
          if (!capability.connectionId || !expectedGeneration) {
            throw new Error("Enabled Connection generation is unavailable");
          }
          return userConfiguration.leaseToolCredential(
            identity.userId,
            capability.connectionId,
            effectId,
            expectedGeneration,
          );
        },
        settleCredential: async (
          capability: EnabledCapabilityV1,
          effectId: string,
        ): Promise<void> => {
          if (!capability.connectionId) return;
          await userConfiguration.settleToolCredential(
            identity.userId,
            capability.connectionId,
            effectId,
          );
        },
      })),
    ];
    const agentPackages: FoundationAgentPackage[] = resolvedAgentPackages;
    // One generic resolver owns precedence: enabled Bot-scoped Package value,
    // enabled User-scoped Package value, then the platform model. The kernel
    // names no Package (AGENTS.md Configuration shape).
    const effective = resolveEffectiveBotModelV1({
      bot: settings,
      user,
      packages: packageDefinitions,
    });
    const effectiveModel = effective.model;
    if (!effectiveModel) {
      throw new Error(
        effective.binding?.failure ??
          "No model is set up yet. Choose one in Models.",
      );
    }
    const binding: ResolvedModelBindingV1 = effective.binding ?? {
      model: structuredClone(effectiveModel),
      state: "unavailable",
      failure: "This Bot's model isn't available. Pick one in Models.",
    };
    if (
      binding.state === "unavailable" ||
      !binding.connection ||
      !binding.providerType ||
      !binding.packageId
    ) {
      throw new Error(
        binding.failure ??
          "This Bot's model isn't available. Pick one in Models.",
      );
    }
    if (
      admittedRequest &&
      (admittedRequest.provider !== binding.providerType ||
        admittedRequest.model !== effectiveModel.providerModelId ||
        admittedRequest.modelBinding?.connectionId !==
          binding.connection.connectionId ||
        !admittedRequest.modelBinding.connectionGeneration ||
        admittedRequest.modelBinding.connectionGeneration !==
          binding.connection.generation)
    ) {
      throw new Error(
        "This Bot's model changed mid-reply. Send your message again.",
      );
    }
    const bindingPackageId = binding.packageId;
    agentPackages.push(
      this.state.application.runtime.model(binding, {
        accountId: identity.userId,
        connectionId: binding.connection.connectionId,
        leaseCredential: (
          effectId,
          expectedGeneration,
        ): Promise<CredentialLeaseV1> => {
          if (!expectedGeneration) {
            throw new Error(
              "Model request Connection generation is unavailable",
            );
          }
          return userConfiguration.leaseModelCredential(
            identity.userId,
            binding.connection!.connectionId,
            effectiveModel.providerModelId,
            effectId,
            expectedGeneration,
          );
        },
        settleCredential: (effectId) =>
          userConfiguration.settleModelCredential(
            identity.userId,
            binding.connection!.connectionId,
            bindingPackageId,
            effectId,
          ),
        ...(this.state.env.FROCK_AI
          ? {
              frockAiAutoRoute: this.state.env.FROCK_AI.autoRoute,
              runFrockAiChatCompletion: (gatewayModel, body) =>
                this.state.env.FROCK_AI!.runChatCompletion(gatewayModel, body),
            }
          : {}),
        fetch: this.state.outboundFetch,
      }),
    );
    // The slugs `<available_subagent_models>` renders, and the only ones a
    // `Task` call may name. They come from User enablement as resolved for this
    // Turn — never anything the Bot claimed about a model.
    const modelCapability = plan.capabilities.find(
      (candidate) =>
        candidate.kind === "model" &&
        candidate.connectionId === binding.connection!.connectionId,
    );
    if (modelCapability) {
      const subagentBinding = {
        packageId: modelCapability.packageId,
        capabilityId: modelCapability.capabilityId,
        connectionId: binding.connection.connectionId,
        provider: binding.providerType,
        providerModelId: effectiveModel.providerModelId,
        ...(binding.connection.generation
          ? { connectionGeneration: binding.connection.generation }
          : {}),
      };
      subagentModels.push(
        ...subagentModelCatalogV1({
          bindings: [subagentBinding],
          defaultBinding: subagentBinding,
          turnType: turn?.turnType ?? "chat",
        }),
      );
    }
    // Last, so every provider an earlier Package registered is already there.
    agentPackages.push(...this.state.application.runtime.base());
    return {
      agentPackages,
      capabilities: structuredClone(plan.capabilities),
      modelSelection: {
        provider: binding.providerType,
        model: effectiveModel.providerModelId,
        connectionId: binding.connection.connectionId,
        ...(binding.connection.generation
          ? { connectionGeneration: binding.connection.generation }
          : {}),
        ...((admittedRequest?.modelBinding?.catalogGeneration ??
        binding.connection.modelCatalog?.generation)
          ? {
              catalogGeneration:
                admittedRequest?.modelBinding?.catalogGeneration ??
                binding.connection.modelCatalog!.generation,
            }
          : {}),
      },
    };
  }

  async readDurableIdentity(): Promise<BotIdentity | undefined> {
    return this.state.authority.readDurableIdentity();
  }

  async validateIdentity(identity: BotIdentity): Promise<void> {
    return this.state.authority.validateIdentity(identity);
  }

  /** Recompute the Bot authority's one alarm inside a Package write transaction. */
  async refreshScheduledWork(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    await this.state.authority.refreshRecoveryAlarm(transaction);
  }

  async listNotifications(): Promise<BotNotificationIntent[]> {
    return this.state.authority.listNotifications();
  }

  async acknowledgeNotification(notificationId: string): Promise<void> {
    return this.state.authority.acknowledgeNotification(notificationId);
  }

  /** Every Routine this Bot holds. Bot-scoped: the caller proved membership. */
  async listRoutines(identity: BotIdentity): Promise<RoutineListViewV1> {
    return this.state.routines.list(
      identity.botId,
      await this.state.routineScheduler.nextRuns(),
    );
  }

  /**
   * One Routine command, applied by the Bot Durable Object. The writer is a
   * User here; the `routine_manage` tool calls the same store with a Bot
   * writer, so the two paths cannot drift.
   */
  async executeRoutineCommand(
    identity: BotIdentity,
    command: RoutineCommandV1,
    writer: RoutineWriterV1 = { kind: "user" },
  ): Promise<RoutineCommandReceiptV1> {
    if (command.botId !== identity.botId) {
      throw new RoutineNotFoundError(command.routineId ?? command.botId);
    }
    const receipt = await this.state.routines.execute(command, writer);
    // A created, re-timed, resumed or manually fired Routine changes what the
    // object is owed next, so the alarm is re-armed in the same call that wrote
    // the record rather than waiting for the next one to happen by.
    await this.state.ctx.storage.transaction((transaction) =>
      this.state.authority.refreshRecoveryAlarm(transaction),
    );
    return receipt;
  }

  /**
   * One webhook delivery, after the edge proved the key was minted here.
   *
   * The Bot re-checks the key against its own durable record, because the edge
   * knows only that the signature is this deployment's — not whether the key is
   * still this Routine's. The delivery is enqueued, never run inline: an HTTP
   * caller must not be able to hold a Turn open.
   */
  async deliverRoutineHook(input: {
    routineId: string;
    keyVersion: number;
    digest: string;
    deliveryId: string;
    body: string;
    contentType?: string | null;
  }): Promise<{ status: "accepted" | "duplicate"; fireId: string }> {
    const accepted = await this.state.routines.deliverHook(input);
    await this.state.ctx.storage.transaction((transaction) =>
      this.state.authority.refreshRecoveryAlarm(transaction),
    );
    return accepted;
  }

  /**
   * The User's machines, as this Bot may see them.
   *
   * Four calls and no more: list them, resolve one, queue an approved command,
   * and read a finished command's result. There is no register, no revoke and
   * no token here — a Bot cannot enrol or revoke a machine, and "self
   * modification never widens authority" is why.
   */
  private machineSeam(identity: BotIdentity): BotMachineSeamV1 {
    const userConfiguration = this.userConfiguration(identity);
    return {
      list: () => userConfiguration.listMachines(identity.userId),
      describeTarget: (machineId) =>
        userConfiguration.describeMachineTarget(identity.userId, machineId),
      readResult: (commandId) =>
        userConfiguration.readMachineResult(identity.userId, commandId),
      dispatch: (command) =>
        userConfiguration.dispatchMachineCommand(identity.userId, command),
    };
  }

  /**
   * One finished machine command, handed over by the User Durable Object.
   *
   * The machine answers the backend, never the Bot, so this is how the Bot
   * learns without being asked: the same durable input queue a Routine hand-off
   * and an approval decision ride, idempotent on the command id, drained as a
   * preamble line on the Bot's next conversational Turn. The line carries a
   * preview; `machine_command_check` reads the whole result.
   */
  async deliverMachineResult(
    delivery: MachineResultDeliveryV1,
  ): Promise<{ status: "accepted" }> {
    await this.state.ctx.storage.transaction(async (transaction) => {
      await enqueuePendingBotInputV1(transaction, {
        schemaVersion: 1,
        kind: "machine-result",
        commandId: delivery.commandId,
        machineId: delivery.machineId,
        outcome: delivery.outcome,
        preview: delivery.preview,
        createdAt: delivery.finishedAt,
      });
    });
    await this.state.ctx.storage.transaction((transaction) =>
      this.state.authority.refreshRecoveryAlarm(transaction),
    );
    return { status: "accepted" };
  }

  /**
   * The second of the two points a pending wake is heard at.
   *
   * The first is the Bot's next conversational Turn. This one is the User's:
   * an intent recorded in the settling transaction cannot be lost, but a
   * client that was not connected when it landed can miss the delivery, so the
   * alarm re-emits it once for a wake whose inbox entry is still unread. Once
   * per wake, recorded on the wake, so a Bot nobody talks to is not notified
   * on every alarm forever.
   */
  private async replayPendingWakeNotifications(): Promise<void> {
    const pending = await this.state.routineInbox.pending();
    if (pending.length === 0) return;
    const identity = await this.state.authority.readDurableIdentity();
    if (!identity) return;
    const settings = await this.getSettings(identity);
    if (!settings.notifications.enabled) return;
    const unread = new Map(
      (await this.state.routineInbox.list())
        .filter((entry) => !entry.acknowledged)
        .map((entry) => [entry.runId, entry] as const),
    );
    for (const { key, input } of pending) {
      if (input.kind !== "wake" || input.renotifiedAt !== undefined) continue;
      const entry = unread.get(input.runId);
      if (!entry) continue;
      // The same notification id the settle recorded, per source: a replay is
      // a second delivery of one intent, never a second intent.
      const subagent = input.source === "subagent";
      await this.state.authority.recordNotification({
        notificationId: subagent
          ? `task-settled:${input.runId}`
          : `routine-wake:${input.runId}`,
        runId: input.runId,
        createdAt: new Date().toISOString(),
        title: `${settings.profile.name} finished ${
          subagent ? "a subagent task" : "a Routine"
        }`,
        body: entry.text.slice(0, 240),
      });
      await this.state.routineInbox.markRenotified(key);
    }
  }

  /**
   * Every pending approval this Bot's alarm now owes an expiry, expired in one
   * pass.
   *
   * Exactly once per approval: the write is conditional on the record still
   * being `pending`, so an alarm that fires twice — or fires while a person is
   * clicking Approve — settles on whichever answer got there first and the
   * other is a no-op. The queued input is written in the same transaction as
   * the decision, so the Bot always learns the outcome.
   */
  private async expireDueApprovals(): Promise<void> {
    const stored = await this.state.ctx.storage.list<unknown>({
      prefix: APPROVAL_PREFIX,
    });
    const now = Date.now();
    for (const value of stored.values()) {
      const approval = decodeApprovalRecordV1(value);
      if (approval.decision !== "pending") continue;
      if (Date.parse(approval.expiresAt) > now) continue;
      await this.settleApproval(approval.approvalId, "expired", "expiry");
    }
  }

  /**
   * Record one decision, and queue the input it owes the Bot, in one
   * transaction.
   *
   * First write wins. A record that is no longer `pending` is returned exactly
   * as stored, which is what makes the route idempotent: a replayed `POST`, a
   * second click, and an alarm racing a person all answer with the one
   * decision that was actually recorded.
   */
  private async settleApproval(
    approvalId: string,
    decision: "approved" | "denied" | "expired",
    decidedBy: "user" | "expiry",
  ): Promise<{
    approval: ApprovalRecordV1;
    status: "recorded" | "replayed";
    /** Present when the card was a machine command's. */
    machineIntent?: MachineIntentRecordV1;
  }> {
    const key = approvalKeyV1(approvalId);
    const at = new Date().toISOString();
    return this.state.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(key);
      if (stored === undefined) {
        throw new ApprovalDecodeError(`approval "${approvalId}" was not found`);
      }
      const approval = decodeApprovalRecordV1(stored);
      if (approval.decision !== "pending") {
        return { approval, status: "replayed" as const };
      }
      const decided: ApprovalRecordV1 = {
        ...approval,
        decision,
        decidedAt: at,
        decidedBy,
      };
      await transaction.put(key, decided);
      // The Bot is owed the outcome whether a person gave it or the clock did:
      // "its outcome is delivered to the Bot's next conversational Turn as
      // durable input", and never an unbounded wait.
      await enqueuePendingBotInputV1(transaction, {
        schemaVersion: 1,
        kind: "approval",
        approvalId,
        decision,
        createdAt: at,
      });
      // Row 49: an approval this Bot asked for may be a command waiting for a
      // machine of the User's. The decision and what it authorized become
      // durable together, so a person can never have approved something whose
      // intent record still says nobody answered. Nothing is dispatched here:
      // a cross-Durable-Object call inside this transaction would make its
      // atomicity a lie.
      const machineIntent = await settleMachineIntentV1(
        transaction,
        approvalId,
        decision,
        at,
      );
      return {
        approval: decided,
        status: "recorded" as const,
        ...(machineIntent === undefined ? {} : { machineIntent }),
      };
    });
  }

  /**
   * The Bot's approvals, newest first. Decided cards are carried beside the
   * pending ones so the card in the transcript can say what was decided rather
   * than going quiet the moment somebody answers it.
   */
  async listApprovals(identity: BotIdentity): Promise<ApprovalListViewV1> {
    await this.validateIdentity(identity);
    const stored = await this.state.ctx.storage.list<unknown>({
      prefix: APPROVAL_PREFIX,
    });
    // Retention is enforced on read rather than in the settling transaction,
    // which cannot list. Trimming loses a row and never a fact: the send is
    // still on the durable log of the Turn that made it.
    for (const key of trimmableApprovalKeysV1([...stored.keys()])) {
      await this.state.ctx.storage.delete(key);
      stored.delete(key);
    }
    const approvals = [...stored.values()]
      .map((value) => decodeApprovalRecordV1(value))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      schemaVersion: 1,
      botId: identity.botId,
      approvals: approvals.map((approval) => projectApprovalCardV1(approval)),
      pending: approvals.filter((approval) => approval.decision === "pending")
        .length,
    };
  }

  /**
   * One decision, from a person. The durable write happens before this
   * answers, so the 200 is a statement about state and not about intent.
   */
  async decideApproval(
    identity: BotIdentity,
    approvalId: string,
    command: ApprovalDecisionCommandV1,
  ): Promise<ApprovalDecisionReceiptV1> {
    await this.validateIdentity(identity);
    const settled = await this.settleApproval(
      approvalId,
      command.decision,
      "user",
    );
    // Only the write that decided it dispatches — a second click answers
    // `replayed` and reaches no laptop — and only `approved` does. An expiry
    // never gets here at all: it settles through the alarm, which dispatches
    // nothing by construction.
    if (
      settled.status === "recorded" &&
      settled.machineIntent?.decision === "approved"
    ) {
      await dispatchApprovedMachineIntentV1(
        this.state.ctx.storage,
        settled.machineIntent,
        this.machineSeam(identity),
      );
    }
    return {
      schemaVersion: 1,
      approval: projectApprovalCardV1(settled.approval),
      status: settled.status,
    };
  }

  /** The completion inbox, newest first, with the badge count beside it. */
  async listRoutineInbox(identity: BotIdentity): Promise<RoutineInboxViewV1> {
    await this.validateIdentity(identity);
    const entries = await this.state.routineInbox.list();
    return {
      schemaVersion: 1,
      botId: identity.botId,
      entries: entries.map((entry) => routineInboxEntryViewV1(entry)),
      unacknowledged: entries.filter((entry) => !entry.acknowledged).length,
    };
  }

  /** Count inputs waiting for the next conversational Turn without draining them. */
  async pendingInputCount(identity: BotIdentity): Promise<number> {
    await this.validateIdentity(identity);
    return (await this.state.routineInbox.pending()).length;
  }

  /**
   * Acknowledge inbox entries. An explicit command, never a side effect of
   * reading: a background poll must not clear the badge.
   */
  async executeRoutineInboxCommand(
    identity: BotIdentity,
    command: RoutineInboxCommandV1,
  ): Promise<RoutineInboxReceiptV1> {
    if (command.botId !== identity.botId) {
      throw new RoutineNotFoundError(command.botId);
    }
    await this.validateIdentity(identity);
    await this.state.routineInbox.acknowledge(command.entryIds);
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      inbox: await this.listRoutineInbox(identity),
    };
  }

  /**
   * One automation run, read-only.
   *
   * An automation Turn is absent from `listRuns` by construction, so this is
   * the only read of one, and it is reached through the Routine's own run log:
   * a run whose recorded origin names a different Routine is a 404 here.
   */
  async readRoutineRun(
    identity: BotIdentity,
    routineId: string,
    runId: string,
  ): Promise<RoutineRunDetailViewV1> {
    await this.validateIdentity(identity);
    const run = await this.state.authority.readStoredRun(runId);
    const origin = run ? settledRoutineOriginV1(run) : undefined;
    if (!run || origin?.routineId !== routineId) {
      throw new RoutineNotFoundError(runId);
    }
    return routineRunDetailViewV1(identity.botId, routineId, run);
  }

  /** One Routine's bounded run log, newest first. */
  async listRoutineRuns(
    identity: BotIdentity,
    routineId: string,
  ): Promise<RoutineRunListViewV1> {
    return this.state.routines.listRuns(identity.botId, routineId);
  }
  /**
   * The Bot's durable Composition generations, newest first. Bot-scoped: the
   * caller proves directory membership before this runs.
   */
  async listCompositionGenerations(
    identity: BotIdentity,
    query: { limit: number; cursor?: string },
  ): Promise<CompositionGenerationListViewV1> {
    const current = await this.state.authority.composition.current();
    const page = await this.state.authority.composition.list({
      limit: Math.min(query.limit, MAX_COMPOSITION_GENERATION_PAGE_V1),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return {
      schemaVersion: 1,
      botId: identity.botId,
      currentGenerationId: current.generationId,
      generations: await Promise.all(
        page.generations.map(async (generation) =>
          projectCompositionGenerationV1({
            botId: identity.botId,
            generation,
            currentGenerationId: current.generationId,
            failures: await this.state.authority.compositionFailures.list(
              generation.generationId,
            ),
            ...(await this.compositionQuarantineView(generation.generationId)),
          }),
        ),
      ),
      ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    };
  }

  /** One generation, with the recorded source of each isolate member. */
  async getCompositionGeneration(
    identity: BotIdentity,
    generationId: string,
  ): Promise<CompositionGenerationViewV1 | undefined> {
    const generation =
      await this.state.authority.composition.read(generationId);
    if (!generation) return undefined;
    const current = await this.state.authority.composition.current();
    return projectCompositionGenerationV1({
      botId: identity.botId,
      generation,
      currentGenerationId: current.generationId,
      failures:
        await this.state.authority.compositionFailures.list(generationId),
      ...(await this.compositionQuarantineView(generationId)),
    });
  }

  /** Spread into a projection: absent unless the generation is quarantined. */
  private async compositionQuarantineView(
    generationId: string,
  ): Promise<{ quarantine?: CompositionQuarantineV1 }> {
    const quarantine =
      await this.state.authority.compositionFailures.quarantine(generationId);
    return quarantine === undefined ? {} : { quarantine };
  }

  /**
   * Reverting is a recorded generation, not a mutation: it proposes a new
   * pending generation carrying the target's members, which the next admitted
   * Turn activates. The command is idempotent on its `commandId`, and its
   * `expectedGenerationId` is the optimistic check that the User acted on the
   * Composition they were looking at.
   */
  async revertComposition(
    identity: BotIdentity,
    command: RevertCompositionCommandV1,
  ): Promise<CompositionCommandReceiptV1> {
    if (command.botId !== identity.botId) {
      throw new Error("Composition revert command does not match its Bot");
    }
    const receiptKey = `${COMPOSITION_COMMAND_PREFIX}${command.commandId}`;
    const recorded =
      await this.state.ctx.storage.get<CompositionCommandReceiptV1>(receiptKey);
    if (recorded) return decodeCompositionCommandReceiptV1(recorded);
    const current = await this.state.authority.composition.current();
    const reject = async (
      failure: string,
    ): Promise<CompositionCommandReceiptV1> => {
      const receipt = decodeCompositionCommandReceiptV1({
        schemaVersion: 1,
        commandId: command.commandId,
        status: "rejected",
        failure,
        currentGenerationId: current.generationId,
      });
      await this.state.ctx.storage.put(receiptKey, receipt);
      return receipt;
    };
    if (current.generationId !== command.expectedGenerationId) {
      return reject(`composition generation is ${current.generationId}`);
    }
    let generationId: string;
    try {
      const reverted = await this.state.authority.composition.revert(
        command.toGenerationId,
        {
          kind: "revert",
          revertsTo: command.toGenerationId,
          userId: identity.userId,
        },
      );
      generationId = reverted.generationId;
    } catch (error) {
      return reject(
        error instanceof Error ? error.message : "Composition revert failed",
      );
    }
    const receipt = decodeCompositionCommandReceiptV1({
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      generationId,
      currentGenerationId: current.generationId,
    });
    await this.state.ctx.storage.put(receiptKey, receipt);
    return receipt;
  }

  /**
   * The Bot's unread projection. The count is derived from the admission index
   * on every read, one page longer than the cap so "99+" is exact.
   */
  async readUnread(identity: BotIdentity): Promise<BotUnreadViewV1> {
    await this.state.authority.validateIdentity(identity);
    const [storedState, storedPreview] =
      await this.state.ctx.storage.transaction((transaction) =>
        Promise.all([
          transaction.get<unknown>(UNREAD_STATE_KEY),
          transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
        ]),
      );
    const state = optionalUnreadStateV1(storedState);
    const index = await this.state.authority.listRunIndex({
      limit: UNREAD_COUNT_CAP + 1,
    });
    // Counted straight off the keys rather than through `RoutineInboxStore`:
    // its `list()` trims the inbox, and the unread fan-out is a read every
    // sidebar poll makes for every Bot — it must not write, least of all into
    // an object that is running a Turn. An undecodable row is skipped, because
    // a badge is never worth failing a read for.
    const stored = await this.state.ctx.storage.list<unknown>({
      prefix: ROUTINE_INBOX_PREFIX,
      limit: ROUTINE_INBOX_LIMIT,
    });
    let failures = 0;
    for (const value of stored.values()) {
      try {
        const entry = decodeRoutineInboxEntryV1(value);
        if (entry.failure === true && !entry.acknowledged) failures += 1;
      } catch {
        continue;
      }
    }
    return projectBotUnreadViewV1(
      identity.botId,
      state,
      index.map((entry) => entry.cursor),
      await this.sidebarPreview(storedPreview, index),
      failures,
      await this.isWorking(index[0]?.runId),
    );
  }

  /**
   * Whether the Bot's newest admitted run is still going.
   *
   * The sidebar draws this as an activity ring, so somebody in another
   * conversation can see a Bot working rather than reading a quiet row as a
   * stalled one. It is the newest run only: a Bot admits one Turn at a time,
   * so an older run that is somehow still marked running is a reconciliation
   * problem and not something a ring should report. A read that fails is no
   * ring — liveness is never worth failing a sidebar poll for.
   *
   * The record's `status` is not the test and never was. `resolveRunWorking`
   * holds the rule — running, inside the Turn deadline, and a Turn the log has
   * not already closed — and settles the record when it finds one that only
   * claims to be running, which is why this read is also the repair.
   */
  private async isWorking(runId: string | undefined): Promise<boolean> {
    return runWorkingV1(this.state, runId);
  }

  /**
   * How many stored runs a read will open to recover a missing preview. The
   * newest settled chat Turn is almost always the first entry; the bound is
   * what keeps a Bot whose recent Turns are all automations from turning one
   * sidebar read into a scan of its whole history.
   */
  private static readonly SIDEBAR_PREVIEW_BACKFILL_RUNS_V1 = 5;

  /**
   * The preview record, or the same line derived from the runs when there is
   * none. A Bot whose Turns settled before the preview projection existed has
   * a full transcript and no record, and the row read "No messages yet" over
   * it. A read never writes what it derives: the next settlement stores it.
   */
  private async sidebarPreview(
    storedPreview: unknown,
    index: readonly { runId: string }[],
  ): Promise<SidebarMessagePreviewV1 | undefined> {
    const stored = optionalSidebarMessagePreviewV1(storedPreview);
    if (stored) return stored;
    const runs: SidebarPreviewRunV1[] = [];
    for (const entry of index.slice(
      0,
      ShellBotBackendContribution.SIDEBAR_PREVIEW_BACKFILL_RUNS_V1,
    )) {
      const run = await this.state.authority.readRun(entry.runId);
      if (run) runs.push(run);
    }
    return sidebarMessagePreviewFromRunsV1(runs);
  }

  /**
   * `bot/mark-read` and `bot/mark-unread`. Idempotent on the command id and
   * monotonic in the cursor, so a replay or an out-of-order delivery can only
   * ever produce the same durable record.
   */
  async executeUnreadCommand(
    identity: BotIdentity,
    command: BotUnreadCommandV1,
  ): Promise<BotUnreadReceiptV1> {
    if (command.botId !== identity.botId) {
      throw new Error("unread command does not match its Bot");
    }
    await this.state.authority.validateIdentity(identity);
    const fingerprint = botUnreadCommandFingerprintV1(command);
    const receiptKey = unreadReceiptKeyV1(command.commandId);
    const stored = await this.state.ctx.storage.transaction(
      async (transaction) => {
        const existing = await transaction.get<{
          commandFingerprint: string;
          state: unknown;
        }>(receiptKey);
        if (existing) {
          if (existing.commandFingerprint !== fingerprint) {
            throw new Error(
              `unread command id "${command.commandId}" was reused for a different command`,
            );
          }
          return {
            state: optionalUnreadStateV1(existing.state),
            preview: await transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
          };
        }
        const current = optionalUnreadStateV1(
          await transaction.get<unknown>(UNREAD_STATE_KEY),
        );
        let next = current;
        if (command.type === "bot/mark-read") {
          if (!command.upToCursor) {
            throw new Error("bot/mark-read requires upToCursor");
          }
          next = markUnreadReadV1(current, {
            upToCursor: command.upToCursor,
            at: new Date().toISOString(),
          });
        } else {
          next = markUnreadV1(current);
        }
        await transaction.put({
          [UNREAD_STATE_KEY]: next,
          [receiptKey]: { commandFingerprint: fingerprint, state: next },
        });
        return {
          state: next,
          preview: await transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
        };
      },
    );
    const index = await this.state.authority.listRunIndex({
      limit: UNREAD_COUNT_CAP + 1,
    });
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      unread: projectBotUnreadViewV1(
        identity.botId,
        stored.state,
        index.map((entry) => entry.cursor),
        // The open Bot is the one that gets marked read, so this receipt is
        // the sidebar row it renders from: it owes the same derived preview
        // the fan-out gives every other Bot.
        await this.sidebarPreview(stored.preview, index),
      ),
    };
  }

  private createNotification(
    settings: BotSettingsViewV1,
    result: BotTurnCompletion,
  ): BotNotificationIntent | undefined {
    // An approval is not an update, and `notifications.enabled` is the mute on
    // updates. A question that has stopped the Bot outranks it: the intent is
    // recorded at `critical` whatever the Bot's notification policy says,
    // exactly as a secret request would be. Muting silences chatter, not a
    // decision the Bot is waiting on.
    const [asked] = approvalSendsV1(result.events);
    if (asked) {
      return {
        notificationId: approvalNotificationIdV1(asked.approvalId),
        runId: result.runId,
        createdAt: new Date().toISOString(),
        title: `${settings.profile.name} needs your approval`,
        body: approvalNotificationBodyV1(asked),
        urgency: "critical",
      };
    }
    if (!settings.notifications.enabled) return undefined;
    const automation = result.events.some(
      (event) => event.type === "turn/admission" && event.turnType !== "chat",
    );
    if (automation) {
      const handoff = routineHandoffTextV1(result.events);
      // A firing that handed off is the only automation Turn that says
      // anything to a person here. A silent completion lands in the inbox and
      // notifies nobody: "persisted silently, arriving later as an
      // `automation_completion_inbox` row".
      if (handoff === undefined) return undefined;
      return {
        notificationId: notificationIdV1("routine-wake", result.runId),
        runId: result.runId,
        createdAt: new Date().toISOString(),
        title: `${settings.profile.name} finished a Routine`,
        body: handoff.slice(0, 240),
      };
    }
    return {
      notificationId: result.runId,
      runId: result.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} replied`,
      body: result.text.slice(0, 240),
    };
  }

  /**
   * What a Turn that did not finish tells the person who was waiting on it.
   *
   * A completed Turn notifies ("Bob replied", with what it said); a failed one
   * used to notify nobody, so a deadline, a provider outage, a restart or a
   * Composition that would not mount was visible only to whoever happened to
   * still be looking at that conversation. This is the same intent for the
   * other outcome, written in the transaction that settles the run, once per
   * failed run.
   *
   * The body is the product's own sentence for the failure — `runFailureCopyV1`
   * is the one place a stored diagnostic becomes something a person reads —
   * and never the diagnostic itself, which stays on the debug surface.
   */
  private createFailureNotification(
    settings: BotSettingsViewV1,
    failed: {
      runId: string;
      failure: string;
      events: readonly SessionEvent[];
    },
  ): BotNotificationIntent | undefined {
    // The mute on updates covers this one: a failure is an update about a Turn
    // that ended, not a decision the Bot is waiting on.
    if (!settings.notifications.enabled) return undefined;
    // An automation Turn does not speak to its User here. A Routine firing that
    // fails already records its own `routine-failed` notification, and a
    // subagent task its own; a second intent for the same failure would be two
    // rows for one event.
    const automation = failed.events.some(
      (event) => event.type === "turn/admission" && event.turnType !== "chat",
    );
    if (automation) return undefined;
    return {
      notificationId: notificationIdV1("run-failed", failed.runId),
      runId: failed.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} couldn't finish`,
      body: runFailureCopyV1({
        failure: failed.failure,
        events: failed.events,
      }).slice(0, 240),
    };
  }

  /**
   * Everything the Shell writes in the transaction that settles a Turn.
   *
   * The composition itself lives in `terminal-records.ts`, where "each
   * producer exactly once, and no producer silently overwrites another" is a
   * checked property rather than the shape of three spreads.
   */
  private async terminalPackageRecords(input: {
    snapshot: BotSettingsViewV1;
    run: StoredRun;
    cursor: string;
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>> {
    return shellTerminalRecordsV1({
      run: input.run,
      cursor: input.cursor,
      now: new Date().toISOString(),
      read: input.read,
    });
  }

  /**
   * What a superseded Turn leaves for the Turn that replaced it.
   *
   * One durable input, drained once by the next conversational Turn. The
   * session log already carries what the Turn sent and what its tools
   * returned; this is the part that is not in the log — that it was cut off,
   * that nothing in flight completed, and that a subagent it dispatched is
   * still working. "A firing's outcome is delivered to the Bot's next
   * conversational Turn as durable input" and a superseded Turn's is too.
   */
  private supersededPackageRecords(input: {
    run: StoredRun;
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>> {
    return supersededTurnRecordsV1({
      run: input.run,
      now: new Date().toISOString(),
      read: input.read,
    });
  }

  async alarm(): Promise<void> {
    // One alarm: the kernel defers while work is in flight, settles Package
    // scheduled work, and recovers the active run. Recovery re-issues whatever
    // the interrupted Turn had dispatched, under the keys the log already
    // carries.
    await this.state.authority.alarm();
  }
  async listRuns(
    input: unknown = { schemaVersion: 1 },
  ): Promise<ClientRunListV1> {
    return listRuns(this.state, input);
  }
  async listConversations(): Promise<ClientConversationListV1> {
    return listConversations(this.state);
  }

  async startConversation(
    identity: BotIdentity,
  ): Promise<ClientConversationOutcomeV1> {
    return startConversation(this.state, identity);
  }

  async lookupRun(input: unknown): Promise<ClientRunLookupV1> {
    return lookupRun(this.state, input);
  }

  async listRunEventPage(cursor?: string): ReturnType<typeof listRunEventPage> {
    return listRunEventPage(this.state, cursor);
  }

  /** @see debugSnapshot in `debug.ts`. */
  async debugSnapshot(
    identity: BotIdentity,
    input: unknown = { schemaVersion: 1 },
  ): Promise<BotDebugSnapshotV1> {
    return debugSnapshot(
      this.state,
      identity,
      () => this.getSettings(identity),
      input,
    );
  }

  async fenceRunAdmission(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return projectClientRunLookupV1(
      await this.state.authority.fenceRunAdmission(identity, query.runId),
    );
  }
  private initialBotSettings(botId: string): BotSettingsViewV1 {
    return initializeBotSettingsV1(botId);
  }

  private userConfiguration(identity: BotIdentity): {
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
  } {
    const id = this.state.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker types do not expose its RPC surface.
    const rpc = this.state.env.USER_CONFIGURATIONS.get(id) as unknown as {
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
      executeConfiguration(input: unknown): Promise<unknown>;
      leaseModelCredential(input: unknown): Promise<unknown>;
      settleModelCredential(input: unknown): Promise<void>;
      leaseToolCredential(input: unknown): Promise<unknown>;
      settleToolCredential(input: unknown): Promise<void>;
      listBots(input: unknown): Promise<unknown>;
      createBot(input: unknown): Promise<unknown>;
      executeTemplateCommand(input: unknown): Promise<TemplateShareReceiptV1>;
      listMachines(input: unknown): Promise<unknown>;
      describeMachineTarget(input: unknown): Promise<unknown>;
      dispatchMachineCommand(input: unknown): Promise<unknown>;
      readMachineResult(input: unknown): Promise<unknown>;
    };
    return {
      readConfiguration: (input) =>
        rpc.readConfiguration({ ...input, view: 2 }),
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
    };
  }

  private async resolveExecutionContext(identity: BotIdentity): Promise<{
    settings: BotSettingsViewV1;
    user: UserSettingsViewV1;
    plan: BotExecutionPlanV1;
  }> {
    const settings = await readBotSettingsV1(this.state, identity);
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: executionPackagesV1(this.state.application),
    });
    return { settings, user, plan };
  }

  async archiveEligible(storage: {
    get<T>(key: string): Promise<T | undefined>;
  }): Promise<boolean> {
    return (await storage.get<string>(ACTIVE_RUN_KEY)) === undefined;
  }

  async assertLifecycleActive(botId: string): Promise<void> {
    if (!this.state.lifecycleAdmission) return;
    await this.state.ctx.storage.transaction((transaction) =>
      this.state.lifecycleAdmission!(transaction, botId),
    );
  }

  /**
   * Linearizes one new external effect against durable Stop. The Agent has
   * already journaled intent; this transaction atomically persists the exact
   * admitted/fenced outcome used before the provider/tool invocation.
   */
  private async admitRunEffect(
    identity: BotIdentity,
    runId: string,
    sessionId: string,
    effect: AgentEffectAdmission,
  ): Promise<boolean> {
    return this.state.ctx.storage.transaction(async (transaction) => {
      const [activeRunId, durableIdentity, candidate] = await Promise.all([
        transaction.get<string>(ACTIVE_RUN_KEY),
        transaction.get<BotIdentity>(IDENTITY_KEY),
        transaction.get<unknown>(`${RUN_PREFIX}${runId}`),
      ]);
      const storedRun = optionalStoredRun(candidate);
      let run = storedRun;
      if (storedRun?.eventRange) {
        const events = await new SessionEventLog(transaction).readRange(
          storedRun.sessionId,
          storedRun.eventRange.startSeq,
          storedRun.eventRange.endSeq,
        );
        if (
          events.length !==
          storedRun.eventRange.endSeq - storedRun.eventRange.startSeq
        ) {
          throw new Error(
            `run "${storedRun.runId}" has an incomplete event range`,
          );
        }
        run = requireStoredRunV1({ ...storedRun, events });
      }
      if (
        activeRunId !== runId ||
        !run ||
        run.sessionId !== sessionId ||
        durableIdentity?.userId !== identity.userId ||
        durableIdentity.botId !== identity.botId ||
        !(run.status === "running" && run.phase === "executing")
      ) {
        return false;
      }
      const prior = run.effectAdmissions.find(
        (admission) => admission.effectId === effect.effectId,
      );
      if (prior) {
        if (prior.kind !== effect.kind) {
          throw new Error(
            `effect admission "${effect.effectId}" collides with ${prior.kind}`,
          );
        }
        return prior.outcome === "admitted";
      }
      let matchesIntent = false;
      if (effect.kind === "model") {
        const model = latestModelRequestJournalState(run.events);
        matchesIntent =
          model.status === "unresolved" &&
          model.request.request.requestId === effect.effectId;
      } else {
        try {
          const tool = validateToolOccurrenceJournal(run.events).get(
            effect.effectId,
          );
          matchesIntent = Boolean(tool?.intent && !tool.result);
        } catch {
          matchesIntent = false;
        }
      }
      if (!matchesIntent) {
        throw new Error(
          `effect admission "${effect.effectId}" does not match durable intent`,
        );
      }
      // Supersede fences exactly as Stop does. It is what makes an interrupt
      // durable rather than advisory: a Turn whose Agent never got the signal
      // — because the object was evicted and resumed — still starts no new
      // provider call or tool effect once the intent is recorded.
      const outcome =
        run.stopRequestedAt || run.supersededAt ? "fenced" : "admitted";
      const next = requireStoredRunV1({
        ...run,
        effectAdmissions: [
          ...run.effectAdmissions,
          { kind: effect.kind, effectId: effect.effectId, outcome },
        ],
      } satisfies StoredRun);
      await transaction.put(
        `${RUN_PREFIX}${runId}`,
        structuredClone(storedRunRecordV2(next)),
      );
      return outcome === "admitted";
    });
  }
}

export function createShellBotBackendContribution(
  host: ShellBotBackendHost,
): ShellBotBackendContribution {
  return new ShellBotBackendContribution(host);
}

/**
 * What an application hands this Contribution: the conversation surface and the Bot's Composition, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface ShellBotApplicationHostV1 {
  shell: ShellBotBackendHost;
}

/**
 * The manifest's `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineBotBackendContribution<
  ShellBotApplicationHostV1,
  ShellBotBackendContribution
>({
  specifier: "@frockbot/app/shell/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createShellBotBackendContribution(host.shell)),
});

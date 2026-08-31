import type { AgentEffectAdmission } from "@frockbot/kernel-agent-loop/agent";
import {
  decodeSessionEvent,
  type PersistSessionEvents,
  type SessionEvent,
  validateToolOccurrenceJournal,
  type BotCapabilitiesStub,
  type IsolateModelInvocationV1,
  type IsolatePendingDecisionV1,
  type NormalizedModelRequest,
  type PackageBundlerBinding,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";
import {
  ACTIVE_RUN_KEY,
  BotDurableAuthority,
  IDENTITY_KEY,
  LATEST_EVENTS_KEY,
  NOTIFICATION_PREFIX,
  RECOVERY_ALARM_DELAY_MS,
  RUN_ADMISSION_FENCE_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  type BotIdentity,
  type BotDurableAuthorityOptions,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "@frockbot/kernel-do";
import type {
  FoundationAgentPackage,
  RuntimeModelSelection,
} from "@frockbot/agent-runtime/runtime";
import {
  decodeCredentialLeaseV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import {
  compileFoundationApplication,
  createFoundationModelRuntimePackage,
} from "@frockbot/application-foundation/runtime";
import {
  applyBotProfilePatchV1,
  capabilityAssignmentFailureV1,
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeCompositionCommandReceiptV1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  type CompositionCommandReceiptV1,
  type CompositionGenerationListViewV1,
  type CompositionGenerationViewV1,
  type RevertCompositionCommandV1,
  type ConnectionDependencyRequirementV1,
  type BotExecutionPlanV1,
  type BotSelfWriterV1,
  type BotSettingsViewV1,
  type CapabilityAssignmentView,
  type ModelAssignment,
  type ConnectionView,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
  type ResolvedModelBindingV1,
  initializeBotSettingsV1,
  resolvePackageSettingValuesV1,
  resolveBotExecutionPlanV1,
  resolveBotModelBindingV1,
  resolveEffectiveBotModelV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  createFoundationAssignedRuntimePackages,
  mergeFoundationRuntimePackages,
  createFoundationHostedRuntimePackages,
  mergeFoundationRuntimePackagesV1,
  type PackagePublisherAgentHost,
} from "@frockbot/application-foundation/runtime";
import {
  requireStoredAssignmentSaga,
  type StoredAssignmentSaga,
} from "./backend-assignment.js";
import {
  cancelStoredRun,
  completeStoredRun,
  failStoredRun,
  requireStoredRunReconciliation,
} from "./backend-completion.js";
import { BotTurnReconciliationRequiredError } from "./backend-runner.js";
import {
  eventsForFailedRun,
  latestModelRequestJournalState,
  planBotRunRecovery,
  planStoppedRunRecovery,
} from "./backend-recovery.js";
import {
  bootstrapCompositionGeneration,
  createShellCompositionHost,
  type ShellIsolateMountOptions,
  type ShellMountedComposition,
} from "./backend-composition.js";
import {
  activateCompositionV1,
  type CompositionFailureV1,
  type CompositionMountHost,
  type CompositionQuarantineV1,
} from "@frockbot/kernel-composition/activation";
import {
  createPackageAuthoringHost,
  createR2AuthoringArtifactStore,
} from "./backend-authoring.js";
import { createBotComputerSyncHost } from "./backend-computer.js";
import {
  decodeDirectoryViewV1,
  decodeFlockReceiptV1,
  type BotDirectoryViewV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
} from "@frockbot/plugin-flock/shared";
import { createBotSelfManagementHost } from "./backend-flock.js";
import { createBotMemoryHost } from "./backend-memory.js";
import { createBotImageHost } from "./backend-image.js";
import {
  createBotPluginSkillsSource,
  createBotSkillCatalogReader,
  createBotSkillsHost,
  createBotSkillsReads,
} from "./backend-skills.js";
import {
  loadFullSkillCatalogV1,
  skillRefForLoadedSkillV1,
} from "@frockbot/plugin-skills/catalog";
import {
  clientSkillCatalogEntryV1,
  type ClientSkillCatalogEntryV1,
  type ClientSkillCatalogV1,
} from "./skill-protocol.js";
import {
  createBotRoutineHookMinter,
  createBotRoutines,
  createBotRoutinesHost,
  routineFireOutcomeV1,
  routineInboxEntryViewV1,
  routineRunDetailViewV1,
  routineTerminalRecordsForRunV1,
  routineTurnCommandV1,
  settledRoutineOriginV1,
} from "./backend-routines.js";
import {
  RoutineInboxStore,
  type RoutineTerminalRecordsV1,
} from "@frockbot/plugin-routines/inbox-store";
import {
  pendingBotInputPreambleV1,
  routineHandoffTextV1,
  type PendingBotInputV1,
  type RoutineInboxEntryV1,
} from "@frockbot/plugin-routines/inbox";
import type { RoutineScheduler } from "@frockbot/plugin-routines/scheduler";
import {
  RoutineNotFoundError,
  type RoutineStore,
} from "@frockbot/plugin-routines/store";
import type {
  RoutineCommandReceiptV1,
  RoutineCommandV1,
  RoutineInboxCommandV1,
  RoutineInboxReceiptV1,
  RoutineInboxViewV1,
  RoutineListViewV1,
  RoutineRunDetailViewV1,
  RoutineRunListViewV1,
} from "@frockbot/plugin-routines/shared";
import {
  decodeAuthoringQuotaReceiptV1,
  type AuthoringQuotaBinding,
  type PackageAuthoringHost,
} from "@frockbot/plugin-authoring";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  createIsolateCapabilityHost,
  createR2PackageArtifactStore,
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
  type IsolateAssignmentV1,
  type IsolateCapabilityHost,
  type IsolateModelBindingV1,
  type IsolateModelPath,
  type IsolateModelRequestRecordV1,
  type IsolatePendingAuthorityDecisionV1,
} from "./backend-isolate.js";
import type { BotIsolateLoader } from "@frockbot/kernel-composition/isolate";
import type {
  CompositionGenerationV1,
  CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import {
  decodeMcpLifecycleReceiptV1,
  decodeMcpServerStatusViewV1,
  type McpLifecycleReceiptV1,
  type McpMountOutcomeReportV1,
  type McpServerStatusViewV1,
} from "@frockbot/plugin-mcp/records";
import { projectCompositionGenerationV1 } from "./composition-views.js";
import { executeBotTurn } from "./backend-runner.js";
import {
  CLIENT_RUN_LIST_MAX_BYTES,
  CLIENT_RUN_PAGE_LIMIT,
  clientRunListWireBytes,
  createClientRunListV1,
  createClientRunStopReceiptV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunListQueryV1,
  decodeClientRunStopCommandV1,
  isVisibleRunV1,
  projectClientRunLookupV1,
  projectClientRunV1,
  projectClientAnnouncementsV1,
  projectClientTurnV1,
  type ClientRunLookupV1,
  type ClientRunListV1,
  type ClientRunStopReceiptV1,
  type ClientRunV1,
  type ClientTurnV1,
} from "./run-protocol.js";
import {
  botStopCommandFingerprintV1,
  botTurnCommandFingerprintV1,
  requireStoredRunV1,
  storedRunCodecV1,
  type BotNotificationIntent,
  type BotTurnCompletion,
  type StoredRun,
  type StoredRunStatus,
} from "./backend-contracts.js";

/** The Bot Durable Object key holding this Bot's durable configuration. */
import {
  advanceUnreadActivityV1,
  botUnreadCommandFingerprintV1,
  markUnreadReadV1,
  markUnreadV1,
  optionalUnreadStateV1,
  projectBotUnreadViewV1,
  unreadReceiptKeyV1,
  UNREAD_COUNT_CAP,
  UNREAD_STATE_KEY,
  type BotUnreadCommandV1,
  type BotUnreadReceiptV1,
  type BotUnreadViewV1,
} from "./unread.js";

export const BOT_CONFIGURATION_KEY = "bot-configuration";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
const ASSIGNMENT_GENERATION_PREFIX = "assignment-generation:";
const ASSIGNMENT_COMPENSATION_PREFIX = "assignment-compensation:";
const ASSIGNMENT_TOMBSTONE_PREFIX = "assignment-tombstone:";
const ASSIGNMENT_SAGA_PREFIX = "assignment-saga:";
const STOP_RECEIPT_PREFIX = "stop-receipt:";
/**
 * The Bot's durable announcement log: Session events that happen outside any
 * Turn, such as a rename.
 */
const BOT_ANNOUNCEMENT_PREFIX = "bot-announcement:";
const BOT_ANNOUNCEMENT_SEQUENCE_KEY = "bot-announcement-sequence";
/** How many announcements the Session keeps. */
export const BOT_ANNOUNCEMENT_RETENTION = 32;

function botAnnouncementKey(seq: number): string {
  return `${BOT_ANNOUNCEMENT_PREFIX}${String(seq).padStart(12, "0")}`;
}
const ASSIGNMENT_SAGA_DEADLINE_MS = 60_000;
/** Idempotency records for Composition commands this Package admits. */
const COMPOSITION_COMMAND_PREFIX = "composition-command:";

function assignmentGenerationKey(assignmentId: string): string {
  return `${ASSIGNMENT_GENERATION_PREFIX}${assignmentId}`;
}

function capabilityKey(packageId: string, capabilityId: string): string {
  return `${packageId}:${capabilityId}`;
}

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
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

interface AssignmentActivity {
  commandFingerprint: string;
  promise: Promise<OperationReceiptV1>;
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

export interface BotStateEnv {
  MEMORY_FILES: R2Bucket;
  /**
   * The Bot Package Worker Loader (plan Step 4). Optional so a host without
   * Bot-authored Packages — tests, the Electron shell — still compiles; a
   * generation with an isolate member fails verification without it.
   */
  BOT_PACKAGES?: BotIsolateLoader;
  /** Immutable, content-addressed Package artifacts, read hash-verified. */
  APPLICATION_ARTIFACTS?: R2Bucket;
  /**
   * The remote Package Catalog bucket. Read here only to index the Skills that
   * arrived with the User's installed entries, at the generation each install
   * pinned. Optional so a deployment without a Catalog still compiles: a Turn
   * then carries no plugin-borne Skills, which is the true answer.
   */
  PACKAGE_CATALOG?: R2Bucket;
  /**
   * The Package bundler service (plan Step 3/D4). Optional so a host without
   * Bot authoring still compiles; `package_author` then refuses visibly.
   */
  PACKAGE_BUNDLER?: PackageBundlerBinding;
  MEMORY_INDEX: VectorizeIndex;
  /**
   * The Workers AI binding, read only by the image-generation seam
   * (`backend-image.ts`). Optional so a host without Workers AI — a test, the
   * Electron shell, a self-hosted deployment — still compiles; `generate_image`
   * then refuses visibly on the Turn that calls it rather than throwing inside
   * the Agent loop. The `PACKAGE_BUNDLER` precedent.
   */
  AI?: Ai;
  USER_CONFIGURATIONS: DurableObjectNamespace;
  COMPUTER_HOST?: Fetcher;
  /**
   * The shared secret the app Worker presents to the Computer host. Absent,
   * and no Computer host call is made: an unauthenticated call would be
   * refused at the host anyway, and a missing secret is a deployment fault
   * that should be visible as "no Computer" rather than as a 401 per Turn.
   */
  COMPUTER_HOST_TOKEN?: string;
  SPRITES_TOKEN?: string;
  CREDENTIAL_KEYRING?: string;
  /**
   * The HMAC secret every Routine webhook key is signed with. Absent in a
   * deployment that has not set it, and a webhook Routine is then refused a key
   * with that reason rather than given an unverifiable one.
   */
  ROUTINE_HOOK_SECRET?: string;
}

/** Constructs the kernel Bot Durable Object authority this Package runs under. */
export type CreateBotDurableAuthority = <Snapshot>(
  options: BotDurableAuthorityOptions<Snapshot>,
) => BotDurableAuthority<Snapshot>;

export interface ShellBotBackendHost {
  state: DurableObjectState;
  env: BotStateEnv;
  compileApplication?: typeof compileFoundationApplication;
  assertLifecycleActive?(
    storage: DurableObjectTransaction,
    botId: string,
  ): Promise<void>;
  outboundFetch?: typeof fetch;
  /** Supplied by the Durable Object; defaults to the kernel implementation. */
  createAuthority?: CreateBotDurableAuthority;
}

function optionalStoredRun(input: unknown): StoredRun | undefined {
  return input === undefined ? undefined : requireStoredRunV1(input);
}

export class ShellBotBackendContribution {
  readonly ctx: DurableObjectState;
  readonly env: BotStateEnv;
  private readonly compileApplication: typeof compileFoundationApplication;
  private readonly lifecycleAdmission?: ShellBotBackendHost["assertLifecycleActive"];
  private readonly reconciliationActivities = new Map<
    string,
    Promise<ClientTurnV1>
  >();
  private readonly outboundFetch?: typeof fetch;
  private readonly assignmentActivities = new Map<string, AssignmentActivity>();
  /** The Turn currently executing on this object, for durable Stop. */
  private activeTurn:
    { runId: string; sessionId: string; cancel(): void } | undefined;
  /**
   * Admission, the event log, the cursor, idempotency, cancellation, and
   * durable scheduling are kernel authority; this Package supplies only the
   * configuration, Composition, and notification policy it needs.
   */
  private readonly authority: BotDurableAuthority<BotSettingsViewV1>;
  /**
   * The Routines authority for this Bot. One store per object, over the same
   * Durable Object storage every other durable record lives in.
   */
  private readonly routines: RoutineStore;
  /**
   * The Routine scheduler, composed into the object's one alarm. It owns no
   * alarm of its own: `scheduledDeadlines`, `deferScheduledWork` and
   * `settleScheduledWork` are the whole of its access to the clock.
   */
  private readonly routineScheduler: RoutineScheduler;
  /**
   * The completion inbox and the pending-input queue. An automation Turn cannot
   * speak to its User, so this is where its outcome lands, written in the same
   * transaction that settles the Turn.
   */
  private readonly routineInbox: RoutineInboxStore;

  constructor(host: ShellBotBackendHost) {
    this.ctx = host.state;
    this.env = host.env;
    this.compileApplication =
      host.compileApplication ?? compileFoundationApplication;
    this.lifecycleAdmission = host.assertLifecycleActive;
    this.outboundFetch = host.outboundFetch;
    const routines = createBotRoutines(
      host.state.storage,
      createBotRoutineHookMinter(
        () => this.authority.readDurableIdentity(),
        host.env.ROUTINE_HOOK_SECRET,
      ),
    );
    this.routines = routines.store;
    this.routineScheduler = routines.scheduler;
    this.routineInbox = new RoutineInboxStore(host.state.storage);
    const createAuthority: CreateBotDurableAuthority =
      host.createAuthority ?? ((options) => new BotDurableAuthority(options));
    this.authority = createAuthority<BotSettingsViewV1>({
      state: host.state,
      codec: storedRunCodecV1,
      hooks: {
        resolveAdmissionSnapshot: (command) =>
          this.resolveAdmissionSnapshot(command),
        bootstrapComposition: () => this.bootstrapComposition(),
        admittedSnapshot: (transaction, resolved) =>
          this.admittedSnapshot(transaction, resolved),
        executeTurn: (input) => this.executeTurn(input),
        notification: (snapshot, result) =>
          this.createNotification(snapshot, result),
        terminalRecords: (input) => this.terminalPackageRecords(input),
        scheduledDeadlines: (transaction) =>
          this.scheduledDeadlines(transaction),
        scheduledWorkInFlight: () => this.assignmentActivities.size > 0,
        deferScheduledWork: (transaction) =>
          this.deferScheduledWork(transaction),
        settleScheduledWork: () => this.settleScheduledWork(),
      },
    });
  }

  async materializeSettings(
    identity: BotIdentity,
    initial: {
      name: string;
      /** The persona the Bot's profile is seeded with, when its creator gave one. */
      description?: string;
      model?: BotSettingsViewV1["model"];
      modelBinding?: {
        assignment: BotSettingsViewV1["assignments"][number];
        generation: string;
      };
    },
  ): Promise<BotSettingsViewV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        durableIdentity &&
        (durableIdentity.userId !== identity.userId ||
          durableIdentity.botId !== identity.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      const existing = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (existing) return existing;
      const settings = {
        ...this.initialBotSettings(identity.botId, initial.model),
        profile: {
          name: initial.name,
          ...(initial.description === undefined
            ? {}
            : { description: initial.description }),
        },
        assignments: initial.modelBinding
          ? [structuredClone(initial.modelBinding.assignment)]
          : [],
      } satisfies BotSettingsViewV1;
      await transaction.put({
        [IDENTITY_KEY]: durableIdentity ?? identity,
        [BOT_CONFIGURATION_KEY]: settings,
        ...(initial.modelBinding
          ? {
              [assignmentGenerationKey(
                initial.modelBinding.assignment.assignmentId,
              )]: initial.modelBinding.generation,
            }
          : {}),
      });
      return settings;
    });
  }

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    const settings = await this.ensureBotSettings(identity);
    if (settings.assignments.length === 0) return settings;
    const [user, application] = await Promise.all([
      this.userConfiguration(identity).readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      }),
      this.compileApplication(),
    ]);
    const plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    return { ...settings, assignments: plan.assignments };
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
    const active = this.assignmentActivities.get(command.commandId);
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
          this.assignmentActivities.get(command.commandId)?.promise === activity
        ) {
          this.assignmentActivities.delete(command.commandId);
        }
      });
    this.assignmentActivities.set(command.commandId, {
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
    const settings = await this.ensureBotSettings(identity);
    const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
    const existing =
      await this.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
    if (existing) {
      const receipt = requireMatchingConfigurationReceipt(
        existing,
        commandFingerprint,
        command.commandId,
      );
      if (
        command.type === "bot/assign-capability" ||
        command.type === "bot/replace-capability" ||
        command.type === "bot/unassign-capability"
      ) {
        try {
          await this.reconcileStoredAssignmentSaga(
            identity,
            command.commandId,
            commandFingerprint,
          );
        } catch {
          // The durable accepted receipt remains replayable while recovery is
          // retrying; alarm reconciliation owns eventual settlement.
        }
        const pending = await this.ctx.storage.get<unknown>(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
        );
        if (pending !== undefined) {
          const saga = requireStoredAssignmentSaga(pending);
          if (saga.commandFingerprint !== commandFingerprint) {
            throw new Error(
              `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
            );
          }
          return saga.acceptedReceipt;
        }
      }
      return receipt;
    }
    if (command.expectedRevision !== settings.revision) {
      throw new ConfigurationConflictError(settings.revision);
    }
    let modelCapabilities = new Set<string>();
    if (command.type === "bot/select-model") {
      const [user, application] = await Promise.all([
        this.userConfiguration(identity).readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
        this.compileApplication(),
      ]);
      modelCapabilities = new Set(
        application.packages.flatMap((pkg) =>
          (pkg.manifest.configuration?.capabilities ?? []).flatMap(
            (capability) =>
              capability.kind === "model"
                ? [capabilityKey(pkg.id, capability.id)]
                : [],
          ),
        ),
      );
      const binding = resolveBotModelBindingV1({
        model: command.model,
        assignments: settings.assignments,
        user,
        packages: application.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          capabilities: pkg.manifest.configuration?.capabilities ?? [],
          connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
        })),
      });
      if (binding.state === "unavailable") {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          binding.failure ?? "Bot model binding is unavailable",
        );
      }
    }
    if (
      command.type === "bot/assign-capability" ||
      command.type === "bot/replace-capability"
    ) {
      const existingAssignment = settings.assignments.find(
        (assignment) =>
          assignment.assignmentId === command.assignment.assignmentId,
      );
      if (
        existingAssignment &&
        (existingAssignment.packageId !== command.assignment.packageId ||
          existingAssignment.capabilityId !== command.assignment.capabilityId)
      ) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Assignment ID cannot change Package Capability authority",
        );
      }
      const [user, application] = await Promise.all([
        this.userConfiguration(identity).readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
        this.compileApplication(),
      ]);
      modelCapabilities = new Set(
        application.packages.flatMap((pkg) =>
          (pkg.manifest.configuration?.capabilities ?? []).flatMap(
            (capability) =>
              capability.kind === "model"
                ? [capabilityKey(pkg.id, capability.id)]
                : [],
          ),
        ),
      );
      const failure = capabilityAssignmentFailureV1({
        assignment: command.assignment,
        user,
        packages: application.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          capabilities: pkg.manifest.configuration?.capabilities ?? [],
          connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
        })),
      });
      if (failure) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          failure,
        );
      }
      if (command.model) {
        if (command.model.connectionId !== command.assignment.connectionId) {
          return this.rejectConfigurationCommand(
            identity,
            command,
            commandFingerprint,
            "Model binding must use the assigned Connection",
          );
        }
        const binding = resolveBotModelBindingV1({
          model: command.model,
          assignments: [
            ...settings.assignments,
            { ...command.assignment, state: "enabled" },
          ],
          user,
          packages: application.packages.map((pkg) => ({
            packageId: pkg.id,
            version: pkg.version,
            capabilities: pkg.manifest.configuration?.capabilities ?? [],
            connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
          })),
        });
        if (binding.state === "unavailable") {
          return this.rejectConfigurationCommand(
            identity,
            command,
            commandFingerprint,
            binding.failure ?? "Bot model binding is unavailable",
          );
        }
      }
    }
    if (
      command.type === "bot/select-model" &&
      settings.model?.connectionId &&
      settings.model.connectionId !== command.model.connectionId
    ) {
      // Moving the model to another Connection changes Assignment authority,
      // so it is a Replace, not a select. One durable shape, one saga.
      return this.rejectConfigurationCommand(
        identity,
        command,
        commandFingerprint,
        "Selecting a model on another Connection requires Replace",
      );
    }
    if (command.type === "bot/unbind-model") {
      const assignment = settings.assignments.find(
        (candidate) =>
          candidate.assignmentId === command.assignmentId &&
          (candidate.state === "enabled" ||
            candidate.state === "unavailable") &&
          candidate.connectionId === settings.model?.connectionId,
      );
      const application = await this.compileApplication();
      const capability = application.packages
        .find((pkg) => pkg.id === assignment?.packageId)
        ?.manifest.configuration?.capabilities.find(
          (candidate) => candidate.id === assignment?.capabilityId,
        );
      if (!assignment?.connectionId || capability?.kind !== "model") {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Bot model assignment is unavailable",
        );
      }
      const generation = await this.ctx.storage.get<string>(
        assignmentGenerationKey(assignment.assignmentId),
      );
      if (!generation) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Bot model assignment generation is unavailable",
        );
      }
      // Unbinding the model is the Assignment's Unassign: one saga releases
      // the Connection dependency and clears the Bot's model together.
      return this.executeAssignmentCommand(
        identity,
        {
          ...command,
          type: "bot/unassign-capability",
          assignmentId: assignment.assignmentId,
        },
        commandFingerprint,
        { clearModel: true },
      );
    }

    if (
      command.type !== "bot/assign-capability" &&
      command.type !== "bot/replace-capability" &&
      command.type !== "bot/unassign-capability"
    ) {
      return this.applySimpleConfigurationCommand(
        identity,
        command,
        commandFingerprint,
      );
    }
    return this.executeAssignmentCommand(
      identity,
      command,
      commandFingerprint,
      {
        ...(command.type === "bot/unassign-capability"
          ? {}
          : { model: command.model }),
      },
    );
  }

  private async rejectConfigurationCommand(
    identity: BotIdentity,
    command: Extract<ConfigurationCommandV1, { botId: string }>,
    commandFingerprint: string,
    failure: string,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
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
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: current.revision,
        status: "rejected",
        failure,
      };
      await transaction.put(receiptKey, { commandFingerprint, receipt });
      return receipt;
    });
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
          | "bot/select-model";
      }
    >,
    commandFingerprint: string,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      await this.lifecycleAdmission?.(transaction, identity.botId);
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
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      if (current.assignmentOperations.length > 0) {
        throw new Error("An Assignment operation is still retrying");
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
              : { ...current, revision, model: command.model };
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
    transaction: {
      get<T>(key: string): Promise<T | undefined>;
      put(entries: Record<string, unknown>): Promise<void>;
      list<T>(options: { prefix: string }): Promise<Map<string, T>>;
      delete(keys: string[]): Promise<number>;
    },
    rename: {
      from: string;
      to: string;
      namedBy: "user" | "bot";
      writer?: BotSelfWriterV1;
    },
  ): Promise<void> {
    const seq =
      ((await transaction.get<number>(BOT_ANNOUNCEMENT_SEQUENCE_KEY)) ?? -1) +
      1;
    const event: SessionEvent = {
      type: "bot/renamed",
      seq,
      timestamp: new Date().toISOString(),
      from: rename.from,
      to: rename.to,
      namedBy: rename.namedBy,
      ...(rename.writer ? { writer: rename.writer } : {}),
    };
    await transaction.put({
      [botAnnouncementKey(seq)]: event,
      [BOT_ANNOUNCEMENT_SEQUENCE_KEY]: seq,
    });
    const stored = await transaction.list<unknown>({
      prefix: BOT_ANNOUNCEMENT_PREFIX,
    });
    const expired = [...stored.keys()]
      .sort()
      .slice(0, Math.max(0, stored.size - BOT_ANNOUNCEMENT_RETENTION));
    if (expired.length > 0) await transaction.delete(expired);
  }

  /** The announcements the Session shows, oldest first. */
  async listAnnouncements(): Promise<SessionEvent[]> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: BOT_ANNOUNCEMENT_PREFIX,
    });
    return [...stored.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => decodeSessionEvent(value));
  }

  private async assignmentRequirement(
    identity: BotIdentity,
    assignment: Omit<BotSettingsViewV1["assignments"][number], "state">,
  ): Promise<
    | {
        user: UserSettingsViewV1;
        requirement?: ConnectionDependencyRequirementV1;
      }
    | { failure: string }
  > {
    const [user, application] = await Promise.all([
      this.userConfiguration(identity).readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      }),
      this.compileApplication(),
    ]);
    const packages = application.packages.map((pkg) => ({
      packageId: pkg.id,
      version: pkg.version,
      capabilities: pkg.manifest.configuration?.capabilities ?? [],
      connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
    }));
    const failure = capabilityAssignmentFailureV1({
      assignment,
      user,
      packages,
    });
    if (failure) return { failure };
    if (!assignment.connectionId) return { user };
    const installation = user.packages.find(
      (pkg) =>
        pkg.packageId === assignment.packageId && pkg.state === "installed",
    );
    const pkg = application.packages.find(
      (candidate) =>
        candidate.id === assignment.packageId &&
        candidate.version === installation?.version,
    );
    const capability = pkg?.manifest.configuration?.capabilities.find(
      (candidate) => candidate.id === assignment.capabilityId,
    );
    if (!installation || !pkg || !capability) {
      return {
        failure: "Capability assignment policy changed during validation",
      };
    }
    return {
      user,
      requirement: {
        schemaVersion: 1,
        packageId: pkg.id,
        packageVersion: pkg.version,
        capabilityId: capability.id,
        connectionTypeIds: [...capability.connectionTypes],
      },
    };
  }

  private async executeAssignmentCommand(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/assign-capability"
          | "bot/replace-capability"
          | "bot/unassign-capability";
      }
    >,
    commandFingerprint: string,
    binding: { model?: ModelAssignment; clearModel?: boolean } = {},
  ): Promise<OperationReceiptV1> {
    try {
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
    } catch (error) {
      const pending = await this.ctx.storage.get<unknown>(
        `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
      );
      if (pending === undefined) throw error;
      const saga = requireStoredAssignmentSaga(pending);
      if (saga.commandFingerprint !== commandFingerprint) throw error;
      return saga.acceptedReceipt;
    }
    const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
    const receipt =
      await this.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
    if (receipt) {
      return requireMatchingConfigurationReceipt(
        receipt,
        commandFingerprint,
        command.commandId,
      );
    }
    const pending = await this.ctx.storage.get<unknown>(
      `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
    );
    if (pending !== undefined) {
      const saga = requireStoredAssignmentSaga(pending);
      if (saga.commandFingerprint !== commandFingerprint) {
        throw new Error(
          `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
        );
      }
      return saga.acceptedReceipt;
    }
    const current = await this.ensureBotSettings(identity);
    const assignmentId =
      command.type === "bot/unassign-capability"
        ? command.assignmentId
        : command.assignment.assignmentId;
    const previous = current.assignments.find(
      (assignment) => assignment.assignmentId === assignmentId,
    );
    if (command.type === "bot/assign-capability" && previous) {
      return this.rejectAssignmentCommand(
        identity,
        command.commandId,
        commandFingerprint,
        `Assignment "${assignmentId}" already exists; use Replace`,
      );
    }
    if (command.type !== "bot/assign-capability" && !previous) {
      return this.rejectAssignmentCommand(
        identity,
        command.commandId,
        commandFingerprint,
        `Assignment "${assignmentId}" does not exist`,
      );
    }
    let targetRequirement: ConnectionDependencyRequirementV1 | undefined;
    if (command.type !== "bot/unassign-capability") {
      const validation = await this.assignmentRequirement(
        identity,
        command.assignment,
      );
      if ("failure" in validation) {
        return this.rejectAssignmentCommand(
          identity,
          command.commandId,
          commandFingerprint,
          validation.failure,
        );
      }
      targetRequirement = validation.requirement;
    }
    const previousGeneration = previous?.connectionId
      ? await this.ctx.storage.get<string>(
          `${ASSIGNMENT_GENERATION_PREFIX}${previous.assignmentId}`,
        )
      : undefined;
    const operation =
      command.type === "bot/assign-capability"
        ? "assigning"
        : command.type === "bot/replace-capability"
          ? "replacing"
          : "unassigning";
    await this.ctx.storage.transaction(async (transaction) => {
      await this.lifecycleAdmission?.(transaction, identity.botId);
      const existing = await transaction.get<StoredAssignmentSaga>(
        `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
      );
      if (existing) return;
      const durable =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (durable.revision !== command.expectedRevision) {
        throw new ConfigurationConflictError(durable.revision);
      }
      if (durable.assignmentOperations.length > 0) {
        throw new Error("Another Assignment operation is already pending");
      }
      const target =
        command.type === "bot/unassign-capability"
          ? undefined
          : structuredClone(command.assignment);
      const phase =
        operation === "unassigning"
          ? "releasing"
          : target?.connectionId
            ? "claiming"
            : "committing";
      const acceptedReceipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: durable.revision,
        status: "pending",
      };
      const saga: StoredAssignmentSaga = {
        schemaVersion: 1,
        commandId: command.commandId,
        commandFingerprint,
        userId: identity.userId,
        botId: identity.botId,
        operation,
        assignmentId,
        generation: command.commandId,
        phase,
        target,
        targetRequirement,
        previous: previous ? structuredClone(previous) : undefined,
        previousGeneration,
        // The Bot's model commits with the Assignment, in the saga's commit
        // phase, so the dependency claim and the binding are one durable unit.
        model: binding.model ? structuredClone(binding.model) : undefined,
        clearModel: binding.clearModel,
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
        acceptedReceipt,
      };
      await transaction.put({
        [`${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`]: saga,
        [BOT_CONFIGURATION_KEY]: {
          ...durable,
          assignmentOperations: [
            {
              commandId: command.commandId,
              kind: operation,
              assignmentId,
              state: "pending",
              target,
            },
          ],
        } satisfies BotSettingsViewV1,
      });
      await this.refreshRecoveryAlarm(transaction);
    });
    try {
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
    } catch {
      const pending = requireStoredAssignmentSaga(
        await this.ctx.storage.get<unknown>(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
        ),
      );
      return pending.acceptedReceipt;
    }
    const completed =
      await this.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
    if (!completed) {
      const pending = requireStoredAssignmentSaga(
        await this.ctx.storage.get<unknown>(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
        ),
      );
      return pending.acceptedReceipt;
    }
    return requireMatchingConfigurationReceipt(
      completed,
      commandFingerprint,
      command.commandId,
    );
  }

  private async rejectAssignmentCommand(
    identity: BotIdentity,
    commandId: string,
    commandFingerprint: string,
    failure: string,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      await this.lifecycleAdmission?.(transaction, identity.botId);
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId,
        revision: current.revision,
        status: "rejected",
        failure,
      };
      await transaction.put(`${CONFIGURATION_RECEIPT_PREFIX}${commandId}`, {
        commandFingerprint,
        receipt,
      } satisfies StoredConfigurationReceipt);
      return receipt;
    });
  }

  private async dependencyResult(
    identity: BotIdentity,
    saga: StoredAssignmentSaga,
    action: "claim" | "read" | "acknowledge" | "release" | "reconcile",
    target: "new" | "old",
  ): Promise<import("@frockbot/connection-core").ConnectionDependencyResultV1> {
    const connectionId =
      target === "new"
        ? saga.target?.connectionId
        : saga.previous?.connectionId;
    const generation =
      target === "new" ? saga.generation : saga.previousGeneration;
    if (!connectionId) {
      return { schemaVersion: 1, status: "released" };
    }
    if (!generation) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        failure: `Assignment "${saga.assignmentId}" dependency generation is unavailable`,
      };
    }
    const packageId =
      target === "new" ? saga.target?.packageId : saga.previous?.packageId;
    if (!packageId) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        failure: `Assignment "${saga.assignmentId}" Package identity is unavailable`,
      };
    }
    const base = {
      schemaVersion: 1 as const,
      operationId: `${saga.commandId}:${target}`,
      userId: identity.userId,
      packageId,
      connectionId,
      botId: identity.botId,
      generation,
    };
    return this.userConfiguration(identity).executeConnectionDependency(
      action === "claim"
        ? { ...base, action, requirement: saga.targetRequirement! }
        : { ...base, action },
    );
  }

  private async rejectPendingAssignmentSaga(
    saga: StoredAssignmentSaga,
    failure: string,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const settings = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (!settings) throw new Error("Bot settings are unavailable");
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: saga.commandId,
        revision: settings.revision,
        status: "rejected",
        failure,
      };
      await transaction.put({
        [BOT_CONFIGURATION_KEY]: {
          ...settings,
          assignmentOperations: settings.assignmentOperations.filter(
            (operation) => operation.commandId !== saga.commandId,
          ),
        } satisfies BotSettingsViewV1,
        [`${CONFIGURATION_RECEIPT_PREFIX}${saga.commandId}`]: {
          commandFingerprint: saga.commandFingerprint,
          receipt,
        } satisfies StoredConfigurationReceipt,
      });
      await transaction.delete(`${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`);
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async persistSaga(
    saga: StoredAssignmentSaga,
    patch: Partial<StoredAssignmentSaga>,
    retrying = false,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`;
      const current = await transaction.get<StoredAssignmentSaga>(key);
      if (!current || current.generation !== saga.generation) return;
      await transaction.put(key, {
        ...current,
        ...patch,
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
      } satisfies StoredAssignmentSaga);
      if (retrying) {
        const settings = await transaction.get<BotSettingsViewV1>(
          BOT_CONFIGURATION_KEY,
        );
        if (settings) {
          await transaction.put(BOT_CONFIGURATION_KEY, {
            ...settings,
            assignmentOperations: settings.assignmentOperations.map(
              (operation) =>
                operation.commandId === saga.commandId
                  ? { ...operation, state: "retrying" as const }
                  : operation,
            ),
          } satisfies BotSettingsViewV1);
        }
      }
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async commitAssignmentSaga(
    saga: StoredAssignmentSaga,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = (await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      ))!;
      const existing = await transaction.get<StoredConfigurationReceipt>(
        `${CONFIGURATION_RECEIPT_PREFIX}${saga.commandId}`,
      );
      if (existing) return existing.receipt;
      const revision = current.revision + 1;
      const assignments =
        saga.operation === "unassigning"
          ? current.assignments.filter(
              (assignment) => assignment.assignmentId !== saga.assignmentId,
            )
          : [
              ...current.assignments.filter(
                (assignment) => assignment.assignmentId !== saga.assignmentId,
              ),
              { ...saga.target!, state: "enabled" as const },
            ];
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: saga.commandId,
        revision,
        status: "applied",
      };
      await transaction.put({
        [BOT_CONFIGURATION_KEY]: {
          ...current,
          revision,
          assignments,
          ...(saga.clearModel
            ? { model: undefined }
            : saga.model
              ? { model: structuredClone(saga.model) }
              : {}),
        } satisfies BotSettingsViewV1,
        [`${CONFIGURATION_RECEIPT_PREFIX}${saga.commandId}`]: {
          commandFingerprint: saga.commandFingerprint,
          receipt,
        } satisfies StoredConfigurationReceipt,
      });
      if (saga.target?.connectionId) {
        await transaction.put(
          `${ASSIGNMENT_GENERATION_PREFIX}${saga.assignmentId}`,
          saga.generation,
        );
      } else if (saga.operation === "unassigning") {
        await transaction.delete(
          `${ASSIGNMENT_GENERATION_PREFIX}${saga.assignmentId}`,
        );
      }
      return receipt;
    });
  }

  private async markSagaAssignmentUnavailable(
    saga: StoredAssignmentSaga,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const settings = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (!settings) return;
      await transaction.put(BOT_CONFIGURATION_KEY, {
        ...settings,
        assignments: settings.assignments.map((assignment) =>
          assignment.assignmentId === saga.assignmentId
            ? { ...assignment, state: "unavailable" as const }
            : assignment,
        ),
      } satisfies BotSettingsViewV1);
    });
  }

  private async finishAssignmentSaga(
    saga: StoredAssignmentSaga,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`;
      const current = await transaction.get<StoredAssignmentSaga>(key);
      if (current?.generation !== saga.generation) return;
      const settings = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (settings) {
        await transaction.put(BOT_CONFIGURATION_KEY, {
          ...settings,
          assignmentOperations: settings.assignmentOperations.filter(
            (operation) => operation.commandId !== saga.commandId,
          ),
        } satisfies BotSettingsViewV1);
      }
      await transaction.delete(key);
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async reconcileStoredAssignmentSaga(
    identity: BotIdentity,
    commandId: string,
    commandFingerprint?: string,
  ): Promise<void> {
    const key = `${ASSIGNMENT_SAGA_PREFIX}${commandId}`;
    const storedSaga = await this.ctx.storage.get<unknown>(key);
    let saga =
      storedSaga === undefined
        ? undefined
        : requireStoredAssignmentSaga(storedSaga);
    if (!saga) return;
    if (saga.userId !== identity.userId || saga.botId !== identity.botId) {
      throw new Error("Assignment saga does not match its durable identity");
    }
    if (
      commandFingerprint !== undefined &&
      saga.commandFingerprint !== commandFingerprint
    ) {
      throw new Error(
        `Configuration command idempotency key "${commandId}" was reused for a different command`,
      );
    }
    try {
      for (let step = 0; step < 8 && saga; step += 1) {
        if (saga.phase === "claiming") {
          if (!saga.claimDispatched) {
            await this.persistSaga(saga, { claimDispatched: true });
            saga = { ...saga, claimDispatched: true };
          }
          let result = await this.dependencyResult(
            identity,
            saga,
            saga.claimDispatched ? "read" : "claim",
            "new",
          );
          if (result.status === "absent") {
            result = await this.dependencyResult(
              identity,
              saga,
              "claim",
              "new",
            );
          }
          if (result.status === "pending" || result.status === "unavailable") {
            if (result.status === "pending") {
              await this.dependencyResult(identity, saga, "reconcile", "new");
            }
            await this.persistSaga(saga, {}, true);
            return;
          }
          if (result.status !== "claimed" && result.status !== "acknowledged") {
            await this.rejectPendingAssignmentSaga(
              saga,
              ("failure" in result ? result.failure : undefined) ??
                "Connection dependency claim rejected",
            );
            return;
          }
          await this.persistSaga(saga, { phase: "committing" });
          saga = { ...saga, phase: "committing" };
          continue;
        }
        if (saga.phase === "committing") {
          const receipt = await this.commitAssignmentSaga(saga);
          const phase: StoredAssignmentSaga["phase"] | undefined = saga.target
            ?.connectionId
            ? "acknowledging"
            : saga.previous?.connectionId
              ? "releasing"
              : undefined;
          if (!phase) {
            await this.finishAssignmentSaga({ ...saga, receipt });
            return;
          }
          await this.persistSaga(saga, { phase, receipt });
          saga = { ...saga, phase, receipt };
          continue;
        }
        if (saga.phase === "acknowledging") {
          if (!saga.acknowledgeDispatched) {
            await this.persistSaga(saga, { acknowledgeDispatched: true });
            saga = { ...saga, acknowledgeDispatched: true };
          }
          let result = await this.dependencyResult(
            identity,
            saga,
            "read",
            "new",
          );
          if (result.status === "claimed") {
            result = await this.dependencyResult(
              identity,
              saga,
              "acknowledge",
              "new",
            );
          }
          if (result.status === "pending" || result.status === "unavailable") {
            if (result.status === "pending") {
              await this.dependencyResult(identity, saga, "reconcile", "new");
            }
            await this.persistSaga(saga, {}, true);
            return;
          }
          if (result.status !== "acknowledged") {
            if (result.status === "rejected" || result.status === "absent") {
              await this.markSagaAssignmentUnavailable(saga);
              if (!saga.previous?.connectionId) {
                await this.finishAssignmentSaga(saga);
                return;
              }
              await this.persistSaga(saga, { phase: "releasing" });
              saga = { ...saga, phase: "releasing" };
              continue;
            }
            throw new Error(
              ("failure" in result ? result.failure : undefined) ??
                "Connection dependency acknowledgement rejected",
            );
          }
          if (!saga.previous?.connectionId) {
            await this.finishAssignmentSaga(saga);
            return;
          }
          await this.persistSaga(saga, { phase: "releasing" });
          saga = { ...saga, phase: "releasing" };
          continue;
        }
        if (!saga.previous?.connectionId) {
          if (saga.operation === "unassigning")
            await this.commitAssignmentSaga(saga);
          await this.finishAssignmentSaga(saga);
          return;
        }
        if (!saga.releaseDispatched) {
          await this.persistSaga(saga, { releaseDispatched: true });
          saga = { ...saga, releaseDispatched: true };
        }
        let result = await this.dependencyResult(identity, saga, "read", "old");
        if (result.status === "claimed" || result.status === "acknowledged") {
          result = await this.dependencyResult(
            identity,
            saga,
            "release",
            "old",
          );
        }
        if (result.status === "pending" || result.status === "unavailable") {
          if (result.status === "pending") {
            await this.dependencyResult(identity, saga, "reconcile", "old");
          }
          await this.persistSaga(saga, {}, true);
          return;
        }
        if (result.status !== "released" && result.status !== "absent") {
          throw new Error(
            ("failure" in result ? result.failure : undefined) ??
              "Connection dependency release rejected",
          );
        }
        if (saga.operation === "unassigning")
          await this.commitAssignmentSaga(saga);
        await this.finishAssignmentSaga(saga);
        return;
      }
    } catch (error) {
      await this.persistSaga(saga, {}, true);
      throw error;
    }
  }

  private async refreshRecoveryAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    await this.authority.refreshRecoveryAlarm(transaction);
  }
  async markConnectionUnavailable(
    identity: BotIdentity,
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale"> {
    await this.ensureBotSettings(identity);
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${ASSIGNMENT_COMPENSATION_PREFIX}${compensation.id}`;
      const existing = await transaction.get<"applied" | "stale">(receiptKey);
      if (existing) return existing;
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      // Every enabled Assignment on this Connection whose durable generation
      // is the compensated one becomes unavailable. A compensation that names
      // a generation no live Assignment holds is stale, not a silent no-op.
      const matching: string[] = [];
      for (const assignment of current.assignments) {
        if (
          assignment.connectionId !== connectionId ||
          assignment.state !== "enabled"
        ) {
          continue;
        }
        if (
          (await transaction.get<string>(
            assignmentGenerationKey(assignment.assignmentId),
          )) === compensation.expectedGeneration
        ) {
          matching.push(assignment.assignmentId);
        }
      }
      await transaction.put(
        `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionId}:${compensation.expectedGeneration}`,
        compensation.id,
      );
      if (matching.length === 0) {
        await transaction.put(receiptKey, "stale");
        return "stale";
      }
      const unavailable = new Set(matching);
      await transaction.put(BOT_CONFIGURATION_KEY, {
        ...current,
        revision: current.revision + 1,
        assignments: current.assignments.map((assignment) =>
          unavailable.has(assignment.assignmentId)
            ? { ...assignment, state: "unavailable" as const }
            : assignment,
        ),
      } satisfies BotSettingsViewV1);
      await this.refreshRecoveryAlarm(transaction);
      await transaction.put(receiptKey, "applied");
      return "applied";
    });
  }

  async resolveConfiguration(
    identity: BotIdentity,
  ): Promise<BotExecutionPlanV1> {
    return (await this.resolveExecutionContext(identity)).plan;
  }

  async run(command: OwnedBotTurnCommand): Promise<ClientTurnV1> {
    return projectClientTurnV1(await this.authority.run(command));
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
    const reads = createBotSkillsReads(this.env);
    if (!reads) return { schemaVersion: 1, skills: [] };
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const pluginSkills = createBotPluginSkillsSource(
      user.packages,
      createBotSkillCatalogReader(this.env),
    );
    const catalog = await loadFullSkillCatalogV1(
      reads,
      { userId: identity.userId, botId: identity.botId },
      { ...(pluginSkills ? { pluginSkills } : {}) },
    );
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
    const admitted = await this.ctx.storage.transaction(async (transaction) => {
      const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
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
    });
    // The Agent signal is advisory and always follows the durable intent.
    this.cancelActiveTurn({
      sessionId: admitted.sessionId,
      runId: command.runId,
    });
    const current =
      optionalStoredRun(await this.ctx.storage.get<unknown>(key)) ?? admitted;
    return createClientRunStopReceiptV1(command, projectClientRunV1(current));
  }

  async reconcileRun(
    identity: BotIdentity,
    runId: string,
  ): Promise<ClientTurnV1> {
    const active = this.reconciliationActivities.get(runId);
    if (active) return active;
    const operation = this.executeRunReconciliation(identity, runId).finally(
      () => {
        if (this.reconciliationActivities.get(runId) === operation) {
          this.reconciliationActivities.delete(runId);
        }
      },
    );
    this.reconciliationActivities.set(runId, operation);
    return operation;
  }

  /**
   * Retrieval is itself reconciliation: the kernel authority resumes the run
   * on the Composition it was admitted under, so an uncertain effect is
   * settled or stays explicitly unresolved rather than being started again.
   */
  private async executeRunReconciliation(
    identity: BotIdentity,
    runId: string,
  ): Promise<ClientTurnV1> {
    return projectClientTurnV1(
      await this.authority.reconcileRun(identity, runId),
    );
  }
  private async executeTurn(
    input: BotTurnExecutionInput<BotSettingsViewV1>,
  ): Promise<BotTurnCompletion> {
    const settings = input.configurationSnapshot;
    const turn = {
      runId: input.command.runId,
      // One admitted Turn is one run; the Turn ordinal lives in the session log.
      turnId: input.command.runId,
      sessionId: input.command.sessionId,
    };
    const runtime = await this.agentRuntime(
      input.identity,
      settings,
      input.admittedRequest,
      turn,
    );
    const promptParts = [
      `You are ${settings.profile.name}.`,
      settings.profile.label,
      settings.profile.description,
    ].filter((part): part is string => Boolean(part?.trim()));
    // The pin, never the current generation: activation takes effect at the
    // next admitted Turn, and an in-flight Turn completes on what it pinned.
    // The isolate bindings follow the generation actually being mounted, so a
    // fail-closed fallback loads the last known good's members, not the
    // pinned generation's.
    const host: CompositionMountHost<ShellMountedComposition> = {
      mount: async (mounting, signal) => {
        const isolate = await this.isolateMountOptions(input.identity, {
          runId: input.command.runId,
          sessionId: input.command.sessionId,
          generationId: mounting.generationId,
          assignments: settings.assignments,
        });
        return createShellCompositionHost({
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
        }).mount(mounting, signal);
      },
    };
    const controller = new AbortController();
    // Composition fails closed: a generation that does not resolve, mount, or
    // pass `health()` leaves the last known good resident, records a durable
    // failure, raises a visible one, and the Turn is admitted anyway.
    const activation = await activateCompositionV1({
      generationId: input.compositionGenerationId,
      store: {
        read: (generationId) => this.authority.composition.read(generationId),
        lastKnownGood: () => this.authority.composition.lastKnownGood(),
        commit: (generationId) =>
          this.authority.composition.commit(generationId),
        fail: (generationId, options) =>
          this.authority.composition.fail(generationId, options),
      },
      failures: this.authority.compositionFailures,
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
      await this.authority.repinRun(
        input.command.runId,
        activation.fallback.generationId,
      );
    }
    // The exact resident Agent this Turn runs on, so a durable Stop reaches
    // that run and never a different one.
    const active = {
      runId: input.command.runId,
      sessionId: input.command.sessionId,
      cancel: () => activation.mounted.runtime.agent.agent.cancel("user"),
    };
    this.activeTurn = active;
    try {
      return await executeBotTurn({
        command: {
          ...input.command,
          text: await this.turnInputTextV1(input.command),
        },
        previousEvents: input.previousEvents,
        composition: activation.mounted,
        resume: input.resume,
      });
    } finally {
      if (this.activeTurn === active) this.activeTurn = undefined;
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
    const drained = await this.routineInbox.drainInto(command.runId);
    const preamble = pendingBotInputPreambleV1(drained);
    return preamble.length === 0
      ? command.text
      : `${preamble}\n${command.text}`;
  }

  /**
   * Cancels the Agent of one exact admitted run. A late Stop that names a run
   * this object is not executing changes nothing.
   */
  private cancelActiveTurn(cancellation: {
    sessionId: string;
    runId: string;
  }): boolean {
    const active = this.activeTurn;
    if (
      !active ||
      active.runId !== cancellation.runId ||
      active.sessionId !== cancellation.sessionId
    ) {
      return false;
    }
    active.cancel();
    return true;
  }

  /** The visible half of failing closed, on the Bot's existing channel. */
  private async recordCompositionFailureNotification(
    settings: BotSettingsViewV1,
    runId: string,
    failure: CompositionFailureV1,
    fallback: CompositionGenerationV1,
  ): Promise<void> {
    await this.authority.recordNotification({
      notificationId: `composition-failure:${failure.generationId}:${failure.attempt}`,
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
   * Everything a Bot isolate member needs. Returns `undefined` when this host
   * has no Package loader, in which case an isolate member fails verification
   * rather than silently running nowhere.
   */
  private async isolateMountOptions(
    identity: BotIdentity,
    turn: {
      runId: string;
      sessionId: string;
      generationId: string;
      assignments: readonly CapabilityAssignmentView[];
    },
  ): Promise<ShellIsolateMountOptions | undefined> {
    const loader = this.env.BOT_PACKAGES;
    const artifacts = this.env.APPLICATION_ARTIFACTS;
    const exports = (
      this.ctx as unknown as {
        exports?: {
          BotCapabilities?: (options: {
            props: BotCapabilitiesPropsV1;
          }) => BotCapabilitiesStub;
        };
      }
    ).exports;
    if (!loader || !artifacts || !exports?.BotCapabilities) return undefined;
    const mintCapabilities = exports.BotCapabilities;
    const assignments = await this.isolateAssignments(turn.assignments);
    return {
      userId: identity.userId,
      runId: turn.runId,
      // One admitted Turn is one run; the Turn ordinal lives in the session log.
      turnId: turn.runId,
      loader,
      artifacts: createR2PackageArtifactStore(artifacts),
      capabilitiesFor: (member) =>
        mintCapabilities({
          props: {
            userId: identity.userId,
            botId: identity.botId,
            generationId: turn.generationId,
            packageId: member.packageId,
            assignments: structuredClone(assignments),
          },
        }),
      bindingDigest: await isolateBindingDigestV1(
        assignments,
        turn.generationId,
      ),
      compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
    };
  }

  /**
   * The Bot Durable Object side of `CAPABILITIES.requestAuthority`. Never a
   * grant: it records a durable pending decision for the User.
   */
  async isolateRequestAuthority(input: {
    botId: string;
    packageId: string;
    generationId: string;
    request: unknown;
  }): Promise<IsolatePendingDecisionV1> {
    return await this.isolateCapabilities(input, []).requestAuthority(
      input.request,
    );
  }

  /**
   * The Bot Durable Object side of `CAPABILITIES.invokeModel`. Refuses with a
   * pending decision unless an enabled model Assignment matches; otherwise
   * records the normalized request and streams through the provider path,
   * which takes the credential lease on the way.
   */
  async isolateInvokeModel(
    identity: BotIdentity,
    input: {
      packageId: string;
      generationId: string;
      request: NormalizedModelRequest;
    },
  ): Promise<IsolateModelInvocationV1> {
    // The Bot Durable Object's own durable configuration is what decides
    // whether the Assignment exists at all, and its durable model binding is
    // what the Assignment authorizes. Nothing the Bot supplied is read.
    const stored = await this.ctx.storage.get<BotSettingsViewV1>(
      BOT_CONFIGURATION_KEY,
    );
    // An isolate model request is authorized exactly as an admitted Turn is,
    // so it resolves the same execution context: a Bot that follows the
    // User's default model claims its own durable Assignment here rather than
    // failing closed on an authority it is entitled to hold.
    let settings = stored;
    if (stored) {
      try {
        settings = (await this.resolveExecutionContext(identity)).settings;
      } catch {
        settings = stored;
      }
    }
    const projected = await this.isolateAssignments(
      settings?.assignments ?? [],
    );
    const bound = await this.isolateModelBinding(identity, settings, projected);
    const assignments = bound
      ? projected.map((assignment) =>
          assignment.assignmentId === bound.binding.assignmentId
            ? {
                ...assignment,
                connectionId: bound.binding.connectionId,
                providerModelId: bound.binding.providerModelId,
              }
            : assignment,
        )
      : projected;
    const host = this.isolateCapabilities(
      {
        botId: identity.botId,
        packageId: input.packageId,
        generationId: input.generationId,
      },
      assignments,
      bound
        ? {
            binding: bound.binding,
            path: this.isolateModelPath(
              identity,
              bound.runtime,
              input.generationId,
            ),
          }
        : undefined,
    );
    return await host.invokeModel(input.request);
  }

  /**
   * The Bot's one durable model binding, projected onto the isolate view. It
   * resolves the Bot's durable `model` through the User's Connection exactly
   * as an admitted Turn does, so an isolate model request is authorized
   * against the same Package, Connection, and provider model a Turn would use.
   * An unresolvable binding is no binding: the request becomes a pending
   * decision rather than an error thrown into Bot code.
   */
  private async isolateModelBinding(
    identity: BotIdentity,
    settings: BotSettingsViewV1 | undefined,
    assignments: readonly IsolateAssignmentV1[],
  ): Promise<
    | {
        binding: IsolateModelBindingV1;
        runtime: {
          agentPackages: FoundationAgentPackage[];
          modelSelection: RuntimeModelSelection;
        };
      }
    | undefined
  > {
    if (!settings) return undefined;
    let runtime: {
      agentPackages: FoundationAgentPackage[];
      modelSelection: RuntimeModelSelection;
    };
    try {
      runtime = await this.agentRuntime(identity, settings);
    } catch {
      return undefined;
    }
    const selection = runtime.modelSelection;
    const connectionId = selection.connectionId;
    if (!connectionId) return undefined;
    const assignment = assignments.find(
      (candidate) =>
        candidate.kind === "model" && candidate.connectionId === connectionId,
    );
    if (!assignment) return undefined;
    return {
      runtime,
      binding: {
        assignmentId: assignment.assignmentId,
        packageId: assignment.packageId,
        capabilityId: assignment.capabilityId,
        connectionId,
        provider: selection.provider,
        providerModelId: selection.model,
        ...(selection.connectionGeneration
          ? { connectionGeneration: selection.connectionGeneration }
          : {}),
        ...(selection.catalogGeneration
          ? { catalogGeneration: selection.catalogGeneration }
          : {}),
      },
    };
  }

  private isolateCapabilities(
    scope: {
      botId: string;
      packageId: string;
      generationId: string;
      request?: unknown;
    },
    assignments: readonly IsolateAssignmentV1[],
    model?: { binding: IsolateModelBindingV1; path: IsolateModelPath },
  ): IsolateCapabilityHost {
    return createIsolateCapabilityHost({
      storage: {
        put: (key, value) => this.ctx.storage.put(key, value),
        get: (key) => this.ctx.storage.get(key),
        list: (options) => this.ctx.storage.list(options),
      },
      botId: scope.botId,
      packageId: scope.packageId,
      generationId: scope.generationId,
      assignments,
      ...(model ? { modelBinding: model.binding, modelPath: model.path } : {}),
    });
  }

  /** The Bot's enabled Assignments, projected onto the isolate capability DTO. */
  private async isolateAssignments(
    assignments: readonly CapabilityAssignmentView[],
  ): Promise<IsolateAssignmentV1[]> {
    const application = await this.compileApplication();
    const projected: IsolateAssignmentV1[] = [];
    for (const assignment of assignments) {
      if (assignment.state !== "enabled") continue;
      const capability = application.packages
        .find((candidate) => candidate.id === assignment.packageId)
        ?.manifest.configuration?.capabilities.find(
          (candidate) => candidate.id === assignment.capabilityId,
        );
      if (!capability) continue;
      projected.push({
        assignmentId: assignment.assignmentId,
        packageId: assignment.packageId,
        capabilityId: assignment.capabilityId,
        kind: capability.kind,
        ...(assignment.connectionId
          ? { connectionId: assignment.connectionId }
          : {}),
      });
    }
    return projected;
  }

  /**
   * Streams through the pinned Composition's mounted `ctx.llm` — the same
   * provider path a Turn uses, so whichever provider Plugin serves the request
   * is the one that takes the credential lease. The runtime is the one the
   * durable model binding resolved to, so the Package that streams is the
   * Package the Assignment names.
   */
  private isolateModelPath(
    identity: BotIdentity,
    runtime: {
      agentPackages: FoundationAgentPackage[];
      modelSelection: RuntimeModelSelection;
    },
    generationId: string,
  ): IsolateModelPath {
    const contribution = this;
    return {
      async *stream(request, signal) {
        const generation =
          await contribution.authority.composition.read(generationId);
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
          // An isolate model invocation is not an admitted Turn, so there is
          // no run to fence it against; it is admitted by its Assignment.
          admitEffect: () => Promise.resolve(true),
        }).mount(generation, signal);
        try {
          yield* composition.root.llm.stream(request, signal);
        } finally {
          await composition.dispose();
        }
      },
    };
  }

  /** The first-party generation this Bot starts on, from the compiled application. */
  private async bootstrapComposition() {
    return bootstrapCompositionGeneration(
      await this.compileApplication(),
      new Date().toISOString(),
    );
  }

  private async resolveAdmissionSnapshot(
    command: OwnedBotTurnCommand,
  ): Promise<BotSettingsViewV1> {
    const context = await this.resolveExecutionContext(command);
    return {
      ...context.settings,
      assignments: context.plan.assignments,
    } satisfies BotSettingsViewV1;
  }

  private async admittedSnapshot(
    transaction: DurableObjectTransaction,
    resolved: BotSettingsViewV1,
  ): Promise<BotSettingsViewV1> {
    return (
      (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
      resolved
    );
  }

  private async scheduledDeadlines(
    transaction: DurableObjectTransaction,
  ): Promise<number[]> {
    const sagas = await transaction.list<unknown>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    return [
      ...[...sagas.values()].map(
        (stored) => requireStoredAssignmentSaga(stored).deadlineAt,
      ),
      ...(await this.routineScheduler.deadlines(transaction)),
    ];
  }

  private async deferScheduledWork(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    const sagas = await transaction.list<StoredAssignmentSaga>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    for (const [key, saga] of sagas) {
      await transaction.put(key, {
        ...saga,
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
      } satisfies StoredAssignmentSaga);
    }
    // A saga's deadline is a retry, so pushing it forward loses nothing. A
    // Routine's is a debt, so the scheduler holds it instead of moving it.
    await this.routineScheduler.defer(transaction);
  }

  private async settleScheduledWork(): Promise<void> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    for (const value of stored.values()) {
      const saga = requireStoredAssignmentSaga(value);
      try {
        await this.reconcileStoredAssignmentSaga(
          { userId: saga.userId, botId: saga.botId },
          saga.commandId,
        );
      } catch (error) {
        console.error(
          "Assignment saga remains durably scheduled after reconciliation failure",
          error instanceof Error ? error.message : "unknown failure",
        );
      }
    }
    await this.settleRoutineFirings();
    await this.replayPendingWakeNotifications();
    // The alarm that woke this object has been consumed. Re-arm on whatever is
    // owed next, or a Routine that fired once would never fire again.
    await this.ctx.storage.transaction((transaction) =>
      this.authority.refreshRecoveryAlarm(transaction),
    );
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
    const identity = await this.authority.readDurableIdentity();
    if (!identity) return;
    // A run already occupies the object. `alarm()` defers before it reaches
    // here whenever the Turn is executing in this isolate, but a durable active
    // run outlives an eviction, and admitting a firing against one would burn
    // the occurrence on an error instead of holding the debt.
    if (await this.authority.readActiveRunId()) return;
    await this.routineScheduler.settle(async (fire) => {
      try {
        await this.authority.run(
          routineTurnCommandV1(identity, fire, new Date().toISOString()),
        );
      } catch (error) {
        return routineFireOutcomeV1(
          await this.authority.readStoredRun(fire.fireId),
          error,
        );
      }
      return routineFireOutcomeV1(
        await this.authority.readStoredRun(fire.fireId),
      );
    });
  }
  /**
   * The narrow User Durable Object RPC the Bot uses to reserve one authored
   * generation against the durable per-User quota (D7).
   */
  private authoringQuota(identity: BotIdentity): AuthoringQuotaBinding {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker
    // types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      reserveAuthoringQuota(input: unknown): Promise<unknown>;
    };
    return {
      reserve: async (request) =>
        decodeAuthoringQuotaReceiptV1(await rpc.reserveAuthoringQuota(request)),
    };
  }

  /** The authoring seam one admitted Turn runs under. */
  private authoringHost(
    identity: BotIdentity,
    turn: { runId: string; turnId: string },
  ): PackageAuthoringHost {
    const artifacts = this.env.APPLICATION_ARTIFACTS;
    return createPackageAuthoringHost({
      storage: {
        get: (key) => this.ctx.storage.get(key),
        put: (entries) => this.ctx.storage.put(entries),
      },
      composition: this.authority.composition,
      ...(this.env.PACKAGE_BUNDLER
        ? { bundler: this.env.PACKAGE_BUNDLER }
        : {}),
      ...(artifacts
        ? { artifacts: createR2AuthoringArtifactStore(artifacts) }
        : {}),
      quota: this.authoringQuota(identity),
      userId: identity.userId,
      botId: identity.botId,
      runId: turn.runId,
      turnId: turn.turnId,
      compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
    });
  }

  private async agentRuntime(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
    admittedRequest?: NormalizedModelRequest,
    turn?: { runId: string; turnId: string; sessionId: string },
  ): Promise<{
    agentPackages: FoundationAgentPackage[];
    modelSelection: RuntimeModelSelection;
  }> {
    const userConfiguration = this.userConfiguration(identity);
    const user = await userConfiguration.readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    const packageDefinitions = application.packages.map((pkg) => ({
      packageId: pkg.id,
      version: pkg.version,
      capabilities: pkg.manifest.configuration?.capabilities ?? [],
      connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
    }));
    const plan = admittedRequest
      ? {
          schemaVersion: 1 as const,
          botId: settings.botId,
          revision: settings.revision,
          model: settings.model ? structuredClone(settings.model) : undefined,
          assignments: structuredClone(settings.assignments),
        }
      : resolveBotExecutionPlanV1({
          bot: settings,
          user,
          packages: packageDefinitions,
        });
    const readSecret = (name: string) => {
      // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
      const value = (this.env as unknown as Record<string, unknown>)[name];
      return typeof value === "string" ? value : undefined;
    };
    const authorizeAssignedConnection = admittedRequest
      ? (assignment: BotSettingsViewV1["assignments"][number]) =>
          this.authorizeAdmittedAssignedEffect(identity, assignment)
      : (assignment: BotSettingsViewV1["assignments"][number]) =>
          this.authorizeAssignedEffect(identity, assignment);
    // The Package-level settings this User holds, resolved against the manifest
    // of the Composition this Turn is pinned to. They come from the same `user`
    // read the rest of this Composition uses, so a value the User changed is
    // picked up when the next Turn resolves its Composition and never inside
    // one already running.
    const packageSettings = (
      packageId: string,
    ): Record<string, string | number | boolean> => {
      const installation = user.packages.find(
        (candidate) => candidate.packageId === packageId,
      );
      const declared = application.packages.find(
        (candidate) =>
          candidate.id === packageId &&
          candidate.version === installation?.version,
      );
      return resolvePackageSettingValuesV1(
        declared?.manifest.configuration?.settings ?? [],
        installation?.values,
      );
    };
    // The `image.model` Package setting, already checked against the enum the
    // Image Package's manifest declares.
    const configuredImageModel = packageSettings("image").model;
    const resolvedAgentPackages: FoundationAgentPackage[] = [
      ...createFoundationHostedRuntimePackages(application, {
        userId: identity.userId,
        readSecret,
        // A Bot authors a Package only inside an admitted Turn, whose run and
        // session the artifact provenance names.
        ...(turn ? { authoring: this.authoringHost(identity, turn) } : {}),
        ...(turn
          ? {
              skills: createBotSkillsHost(
                identity,
                turn,
                this.env,
                // The plugin-borne index is built from the same User settings
                // this Turn already read, so an uninstall is visible on the
                // next Turn without a second source of truth about what is
                // installed.
                createBotPluginSkillsSource(
                  user.packages,
                  createBotSkillCatalogReader(this.env),
                ),
              ),
            }
          : {}),
        ...(turn
          ? { memory: createBotMemoryHost(identity, turn, this.env) }
          : {}),
        // A Bot generates an image only inside an admitted Turn, whose Session
        // and Turn the Workspace write names as its writer.
        ...(turn
          ? {
              image: createBotImageHost(
                identity,
                turn,
                this.env,
                typeof configuredImageModel === "string"
                  ? configuredImageModel
                  : undefined,
              ),
            }
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
              }),
            }
          : {}),
        // The MCP lifecycle is offered only inside a Turn, and only with the
        // User's own authority: the tools read and write the records this
        // Bot's User owns, through the seam that already carries them.
        ...(turn
          ? {
              mcp: {
                readStatus: () =>
                  userConfiguration.readMcpServers(identity.userId),
                execute: (command: unknown) =>
                  userConfiguration.executeMcpCommand(identity.userId, command),
              },
            }
          : {}),
        // A Bot writes a Routine only inside a Turn, so the record's writer can
        // name the Session and Turn that produced it.
        ...(turn
          ? {
              routines: createBotRoutinesHost(identity, turn, this.routines),
            }
          : {}),
        // The durable-root sync runs only inside a Turn that uses the
        // Computer. It attributes nothing: a file a shell wrote there reaches
        // object storage with an unattributed writer.
        ...(turn
          ? {
              computerSync: createBotComputerSyncHost(this.env),
              // The same Turn, as the writer a durable Computer write records.
              computerWriter: {
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                runId: turn.runId,
              },
            }
          : {}),
        // The Computer host, when this deployment has one. Both halves or
        // neither: a binding with no token reaches a host that refuses.
        ...(this.env.COMPUTER_HOST && this.env.COMPUTER_HOST_TOKEN
          ? {
              computerHostBinding: {
                fetcher: this.env.COMPUTER_HOST,
                hostToken: this.env.COMPUTER_HOST_TOKEN,
              },
            }
          : {}),
        packagePublisher: {
          read: () =>
            this.userConfiguration(identity).readPackageRevisions(
              identity.userId,
            ),
          publish: (command) =>
            this.userConfiguration(identity).publishPackage(
              identity.userId,
              command,
            ),
          rollback: (command) =>
            this.userConfiguration(identity).rollbackPackage(
              identity.userId,
              command,
            ),
        },
      }),
      ...(await createFoundationAssignedRuntimePackages(
        application,
        settings,
        plan,
        {
          userId: identity.userId,
          readSecret,
          authorizeConnection: authorizeAssignedConnection,
          packageSettings,
          // Assigned Contributions reach the network through the same
          // outbound seam the model provider uses, so a deployment that stubs
          // it stubs every one of them.
          ...(this.outboundFetch ? { fetch: this.outboundFetch } : {}),
          leaseCredential: async (
            assignment,
            effectId,
            expectedGeneration,
          ): Promise<CredentialLeaseV1> => {
            if (!assignment.connectionId || !expectedGeneration) {
              throw new Error("Assigned Connection generation is unavailable");
            }
            return userConfiguration.leaseToolCredential(
              identity.userId,
              assignment.connectionId,
              effectId,
              expectedGeneration,
            );
          },
          settleCredential: async (assignment, effectId): Promise<void> => {
            if (!assignment.connectionId) return;
            await userConfiguration.settleToolCredential(
              identity.userId,
              assignment.connectionId,
              effectId,
            );
          },
          // A mount that could not reach its server writes that down where
          // the User can read it. The Bot holds no MCP record; the User
          // Durable Object that owns the Connection does.
          recordOutcome: (outcome) =>
            userConfiguration.recordMcpMountOutcome(identity.userId, outcome),
        },
      )),
    ];
    const agentPackages: FoundationAgentPackage[] =
      mergeFoundationRuntimePackages(resolvedAgentPackages);
    // A Bot without its own `model` follows the User's default model. The
    // Bot's own Assignment still carries the authority (ADR 0003); the default
    // only names which model that Assignment's Connection should run.
    const effective = resolveEffectiveBotModelV1({
      bot: settings,
      user,
      packages: packageDefinitions,
    });
    const effectiveModel = effective.model;
    if (!effectiveModel) {
      throw new Error("Bot model Connection is not configured");
    }

    let binding: ResolvedModelBindingV1;
    if (admittedRequest) {
      const admittedBinding = admittedRequest.modelBinding;
      const assignment = settings.assignments.find(
        (candidate) =>
          candidate.connectionId === admittedBinding?.connectionId &&
          candidate.state === "enabled",
      );
      const pkg = application.packages.find(
        (candidate) => candidate.id === assignment?.packageId,
      );
      const capability = pkg?.manifest.configuration?.capabilities.find(
        (candidate) => candidate.id === assignment?.capabilityId,
      );
      const connectionTypeId = capability?.connectionTypes[0];
      if (
        !admittedBinding?.connectionGeneration ||
        !assignment?.connectionId ||
        !pkg ||
        !connectionTypeId ||
        effectiveModel.connectionId !== admittedBinding.connectionId ||
        effectiveModel.providerModelId !== admittedRequest.model
      ) {
        throw new Error("Admitted model binding is unavailable");
      }
      binding = {
        state: "ready",
        assignment: structuredClone(effectiveModel),
        packageId: pkg.id,
        providerType: admittedRequest.provider,
        connection: {
          connectionId: admittedBinding.connectionId,
          packageId: pkg.id,
          connectionTypeId,
          displayName: "Admitted model Connection",
          state: "ready",
          providerType: admittedRequest.provider,
          generation: admittedBinding.connectionGeneration,
          safeMetadata: {},
        },
      };
    } else {
      binding = effective.binding ?? {
        assignment: structuredClone(effectiveModel),
        state: "unavailable",
        failure: "Bot model Connection is unavailable",
      };
    }
    if (
      binding.state === "unavailable" ||
      !binding.connection ||
      !binding.providerType ||
      !binding.packageId
    ) {
      throw new Error(binding.failure ?? "Bot model Connection is unavailable");
    }
    const bindingPackageId = binding.packageId;
    agentPackages.push(
      createFoundationModelRuntimePackage(application, binding, {
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
        fetch: this.outboundFetch,
      }),
    );
    return {
      // One Package can reach a Turn as more than one Contribution — Ollama
      // Cloud is both the model provider and the `web_search` Capability — and
      // the runtime resolves one Plugin per Contribution specifier.
      agentPackages: mergeFoundationRuntimePackagesV1(agentPackages),
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

  private async authorizeAdmittedAssignedEffect(
    identity: BotIdentity,
    assignment: BotSettingsViewV1["assignments"][number],
  ): Promise<ConnectionView> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    const connection = user.connections.find(
      (candidate) =>
        candidate.connectionId === assignment.connectionId &&
        candidate.packageId === assignment.packageId &&
        candidate.state === "ready",
    );
    const pkg = application.packages.find(
      (candidate) => candidate.id === assignment.packageId,
    );
    const capability = pkg?.manifest.configuration?.capabilities.find(
      (candidate) =>
        candidate.id === assignment.capabilityId &&
        connection !== undefined &&
        candidate.connectionTypes.includes(connection.connectionTypeId),
    );
    if (assignment.state !== "enabled" || !connection || !capability) {
      throw new Error("Admitted assigned effect is unavailable");
    }
    return structuredClone(connection);
  }

  private async authorizeAssignedEffect(
    identity: BotIdentity,
    admittedAssignment: BotSettingsViewV1["assignments"][number],
  ): Promise<ConnectionView> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    const admittedBot = {
      ...this.initialBotSettings(identity.botId),
      assignments: [admittedAssignment],
    } satisfies BotSettingsViewV1;
    const plan = resolveBotExecutionPlanV1({
      bot: admittedBot,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    const assignment = plan.assignments.find(
      (candidate) =>
        candidate.assignmentId === admittedAssignment.assignmentId &&
        candidate.packageId === admittedAssignment.packageId &&
        candidate.capabilityId === admittedAssignment.capabilityId &&
        candidate.connectionId === admittedAssignment.connectionId &&
        candidate.state === "enabled",
    );
    const connection = user.connections.find(
      (candidate) =>
        candidate.connectionId === assignment?.connectionId &&
        candidate.packageId === admittedAssignment.packageId &&
        candidate.state === "ready",
    );
    if (!connection) throw new Error("Assigned effect is no longer authorized");
    return connection;
  }

  async readDurableIdentity(): Promise<BotIdentity | undefined> {
    return this.authority.readDurableIdentity();
  }

  async validateIdentity(identity: BotIdentity): Promise<void> {
    return this.authority.validateIdentity(identity);
  }

  async listNotifications(): Promise<BotNotificationIntent[]> {
    return this.authority.listNotifications();
  }

  async acknowledgeNotification(notificationId: string): Promise<void> {
    return this.authority.acknowledgeNotification(notificationId);
  }

  /** Every Routine this Bot holds. Bot-scoped: the caller proved membership. */
  async listRoutines(identity: BotIdentity): Promise<RoutineListViewV1> {
    return this.routines.list(
      identity.botId,
      await this.routineScheduler.nextRuns(),
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
  ): Promise<RoutineCommandReceiptV1> {
    if (command.botId !== identity.botId) {
      throw new RoutineNotFoundError(command.routineId ?? command.botId);
    }
    const receipt = await this.routines.execute(command, { kind: "user" });
    // A created, re-timed, resumed or manually fired Routine changes what the
    // object is owed next, so the alarm is re-armed in the same call that wrote
    // the record rather than waiting for the next one to happen by.
    await this.ctx.storage.transaction((transaction) =>
      this.authority.refreshRecoveryAlarm(transaction),
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
    const accepted = await this.routines.deliverHook(input);
    await this.ctx.storage.transaction((transaction) =>
      this.authority.refreshRecoveryAlarm(transaction),
    );
    return accepted;
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
    const pending = await this.routineInbox.pending();
    if (pending.length === 0) return;
    const identity = await this.authority.readDurableIdentity();
    if (!identity) return;
    const settings = await this.getSettings(identity);
    if (!settings.notifications.enabled) return;
    const unread = new Map(
      (await this.routineInbox.list())
        .filter((entry) => !entry.acknowledged)
        .map((entry) => [entry.runId, entry] as const),
    );
    for (const { key, input } of pending) {
      if (input.kind !== "wake" || input.renotifiedAt !== undefined) continue;
      const entry = unread.get(input.runId);
      if (!entry) continue;
      await this.authority.recordNotification({
        notificationId: `routine-wake:${input.runId}`,
        runId: input.runId,
        createdAt: new Date().toISOString(),
        title: `${settings.profile.name} finished a Routine`,
        body: entry.text.slice(0, 240),
      });
      await this.routineInbox.markRenotified(key);
    }
  }

  /** The completion inbox, newest first, with the badge count beside it. */
  async listRoutineInbox(identity: BotIdentity): Promise<RoutineInboxViewV1> {
    await this.validateIdentity(identity);
    const entries = await this.routineInbox.list();
    return {
      schemaVersion: 1,
      botId: identity.botId,
      entries: entries.map((entry) => routineInboxEntryViewV1(entry)),
      unacknowledged: entries.filter((entry) => !entry.acknowledged).length,
    };
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
    await this.routineInbox.acknowledge(command.entryIds);
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
    const run = await this.authority.readStoredRun(runId);
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
    return this.routines.listRuns(identity.botId, routineId);
  }
  /**
   * The Bot's durable Composition generations, newest first. Bot-scoped: the
   * caller proves directory membership before this runs.
   */
  async listCompositionGenerations(
    identity: BotIdentity,
    query: { limit: number; cursor?: string },
  ): Promise<CompositionGenerationListViewV1> {
    const current = await this.authority.composition.current();
    const page = await this.authority.composition.list({
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
            failures: await this.authority.compositionFailures.list(
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
    const generation = await this.authority.composition.read(generationId);
    if (!generation) return undefined;
    const current = await this.authority.composition.current();
    return projectCompositionGenerationV1({
      botId: identity.botId,
      generation,
      currentGenerationId: current.generationId,
      readMemberSource: (member) => this.readCompositionMemberSource(member),
      failures: await this.authority.compositionFailures.list(generationId),
      ...(await this.compositionQuarantineView(generationId)),
    });
  }

  /** Spread into a projection: absent unless the generation is quarantined. */
  private async compositionQuarantineView(
    generationId: string,
  ): Promise<{ quarantine?: CompositionQuarantineV1 }> {
    const quarantine =
      await this.authority.compositionFailures.quarantine(generationId);
    return quarantine === undefined ? {} : { quarantine };
  }

  /**
   * SEAM — plan Step 5 (authoring) owns `authorship:intent:<effectId>` and
   * `artifact:<contentHash>`. Those records do not exist yet, so an isolate
   * member has no recorded source to show and the view carries members only.
   */
  private readCompositionMemberSource(
    _member: CompositionMemberV1,
  ): Promise<string | undefined> {
    return Promise.resolve(undefined);
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
      await this.ctx.storage.get<CompositionCommandReceiptV1>(receiptKey);
    if (recorded) return decodeCompositionCommandReceiptV1(recorded);
    const current = await this.authority.composition.current();
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
      await this.ctx.storage.put(receiptKey, receipt);
      return receipt;
    };
    if (current.generationId !== command.expectedGenerationId) {
      return reject(`composition generation is ${current.generationId}`);
    }
    let generationId: string;
    try {
      const reverted = await this.authority.composition.revert(
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
    await this.ctx.storage.put(receiptKey, receipt);
    return receipt;
  }

  /**
   * The unread record, written in the same transaction that settles the Turn —
   * FrockBot's `lastTurnSettlement`. Activity advances whatever the Bot's
   * notification policy says: muting silences the intent, never the badge.
   * Only a chat Turn advances it; an automation Turn reaches the User through
   * its own inbox entry.
   */
  private async unreadTerminalRecords(input: {
    run: {
      acceptedAt: string;
      runId: string;
      admission?: { turnType: string };
    };
    cursor: string;
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>> {
    if ((input.run.admission?.turnType ?? "chat") !== "chat") return {};
    const current = optionalUnreadStateV1(
      await input.read<unknown>(UNREAD_STATE_KEY),
    );
    return {
      [UNREAD_STATE_KEY]: advanceUnreadActivityV1(current, {
        cursor: input.cursor,
        at: new Date().toISOString(),
      }),
    };
  }

  /**
   * The Bot's unread projection. The count is derived from the admission index
   * on every read, one page longer than the cap so "99+" is exact.
   */
  async readUnread(identity: BotIdentity): Promise<BotUnreadViewV1> {
    await this.authority.validateIdentity(identity);
    const state = optionalUnreadStateV1(
      await this.ctx.storage.get<unknown>(UNREAD_STATE_KEY),
    );
    const index = await this.authority.listRunIndex({
      limit: UNREAD_COUNT_CAP + 1,
    });
    return projectBotUnreadViewV1(
      identity.botId,
      state,
      index.map((entry) => entry.cursor),
    );
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
    await this.authority.validateIdentity(identity);
    const fingerprint = botUnreadCommandFingerprintV1(command);
    const receiptKey = unreadReceiptKeyV1(command.commandId);
    const stored = await this.ctx.storage.transaction(async (transaction) => {
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
        return optionalUnreadStateV1(existing.state);
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
      return next;
    });
    const index = await this.authority.listRunIndex({
      limit: UNREAD_COUNT_CAP + 1,
    });
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      status: "applied",
      unread: projectBotUnreadViewV1(
        identity.botId,
        stored,
        index.map((entry) => entry.cursor),
      ),
    };
  }

  private createNotification(
    settings: BotSettingsViewV1,
    result: BotTurnCompletion,
  ): BotNotificationIntent | undefined {
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
        notificationId: `routine-wake:${result.runId}`,
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
   * Everything the Shell writes in the transaction that settles a Turn. Two
   * policies share the seam and neither knows about the other: unread state
   * advances for a conversational Turn, and an automation Turn writes its
   * completion inbox entry instead, which is why a firing reaches its User
   * without ever touching the badge a visible run moves.
   */
  private async terminalPackageRecords(input: {
    snapshot: BotSettingsViewV1;
    run: StoredRun;
    cursor: string;
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>> {
    return {
      ...(await this.unreadTerminalRecords(input)),
      ...(await this.routineTerminalRecords(input)),
    };
  }

  /**
   * The Package records that settle with an automation Turn. Returns nothing
   * for a conversational one, so a chat Turn's settlement is byte-for-byte what
   * it was.
   */
  private async routineTerminalRecords(input: {
    run: StoredRun;
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>> {
    const contributed = await routineTerminalRecordsForRunV1({
      run: input.run,
      read: input.read,
      now: new Date().toISOString(),
    });
    return contributed?.records ?? {};
  }

  async alarm(): Promise<void> {
    // One alarm: the kernel defers while work is in flight, settles the
    // Package's Assignment sagas, and recovers the active run. A run left
    // durably `reconciliation-required` stays scheduled and visible; only an
    // explicit resume retrieves the original effect, so the alarm never
    // terminalizes an uncertain outcome on its own.
    await this.authority.alarm();
  }
  async listRuns(
    input: unknown = { schemaVersion: 1 },
  ): Promise<ClientRunListV1> {
    const query = decodeClientRunListQueryV1(input);
    await this.authority.recoverActiveRun();
    const activeRunId = query.before
      ? undefined
      : await this.authority.readActiveRunId();
    const candidates = await this.authority.listRunIndex({
      limit: CLIENT_RUN_PAGE_LIMIT + 1,
      ...(query.before ? { before: query.before } : {}),
    });

    const selected = new Map<string, { cursor?: string; run: ClientRunV1 }>();
    if (activeRunId) {
      const active = await this.authority.readStoredRun(activeRunId);
      // An automation firing occupies the object like any other run, and is
      // still not part of the conversation: the visible transcript never
      // shows one, running or settled.
      if (active && isVisibleRunV1(active))
        selected.set(active.runId, { run: projectClientRunV1(active) });
    }
    const available = candidates.slice(0, CLIENT_RUN_PAGE_LIMIT);
    let stoppedEarly = false;
    for (const candidate of available) {
      if (selected.has(candidate.runId)) {
        const current = selected.get(candidate.runId)!;
        selected.set(candidate.runId, { ...current, cursor: candidate.cursor });
        continue;
      }
      const stored = await this.authority.readStoredRun(candidate.runId);
      if (!stored || !isVisibleRunV1(stored)) continue;
      const projected = projectClientRunV1(stored);
      const tentative = [
        ...selected.values(),
        { cursor: candidate.cursor, run: projected },
      ];
      const ordered = tentative
        .map((entry) => entry.run)
        .sort(
          (left, right) =>
            left.admittedAt.localeCompare(right.admittedAt) ||
            left.runId.localeCompare(right.runId),
        );
      const tentativePage = createClientRunListV1(ordered, {
        truncated: true,
        nextCursor: candidate.cursor,
      });
      const isNewestTerminal =
        ![...selected.values()].some(
          (entry) =>
            entry.run.status === "completed" || entry.run.status === "failed",
        ) &&
        (projected.status === "completed" || projected.status === "failed");
      if (
        selected.size >= CLIENT_RUN_PAGE_LIMIT ||
        (!isNewestTerminal &&
          clientRunListWireBytes(tentativePage) > CLIENT_RUN_LIST_MAX_BYTES)
      ) {
        stoppedEarly = true;
        break;
      }
      selected.set(stored.runId, { cursor: candidate.cursor, run: projected });
    }
    const orderedEntries = [...selected.values()].sort(
      (left, right) =>
        left.run.admittedAt.localeCompare(right.run.admittedAt) ||
        left.run.runId.localeCompare(right.run.runId),
    );
    const oldestCursor = orderedEntries.find((entry) => entry.cursor)?.cursor;
    const truncated = stoppedEarly || candidates.length > CLIENT_RUN_PAGE_LIMIT;
    const page = createClientRunListV1(
      orderedEntries.map((entry) => entry.run),
      truncated && oldestCursor
        ? { truncated: true, nextCursor: oldestCursor }
        : { truncated: false },
      // Announcements belong to the Session, not to a page of Turns, so only
      // the newest page carries them.
      query.before
        ? []
        : projectClientAnnouncementsV1(await this.listAnnouncements()),
    );
    if (clientRunListWireBytes(page) > CLIENT_RUN_LIST_MAX_BYTES) {
      throw new Error("required run projections exceed the wire byte limit");
    }
    return page;
  }
  async lookupRun(input: unknown): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return projectClientRunLookupV1(await this.authority.readRun(query.runId));
  }

  async fenceRunAdmission(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return projectClientRunLookupV1(
      await this.authority.fenceRunAdmission(identity, query.runId),
    );
  }
  private initialBotSettings(
    botId: string,
    model?: BotSettingsViewV1["model"],
  ): BotSettingsViewV1 {
    return initializeBotSettingsV1(botId, model);
  }

  private userConfiguration(identity: BotIdentity): {
    readConfiguration(input: {
      schemaVersion: 1;
      userId: string;
    }): Promise<UserSettingsViewV1>;
    readPackageRevisions(
      userId: string,
    ): ReturnType<PackagePublisherAgentHost["read"]>;
    publishPackage(
      userId: string,
      command: Parameters<PackagePublisherAgentHost["publish"]>[0],
    ): ReturnType<PackagePublisherAgentHost["publish"]>;
    rollbackPackage(
      userId: string,
      command: Parameters<PackagePublisherAgentHost["rollback"]>[0],
    ): ReturnType<PackagePublisherAgentHost["rollback"]>;
    getConnection(
      userId: string,
      connectionId: string,
    ): Promise<ConnectionView | undefined>;
    executeConnectionDependency(
      input: import("@frockbot/connection-core").ConnectionDependencyCommandV1,
    ): Promise<
      import("@frockbot/connection-core").ConnectionDependencyResultV1
    >;
    claimConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
      requirement: ConnectionDependencyRequirementV1,
    ): Promise<boolean>;
    acknowledgeConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
    releaseConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
    compensateConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
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
    readMcpServers(userId: string): Promise<McpServerStatusViewV1>;
    executeMcpCommand(
      userId: string,
      command: unknown,
    ): Promise<McpLifecycleReceiptV1>;
    recordMcpMountOutcome(
      userId: string,
      outcome: McpMountOutcomeReportV1,
    ): Promise<void>;
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
  } {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
      readPackageRevisions(
        input: unknown,
      ): ReturnType<PackagePublisherAgentHost["read"]>;
      publishPackage(
        input: unknown,
      ): ReturnType<PackagePublisherAgentHost["publish"]>;
      rollbackPackage(
        input: unknown,
      ): ReturnType<PackagePublisherAgentHost["rollback"]>;
      getConnection(input: unknown): Promise<ConnectionView | undefined>;
      executeConnectionDependency(
        input: unknown,
      ): Promise<
        import("@frockbot/connection-core").ConnectionDependencyResultV1
      >;
      claimConnectionDependency(input: unknown): Promise<boolean>;
      acknowledgeConnectionDependency(input: unknown): Promise<boolean>;
      releaseConnectionDependency(input: unknown): Promise<boolean>;
      compensateConnectionDependency(input: unknown): Promise<boolean>;
      leaseModelCredential(input: unknown): Promise<unknown>;
      settleModelCredential(input: unknown): Promise<void>;
      leaseToolCredential(input: unknown): Promise<unknown>;
      settleToolCredential(input: unknown): Promise<void>;
      readMcpServers(input: unknown): Promise<unknown>;
      executeMcpCommand(input: unknown): Promise<unknown>;
      recordMcpMountOutcome(input: unknown): Promise<void>;
      listBots(input: unknown): Promise<unknown>;
      createBot(input: unknown): Promise<unknown>;
    };
    return {
      readConfiguration: (input) => rpc.readConfiguration(input),
      readPackageRevisions: (userId) =>
        rpc.readPackageRevisions({ schemaVersion: 1, userId }),
      publishPackage: (userId, command) =>
        rpc.publishPackage({ schemaVersion: 1, userId, command }),
      rollbackPackage: (userId, command) =>
        rpc.rollbackPackage({ schemaVersion: 1, userId, command }),
      getConnection: (userId, connectionId) =>
        rpc.getConnection({ schemaVersion: 1, userId, connectionId }),
      // Flock state crosses a Durable Object seam, so it decodes on arrival
      // rather than being trusted in the shape RPC happened to return.
      listBots: async (userId) =>
        decodeDirectoryViewV1(await rpc.listBots({ schemaVersion: 1, userId })),
      createBot: async (userId, command) =>
        decodeFlockReceiptV1(
          await rpc.createBot({ schemaVersion: 1, userId, command }),
        ),
      executeConnectionDependency: (input) =>
        rpc.executeConnectionDependency(input),
      claimConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
        requirement,
      ) =>
        rpc.claimConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
          requirement,
        }),
      acknowledgeConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
      ) =>
        rpc.acknowledgeConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
      releaseConnectionDependency: (userId, connectionId, botId, generation) =>
        rpc.releaseConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
      compensateConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
      ) =>
        rpc.compensateConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
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
      // The MCP lifecycle crosses this seam like every other value: decoded
      // on arrival rather than trusted in the shape RPC happened to return.
      readMcpServers: async (userId) =>
        decodeMcpServerStatusViewV1(
          await rpc.readMcpServers({ schemaVersion: 1, userId }),
        ),
      executeMcpCommand: async (userId, command) =>
        decodeMcpLifecycleReceiptV1(
          await rpc.executeMcpCommand({ schemaVersion: 1, userId, command }),
        ),
      recordMcpMountOutcome: (userId, outcome) =>
        rpc.recordMcpMountOutcome({ schemaVersion: 1, userId, outcome }),
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

  private async ensureBotSettings(
    identity: BotIdentity,
  ): Promise<BotSettingsViewV1> {
    await this.validateIdentity(identity);
    const existing = await this.ctx.storage.get<BotSettingsViewV1>(
      BOT_CONFIGURATION_KEY,
    );
    if (!existing)
      throw new Error(`Bot "${identity.botId}" is not materialized`);
    return existing;
  }

  /**
   * A Bot that follows the User's default model still needs its own durable
   * Assignment: authority reaches a Bot only through an explicit Assignment
   * and, when required, a Connection (ADR 0003). The Assignment is claimed
   * lazily the first time the Bot resolves its execution context under a
   * default it has not yet claimed, exactly as Flock claims one when a Bot is
   * created, so the User Connection's dependency ledger stays accurate and
   * revocation still fails closed.
   */
  private async claimDefaultModelAssignment(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
    user: UserSettingsViewV1,
    application: Awaited<ReturnType<typeof compileFoundationApplication>>,
  ): Promise<BotSettingsViewV1> {
    const model = user.newBotModelTemplate;
    if (settings.model || !model) return settings;
    // One Assignment operation at a time: a claim still reconciling owns the
    // Bot's Assignment authority until it settles.
    if (settings.assignmentOperations.length > 0) return settings;
    const connection = user.connections.find(
      (candidate) => candidate.connectionId === model.connectionId,
    );
    const installation = user.packages.find(
      (candidate) =>
        candidate.packageId === connection?.packageId &&
        candidate.state === "installed",
    );
    const pkg = application.packages.find(
      (candidate) =>
        candidate.id === connection?.packageId &&
        candidate.version === installation?.version,
    );
    const connectionType = pkg?.manifest.configuration?.connectionTypes.find(
      (candidate) => candidate.id === connection?.connectionTypeId,
    );
    const capability = pkg?.manifest.configuration?.capabilities.find(
      (candidate) =>
        candidate.kind === "model" &&
        connectionType?.capabilities.includes(candidate.id) &&
        candidate.connectionTypes.includes(connectionType.id),
    );
    if (connection?.state !== "ready" || !pkg || !capability) return settings;
    if (
      settings.assignments.some(
        (assignment) =>
          assignment.packageId === pkg.id &&
          assignment.capabilityId === capability.id &&
          assignment.connectionId === connection.connectionId,
      )
    ) {
      return settings;
    }
    const commandId = crypto.randomUUID();
    try {
      const receipt = await this.executeConfigurationCommand(identity, {
        schemaVersion: 1,
        type: "bot/assign-capability",
        commandId,
        expectedRevision: settings.revision,
        botId: identity.botId,
        assignment: {
          assignmentId: commandId,
          packageId: pkg.id,
          capabilityId: capability.id,
          connectionId: connection.connectionId,
        },
      });
      if (receipt.status !== "applied") return settings;
    } catch (error) {
      // The default model is not the Bot's own binding: a claim that cannot be
      // made leaves the Bot without a model, visibly, rather than failing the
      // caller that only wanted to read the plan.
      console.error(
        "Default model Assignment claim failed",
        error instanceof Error ? error.message : "unknown failure",
      );
      return settings;
    }
    return this.ensureBotSettings(identity);
  }

  private async resolveExecutionContext(identity: BotIdentity): Promise<{
    settings: BotSettingsViewV1;
    user: UserSettingsViewV1;
    plan: BotExecutionPlanV1;
  }> {
    let settings = await this.ensureBotSettings(identity);
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    let plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    settings = await this.claimDefaultModelAssignment(
      identity,
      settings,
      user,
      application,
    );
    if (settings.revision !== plan.revision) {
      plan = resolveBotExecutionPlanV1({
        bot: settings,
        user,
        packages: application.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          capabilities: pkg.manifest.configuration?.capabilities ?? [],
          connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
        })),
      });
    }
    const changed = settings.assignments.some(
      (assignment, index) =>
        assignment.state !== plan.assignments[index]?.state,
    );
    if (changed) {
      settings = await this.ctx.storage.transaction(async (transaction) => {
        const current =
          (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
          settings;
        if (current.revision !== settings.revision) return current;
        const next = {
          ...current,
          revision: current.revision + 1,
          assignments: plan.assignments,
        } satisfies BotSettingsViewV1;
        await transaction.put(BOT_CONFIGURATION_KEY, next);
        await this.refreshRecoveryAlarm(transaction);
        return next;
      });
      plan = {
        ...plan,
        revision: settings.revision,
        assignments: settings.assignments,
      };
    }
    return { settings, user, plan };
  }

  async archiveEligible(storage: {
    get<T>(key: string): Promise<T | undefined>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  }): Promise<boolean> {
    const [activeRunId, settings, sagas] = await Promise.all([
      storage.get<string>(ACTIVE_RUN_KEY),
      storage.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY),
      storage.list<unknown>({ prefix: ASSIGNMENT_SAGA_PREFIX }),
    ]);
    return (
      activeRunId === undefined &&
      (settings?.assignmentOperations.length ?? 0) === 0 &&
      sagas.size === 0
    );
  }

  async assertLifecycleActive(botId: string): Promise<void> {
    if (!this.lifecycleAdmission) return;
    await this.ctx.storage.transaction((transaction) =>
      this.lifecycleAdmission!(transaction, botId),
    );
  }

  private async assertIdentity(identity: BotIdentity): Promise<void> {
    const existing = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (
      existing &&
      (existing.userId !== identity.userId || existing.botId !== identity.botId)
    ) {
      throw new Error("Bot authority does not match its durable identity");
    }
    if (!existing) await this.ctx.storage.put(IDENTITY_KEY, identity);
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
    return this.ctx.storage.transaction(async (transaction) => {
      const [activeRunId, durableIdentity, candidate] = await Promise.all([
        transaction.get<string>(ACTIVE_RUN_KEY),
        transaction.get<BotIdentity>(IDENTITY_KEY),
        transaction.get<unknown>(`${RUN_PREFIX}${runId}`),
      ]);
      const run = optionalStoredRun(candidate);
      if (
        activeRunId !== runId ||
        !run ||
        run.sessionId !== sessionId ||
        durableIdentity?.userId !== identity.userId ||
        durableIdentity.botId !== identity.botId ||
        !(
          (run.status === "running" && run.phase === "executing") ||
          (run.status === "reconciliation-required" &&
            run.phase === "reconciliation-required")
        )
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
      const outcome = run.stopRequestedAt ? "fenced" : "admitted";
      const next = requireStoredRunV1({
        ...run,
        effectAdmissions: [
          ...run.effectAdmissions,
          { kind: effect.kind, effectId: effect.effectId, outcome },
        ],
      } satisfies StoredRun);
      await transaction.put(`${RUN_PREFIX}${runId}`, structuredClone(next));
      return outcome === "admitted";
    });
  }
}

export function createShellBotBackendContribution(
  host: ShellBotBackendHost,
): ShellBotBackendContribution {
  return new ShellBotBackendContribution(host);
}

export function createShellBotBackendPlugin(
  host: ShellBotBackendHost,
  lifecycle: { mount(value: ShellBotBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createShellBotBackendContribution(host));
}

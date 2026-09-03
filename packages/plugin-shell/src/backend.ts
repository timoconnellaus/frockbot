import type { AgentEffectAdmission } from "@frockbot/kernel-agent-loop/agent";
import {
  decodeIsolateMemoryReadRequestV1,
  decodeIsolateMemoryWriteRequestV1,
  decodeIsolateNotificationRequestV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateToolRequestV1,
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeWorkspacePathV1,
  decodeWorkspaceRootV1,
  decodeSessionEvent,
  type IsolateConnectionOutcomeV1,
  type IsolateConnectionV1,
  type IsolateMemoryOutcomeV1,
  type IsolateNotificationOutcomeV1,
  type IsolateToolOutcomeV1,
  type IsolateWorkspaceOutcomeV1,
  type PersistSessionEvents,
  type SessionEvent,
  type WorkspacePathV1,
  type WorkspaceRootV1,
  validateToolOccurrenceJournal,
  type BotCapabilitiesStub,
  type IsolateModelInvocationV1,
  type NormalizedModelRequest,
  type PackageBundlerBinding,
  type PackageIframeCompositionV1,
  type PackageIframeToolCommandV1,
  type TurnTypeV1,
  type WorkspaceFilesV1,
} from "@frockbot/kernel-contracts";
import {
  decodeFrockBotManifest,
  isClientIframeContribution,
  type FrockBotManifest,
} from "@frockbot/kernel-composition";
import { canonicalJson, sha256 } from "@frockbot/kernel-composition/compiler";
import type { Plugin } from "cordis";
import type { ComputerRegistry } from "@frockbot/computer-core";
import { appletsSourceRootV1 } from "@frockbot/plugin-applets/root";
import { syncWorkspaceRootNowV1 } from "@frockbot/plugin-computer/agent";
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
} from "@frockbot/configuration-core";
import {
  createFoundationEnabledRuntimePackages,
  mergeFoundationRuntimePackages,
  createFoundationHostedRuntimePackages,
  mergeFoundationRuntimePackagesV1,
  type PackagePublisherAgentHost,
} from "@frockbot/application-foundation/runtime";
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
  planInterruptedRunRecoveryV1,
} from "./backend-recovery.js";
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
  appletRpcSnapshotV1 as rpcJsonSnapshotV1,
  resolveAppletCompositionV1,
  type AppletCapabilityHostV1,
  type AppletInstanceNamespaceV1,
  type AppletUserDirectoryV1,
} from "./backend-applets.js";
import {
  APPLET_FOCUSED_KEY,
  decodeFocusedAppletV1,
  type FocusedAppletV1,
} from "@frockbot/kernel-do";
import {
  decodeAppletProvenanceV1,
  decodeAppletSummaryV1,
  decodeAppletToolDeclarationV1,
  decodeIsolateAppletsRequestV1,
  type IsolateAppletsOutcomeV1,
} from "@frockbot/kernel-contracts";
import { compositionFailureTurnTextV1 } from "./backend-composition-input.js";
import {
  activateCompositionV1,
  type CompositionFailureV1,
  type CompositionMountHost,
  type CompositionQuarantineV1,
} from "@frockbot/kernel-composition/activation";
import {
  createPackageAuthoringHost,
  createR2AuthoringArtifactStore,
  readAuthoredCompositionMemberSourceV1,
} from "./backend-authoring.js";
import {
  type CatalogAwarePackageCatalogHost,
  createPackageCatalogHost,
  createR2BotPackageCatalogReader,
} from "./backend-package-catalog.js";
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
} from "@frockbot/plugin-flock/shared";
import { createBotSelfManagementHost } from "./backend-flock.js";
import {
  decodeTemplateShareReceiptV1,
  type TemplateCommandV1,
  type TemplateShareReceiptV1,
} from "@frockbot/plugin-bot-template/shared";
import { createBotMemoryHost } from "./backend-memory.js";
import { createBotImageHost, type NativeAiBindingV1 } from "./backend-image.js";
import {
  createBotPluginSkillsSource,
  createBotSkillCatalogReader,
  createBotSkillsHost,
  createBotSkillsReads,
} from "./backend-skills.js";
import {
  loadFullSkillCatalogV1,
  loadSkillCatalogV1,
  skillRefForLoadedSkillV1,
} from "@frockbot/plugin-skills/catalog";
import { writeSkillDocumentV1 } from "@frockbot/plugin-skills/write";
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
  routineTurnCommandV1,
  settledRoutineOriginV1,
} from "./backend-routines.js";
import { RoutineInboxStore } from "@frockbot/plugin-routines/inbox-store";
import {
  subagentAttributionV1,
  ROUTINE_INBOX_TEXT_MAX,
  ROUTINE_WAKE_TITLE_MAX,
  type RoutinePendingWakeV1,
} from "@frockbot/plugin-routines/inbox";
import {
  TaskStore,
  type TaskStorageV1,
} from "@frockbot/plugin-subagents/store";
import {
  taskDesktopLeaseOwnerV1,
  TASK_DESKTOP_LEASE_MAX_AGE_SECONDS_V1,
  taskPromptDigestV1,
  TASK_BLOCKING_POLL_MS_V1,
  TASK_BLOCKING_TIMEOUT_MS_V1,
  isTerminalTaskStatusV1,
  type TaskOutcomeV1,
  type TaskRecordV1,
} from "@frockbot/plugin-subagents/records";
import {
  taskAnchorIdV1,
  taskContextKeyV1,
  taskKeyV1,
  TASK_ACTIVE_PREFIX,
  TASK_CONTEXT_PREFIX,
} from "@frockbot/plugin-subagents/storage-keys";
import {
  decodeSubagentSlotReceiptV1,
  type SubagentSlotBinding,
} from "@frockbot/plugin-subagents/quota";
import {
  subagentModelCatalogV1,
  type SubagentModelOptionV1,
} from "@frockbot/plugin-subagents/models";
import type {
  SubagentCheckOutcomeV1,
  SubagentDispatchOutcomeV1,
  SubagentDispatchRequestV1,
  SubagentMessageOutcomeV1,
  SubagentResumeRequestV1,
  SubagentStopOutcomeV1,
  SubagentsRuntimeHostV1,
} from "@frockbot/plugin-subagents/agent";
import {
  COMPUTER_HOST_PROTOCOL_VERSION,
  COMPUTER_HOST_ROUTES,
  COMPUTER_HOST_TOKEN_HEADER,
  decodeComputerHostControlResultV1,
  decodeComputerHostProblemV1,
  encodeComputerHostRequestV1,
} from "@frockbot/computer-host-protocol";
import {
  taskViewV1,
  type TaskListViewV1,
  type TaskViewV1,
} from "@frockbot/plugin-subagents/shared";
import {
  createBotSubagentDurableBindingV1,
  decodeSubagentTaskContextV1,
  subagentOutcomeForRunV1,
  subagentTaskContextV1,
  subagentTaskIdV1,
  type SubagentDurableBindingV1,
  type SubagentRunTaskRequestV1,
  type SubagentTaskContextV1,
} from "./backend-subagents.js";
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
import { enqueuePendingBotInputV1 } from "@frockbot/plugin-routines/inbox-store";
import {
  createBotMachineHost,
  createBotMachineMessagesHost,
  dispatchApprovedMachineIntentV1,
  resolveBotMachineMessagesGateV1,
  type BotMachineSeamV1,
} from "./backend-machine.js";
import { settleMachineIntentV1 } from "@frockbot/plugin-user-machine/approval";
import type { MachineIntentRecordV1 } from "@frockbot/plugin-user-machine/intent";
import {
  decodeMachineResultDeliveryV1,
  type MachineResultDeliveryV1,
} from "@frockbot/plugin-user-machine/delivery";
import {
  decodeMachineListViewV1,
  decodeMachineCommandResultV1,
  type MachineCommandResultV1,
  type MachineCommandV1,
  type MachineListViewV1,
} from "@frockbot/machine-protocol";
import { decodeMachineTargetViewV1 } from "@frockbot/plugin-user-machine/target";
import type { MachineTargetViewV1 } from "@frockbot/plugin-user-machine/target";
import {
  decodeMachineDispatchAnswerV1,
  type MachineDispatchAnswerV1,
} from "@frockbot/plugin-user-machine/approval";
import {
  pendingBotInputPreambleV1,
  routineHandoffTextV1,
  type PendingBotInputV1,
  type RoutineInboxEntryV1,
} from "@frockbot/plugin-routines/inbox";
import type {
  RoutineFireOutcomeV1,
  RoutineScheduler,
} from "@frockbot/plugin-routines/scheduler";
import type { RoutineFireV1 } from "@frockbot/plugin-routines/firing";
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
  authorshipManifestKey,
  decodeAuthoringQuotaReceiptV1,
  type AuthoredManifestRecordV1,
  type AuthoringQuotaBinding,
  type PackageAuthoringHost,
} from "@frockbot/plugin-authoring";
import {
  BOT_ISOLATE_COMPATIBILITY_DATE,
  createIsolateCapabilityHost,
  createR2PackageArtifactStore,
  isolateBindingDigestV1,
  type BotCapabilitiesPropsV1,
  type IsolateCapabilityHost,
  type IsolateModelBindingV1,
  type IsolateModelPath,
  type IsolateModelRequestRecordV1,
} from "./backend-isolate.js";
import { memoryScopeRootV1 } from "@frockbot/plugin-memory/roots";
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
import {
  projectCompositionGenerationV1,
  projectPackageIframeCompositionV1,
} from "./composition-views.js";
import { executeBotTurn, executeDirectToolTurn } from "./backend-runner.js";
import {
  shellTerminalRecordsV1,
  supersededTurnRecordsV1,
} from "./terminal-records.js";
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
  projectClientRunOrDegradedV1,
  projectClientAnnouncementsV1,
  projectClientTurnV1,
  type ClientRunLookupV1,
  type ClientRunListV1,
  type ClientRunStopReceiptV1,
  type ClientRunV1,
  type ClientTurnV1,
} from "./run-protocol.js";
import {
  BOT_DEBUG_DEFAULT_RUN_LIMIT_V1,
  BOT_DEBUG_EVENT_BYTES_V1,
  BOT_DEBUG_GENERATION_LIMIT_V1,
  boundDebugEventsV1,
  decodeBotDebugQueryV1,
  type BotDebugRunV1,
  type BotDebugSnapshotV1,
} from "./debug-protocol.js";
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
  botUnreadCommandFingerprintV1,
  markUnreadReadV1,
  markUnreadV1,
  optionalSidebarMessagePreviewV1,
  optionalUnreadStateV1,
  projectBotUnreadViewV1,
  SIDEBAR_PREVIEW_KEY,
  unreadReceiptKeyV1,
  UNREAD_COUNT_CAP,
  UNREAD_STATE_KEY,
  type BotUnreadCommandV1,
  type BotUnreadReceiptV1,
  type BotUnreadViewV1,
} from "./unread.js";
import { defineBotBackendContribution } from "@frockbot/kernel-contracts/contributions";

export const BOT_CONFIGURATION_KEY = "bot-configuration";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
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

export interface BotStateEnv {
  MEMORY_FILES: R2Bucket;
  /** Object-storage file surfaces constructed by the Cloudflare adapter. */
  WORKSPACE_FILES?: WorkspaceFilesV1;
  MEMORY_WORKSPACE_FILES?: WorkspaceFilesV1;
  /**
   * The Bot Package Worker Loader (plan Step 4). Optional so a host without
   * Bot-authored Packages — tests, the Electron shell — still compiles; a
   * generation with an isolate member fails verification without it.
   */
  BOT_PACKAGES?: BotIsolateLoader;
  /** Immutable, content-addressed Package artifacts, read hash-verified. */
  APPLICATION_ARTIFACTS?: R2Bucket;
  /**
   * One Applet Durable Object per Applet instance (ADR 0022). Optional so a
   * host without Applets still compiles; a Composition generation carrying an
   * Applet member then fails verification, exactly as an isolate member does
   * without a loader.
   */
  APPLET_STATES?: AppletInstanceNamespaceV1;
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
  /** The native AI binding consumed through the image Package adapter. */
  AI?: NativeAiBindingV1;
  /** The Flock AI Gateway adapter constructed by the Cloudflare host. */
  FLOCK_AI?: {
    autoRoute: string;
    runChatCompletion(
      gatewayModel: string,
      body: Record<string, unknown>,
    ): Promise<ReadableStream<Uint8Array>>;
  };
  USER_CONFIGURATIONS: DurableObjectNamespace;
  /**
   * The Bot Durable Object namespace, as the Subagent Durable Object namespace
   * (ADR 0017): the same class, named `<userId>:<botId>#task:<taskId>`.
   * Optional so a host without it still compiles — `Task` is then not offered
   * at all, rather than offered and unable to dispatch.
   */
  BOT_STATES?: DurableObjectNamespace;
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
  /**
   * Durable Object addressing for subagent dispatch (ADR 0017). Absent, and
   * `Task` is not offered at all: a Package that cannot reach a Subagent
   * Durable Object has no honest way to dispatch one.
   */
  subagents?: SubagentDurableBindingV1;
  /**
   * Immutable Package artifacts this bundle already carries, by object key.
   *
   * The application supplies these; the shell only hands them to the artifact
   * store as a second place to look. See `createR2PackageArtifactStore`.
   */
  bundledPackageArtifacts?: ReadonlyMap<string, string>;
  invalidateComputerProjectionFile?(
    userId: string,
    botId: string,
    kind: "screenshots" | "doctor",
  ): void;
  /** Package deadlines composed into the Bot authority's one durable alarm. */
  scheduledDeadlines?(transaction: DurableObjectTransaction): Promise<number[]>;
  scheduledWorkInFlight?(): boolean;
  deferScheduledWork?(transaction: DurableObjectTransaction): Promise<void>;
  settleScheduledWork?(): Promise<void>;
}

/** The narrow storage seam the Bot's announcement log is written through. */
interface BotAnnouncementTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
}

function optionalStoredRun(input: unknown): StoredRun | undefined {
  return input === undefined ? undefined : requireStoredRunV1(input);
}

/** Server-side allowlist for the untrusted page's only effectful message. */
export function requirePackageUiToolDeclarationV1(
  catalog: PackageIframeCompositionV1,
  command: Pick<
    PackageIframeToolCommandV1,
    "generationId" | "packageId" | "name"
  >,
): PackageIframeCompositionV1["contributions"][number] {
  const contribution = catalog.contributions.find(
    (candidate) => candidate.packageId === command.packageId,
  );
  if (
    catalog.generationId !== command.generationId ||
    !contribution ||
    !contribution.declaredTools.includes(command.name)
  ) {
    throw new Error(
      `Package "${command.packageId}" did not declare tool "${command.name}" in generation "${command.generationId}"`,
    );
  }
  return contribution;
}

export class ShellBotBackendContribution {
  readonly ctx: DurableObjectState;
  readonly env: BotStateEnv;
  private readonly compileApplication: typeof compileFoundationApplication;
  private readonly bundledPackageArtifacts?: ReadonlyMap<string, string>;
  private readonly lifecycleAdmission?: ShellBotBackendHost["assertLifecycleActive"];
  private readonly reconciliationActivities = new Map<
    string,
    Promise<ClientTurnV1>
  >();
  private readonly outboundFetch?: typeof fetch;
  private readonly configurationActivities = new Map<
    string,
    ConfigurationActivity
  >();
  /** The Turn currently executing on this object, for durable Stop. */
  private activeTurn:
    | {
        runId: string;
        sessionId: string;
        turnId: string;
        generationId: string;
        turnType: TurnTypeV1;
        subagentRole?: string;
        mounted: ShellMountedComposition;
        signal: AbortSignal;
        /** `detail` is recorded on the Turn's `turn/end`, never interpreted. */
        cancel(detail?: string): void;
      }
    | undefined;
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
  /**
   * The subagent task authority (ADR 0017). In a parent Bot Durable Object it
   * holds the Bot's tasks; in a Subagent Durable Object it holds nothing,
   * because a child never dispatches one.
   */
  private readonly tasks: TaskStore;
  private readonly subagentBinding: SubagentDurableBindingV1 | undefined;
  private readonly invalidateComputerProjectionFile?: ShellBotBackendHost["invalidateComputerProjectionFile"];
  private readonly hostScheduledDeadlines?: ShellBotBackendHost["scheduledDeadlines"];
  private readonly hostScheduledWorkInFlight?: ShellBotBackendHost["scheduledWorkInFlight"];
  private readonly hostDeferScheduledWork?: ShellBotBackendHost["deferScheduledWork"];
  private readonly hostSettleScheduledWork?: ShellBotBackendHost["settleScheduledWork"];

  constructor(host: ShellBotBackendHost) {
    this.ctx = host.state;
    this.env = host.env;
    this.compileApplication =
      host.compileApplication ?? compileFoundationApplication;
    this.bundledPackageArtifacts = host.bundledPackageArtifacts;
    this.lifecycleAdmission = host.assertLifecycleActive;
    this.outboundFetch = host.outboundFetch;
    this.invalidateComputerProjectionFile =
      host.invalidateComputerProjectionFile;
    this.hostScheduledDeadlines = host.scheduledDeadlines;
    this.hostScheduledWorkInFlight = host.scheduledWorkInFlight;
    this.hostDeferScheduledWork = host.deferScheduledWork;
    this.hostSettleScheduledWork = host.settleScheduledWork;
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
    this.tasks = new TaskStore(host.state.storage as unknown as TaskStorageV1);
    this.subagentBinding =
      host.subagents ??
      (host.env.BOT_STATES
        ? createBotSubagentDurableBindingV1(host.env.BOT_STATES)
        : undefined);
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
        supersededRecords: (input) => this.supersededPackageRecords(input),
        interruptTurn: (runId, reason) =>
          this.interruptActiveTurn(runId, reason),
        scheduledDeadlines: (transaction) =>
          this.scheduledDeadlines(transaction),
        scheduledWorkInFlight: () =>
          this.hostScheduledWorkInFlight?.() ?? false,
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
    return this.ensureBotSettings(identity);
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
    const settings = await this.ensureBotSettings(identity);
    const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
    const existing =
      await this.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
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
        settings: pkg.manifest.configuration?.settings ?? [],
      }));
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
    await this.appendAnnouncement(transaction, (seq) => ({
      type: "bot/renamed",
      seq,
      timestamp: new Date().toISOString(),
      from: rename.from,
      to: rename.to,
      namedBy: rename.namedBy,
      ...(rename.writer ? { writer: rename.writer } : {}),
    }));
  }

  /**
   * Appends one durable Session event that belongs to no Turn.
   *
   * A rename is one; so is a task settling, because a background subagent
   * settles after the Turn that dispatched it is over and there is no live
   * Session left to append to. The log is append-only and bounded — an
   * announcement is conversational history, not authority.
   */
  private async appendAnnouncement(
    transaction: BotAnnouncementTransaction,
    build: (seq: number) => SessionEvent,
  ): Promise<void> {
    const seq =
      ((await transaction.get<number>(BOT_ANNOUNCEMENT_SEQUENCE_KEY)) ?? -1) +
      1;
    const event = build(seq);
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

  private async refreshRecoveryAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    await this.authority.refreshRecoveryAlarm(transaction);
  }

  async resolveConfiguration(
    identity: BotIdentity,
  ): Promise<BotExecutionPlanV1> {
    return (await this.resolveExecutionContext(identity)).plan;
  }

  async run(command: OwnedBotTurnCommand): Promise<ClientTurnV1> {
    // Before admission, so the pin this Turn takes already carries whatever the
    // User's Applet directory says now.
    await this.resolveAppletComposition(
      { userId: command.userId, botId: command.botId },
      command,
    );
    return projectClientTurnV1(await this.authority.run(command));
  }

  async runPackageUiTool(
    identity: BotIdentity,
    command: PackageIframeToolCommandV1,
  ): Promise<ClientTurnV1> {
    await this.validateIdentity(identity);
    const catalog = await this.listPackageUi(identity);
    const contribution = requirePackageUiToolDeclarationV1(catalog, command);
    return projectClientTurnV1(
      await this.authority.run({
        ...identity,
        runId: command.commandId,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: `${contribution.displayName} · ${command.name}`,
        directTool: {
          generationId: command.generationId,
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

  /** The one durable manifest lookup used by mounts, commands, and UI views. */
  private async readCompositionMemberManifest(
    member: CompositionMemberV1,
  ): Promise<FrockBotManifest | undefined> {
    const stored = await this.ctx.storage.get<AuthoredManifestRecordV1>(
      authorshipManifestKey(member.manifestHash),
    );
    if (stored) return decodeFrockBotManifest(stored.manifest);
    return await this.readApplicationMemberManifest(member);
  }

  /**
   * The manifest of a member the *application* declared, not the Bot.
   *
   * `authorship:manifest:<hash>` is written by the authoring path and by a
   * Catalog install, so it exists for every member a Bot or its User put into
   * the Composition. A first-party artifact-backed member (ADR 0022 decision
   * 8) came from neither: it is in the compiled application, whose manifests
   * are already in this bundle. The `manifestHash` is still what decides —
   * the plan's manifest is accepted only when it hashes to exactly what the
   * generation recorded — so this is a second *place* to look, never a second
   * answer.
   */
  private async readApplicationMemberManifest(
    member: CompositionMemberV1,
  ): Promise<FrockBotManifest | undefined> {
    if (!member.artifact) return undefined;
    const application = await this.compileApplication();
    const declared = application.packages.find(
      (candidate) => candidate.id === member.packageId,
    );
    if (!declared) return undefined;
    const hash = await sha256(canonicalJson(declared.manifest));
    if (hash !== member.manifestHash) return undefined;
    return declared.manifest;
  }

  private async requireCompositionMemberManifest(
    member: CompositionMemberV1,
  ): Promise<FrockBotManifest> {
    const manifest = await this.readCompositionMemberManifest(member);
    if (!manifest) {
      throw new Error(
        `package "${member.packageId}" manifest "${member.manifestHash}" is unavailable`,
      );
    }
    return manifest;
  }

  /** Active fail-closed Composition projected as inert iframe metadata. */
  async listPackageUi(
    identity: BotIdentity,
  ): Promise<PackageIframeCompositionV1> {
    await this.validateIdentity(identity);
    const current = await this.authority.composition.current();
    const generation =
      current.status === "active" || current.status === "superseded"
        ? current
        : await this.authority.composition.lastKnownGood();
    return projectPackageIframeCompositionV1({
      botId: identity.botId,
      generation,
      readMemberManifest: (member) =>
        this.readCompositionMemberManifest(member),
    });
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
    const files = (this.env as { WORKSPACE_FILES?: WorkspaceFilesV1 })
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
    const files = (this.env as { WORKSPACE_FILES?: WorkspaceFilesV1 })
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
    const reads = createBotSkillsReads(this.env);
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
    };
    let mountedRoot: ShellMountedComposition["root"] | undefined;
    let mountedGeneration: CompositionGenerationV1 | undefined;
    const currentToolNames = (): readonly string[] =>
      mountedRoot?.tools.registeredNames?.() ?? [];
    const runtime = await this.agentRuntime(
      input.identity,
      settings,
      input.admittedRequest,
      turn,
      currentToolNames,
      () => mountedGeneration,
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
    const appletInstances = this.env.APPLET_STATES
      ? createAppletInstanceBindingV1(
          this.env.APPLET_STATES,
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
        mountedRoot = mounted.root;
        mountedGeneration = mounted.generation;
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
    this.activeTurn = active;
    try {
      const directTool = input.command.directTool;
      if (directTool) {
        if (
          directTool.generationId !== activation.mounted.generation.generationId
        ) {
          throw new Error(
            "Package UI command does not match the mounted Composition generation",
          );
        }
        // Artifact-backed, not "not first-party": what makes a Package's page
        // able to name one of its tools is that the Package is loaded from an
        // immutable artifact with a manifest, which is exactly what ADR 0022
        // decision 8 gives a first-party Package too.
        const member = activation.mounted.generation.members.find(
          (candidate) =>
            candidate.packageId === directTool.packageId &&
            candidate.artifact !== undefined,
        );
        if (!member)
          throw new Error("Package UI command names an unavailable Package");
        const manifest = await this.requireCompositionMemberManifest(member);
        const client = manifest.contributions.client;
        if (
          !client ||
          !isClientIframeContribution(client) ||
          !(manifest.tools ?? []).some((tool) => tool.name === directTool.name)
        ) {
          throw new Error(
            `Package "${directTool.packageId}" did not declare tool "${directTool.name}" for its iframe`,
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
    detail?: string;
  }): boolean {
    const active = this.activeTurn;
    if (
      !active ||
      active.runId !== cancellation.runId ||
      active.sessionId !== cancellation.sessionId
    ) {
      return false;
    }
    active.cancel(cancellation.detail);
    return true;
  }

  /**
   * The kernel's advisory interrupt, bound to this object's resident Agent.
   *
   * It runs only after the durable intent that justifies it is written, and it
   * changes nothing durable itself: a Turn whose Agent is no longer resident
   * is stopped by the effect fence on its next external effect instead, which
   * is the same outcome by a slower road.
   */
  private interruptActiveTurn(runId: string, reason: string): void {
    const active = this.activeTurn;
    if (!active || active.runId !== runId) return;
    active.cancel(reason);
  }

  /** The visible half of failing closed, through the Bot's notifications. */
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
      artifacts: createR2PackageArtifactStore(
        artifacts,
        this.bundledPackageArtifacts,
      ),
      manifestFor: (member) => this.requireCompositionMemberManifest(member),
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
    const [user, application] = await Promise.all([
      this.userConfiguration(identity).readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      }),
      this.compileApplication(),
    ]);
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
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        settings: pkg.manifest.configuration?.settings ?? [],
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
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
      memory: Boolean(this.env.MEMORY_WORKSPACE_FILES),
      workspace: Boolean(this.env.WORKSPACE_FILES),
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
    const settings = await this.ensureBotSettings(identity);
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

  async isolateInvokeTool(input: {
    userId: string;
    botId: string;
    runId: string;
    sessionId: string;
    turnId: string;
    packageId: string;
    generationId: string;
    request: unknown;
  }): Promise<IsolateToolOutcomeV1> {
    const request = decodeIsolateToolRequestV1(input.request);
    const active = this.activeIsolateTurn(input);
    if (!active) {
      return {
        status: "unavailable",
        reason: "the Package is not running in this Bot's active Composition",
      };
    }
    const session = active.mounted.runtime.root.sessions.get(input.sessionId);
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
    const preparation = await active.mounted.runtime.root.tools.prepare(
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
      } else if (priorCall) {
        const recovered =
          await active.mounted.runtime.root.tools.reconcilePrepared(
            preparation,
            context,
          );
        result =
          recovered.status === "recovered"
            ? recovered.result
            : { content: recovered.reason, isError: true };
      } else {
        result = await active.mounted.runtime.root.tools.executePrepared(
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

  // --- Applets (ADR 0022) --------------------------------------------------

  /**
   * `ctx.applets` for one Bot, or `undefined` when this host cannot reach
   * Applets at all — no instance namespace, no artifact bucket, or no
   * Workspace. An absent capability is an `unavailable` outcome at the isolate
   * boundary, never a thrown error inside Bot code.
   */
  private appletCapabilityHost(
    identity: BotIdentity,
    active?: NonNullable<ShellBotBackendContribution["activeTurn"]>,
  ): AppletCapabilityHostV1 | undefined {
    const namespace = this.env.APPLET_STATES;
    const artifacts = this.env.APPLICATION_ARTIFACTS;
    const workspace = this.env.WORKSPACE_FILES;
    if (!namespace || !artifacts || !workspace) return undefined;
    const bucket = artifacts;
    return createAppletCapabilityHostV1({
      userId: identity.userId,
      botId: identity.botId,
      storage: {
        get: (key) => this.ctx.storage.get(key),
        put: (entries) => this.ctx.storage.put(entries),
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
        ? async () => {
            const root = active.mounted.runtime.root as unknown as {
              computers?: ComputerRegistry;
              sessions: typeof active.mounted.runtime.root.sessions;
            };
            const computerIdentity = { userId: identity.userId };
            if (!root.computers?.assignment(computerIdentity)) return;
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
            await syncWorkspaceRootNowV1({
              computer,
              sessions: root.sessions,
              sessionId: active.sessionId,
              turn,
              root: appletsSourceRootV1(identity.userId),
              signal: active.signal,
            });
          }
        : undefined,
      composition: {
        current: () => this.authority.composition.current(),
        lastKnownGood: () => this.authority.composition.lastKnownGood(),
        propose: (generation, options) =>
          this.authority.composition.propose(generation, options),
      },
    });
  }

  /** The User Durable Object's Applet directory, decoded on arrival. */
  private appletUserDirectory(identity: BotIdentity): AppletUserDirectoryV1 {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker
    // types do not expose its Applet directory RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
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

  /**
   * The Applet capability at the isolate boundary. One RPC with an operation,
   * because seven near-identical forwarders would say nothing seven times; the
   * shapes are decoded here and the outcomes are declared, never thrown.
   */
  async isolateApplets(
    input: IsolateCallScopeV1,
  ): Promise<IsolateAppletsOutcomeV1> {
    const active = this.activeIsolateTurn(input);
    if (!active) {
      return {
        status: "unavailable",
        reason: "the Package is not running in this Bot's active Composition",
      };
    }
    const identity = { userId: input.userId, botId: input.botId };
    const host = this.appletCapabilityHost(identity, active);
    if (!host) {
      return { status: "unavailable", reason: "Applets are unavailable" };
    }
    const request = decodeIsolateAppletsRequestV1(input.request);
    const scope = {
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      effectId: `applet:${input.turnId}:${request.op}:${
        "appletId" in request ? request.appletId : "new"
      }`,
    };
    try {
      switch (request.op) {
        case "list":
          return { status: "available", value: await host.list() };
        case "create":
          return {
            status: "available",
            value: await host.create(
              { displayName: request.displayName },
              scope,
            ),
          };
        case "publish":
          return {
            status: "available",
            value: await host.publish({ appletId: request.appletId }, scope),
          };
        case "revert":
          return {
            status: "available",
            value: await host.revert(
              {
                appletId: request.appletId,
                generationId: request.generationId,
              },
              scope,
            ),
          };
        case "delete":
          return {
            status: "available",
            value: await host.delete({ appletId: request.appletId }),
          };
        case "focus":
          return {
            status: "available",
            value: await host.focus({ appletId: request.appletId }),
          };
        case "generations":
          return {
            status: "available",
            value: await host.generations({ appletId: request.appletId }),
          };
      }
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error ? error.message : "the Applet call failed",
      };
    }
  }

  /** The Session's focused Applet, as the shell and its route read it. */
  async readFocusedApplet(identity: BotIdentity): Promise<FocusedAppletV1> {
    await this.validateIdentity(identity);
    const stored = await this.ctx.storage.get<unknown>(APPLET_FOCUSED_KEY);
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
    await this.ctx.storage.put({ [APPLET_FOCUSED_KEY]: focused });
    return focused;
  }

  /**
   * Resolve the User's Applet directory into this Bot's next Composition
   * generation, before a Turn is admitted.
   *
   * Outside the admission transaction on purpose: the pin is taken in one
   * storage transaction, which cannot make a cross-object call. A publish or a
   * delete therefore activates at the *next* admitted Turn, and an in-flight
   * Turn keeps the set it pinned — which is exactly what ADR 0022 promises.
   * A directory that cannot be read leaves the Bot on the generation it has;
   * an Applet change is never a reason a Turn cannot start.
   */
  private async resolveAppletComposition(
    identity: BotIdentity,
    command: OwnedBotTurnCommand,
  ): Promise<void> {
    if (!this.env.APPLET_STATES) return;
    try {
      await resolveAppletCompositionV1({
        directory: this.appletUserDirectory(identity),
        composition: {
          current: () => this.authority.composition.current(),
          propose: (generation, options) =>
            this.authority.composition.propose(generation, options),
        },
        storage: {
          get: (key) => this.ctx.storage.get(key),
          put: (entries) => this.ctx.storage.put(entries),
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
    const files = this.env.WORKSPACE_FILES;
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
    const files = this.env.WORKSPACE_FILES;
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
    const files = this.env.WORKSPACE_FILES;
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
    const files = this.env.WORKSPACE_FILES;
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
    const files = this.env.WORKSPACE_FILES;
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
      await this.authority.recordNotification({
        notificationId: `package-connection-unavailable:${input.runId}:${input.packageId}:${input.request}`,
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

  async isolateNotify(
    input: IsolateCallScopeV1,
  ): Promise<IsolateNotificationOutcomeV1> {
    if (!this.activeIsolateTurn(input)) {
      return { status: "unavailable", reason: "notifications are unavailable" };
    }
    const request = decodeIsolateNotificationRequestV1(input.request);
    await this.authority.recordNotification({
      notificationId: `package:${input.packageId}:${request.notificationId}`,
      runId: input.runId,
      createdAt: new Date().toISOString(),
      title: request.title,
      body: request.body,
    });
    return { status: "recorded" };
  }

  async isolateSchedule(
    input: IsolateCallScopeV1,
  ): Promise<IsolateToolOutcomeV1> {
    const request = decodeIsolateScheduleRequestV1(input.request);
    return this.isolateInvokeTool({
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
      this.env,
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
    const active = this.activeTurn;
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
        put: (key, value) => this.ctx.storage.put(key, value),
        list: (options) => this.ctx.storage.list(options),
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
      ...(await this.routineScheduler.deadlines(transaction)),
      ...expiries.filter((at) => Number.isFinite(at)),
      // A dispatched task's 30-minute lifetime, and a child's own owed Turn,
      // both ride the one alarm this object already has (ADR 0017): the parent
      // reconciles a child that never reported, and the child runs the Turn it
      // was handed on its next alarm rather than on a floating promise.
      ...(await this.subagentDeadlines(transaction)),
      ...(this.hostScheduledDeadlines
        ? await this.hostScheduledDeadlines(transaction)
        : []),
    ];
  }

  /**
   * The deadlines subagent work contributes to this object's one alarm.
   *
   * Two kinds, and which one an object has says which side of ADR 0017 it is
   * on. A *parent* has task records whose `deadlineAt` is when it must go and
   * ask what became of a child. A *child* has one task context, and while that
   * context is `queued` its deadline is *now*: accepting a task arms the alarm,
   * and the alarm is what runs the Turn.
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
    await this.routineScheduler.defer(transaction);
    await this.hostDeferScheduledWork?.(transaction);
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
      await this.runOwedSubagentTurns();
      await this.reconcileOverdueTasks();
      await this.expireDueApprovals();
      await this.replayPendingWakeNotifications();
      await this.hostSettleScheduledWork?.();
    } finally {
      await this.ctx.storage.transaction((transaction) =>
        this.authority.refreshRecoveryAlarm(transaction),
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
    const identity = await this.authority.readDurableIdentity();
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
    if (await this.authority.readActiveRunId()) {
      await this.ctx.storage.transaction((transaction) =>
        this.routineScheduler.defer(transaction),
      );
      return;
    }
    await this.routineScheduler.settle(async (fire) => {
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
    await this.authority.recordNotification({
      // The same id shape the completion path uses, so one firing is one
      // intent however many times the alarm retries it.
      notificationId: `routine-failed:${fire.fireId}`,
      runId: fire.fireId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} could not run a Routine`,
      body: (outcome.summary ?? "The firing ended without saying why.").slice(
        0,
        240,
      ),
    });
  }
  // -------------------------------------------------------------------------
  // Subagents (ADR 0017). The parent Bot Durable Object is the authority; the
  // Subagent Durable Object is an execution host with no authority of its own.
  // -------------------------------------------------------------------------

  /** The narrow User Durable Object RPC that bounds concurrent subagents per User. */
  private subagentSlots(identity: BotIdentity): SubagentSlotBinding {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker
    // types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      reserveSubagentSlot(input: unknown): Promise<unknown>;
      releaseSubagentSlot(input: unknown): Promise<unknown>;
    };
    return {
      reserve: async (request) =>
        decodeSubagentSlotReceiptV1(await rpc.reserveSubagentSlot(request)),
      release: async (request) => {
        await rpc.releaseSubagentSlot(request);
      },
    };
  }

  /**
   * The User-wide `desktop-gui` lease, held at the Computer host.
   *
   * The Bot Durable Object cannot serialize across a User's Bots — they are
   * separate objects — and the User Durable Object owns the Computer
   * allocation but not the desktop. The host's `control` op is already the
   * single writer that serializes human takeover, so it is where a second
   * opinion cannot exist (plan decision 3): the Bot records the intent, the
   * host grants or refuses, and the refusal names the holder.
   *
   * Absent when this deployment has no Computer host — a Bot with no Computer
   * has no desktop to serialize, and a `computerUse` task is then bounded only
   * by this Bot's own lease record.
   */
  /**
   * The origin the Computer host service binding is addressed on. A service
   * binding routes by binding, not by name, so the origin is only a syntactic
   * requirement of `Request`.
   */
  private static readonly COMPUTER_HOST_ORIGIN_V1 =
    "http://computer-host.internal";

  private async desktopLease(
    identity: BotIdentity,
    action: "acquire" | "release",
    ownerId: string,
  ): Promise<
    | { status: "granted"; expiresAt?: string }
    | { status: "refused"; reason: string }
    | { status: "unavailable" }
  > {
    const fetcher = this.env.COMPUTER_HOST;
    const hostToken = this.env.COMPUTER_HOST_TOKEN;
    if (!fetcher || !hostToken) return { status: "unavailable" };
    const body = JSON.stringify(
      encodeComputerHostRequestV1({
        version: COMPUTER_HOST_PROTOCOL_VERSION,
        effectId: `${action}:${ownerId}`,
        identity: { userId: identity.userId },
        tenant: { botId: identity.botId },
        credentialRef: `sprites:user:${identity.userId}`,
        operation: {
          kind: "control",
          action,
          ownerId,
          maxAgeSeconds: TASK_DESKTOP_LEASE_MAX_AGE_SECONDS_V1,
          scope: "desktop-gui",
        },
      }),
    );
    let response: Response;
    try {
      response = await fetcher.fetch(
        new Request(
          `${ShellBotBackendContribution.COMPUTER_HOST_ORIGIN_V1}${COMPUTER_HOST_ROUTES.control}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [COMPUTER_HOST_TOKEN_HEADER]: hostToken,
            },
            body,
          },
        ),
      );
    } catch {
      // A host that cannot be reached has granted nothing and holds nothing.
      return { status: "unavailable" };
    }
    if (!response.ok) {
      // 409 is the host's "somebody else holds this", and its message names
      // the holder — which is the whole point of leasing under an owner derived
      // from the Bot and the task.
      let message = "";
      try {
        message = decodeComputerHostProblemV1(await response.json()).message;
      } catch {
        message = "";
      }
      if (response.status === 409) {
        return {
          status: "refused",
          reason: message || "the desktop is held by another subagent",
        };
      }
      return { status: "unavailable" };
    }
    try {
      const result = decodeComputerHostControlResultV1(await response.json());
      return {
        status: "granted",
        ...(result.expiresAt === undefined
          ? {}
          : { expiresAt: result.expiresAt }),
      };
    } catch {
      return { status: "granted" };
    }
  }

  /**
   * Takes the desktop for one `computerUse` task, in the constitution's order:
   * the intent is already durable (`admit` wrote `task-lease:desktop`), the
   * host is asked, and only a granted lease is recorded back onto the intent.
   */
  private async acquireDesktopForTask(
    identity: BotIdentity,
    taskId: string,
  ): Promise<{ status: "held" } | { status: "refused"; reason: string }> {
    const outcome = await this.desktopLease(
      identity,
      "acquire",
      taskDesktopLeaseOwnerV1(identity.botId, taskId),
    );
    if (outcome.status === "refused") {
      return { status: "refused", reason: outcome.reason };
    }
    // `unavailable` is a deployment with no Computer host. The Bot's own lease
    // record still holds — one `computerUse` task per Bot — and there is no
    // desktop to contend for.
    await this.tasks.recordDesktopLease(
      identity.botId,
      taskId,
      outcome.status === "granted" ? outcome.expiresAt : undefined,
    );
    return { status: "held" };
  }

  /**
   * Releases the desktop this task held, if it held it. Called on every path
   * that settles a task — completion, failure, `task_stop`, and the deadline
   * reconciliation — so the screen is never held by something that has ended.
   */
  private async releaseDesktopForTask(
    identity: BotIdentity,
    taskId: string,
  ): Promise<void> {
    const released = await this.tasks.releaseDesktopLease(taskId);
    if (!released) return;
    try {
      await this.desktopLease(
        identity,
        "release",
        released.ownerId ?? taskDesktopLeaseOwnerV1(identity.botId, taskId),
      );
    } catch {
      // The host lease lapses on its own. A release that could not be
      // delivered delays the next `computerUse` task by at most the lease's
      // own age; it never leaves the record claiming a desktop this Bot holds.
    }
  }

  /** The Bot's task list, as the gateway route reads it. */
  async listTasks(identity: BotIdentity): Promise<TaskListViewV1> {
    await this.validateIdentity(identity);
    return this.tasks.list(identity.botId);
  }

  /**
   * One dispatch, in the order the constitution requires.
   *
   * Intent before effect: the task record, the active key and the index row are
   * durable — and the per-Bot and per-User bounds have both answered — before
   * any Subagent Durable Object is addressed. A dispatch that dies between the
   * two leaves a task the parent can see, ask about, and settle; it never
   * leaves a child running with nothing to answer for it.
   */
  private async dispatchSubagentTask(
    identity: BotIdentity,
    turn: { runId: string; turnId: string; sessionId: string },
    compositionGenerationId: string,
    request: SubagentDispatchRequestV1,
    /** Present only on a resume: which task this continues, and in whose child. */
    resume?: { resumedFrom: string; anchorTaskId: string },
  ): Promise<SubagentDispatchOutcomeV1> {
    const binding = this.subagentBinding;
    if (!binding) {
      return {
        status: "refused",
        reason:
          "this deployment cannot address a Subagent Durable Object, so no subagent can be dispatched",
      };
    }
    const taskId = subagentTaskIdV1(request.effectId);
    const admission = await this.tasks.admit({
      taskId,
      type: request.type,
      description: request.description,
      promptDigest: await taskPromptDigestV1(request.prompt),
      model: request.model,
      compositionGenerationId,
      background: request.background,
      attachments: request.attachments,
      // The dispatching Turn, and only the three fields that identify it: the
      // `turn` the runtime host carries also holds the pin and the turn type,
      // and neither belongs on the record's provenance.
      dispatch: {
        runId: turn.runId,
        turnId: turn.turnId,
        sessionId: turn.sessionId,
      },
      ...(resume
        ? {
            resumedFrom: resume.resumedFrom,
            anchorTaskId: resume.anchorTaskId,
          }
        : {}),
      now: new Date(),
    });
    if (admission.status === "refused") {
      return { status: "refused", reason: admission.reason };
    }
    if (admission.status === "replayed") {
      // The same tool call, reconciled or retried: the task it already
      // dispatched is the answer, never a second child.
      return {
        status: "dispatched",
        taskId: admission.record.taskId,
        model: admission.record.model.slug,
      };
    }
    const reservation = await this.subagentSlots(identity).reserve({
      schemaVersion: 1,
      userId: identity.userId,
      botId: identity.botId,
      taskId,
      reservedAt: admission.record.createdAt,
    });
    if (reservation.status === "refused") {
      await this.tasks.settle(taskId, {
        status: "failed",
        settledAt: new Date().toISOString(),
        failure: reservation.reason,
      });
      return { status: "refused", reason: reservation.reason };
    }
    // The desktop, for a `computerUse` task only, and after the intent this
    // Bot already recorded: intent → acquire → dispatch. A refusal here is a
    // refusal of the dispatch, and it names the holder.
    if (admission.record.type === "computerUse") {
      const desktop = await this.acquireDesktopForTask(identity, taskId);
      if (desktop.status === "refused") {
        await this.settleTask(identity, taskId, {
          status: "failed",
          settledAt: new Date().toISOString(),
          failure: desktop.reason,
        });
        return { status: "refused", reason: desktop.reason };
      }
    }
    const anchorTaskId = taskAnchorIdV1(admission.record.childSessionId);
    const runTask: SubagentRunTaskRequestV1 = {
      taskId,
      type: admission.record.type,
      parent: {
        userId: identity.userId,
        botId: identity.botId,
        runId: turn.runId,
        turnId: turn.turnId,
        sessionId: turn.sessionId,
      },
      compositionGenerationId,
      model: admission.record.model,
      prompt: request.prompt,
      ...(anchorTaskId === taskId
        ? {}
        : { sessionId: admission.record.childSessionId }),
    };
    try {
      await binding.accept(identity, anchorTaskId, runTask);
    } catch (error) {
      const failure =
        error instanceof Error ? error.message : "the subagent could not start";
      await this.settleTask(identity, taskId, {
        status: "failed",
        settledAt: new Date().toISOString(),
        failure,
      });
      return { status: "refused", reason: failure };
    }
    await this.tasks.markRunning(taskId);
    if (!request.background) {
      const settled = await this.awaitBlockingTask(
        identity,
        anchorTaskId,
        taskId,
      );
      if (settled) {
        return {
          status: "settled",
          taskId,
          model: admission.record.model.slug,
          taskStatus: settled.status,
          ...(settled.summary === undefined
            ? {}
            : { summary: settled.summary }),
          ...(settled.failure === undefined
            ? {}
            : { failure: settled.failure }),
        };
      }
    }
    return {
      status: "dispatched",
      taskId,
      model: admission.record.model.slug,
    };
  }

  /**
   * Waits, boundedly, for a `background:false` task — and degrades to
   * background rather than holding a Turn open.
   *
   * It *polls durable state*: the parent's own task record first, then the
   * child's context by RPC. It never awaits the child's settle callback, which
   * is an RPC back into this very object while this very Turn is still
   * executing — the reentrancy hazard G1 named. Both reads are ordinary I/O the
   * Durable Object already does inside a Turn, and the outbound probe is the
   * same call reconciliation makes.
   */
  private async awaitBlockingTask(
    identity: BotIdentity,
    anchorTaskId: string,
    taskId: string,
  ): Promise<TaskOutcomeV1 | undefined> {
    const binding = this.subagentBinding;
    const deadline = Date.now() + TASK_BLOCKING_TIMEOUT_MS_V1;
    for (;;) {
      try {
        const record = await this.tasks.read(taskId);
        if (record.outcome) return record.outcome;
      } catch {
        // A record that cannot be read is not a reason to hold the Turn.
        return undefined;
      }
      if (binding) {
        try {
          const context = await binding.probe(identity, anchorTaskId, taskId);
          if (context?.outcome) {
            // The child finished but its callback has not landed. Settling
            // here is the same idempotent write the callback performs.
            await this.settleTask(identity, taskId, context.outcome);
            return context.outcome;
          }
        } catch {
          // A child that cannot be probed is simply not finished yet.
        }
      }
      if (Date.now() >= deadline) return undefined;
      await this.sleep(
        Math.min(TASK_BLOCKING_POLL_MS_V1, Math.max(0, deadline - Date.now())),
      );
    }
  }

  /** The one wait in this class, named so a test can shorten it. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Records one terminal outcome for a task and gives back what it held.
   *
   * The single settle point. The child calls it when its Turn ends; the
   * parent's own alarm calls it for a child that never reported. It is
   * idempotent on the task id, so both landing is one outcome, not two.
   */
  async settleTask(
    identity: BotIdentity,
    taskId: string,
    outcome: TaskOutcomeV1,
  ): Promise<{ status: "settled" | "replayed" }> {
    await this.authority.assertIdentity(identity);
    // The desktop goes back *before* the record settles, because the record is
    // what says this task holds it: settling first would drop the lease record
    // and leave the host lease held by a task that has ended. A task that held
    // nothing releases nothing, so this is a no-op on every other path and on
    // a replayed settle.
    await this.releaseDesktopForTask(identity, taskId);
    const settled = await this.tasks.settle(taskId, outcome);
    if (settled.status === "settled") {
      try {
        await this.subagentSlots(identity).release({
          schemaVersion: 1,
          userId: identity.userId,
          botId: identity.botId,
          taskId,
        });
      } catch {
        // The User's slot is a reservation, not the record. A release that
        // could not be delivered is retried the next time this task settles or
        // this object reconciles; it never makes a settled task look unsettled.
      }
      await this.recordTaskCompletion(identity, settled.record);
    }
    await this.ctx.storage.transaction((transaction) =>
      this.authority.refreshRecoveryAlarm(transaction),
    );
    return { status: settled.status };
  }

  /**
   * What a settled task leaves behind on the parent (l.352: a background
   * completion "also posts a user-visible summary on the parent").
   *
   * Three records, and they are the *same* three a completed Routine firing
   * leaves — slice E's seams, reused rather than paralleled:
   *
   *  * the `task/settled` Session line, on the Bot's announcement log, because
   *    a background task settles when the Turn that dispatched it is over and
   *    there is no live Session to append to;
   *  * a completion-inbox entry and a pending wake, so the summary — never the
   *    child's transcript, which the parent has no door onto — is delivered to
   *    the Bot's next conversational Turn as durable input;
   *  * a notification intent, so a person hears about it too.
   *
   * The inbox half is skipped while the dispatching run is still active: a
   * blocking dispatch is answered by its own tool result, and telling the same
   * Turn the same thing twice is not delivery, it is duplication.
   *
   * Every write is idempotent on the task id, so a settle that races its own
   * reconciliation leaves one of each.
   */
  private async recordTaskCompletion(
    identity: BotIdentity,
    task: TaskRecordV1,
  ): Promise<void> {
    const outcome = task.outcome;
    if (!outcome) return;
    const at = outcome.settledAt;
    await this.ctx.storage.transaction((transaction) =>
      this.appendAnnouncement(transaction, (seq) => ({
        type: "task/settled",
        seq,
        timestamp: at,
        taskId: task.taskId,
        status: outcome.status,
        ...(outcome.summary === undefined
          ? {}
          : { summary: outcome.summary.slice(0, ROUTINE_INBOX_TEXT_MAX) }),
      })),
    );
    // The dispatching Turn is still running: it is waiting on this task and
    // will read the outcome as its own tool result.
    if ((await this.authority.readActiveRunId()) === task.dispatch.runId) {
      return;
    }
    const text = this.taskCompletionTextV1(task, outcome);
    const attribution = subagentAttributionV1(task.description);
    const wakeId = `tw-${task.taskId}`;
    const entry: RoutineInboxEntryV1 = {
      schemaVersion: 1,
      entryId: `ti-${task.taskId}`,
      // The child's run id *is* the task id, so the entry names the run that
      // produced it exactly as a firing's entry does.
      runId: task.taskId,
      routineId: task.taskId,
      text,
      attribution,
      createdAt: at,
      acknowledged: false,
      wakeId,
      source: "subagent",
    };
    await this.routineInbox.append(entry);
    const wake: RoutinePendingWakeV1 = {
      schemaVersion: 1,
      kind: "wake",
      wakeId,
      runId: task.taskId,
      routineId: task.taskId,
      title: attribution.slice(0, ROUTINE_WAKE_TITLE_MAX),
      text,
      createdAt: at,
      quiet: { automation: true },
      source: "subagent",
    };
    await this.routineInbox.enqueue(wake);
    let settings: BotSettingsViewV1;
    try {
      settings = await this.getSettings(identity);
    } catch {
      return;
    }
    if (!settings.notifications.enabled) return;
    await this.authority.recordNotification({
      notificationId: `task-settled:${task.taskId}`,
      runId: task.taskId,
      createdAt: at,
      title: `${settings.profile.name} finished a subagent task`,
      body: text.slice(0, 240),
    });
  }

  /** The one line a settled task says to its parent. Never a transcript. */
  private taskCompletionTextV1(
    task: TaskRecordV1,
    outcome: TaskOutcomeV1,
  ): string {
    const head = `${task.type} subagent "${task.description}" ${outcome.status}.`;
    const body =
      outcome.status === "completed"
        ? (outcome.summary ?? "It left no summary.")
        : (outcome.failure ??
          (outcome.status === "stopped"
            ? "It was stopped."
            : "No reason was recorded."));
    return `${head} ${body}`.slice(0, ROUTINE_INBOX_TEXT_MAX);
  }

  /** One task, as the gateway detail route reads it. */
  async readTask(identity: BotIdentity, taskId: string): Promise<TaskViewV1> {
    await this.validateIdentity(identity);
    return taskViewV1(await this.tasks.read(taskId));
  }

  /** What `task_check` answers: status, last summary, and nothing to poll on. */
  private async checkTask(taskId: string): Promise<SubagentCheckOutcomeV1> {
    let record: TaskRecordV1;
    try {
      record = await this.tasks.read(taskId);
    } catch (error) {
      return {
        status: "refused",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      status: "known",
      taskId: record.taskId,
      taskType: record.type,
      description: record.description,
      taskStatus: record.status,
      model: record.model.slug,
      ...(record.outcome?.summary === undefined
        ? {}
        : { summary: record.outcome.summary }),
      ...(record.outcome?.failure === undefined
        ? {}
        : { failure: record.outcome.failure }),
      // What is *waiting*, not what was ever sent: a message the child has
      // already read is not something the Bot is still waiting on.
      queuedMessages: (await this.tasks.pendingMessages(taskId)).length,
    };
  }

  /** What `task_message` does: append to the bounded queue, or refuse. */
  private async messageTask(
    taskId: string,
    message: string,
  ): Promise<SubagentMessageOutcomeV1> {
    const queued = await this.tasks.appendMessage(taskId, message, new Date());
    if (queued.status === "refused") {
      return { status: "refused", reason: queued.reason };
    }
    return { status: "queued", taskId, depth: queued.depth };
  }

  /**
   * Explicit, authenticated cancellation of one task. Durable and terminal.
   *
   * The order is the constitution's: the intent is recorded, the child is
   * asked to stop, and only then is the outcome written — so a stop that dies
   * between the two is read back rather than repeated, and a child that cannot
   * be reached does not leave a task the User was told was cancelled still
   * live. The settle is the one idempotent settle every other path uses.
   */
  async stopTask(
    identity: BotIdentity,
    taskId: string,
    requestedBy: "bot" | "user",
  ): Promise<
    | { status: "stopped"; record: TaskRecordV1 }
    | { status: "refused"; reason: string }
  > {
    await this.authority.assertIdentity(identity);
    const requested = await this.tasks.requestStop(
      taskId,
      new Date(),
      requestedBy,
    );
    if (requested.status === "refused") {
      // A task that is already terminal answers with what it already is: a
      // second Stop on a stopped task is not a failure.
      let record: TaskRecordV1 | undefined;
      try {
        record = await this.tasks.read(taskId);
      } catch {
        record = undefined;
      }
      if (record && record.status === "stopped") {
        return { status: "stopped", record };
      }
      return { status: "refused", reason: requested.reason };
    }
    await this.ctx.storage.transaction((transaction) =>
      this.appendAnnouncement(transaction, (seq) => ({
        type: "task/stopped",
        seq,
        timestamp: new Date().toISOString(),
        taskId,
        requestedBy,
      })),
    );
    const binding = this.subagentBinding;
    if (binding) {
      try {
        await binding.stop(
          identity,
          taskAnchorIdV1(requested.record.childSessionId),
          taskId,
        );
      } catch {
        // The child is an execution host, not the authority. One that cannot
        // be reached reads its own cancelled context back on its next alarm;
        // the terminal state is recorded here either way.
      }
    }
    await this.settleTask(identity, taskId, {
      status: "stopped",
      settledAt: new Date().toISOString(),
      failure: `Stopped by ${requestedBy === "user" ? "your user" : "the Bot"}.`,
    });
    return { status: "stopped", record: await this.tasks.read(taskId) };
  }

  /** The gateway's cancellation door. Same act, second authenticated caller. */
  async stopTaskForUser(
    identity: BotIdentity,
    taskId: string,
  ): Promise<TaskViewV1> {
    await this.validateIdentity(identity);
    const stopped = await this.stopTask(identity, taskId, "user");
    if (stopped.status === "refused") {
      throw new Error(stopped.reason);
    }
    return taskViewV1(stopped.record);
  }

  /**
   * A new run in a finished task's own child Durable Object and Session.
   *
   * The model is *not* re-resolved: the resumed run keeps the binding the
   * first one pinned, because the transcript it continues was produced by it.
   * `resumedFrom` records which task this continues.
   */
  private async resumeTask(
    identity: BotIdentity,
    turn: { runId: string; turnId: string; sessionId: string },
    compositionGenerationId: string,
    request: SubagentResumeRequestV1,
  ): Promise<SubagentDispatchOutcomeV1> {
    const resumable = await this.tasks.resumable(request.resume);
    if (resumable.status === "refused") {
      return { status: "refused", reason: resumable.reason };
    }
    if (await this.tasks.stopRequested(request.resume)) {
      return {
        status: "refused",
        reason: `task "${request.resume}" was stopped; a stopped subagent is not resumed`,
      };
    }
    return this.dispatchSubagentTask(
      identity,
      turn,
      compositionGenerationId,
      {
        description: request.description ?? resumable.record.description,
        prompt: request.prompt,
        type: resumable.record.type,
        background: request.background,
        model: resumable.record.model,
        attachments: [],
        effectId: request.effectId,
      },
      { resumedFrom: request.resume, anchorTaskId: resumable.anchorTaskId },
    );
  }

  /**
   * The child's door. It records the task and arms its own alarm, and it does
   * not run the Turn: the RPC returns to a parent that is still inside the
   * Turn that dispatched, so anything longer than a write would block it.
   */
  async acceptSubagentTask(
    identity: BotIdentity,
    request: SubagentRunTaskRequestV1,
  ): Promise<{ childSessionId: string }> {
    await this.authority.assertIdentity(identity);
    const key = taskContextKeyV1(request.taskId);
    const existing = await this.ctx.storage.get<unknown>(key);
    if (existing !== undefined) {
      // A retried dispatch reaches the child it already reached.
      return {
        childSessionId: decodeSubagentTaskContextV1(existing).sessionId,
      };
    }
    const context = subagentTaskContextV1(request, new Date().toISOString());
    await this.ctx.storage.put(key, context);
    await this.ctx.storage.transaction((transaction) =>
      this.authority.refreshRecoveryAlarm(transaction),
    );
    return { childSessionId: context.sessionId };
  }

  /**
   * The child's cancellation door.
   *
   * Durable first: the context is marked settled so a child that is evicted
   * before its Agent notices — or that has not started its Turn yet — cannot
   * come back and run the task anyway. The Agent signal follows, and is
   * advisory, exactly as an authenticated Stop's is.
   */
  async stopSubagentTask(
    identity: BotIdentity,
    taskId: string,
  ): Promise<{ status: "stopped" | "unknown" }> {
    await this.authority.assertIdentity(identity);
    const key = taskContextKeyV1(taskId);
    const stored = await this.ctx.storage.get<unknown>(key);
    if (stored === undefined) return { status: "unknown" };
    const context = decodeSubagentTaskContextV1(stored);
    if (context.status !== "settled") {
      await this.ctx.storage.put(key, {
        ...context,
        status: "settled",
        outcome: {
          status: "stopped",
          settledAt: new Date().toISOString(),
          failure: "Stopped by an authenticated cancellation.",
        },
      });
    }
    this.cancelActiveTurn({ sessionId: context.sessionId, runId: taskId });
    return { status: "stopped" };
  }

  /**
   * The parent's half of message delivery: hand the child everything queued
   * for one task and mark it delivered, in one transaction.
   *
   * Authenticated as every other task RPC is. The claim is idempotent by
   * construction — a second claim reads the marks back and answers nothing —
   * so a child that retries a step after an eviction does not read the same
   * instruction twice.
   */
  async claimTaskMessages(
    identity: BotIdentity,
    taskId: string,
  ): Promise<{ messages: { seq: number; message: string }[] }> {
    await this.authority.assertIdentity(identity);
    const claimed = await this.tasks.claimMessages(taskId, new Date());
    return {
      messages: claimed.map((entry) => ({
        seq: entry.seq,
        message: entry.message,
      })),
    };
  }

  /**
   * The child's half: ask the parent for what it has queued, using the parent
   * this child was handed when it accepted the task.
   *
   * A parent that cannot be reached answers nothing; the messages are still
   * queued, still undelivered, and the next step claims them.
   */
  private async claimParentTaskMessages(
    taskId: string,
  ): Promise<readonly { seq: number; message: string }[]> {
    const binding = this.subagentBinding;
    if (!binding) return [];
    const context = await this.readSubagentTaskContext(taskId);
    if (!context) return [];
    return binding.claimMessagesOnParent(context.parent, taskId);
  }

  /** What a child holds for one task, for the parent's reconciliation. */
  async readSubagentTaskContext(
    taskId: string,
  ): Promise<SubagentTaskContextV1 | undefined> {
    const stored = await this.ctx.storage.get<unknown>(
      taskContextKeyV1(taskId),
    );
    return stored === undefined
      ? undefined
      : decodeSubagentTaskContextV1(stored);
  }

  /**
   * The child half of the alarm: run the one Turn this object was handed.
   *
   * A `subagent` Turn, on this object's own Session, admitted with the
   * `{kind:"subagent"}` origin so the durable run says whose task it was. The
   * task id *is* the run id, so a retried alarm is refused by the kernel's own
   * idempotency rather than running the child twice.
   */
  private async runOwedSubagentTurns(): Promise<void> {
    const identity = await this.authority.readDurableIdentity();
    if (!identity) return;
    const stored = await this.ctx.storage.list<unknown>({
      prefix: TASK_CONTEXT_PREFIX,
    });
    for (const [key, value] of stored) {
      let context: SubagentTaskContextV1;
      try {
        context = decodeSubagentTaskContextV1(value);
      } catch {
        continue;
      }
      if (context.status !== "queued") continue;
      // A run already occupies this object; the alarm defers rather than
      // burning the task on an error it did not have to take.
      if (await this.authority.readActiveRunId()) return;
      await this.ctx.storage.put(key, { ...context, status: "running" });
      let outcome: TaskOutcomeV1;
      try {
        await this.authority.run({
          ...identity,
          runId: context.taskId,
          sessionId: context.sessionId,
          acceptedAt: new Date().toISOString(),
          text: context.prompt,
          turnType: "subagent",
          // The role is the task's type. It is the second ceiling on the
          // child's catalog: a `browserUse` child is never offered
          // `computer_exec`, and the durable run records the role so a
          // recovered child re-mounts the same catalog.
          subagentRole: context.type,
          origin: {
            kind: "subagent",
            taskId: context.taskId,
            parentRunId: context.parent.runId,
          },
        });
        outcome = subagentOutcomeForRunV1(
          await this.authority.readStoredRun(context.taskId),
          new Date().toISOString(),
        );
      } catch (error) {
        outcome = subagentOutcomeForRunV1(
          await this.authority.readStoredRun(context.taskId),
          new Date().toISOString(),
          error,
        );
      }
      await this.ctx.storage.put(key, {
        ...context,
        status: "settled",
        outcome,
      });
      if (this.subagentBinding) {
        try {
          await this.subagentBinding.settleOnParent(
            context.parent,
            context.taskId,
            outcome,
          );
        } catch {
          // The outcome is durable here. A parent that could not be reached is
          // asked again when its own deadline comes due — the child is never
          // re-dispatched, only re-read.
        }
      }
    }
  }

  /**
   * The parent half of the alarm: settle a task whose child never reported.
   *
   * The child is *asked*, never re-dispatched. A child that finished but could
   * not deliver its outcome is adopted as it stands; a child that has nothing
   * to say by its deadline is failed, because every admitted Turn must reach a
   * durable terminal state.
   */
  private async reconcileOverdueTasks(): Promise<void> {
    const identity = await this.authority.readDurableIdentity();
    if (!identity) return;
    const binding = this.subagentBinding;
    const now = Date.now();
    for (const task of await this.tasks.active()) {
      if (Date.parse(task.deadlineAt) > now) continue;
      let outcome: TaskOutcomeV1 | undefined;
      if (binding) {
        try {
          outcome = (
            await binding.probe(
              identity,
              taskAnchorIdV1(task.childSessionId),
              task.taskId,
            )
          )?.outcome;
        } catch {
          outcome = undefined;
        }
      }
      await this.settleTask(
        identity,
        task.taskId,
        outcome ?? {
          status: "failed",
          settledAt: new Date().toISOString(),
          failure: `the subagent did not report before its deadline of ${task.deadlineAt}`,
        },
      );
    }
  }

  /**
   * The Subagents seam one admitted Turn runs under. `models` is read lazily,
   * because the Turn's model binding is resolved after the runtime Packages
   * are built and the catalog is only ever read from inside the Turn.
   */
  private subagentsRuntimeHost(
    identity: BotIdentity,
    turn: { runId: string; turnId: string; sessionId: string },
    compositionGenerationId: string,
    turnType: TurnTypeV1,
    models: () => readonly SubagentModelOptionV1[],
    /** Present only in a child: the task this Turn is running. */
    childTaskId?: string,
  ): SubagentsRuntimeHostV1 {
    return {
      botId: identity.botId,
      writer: turn,
      turnType,
      models,
      ...(childTaskId
        ? {
            taskId: childTaskId,
            // The seam that makes `task_message` delivery rather than
            // queueing: the child claims what its parent queued on its way
            // into each step, and the parent marks the claim durably.
            drainMessages: () => this.claimParentTaskMessages(childTaskId),
          }
        : {}),
      dispatch: (request) =>
        this.dispatchSubagentTask(
          identity,
          turn,
          compositionGenerationId,
          request,
        ),
      check: (taskId) => this.checkTask(taskId),
      message: (taskId, message) => this.messageTask(taskId, message),
      stop: async (taskId): Promise<SubagentStopOutcomeV1> => {
        const stopped = await this.stopTask(identity, taskId, "bot");
        return stopped.status === "stopped"
          ? { status: "stopped", taskId }
          : { status: "refused", reason: stopped.reason };
      },
      resume: (request) =>
        this.resumeTask(identity, turn, compositionGenerationId, request),
    };
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
    currentToolNames: () => readonly string[],
    mountedGeneration: () => CompositionGenerationV1 | undefined,
  ): PackageAuthoringHost {
    const artifacts = this.env.APPLICATION_ARTIFACTS;
    return createPackageAuthoringHost({
      storage: {
        get: (key) => this.ctx.storage.get(key),
        put: (entries) => this.ctx.storage.put(entries),
        list: (options) => this.ctx.storage.list(options),
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
      currentToolNames,
      mountedGeneration,
      activationFailures: this.authority.compositionFailures,
    });
  }

  /** Catalog reads plus the two-authority mutation seam for one admitted Turn. */
  private packageCatalogHost(
    identity: BotIdentity,
    turn: { runId: string; turnId: string },
  ): CatalogAwarePackageCatalogHost | undefined {
    if (!this.env.PACKAGE_CATALOG || !this.env.APPLICATION_ARTIFACTS) {
      return undefined;
    }
    const user = this.userConfiguration(identity);
    return createPackageCatalogHost({
      storage: {
        get: (key) => this.ctx.storage.get(key),
        put: (entries) => this.ctx.storage.put(entries),
      },
      composition: this.authority.composition,
      catalog: createR2BotPackageCatalogReader(
        this.env.PACKAGE_CATALOG,
        this.env.APPLICATION_ARTIFACTS,
      ),
      user: {
        read: () =>
          user.readConfiguration({
            schemaVersion: 1,
            userId: identity.userId,
          }),
        execute: (command) => user.executeConfiguration(command),
      },
      userId: identity.userId,
      botId: identity.botId,
      runId: turn.runId,
      turnId: turn.turnId,
    });
  }

  private async agentRuntime(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
    admittedRequest?: NormalizedModelRequest,
    turn?: {
      runId: string;
      turnId: string;
      sessionId: string;
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
    currentToolNames: () => readonly string[] = () => [],
    mountedGeneration: () => CompositionGenerationV1 | undefined = () =>
      undefined,
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
    const application = await this.compileApplication();
    const packageDefinitions = application.packages.map((pkg) => ({
      packageId: pkg.id,
      version: pkg.version,
      settings: pkg.manifest.configuration?.settings ?? [],
      capabilities: pkg.manifest.configuration?.capabilities ?? [],
      connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
    }));
    const plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: packageDefinitions,
    });
    // The durable roots this User's enabled Packages declare, read from the
    // same installations and the same compiled manifests the Composition is
    // resolved from. Handed to the Computer sync below; nothing else reads it.
    const packageRoots = declaredPackageRootsV1({
      installations: user.packages,
      packages: application.packages,
    });
    const readSecret = (name: string) => {
      // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
      const value = (this.env as unknown as Record<string, unknown>)[name];
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
    // Image Package's manifest declares.
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
    const packageCatalog = turn
      ? this.packageCatalogHost(identity, turn)
      : undefined;
    const baseAuthoring = turn
      ? this.authoringHost(identity, turn, currentToolNames, mountedGeneration)
      : undefined;
    const authoring: PackageAuthoringHost | undefined =
      baseAuthoring && packageCatalog
        ? {
            ...baseAuthoring,
            undo: async (request) =>
              (await packageCatalog.undoCatalogChange(request)) ??
              baseAuthoring.undo(request),
          }
        : baseAuthoring;
    const resolvedAgentPackages: FoundationAgentPackage[] = [
      ...createFoundationHostedRuntimePackages(application, {
        userId: identity.userId,
        readSecret,
        // A Bot authors a Package only inside an admitted Turn, whose run and
        // session the artifact provenance names.
        ...(authoring ? { authoring } : {}),
        ...(packageCatalog ? { packageCatalog } : {}),
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
              routines: createBotRoutinesHost(identity, turn, this.routines),
            }
          : {}),
        // A Bot dispatches a subagent only inside an admitted Turn, whose run
        // the task record names, and only where a Subagent Durable Object can
        // actually be addressed (ADR 0017).
        ...(turn && turn.compositionGenerationId && this.subagentBinding
          ? {
              subagents: this.subagentsRuntimeHost(
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
                this.ctx.storage,
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
                    this.ctx.storage,
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
              computerSync: createBotComputerSyncHost(this.env, packageRoots),
              // The same Turn, as the writer a durable Computer write records.
              computerWriter: {
                sessionId: turn.sessionId,
                turnId: turn.turnId,
                runId: turn.runId,
              },
              // A background process is Bot-scoped durable state, so its
              // record lives in this Bot's own Durable Object storage.
              computerProcesses: this.ctx.storage,
              // Prompt assembly reads the Bot DO's Step 1 lease record
              // directly; passing storage wakes no Computer.
              computerControlRecords: this.ctx.storage,
              ...(this.invalidateComputerProjectionFile
                ? {
                    computerProjectionFiles: {
                      invalidate: (
                        botId: string,
                        kind: "screenshots" | "doctor",
                      ) =>
                        this.invalidateComputerProjectionFile?.(
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
      ...(await createFoundationEnabledRuntimePackages(application, plan, {
        userId: identity.userId,
        readSecret,
        authorizeConnection: authorizeEnabledConnection,
        packageSettings,
        // Enabled Contributions reach the network through the same
        // outbound seam the model provider uses, so a deployment that stubs
        // it stubs every one of them.
        ...(this.outboundFetch ? { fetch: this.outboundFetch } : {}),
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
        // A mount that could not reach its server writes that down where
        // the User can read it. The Bot holds no MCP record; the User
        // Durable Object that owns the Connection does.
        recordOutcome: (outcome: McpMountOutcomeReportV1) =>
          userConfiguration.recordMcpMountOutcome(identity.userId, outcome),
      })),
    ];
    const agentPackages: FoundationAgentPackage[] =
      mergeFoundationRuntimePackages(resolvedAgentPackages);
    // One generic resolver owns precedence: enabled Bot-scoped Package value,
    // enabled User-scoped Package value, then the platform model. The kernel
    // names no Package (AGENTS.md Configuration shape; ADR 0019).
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
        ...(this.env.FLOCK_AI
          ? {
              flockAiAutoRoute: this.env.FLOCK_AI.autoRoute,
              runFlockAiChatCompletion: (gatewayModel, body) =>
                this.env.FLOCK_AI!.runChatCompletion(gatewayModel, body),
            }
          : {}),
        fetch: this.outboundFetch,
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
    return {
      // One Package can reach a Turn as more than one Contribution — Ollama
      // Cloud is both the model provider and the `web_search` Capability — and
      // the runtime resolves one Plugin per Contribution specifier.
      agentPackages: mergeFoundationRuntimePackagesV1(agentPackages),
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
    return this.authority.readDurableIdentity();
  }

  async validateIdentity(identity: BotIdentity): Promise<void> {
    return this.authority.validateIdentity(identity);
  }

  /** Recompute the Bot authority's one alarm inside a Package write transaction. */
  async refreshScheduledWork(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    await this.authority.refreshRecoveryAlarm(transaction);
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
    await this.ctx.storage.transaction(async (transaction) => {
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
    await this.ctx.storage.transaction((transaction) =>
      this.authority.refreshRecoveryAlarm(transaction),
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
      // The same notification id the settle recorded, per source: a replay is
      // a second delivery of one intent, never a second intent.
      const subagent = input.source === "subagent";
      await this.authority.recordNotification({
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
      await this.routineInbox.markRenotified(key);
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
    const stored = await this.ctx.storage.list<unknown>({
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
    return this.ctx.storage.transaction(async (transaction) => {
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
    const stored = await this.ctx.storage.list<unknown>({
      prefix: APPROVAL_PREFIX,
    });
    // Retention is enforced on read rather than in the settling transaction,
    // which cannot list. Trimming loses a row and never a fact: the send is
    // still on the durable log of the Turn that made it.
    for (const key of trimmableApprovalKeysV1([...stored.keys()])) {
      await this.ctx.storage.delete(key);
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
        this.ctx.storage,
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

  /** Reads the immutable TypeScript source retained beside an authored artifact. */
  private async readCompositionMemberSource(
    member: CompositionMemberV1,
  ): Promise<string | undefined> {
    const bucket = this.env.APPLICATION_ARTIFACTS;
    if (!bucket) return undefined;
    return readAuthoredCompositionMemberSourceV1({
      storage: { get: (key) => this.ctx.storage.get(key) },
      artifacts: createR2AuthoringArtifactStore(bucket),
      member,
    });
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
   * The Bot's unread projection. The count is derived from the admission index
   * on every read, one page longer than the cap so "99+" is exact.
   */
  async readUnread(identity: BotIdentity): Promise<BotUnreadViewV1> {
    await this.authority.validateIdentity(identity);
    const [storedState, storedPreview] = await this.ctx.storage.transaction(
      (transaction) =>
        Promise.all([
          transaction.get<unknown>(UNREAD_STATE_KEY),
          transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
        ]),
    );
    const state = optionalUnreadStateV1(storedState);
    const preview = optionalSidebarMessagePreviewV1(storedPreview);
    const index = await this.authority.listRunIndex({
      limit: UNREAD_COUNT_CAP + 1,
    });
    return projectBotUnreadViewV1(
      identity.botId,
      state,
      index.map((entry) => entry.cursor),
      preview,
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
        return {
          state: optionalUnreadStateV1(existing.state),
          preview: optionalSidebarMessagePreviewV1(
            await transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
          ),
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
        preview: optionalSidebarMessagePreviewV1(
          await transaction.get<unknown>(SIDEBAR_PREVIEW_KEY),
        ),
      };
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
        stored.state,
        index.map((entry) => entry.cursor),
        stored.preview,
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
    // scheduled work, and recovers the active run. A run left
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
        selected.set(active.runId, {
          run: projectClientRunOrDegradedV1(active),
        });
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
      const projected = projectClientRunOrDegradedV1(stored);
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

  /**
   * One page of settled runs as their durable session events, newest first.
   *
   * The client projection is not enough for every reader: it drops
   * `call.input`, so a projection that has to identify *what* a tool was asked
   * to do — an audit digest, say — cannot be built from it. This is the same
   * runs, unprojected, offered as the narrow shape such a reader needs and
   * nothing wider: the events, the run id, its admission time, its status. No
   * Composition snapshot, no fingerprint, no configuration.
   *
   * Settled runs only. An in-flight run's events can still change, and a
   * projection built from them would not be reproducible.
   */
  async listRunEventPage(cursor?: string): Promise<{
    schemaVersion: 1;
    runs: Array<{
      runId: string;
      acceptedAt: string;
      status: StoredRunStatus;
      events: SessionEvent[];
    }>;
    nextCursor?: string;
  }> {
    const candidates = await this.authority.listRunIndex({
      limit: CLIENT_RUN_PAGE_LIMIT + 1,
      ...(cursor ? { before: cursor } : {}),
    });
    const available = candidates.slice(0, CLIENT_RUN_PAGE_LIMIT);
    const runs: Array<{
      runId: string;
      acceptedAt: string;
      status: StoredRunStatus;
      events: SessionEvent[];
    }> = [];
    for (const candidate of available) {
      const stored = await this.authority.readStoredRun(candidate.runId);
      if (!stored) continue;
      runs.push({
        runId: stored.runId,
        acceptedAt: stored.acceptedAt,
        status: stored.status,
        events: stored.events,
      });
    }
    const oldest = available.at(-1)?.cursor;
    return {
      schemaVersion: 1,
      runs,
      ...(candidates.length > CLIENT_RUN_PAGE_LIMIT && oldest
        ? { nextCursor: oldest }
        : {}),
    };
  }

  /**
   * The operator's snapshot: durable runs unprojected, the Composition
   * generations they pinned, and the failures recorded against those
   * generations. See `debug-protocol.ts` for why this is not `listRuns`.
   *
   * Read-only on purpose — no `recoverActiveRun`, no reconciliation. Looking
   * at a wedged Bot must not be what unwedges it, or the next look tells you
   * nothing about what it was doing.
   */
  async debugSnapshot(
    identity: BotIdentity,
    input: unknown = { schemaVersion: 1 },
  ): Promise<BotDebugSnapshotV1> {
    const query = decodeBotDebugQueryV1(input);
    const [activeRunId, current, notifications] = await Promise.all([
      this.authority.readActiveRunId(),
      this.authority.composition.current(),
      this.listNotifications(),
    ]);
    let lastKnownGoodGenerationId: string | undefined;
    try {
      lastKnownGoodGenerationId = (
        await this.authority.composition.lastKnownGood()
      ).generationId;
    } catch {
      // A Bot whose first generation never mounted has no last known good;
      // that absence is itself a finding, not an error to propagate.
      lastKnownGoodGenerationId = undefined;
    }
    const generationPage = await this.authority.composition.list({
      limit: BOT_DEBUG_GENERATION_LIMIT_V1,
    });
    const generations = await Promise.all(
      generationPage.generations.map(async (generation) => ({
        generationId: generation.generationId,
        createdAt: generation.createdAt,
        status: generation.status,
        origin: generation.origin.kind,
        artifactSetHash: generation.artifactSetHash,
        ...(generation.parentGenerationId === undefined
          ? {}
          : { parentGenerationId: generation.parentGenerationId }),
        memberCount: generation.members.length,
        failures: await this.authority.compositionFailures.list(
          generation.generationId,
        ),
        quarantined:
          (await this.authority.compositionFailures.quarantine(
            generation.generationId,
          )) !== undefined,
      })),
    );

    let candidates: Array<{ cursor?: string; runId: string }>;
    let nextCursor: string | undefined;
    if (query.runId) {
      candidates = [{ runId: query.runId }];
    } else {
      const limit = query.limit ?? BOT_DEBUG_DEFAULT_RUN_LIMIT_V1;
      const page = await this.authority.listRunIndex({
        limit: limit + 1,
        ...(query.before ? { before: query.before } : {}),
      });
      candidates = page.slice(0, limit);
      // The active run is not necessarily the newest admitted one; a wedged
      // run older than the page would otherwise be invisible here.
      if (
        activeRunId &&
        !query.before &&
        !candidates.some((candidate) => candidate.runId === activeRunId)
      ) {
        candidates.unshift({ runId: activeRunId });
      }
      if (page.length > limit) nextCursor = candidates.at(-1)?.cursor;
    }
    const includeEvents = query.runId !== undefined || query.events === true;
    let budget = BOT_DEBUG_EVENT_BYTES_V1;
    const runs: BotDebugRunV1[] = [];
    for (const candidate of candidates) {
      const stored = await this.authority.readStoredRun(candidate.runId);
      if (!stored) continue;
      const bounded = includeEvents
        ? boundDebugEventsV1(stored.events, budget)
        : undefined;
      if (bounded) budget = Math.max(0, budget - bounded.spent);
      runs.push({
        runId: stored.runId,
        sessionId: stored.sessionId,
        acceptedAt: stored.acceptedAt,
        status: stored.status,
        phase: stored.phase,
        input: stored.input,
        commandFingerprint: stored.commandFingerprint,
        compositionGenerationId: stored.compositionGenerationId,
        previousEventCount: stored.previousEventCount,
        eventCount: stored.events.length,
        ...(stored.responseText === undefined
          ? {}
          : { responseText: stored.responseText }),
        ...(stored.failure === undefined ? {} : { failure: stored.failure }),
        ...(bounded
          ? {
              events: bounded.events,
              ...(bounded.omittedEvents > 0
                ? { omittedEvents: bounded.omittedEvents }
                : {}),
            }
          : {}),
      });
    }

    let configuration: BotSettingsViewV1 | undefined;
    try {
      configuration = await this.getSettings(identity);
    } catch {
      // Settings that will not resolve are a live cause of a Bot that never
      // runs a turn, so the snapshot reports the rest rather than failing.
      configuration = undefined;
    }
    return {
      schemaVersion: 1,
      botId: identity.botId,
      capturedAt: new Date().toISOString(),
      ...(activeRunId ? { activeRunId } : {}),
      composition: {
        currentGenerationId: current.generationId,
        currentStatus: current.status,
        ...(lastKnownGoodGenerationId ? { lastKnownGoodGenerationId } : {}),
        generations,
      },
      ...(configuration ? { configuration } : {}),
      notifications,
      runs,
      ...(nextCursor ? { nextCursor } : {}),
    };
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
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
      executeConfiguration(input: unknown): Promise<unknown>;
      readPackageRevisions(
        input: unknown,
      ): ReturnType<PackagePublisherAgentHost["read"]>;
      publishPackage(
        input: unknown,
      ): ReturnType<PackagePublisherAgentHost["publish"]>;
      rollbackPackage(
        input: unknown,
      ): ReturnType<PackagePublisherAgentHost["rollback"]>;
      leaseModelCredential(input: unknown): Promise<unknown>;
      settleModelCredential(input: unknown): Promise<void>;
      leaseToolCredential(input: unknown): Promise<unknown>;
      settleToolCredential(input: unknown): Promise<void>;
      readMcpServers(input: unknown): Promise<unknown>;
      executeMcpCommand(input: unknown): Promise<unknown>;
      recordMcpMountOutcome(input: unknown): Promise<void>;
      listBots(input: unknown): Promise<unknown>;
      createBot(input: unknown): Promise<unknown>;
      executeTemplateCommand(input: unknown): Promise<TemplateShareReceiptV1>;
      listMachines(input: unknown): Promise<unknown>;
      describeMachineTarget(input: unknown): Promise<unknown>;
      dispatchMachineCommand(input: unknown): Promise<unknown>;
      readMachineResult(input: unknown): Promise<unknown>;
    };
    return {
      readConfiguration: (input) => rpc.readConfiguration(input),
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
      readPackageRevisions: (userId) =>
        rpc.readPackageRevisions({ schemaVersion: 1, userId }),
      publishPackage: (userId, command) =>
        rpc.publishPackage({ schemaVersion: 1, userId, command }),
      rollbackPackage: (userId, command) =>
        rpc.rollbackPackage({ schemaVersion: 1, userId, command }),
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
    const stored = await this.ctx.storage.get<unknown>(BOT_CONFIGURATION_KEY);
    if (stored === undefined)
      throw new Error(`Bot "${identity.botId}" is not materialized`);
    return decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored));
  }

  private async resolveExecutionContext(identity: BotIdentity): Promise<{
    settings: BotSettingsViewV1;
    user: UserSettingsViewV1;
    plan: BotExecutionPlanV1;
  }> {
    const settings = await this.ensureBotSettings(identity);
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
    const plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        settings: pkg.manifest.configuration?.settings ?? [],
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    return { settings, user, plan };
  }

  async archiveEligible(storage: {
    get<T>(key: string): Promise<T | undefined>;
  }): Promise<boolean> {
    return (await storage.get<string>(ACTIVE_RUN_KEY)) === undefined;
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
  specifier: "@frockbot/plugin-shell/backend",
  create: (host, lifecycle) =>
    createShellBotBackendPlugin(host.shell, lifecycle),
});

import {
  type BotIsolateEntrypoint,
  type BotIsolateEnv,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import type { MachineResultDeliveryV1 } from "@frockbot/plugin-user-machine/delivery";
import type { DebugGatewaySurface } from "./debug.js";
import type {
  BotConfigurationExecuteRpcV1,
  BotConfigurationReadRpcV1,
  BotSettingsViewV1,
  CompositionCommandReceiptV1,
  CompositionGenerationListViewV1,
  CompositionGenerationViewV1,
  ConnectionView,
  RevertCompositionCommandV1,
  OperationReceiptV1,
  UserConfigurationExecuteRpcV1,
  UserConfigurationReadRpcV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type {
  ConnectionCommandReceiptV1,
  ConnectionCommandV1,
  ConnectionCompletionResult,
  CredentialLeaseV1,
  RevokeConnectionResult,
  StartConnectionResult,
} from "@frockbot/connection-core";
import type {
  McpLifecycleReceiptV1,
  McpMountOutcomeReportV1,
  McpServerStatusViewV1,
} from "@frockbot/plugin-mcp/records";
import type {
  McpAuthorizationCompletionRequestV1,
  McpAuthorizationStartRequestV1,
} from "@frockbot/plugin-mcp/backend";
import type { MemoryVector, MemoryVectorMatch } from "@frockbot/plugin-memory";
// Flock DTOs cross only the authenticated hosted/backend seam.
import type {
  BotDirectoryViewV1,
  BotLifecycleCommandV1,
  BotLifecycleDirectoryViewV1,
  BotLifecycleReceiptV1,
  BotMembershipViewV1,
  BotRegistrationV1,
  CreateBotCommandV1,
  FlockReceiptV1,
  SheepIdentityViewV1,
  UpdateSheepCommandV1,
} from "@frockbot/plugin-flock/shared";
import type {
  TemplateCommandV1,
  TemplateImportListViewV1,
  TemplateImportRecordV1,
  TemplateShareListViewV1,
  TemplateShareReceiptV1,
} from "@frockbot/plugin-bot-template/shared";
import type { TemplateVisibilityV1 } from "@frockbot/template-core";
import type {
  ApprovalDecisionCommandV1,
  ApprovalDecisionReceiptV1,
  ApprovalListViewV1,
} from "@frockbot/plugin-shell/approvals";
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
import type {
  TaskListViewV1,
  TaskViewV1,
} from "@frockbot/plugin-subagents/shared";
import type {
  PackagePublicationReceiptV1,
  PackageRevisionHistoryV1,
  PublishPackageCommandV1,
  RollbackPackageCommandV1,
} from "@frockbot/plugin-package-publisher/shared";
import type {
  ClientRunLookupQueryV1,
  ClientRunLookupV1,
  ClientRunListQueryV1,
  ClientRunListV1,
  ClientRunStopCommandV1,
  ClientRunStopReceiptV1,
  ClientTurnV1,
} from "@frockbot/plugin-shell/run-protocol";
import type { ClientSkillCatalogV1 } from "@frockbot/plugin-shell/skill-protocol";
import type { DeploymentPolicyV1 } from "@frockbot/plugin-admin/shared";

export interface BackendRouteContribution {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: {
      userId?: string;
      client: "browser" | "desktop";
      isAdmin: boolean;
    },
  ): Promise<Response | undefined>;
}

export interface UserApplicationIdentity {
  userId: string;
  applicationHash: string;
}

export type StoredRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "reconciliation-required";

export interface StoredRun {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
  events: SessionEvent[];
  status?: StoredRunStatus;
  responseText?: string;
  failure?: string;
  phase?: "admitted" | "executing" | "reconciliation-required";
  compositionGenerationId?: string;
  configurationSnapshot?: BotSettingsViewV1;
  previousEventCount?: number;
}

export interface BotTurnCommand {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  text: string;
}

export interface BotNotificationIntent {
  notificationId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
}

export type BotTurnResult = ClientTurnV1;

export interface BotStateBinding {
  run(botId: string, command: BotTurnCommand): Promise<BotTurnResult>;
  listRuns(
    botId: string,
    query: ClientRunListQueryV1,
  ): Promise<ClientRunListV1>;
  lookupRun(
    botId: string,
    query: ClientRunLookupQueryV1,
  ): Promise<ClientRunLookupV1>;
  fenceRunAdmission(
    botId: string,
    query: ClientRunLookupQueryV1,
  ): Promise<ClientRunLookupV1>;
  listNotifications(botId: string): Promise<BotNotificationIntent[]>;
  listApprovals(botId: string): Promise<ApprovalListViewV1>;
  decideApproval(
    botId: string,
    approvalId: string,
    command: ApprovalDecisionCommandV1,
  ): Promise<ApprovalDecisionReceiptV1>;
  acknowledgeNotification(botId: string, notificationId: string): Promise<void>;
  reconcileRun(botId: string, runId: string): Promise<BotTurnResult>;
  stopRun(
    botId: string,
    command: ClientRunStopCommandV1,
  ): Promise<ClientRunStopReceiptV1>;
}

export interface MemoryBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  vectorUpsert(vectors: MemoryVector[]): Promise<void>;
  vectorQuery(
    vector: number[],
    options: { topK: number; namespace: string; returnMetadata: "all" },
  ): Promise<{ matches: MemoryVectorMatch[] }>;
  vectorDeleteByIds(ids: string[]): Promise<void>;
  embed(model: string, texts: string[]): Promise<{ data: number[][] }>;
}

/**
 * One durable-root file as the hosted client reads it. A declared variant,
 * never an exception: a root the store cannot serve is an ordinary answer.
 */
export type ClientWorkspaceFileV1 =
  | {
      schemaVersion: 1;
      status: "ok";
      contentHash: string;
      size: number;
      bytesBase64: string;
    }
  | {
      schemaVersion: 1;
      status: "not-found" | "refused" | "conflict" | "unavailable";
      reason: string;
    };

export interface UserBotStateBinding {
  assertRegistered(input: { schemaVersion: 1; botId: string }): Promise<void>;
  run(input: {
    schemaVersion: 1;
    botId: string;
    command: BotTurnCommand;
  }): Promise<BotTurnResult>;
  listRuns(input: {
    schemaVersion: 1;
    botId: string;
    query: ClientRunListQueryV1;
  }): Promise<ClientRunListV1>;
  lookupRun(input: {
    schemaVersion: 1;
    botId: string;
    query: ClientRunLookupQueryV1;
  }): Promise<ClientRunLookupV1>;
  fenceRunAdmission(input: {
    schemaVersion: 1;
    botId: string;
    query: ClientRunLookupQueryV1;
  }): Promise<ClientRunLookupV1>;
  listSkills(input: {
    schemaVersion: 1;
    botId: string;
  }): Promise<ClientSkillCatalogV1>;
  listPackageUi(input: {
    schemaVersion: 1;
    botId: string;
  }): Promise<import("@frockbot/kernel-contracts").PackageIframeCompositionV1>;
  runPackageUiTool(input: {
    schemaVersion: 1;
    botId: string;
    command: import("@frockbot/kernel-contracts").PackageIframeToolCommandV1;
  }): Promise<BotTurnResult>;
  readWorkspaceFileV1(input: {
    schemaVersion: 1;
    botId: string;
    path: unknown;
  }): Promise<ClientWorkspaceFileV1>;
  /**
   * The User's Applets, and the two short-lived projections an open Applet
   * needs (ADR 0022 §4). Account-wide, so they take no Bot: they sit on this
   * User-scoped binding because it is the only door the hosted application has
   * to the User Durable Object.
   */
  listApplets(input?: { schemaVersion: 1 }): Promise<unknown>;
  mintAppletViewerToken(input: {
    schemaVersion: 1;
    appletId: string;
  }): Promise<{
    token: string;
    expiresAt: string;
    appletId: string;
    generationId: string;
  }>;
  readAppletUi(input: { schemaVersion: 1; appletId: string }): Promise<{
    appletId: string;
    generationId: string;
    contentHash: string;
  }>;
  readFocusedApplet(input: {
    schemaVersion: 1;
    botId: string;
  }): Promise<unknown>;
  setFocusedApplet(input: {
    schemaVersion: 1;
    botId: string;
    appletId: string | null;
  }): Promise<unknown>;
  /**
   * An Applet's source, for the Applet canvas's building state. The root is
   * User-scoped, so any of the User's Bots reads the same files; the Bot names
   * the Durable Object that holds the Workspace binding and nothing more.
   */
  readAppletSourceV1(input: {
    schemaVersion: 1;
    botId: string;
    appletId: string;
  }): Promise<import("@frockbot/kernel-contracts").AppletSourceViewV1>;
  /** The outcome last recorded for `applet check` or `applet build`. */
  readAppletBuildV1(input: {
    schemaVersion: 1;
    botId: string;
    appletId: string;
  }): Promise<import("@frockbot/kernel-contracts").AppletBuildViewV1>;
  listNotifications(input: {
    schemaVersion: 1;
    botId: string;
  }): Promise<BotNotificationIntent[]>;
  listApprovals(input: {
    schemaVersion: 1;
    botId: string;
  }): Promise<ApprovalListViewV1>;
  decideApproval(input: {
    schemaVersion: 1;
    botId: string;
    approvalId: string;
    command: ApprovalDecisionCommandV1;
  }): Promise<ApprovalDecisionReceiptV1>;
  acknowledgeNotification(input: {
    schemaVersion: 1;
    botId: string;
    notificationId: string;
  }): Promise<void>;
  reconcileRun(input: {
    schemaVersion: 1;
    botId: string;
    runId: string;
  }): Promise<BotTurnResult>;
  stopRun(input: {
    schemaVersion: 1;
    botId: string;
    command: ClientRunStopCommandV1;
  }): Promise<ClientRunStopReceiptV1>;
}

export interface UserApplicationEnv {
  BOT_STATE: UserBotStateBinding;
  DEPLOYMENT: UserApplicationIdentity;
}

/**
 * The loader-side `WorkerCode`. `env` is generic because two kinds of isolate
 * are loaded from this Worker: a user application (`UserApplicationEnv`) and a
 * Bot Package (`BotIsolateEnv`, from `@frockbot/kernel-contracts`), which sees
 * only `IDENTITY` and the loopback `CAPABILITIES` service binding.
 */
export interface WorkerCode<Env = UserApplicationEnv> {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string | { js: string }>;
  globalOutbound?: null;
  env: Env;
  limits?: {
    cpuMs?: number;
    subRequests?: number;
  };
}

export interface WorkerEntrypointStub {
  fetch(request: Request): Promise<Response>;
}

export interface LoadedWorker<Entrypoint = WorkerEntrypointStub> {
  getEntrypoint(name?: string | null): Entrypoint;
}

export interface WorkerLoader<
  Env = UserApplicationEnv,
  Entrypoint = WorkerEntrypointStub,
> {
  get(
    id: string,
    callback: () => Promise<WorkerCode<Env>>,
  ): LoadedWorker<Entrypoint>;
}

/** The `BOT_PACKAGES` loader: Bot Package isolates, never user applications. */
export type BotPackageLoader = WorkerLoader<
  BotIsolateEnv,
  BotIsolateEntrypoint
>;

export interface ApplicationArtifactStore {
  load(applicationHash: string): Promise<string>;
  /** Hash-verified immutable HTML for the anonymous UI artifact hostname. */
  loadPackageUiArtifact?(contentHash: string): Promise<string | undefined>;
}

/** One verified Catalog object, as `/catalog/v1/*` serves it. */
export interface CatalogGatewayDocument {
  generation: string;
  hash: string;
  document: string;
}

/**
 * The read-only Catalog seam the gateway holds. Only the two documents the
 * routes serve: the gateway publishes the Catalog, it does not own it, and it
 * never writes to the bucket.
 */
export interface CatalogGatewayStore {
  readIndexDocument(
    generation?: string,
  ): Promise<CatalogGatewayDocument | undefined>;
  readEntryDocument(
    catalogId: string,
    generation?: string,
  ): Promise<CatalogGatewayDocument | undefined>;
}

/**
 * Bot-authored Package artifacts (`docs/plans/kernel-and-isolate.md` Step 3).
 * Content-addressed and immutable, stored at `packages/<contentHash>.mjs` in the
 * same `APPLICATION_ARTIFACTS` bucket. Unlike `ApplicationArtifactStore.load`,
 * the reader verifies the hash before the bytes are used.
 */
export interface PackageArtifactStore {
  putPackageArtifact(contentHash: string, module: string): Promise<void>;
  headPackageArtifact(
    contentHash: string,
  ): Promise<{ contentHash: string; size: number } | undefined>;
  loadPackageArtifact(contentHash: string): Promise<string>;
}

/**
 * The `PACKAGE_BUNDLER` service binding (`apps/cloudflare-bundler`). Defined
 * here until `@frockbot/kernel-composition` owns `ArtifactRefV1` (Step 2); the
 * shapes are the plan's verbatim v1 DTOs and must stay in step with
 * `apps/cloudflare-bundler/src/contracts.ts`.
 */
export interface ArtifactRefV1 {
  contentHash: string;
  size: number;
  mediaType: "application/javascript";
  bundlerVersion: string;
}

export interface UiArtifactRefV1 {
  contentHash: string;
  size: number;
  mediaType: "text/html";
  bundlerVersion: string;
}

export interface BundleRequestV1 {
  schemaVersion: 1;
  effectId: string;
  target: "bot-isolate";
  compatibilityDate: string;
  entry: "package.ts";
  sources: { path: string; text: string }[];
  uiPages?: { id: string; html: string }[];
}

export type BundleResultV1 =
  | {
      schemaVersion: 1;
      effectId: string;
      status: "bundled";
      artifact: ArtifactRefV1;
      uiArtifacts?: { id: string; artifact: UiArtifactRefV1; html: string }[];
      module: string;
      diagnostics: string[];
    }
  | {
      schemaVersion: 1;
      effectId: string;
      status: "failed";
      failure: string;
      diagnostics: string[];
    };

export interface BundlerBinding {
  bundle(request: BundleRequestV1): Promise<BundleResultV1>;
}

export interface AuthSession {
  user: {
    id: string;
    email?: string;
  };
}

export interface GatewayAuth {
  handler(request: Request): Promise<Response>;
  getSession(headers: Headers): Promise<AuthSession | null>;
}

export interface ConnectionBinding {
  start(input: {
    commandId: string;
    connectionTypeId: string;
    botId: string;
    alias?: string;
  }): Promise<StartConnectionResult>;
  complete(input: {
    connectionId: string;
    connectedAccountId: string;
  }): Promise<ConnectionCompletionResult>;
  fail(
    connectionId: string,
    message: string,
  ): Promise<ConnectionCompletionResult>;
  revoke(connectionId: string): Promise<RevokeConnectionResult>;
}

export interface UserConfigurationBinding {
  listBots(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<BotDirectoryViewV1>;
  listBotLifecycles(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<BotLifecycleDirectoryViewV1>;
  executeBotLifecycle(request: {
    schemaVersion: 1;
    userId: string;
    command: BotLifecycleCommandV1;
  }): Promise<BotLifecycleReceiptV1>;
  createBot(request: {
    schemaVersion: 1;
    userId: string;
    command: CreateBotCommandV1;
  }): Promise<FlockReceiptV1>;
  getBotRegistration(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
  }): Promise<BotRegistrationV1>;
  hasBot(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
  }): Promise<BotMembershipViewV1>;
  readConfiguration(
    request: UserConfigurationReadRpcV1,
  ): Promise<UserSettingsViewV1>;
  executeConfiguration(
    request: UserConfigurationExecuteRpcV1,
  ): Promise<OperationReceiptV1>;
  executeConnection(request: {
    schemaVersion: 1;
    userId: string;
    command: ConnectionCommandV1;
  }): Promise<ConnectionCommandReceiptV1>;
  lookupConnectionCommand(request: {
    schemaVersion: 1;
    userId: string;
    packageId: string;
    commandId: string;
  }): Promise<ConnectionCommandReceiptV1 | undefined>;
  readMcpServers(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<McpServerStatusViewV1>;
  executeMcpCommand(request: {
    schemaVersion: 1;
    userId: string;
    command: unknown;
  }): Promise<McpLifecycleReceiptV1>;
  recordMcpMountOutcome(request: {
    schemaVersion: 1;
    userId: string;
    outcome: McpMountOutcomeReportV1;
  }): Promise<void>;
  /**
   * The three `mcp-oauth` seams. Every outbound OAuth request and every token
   * lives on the far side of them: the gateway signs a callback state and
   * forwards, and holds nothing.
   */
  startMcpAuthorization(request: {
    schemaVersion: 1;
    userId: string;
    start: McpAuthorizationStartRequestV1;
  }): Promise<StartConnectionResult>;
  completeMcpAuthorization(request: {
    schemaVersion: 1;
    userId: string;
    completion: McpAuthorizationCompletionRequestV1;
  }): Promise<ConnectionCompletionResult>;
  revokeMcpAuthorization(request: {
    schemaVersion: 1;
    userId: string;
    connectionId: string;
  }): Promise<RevokeConnectionResult>;
  getConnection(request: {
    schemaVersion: 1;
    userId: string;
    connectionId: string;
  }): Promise<ConnectionView | undefined>;
  leaseModelCredential(request: {
    schemaVersion: 1;
    userId: string;
    connectionId: string;
    providerModelId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<CredentialLeaseV1>;
  settleModelCredential(request: {
    schemaVersion: 1;
    userId: string;
    connectionId: string;
    packageId: string;
    effectId: string;
  }): Promise<void>;
  readPackageRevisions(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<PackageRevisionHistoryV1>;
  publishPackage(request: {
    schemaVersion: 1;
    userId: string;
    command: PublishPackageCommandV1;
  }): Promise<PackagePublicationReceiptV1>;
  rollbackPackage(request: {
    schemaVersion: 1;
    userId: string;
    command: RollbackPackageCommandV1;
  }): Promise<PackagePublicationReceiptV1>;
  activeApplicationHash(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<string | undefined>;
  listTemplateShares(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<TemplateShareListViewV1>;
  executeTemplateCommand(request: {
    schemaVersion: 1;
    userId: string;
    command: TemplateCommandV1;
  }): Promise<TemplateShareReceiptV1>;
  /**
   * Unauthenticated by design: the share id is the capability, and the User
   * Durable Object answers only for a `link` or `public` share it has not had
   * revoked. Everything else is `undefined`, which the route serves as 404.
   */
  listTemplateImports(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<TemplateImportListViewV1>;
  executeTemplateImport(request: {
    schemaVersion: 1;
    userId: string;
    command: TemplateCommandV1;
  }): Promise<TemplateImportRecordV1>;
  resolveTemplateShare(request: { schemaVersion: 1; shareId: string }): Promise<
    | {
        schemaVersion: 1;
        hash: string;
        visibility: TemplateVisibilityV1;
        document: string;
      }
    | undefined
  >;
}

export interface BotConfigurationBinding {
  readSheep(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
  }): Promise<SheepIdentityViewV1>;
  updateSheep(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: UpdateSheepCommandV1;
  }): Promise<FlockReceiptV1>;
  readConfiguration(
    request: BotConfigurationReadRpcV1,
  ): Promise<BotSettingsViewV1>;
  executeConfiguration(
    request: BotConfigurationExecuteRpcV1,
  ): Promise<OperationReceiptV1>;
  listCompositionGenerations(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    query: { limit: number; cursor?: string };
  }): Promise<CompositionGenerationListViewV1>;
  getCompositionGeneration(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    generationId: string;
  }): Promise<CompositionGenerationViewV1 | undefined>;
  revertComposition(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: RevertCompositionCommandV1;
  }): Promise<CompositionCommandReceiptV1>;
  listRoutines(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
  }): Promise<RoutineListViewV1>;
  /** The Bot's subagent tasks, answered by the parent Bot Durable Object. */
  listTasks(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
  }): Promise<TaskListViewV1>;
  readTask(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    taskId: string;
  }): Promise<TaskViewV1>;
  /** Explicit, authenticated cancellation of one task, by its User. */
  stopTask(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    taskId: string;
  }): Promise<TaskViewV1>;
  executeRoutineCommand(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: RoutineCommandV1;
  }): Promise<RoutineCommandReceiptV1>;
  /**
   * One finished machine command, handed to the Bot that asked for it. Called
   * by the Worker that answered the machine, never by another Durable Object.
   */
  deliverMachineResult(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    delivery: MachineResultDeliveryV1;
  }): Promise<{ status: "accepted" }>;
  deliverRoutineHook(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    delivery: {
      routineId: string;
      keyVersion: number;
      digest: string;
      deliveryId: string;
      body: string;
      contentType?: string | null;
    };
  }): Promise<{ status: "accepted" | "duplicate"; fireId: string }>;
  listRoutineRuns(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    routineId: string;
  }): Promise<RoutineRunListViewV1>;
  readRoutineRun(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    routineId: string;
    runId: string;
  }): Promise<RoutineRunDetailViewV1>;
  listRoutineInbox(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
  }): Promise<RoutineInboxViewV1>;
  executeRoutineInboxCommand(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    command: RoutineInboxCommandV1;
  }): Promise<RoutineInboxReceiptV1>;
}

export interface GatewayDependencies {
  loader: WorkerLoader;
  artifacts: ApplicationArtifactStore;
  /** Dedicated anonymous hostnames that serve only immutable iframe pages. */
  uiArtifactHosts?: readonly string[];
  auth: GatewayAuth;
  userExists(userId: string): Promise<boolean>;
  readDeploymentPolicy(): Promise<DeploymentPolicyV1>;
  /** Raw deployment secret; only the derived `isAdmin` boolean reaches clients. */
  adminEmails?: string;
  applicationHashFor(userId: string): Promise<string>;
  botStateFor(userId: string): UserBotStateBinding;
  userConfigurationFor(userId: string): UserConfigurationBinding;
  botConfigurationFor(userId: string, botId: string): BotConfigurationBinding;
  /**
   * The Applet viewer door (ADR 0022 §4). Both absent in a deployment without
   * Applets, and `/api/applets/:id/socket` then reports itself unconfigured
   * rather than the Worker failing to construct.
   */
  appletViewerSecret?: string;
  /**
   * The Applet object's HTTP door, for the viewer socket: a 101 response and
   * its WebSocket only cross the stub boundary over `fetch`.
   */
  appletStateFor?(
    userId: string,
    appletId: string,
  ): { fetch(request: Request): Promise<Response> };
  /** Authenticated observer transport into the Bot Durable Object. */
  openBotStateChannel?(
    userId: string,
    botId: string,
    request: Request,
    context: { isAdmin: boolean; authMode: string },
  ): Promise<Response>;
  /** Absent when the deployment publishes no Catalog; `/catalog/v1/*` then 503s. */
  catalog?: CatalogGatewayStore;
  /** Absent, or with no token, when the deployment publishes no `/api/debug`. */
  debug?: DebugGatewaySurface;
  backendContributions?: readonly BackendRouteContribution[];
  /** Webview origins allowed to call `/api/*` cross-origin. */
  allowedClientOrigins?: string[];
  allowDevelopmentIdentity?: boolean;
  compatibilityDate?: string;
}

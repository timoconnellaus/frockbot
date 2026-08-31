import type { SessionEvent } from "@frockbot/agent-core";
import type {
  BotIsolateEntrypoint,
  BotIsolateEnv,
} from "@frockbot/kernel-contracts";
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
import type { MemoryVector, MemoryVectorMatch } from "@frockbot/plugin-memory";
// Flock DTOs cross only the authenticated hosted/backend seam.
import type {
  BotDirectoryViewV1,
  BotMembershipViewV1,
  BotRegistrationV1,
  CreateBotCommandV1,
  FlockReceiptV1,
  SheepIdentityViewV1,
  UpdateSheepCommandV1,
} from "@frockbot/plugin-flock/shared";
import type {
  ClientRunLookupQueryV1,
  ClientRunLookupV1,
  ClientRunListQueryV1,
  ClientRunListV1,
  ClientTurnV1,
} from "@frockbot/plugin-shell/run-protocol";

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
    context: { userId?: string; client: "browser" | "desktop" },
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
  acknowledgeNotification(botId: string, notificationId: string): Promise<void>;
  reconcileRun(botId: string, runId: string): Promise<BotTurnResult>;
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
  listNotifications(input: {
    schemaVersion: 1;
    botId: string;
  }): Promise<BotNotificationIntent[]>;
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
  globalOutbound: null;
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

export interface BundleRequestV1 {
  schemaVersion: 1;
  effectId: string;
  target: "bot-isolate";
  compatibilityDate: string;
  entry: "package.ts";
  sources: { path: string; text: string }[];
}

export type BundleResultV1 =
  | {
      schemaVersion: 1;
      effectId: string;
      status: "bundled";
      artifact: ArtifactRefV1;
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
}

export interface GatewayDependencies {
  loader: WorkerLoader;
  artifacts: ApplicationArtifactStore;
  auth: GatewayAuth;
  applicationHashFor(userId: string): Promise<string>;
  botStateFor(userId: string): UserBotStateBinding;
  userConfigurationFor(userId: string): UserConfigurationBinding;
  botConfigurationFor(userId: string, botId: string): BotConfigurationBinding;
  backendContributions?: readonly BackendRouteContribution[];
  allowedClientOrigins?: string[];
  allowDevelopmentIdentity?: boolean;
  compatibilityDate?: string;
}

import type { SessionEvent } from "@frockbot/agent-core";
import type {
  BotConfigurationExecuteRpcV1,
  BotConfigurationReadRpcV1,
  BotSettingsViewV1,
  ConnectionView,
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

export interface WorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string | { js: string }>;
  globalOutbound: null;
  env: UserApplicationEnv;
  limits?: {
    cpuMs?: number;
    subRequests?: number;
  };
}

export interface WorkerEntrypointStub {
  fetch(request: Request): Promise<Response>;
}

export interface LoadedWorker {
  getEntrypoint(name?: string | null): WorkerEntrypointStub;
}

export interface WorkerLoader {
  get(id: string, callback: () => Promise<WorkerCode>): LoadedWorker;
}

export interface ApplicationArtifactStore {
  load(applicationHash: string): Promise<string>;
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

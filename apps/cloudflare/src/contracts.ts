import type { SessionEvent } from "@frockbot/agent-core";
import type {
  BotConfigurationExecuteRpcV1,
  BotConfigurationReadRpcV1,
  BotSettingsViewV1,
  OperationReceiptV1,
  UserConfigurationExecuteRpcV1,
  UserConfigurationReadRpcV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { MemoryVector, MemoryVectorMatch } from "@frockbot/plugin-memory";
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

export type StartConnectionResult =
  | {
      status?: "authorization-required";
      connectionId: string;
      redirectUrl: string;
      expiresAt: string;
      nativeReturnNonce?: string;
    }
  | {
      status: "ready";
      connectionId: string;
      nativeReturnNonce?: string;
    };

export interface RevokeConnectionResult {
  status: "revoked" | "reconciliation-required";
}

export interface ConnectionCompletionResult {
  returnTarget: "browser" | "desktop";
  status: "ready" | "pending" | "failed";
  nativeReturnNonce?: string;
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

export interface BotTurnResult {
  runId: string;
  text: string;
  events: SessionEvent[];
  notification?: BotNotificationIntent;
}

export interface BotStateBinding {
  run(botId: string, command: BotTurnCommand): Promise<BotTurnResult>;
  listRuns(botId: string): Promise<StoredRun[]>;
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

export interface UserApplicationEnv {
  BOT_STATE: BotStateBinding;
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
  readConfiguration(
    request: UserConfigurationReadRpcV1,
  ): Promise<UserSettingsViewV1>;
  executeConfiguration(
    request: UserConfigurationExecuteRpcV1,
  ): Promise<OperationReceiptV1>;
}

export interface BotConfigurationBinding {
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
  botStateFor(userId: string): BotStateBinding;
  userConfigurationFor(userId: string): UserConfigurationBinding;
  botConfigurationFor(userId: string, botId: string): BotConfigurationBinding;
  backendContributions?: readonly BackendRouteContribution[];
  allowedClientOrigins?: string[];
  allowDevelopmentIdentity?: boolean;
  compatibilityDate?: string;
}

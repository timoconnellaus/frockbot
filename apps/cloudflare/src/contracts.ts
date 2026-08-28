import type { SessionEvent } from "@frockbot/agent-core";
import type {
  BotSettingsViewV1,
  ConfigurationCommandV1,
  ConfigurationQueryV1,
  ConfigurationViewV1,
  OperationReceiptV1,
} from "@frockbot/configuration-core";
import type { MemoryVector, MemoryVectorMatch } from "@frockbot/plugin-memory";
import type {
  BackendRouteContribution,
  ConnectionCompletionResult,
  RevokeConnectionResult,
  StartConnectionResult,
} from "@frockbot/plugin-composio/backend";

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

export interface ConfigurationBinding {
  read(query: ConfigurationQueryV1): Promise<ConfigurationViewV1>;
  execute(command: ConfigurationCommandV1): Promise<OperationReceiptV1>;
}

export interface GatewayDependencies {
  loader: WorkerLoader;
  artifacts: ApplicationArtifactStore;
  auth: GatewayAuth;
  applicationHashFor(userId: string): Promise<string>;
  botStateFor(userId: string): BotStateBinding;
  configurationFor(userId: string): ConfigurationBinding;
  backendContributions?: readonly BackendRouteContribution[];
  allowedClientOrigins?: string[];
  allowDevelopmentIdentity?: boolean;
  compatibilityDate?: string;
}

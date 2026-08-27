import type { SessionEvent } from "@frockbot/agent-core";

export interface UserApplicationIdentity {
  userId: string;
  applicationHash: string;
}

export interface StoredRun {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  input: string;
  events: SessionEvent[];
}

export interface BotStateBinding {
  acceptRun(
    botId: string,
    run: Omit<StoredRun, "events">,
  ): Promise<SessionEvent[]>;
  completeRun(
    botId: string,
    runId: string,
    events: SessionEvent[],
  ): Promise<void>;
  listRuns(botId: string): Promise<StoredRun[]>;
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

export interface GatewayDependencies {
  loader: WorkerLoader;
  artifacts: ApplicationArtifactStore;
  auth: GatewayAuth;
  applicationHashFor(userId: string): Promise<string>;
  botStateFor(userId: string): BotStateBinding;
  allowDevelopmentIdentity?: boolean;
  compatibilityDate?: string;
}

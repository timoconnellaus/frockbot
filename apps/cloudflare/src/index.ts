import { WorkerEntrypoint } from "cloudflare:workers";
import { gatewayAuth } from "./auth.js";
import { BotState } from "./bot-state.js";
import type {
  ApplicationArtifactStore,
  BotStateBinding,
  StoredRun,
  WorkerLoader,
} from "./contracts.js";
import { createGateway } from "./gateway.js";

export { BotState };

interface Env {
  USER_APPLICATIONS: WorkerLoader;
  APPLICATION_ARTIFACTS: R2Bucket;
  BOT_STATES: DurableObjectNamespace<BotState>;
  AUTH_DB: D1Database;
  DEFAULT_APPLICATION_HASH: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOW_DEVELOPMENT_AUTH?: string;
}

interface UserBotStateProps {
  userId: string;
}

interface BotStateRpc {
  acceptRun(run: Omit<StoredRun, "events">): Promise<StoredRun["events"]>;
  completeRun(runId: string, events: StoredRun["events"]): Promise<void>;
  listRuns(): Promise<StoredRun[]>;
}

function botStateStub(env: Env, userId: string, botId: string): BotStateRpc {
  const id = env.BOT_STATES.idFromName(`${userId}:${botId}`);
  // SAFETY: Wrangler binds BOT_STATES to BotState, whose public RPC methods
  // exactly match BotStateRpc; workers-types cannot infer the generated stub.
  return env.BOT_STATES.get(id) as unknown as BotStateRpc;
}

export class UserBotState extends WorkerEntrypoint<Env, UserBotStateProps> {
  async acceptRun(
    botId: string,
    run: Omit<StoredRun, "events">,
  ): Promise<StoredRun["events"]> {
    return botStateStub(this.env, this.ctx.props.userId, botId).acceptRun(run);
  }

  async completeRun(
    botId: string,
    runId: string,
    events: StoredRun["events"],
  ): Promise<void> {
    return botStateStub(this.env, this.ctx.props.userId, botId).completeRun(
      runId,
      events,
    );
  }

  async listRuns(botId: string): Promise<StoredRun[]> {
    return botStateStub(this.env, this.ctx.props.userId, botId).listRuns();
  }
}

class R2ApplicationArtifacts implements ApplicationArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async load(applicationHash: string): Promise<string> {
    const object = await this.bucket.get(`applications/${applicationHash}.mjs`);
    if (!object) {
      throw new Error(
        `application artifact "${applicationHash}" was not found`,
      );
    }
    return object.text();
  }
}

interface RuntimeExports {
  UserBotState(options: { props: UserBotStateProps }): BotStateBinding;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // SAFETY: UserBotState is exported by this module; workerd materializes it
    // on ctx.exports, which the generic workers-types declaration cannot see.
    const runtimeExports = ctx.exports as unknown as RuntimeExports;
    const gateway = createGateway({
      loader: env.USER_APPLICATIONS,
      artifacts: new R2ApplicationArtifacts(env.APPLICATION_ARTIFACTS),
      auth: gatewayAuth(env),
      applicationHashFor: () => Promise.resolve(env.DEFAULT_APPLICATION_HASH),
      botStateFor: (userId): BotStateBinding =>
        runtimeExports.UserBotState({ props: { userId } }),
      allowDevelopmentIdentity: env.ALLOW_DEVELOPMENT_AUTH === "true",
    });
    return gateway(request);
  },
} satisfies ExportedHandler<Env>;

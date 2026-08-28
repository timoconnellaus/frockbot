import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  BotSettingsViewV1,
  ConfigurationCommandV1,
  ConfigurationQueryV1,
  ConfigurationViewV1,
  OperationReceiptV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
  type FoundationConnectionStore,
} from "@frockbot/application-foundation/runtime";
import { gatewayAuth } from "./auth.js";
import { BotState, type OwnedBotTurnCommand } from "./bot-state.js";
import type {
  ApplicationArtifactStore,
  BotNotificationIntent,
  BotStateBinding,
  BotTurnCommand,
  BotTurnResult,
  ConfigurationBinding,
  StoredRun,
  WorkerLoader,
} from "./contracts.js";
import { createGateway } from "./gateway.js";
import { UserConfiguration } from "./user-configuration.js";

export { BotState, UserConfiguration };

interface Env {
  USER_APPLICATIONS: WorkerLoader;
  APPLICATION_ARTIFACTS: R2Bucket;
  MEMORY_FILES: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  BOT_STATES: DurableObjectNamespace<BotState>;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
  AUTH_DB: D1Database;
  DEFAULT_APPLICATION_HASH: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  COMPOSIO_API_KEY?: string;
  COMPOSIO_GMAIL_AUTH_CONFIG_ID?: string;
  SPRITES_TOKEN?: string;
  ALLOW_DEVELOPMENT_AUTH?: string;
  ALLOWED_CLIENT_ORIGINS?: string;
}

function allowedClientOrigins(env: Env): string[] | undefined {
  const origins = (env.ALLOWED_CLIENT_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return origins.length > 0 ? origins : undefined;
}

interface UserScopedProps {
  userId: string;
}

interface BotStateRpc {
  run(command: OwnedBotTurnCommand): Promise<BotTurnResult>;
  listRuns(): Promise<StoredRun[]>;
  listNotifications(): Promise<BotNotificationIntent[]>;
  acknowledgeNotification(notificationId: string): Promise<void>;
  reconcileRun(
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<BotTurnResult>;
  getSettings(identity: {
    userId: string;
    botId: string;
  }): Promise<BotSettingsViewV1>;
  executeConfiguration(
    identity: { userId: string; botId: string },
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1>;
  markConnectionUnavailable(
    identity: { userId: string; botId: string },
    connectionId: string,
    compensation?: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale">;
}

interface UserConfigurationRpc extends FoundationConnectionStore {
  read(userId: string): Promise<UserSettingsViewV1>;
  execute(
    userId: string,
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1>;
}

function botStateStub(env: Env, userId: string, botId: string): BotStateRpc {
  const id = env.BOT_STATES.idFromName(`${userId}:${botId}`);
  // SAFETY: Wrangler binds BOT_STATES to BotState, whose public RPC methods
  // exactly match BotStateRpc; workers-types cannot infer the generated stub.
  return env.BOT_STATES.get(id) as unknown as BotStateRpc;
}

function userConfigurationStub(env: Env, userId: string): UserConfigurationRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration, whose
  // public RPC methods exactly match UserConfigurationRpc.
  return env.USER_CONFIGURATIONS.get(id) as unknown as UserConfigurationRpc;
}

export class UserConfigurationApi
  extends WorkerEntrypoint<Env, UserScopedProps>
  implements ConfigurationBinding
{
  async read(query: ConfigurationQueryV1): Promise<ConfigurationViewV1> {
    if (query.type === "user/get") {
      return userConfigurationStub(this.env, this.ctx.props.userId).read(
        this.ctx.props.userId,
      );
    }
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      query.botId,
    ).getSettings({ userId: this.ctx.props.userId, botId: query.botId });
  }

  async execute(command: ConfigurationCommandV1): Promise<OperationReceiptV1> {
    if (command.type === "user/install-package") {
      const application = await compileFoundationApplication();
      const available = application.packages.find(
        (pkg) =>
          pkg.id === command.packageId && pkg.version === command.version,
      );
      if (!available)
        throw new Error("Package is not available in this application");
    }
    if (
      command.type === "user/update-profile" ||
      command.type === "user/set-new-bot-model" ||
      command.type === "user/install-package" ||
      command.type === "user/set-package-enabled"
    ) {
      return userConfigurationStub(this.env, this.ctx.props.userId).execute(
        this.ctx.props.userId,
        command,
      );
    }
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      command.botId,
    ).executeConfiguration(
      { userId: this.ctx.props.userId, botId: command.botId },
      command,
    );
  }
}

export class UserBotState extends WorkerEntrypoint<Env, UserScopedProps> {
  async run(botId: string, command: BotTurnCommand): Promise<BotTurnResult> {
    return botStateStub(this.env, this.ctx.props.userId, botId).run({
      ...command,
      userId: this.ctx.props.userId,
      botId,
    });
  }

  async listRuns(botId: string): Promise<StoredRun[]> {
    return botStateStub(this.env, this.ctx.props.userId, botId).listRuns();
  }

  async listNotifications(botId: string): Promise<BotNotificationIntent[]> {
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      botId,
    ).listNotifications();
  }

  async acknowledgeNotification(
    botId: string,
    notificationId: string,
  ): Promise<void> {
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      botId,
    ).acknowledgeNotification(notificationId);
  }

  async reconcileRun(botId: string, runId: string): Promise<BotTurnResult> {
    return botStateStub(this.env, this.ctx.props.userId, botId).reconcileRun(
      { userId: this.ctx.props.userId, botId },
      runId,
    );
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
  UserBotState(options: { props: UserScopedProps }): BotStateBinding;
  UserConfigurationApi(options: {
    props: UserScopedProps;
  }): ConfigurationBinding;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
    // workers-types cannot infer the generated local RPC stubs.
    const runtimeExports = ctx.exports as unknown as RuntimeExports;
    const application = await compileFoundationApplication();
    const backendContributions = createFoundationBackendContributions(
      application,
      {
        callbackBaseUrl: env.BETTER_AUTH_URL ?? "https://bot.frockbot.com",
        readSecret: (name) => {
          const value = (env as unknown as Record<string, unknown>)[name];
          return typeof value === "string" ? value : undefined;
        },
        storeFor: (userId) => userConfigurationStub(env, userId),
        assignCapability: async (assignment) => {
          const bot = botStateStub(env, assignment.userId, assignment.botId);
          const settings = await bot.getSettings({
            userId: assignment.userId,
            botId: assignment.botId,
          });
          await bot.executeConfiguration(
            { userId: assignment.userId, botId: assignment.botId },
            {
              schemaVersion: 1,
              type: "bot/assign-capability",
              commandId: assignment.generation,
              botId: assignment.botId,
              expectedRevision: settings.revision,
              assignment: {
                assignmentId: assignment.assignmentId,
                packageId: assignment.packageId,
                capabilityId: assignment.capabilityId,
                connectionId: assignment.connectionId,
              },
            },
          );
        },
        markConnectionUnavailable: (
          userId,
          botId,
          connectionId,
          compensation,
        ) =>
          botStateStub(env, userId, botId).markConnectionUnavailable(
            { userId, botId },
            connectionId,
            compensation,
          ),
      },
    );
    const gateway = createGateway({
      loader: env.USER_APPLICATIONS,
      artifacts: new R2ApplicationArtifacts(env.APPLICATION_ARTIFACTS),
      auth: gatewayAuth(env),
      applicationHashFor: () => Promise.resolve(env.DEFAULT_APPLICATION_HASH),
      botStateFor: (userId): BotStateBinding =>
        runtimeExports.UserBotState({ props: { userId } }),
      configurationFor: (userId): ConfigurationBinding =>
        runtimeExports.UserConfigurationApi({ props: { userId } }),
      backendContributions,
      allowedClientOrigins: allowedClientOrigins(env),
      allowDevelopmentIdentity: env.ALLOW_DEVELOPMENT_AUTH === "true",
    });
    return gateway(request);
  },
} satisfies ExportedHandler<Env>;

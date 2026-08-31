import { WorkerEntrypoint } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import {
  decodeBotMembershipViewV1,
  decodeDirectoryViewV1,
  decodeFlockReceiptV1,
  decodeSheepIdentityViewV1,
} from "@frockbot/plugin-flock/shared";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  type ClientRunLookupQueryV1,
  type ClientRunLookupV1,
  type ClientRunListQueryV1,
  type ClientRunListV1,
} from "@frockbot/plugin-shell/run-protocol";
import { gatewayAuth } from "./auth.js";
import { BotState, type OwnedBotTurnCommand } from "./bot-state.js";
import type {
  ApplicationArtifactStore,
  BundlerBinding,
  PackageArtifactStore,
  BotConfigurationBinding,
  BotNotificationIntent,
  BotTurnCommand,
  BotTurnResult,
  UserConfigurationBinding,
  WorkerLoader,
} from "./contracts.js";
import { createGateway } from "./gateway.js";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcObject,
  rpcString,
} from "./durable-rpc.js";
import { createImmutablePlanRequestFactory } from "./immutable-application.js";
import { UserConfiguration } from "./user-configuration.js";

export { BotState, UserConfiguration };

interface Env {
  USER_APPLICATIONS: WorkerLoader;
  APPLICATION_ARTIFACTS: R2Bucket;
  // `apps/cloudflare-bundler`; the Bot Durable Object calls it after recording
  // its authorship intent (plan Step 3, decision D4).
  PACKAGE_BUNDLER: BundlerBinding;
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
  SPRITES_TOKEN?: string;
  CREDENTIAL_KEYRING?: string;
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

interface BotStateRpc extends BotConfigurationBinding {
  run(command: OwnedBotTurnCommand): Promise<BotTurnResult>;
  listRuns(query: ClientRunListQueryV1): Promise<ClientRunListV1>;
  lookupRun(query: ClientRunLookupQueryV1): Promise<ClientRunLookupV1>;
  fenceRunAdmission(query: ClientRunLookupQueryV1): Promise<ClientRunLookupV1>;
  listNotifications(): Promise<BotNotificationIntent[]>;
  acknowledgeNotification(notificationId: string): Promise<void>;
  reconcileRun(
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<BotTurnResult>;
  markConnectionUnavailable(
    identity: { userId: string; botId: string },
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale">;
}

interface UserConfigurationRpc extends UserConfigurationBinding {}

type RpcBoundary<T> = {
  [Key in keyof T]: T[Key] extends (...args: never[]) => infer Result
    ? (input: unknown) => Result
    : never;
};

function botStateStub(env: Env, userId: string, botId: string): BotStateRpc {
  const id = env.BOT_STATES.idFromName(`${userId}:${botId}`);
  // SAFETY: Wrangler binds BOT_STATES to BotState; workers-types cannot infer its generated RPC surface.
  const rpc = env.BOT_STATES.get(id) as unknown as RpcBoundary<BotStateRpc>;
  return {
    readSheep: (request) => rpc.readSheep(request),
    updateSheep: (request) => rpc.updateSheep(request),
    readConfiguration: (request) => rpc.readConfiguration(request),
    executeConfiguration: (request) => rpc.executeConfiguration(request),
    run: (command) =>
      rpc.run({
        schemaVersion: 1,
        userId: command.userId,
        botId: command.botId,
        command: {
          runId: command.runId,
          sessionId: command.sessionId,
          acceptedAt: command.acceptedAt,
          text: command.text,
        },
      }),
    listRuns: (query) =>
      rpc.listRuns({ schemaVersion: 1, userId, botId, query }),
    lookupRun: (query) =>
      rpc.lookupRun({ schemaVersion: 1, userId, botId, query }),
    fenceRunAdmission: (query) =>
      rpc.fenceRunAdmission({ schemaVersion: 1, userId, botId, query }),
    listNotifications: () =>
      rpc.listNotifications({ schemaVersion: 1, userId, botId }),
    acknowledgeNotification: (notificationId) =>
      rpc.acknowledgeNotification({
        schemaVersion: 1,
        userId,
        botId,
        notificationId,
      }),
    reconcileRun: (identity, runId) =>
      rpc.reconcileRun({ schemaVersion: 1, ...identity, runId }),
    markConnectionUnavailable: (identity, connectionId, compensation) =>
      rpc.markConnectionUnavailable({
        schemaVersion: 1,
        ...identity,
        connectionId,
        compensation,
      }),
  };
}

function userConfigurationStub(env: Env, userId: string): UserConfigurationRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its RPC surface.
  const rpc = env.USER_CONFIGURATIONS.get(
    id,
  ) as unknown as RpcBoundary<UserConfigurationRpc>;
  return {
    listBots: (request) => rpc.listBots(request),
    createBot: (request) => rpc.createBot(request),
    getBotRegistration: (request) => rpc.getBotRegistration(request),
    hasBot: (request) => rpc.hasBot(request),
    readConfiguration: (request) => rpc.readConfiguration(request),
    executeConfiguration: (request) => rpc.executeConfiguration(request),
    executeConnection: (request) => rpc.executeConnection(request),
    lookupConnectionCommand: (request) => rpc.lookupConnectionCommand(request),
    getConnection: (request) => rpc.getConnection(request),
    leaseModelCredential: (request) => rpc.leaseModelCredential(request),
    settleModelCredential: (request) => rpc.settleModelCredential(request),
  };
}

function decodeUserBotRunLookupRpcV1(input: unknown): {
  botId: string;
  query: ClientRunLookupQueryV1;
} {
  const request = decodeRpcEnvelopeV1(input, {
    botId: rpcBotId,
    query: rpcDecoded(decodeClientRunLookupQueryV1),
  });
  return {
    botId: request.botId as string,
    query: request.query as ClientRunLookupQueryV1,
  };
}

export class UserBotState extends WorkerEntrypoint<Env, UserScopedProps> {
  async assertRegistered(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    const botId = request.botId as string;
    const membership = decodeBotMembershipViewV1(
      await userConfigurationStub(this.env, this.ctx.props.userId).hasBot({
        schemaVersion: 1,
        userId: this.ctx.props.userId,
        botId,
      }),
    );
    if (!membership.registered) {
      const error = new Error(`Bot "${botId}" is not registered`);
      error.name = "BotNotFoundError";
      throw error;
    }
  }

  async run(input: unknown): Promise<BotTurnResult> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      command: rpcObject({
        runId: rpcIdentifier,
        sessionId: rpcString(257),
        acceptedAt: rpcString(64),
        text: rpcString(100_000),
      }),
    });
    const command = request.command as BotTurnCommand;
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).run({
      ...command,
      userId: this.ctx.props.userId,
      botId: request.botId as string,
    });
  }

  async listRuns(input: unknown): Promise<ClientRunListV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunListQueryV1),
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).listRuns(request.query as ClientRunListQueryV1);
  }

  async lookupRun(input: unknown): Promise<ClientRunLookupV1> {
    const request = decodeUserBotRunLookupRpcV1(input);
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId,
    ).lookupRun(request.query);
  }

  async fenceRunAdmission(input: unknown): Promise<ClientRunLookupV1> {
    const request = decodeUserBotRunLookupRpcV1(input);
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId,
    ).fenceRunAdmission(request.query);
  }

  async listNotifications(input: unknown): Promise<BotNotificationIntent[]> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).listNotifications();
  }

  async acknowledgeNotification(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      notificationId: rpcIdentifier,
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).acknowledgeNotification(request.notificationId as string);
  }

  async reconcileRun(input: unknown): Promise<BotTurnResult> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      runId: rpcIdentifier,
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).reconcileRun(
      { userId: this.ctx.props.userId, botId: request.botId as string },
      request.runId as string,
    );
  }
}

function packageArtifactKey(contentHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error("package artifact contentHash is invalid");
  }
  return `packages/${contentHash}.mjs`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

class R2ApplicationArtifacts
  implements ApplicationArtifactStore, PackageArtifactStore
{
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

  /**
   * Content-addressed, so the write is idempotent: the same bytes always land
   * at the same key. The hash is verified here too — the caller does not get to
   * name bytes something they are not.
   */
  async putPackageArtifact(contentHash: string, module: string): Promise<void> {
    const key = packageArtifactKey(contentHash);
    if ((await sha256Hex(module)) !== contentHash) {
      throw new Error(
        `package artifact "${contentHash}" does not match its content hash`,
      );
    }
    await this.bucket.put(key, module, {
      httpMetadata: { contentType: "application/javascript" },
    });
  }

  async headPackageArtifact(
    contentHash: string,
  ): Promise<{ contentHash: string; size: number } | undefined> {
    const object = await this.bucket.head(packageArtifactKey(contentHash));
    return object ? { contentHash, size: object.size } : undefined;
  }

  /** Hash-verified read: mismatched bytes are never handed to a loader. */
  async loadPackageArtifact(contentHash: string): Promise<string> {
    const object = await this.bucket.get(packageArtifactKey(contentHash));
    if (!object) {
      throw new Error(`package artifact "${contentHash}" was not found`);
    }
    const module = await object.text();
    if ((await sha256Hex(module)) !== contentHash) {
      throw new Error(
        `package artifact "${contentHash}" failed hash verification`,
      );
    }
    return module;
  }
}

interface RuntimeExports {
  UserBotState(options: { props: UserScopedProps }): RpcBoundary<UserBotState>;
}

const createGatewayBackendContributions = createImmutablePlanRequestFactory(
  compileFoundationApplication,
  (application, env: Env) =>
    createFoundationBackendContributions(application, {
      backendHost: "gateway",
      listBots: async (userId) =>
        decodeDirectoryViewV1(
          await userConfigurationStub(env, userId).listBots({
            schemaVersion: 1,
            userId,
          }),
        ),
      createBot: async (userId, command) =>
        decodeFlockReceiptV1(
          await userConfigurationStub(env, userId).createBot({
            schemaVersion: 1,
            userId,
            command,
          }),
        ),
      readSheep: async (userId, botId) =>
        decodeSheepIdentityViewV1(
          await botStateStub(env, userId, botId).readSheep({
            schemaVersion: 1,
            userId,
            botId,
          }),
        ),
      executeConnection: (userId, command) =>
        userConfigurationStub(env, userId).executeConnection({
          schemaVersion: 1,
          userId,
          command,
        }),
      lookupConnectionCommand: (userId, packageId, commandId) =>
        userConfigurationStub(env, userId).lookupConnectionCommand({
          schemaVersion: 1,
          userId,
          packageId,
          commandId,
        }),
      updateSheep: async (userId, botId, command) =>
        decodeFlockReceiptV1(
          await botStateStub(env, userId, botId).updateSheep({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        ),
    }),
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
    // workers-types cannot infer the generated local RPC stubs.
    const runtimeExports = ctx.exports as unknown as RuntimeExports;
    const mountedBackend = await createGatewayBackendContributions(env);
    const gateway = createGateway({
      loader: env.USER_APPLICATIONS,
      artifacts: new R2ApplicationArtifacts(env.APPLICATION_ARTIFACTS),
      auth: gatewayAuth(env),
      applicationHashFor: () => Promise.resolve(env.DEFAULT_APPLICATION_HASH),
      botStateFor: (userId) =>
        runtimeExports.UserBotState({ props: { userId } }),
      userConfigurationFor: (userId): UserConfigurationBinding =>
        userConfigurationStub(env, userId),
      botConfigurationFor: (userId, botId): BotConfigurationBinding =>
        botStateStub(env, userId, botId),
      backendContributions: [...mountedBackend.contributions],
      allowedClientOrigins: allowedClientOrigins(env),
      allowDevelopmentIdentity: env.ALLOW_DEVELOPMENT_AUTH === "true",
    });
    try {
      return await gateway(request);
    } finally {
      await mountedBackend.dispose();
    }
  },
} satisfies ExportedHandler<Env>;

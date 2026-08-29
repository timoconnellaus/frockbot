import { WorkerEntrypoint } from "cloudflare:workers";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
  type FoundationConnectionStore,
} from "@frockbot/application-foundation/runtime";
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
  BotConfigurationBinding,
  BotNotificationIntent,
  BotStateBinding,
  BotTurnCommand,
  BotTurnResult,
  UserConfigurationBinding,
  WorkerLoader,
} from "./contracts.js";
import { createGateway } from "./gateway.js";
import {
  decodeRpcEnvelopeV1,
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
    compensation?: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale">;
}

interface UserConfigurationRpc
  extends FoundationConnectionStore, UserConfigurationBinding {}

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
    listRuns: (query) => rpc.listRuns(query),
    lookupRun: (query) => rpc.lookupRun(query),
    fenceRunAdmission: (query) => rpc.fenceRunAdmission(query),
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
        ...(compensation ? { compensation } : {}),
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
    readConfiguration: (request) => rpc.readConfiguration(request),
    executeConfiguration: (request) => rpc.executeConfiguration(request),
    isPackageInstalled: (owner, packageId) =>
      rpc.isPackageInstalled({ schemaVersion: 1, userId: owner, packageId }),
    getConnection: (owner, connectionId) =>
      rpc.getConnection({ schemaVersion: 1, userId: owner, connectionId }),
    startConnection: (owner, connection) =>
      rpc.startConnection({ schemaVersion: 1, userId: owner, connection }),
    recordConnectLinkResult: (owner, connectionId, safeMetadata) =>
      rpc.recordConnectLinkResult({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        safeMetadata,
      }),
    recordLinkReconciliationIdentity: (owner, connectionId, safeMetadata) =>
      rpc.recordLinkReconciliationIdentity({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        safeMetadata,
      }),
    claimLostLinkCleanup: (owner, connectionId, safeMetadata) =>
      rpc.claimLostLinkCleanup({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        safeMetadata,
      }),
    finishConnectionAuthorization: (owner, connectionId, update) =>
      rpc.finishConnectionAuthorization({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        update,
      }),
    consumeAuthorizationState: (owner, connectionId, authorizationStateId) =>
      rpc.consumeAuthorizationState({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        authorizationStateId,
      }),
    admitConnectionCallback: (owner, connectionId, callback) =>
      rpc.admitConnectionCallback({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        callback,
      }),
    claimConnectionAssignment: (
      owner,
      connectionId,
      leaseId,
      verifiedMetadata,
    ) =>
      rpc.claimConnectionAssignment({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        leaseId,
        ...(verifiedMetadata ? { verifiedMetadata } : {}),
      }),
    finishConnectionAssignment: (owner, connectionId, leaseId) =>
      rpc.finishConnectionAssignment({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        leaseId,
      }),
    requireAssignmentCompensation: (owner, connectionId, leaseId) =>
      rpc.requireAssignmentCompensation({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        leaseId,
      }),
    recordAssignmentCompensated: (owner, connectionId, compensationId) =>
      rpc.recordAssignmentCompensated({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        compensationId,
      }),
    recordConnectionDependency: (
      owner,
      connectionId,
      targetBotId,
      generation,
    ) =>
      rpc.recordConnectionDependency({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        botId: targetBotId,
        generation,
      }),
    requireConnectionReconciliation: (
      owner,
      connectionId,
      operation,
      failure,
    ) =>
      rpc.requireConnectionReconciliation({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        operation,
        failure,
      }),
    claimConnectionRevocation: (owner, connectionId, recoveredSafeMetadata) =>
      rpc.claimConnectionRevocation({
        schemaVersion: 1,
        userId: owner,
        connectionId,
        ...(recoveredSafeMetadata ? { recoveredSafeMetadata } : {}),
      }),
    recordRevocationProviderCompleted: (owner, connectionId) =>
      rpc.recordRevocationProviderCompleted({
        schemaVersion: 1,
        userId: owner,
        connectionId,
      }),
    finishConnectionRevocation: (owner, connectionId) =>
      rpc.finishConnectionRevocation({
        schemaVersion: 1,
        userId: owner,
        connectionId,
      }),
  };
}

function decodeUserBotRunLookupRpcV1(input: unknown): {
  botId: string;
  query: ClientRunLookupQueryV1;
} {
  const request = decodeRpcEnvelopeV1(input, {
    botId: rpcIdentifier,
    query: rpcDecoded(decodeClientRunLookupQueryV1),
  });
  return {
    botId: request.botId as string,
    query: request.query as ClientRunLookupQueryV1,
  };
}

export class UserBotState extends WorkerEntrypoint<Env, UserScopedProps> {
  async run(input: unknown): Promise<BotTurnResult> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcIdentifier,
      command: rpcObject({
        runId: rpcIdentifier,
        sessionId: rpcString(256),
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
      botId: rpcIdentifier,
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
    const request = decodeRpcEnvelopeV1(input, { botId: rpcIdentifier });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).listNotifications();
  }

  async acknowledgeNotification(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcIdentifier,
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
      botId: rpcIdentifier,
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
  UserBotState(options: {
    props: UserScopedProps;
  }): RpcBoundary<BotStateBinding>;
}

function userBotStateBinding(
  runtimeExports: RuntimeExports,
  userId: string,
): BotStateBinding {
  const rpc = runtimeExports.UserBotState({ props: { userId } });
  return {
    run: (botId, command) => rpc.run({ schemaVersion: 1, botId, command }),
    listRuns: (botId, query) =>
      rpc.listRuns({ schemaVersion: 1, botId, query }),
    lookupRun: (botId, query) =>
      rpc.lookupRun({ schemaVersion: 1, botId, query }),
    fenceRunAdmission: (botId, query) =>
      rpc.fenceRunAdmission({ schemaVersion: 1, botId, query }),
    listNotifications: (botId) =>
      rpc.listNotifications({ schemaVersion: 1, botId }),
    acknowledgeNotification: (botId, notificationId) =>
      rpc.acknowledgeNotification({
        schemaVersion: 1,
        botId,
        notificationId,
      }),
    reconcileRun: (botId, runId) =>
      rpc.reconcileRun({ schemaVersion: 1, botId, runId }),
  };
}

const createGatewayBackendContributions = createImmutablePlanRequestFactory(
  compileFoundationApplication,
  (application, env: Env) =>
    createFoundationBackendContributions(application, {
      backendHost: "gateway",
      callbackBaseUrl: env.BETTER_AUTH_URL ?? "https://bot.frockbot.com",
      readSecret: (name) => {
        // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
        const value = (env as unknown as Record<string, unknown>)[name];
        return typeof value === "string" ? value : undefined;
      },
      storeFor: (userId) => userConfigurationStub(env, userId),
      markConnectionUnavailable: (userId, botId, connectionId, compensation) =>
        botStateStub(env, userId, botId).markConnectionUnavailable(
          { userId, botId },
          connectionId,
          compensation,
        ),
    }),
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
    // workers-types cannot infer the generated local RPC stubs.
    const runtimeExports = ctx.exports as unknown as RuntimeExports;
    const backendContributions = await createGatewayBackendContributions(env);
    const gateway = createGateway({
      loader: env.USER_APPLICATIONS,
      artifacts: new R2ApplicationArtifacts(env.APPLICATION_ARTIFACTS),
      auth: gatewayAuth(env),
      applicationHashFor: () => Promise.resolve(env.DEFAULT_APPLICATION_HASH),
      botStateFor: (userId): BotStateBinding =>
        userBotStateBinding(runtimeExports, userId),
      userConfigurationFor: (userId): UserConfigurationBinding =>
        userConfigurationStub(env, userId),
      botConfigurationFor: (userId, botId): BotConfigurationBinding =>
        botStateStub(env, userId, botId),
      backendContributions,
      allowedClientOrigins: allowedClientOrigins(env),
      allowDevelopmentIdentity: env.ALLOW_DEVELOPMENT_AUTH === "true",
    });
    return gateway(request);
  },
} satisfies ExportedHandler<Env>;

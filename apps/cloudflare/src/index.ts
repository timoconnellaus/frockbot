import { WorkerEntrypoint } from "cloudflare:workers";
import { decodeSkillRefsV1 } from "@frockbot/kernel-contracts";
import type { ClientSkillCatalogV1 } from "@frockbot/plugin-shell/skill-protocol";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import {
  decodeBotLifecycleDirectoryViewV1,
  decodeBotLifecycleReceiptV1,
  type BotLifecycleCommandV1,
  decodeBotMembershipViewV1,
  decodeDirectoryViewV1,
  decodeFlockReceiptV1,
  decodeSheepIdentityViewV1,
  BotNotFoundError,
  decodeBotIdentityDirectoryViewV1,
  FLOCK_DIRECTORY_LIMIT,
  type BotIdentityDirectoryViewV1,
  type BotIdentityViewV1,
} from "@frockbot/plugin-flock/shared";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  type ClientRunLookupQueryV1,
  type ClientRunLookupV1,
  type ClientRunListQueryV1,
  type ClientRunListV1,
  type ClientRunStopCommandV1,
  type ClientRunStopReceiptV1,
} from "@frockbot/plugin-shell/run-protocol";
import {
  decodeBotNotificationDirectoryViewV1,
  decodeBotUnreadDirectoryViewV1,
  decodeBotUnreadReceiptV1,
  type BotNotificationDirectoryViewV1,
  type BotUnreadCommandV1,
  type BotUnreadDirectoryViewV1,
  type BotUnreadReceiptV1,
  type BotUnreadViewV1,
} from "@frockbot/plugin-shell/unread";
import {
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationListViewV1,
  decodeCompositionGenerationViewV1,
  botAvatarObjectKeyV1,
  decodeBotAvatarBytesV1,
  type BotAvatarUploadReceiptV1,
  type BotSettingsViewV1,
  type UploadBotAvatarCommandV1,
} from "@frockbot/configuration-core";
import {
  decodeRoutineCommandReceiptV1,
  decodeRoutineInboxReceiptV1,
  decodeRoutineInboxViewV1,
  decodeRoutineListViewV1,
  decodeRoutineRunDetailViewV1,
  decodeRoutineRunListViewV1,
} from "@frockbot/plugin-routines/shared";
import {
  decodeClientSearchRebuildReceiptV1,
  decodeSearchIndexResultsV1,
  type SearchQueryV1,
} from "@frockbot/plugin-search";
import {
  decodeMcpLifecycleReceiptV1,
  decodeMcpServerStatusViewV1,
} from "@frockbot/plugin-mcp/records";
import {
  decodeTemplateImportListViewV1,
  decodeTemplateImportRecordV1,
  decodeTemplateShareListViewV1,
  decodeTemplateShareReceiptV1,
  type TemplateCommandV1,
} from "@frockbot/plugin-bot-template/shared";
import {
  parseTemplateShareIdV1,
  type TemplateVisibilityV1,
} from "@frockbot/template-core";
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
  BotPackageLoader,
  UserConfigurationBinding,
  WorkerLoader,
  ClientWorkspaceFileV1,
} from "./contracts.js";
import { createGateway } from "./gateway.js";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcDecodedValue,
  rpcIdentifier,
  rpcObject,
  rpcString,
} from "./durable-rpc.js";
import { createImmutablePlanRequestFactory } from "./immutable-application.js";
import { R2PackageCatalog } from "./package-catalog.js";
import { UserConfiguration } from "./user-configuration.js";

export { BotCapabilities } from "./bot-capabilities.js";
export { BotState, UserConfiguration };

interface Env {
  USER_APPLICATIONS: WorkerLoader;
  // Bot-authored Package isolates, driven from the Bot Durable Object with
  // `globalOutbound` disabled (plan Step 4). A separate loader namespace from
  // USER_APPLICATIONS so the two never share an identity.
  BOT_PACKAGES: BotPackageLoader;
  APPLICATION_ARTIFACTS: R2Bucket;
  // `apps/cloudflare-bundler`; the Bot Durable Object calls it after recording
  // its authorship intent (plan Step 3, decision D4).
  PACKAGE_BUNDLER: BundlerBinding;
  MEMORY_FILES: R2Bucket;
  /**
   * The remote Package Catalog. Optional so a deployment without one still
   * boots: `/catalog/v1/*` then reports the Catalog as unconfigured rather
   * than the Worker failing to construct.
   */
  PACKAGE_CATALOG?: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  BOT_STATES: DurableObjectNamespace<BotState>;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
  COMPUTER_HOST: Fetcher;
  /** Shared secret presented on every Computer host call. */
  COMPUTER_HOST_TOKEN?: string;
  AUTH_DB: D1Database;
  DEFAULT_APPLICATION_HASH: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SPRITES_TOKEN?: string;
  CREDENTIAL_KEYRING?: string;
  /** Signs every Routine webhook key. Absent closes the webhook door. */
  ROUTINE_HOOK_SECRET?: string;
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
  listSkills(): Promise<ClientSkillCatalogV1>;
  readWorkspaceFileV1(path: unknown): Promise<ClientWorkspaceFileV1>;
  listNotifications(): Promise<BotNotificationIntent[]>;
  acknowledgeNotification(notificationId: string): Promise<void>;
  readUnread(): Promise<BotUnreadViewV1>;
  executeUnreadCommand(
    command: BotUnreadCommandV1,
  ): Promise<BotUnreadReceiptV1>;
  reconcileRun(
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<BotTurnResult>;
  stopRun(command: ClientRunStopCommandV1): Promise<ClientRunStopReceiptV1>;
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
    listRoutines: (request) => rpc.listRoutines(request),
    executeRoutineCommand: (request) => rpc.executeRoutineCommand(request),
    listRoutineRuns: (request) => rpc.listRoutineRuns(request),
    deliverRoutineHook: (request) => rpc.deliverRoutineHook(request),
    readRoutineRun: (request) => rpc.readRoutineRun(request),
    listRoutineInbox: (request) => rpc.listRoutineInbox(request),
    executeRoutineInboxCommand: (request) =>
      rpc.executeRoutineInboxCommand(request),
    listCompositionGenerations: (request) =>
      rpc.listCompositionGenerations(request),
    getCompositionGeneration: (request) =>
      rpc.getCompositionGeneration(request),
    revertComposition: (request) => rpc.revertComposition(request),
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
          ...(command.skills ? { skills: command.skills } : {}),
        },
      }),
    listRuns: (query) =>
      rpc.listRuns({ schemaVersion: 1, userId, botId, query }),
    lookupRun: (query) =>
      rpc.lookupRun({ schemaVersion: 1, userId, botId, query }),
    fenceRunAdmission: (query) =>
      rpc.fenceRunAdmission({ schemaVersion: 1, userId, botId, query }),
    listSkills: () => rpc.listSkills({ schemaVersion: 1, userId, botId }),
    readWorkspaceFileV1: (path) =>
      rpc.readWorkspaceFileV1({ schemaVersion: 1, userId, botId, path }),
    listNotifications: () =>
      rpc.listNotifications({ schemaVersion: 1, userId, botId }),
    readUnread: () => rpc.readUnread({ schemaVersion: 1, userId, botId }),
    executeUnreadCommand: (command) =>
      rpc.executeUnreadCommand({ schemaVersion: 1, userId, botId, command }),
    acknowledgeNotification: (notificationId) =>
      rpc.acknowledgeNotification({
        schemaVersion: 1,
        userId,
        botId,
        notificationId,
      }),
    reconcileRun: (identity, runId) =>
      rpc.reconcileRun({ schemaVersion: 1, ...identity, runId }),
    stopRun: (command) =>
      rpc.stopRun({ schemaVersion: 1, userId, botId, command }),
    markConnectionUnavailable: (identity, connectionId, compensation) =>
      rpc.markConnectionUnavailable({
        schemaVersion: 1,
        ...identity,
        connectionId,
        compensation,
      }),
  };
}

function rpcJsonSnapshot<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("RPC response is not a JSON value");
    }
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new Error("RPC response is not valid JSON", { cause: error });
  }
}

function userConfigurationStub(env: Env, userId: string): UserConfigurationRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its RPC surface.
  const rpc = env.USER_CONFIGURATIONS.get(
    id,
  ) as unknown as RpcBoundary<UserConfigurationRpc>;
  return {
    listBots: (request) => rpc.listBots(request),
    listBotLifecycles: (request) => rpc.listBotLifecycles(request),
    executeBotLifecycle: (request) => rpc.executeBotLifecycle(request),
    createBot: (request) => rpc.createBot(request),
    getBotRegistration: (request) => rpc.getBotRegistration(request),
    hasBot: (request) => rpc.hasBot(request),
    readConfiguration: (request) => rpc.readConfiguration(request),
    executeConfiguration: (request) => rpc.executeConfiguration(request),
    executeConnection: (request) => rpc.executeConnection(request),
    lookupConnectionCommand: (request) => rpc.lookupConnectionCommand(request),
    readMcpServers: (request) => rpc.readMcpServers(request),
    executeMcpCommand: (request) => rpc.executeMcpCommand(request),
    recordMcpMountOutcome: (request) => rpc.recordMcpMountOutcome(request),
    getConnection: (request) => rpc.getConnection(request),
    leaseModelCredential: (request) => rpc.leaseModelCredential(request),
    settleModelCredential: (request) => rpc.settleModelCredential(request),
    readPackageRevisions: (request) => rpc.readPackageRevisions(request),
    publishPackage: (request) => rpc.publishPackage(request),
    rollbackPackage: (request) => rpc.rollbackPackage(request),
    activeApplicationHash: (request) => rpc.activeApplicationHash(request),
    listTemplateShares: (request) => rpc.listTemplateShares(request),
    executeTemplateCommand: (request) => rpc.executeTemplateCommand(request),
    resolveTemplateShare: (request) => rpc.resolveTemplateShare(request),
    listTemplateImports: (request) => rpc.listTemplateImports(request),
    executeTemplateImport: (request) => rpc.executeTemplateImport(request),
  };
}

/**
 * The User Durable Object's transcript-index RPCs.
 *
 * Narrow and separate from `UserConfigurationBinding`: search is one Package's
 * Contribution, and the generic configuration binding every gateway adapter
 * implements has no business growing a method for it.
 */
interface UserSearchRpc {
  searchTranscripts(input: unknown): Promise<unknown>;
  rebuildSearchIndex(input: unknown): Promise<unknown>;
}

function userSearchStub(env: Env, userId: string): UserSearchRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its generated Search RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as UserSearchRpc;
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
    const lifecycles = decodeBotLifecycleDirectoryViewV1(
      await userConfigurationStub(
        this.env,
        this.ctx.props.userId,
      ).listBotLifecycles({
        schemaVersion: 1,
        userId: this.ctx.props.userId,
      }),
    );
    if (
      lifecycles.lifecycles.find((item) => item.botId === botId)?.status ===
      "archived"
    ) {
      const error = new Error(`Bot "${botId}" is archived`);
      error.name = "BotArchivedError";
      throw error;
    }
  }

  async run(input: unknown): Promise<BotTurnResult> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      command: rpcObject(
        {
          runId: rpcIdentifier,
          sessionId: rpcString(257),
          acceptedAt: rpcString(64),
          text: rpcString(100_000),
        },
        { skills: (value, label) => decodeSkillRefsV1(value, label) },
      ),
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

  async listSkills(input: unknown): Promise<ClientSkillCatalogV1> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).listSkills();
  }

  async readWorkspaceFileV1(input: unknown): Promise<ClientWorkspaceFileV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      path: rpcDecodedValue,
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).readWorkspaceFileV1(request.path);
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

  async stopRun(input: unknown): Promise<ClientRunStopReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      command: rpcDecoded(decodeClientRunStopCommandV1),
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).stopRun(request.command as ClientRunStopCommandV1);
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

/**
 * Projects one Bot's durable settings onto the Flock identity DTO. The Bot
 * Durable Object stays the authority: this is a read-through view, so the
 * immutable registration seed (ADR 0006) never has to carry mutable identity.
 */
function botIdentityView(
  botId: string,
  settings: BotSettingsViewV1,
): BotIdentityViewV1 {
  const profile = settings.profile;
  return {
    schemaVersion: 1,
    botId,
    name: profile.name,
    namedBy: profile.namedBy ?? "user",
    hiddenFromSidebar: profile.hiddenFromSidebar === true,
    ...(profile.title === undefined ? {} : { title: profile.title }),
    ...(profile.avatar?.kind === "image" ? { avatar: profile.avatar } : {}),
  };
}

async function listBotIdentities(
  env: Env,
  userId: string,
): Promise<BotIdentityDirectoryViewV1> {
  const directory = decodeDirectoryViewV1(
    rpcJsonSnapshot(
      await userConfigurationStub(env, userId).listBots({
        schemaVersion: 1,
        userId,
      }),
    ),
  );
  // The directory is already bounded to FLOCK_DIRECTORY_LIMIT; the slice makes
  // the fan-out bound explicit at the point that pays for it.
  const identities = await Promise.all(
    directory.bots.slice(0, FLOCK_DIRECTORY_LIMIT).map(async (bot) =>
      botIdentityView(
        bot.botId,
        (await botStateStub(env, userId, bot.botId).readConfiguration({
          schemaVersion: 1,
          userId,
          botId: bot.botId,
        })) as BotSettingsViewV1,
      ),
    ),
  );
  return decodeBotIdentityDirectoryViewV1({ schemaVersion: 1, identities });
}

/**
 * The Bots a fan-out reads: registered, not archived, and bounded by the same
 * `FLOCK_DIRECTORY_LIMIT` the identity directory pays for.
 */
async function fanOutBotIds(env: Env, userId: string): Promise<string[]> {
  const [directory, lifecycles] = await Promise.all([
    userConfigurationStub(env, userId)
      .listBots({ schemaVersion: 1, userId })
      .then((value) => decodeDirectoryViewV1(rpcJsonSnapshot(value))),
    userConfigurationStub(env, userId)
      .listBotLifecycles({ schemaVersion: 1, userId })
      .then((value) =>
        decodeBotLifecycleDirectoryViewV1(rpcJsonSnapshot(value)),
      ),
  ]);
  const archived = new Set(
    lifecycles.lifecycles
      .filter((entry) => entry.status === "archived")
      .map((entry) => entry.botId),
  );
  return directory.bots
    .slice(0, FLOCK_DIRECTORY_LIMIT)
    .map((bot) => bot.botId)
    .filter((botId) => !archived.has(botId));
}

/** Unread for the whole sidebar in one round trip. */
async function listBotUnread(
  env: Env,
  userId: string,
): Promise<BotUnreadDirectoryViewV1> {
  const botIds = await fanOutBotIds(env, userId);
  const unread = await Promise.all(
    botIds.map((botId) =>
      botStateStub(env, userId, botId)
        .readUnread()
        .then((value) => rpcJsonSnapshot(value)),
    ),
  );
  return decodeBotUnreadDirectoryViewV1({ schemaVersion: 1, unread });
}

/**
 * Pending intents across every non-archived Bot. Acknowledgement stays
 * per-Bot: this route only makes a background Bot's completion visible.
 */
async function listBotNotifications(
  env: Env,
  userId: string,
): Promise<BotNotificationDirectoryViewV1> {
  const botIds = await fanOutBotIds(env, userId);
  const perBot = await Promise.all(
    botIds.map(async (botId) =>
      (await botStateStub(env, userId, botId).listNotifications()).map(
        (intent) => ({
          schemaVersion: 1 as const,
          botId,
          ...rpcJsonSnapshot(intent),
        }),
      ),
    ),
  );
  return decodeBotNotificationDirectoryViewV1({
    schemaVersion: 1,
    notifications: perBot.flat(),
  });
}

async function executeBotUnreadCommand(
  env: Env,
  userId: string,
  botId: string,
  command: BotUnreadCommandV1,
): Promise<BotUnreadReceiptV1> {
  // Membership first: a Bot this User does not own is not found, never marked.
  const membership = decodeBotMembershipViewV1(
    rpcJsonSnapshot(
      await userConfigurationStub(env, userId).hasBot({
        schemaVersion: 1,
        userId,
        botId,
      }),
    ),
  );
  if (!membership.registered) throw new BotNotFoundError(botId);
  return decodeBotUnreadReceiptV1(
    rpcJsonSnapshot(
      await botStateStub(env, userId, botId).executeUnreadCommand(command),
    ),
  );
}

async function readBotAvatar(
  env: Env,
  userId: string,
  botId: string,
): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  const settings = (await botStateStub(env, userId, botId).readConfiguration({
    schemaVersion: 1,
    userId,
    botId,
  })) as BotSettingsViewV1;
  const avatar = settings.profile.avatar;
  if (avatar?.kind !== "image") return undefined;
  const object = await env.APPLICATION_ARTIFACTS.get(
    botAvatarObjectKeyV1(userId, avatar.digest),
  );
  if (!object) return undefined;
  return {
    bytes: new Uint8Array(await object.arrayBuffer()),
    contentType: avatar.contentType,
  };
}

async function uploadBotAvatar(
  env: Env,
  userId: string,
  botId: string,
  command: UploadBotAvatarCommandV1,
): Promise<BotAvatarUploadReceiptV1> {
  // Membership before storage: an unregistered Bot never causes a write.
  const membership = decodeBotMembershipViewV1(
    rpcJsonSnapshot(
      await userConfigurationStub(env, userId).hasBot({
        schemaVersion: 1,
        userId,
        botId,
      }),
    ),
  );
  if (!membership.registered) {
    throw new BotNotFoundError(botId);
  }
  const bytes = decodeBotAvatarBytesV1(command.bytes);
  const digest = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await env.APPLICATION_ARTIFACTS.put(
    botAvatarObjectKeyV1(userId, digest),
    bytes,
    { httpMetadata: { contentType: command.contentType } },
  );
  return {
    schemaVersion: 1,
    botId,
    avatar: {
      kind: "image",
      digest,
      contentType: command.contentType,
      size: bytes.byteLength,
    },
  };
}

/**
 * One published template, for the unauthenticated `GET /templates/v1/:shareId`.
 *
 * The share id names its owner, so the route needs no index and no lookup
 * table: it derives the one User Durable Object that could answer, and that
 * object refuses a `private` or revoked share exactly as it refuses one it has
 * never heard of. A malformed id is `undefined` here, so it is a 404 at the
 * route rather than an error a prober could tell apart.
 */
async function readPublishedTemplate(
  env: Env,
  shareId: string,
): Promise<
  | { hash: string; visibility: TemplateVisibilityV1; document: string }
  | undefined
> {
  let ownerId: string;
  try {
    ownerId = parseTemplateShareIdV1(shareId).ownerId;
  } catch {
    return undefined;
  }
  const answered = await userConfigurationStub(
    env,
    ownerId,
  ).resolveTemplateShare({ schemaVersion: 1, shareId });
  // A share that is missing, private, or revoked all answer the same way, and
  // that answer is not a JSON value, so it is checked before the snapshot.
  if (answered === undefined || answered === null) return undefined;
  const found = rpcJsonSnapshot(answered);
  if (!found || typeof found !== "object") return undefined;
  const value = found as Record<string, unknown>;
  if (
    typeof value.hash !== "string" ||
    typeof value.document !== "string" ||
    (value.visibility !== "link" && value.visibility !== "public")
  ) {
    return undefined;
  }
  return {
    hash: value.hash,
    visibility: value.visibility,
    document: value.document,
  };
}

interface RuntimeExports {
  UserBotState(options: { props: UserScopedProps }): RpcBoundary<UserBotState>;
}

const createGatewayBackendContributions = createImmutablePlanRequestFactory(
  compileFoundationApplication,
  (application, env: Env) =>
    createFoundationBackendContributions(application, {
      backendHost: "gateway",
      listTemplateShares: async (userId: string) =>
        decodeTemplateShareListViewV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).listTemplateShares({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      executeTemplateCommand: async (
        userId: string,
        command: TemplateCommandV1,
      ) =>
        decodeTemplateShareReceiptV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).executeTemplateCommand({
              schemaVersion: 1,
              userId,
              command,
            }),
          ),
        ),
      readPublishedTemplate: (shareId: string) =>
        readPublishedTemplate(env, shareId),
      listTemplateImports: async (userId: string) =>
        decodeTemplateImportListViewV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).listTemplateImports({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      executeTemplateImport: async (
        userId: string,
        command: TemplateCommandV1,
      ) =>
        decodeTemplateImportRecordV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).executeTemplateImport({
              schemaVersion: 1,
              userId,
              command,
            }),
          ),
        ),
      listBots: async (userId) =>
        decodeDirectoryViewV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).listBots({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      listBotLifecycles: async (userId: string) =>
        decodeBotLifecycleDirectoryViewV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).listBotLifecycles({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      executeBotLifecycle: async (
        userId: string,
        command: BotLifecycleCommandV1,
      ) =>
        decodeBotLifecycleReceiptV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).executeBotLifecycle({
              schemaVersion: 1,
              userId,
              command,
            }),
          ),
        ),
      createBot: async (userId, command) =>
        decodeFlockReceiptV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).createBot({
              schemaVersion: 1,
              userId,
              command,
            }),
          ),
        ),
      listBotIdentities: (userId: string) => listBotIdentities(env, userId),
      searchTranscripts: async (userId: string, query: SearchQueryV1) =>
        decodeSearchIndexResultsV1(
          rpcJsonSnapshot(
            await userSearchStub(env, userId).searchTranscripts({
              schemaVersion: 1,
              userId,
              query,
            }),
          ),
        ),
      rebuildSearchIndex: async (userId: string) =>
        decodeClientSearchRebuildReceiptV1(
          rpcJsonSnapshot(
            await userSearchStub(env, userId).rebuildSearchIndex({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      listBotUnread: (userId: string) => listBotUnread(env, userId),
      listBotNotifications: (userId: string) =>
        listBotNotifications(env, userId),
      executeBotUnreadCommand: (
        userId: string,
        botId: string,
        command: BotUnreadCommandV1,
      ) => executeBotUnreadCommand(env, userId, botId, command),
      readBotAvatar: (userId: string, botId: string) =>
        readBotAvatar(env, userId, botId),
      uploadBotAvatar: (
        userId: string,
        botId: string,
        command: UploadBotAvatarCommandV1,
      ) => uploadBotAvatar(env, userId, botId, command),
      readSheep: async (userId, botId) =>
        decodeSheepIdentityViewV1(
          rpcJsonSnapshot(
            await botStateStub(env, userId, botId).readSheep({
              schemaVersion: 1,
              userId,
              botId,
            }),
          ),
        ),
      executeConnection: (userId, command) =>
        userConfigurationStub(env, userId).executeConnection({
          schemaVersion: 1,
          userId,
          command,
        }),
      readMcpServers: async (userId) =>
        decodeMcpServerStatusViewV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).readMcpServers({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      executeMcpCommand: async (userId, command) =>
        decodeMcpLifecycleReceiptV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).executeMcpCommand({
              schemaVersion: 1,
              userId,
              command,
            }),
          ),
        ),
      lookupConnectionCommand: (userId, packageId, commandId) =>
        userConfigurationStub(env, userId).lookupConnectionCommand({
          schemaVersion: 1,
          userId,
          packageId,
          commandId,
        }),
      listCompositionGenerations: async (userId, botId, query) =>
        decodeCompositionGenerationListViewV1(
          await botStateStub(env, userId, botId).listCompositionGenerations({
            schemaVersion: 1,
            userId,
            botId,
            query,
          }),
        ),
      getCompositionGeneration: async (userId, botId, generationId) => {
        const generation = await botStateStub(
          env,
          userId,
          botId,
        ).getCompositionGeneration({
          schemaVersion: 1,
          userId,
          botId,
          generationId,
        });
        return generation === undefined
          ? undefined
          : decodeCompositionGenerationViewV1(generation);
      },
      listRoutines: async (userId, botId) =>
        decodeRoutineListViewV1(
          await botStateStub(env, userId, botId).listRoutines({
            schemaVersion: 1,
            userId,
            botId,
          }),
        ),
      executeRoutineCommand: async (userId, botId, command) =>
        decodeRoutineCommandReceiptV1(
          await botStateStub(env, userId, botId).executeRoutineCommand({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        ),
      // The secret the gateway verifies a presented webhook key against. It
      // never leaves the Worker; a Bot only ever sees a digest.
      ...(typeof env.ROUTINE_HOOK_SECRET === "string"
        ? { routineHookSecret: env.ROUTINE_HOOK_SECRET }
        : {}),
      deliverRoutineHook: async (userId, botId, delivery) =>
        botStateStub(env, userId, botId).deliverRoutineHook({
          schemaVersion: 1,
          userId,
          botId,
          delivery,
        }),
      listRoutineRuns: async (userId, botId, routineId) =>
        decodeRoutineRunListViewV1(
          await botStateStub(env, userId, botId).listRoutineRuns({
            schemaVersion: 1,
            userId,
            botId,
            routineId,
          }),
        ),
      readRoutineRun: async (userId, botId, routineId, runId) =>
        decodeRoutineRunDetailViewV1(
          await botStateStub(env, userId, botId).readRoutineRun({
            schemaVersion: 1,
            userId,
            botId,
            routineId,
            runId,
          }),
        ),
      listRoutineInbox: async (userId, botId) =>
        decodeRoutineInboxViewV1(
          await botStateStub(env, userId, botId).listRoutineInbox({
            schemaVersion: 1,
            userId,
            botId,
          }),
        ),
      executeRoutineInboxCommand: async (userId, botId, command) =>
        decodeRoutineInboxReceiptV1(
          await botStateStub(env, userId, botId).executeRoutineInboxCommand({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        ),
      revertComposition: async (userId, botId, command) =>
        decodeCompositionCommandReceiptV1(
          await botStateStub(env, userId, botId).revertComposition({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        ),
      updateSheep: async (userId, botId, command) =>
        decodeFlockReceiptV1(
          rpcJsonSnapshot(
            await botStateStub(env, userId, botId).updateSheep({
              schemaVersion: 1,
              userId,
              botId,
              command,
            }),
          ),
        ),
      read: (userId) =>
        userConfigurationStub(env, userId).readPackageRevisions({
          schemaVersion: 1,
          userId,
        }),
      rollback: (userId, command) =>
        userConfigurationStub(env, userId).rollbackPackage({
          schemaVersion: 1,
          userId,
          command,
        }),
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
      applicationHashFor: async (userId) =>
        (await userConfigurationStub(env, userId).activeApplicationHash({
          schemaVersion: 1,
          userId,
        })) ?? env.DEFAULT_APPLICATION_HASH,
      botStateFor: (userId) =>
        runtimeExports.UserBotState({ props: { userId } }),
      userConfigurationFor: (userId): UserConfigurationBinding =>
        userConfigurationStub(env, userId),
      botConfigurationFor: (userId, botId): BotConfigurationBinding =>
        botStateStub(env, userId, botId),
      ...(env.PACKAGE_CATALOG
        ? { catalog: new R2PackageCatalog(env.PACKAGE_CATALOG) }
        : {}),
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

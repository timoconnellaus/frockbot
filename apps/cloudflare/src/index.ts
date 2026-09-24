import { billingRoutes, type BillingAccountRpc } from "./billing.js";
import { decodeHostedModelRatesV1 } from "@frockbot/app/billing/rates";
import { WorkerEntrypoint } from "cloudflare:workers";
import { BOT_STATE_CHANNEL_INTERNAL_PATH } from "./bot-state-channel.js";
import {
  decodeMachineResultDeliveryV1,
  type MachineResultDeliveryV1,
} from "@frockbot/app/machine/delivery";
import type {
  AuthIdentityCandidateV1,
  AuthPackageIdentityStoreV1,
} from "@frockbot/core/contracts";
import { pluginPageKeyV1 } from "@frockbot/core/contracts";
import type { ClientSkillCatalogV1 } from "@frockbot/app/shell/skill-protocol";
import { GroupChat, GROUP_CHANNEL_INTERNAL_PATH } from "./group-chat.js";
import {
  groupChatObjectNameV1,
  unwrapGroupRpcV1,
  type GroupChatCommandV1,
  type GroupChatListV1,
  type GroupChatReceiptV1,
  type GroupChatViewV1,
  type GroupMessagePageV1,
  type GroupMessageV1,
  type GroupPostCommandV1,
  type GroupReadCommandV1,
  type GroupRetryCommandV1,
  type GroupStopCommandV1,
} from "@frockbot/app/groups/shared";
import { createFoundationBackendContributions } from "@frockbot/app/runtime";
import {
  decodeBotLifecycleDirectoryViewV1,
  decodeBotLifecycleReceiptV1,
  type BotLifecycleCommandV1,
  decodeBotMembershipViewV1,
  decodeDirectoryViewV1,
  decodeFlockBootstrapViewV1,
  type FlockBootstrapViewV1,
  decodeFlockReceiptV1,
  decodeAvatarIdentityViewV1,
  decodeVoiceIdentityViewV1,
  decodeLookIdentityViewV1,
  BotNotFoundError,
  decodeBotIdentityDirectoryViewV1,
  FLOCK_DIRECTORY_LIMIT,
  type BotIdentityDirectoryViewV1,
  type BotIdentityViewV1,
} from "@frockbot/app/flock/shared";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  type ClientRunLookupQueryV1,
  type ClientRunLookupV1,
  type ClientRunQuestionsV1,
  type ClientRunListQueryV1,
  type ClientRunListV1,
  type ClientRunStopCommandV1,
  type ClientRunStopReceiptV1,
} from "@frockbot/app/shell/run-protocol";
import {
  decodeBotNotificationDirectoryViewV1,
  decodeBotUnreadDirectoryViewV1,
  decodeBotUnreadReceiptV1,
  type BotNotificationDirectoryViewV1,
  type BotUnreadCommandV1,
  type BotUnreadDirectoryViewV1,
  type BotUnreadReceiptV1,
  type BotUnreadViewV1,
} from "@frockbot/app/shell/unread";
import {
  decodeApprovalDecisionCommandV1,
  decodeApprovalDecisionReceiptV1,
  decodeApprovalListViewV1,
  type ApprovalDecisionCommandV1,
  type ApprovalDecisionReceiptV1,
  type ApprovalListViewV1,
} from "@frockbot/app/shell/approvals";
import {
  decodeCardActionCommandV1,
  decodeCardActionReceiptV1,
  decodeCardListViewV1,
  decodeCardSurfaceIdV1,
  decodeCardViewV1,
  type CardActionCommandV1,
  type CardActionReceiptV1,
  type CardListViewV1,
  type CardViewV1,
} from "@frockbot/app/shell/cards";
import {
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationListViewV1,
  decodeCompositionGenerationViewV1,
  decodeBotIdV1,
  type BotSettingsViewV1,
} from "@frockbot/core/configuration";
import {
  decodeRoutineCommandReceiptV1,
  decodeRoutineInboxReceiptV1,
  decodeRoutineInboxViewV1,
  decodeRoutineListViewV1,
  decodeRoutineRunDetailViewV1,
  decodeRoutineRunListViewV1,
} from "@frockbot/app/routines/shared";
import {
  decodeComputerCommandResponse,
  decodeComputerProjectionV1,
  type ComputerCommandV1,
} from "@frockbot/computer/protocol";
import { ComputerBotNotFoundError } from "@frockbot/computer/backend";
import {
  decodeTaskListViewV1,
  decodeTaskViewV1,
} from "@frockbot/app/subagents/shared";
import {
  decodeMachineClaimReceiptV1,
  MachineTokenError,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineListViewV1,
  decodeMachinePairingOfferV1,
  decodeMachinePollResultV1,
  decodeMachineResultReceiptV1,
} from "@frockbot/core/machine-protocol";
import {
  decodeClientSearchRebuildReceiptV1,
  decodeSearchIndexResultsV1,
  type SearchQueryV1,
} from "@frockbot/app/search";
import {
  decodeAuditRebuildReceiptV1,
  decodeClientAuditPageV1,
  type AuditQueryV1,
} from "@frockbot/app/audit";
import {
  decodeTemplateImportListViewV1,
  decodeTemplateImportRecordV1,
  decodeTemplateShareListViewV1,
  decodeTemplateShareReceiptV1,
  type TemplateCommandV1,
} from "@frockbot/app/bot-template/shared";
import {
  parseTemplateShareIdV1,
  type TemplateVisibilityV1,
} from "@frockbot/core/template";
import {
  accessEmailV1,
  ADMISSION_REFUSAL_COPY_V1,
  decodeAccountAdmissionDecisionV1,
  type AccountAdmissionDecisionV1,
  type AdmissionIdentityV1,
  decodeUserFeaturesV1,
} from "@frockbot/app/admin/shared";
import { AUTH_PACKAGE_V1 } from "#auth-package";
import {
  createNativeAuth,
  NATIVE_RETURN_DEVELOPMENT,
  nativeReturnUris,
} from "./native-auth.js";
import {
  DEVELOPMENT_USER_ID,
  isDeploymentAdminV1,
} from "./admin-identities.js";
import type { DebugGatewaySurface } from "./debug.js";
import type { BotDebugQueryV1 } from "@frockbot/app/shell/debug-protocol";
import {
  BotState,
  frockAiWorkerVarV1,
  type OwnedBotTurnCommand,
} from "./bot-state.js";
import type {
  ApplicationArtifactStore,
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
import { getAgentByName } from "agents";
import {
  VOICE_ASSISTANT_DEVICE_HEADER,
  VOICE_ASSISTANT_INTERNAL_PATH,
  VOICE_ASSISTANT_USER_HEADER,
  VoiceAssistant,
  voiceAssistantConfiguredV1,
} from "./voice-assistant.js";
import {
  openVoiceDictationRelayV1,
  type VoiceDictationCleanupV1,
} from "./voice-dictation.js";
import { createFrockAiGatewayHostV1 } from "./frock-ai.js";
import { createHostedDictationCleanupJudgeV1 } from "@frockbot/app/supervision";
import { VOICE_DICTATION_CLEANUP_MODEL_V1 } from "@frockbot/app/voice/dictation-cleanup";
import { voiceDictationConfiguredV1 } from "@frockbot/app/voice/dictation-upstream";
import { voiceAssistantEdgeTimingOfV1 } from "@frockbot/app/voice/diagnostics";
import type { VoiceGatewayDependencies } from "./contracts.js";
import {
  decodeRpcEnvelopeV1,
  rpcBotId,
  rpcDecoded,
  rpcDecodedValue,
  rpcIdentifier,
  rpcJsonSnapshotV1,
  rpcObject,
  rpcBotTurnCommandOptionalsV1,
  rpcPattern,
  rpcString,
} from "./durable-rpc.js";
import { UserConfiguration } from "./user-configuration.js";
import {
  DEPLOYMENT_POLICY_SINGLETON_NAME,
  DeploymentPolicy,
} from "./deployment-policy.js";
import { ACCOUNT_ADMISSION_UNAVAILABLE_MESSAGE } from "./account-admission.js";
import { RoutineHookError } from "@frockbot/app/routines/hook";
import type { ConnectTriggerOfferV1 } from "@frockbot/app/connect/triggers";
import type { ConnectEventV1 } from "@frockbot/app/connect/events";

export { BotCapabilities } from "./bot-capabilities.js";
export { PluginEgress } from "./plugin-egress.js";
export { BotState, DeploymentPolicy, UserConfiguration };
// One object per Group Chat, `idFromName("<userId>:<groupId>")`.
export { GroupChat };
// Administration, reached only by the admin portal over a service binding
// (ADR 0028). No route in this Worker answers for it.
export { AdminEntrypoint } from "./admin-entrypoint.js";
// The account-wide voice session (docs/voice.md): the one Agents SDK object.
export { VoiceAssistant };

interface Env {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_MONTHLY_PRICE_ID?: string;
  FCM_SERVICE_ACCOUNT?: string;
  /** Explicit qualification gate; not enabled by the production configuration. */
  NATIVE_SLICE_2_AUTH?: string;
  USER_APPLICATIONS: WorkerLoader;
  // Bot-authored Package isolates, driven from the Bot Durable Object with
  // `globalOutbound` disabled (plan Step 4). A separate loader namespace from
  // USER_APPLICATIONS so the two never share an identity.
  BOT_PACKAGES: BotPackageLoader;
  APPLICATION_ARTIFACTS: R2Bucket;
  MEMORY_FILES: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  FROCK_AI_GATEWAY_ID?: string;
  FROCK_AI_AUTO_ROUTE?: string;
  /** Cloudflare account owning the AI Gateway; enables the compat transport. */
  FROCK_AI_ACCOUNT_ID?: string;
  /** `cf-aig-authorization` bearer for the authenticated AI Gateway. */
  FROCK_AI_GATEWAY_TOKEN?: string;
  // The pre-rename names. Each `FROCK_AI_*` setting falls back to its
  // `FLOCK_AI_*` twin so a deployment whose vars and secrets still carry the
  // old names keeps working; drop these once every environment is renamed.
  FLOCK_AI_GATEWAY_ID?: string;
  FLOCK_AI_AUTO_ROUTE?: string;
  FLOCK_AI_ACCOUNT_ID?: string;
  FLOCK_AI_GATEWAY_TOKEN?: string;
  BOT_STATES: DurableObjectNamespace<BotState>;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
  DEPLOYMENT_POLICY: DurableObjectNamespace<DeploymentPolicy>;
  /** One voice session object per User, `idFromName(userId)` (docs/voice.md). */
  VOICE_ASSISTANTS: DurableObjectNamespace<VoiceAssistant>;
  /** One object per Group Chat, `idFromName("<userId>:<groupId>")`. */
  GROUP_CHATS: DurableObjectNamespace<GroupChat>;
  /** The composer's dictation upstream. Absent closes dictation, visibly. */
  OPENAI_API_KEY?: string;
  /** The voice session itself: Gemini Live. Absent closes it, visibly. */
  GEMINI_API_KEY?: string;
  /** A local Live stand-in for the test harness; never set in production. */
  VOICE_ASSISTANT_UPSTREAM_URL?: string;
  VOICE_ASSISTANT_MODEL?: string;
  /**
   * The model that tidies a dictated transcript. Unset takes the ordinary
   * default route; a deployment that wants a cheap, fast model for a job that
   * is only ever "remove the ums" pins one here without a code change.
   */
  VOICE_DICTATION_CLEANUP_MODEL?: string;
  /** A local dictation stand-in for the test harness; never set in production. */
  VOICE_DICTATION_UPSTREAM_URL?: string;
  COMPUTER_HOST: Fetcher;
  /** Shared secret presented on every Computer host call. */
  COMPUTER_HOST_TOKEN?: string;
  /**
   * The plugin build service. It is handed source and returns artifacts; this
   * Worker keeps the R2 write and the hash verification, so the builder holds
   * no authority of its own.
   */
  APPLET_BUILD: Fetcher;
  /** Shared secret presented on every plugin build call. */
  APPLET_BUILD_TOKEN?: string;
  /**
   * The identity store, on a build whose auth Package has one. The Access
   * Package stores nothing and its deployment binds no database, which is why
   * this is optional — and why nothing outside the Package reads it.
   */
  AUTH_DB?: D1Database;
  DEFAULT_APPLICATION_HASH: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** The Zero Trust team whose keys sign every Cloudflare Access token. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag. */
  ACCESS_AUD?: string;
  /** The native door's signing key on the Access build; see `AUTH_PACKAGE_V1`. */
  NATIVE_TOKEN_SECRET?: string;
  CREDENTIAL_KEYRING?: string;
  /** Signs every Routine webhook key. Absent closes the webhook door. */
  ROUTINE_HOOK_SECRET?: string;
  /** The Connected apps provider key. Absent, no app can be connected. */
  COMPOSIO_API_KEY?: string;
  /**
   * HMAC secret for Connected-app event deliveries. Absent closes the
   * deployment-wide events door.
   */
  COMPOSIO_WEBHOOK_SECRET?: string;
  /**
   * Signs every machine token and pairing code. Absent closes the registered
   * machine door: pairing, enrollment and every machine route answer 503
   * rather than admitting a caller nothing could verify.
   */
  MACHINE_TOKEN_SECRET?: string;
  /**
   * Signs the callback `state` of every redirect-based Connection. Absent — or
   * weak, or equal to `BETTER_AUTH_SECRET` — closes that door: the routes
   * answer 503 rather than trusting a forgeable identity.
   */
  ALLOW_DEVELOPMENT_AUTH?: string;
  FROCKBOT_ADMIN_EMAILS?: string;
  ALLOWED_CLIENT_ORIGINS?: string;
  /** Authorizes `/api/debug/*`. Absent disables the surface entirely. */
  DEBUG_TOKEN?: string;
  /**
   * The hosted Jev credential: Turn supervision, the routine-event rejector,
   * and dictation tidy review. Absent, those choosers are unavailable.
   */
  JEV_API_KEY?: string;
}

/**
 * The identity store of the sign-in Package this build deploys.
 *
 * Admission and the operator surface read the durable identity rather than the
 * User id a caller presented, and which store that is belongs to the Package —
 * the better-auth build's D1 `user` table, or, on the Access build, none at
 * all. Constructed per lookup because both reads are a single query and neither
 * needs sign-in itself to be configured.
 */
function authIdentitiesV1(env: Env): AuthPackageIdentityStoreV1 {
  return AUTH_PACKAGE_V1.create(env);
}

/** The User Durable Object's account features, addressed by User. */
function userFeaturesStub(
  env: Env,
  userId: string,
): {
  readFeatures(input: unknown): Promise<unknown>;
  setFeatures(input: unknown): Promise<unknown>;
} {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its generated account features RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as {
    readFeatures(input: unknown): Promise<unknown>;
    setFeatures(input: unknown): Promise<unknown>;
  };
}

/**
 * The `/api/debug` surface, over the same durable records and identity store
 * the gateway already holds. Without `DEBUG_TOKEN` it carries no token, and
 * the routes 404.
 */
function debugSurface(env: Env): DebugGatewaySurface {
  return {
    ...(env.DEBUG_TOKEN ? { token: env.DEBUG_TOKEN } : {}),
    // A build whose auth Package stores no identity lists none: there is no
    // roll of accounts to read, because Access re-establishes who a person is
    // on every request. Every other route still answers for a User id the
    // operator already has.
    listUsers: async () =>
      (await authIdentitiesV1(env).listStoredIdentities?.(50)) ?? [],
    listBots: (userId) =>
      userConfigurationStub(env, userId).listBots({ schemaVersion: 1, userId }),
    snapshot: (userId, botId, query) =>
      botStateStub(env, userId, botId).debugSnapshot(query),
    voice: async (userId) =>
      (await getAgentByName(env.VOICE_ASSISTANTS, userId)).debugSnapshot(),
    isAdminUser: async (userId) => {
      // The auth Package's store is the durable identity source. The path's
      // User id is never trusted on its own: it must resolve to a stored email,
      // and that identity is evaluated by the same allowlist policy as the
      // signed-in gateway. A Package that stores nothing resolves nothing, so
      // the one write on this surface is refused rather than granted on the
      // strength of a User id somebody typed.
      const identity = await authIdentitiesV1(env).storedIdentity?.(userId);
      return (
        identity != null &&
        isDeploymentAdminV1(
          { id: identity.id, email: identity.email, mode: "better-auth" },
          env.FROCKBOT_ADMIN_EMAILS,
        )
      );
    },
    setAccountFeatures: async (userId, command) =>
      decodeUserFeaturesV1(
        rpcJsonSnapshotV1(
          await userFeaturesStub(env, userId).setFeatures({
            schemaVersion: 1,
            userId,
            command,
            updatedBy: "operator",
          }),
        ),
      ),
  };
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
  deliverConnectEvent(request: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    routineId: string;
    eventId: string;
    payload?: unknown;
  }): Promise<
    | { status: "accepted" | "duplicate"; fireId: string }
    | { status: "dropped"; reason: string }
  >;
  readComputerPresence(): Promise<unknown>;
  readComputerFrame(
    contentHash: string,
  ): Promise<{ bytesBase64: string } | null>;
  executeComputerPresenceCommand(command: ComputerCommandV1): Promise<unknown>;
  run(command: OwnedBotTurnCommand): Promise<BotTurnResult>;
  admitRun(
    command: OwnedBotTurnCommand,
  ): Promise<{ schemaVersion: 1; runId: string }>;
  listRuns(query: ClientRunListQueryV1): Promise<ClientRunListV1>;
  debugSnapshot(query: BotDebugQueryV1): Promise<unknown>;
  lookupRun(query: ClientRunLookupQueryV1): Promise<ClientRunLookupV1>;
  runQuestions(query: ClientRunLookupQueryV1): Promise<ClientRunQuestionsV1>;
  fenceRunAdmission(query: ClientRunLookupQueryV1): Promise<ClientRunLookupV1>;
  listSkills(): Promise<ClientSkillCatalogV1>;
  readWorkspaceFileV1(path: unknown): Promise<ClientWorkspaceFileV1>;
  listNotifications(): Promise<BotNotificationIntent[]>;
  acknowledgeNotification(notificationId: string): Promise<void>;
  listApprovals(): Promise<ApprovalListViewV1>;
  decideApproval(
    approvalId: string,
    command: ApprovalDecisionCommandV1,
  ): Promise<ApprovalDecisionReceiptV1>;
  listCards(): Promise<CardListViewV1>;
  readCard(surfaceId: string): Promise<CardViewV1>;
  cardAction(command: CardActionCommandV1): Promise<CardActionReceiptV1>;
  readUnread(): Promise<BotUnreadViewV1>;
  executeUnreadCommand(
    command: BotUnreadCommandV1,
  ): Promise<BotUnreadReceiptV1>;
  stopRun(command: ClientRunStopCommandV1): Promise<ClientRunStopReceiptV1>;
}

/**
 * The User Durable Object's RPC surface as this Worker uses it: the binding the
 * gateway shares, plus this adapter's own seams.
 */
interface UserConfigurationRpc extends UserConfigurationBinding {
  readFlockBootstrap(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<FlockBootstrapViewV1>;
  listConnectTriggers(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<ConnectTriggerOfferV1[]>;
  handleConnectEvent(request: {
    schemaVersion: 1;
    userId: string;
    event: ConnectEventV1;
  }): Promise<{ status: "accepted" | "ignored"; fireId?: string }>;
}

type RpcBoundary<T> = {
  [Key in keyof T]: T[Key] extends (...args: never[]) => infer Result
    ? (input: unknown) => Result
    : never;
};

function botTurnRpcV1(command: OwnedBotTurnCommand) {
  return {
    schemaVersion: 1 as const,
    userId: command.userId,
    botId: command.botId,
    command: {
      runId: command.runId,
      sessionId: command.sessionId,
      acceptedAt: command.acceptedAt,
      text: command.text,
      ...(command.retryOf ? { retryOf: command.retryOf } : {}),
      ...(command.skills ? { skills: command.skills } : {}),
    },
  };
}

function botStateStub(env: Env, userId: string, botId: string): BotStateRpc {
  // The one place a Bot Durable Object is named, and therefore the one place
  // the name has to be beyond doubt. A Subagent Durable Object is the same
  // class in this namespace under `<userId>:<botId>#task:<taskId>`, so a `#`
  // reaching here from a path segment would let a caller name an object the
  // directory never minted. `decodeBotIdV1` rejects it — this
  // restates the check where the id becomes an object rather than trusting
  // that every route above remembered to.
  const id = env.BOT_STATES.idFromName(
    `${userId}:${decodeBotIdV1(botId, "bot id")}`,
  );
  // SAFETY: Wrangler binds BOT_STATES to BotState; workers-types cannot infer its generated RPC surface.
  const rpc = env.BOT_STATES.get(id) as unknown as RpcBoundary<BotStateRpc>;
  return {
    readComputerPresence: () =>
      rpc.readComputerPresence({ schemaVersion: 1, userId, botId }),
    readComputerFrame: (contentHash) =>
      rpc.readComputerFrame({ schemaVersion: 1, userId, botId, contentHash }),
    executeComputerPresenceCommand: (command) =>
      rpc.executeComputerPresenceCommand({
        schemaVersion: 1,
        userId,
        botId,
        command,
      }),
    readAvatar: (request) => rpc.readAvatar(request),
    updateAvatar: (request) => rpc.updateAvatar(request),
    readVoice: (request) => rpc.readVoice(request),
    updateVoice: (request) => rpc.updateVoice(request),
    readLook: (request) => rpc.readLook(request),
    updateLook: (request) => rpc.updateLook(request),
    persistAssembledDocument: (request) =>
      rpc.persistAssembledDocument(request),
    readConfiguration: (request) => rpc.readConfiguration(request),
    executeConfiguration: (request) => rpc.executeConfiguration(request),
    readBotPluginsFrame: (request) => rpc.readBotPluginsFrame(request),
    setBotPluginEnabled: (request) => rpc.setBotPluginEnabled(request),
    executeBotPluginTool: (request) => rpc.executeBotPluginTool(request),
    openFocusedPanel: (request) => rpc.openFocusedPanel(request),
    setFocusedPanel: (request) => rpc.setFocusedPanel(request),
    recordPanelDeviceUse: (request) => rpc.recordPanelDeviceUse(request),
    listRoutines: (request) => rpc.listRoutines(request),
    readRoutinesFrame: (request) => rpc.readRoutinesFrame(request),
    listTasks: (request) => rpc.listTasks(request),
    readTask: (request) => rpc.readTask(request),
    stopTask: (request) => rpc.stopTask(request),
    executeRoutineCommand: (request) => rpc.executeRoutineCommand(request),
    listRoutineRuns: (request) => rpc.listRoutineRuns(request),
    deliverRoutineHook: (request) => rpc.deliverRoutineHook(request),
    deliverConnectEvent: (request) => rpc.deliverConnectEvent(request),
    deliverMachineResult: (request) => rpc.deliverMachineResult(request),
    readRoutineRun: (request) => rpc.readRoutineRun(request),
    listRoutineInbox: (request) => rpc.listRoutineInbox(request),
    executeRoutineInboxCommand: (request) =>
      rpc.executeRoutineInboxCommand(request),
    listCompositionGenerations: (request) =>
      rpc.listCompositionGenerations(request),
    getCompositionGeneration: (request) =>
      rpc.getCompositionGeneration(request),
    revertComposition: (request) => rpc.revertComposition(request),
    run: (command) => rpc.run(botTurnRpcV1(command)),
    admitRun: (command) => rpc.admitRun(botTurnRpcV1(command)),
    listRuns: (query) =>
      rpc.listRuns({ schemaVersion: 1, userId, botId, query }),
    debugSnapshot: (query) =>
      rpc.debugSnapshot({ schemaVersion: 1, userId, botId, query }),
    lookupRun: (query) =>
      rpc.lookupRun({ schemaVersion: 1, userId, botId, query }),
    runQuestions: (query) =>
      rpc.runQuestions({ schemaVersion: 1, userId, botId, query }),
    fenceRunAdmission: (query) =>
      rpc.fenceRunAdmission({ schemaVersion: 1, userId, botId, query }),
    listSkills: () => rpc.listSkills({ schemaVersion: 1, userId, botId }),
    readWorkspaceFileV1: (path) =>
      rpc.readWorkspaceFileV1({ schemaVersion: 1, userId, botId, path }),
    listNotifications: () =>
      rpc.listNotifications({ schemaVersion: 1, userId, botId }),
    listApprovals: () => rpc.listApprovals({ schemaVersion: 1, userId, botId }),
    decideApproval: (approvalId, command) =>
      rpc.decideApproval({
        schemaVersion: 1,
        userId,
        botId,
        approvalId,
        command,
      }),
    listCards: () => rpc.listCards({ schemaVersion: 1, userId, botId }),
    readCard: (surfaceId) =>
      rpc.readCard({ schemaVersion: 1, userId, botId, surfaceId }),
    cardAction: (command) =>
      rpc.cardAction({ schemaVersion: 1, userId, botId, command }),
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
    stopRun: (command) =>
      rpc.stopRun({ schemaVersion: 1, userId, botId, command }),
  };
}

function botStateObject(
  env: Env,
  userId: string,
  botId: string,
): DurableObjectStub {
  const id = env.BOT_STATES.idFromName(
    `${userId}:${decodeBotIdV1(botId, "bot id")}`,
  );
  return env.BOT_STATES.get(id);
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
    readFlockBootstrap: (request) => rpc.readFlockBootstrap(request),
    executeBotLifecycle: (request) => rpc.executeBotLifecycle(request),
    createBot: (request) => rpc.createBot(request),
    updateBotAvatar: (request) => rpc.updateBotAvatar(request),
    readBotVoice: (request) => rpc.readBotVoice(request),
    updateBotVoice: (request) => rpc.updateBotVoice(request),
    readBotLook: (request) => rpc.readBotLook(request),
    updateBotLook: (request) => rpc.updateBotLook(request),
    mirrorBotLook: (request) => rpc.mirrorBotLook(request),
    getBotRegistration: (request) => rpc.getBotRegistration(request),
    hasBot: (request) => rpc.hasBot(request),
    readConnectionsFrame: (request) => rpc.readConnectionsFrame(request),
    readSettingsFrame: (request) => rpc.readSettingsFrame(request),
    readSettingsOptions: (request) => rpc.readSettingsOptions(request),
    changeSettings: (request) => rpc.changeSettings(request),
    readConfiguration: (request) =>
      rpc.readConfiguration({ ...request, view: request.view ?? 2 }),
    executeConfiguration: (request) => rpc.executeConfiguration(request),
    executeConnection: (request) => rpc.executeConnection(request),
    listConnectTriggers: (request) => rpc.listConnectTriggers(request),
    handleConnectEvent: (request) => rpc.handleConnectEvent(request),
    lookupConnectionCommand: (request) => rpc.lookupConnectionCommand(request),
    getConnection: (request) => rpc.getConnection(request),
    leaseModelCredential: (request) => rpc.leaseModelCredential(request),
    settleModelCredential: (request) => rpc.settleModelCredential(request),
    listTemplateShares: (request) => rpc.listTemplateShares(request),
    executeTemplateCommand: (request) => rpc.executeTemplateCommand(request),
    resolveTemplateShare: (request) => rpc.resolveTemplateShare(request),
    listTemplateImports: (request) => rpc.listTemplateImports(request),
    executeTemplateImport: (request) => rpc.executeTemplateImport(request),
  };
}

interface DeploymentPolicyRpc {
  readPolicy(input: unknown): Promise<unknown>;
  setAdmissionMode(input: unknown): Promise<unknown>;
  readAccountAccess(input: unknown): Promise<unknown>;
  setAccountAccess(input: unknown): Promise<unknown>;
  inviteEmail(input: unknown): Promise<unknown>;
  admitAccount(input: unknown): Promise<unknown>;
  checkAccount(input: unknown): Promise<unknown>;
  mayCreateIdentity(input: unknown): Promise<unknown>;
  readModelRates(input: unknown): Promise<unknown>;
}

function deploymentPolicyStub(env: Env): DeploymentPolicyRpc {
  return env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  ) as unknown as DeploymentPolicyRpc;
}

/**
 * Every identity this build's sign-in Package produced is admitted.
 *
 * Cloudflare Access admits nobody the deployment's own policy did not, so on
 * that build the policy *is* the allowlist: there is no authority to ask, no
 * access record to read and no admission UI to show (ADR 0028). The hosted
 * build's Package answers `authority` and nothing here applies to it.
 */
const AUTH_PACKAGE_DECIDES_ADMISSION_V1 =
  AUTH_PACKAGE_V1.admission === "package";
const ADMITTED_BY_AUTH_PACKAGE_V1: AccountAdmissionDecisionV1 = {
  schemaVersion: 1,
  admitted: true,
  // The deployment is open to everyone its sign-in policy let through, which
  // is what `open` says. No account is activated, because none is recorded.
  basis: "open",
};

/**
 * The one door into the beta-access authority for browser and native alike.
 * An admin is answered here, without the authority, so a deployment whose
 * authority is unreachable still lets its admins in to see why.
 */
async function admitAccount(
  env: Env,
  identity: AdmissionIdentityV1,
): Promise<AccountAdmissionDecisionV1> {
  if (identity.isAdmin) {
    return { schemaVersion: 1, admitted: true, basis: "admin" };
  }
  if (AUTH_PACKAGE_DECIDES_ADMISSION_V1) return ADMITTED_BY_AUTH_PACKAGE_V1;
  return decodeAccountAdmissionDecisionV1(
    rpcJsonSnapshotV1(await deploymentPolicyStub(env).admitAccount(identity)),
  );
}

async function storedAdmissionIdentity(
  env: Env,
  userId: string,
): Promise<AdmissionIdentityV1 | null> {
  const identity = await authIdentitiesV1(env).storedIdentity?.(userId);
  if (!identity) return null;
  const email = accessEmailV1(identity.email);
  return {
    schemaVersion: 1,
    userId,
    ...(email === undefined ? {} : { email }),
    emailVerified: identity.emailVerified,
    isAdmin: isDeploymentAdminV1(
      { id: identity.id, email: identity.email, mode: "better-auth" },
      env.FROCKBOT_ADMIN_EMAILS,
    ),
  };
}

async function admitStoredAccount(
  env: Env,
  userId: string,
): Promise<AccountAdmissionDecisionV1 | null> {
  if (AUTH_PACKAGE_DECIDES_ADMISSION_V1) return ADMITTED_BY_AUTH_PACKAGE_V1;
  const identity = await storedAdmissionIdentity(env, userId);
  return identity ? admitAccount(env, identity) : null;
}

async function checkStoredAccount(
  env: Env,
  userId: string,
): Promise<AccountAdmissionDecisionV1 | null> {
  if (AUTH_PACKAGE_DECIDES_ADMISSION_V1) return ADMITTED_BY_AUTH_PACKAGE_V1;
  const identity = await storedAdmissionIdentity(env, userId);
  if (!identity) return null;
  if (identity.isAdmin) {
    return { schemaVersion: 1, admitted: true, basis: "admin" };
  }
  return decodeAccountAdmissionDecisionV1(
    rpcJsonSnapshotV1(await deploymentPolicyStub(env).checkAccount(identity)),
  );
}

async function externalAccountRefusal(
  env: Env,
  userId: string,
): Promise<{ status: number; message: string } | undefined> {
  if (developmentAuthAllowed(env)) return;
  let decision;
  try {
    decision = await checkStoredAccount(env, userId);
  } catch {
    return { status: 503, message: ACCOUNT_ADMISSION_UNAVAILABLE_MESSAGE };
  }
  if (!decision)
    return { status: 401, message: "Account identity is unavailable" };
  if (!decision.admitted) {
    return {
      status: 403,
      message: ADMISSION_REFUSAL_COPY_V1[decision.reason].title,
    };
  }
}

/**
 * Whether better-auth may write a new identity. The same authority as
 * admission, asked earlier; admins bypass it, and all other candidates must
 * satisfy the identity-creation rule in `account-admission.ts`.
 */
async function mayCreateIdentity(
  env: Env,
  candidate: AuthIdentityCandidateV1,
): Promise<boolean> {
  const email = accessEmailV1(candidate.email);
  if (email === undefined) return false;
  if (
    isDeploymentAdminV1(
      { id: email, email, mode: "better-auth" },
      env.FROCKBOT_ADMIN_EMAILS,
    )
  ) {
    return true;
  }
  return (
    (await deploymentPolicyStub(env).mayCreateIdentity({
      schemaVersion: 1,
      email,
      emailVerified: candidate.emailVerified,
      isAdmin: false,
    })) === true
  );
}

function developmentAuthAllowed(env: Env): boolean {
  return env.ALLOW_DEVELOPMENT_AUTH === "true";
}

/**
 * Where the app may be sent back after sign-in: this deployment's App Links,
 * plus the development scheme on a stack that allows development auth — the flag
 * production's secret gate refuses.
 */
function nativeReturnUrisFor(env: Env, origin: string): readonly string[] {
  return [
    ...nativeReturnUris(env.NATIVE_SLICE_2_AUTH, origin),
    ...(developmentAuthAllowed(env) ? [NATIVE_RETURN_DEVELOPMENT] : []),
  ];
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

/**
 * The User Durable Object's registered-machine RPCs.
 *
 * Narrow and separate from `UserConfigurationBinding` for the same reason the
 * transcript index's are: the registry is one Package's Contribution, and the
 * generic configuration binding every gateway adapter implements has no
 * business growing a method for somebody's laptop.
 */
interface UserMachineRpc {
  createMachinePairing(input: unknown): Promise<unknown>;
  enrollMachine(input: unknown): Promise<unknown>;
  pollMachine(input: unknown): Promise<unknown>;
  claimMachineCommand(input: unknown): Promise<unknown>;
  recordMachineResult(input: unknown): Promise<unknown>;
  takeMachineDeliveries(input: unknown): Promise<unknown>;
  listMachines(input: unknown): Promise<unknown>;
  revokeMachine(input: unknown): Promise<unknown>;
}

/**
 * Drain a User's finished machine commands into the Bots that asked for them.
 *
 * Best effort by construction. The result is already durable and
 * `machine_command_check` reads it in full, so a Bot that has since been
 * deleted — or one that cannot be reached this second — costs a preamble line
 * and no fact, and must never fail the machine's own POST.
 */
async function deliverMachineResults(env: Env, userId: string): Promise<void> {
  let deliveries: MachineResultDeliveryV1[];
  try {
    deliveries = (
      (await userMachineStub(env, userId).takeMachineDeliveries({
        schemaVersion: 1,
        userId,
      })) as unknown[]
    ).map((value) => decodeMachineResultDeliveryV1(value));
  } catch {
    return;
  }
  for (const delivery of deliveries) {
    try {
      await botStateStub(env, userId, delivery.botId).deliverMachineResult({
        schemaVersion: 1,
        userId,
        botId: delivery.botId,
        delivery,
      });
    } catch {
      // See above: the durable answer is already recorded.
    }
  }
}

function userMachineStub(env: Env, userId: string): UserMachineRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its RPC surface.
  const rpc = env.USER_CONFIGURATIONS.get(id) as unknown as UserMachineRpc;
  return rpc;
}

/**
 * The User Durable Object's audit RPCs. Narrow and separate for the same
 * reason the transcript index's are.
 */
interface UserAuditRpc {
  readAuditEntries(input: unknown): Promise<unknown>;
  rebuildAuditIndex(input: unknown): Promise<unknown>;
}

function userAuditStub(env: Env, userId: string): UserAuditRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its generated Audit RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as UserAuditRpc;
}

function userSearchStub(env: Env, userId: string): UserSearchRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its generated Search RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as UserSearchRpc;
}

function decodeUserBotTurnRpcV1(input: unknown) {
  return decodeRpcEnvelopeV1(input, {
    botId: rpcBotId,
    command: rpcObject(
      {
        runId: rpcIdentifier,
        sessionId: rpcString(257),
        acceptedAt: rpcString(64),
        text: rpcString(100_000),
      },
      // The same optional members the Bot Durable Object's door accepts, so
      // nothing the composer sends is refused one door earlier.
      rpcBotTurnCommandOptionalsV1,
    ),
  });
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
    const request = decodeUserBotTurnRpcV1(input);
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

  async admitRun(input: unknown): Promise<{ schemaVersion: 1; runId: string }> {
    const request = decodeUserBotTurnRpcV1(input);
    const command = request.command as BotTurnCommand;
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).admitRun({
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

  async runQuestions(input: unknown): Promise<ClientRunQuestionsV1> {
    const request = decodeUserBotRunLookupRpcV1(input);
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId,
    ).runQuestions(request.query);
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

  /**
   * The Bot's approvals. Decoded at the seam, like every other read that
   * crosses from a Durable Object into the gateway.
   */
  async listApprovals(input: unknown): Promise<ApprovalListViewV1> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    return decodeApprovalListViewV1(
      await botStateStub(
        this.env,
        this.ctx.props.userId,
        request.botId as string,
      ).listApprovals(),
    );
  }

  /** One decision, recorded durably before this answers. */
  async decideApproval(input: unknown): Promise<ApprovalDecisionReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      approvalId: rpcIdentifier,
      command: rpcDecoded(decodeApprovalDecisionCommandV1),
    });
    return decodeApprovalDecisionReceiptV1(
      await botStateStub(
        this.env,
        this.ctx.props.userId,
        request.botId as string,
      ).decideApproval(
        request.approvalId as string,
        request.command as ApprovalDecisionCommandV1,
      ),
    );
  }

  /** The Bot's Cards, decoded at the seam like every other crossing read. */
  async listCards(input: unknown): Promise<CardListViewV1> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    return decodeCardListViewV1(
      await botStateStub(
        this.env,
        this.ctx.props.userId,
        request.botId as string,
      ).listCards(),
    );
  }

  /** One Card by its id, for a surface the listing's byte budget left out. */
  async readCard(input: unknown): Promise<CardViewV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      surfaceId: rpcDecoded(decodeCardSurfaceIdV1),
    });
    return decodeCardViewV1(
      await botStateStub(
        this.env,
        this.ctx.props.userId,
        request.botId as string,
      ).readCard(request.surfaceId as string),
    );
  }

  /** One action on one Card, routed by the kernel before this answers. */
  async cardAction(input: unknown): Promise<CardActionReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      command: rpcDecoded(decodeCardActionCommandV1),
    });
    return decodeCardActionReceiptV1(
      await botStateStub(
        this.env,
        this.ctx.props.userId,
        request.botId as string,
      ).cardAction(request.command as CardActionCommandV1),
    );
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

  async loadPluginPage(contentHash: string): Promise<string | undefined> {
    const object = await this.bucket.get(pluginPageKeyV1(contentHash));
    return object ? object.text() : undefined;
  }
}

/**
 * Projects one Bot's durable settings onto the Flock identity DTO. The Bot
 * Durable Object stays the authority: this is a read-through view, so the
 * immutable registration seed never has to carry mutable identity.
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
    ...(profile.label === undefined ? {} : { label: profile.label }),
    ...(profile.title === undefined ? {} : { title: profile.title }),
    ...(profile.pinnedAt === undefined ? {} : { pinnedAt: profile.pinnedAt }),
    ...(profile.sidebarOrder === undefined
      ? {}
      : { sidebarOrder: profile.sidebarOrder }),
  };
}

async function listBotIdentities(
  env: Env,
  userId: string,
): Promise<BotIdentityDirectoryViewV1> {
  const directory = decodeDirectoryViewV1(
    rpcJsonSnapshotV1(
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
      .then((value) => decodeDirectoryViewV1(rpcJsonSnapshotV1(value))),
    userConfigurationStub(env, userId)
      .listBotLifecycles({ schemaVersion: 1, userId })
      .then((value) =>
        decodeBotLifecycleDirectoryViewV1(rpcJsonSnapshotV1(value)),
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
        .then((value) => rpcJsonSnapshotV1(value)),
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
          ...rpcJsonSnapshotV1(intent),
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
    rpcJsonSnapshotV1(
      await userConfigurationStub(env, userId).hasBot({
        schemaVersion: 1,
        userId,
        botId,
      }),
    ),
  );
  if (!membership.registered) throw new BotNotFoundError(botId);
  return decodeBotUnreadReceiptV1(
    rpcJsonSnapshotV1(
      await botStateStub(env, userId, botId).executeUnreadCommand(command),
    ),
  );
}

/**
 * Proves User-to-Bot membership before the Bot Durable Object is named.
 * Unknown and foreign Bots therefore share one 404 and cannot cause even an
 * empty Bot object — or a Computer intent within one — to be created.
 */
async function ownedComputerBotState(
  env: Env,
  userId: string,
  botId: string,
): Promise<BotStateRpc> {
  const membership = decodeBotMembershipViewV1(
    rpcJsonSnapshotV1(
      await userConfigurationStub(env, userId).hasBot({
        schemaVersion: 1,
        userId,
        botId,
      }),
    ),
  );
  if (!membership.registered) throw new ComputerBotNotFoundError(botId);
  return botStateStub(env, userId, botId);
}

function voiceAssistantStub(env: Env, userId: string) {
  return env.VOICE_ASSISTANTS.get(env.VOICE_ASSISTANTS.idFromName(userId));
}

/**
 * The tidy-up the dictation relay offers a finished capture.
 *
 * Two jobs and no judgement: book the spend against the account's own voice
 * object, then reach the model gateway with the deployment's credential. What
 * is asked for and what is accepted back belong to the relay, which is where
 * they can be tested without a model.
 *
 * Absent — and so no tidying at all — in a deployment with no usable `AI`
 * binding. A draft that keeps the ums is a working draft.
 */
function voiceDictationCleanup(
  env: Env,
  userId: string,
): VoiceDictationCleanupV1 | undefined {
  const ai = env.AI;
  if (!ai || typeof Reflect.get(ai, "gateway") !== "function") return undefined;
  return {
    run: async (body, signal) => {
      const stub = await getAgentByName(env.VOICE_ASSISTANTS, userId);
      const booked = await stub.dictationLease({
        schemaVersion: 1,
        userId,
        // The lease id is this booking's, not the capture's: nothing is held
        // and nothing is released, so it only has to satisfy the decoder.
        leaseId: crypto.randomUUID(),
        action: "cleanup",
      });
      if (booked.status !== "cleanup" || !booked.admitted) return undefined;
      const host = createFrockAiGatewayHostV1(ai as Pick<Ai, "gateway">, {
        gatewayId: frockAiWorkerVarV1(env, "FROCK_AI_GATEWAY_ID"),
        autoRoute: frockAiWorkerVarV1(env, "FROCK_AI_AUTO_ROUTE"),
        accountId: frockAiWorkerVarV1(env, "FROCK_AI_ACCOUNT_ID"),
        token: frockAiWorkerVarV1(env, "FROCK_AI_GATEWAY_TOKEN"),
      });
      const model =
        env.VOICE_DICTATION_CLEANUP_MODEL?.trim() ||
        VOICE_DICTATION_CLEANUP_MODEL_V1;
      const stream = await host.runChatCompletion(model, body, signal);
      return voiceDictationCleanupAnswerV1(await new Response(stream).text());
    },
  };
}

/**
 * The assistant's message out of one unstreamed chat completion.
 *
 * Returns the empty string for a body that is not the shape we asked for,
 * which every guard downstream reads as "nothing came back" and answers by
 * keeping the raw transcript. A malformed answer must never be a thrown
 * error here: it is an ordinary outcome of asking a model for text.
 */
export function voiceDictationCleanupAnswerV1(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}

/** The voice doors the gateway opens once it has proved the identity. */
function voiceGatewayDependencies(env: Env): VoiceGatewayDependencies {
  return {
    capabilities: () => ({
      dictation: voiceDictationConfiguredV1(env),
      assistant: voiceAssistantConfiguredV1(env),
    }),
    openDictation: async (userId, request) => {
      // The account's voice object holds the dictation lease: one capture
      // at a time and a booked window of seconds, decided before the provider
      // is opened. RPC goes through the Agent lifecycle; the assistant
      // socket below does not, so a cold start is paid once on the 101.
      const stub = await getAgentByName(env.VOICE_ASSISTANTS, userId);
      const leaseId = crypto.randomUUID();
      const call = (input: Record<string, unknown>) =>
        stub.dictationLease({ schemaVersion: 1, userId, leaseId, ...input });
      return openVoiceDictationRelayV1(request, {
        env,
        cleanup: voiceDictationCleanup(env, userId),
        cleanupJudge: createHostedDictationCleanupJudgeV1({
          JEV_API_KEY: env.JEV_API_KEY,
        }),
        lease: {
          acquire: async () => {
            const answer = await call({ action: "acquire" });
            return answer.status === "acquired"
              ? { status: "acquired" }
              : {
                  status: "refused",
                  reason:
                    answer.status === "refused"
                      ? answer.reason
                      : "Dictation is unavailable right now.",
                };
          },
          renew: async () => {
            const answer = await call({ action: "renew" });
            return answer.status === "renewed" && answer.ok;
          },
          release: async (activeSeconds) => {
            await call({ action: "release", activeSeconds });
          },
        },
      });
    },
    openAssistant: async (userId, deviceKey, request, context) => {
      const incoming = new URL(request.url);
      const internal = new URL(
        `${VOICE_ASSISTANT_INTERNAL_PATH}${incoming.search}`,
        "https://voice-assistant.internal",
      );
      const headers = new Headers(request.headers);
      headers.delete(VOICE_ASSISTANT_USER_HEADER);
      headers.set(VOICE_ASSISTANT_USER_HEADER, userId);
      headers.set(VOICE_ASSISTANT_DEVICE_HEADER, deviceKey);
      headers.set("x-frockbot-auth-session-v1", context.authMode);
      headers.set("x-frockbot-is-admin-v1", String(context.isAdmin));
      // Named for the User and reached only through this door: there is no
      // `/agents/*` route, so an object nobody signed in as is never opened.
      // `getAgentByName` waits for `onStart` before returning the stub, which
      // would hold the 101 until ledger recovery finished. The fetch itself
      // starts the Agent; recovery runs in that same invocation.
      return voiceAssistantStub(env, userId).fetch(
        new Request(internal, { method: "GET", headers }),
      );
    },
  };
}

async function openOwnedBotStateChannel(
  env: Env,
  userId: string,
  botId: string,
  request: Request,
  context: { isAdmin: boolean; authMode: string },
): Promise<Response> {
  // Prove directory membership before naming the object, exactly like every
  // Computer read and command route.
  await ownedComputerBotState(env, userId, botId);
  const incoming = new URL(request.url);
  const internal = new URL(
    `${BOT_STATE_CHANNEL_INTERNAL_PATH}${incoming.search}`,
    "https://bot-state.internal",
  );
  const headers = new Headers(request.headers);
  headers.delete("x-frockbot-user-id");
  headers.delete("x-frockbot-bot-id");
  headers.set("x-frockbot-user-id", userId);
  headers.set("x-frockbot-bot-id", botId);
  headers.set("x-frockbot-auth-session-v1", context.authMode);
  headers.set("x-frockbot-is-admin-v1", String(context.isAdmin));
  return botStateObject(env, userId, botId).fetch(
    new Request(internal, { method: "GET", headers }),
  );
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
  const found = rpcJsonSnapshotV1(answered);
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

/** The User object's Group Chat doors; each answers a value, never a class. */
function groupChatUser(env: Env, userId: string) {
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration.
  return env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  ) as unknown as {
    listGroupChats(input: unknown): Promise<unknown>;
    executeGroupChatCommand(input: unknown): Promise<unknown>;
  };
}

/** A Group Chat's own object, addressed by the User and the group together. */
function groupChatObject(env: Env, userId: string, groupId: string) {
  // SAFETY: Wrangler binds GROUP_CHATS to GroupChat; these are its RPC doors.
  return env.GROUP_CHATS.get(
    env.GROUP_CHATS.idFromName(groupChatObjectNameV1(userId, groupId)),
  ) as unknown as {
    view(input: unknown): Promise<unknown>;
    page(input: unknown): Promise<unknown>;
    postFromUser(input: unknown): Promise<unknown>;
    markRead(input: unknown): Promise<unknown>;
    stop(input: unknown): Promise<unknown>;
    retry(input: unknown): Promise<unknown>;
    fetch(request: Request): Promise<Response>;
  };
}

const createGatewayBackendContributions = (env: Env) =>
  createFoundationBackendContributions({
    backendHost: "gateway",
    listGroupChats: async (userId: string) =>
      unwrapGroupRpcV1<GroupChatListV1>(
        await groupChatUser(env, userId).listGroupChats({
          schemaVersion: 1,
          userId,
        }),
      ),
    executeGroupChatCommand: async (
      userId: string,
      command: GroupChatCommandV1,
    ) =>
      unwrapGroupRpcV1<GroupChatReceiptV1>(
        await groupChatUser(env, userId).executeGroupChatCommand({
          schemaVersion: 1,
          userId,
          command,
        }),
      ),
    readGroupChat: async (userId: string, groupId: string) =>
      unwrapGroupRpcV1<GroupChatViewV1>(
        await groupChatObject(env, userId, groupId).view({
          schemaVersion: 1,
          userId,
          groupId,
        }),
      ),
    readGroupMessages: async (
      userId: string,
      groupId: string,
      query: { before?: number; after?: number; limit: number },
    ) =>
      unwrapGroupRpcV1<GroupMessagePageV1>(
        await groupChatObject(env, userId, groupId).page({
          schemaVersion: 1,
          userId,
          groupId,
          ...query,
        }),
      ),
    postGroupMessage: async (
      userId: string,
      groupId: string,
      command: GroupPostCommandV1,
    ) =>
      unwrapGroupRpcV1<{ schemaVersion: 1; message: GroupMessageV1 }>(
        await groupChatObject(env, userId, groupId).postFromUser({
          schemaVersion: 1,
          userId,
          groupId,
          command,
        }),
      ),
    markGroupRead: async (
      userId: string,
      groupId: string,
      command: GroupReadCommandV1,
    ) =>
      unwrapGroupRpcV1<{ schemaVersion: 1; readThrough: number }>(
        await groupChatObject(env, userId, groupId).markRead({
          schemaVersion: 1,
          userId,
          groupId,
          upTo: command.upTo,
        }),
      ),
    stopGroupTurns: async (
      userId: string,
      groupId: string,
      command: GroupStopCommandV1,
    ) =>
      unwrapGroupRpcV1<{ schemaVersion: 1; stopped: string[] }>(
        await groupChatObject(env, userId, groupId).stop({
          schemaVersion: 1,
          userId,
          groupId,
          command,
        }),
      ),
    retryGroupTurn: async (
      userId: string,
      groupId: string,
      command: GroupRetryCommandV1,
    ) =>
      unwrapGroupRpcV1<{ schemaVersion: 1 }>(
        await groupChatObject(env, userId, groupId).retry({
          schemaVersion: 1,
          userId,
          groupId,
          command,
        }),
      ),
    openGroupChannel: (userId: string, groupId: string, request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("x-frockbot-user-id", userId);
      headers.set("x-frockbot-group-id", groupId);
      return groupChatObject(env, userId, groupId).fetch(
        new Request(
          new URL(GROUP_CHANNEL_INTERNAL_PATH, "https://group-chat.internal"),
          { method: "GET", headers },
        ),
      );
    },
    listTemplateShares: async (userId: string) =>
      decodeTemplateShareListViewV1(
        rpcJsonSnapshotV1(
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
        rpcJsonSnapshotV1(
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
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).listTemplateImports({
            schemaVersion: 1,
            userId,
          }),
        ),
      ),
    executeTemplateImport: async (userId: string, command: TemplateCommandV1) =>
      decodeTemplateImportRecordV1(
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).executeTemplateImport({
            schemaVersion: 1,
            userId,
            command,
          }),
        ),
      ),
    listBots: async (userId) =>
      decodeDirectoryViewV1(
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).listBots({
            schemaVersion: 1,
            userId,
          }),
        ),
      ),
    readFlockBootstrap: async (userId: string) =>
      decodeFlockBootstrapViewV1(
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).readFlockBootstrap({
            schemaVersion: 1,
            userId,
          }),
        ),
      ),
    listBotLifecycles: async (userId: string) =>
      decodeBotLifecycleDirectoryViewV1(
        rpcJsonSnapshotV1(
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
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).executeBotLifecycle({
            schemaVersion: 1,
            userId,
            command,
          }),
        ),
      ),
    createBot: async (userId, command) =>
      decodeFlockReceiptV1(
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).createBot({
            schemaVersion: 1,
            userId,
            command,
          }),
        ),
      ),
    listBotIdentities: (userId: string) => listBotIdentities(env, userId),
    readComputer: async (userId: string, botId: string) =>
      decodeComputerProjectionV1(
        rpcJsonSnapshotV1(
          await (
            await ownedComputerBotState(env, userId, botId)
          ).readComputerPresence(),
        ),
      ),
    readComputerFrame: async (
      userId: string,
      botId: string,
      contentHash: string,
    ) => {
      const answer = await (
        await ownedComputerBotState(env, userId, botId)
      ).readComputerFrame(contentHash);
      if (!answer) return undefined;
      const binary = atob(answer.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    },
    executeComputerCommand: async (
      userId: string,
      botId: string,
      command: ComputerCommandV1,
    ) =>
      decodeComputerCommandResponse(
        rpcJsonSnapshotV1(
          await (
            await ownedComputerBotState(env, userId, botId)
          ).executeComputerPresenceCommand(command),
        ),
      ),
    searchTranscripts: async (userId: string, query: SearchQueryV1) =>
      decodeSearchIndexResultsV1(
        rpcJsonSnapshotV1(
          await userSearchStub(env, userId).searchTranscripts({
            schemaVersion: 1,
            userId,
            query,
          }),
        ),
      ),
    rebuildSearchIndex: async (userId: string) =>
      decodeClientSearchRebuildReceiptV1(
        rpcJsonSnapshotV1(
          await userSearchStub(env, userId).rebuildSearchIndex({
            schemaVersion: 1,
            userId,
          }),
        ),
      ),
    readAudit: async (userId: string, query: AuditQueryV1) =>
      decodeClientAuditPageV1(
        rpcJsonSnapshotV1(
          await userAuditStub(env, userId).readAuditEntries({
            schemaVersion: 1,
            userId,
            ...(query.botId === undefined ? {} : { botId: query.botId }),
            ...(query.kind === undefined ? {} : { kind: query.kind }),
            ...(query.target === undefined ? {} : { target: query.target }),
            ...(query.before === undefined ? {} : { before: query.before }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          }),
        ),
      ),
    rebuildAuditIndex: async (userId: string) =>
      decodeAuditRebuildReceiptV1(
        rpcJsonSnapshotV1(
          await userAuditStub(env, userId).rebuildAuditIndex({
            schemaVersion: 1,
            userId,
          }),
        ),
      ),
    listBotUnread: (userId: string) => listBotUnread(env, userId),
    listBotNotifications: (userId: string) => listBotNotifications(env, userId),
    executeBotUnreadCommand: (
      userId: string,
      botId: string,
      command: BotUnreadCommandV1,
    ) => executeBotUnreadCommand(env, userId, botId, command),
    readAvatar: async (userId, botId) =>
      decodeAvatarIdentityViewV1(
        rpcJsonSnapshotV1(
          await botStateStub(env, userId, botId).readAvatar({
            schemaVersion: 1,
            userId,
            botId,
          }),
        ),
      ),
    readVoice: async (userId, botId) =>
      decodeVoiceIdentityViewV1(
        rpcJsonSnapshotV1(
          await botStateStub(env, userId, botId).readVoice({
            schemaVersion: 1,
            userId,
            botId,
          }),
        ),
      ),
    readLook: async (userId, botId) =>
      decodeLookIdentityViewV1(
        rpcJsonSnapshotV1(
          await botStateStub(env, userId, botId).readLook({
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
    listConnectTriggers: async (userId) => {
      const offers = await userConfigurationStub(
        env,
        userId,
      ).listConnectTriggers({
        schemaVersion: 1,
        userId,
      });
      return Array.isArray(offers) ? offers : [];
    },
    ...(typeof env.COMPOSIO_WEBHOOK_SECRET === "string"
      ? { connectWebhookSecret: env.COMPOSIO_WEBHOOK_SECRET }
      : {}),
    handleConnectEvent: (input) =>
      userConfigurationStub(env, input.userId).handleConnectEvent({
        schemaVersion: 1,
        userId: input.userId,
        event: input.event,
      }),
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
    listTasks: async (userId, botId) =>
      // Snapshotted first: a cross-object answer arrives as a live stub
      // carrying `Symbol.dispose`, and an exact-keys decoder is right to
      // refuse that.
      decodeTaskListViewV1(
        rpcJsonSnapshotV1(
          await botStateStub(env, userId, botId).listTasks({
            schemaVersion: 1,
            userId,
            botId,
          }),
        ),
      ),
    readTask: async (userId, botId, taskId) =>
      decodeTaskViewV1(
        rpcJsonSnapshotV1(
          await botStateStub(env, userId, botId).readTask({
            schemaVersion: 1,
            userId,
            botId,
            taskId,
          }),
        ),
      ),
    stopTask: async (userId, botId, taskId) =>
      decodeTaskViewV1(
        rpcJsonSnapshotV1(
          await botStateStub(env, userId, botId).stopTask({
            schemaVersion: 1,
            userId,
            botId,
            taskId,
          }),
        ),
      ),
    listRoutines: async (userId, botId) =>
      decodeRoutineListViewV1(
        await botStateStub(env, userId, botId).listRoutines({
          schemaVersion: 1,
          userId,
          botId,
        }),
      ),
    readRoutinesFrame: async (userId, botId) => {
      const frame = await botStateStub(env, userId, botId).readRoutinesFrame({
        schemaVersion: 1,
        userId,
        botId,
      });
      return {
        list: decodeRoutineListViewV1(frame.list),
        inbox: decodeRoutineInboxViewV1(frame.inbox),
      };
    },
    executeRoutineCommand: async (userId, botId, command) =>
      decodeRoutineCommandReceiptV1(
        await botStateStub(env, userId, botId).executeRoutineCommand({
          schemaVersion: 1,
          userId,
          botId,
          command,
        }),
      ),
    // The secret the gateway verifies a presented machine token or pairing
    // code against, before any Durable Object is addressed. It never leaves
    // the Worker: what crosses to the User object is the token's claims and
    // its digest, never the token.
    ...(typeof env.MACHINE_TOKEN_SECRET === "string"
      ? { machineTokenSecret: env.MACHINE_TOKEN_SECRET }
      : {}),
    createMachinePairing: async (userId, request) =>
      decodeMachinePairingOfferV1(
        rpcJsonSnapshotV1(
          await userMachineStub(env, userId).createMachinePairing({
            schemaVersion: 1,
            userId,
            ...(request.label === undefined ? {} : { label: request.label }),
          }),
        ),
      ),
    enrollMachine: async (userId, input) => {
      const refusal = await externalAccountRefusal(env, userId);
      if (refusal) throw new MachineTokenError(refusal.status, refusal.message);
      return decodeMachineEnrollmentReceiptV1(
        rpcJsonSnapshotV1(
          await userMachineStub(env, userId).enrollMachine({
            schemaVersion: 1,
            userId,
            machineId: input.machineId,
            enrollment: input.enrollment,
          }),
        ),
      );
    },
    pollMachine: async (userId, call) =>
      decodeMachinePollResultV1(
        rpcJsonSnapshotV1(
          await userMachineStub(env, userId).pollMachine({
            schemaVersion: 1,
            userId,
            machineId: call.machineId,
            claims: call.claims,
            tokenDigest: call.tokenDigest,
            waitSeconds: call.waitSeconds,
          }),
        ),
      ),
    claimMachineCommand: async (userId, call) =>
      decodeMachineClaimReceiptV1(
        rpcJsonSnapshotV1(
          await userMachineStub(env, userId).claimMachineCommand({
            schemaVersion: 1,
            userId,
            machineId: call.machineId,
            commandId: call.commandId,
            claims: call.claims,
            tokenDigest: call.tokenDigest,
          }),
        ),
      ),
    recordMachineResult: async (userId, call) => {
      const receipt = decodeMachineResultReceiptV1(
        rpcJsonSnapshotV1(
          await userMachineStub(env, userId).recordMachineResult({
            schemaVersion: 1,
            userId,
            machineId: call.machineId,
            commandId: call.commandId,
            claims: call.claims,
            tokenDigest: call.tokenDigest,
            result: call.result,
          }),
        ),
      );
      // The Bot that asked is told here rather than by the User Durable
      // Object: a Durable Object holding a live reference to another one
      // cannot be evicted while it does, and this registry is built to
      // depend on neither presence nor residency. The outbox is durable, so
      // the hand-off is not lost by being made from out here.
      await deliverMachineResults(env, userId);
      return receipt;
    },
    listMachines: async (userId) =>
      decodeMachineListViewV1(
        rpcJsonSnapshotV1(
          await userMachineStub(env, userId).listMachines({
            schemaVersion: 1,
            userId,
          }),
        ),
      ),
    revokeMachine: async (userId, machineId) =>
      decodeMachineListViewV1(
        rpcJsonSnapshotV1(
          await userMachineStub(env, userId).revokeMachine({
            schemaVersion: 1,
            userId,
            machineId,
          }),
        ),
      ),
    // The secret the gateway verifies a presented webhook key against. It
    // never leaves the Worker; a Bot only ever sees a digest.
    ...(typeof env.ROUTINE_HOOK_SECRET === "string"
      ? { routineHookSecret: env.ROUTINE_HOOK_SECRET }
      : {}),
    deliverRoutineHook: async (userId, botId, delivery) => {
      const refusal = await externalAccountRefusal(env, userId);
      if (refusal) throw new RoutineHookError(refusal.status, refusal.message);
      return botStateStub(env, userId, botId).deliverRoutineHook({
        schemaVersion: 1,
        userId,
        botId,
        delivery,
      });
    },
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
    // Through the User rather than the Bot: the Bot applies the change and
    // the User's directory, which every Bot list reads, is told of it.
    updateAvatar: async (userId, botId, command) =>
      decodeFlockReceiptV1(
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).updateBotAvatar({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        ),
      ),
    updateVoice: async (userId, botId, command) =>
      decodeFlockReceiptV1(
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).updateBotVoice({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        ),
      ),
    updateLook: async (userId, botId, command) =>
      decodeFlockReceiptV1(
        rpcJsonSnapshotV1(
          await userConfigurationStub(env, userId).updateBotLook({
            schemaVersion: 1,
            userId,
            botId,
            command,
          }),
        ),
      ),
  });

/**
 * The last net under every entry point, for the rejections no boundary caught.
 *
 * `answeredEntryV1`/`loggedEntryV1` cover the entry points we know about, and a
 * detached promise is by definition one nobody is awaiting — so an isolate that
 * loses one has nowhere to report it. In the dev Worker that is not a quiet
 * loss: a run of uncaught rejections (`BotNotFoundError`, a refused Turn, a
 * provider that offers no retrieval) preceded wrangler exiting and taking the
 * shared stack down mid-test for every agent using it.
 *
 * Logging is all this does. It cannot make the rejection safe — the code that
 * produced it is what has to — but it names the failure that would otherwise
 * only ever appear as `exceptionId, url 'undefined'`, and it keeps the isolate
 * from treating the rejection as fatal.
 *
 * Registration is guarded because the event is a host capability, not a
 * language one: a runtime that does not offer it must not fail to boot.
 */
try {
  addEventListener("unhandledrejection", (event: Event) => {
    const reason = (event as { reason?: unknown }).reason;
    console.error(
      `Unhandled rejection escaped an entry point: ${
        reason instanceof Error
          ? (reason.stack ?? reason.message)
          : String(reason)
      }`,
    );
    (event as { preventDefault?: () => void }).preventDefault?.();
  });
} catch {
  // A runtime without the event still runs; it just reports less.
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    let mountedBackend:
      Awaited<ReturnType<typeof createGatewayBackendContributions>> | undefined;
    // Opt-in voice diagnostics for the assistant upgrade and nothing else.
    // The entry is the first thing that happens to this request in this
    // Worker; everything the voice object can see starts long after it.
    const timing = voiceAssistantEdgeTimingOfV1(request.url);
    timing?.mark("edge-fetch");
    try {
      // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
      // workers-types cannot infer the generated local RPC stubs.
      const runtimeExports = ctx.exports as unknown as RuntimeExports;
      mountedBackend = await createGatewayBackendContributions(env);
      timing?.mark("edge-backend-ready");
      // Which `env` secret the native door signs with belongs to the auth
      // Package: the hosted build keeps signing with the live
      // `BETTER_AUTH_SECRET`, and a build without better-auth has its own key.
      const nativeTokenSecret = AUTH_PACKAGE_V1.nativeTokenSecret.read(env);
      const gateway = createGateway(
        {
          loader: env.USER_APPLICATIONS,
          artifacts: new R2ApplicationArtifacts(env.APPLICATION_ARTIFACTS),
          registerPush: (userId, registration) =>
            env.USER_CONFIGURATIONS.get(
              env.USER_CONFIGURATIONS.idFromName(userId),
            ).registerPush({ userId, registration }),
          deletion: {
            deleteAccount: async (userId, command) =>
              rpcJsonSnapshotV1(
                await env.USER_CONFIGURATIONS.get(
                  env.USER_CONFIGURATIONS.idFromName(userId),
                ).beginAccountDeletion({ userId, ...command }),
              ),
            deleteComputer: async (userId, commandId) =>
              rpcJsonSnapshotV1(
                await env.USER_CONFIGURATIONS.get(
                  env.USER_CONFIGURATIONS.idFromName(userId),
                ).deleteComputer({ userId, commandId }),
              ),
          },
          auth: AUTH_PACKAGE_V1.create(env, {
            mayCreateIdentity: (candidate) => mayCreateIdentity(env, candidate),
          }),
          // The deployment's own origin, which is what `BETTER_AUTH_URL` is: a
          // development stack points it at its own host — the emulator reaches
          // this machine as 10.0.2.2, never as the hosted origin — and a
          // deployment that names none offers no native sign-in.
          ...(env.BETTER_AUTH_URL &&
          nativeReturnUrisFor(env, env.BETTER_AUTH_URL).length > 0 &&
          nativeTokenSecret
            ? {
                nativeAuth: createNativeAuth({
                  secret: nativeTokenSecret,
                  auth: AUTH_PACKAGE_V1.create(env, {
                    mayCreateIdentity: (candidate) =>
                      mayCreateIdentity(env, candidate),
                  }),
                  returnUris: nativeReturnUrisFor(env, env.BETTER_AUTH_URL),
                  origin: env.BETTER_AUTH_URL,
                  // The development door signs the app in as the development
                  // identity in place of Google.
                  ...(developmentAuthAllowed(env)
                    ? { developmentUserId: DEVELOPMENT_USER_ID }
                    : {}),
                  admit: async (userId) => {
                    // The stored identity, not anything the bearer carries: the
                    // email an invitation binds to and the admin allowlist reads
                    // are the identity provider's.
                    return admitStoredAccount(env, userId);
                  },
                  session: async (userId, operation) => {
                    const stub = env.USER_CONFIGURATIONS.get(
                      env.USER_CONFIGURATIONS.idFromName(userId),
                    );
                    // SAFETY: this binding names UserConfiguration; this is its reviewed RPC.
                    const rpc = stub as unknown as Pick<
                      UserConfiguration,
                      "nativeSession"
                    >;
                    const result = await rpc.nativeSession(operation);
                    if (result.schemaVersion !== 1 || result.status !== "ok")
                      throw new Error("Sign-in was refused");
                    return result.record;
                  },
                }),
              }
            : {}),
          admitAccount: (identity) => admitAccount(env, identity),
          ...(env.FROCKBOT_ADMIN_EMAILS
            ? { adminEmails: env.FROCKBOT_ADMIN_EMAILS }
            : {}),
          applicationHashFor: async () => env.DEFAULT_APPLICATION_HASH,
          botStateFor: (userId) =>
            runtimeExports.UserBotState({ props: { userId } }),
          userConfigurationFor: (userId): UserConfigurationBinding =>
            userConfigurationStub(env, userId),
          botConfigurationFor: (userId, botId): BotConfigurationBinding =>
            botStateStub(env, userId, botId),
          openBotStateChannel: (userId, botId, request, context) =>
            openOwnedBotStateChannel(env, userId, botId, request, context),
          voice: voiceGatewayDependencies(env),
          backendContributions: [
            ...mountedBackend.contributions,
            billingRoutes(
              env,
              (userId) =>
                env.USER_CONFIGURATIONS.get(
                  env.USER_CONFIGURATIONS.idFromName(userId),
                ) as unknown as BillingAccountRpc,
              async () =>
                decodeHostedModelRatesV1(
                  rpcJsonSnapshotV1(
                    await deploymentPolicyStub(env).readModelRates({
                      schemaVersion: 1,
                    }),
                  ),
                ),
            ),
          ],
          debug: debugSurface(env),
          allowedClientOrigins: allowedClientOrigins(env),
          allowDevelopmentIdentity: env.ALLOW_DEVELOPMENT_AUTH === "true",
        },
        timing,
      );
      const answer = await gateway(request);
      timing?.mark("edge-answered", { status: answer.status });
      return answer;
    } catch (error) {
      // The outermost boundary. Building the gateway can fail before any route
      // runs — an unavailable binding, a Contribution that will not mount — and
      // workerd would answer that as plain text, which the client can only
      // report as a JSON parse error. Every answer this Worker gives is JSON
      // carrying a reason.
      return Response.json(
        {
          error:
            error instanceof Error ? error.message : "gateway request failed",
        },
        { status: 500 },
      );
    } finally {
      await mountedBackend?.dispose();
    }
  },
} satisfies ExportedHandler<Env>;

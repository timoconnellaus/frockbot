import { WorkerEntrypoint } from "cloudflare:workers";
import { BOT_STATE_CHANNEL_INTERNAL_PATH } from "./bot-state-channel.js";
import {
  decodeMachineResultDeliveryV1,
  type MachineResultDeliveryV1,
} from "@frockbot/plugin-user-machine/delivery";
import {
  APPLET_ID_V1,
  decodePackageIframeToolCommandV1,
  type AppletBuildViewV1,
  type AppletSourceViewV1,
  type PackageIframeCompositionV1,
} from "@frockbot/kernel-contracts";
import type { ClientSkillCatalogV1 } from "@frockbot/plugin-shell/skill-protocol";
import {
  compileFoundationApplication,
  createFoundationBackendContributions,
} from "@frockbot/application-foundation/runtime";
import { FIRST_PARTY_PACKAGE_ARTIFACTS_V1 } from "@frockbot/application-foundation/generated/applets-artifact";
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
  type ClientConversationListV1,
  type ClientConversationOutcomeV1,
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
  decodeApprovalDecisionCommandV1,
  decodeApprovalDecisionReceiptV1,
  decodeApprovalListViewV1,
  type ApprovalDecisionCommandV1,
  type ApprovalDecisionReceiptV1,
  type ApprovalListViewV1,
} from "@frockbot/plugin-shell/approvals";
import {
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationListViewV1,
  decodeCompositionGenerationViewV1,
  decodeBotIdV1,
  type BotSettingsViewV1,
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
  decodeComputerCommandResponse,
  decodeComputerProjectionV1,
  type ComputerCommandV1,
} from "@frockbot/plugin-computer/protocol";
import { ComputerBotNotFoundError } from "@frockbot/plugin-computer/backend";
import {
  decodeTaskListViewV1,
  decodeTaskViewV1,
} from "@frockbot/plugin-subagents/shared";
import {
  decodeMachineClaimReceiptV1,
  decodeMachineEnrollmentReceiptV1,
  decodeMachineListViewV1,
  decodeMachinePairingOfferV1,
  decodeMachinePollResultV1,
  decodeMachineResultReceiptV1,
} from "@frockbot/machine-protocol";
import {
  decodeClientSearchRebuildReceiptV1,
  decodeSearchIndexResultsV1,
  type SearchQueryV1,
} from "@frockbot/plugin-search";
import {
  decodeAuditRebuildReceiptV1,
  decodeClientAuditPageV1,
  type AuditQueryV1,
} from "@frockbot/plugin-audit";
import {
  decodeUsageReportV1,
  type UsageReportV1,
} from "@frockbot/plugin-billing";
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
import {
  decodeRevokeConnectionResultV1,
  decodeStartConnectionResultV1,
} from "@frockbot/connection-core";
import {
  decodeDeploymentPolicyV1,
  type DeploymentPolicyV1,
  type SetSignupsCommandV1,
} from "@frockbot/plugin-admin/shared";
import { gatewayAuth } from "./auth.js";
import { createNativeAuth, nativeReturnUris } from "./native-auth.js";
import { accountIsAdmitted } from "./account-admission.js";
import { isDeploymentAdminV1 } from "./admin-identities.js";
import type { DebugGatewaySurface } from "./debug.js";
import type { BotDebugQueryV1 } from "@frockbot/plugin-shell/debug-protocol";
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
  rpcAppletIdOrNull,
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
import { createImmutablePlanRequestFactory } from "./immutable-application.js";
import { R2PackageCatalog } from "./package-catalog.js";
import { UserConfiguration } from "./user-configuration.js";
import {
  DEPLOYMENT_POLICY_SINGLETON_NAME,
  DeploymentPolicy,
} from "./deployment-policy.js";

import {
  appletStateNameV1,
  mintAppletViewerTokenV1,
  APPLET_VIEWER_TOKEN_TTL_MS,
} from "@frockbot/kernel-do";
import {
  decodeAppletGenerationV1,
  decodeAppletSummaryV1,
} from "@frockbot/kernel-contracts";
import type { AppletState } from "./applet-state.js";
import type { VoiceSession } from "./voice-session.js";
import {
  VOICE_ASSISTANT_INTERNAL_PATH,
  VOICE_DICTATION_INTERNAL_PATH,
} from "./voice-session.js";
export { BotCapabilities } from "./bot-capabilities.js";
// The Applet authority (ADR 0022): the Durable Object that owns one Applet
// instance, and the loopback `CAPABILITIES` entrypoint its facet is handed.
export { AppletCapabilities, AppletState } from "./applet-state.js";
// The composer's dictation transport (voice plan D2): one object per User,
// holding the browser leg and the provider leg and no authority at all.
export { VoiceSession } from "./voice-session.js";
export { BotState, DeploymentPolicy, UserConfiguration };

interface Env {
  /** Explicit qualification gate; not enabled by the production configuration. */
  NATIVE_SLICE_2_AUTH?: string;
  USER_APPLICATIONS: WorkerLoader;
  // Bot-authored Package isolates, driven from the Bot Durable Object with
  // `globalOutbound` disabled (plan Step 4). A separate loader namespace from
  // USER_APPLICATIONS so the two never share an identity.
  BOT_PACKAGES: BotPackageLoader;
  /**
   * Applet server artifacts, loaded from the Applet Durable Object and mounted
   * as a facet (ADR 0022). Its own loader namespace: a loader id keeps the
   * `env` it was first loaded with, and an Applet's `env` is not a Bot
   * Package's.
   */
  APPLETS: WorkerLoader;
  /** One Durable Object per Applet instance, `idFromName("<userId>:<appletId>")`. */
  APPLET_STATES: DurableObjectNamespace<AppletState>;
  /**
   * Signs the short-lived viewer token an open Applet's page presents. The
   * page runs in a cookieless sandboxed iframe and can carry no credential, so
   * this secret is the whole of the door. Absent closes it: a token is refused
   * rather than minted under a signature nothing could verify.
   */
  APPLET_VIEWER_SECRET?: string;
  APPLICATION_ARTIFACTS: R2Bucket;
  UI_ARTIFACT_HOSTS?: string;
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
  /** One voice transport per User, `idFromName(userId)` (voice plan D2). */
  VOICE_SESSIONS: DurableObjectNamespace<VoiceSession>;
  /**
   * The direct OpenAI realtime key. Present, dictation takes the direct path;
   * absent, it takes the AI Gateway's BYOK key. A Worker secret, so the
   * release workflow's `--secrets-file` list carries the name or a deploy
   * would delete it (ADR 0025).
   */
  OPENAI_API_KEY?: string;
  /**
   * The Gemini key slice B will read the same way. Declared here so the
   * release workflow can carry it before the code that uses it lands.
   */
  GEMINI_API_KEY?: string;
  /** Local dictation stand-in; set by the end-to-end harness only. */
  VOICE_UPSTREAM_URL?: string;
  /** Local Gemini Live stand-in; set by the end-to-end harness only. */
  VOICE_ASSISTANT_UPSTREAM_URL?: string;
  DEPLOYMENT_POLICY: DurableObjectNamespace<DeploymentPolicy>;
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
  /**
   * Signs every machine token and pairing code. Absent closes the registered
   * machine door: pairing, enrollment and every machine route answer 503
   * rather than admitting a caller nothing could verify.
   */
  MACHINE_TOKEN_SECRET?: string;
  /**
   * Signs the callback `state` of every redirect-based Connection. Absent — or
   * weak, or equal to `BETTER_AUTH_SECRET` — closes the `mcp-oauth` door: the
   * routes answer 503 rather than trusting a forgeable identity.
   */
  FROCKBOT_AUTHORIZATION_STATE_SECRET?: string;
  ALLOW_DEVELOPMENT_AUTH?: string;
  FROCKBOT_ADMIN_EMAILS?: string;
  ALLOWED_CLIENT_ORIGINS?: string;
  /** Authorizes `/api/debug/*`. Absent disables the surface entirely. */
  DEBUG_TOKEN?: string;
  /** Set only by the end-to-end harness; opens the Workspace seed door. */
  WORKSPACE_SEED_TOKEN?: string;
}

/**
 * The `/api/debug` surface, over the same durable records and identity store
 * the gateway already holds. Without `DEBUG_TOKEN` it carries no token, and
 * the routes 404.
 */
function debugSurface(env: Env): DebugGatewaySurface {
  return {
    ...(env.DEBUG_TOKEN ? { token: env.DEBUG_TOKEN } : {}),
    listUsers: async () => {
      const result = await env.AUTH_DB.prepare(
        'select "id", "email", "name", "createdAt" from "user" order by "createdAt" desc limit 50',
      ).all<{ id: string; email: string; name: string; createdAt: string }>();
      return result.results ?? [];
    },
    listBots: (userId) =>
      userConfigurationStub(env, userId).listBots({ schemaVersion: 1, userId }),
    readUsage: (userId) =>
      userUsageStub(env, userId).readUsage({ schemaVersion: 1, userId }),
    snapshot: (userId, botId, query) =>
      botStateStub(env, userId, botId).debugSnapshot(query),
    isAdminUser: async (userId) => {
      // Better Auth is the durable identity source for production Users. The
      // path's User id is never trusted on its own: it must resolve to a stored
      // email, and that identity is evaluated by the same allowlist policy as
      // the signed-in gateway and the admin Package.
      const identity = await env.AUTH_DB.prepare(
        'select "id", "email" from "user" where "id" = ? limit 1',
      )
        .bind(userId)
        .first<{ id: string; email: string }>();
      return (
        identity !== null &&
        isDeploymentAdminV1(
          { id: identity.id, email: identity.email, mode: "better-auth" },
          env.FROCKBOT_ADMIN_EMAILS,
        )
      );
    },
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
  writeUserWorkspaceFileV1(input: {
    schemaVersion: 1;
    userId: string;
    botId: string;
    root: unknown;
    path: string;
    bytesBase64: string;
    mediaType?: string;
  }): Promise<unknown>;
  readComputerPresence(): Promise<unknown>;
  executeComputerPresenceCommand(command: ComputerCommandV1): Promise<unknown>;
  run(command: OwnedBotTurnCommand): Promise<BotTurnResult>;
  listRuns(query: ClientRunListQueryV1): Promise<ClientRunListV1>;
  listConversations(): Promise<ClientConversationListV1>;
  startConversation(): Promise<ClientConversationOutcomeV1>;
  debugSnapshot(query: BotDebugQueryV1): Promise<unknown>;
  readFocusedApplet(input: unknown): Promise<unknown>;
  setFocusedApplet(input: unknown): Promise<unknown>;
  lookupRun(query: ClientRunLookupQueryV1): Promise<ClientRunLookupV1>;
  fenceRunAdmission(query: ClientRunLookupQueryV1): Promise<ClientRunLookupV1>;
  listSkills(): Promise<ClientSkillCatalogV1>;
  listPackageUi(): Promise<PackageIframeCompositionV1>;
  runPackageUiTool(
    command: import("@frockbot/kernel-contracts").PackageIframeToolCommandV1,
  ): Promise<BotTurnResult>;
  readWorkspaceFileV1(path: unknown): Promise<ClientWorkspaceFileV1>;
  readAppletSourceV1(appletId: string): Promise<AppletSourceViewV1>;
  readAppletBuildV1(appletId: string): Promise<AppletBuildViewV1>;
  listNotifications(): Promise<BotNotificationIntent[]>;
  acknowledgeNotification(notificationId: string): Promise<void>;
  listApprovals(): Promise<ApprovalListViewV1>;
  decideApproval(
    approvalId: string,
    command: ApprovalDecisionCommandV1,
  ): Promise<ApprovalDecisionReceiptV1>;
  readUnread(): Promise<BotUnreadViewV1>;
  executeUnreadCommand(
    command: BotUnreadCommandV1,
  ): Promise<BotUnreadReceiptV1>;
  reconcileRun(
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<BotTurnResult>;
  stopRun(command: ClientRunStopCommandV1): Promise<ClientRunStopReceiptV1>;
}

/**
 * The User Durable Object's RPC surface as this Worker uses it: the binding the
 * gateway shares, plus this adapter's own seams.
 */
interface UserConfigurationRpc extends UserConfigurationBinding {
  /** Read-only signup-gate probe; unlike configuration reads, it pins nothing. */
  isProvisioned(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<boolean>;
  readVoiceAssistant(request: {
    schemaVersion: 1;
    userId: string;
  }): Promise<unknown>;
}

type RpcBoundary<T> = {
  [Key in keyof T]: T[Key] extends (...args: never[]) => infer Result
    ? (input: unknown) => Result
    : never;
};

function botStateStub(env: Env, userId: string, botId: string): BotStateRpc {
  // The one place a Bot Durable Object is named, and therefore the one place
  // the name has to be beyond doubt. A Subagent Durable Object is the same
  // class in this namespace under `<userId>:<botId>#task:<taskId>` (ADR 0017),
  // so a `#` reaching here from a path segment would let a caller name an
  // object the directory never minted. `decodeBotIdV1` rejects it — this
  // restates the check where the id becomes an object rather than trusting
  // that every route above remembered to.
  const id = env.BOT_STATES.idFromName(
    `${userId}:${decodeBotIdV1(botId, "bot id")}`,
  );
  // SAFETY: Wrangler binds BOT_STATES to BotState; workers-types cannot infer its generated RPC surface.
  const rpc = env.BOT_STATES.get(id) as unknown as RpcBoundary<BotStateRpc>;
  return {
    writeUserWorkspaceFileV1: (input) => rpc.writeUserWorkspaceFileV1(input),
    readComputerPresence: () =>
      rpc.readComputerPresence({ schemaVersion: 1, userId, botId }),
    executeComputerPresenceCommand: (command) =>
      rpc.executeComputerPresenceCommand({
        schemaVersion: 1,
        userId,
        botId,
        command,
      }),
    readSheep: (request) => rpc.readSheep(request),
    updateSheep: (request) => rpc.updateSheep(request),
    readConfiguration: (request) => rpc.readConfiguration(request),
    executeConfiguration: (request) => rpc.executeConfiguration(request),
    listRoutines: (request) => rpc.listRoutines(request),
    listTasks: (request) => rpc.listTasks(request),
    readTask: (request) => rpc.readTask(request),
    stopTask: (request) => rpc.stopTask(request),
    executeRoutineCommand: (request) => rpc.executeRoutineCommand(request),
    listRoutineRuns: (request) => rpc.listRoutineRuns(request),
    deliverRoutineHook: (request) => rpc.deliverRoutineHook(request),
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
          // The composer's supersede intent and the lane it implies. This
          // rebuilds the command field by field rather than spreading it, so
          // anything not named here is dropped silently — which is exactly how
          // a supersede reached the Bot Durable Object as an ordinary second
          // command and came back "bot already has an active run".
          ...(command.lane ? { lane: command.lane } : {}),
          ...(command.supersedes ? { supersedes: command.supersedes } : {}),
        },
      }),
    listRuns: (query) =>
      rpc.listRuns({ schemaVersion: 1, userId, botId, query }),
    listConversations: () =>
      rpc.listConversations({ schemaVersion: 1, userId, botId }),
    startConversation: () =>
      rpc.startConversation({ schemaVersion: 1, userId, botId }),
    debugSnapshot: (query) =>
      rpc.debugSnapshot({ schemaVersion: 1, userId, botId, query }),
    lookupRun: (query) =>
      rpc.lookupRun({ schemaVersion: 1, userId, botId, query }),
    fenceRunAdmission: (query) =>
      rpc.fenceRunAdmission({ schemaVersion: 1, userId, botId, query }),
    listSkills: () => rpc.listSkills({ schemaVersion: 1, userId, botId }),
    listPackageUi: () => rpc.listPackageUi({ schemaVersion: 1, userId, botId }),
    runPackageUiTool: (command) =>
      rpc.runPackageUiTool({ schemaVersion: 1, userId, botId, command }),
    readWorkspaceFileV1: (path) =>
      rpc.readWorkspaceFileV1({ schemaVersion: 1, userId, botId, path }),
    readAppletSourceV1: (appletId) =>
      rpc.readAppletSourceV1({ schemaVersion: 1, userId, botId, appletId }),
    readAppletBuildV1: (appletId) =>
      rpc.readAppletBuildV1({ schemaVersion: 1, userId, botId, appletId }),
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
    readFocusedApplet: (input) => rpc.readFocusedApplet(input),
    setFocusedApplet: (input) => rpc.setFocusedApplet(input),
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
    isProvisioned: (request) => rpc.isProvisioned(request),
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
    startMcpAuthorization: (request) => rpc.startMcpAuthorization(request),
    completeMcpAuthorization: (request) =>
      rpc.completeMcpAuthorization(request),
    revokeMcpAuthorization: (request) => rpc.revokeMcpAuthorization(request),
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
    readVoiceAssistant: (request) => rpc.readVoiceAssistant(request),
  };
}

interface DeploymentPolicyRpc {
  readPolicy(input: unknown): Promise<unknown>;
  setSignups(input: unknown): Promise<unknown>;
}

function deploymentPolicyStub(env: Env): DeploymentPolicyRpc {
  return env.DEPLOYMENT_POLICY.getByName(
    DEPLOYMENT_POLICY_SINGLETON_NAME,
  ) as unknown as DeploymentPolicyRpc;
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

interface UserUsageRpc {
  readUsage(input: unknown): Promise<unknown>;
}

function userAuditStub(env: Env, userId: string): UserAuditRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its generated Audit RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as UserAuditRpc;
}

function userUsageStub(env: Env, userId: string): UserUsageRpc {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its generated Usage RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as UserUsageRpc;
}

/** The User Durable Object's Applet directory, addressed by User. */
function userAppletDirectoryStub(
  env: Env,
  userId: string,
): { listApplets(input: unknown): Promise<unknown> } {
  const id = env.USER_CONFIGURATIONS.idFromName(userId);
  // SAFETY: Wrangler binds USER_CONFIGURATIONS to UserConfiguration; workers-types cannot infer its generated Applet directory RPC surface.
  return env.USER_CONFIGURATIONS.get(id) as unknown as {
    listApplets(input: unknown): Promise<unknown>;
  };
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
        // The same optional members the Bot Durable Object's door accepts —
        // a supersede the composer sends must not be refused one door earlier.
        rpcBotTurnCommandOptionalsV1,
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

  async listConversations(input: unknown): Promise<ClientConversationListV1> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).listConversations();
  }

  async startConversation(
    input: unknown,
  ): Promise<ClientConversationOutcomeV1> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).startConversation();
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

  async listPackageUi(input: unknown): Promise<PackageIframeCompositionV1> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).listPackageUi();
  }

  async runPackageUiTool(input: unknown): Promise<BotTurnResult> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      command: rpcDecoded(decodePackageIframeToolCommandV1),
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).runPackageUiTool(
      request.command as import("@frockbot/kernel-contracts").PackageIframeToolCommandV1,
    );
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

  // --- Applets (ADR 0022) --------------------------------------------------
  //
  // Applets are the User's, not a Bot's, so these three sit on the User-scoped
  // entrypoint the hosted application already holds. The application Worker
  // reaches the User Durable Object only through here; it never gets a
  // namespace of its own.

  async listApplets(_input?: unknown): Promise<unknown> {
    const userId = this.ctx.props.userId;
    return rpcJsonSnapshot(
      await userAppletDirectoryStub(this.env, userId).listApplets({
        schemaVersion: 1,
        userId,
      }),
    );
  }

  /**
   * A short-lived viewer token for one Applet, minted only for the User this
   * entrypoint is scoped to and only against the Applet's *current* generation.
   *
   * The Applet's page runs in a cookieless sandboxed iframe and can carry no
   * credential, so this is the whole of its authority — and it names the User,
   * the Applet, and the generation, for fifteen minutes.
   */
  async mintAppletViewerToken(input: unknown): Promise<{
    token: string;
    expiresAt: string;
    appletId: string;
    generationId: string;
  }> {
    const request = decodeRpcEnvelopeV1(input, { appletId: rpcString(129) });
    const userId = this.ctx.props.userId;
    const appletId = request.appletId as string;
    const secret = this.env.APPLET_VIEWER_SECRET;
    if (!secret) {
      throw new Error("Applet viewer sessions are not configured");
    }
    const state = await this.appletCurrentGeneration(userId, appletId);
    const expiresAt = new Date(Date.now() + APPLET_VIEWER_TOKEN_TTL_MS);
    return {
      token: await mintAppletViewerTokenV1(secret, {
        u: userId,
        a: appletId,
        g: state.generationId,
        exp: Math.floor(expiresAt.getTime() / 1_000),
      }),
      expiresAt: expiresAt.toISOString(),
      appletId,
      generationId: state.generationId,
    };
  }

  /** One generation read supplies both the native iframe artifact and its lease. */
  async nativeAppletBootstrap(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      appletId: rpcString(129),
      navigationEpoch: rpcIdentifier,
    });
    const userId = this.ctx.props.userId;
    const appletId = request.appletId as string;
    const navigationEpoch = request.navigationEpoch as string;
    const secret = this.env.APPLET_VIEWER_SECRET;
    if (!secret) throw new Error("Applet viewer sessions are not configured");
    const state = await this.appletCurrentGeneration(userId, appletId);
    const expiresAt = new Date(Date.now() + 120_000);
    const artifactOrigin = "https://ui.bot.frockbot.com";
    return {
      schemaVersion: 1 as const,
      appletId,
      userId,
      generationId: state.generationId,
      navigationEpoch,
      bootstrapUrl: `${artifactOrigin}/native-fallback?artifact=${state.uiContentHash}&epoch=${encodeURIComponent(navigationEpoch)}`,
      artifactOrigin,
      artifact: state.ui,
      viewer: {
        token: await mintAppletViewerTokenV1(secret, {
          u: userId,
          a: appletId,
          g: state.generationId,
          exp: Math.floor(expiresAt.getTime() / 1000),
        }),
        expiresAt: expiresAt.toISOString(),
        socketUrl: `wss://bot.frockbot.com/api/applets/${encodeURIComponent(appletId)}/socket`,
      },
    };
  }

  /** The current generation's UI artifact, for the canvas to nest. */
  async readAppletUi(input: unknown): Promise<{
    appletId: string;
    generationId: string;
    contentHash: string;
  }> {
    const request = decodeRpcEnvelopeV1(input, { appletId: rpcString(129) });
    const userId = this.ctx.props.userId;
    const appletId = request.appletId as string;
    const state = await this.appletCurrentGeneration(userId, appletId);
    return {
      appletId,
      generationId: state.generationId,
      contentHash: state.uiContentHash,
    };
  }

  private async appletCurrentGeneration(
    userId: string,
    appletId: string,
  ): Promise<{
    generationId: string;
    uiContentHash: string;
    ui: ReturnType<typeof decodeAppletGenerationV1>["ui"];
  }> {
    const directory = decodeAppletSummaryV1(
      await this.requireAppletSummary(userId, appletId),
    );
    if (directory.status === "deleted" || !directory.currentGenerationId) {
      throw new Error(`Applet "${appletId}" has no active generation`);
    }
    const namespace = this.env.APPLET_STATES;
    const view = rpcJsonSnapshot(
      await namespace
        .get(namespace.idFromName(appletStateNameV1(userId, appletId)))
        .read({ schemaVersion: 1, userId, appletId }),
    ) as { current?: { generationId?: unknown }; generations?: unknown };
    const generationId = String(view.current?.generationId ?? "");
    const generation = (Array.isArray(view.generations) ? view.generations : [])
      .map((value) => decodeAppletGenerationV1(value))
      .find((candidate) => candidate.generationId === generationId);
    if (!generation) {
      throw new Error(`Applet "${appletId}" has no active generation`);
    }
    return {
      generationId,
      uiContentHash: generation.ui.contentHash,
      ui: generation.ui,
    };
  }

  private async requireAppletSummary(
    userId: string,
    appletId: string,
  ): Promise<unknown> {
    const answer = rpcJsonSnapshot(
      await userAppletDirectoryStub(this.env, userId).listApplets({
        schemaVersion: 1,
        userId,
      }),
    ) as { applets?: unknown };
    const found = (Array.isArray(answer.applets) ? answer.applets : []).find(
      (applet) => (applet as { appletId?: unknown }).appletId === appletId,
    );
    if (!found) throw new Error(`Applet "${appletId}" is unavailable`);
    return found;
  }

  async readFocusedApplet(input: unknown): Promise<unknown> {
    const request = decodeRpcEnvelopeV1(input, { botId: rpcBotId });
    const userId = this.ctx.props.userId;
    const botId = request.botId as string;
    return rpcJsonSnapshot(
      await botStateStub(this.env, userId, botId).readFocusedApplet({
        schemaVersion: 1,
        userId,
        botId,
      }),
    );
  }

  async setFocusedApplet(input: unknown): Promise<unknown> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      appletId: rpcAppletIdOrNull,
    });
    const userId = this.ctx.props.userId;
    const botId = request.botId as string;
    return rpcJsonSnapshot(
      await botStateStub(this.env, userId, botId).setFocusedApplet({
        schemaVersion: 1,
        userId,
        botId,
        appletId: request.appletId as string | null,
      }),
    );
  }

  async readAppletSourceV1(input: unknown): Promise<AppletSourceViewV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      appletId: rpcPattern(APPLET_ID_V1, 129),
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).readAppletSourceV1(request.appletId as string);
  }

  async readAppletBuildV1(input: unknown): Promise<AppletBuildViewV1> {
    const request = decodeRpcEnvelopeV1(input, {
      botId: rpcBotId,
      appletId: rpcPattern(APPLET_ID_V1, 129),
    });
    return botStateStub(
      this.env,
      this.ctx.props.userId,
      request.botId as string,
    ).readAppletBuildV1(request.appletId as string);
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

function packageUiArtifactKey(contentHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error("package UI artifact contentHash is invalid");
  }
  return `packages/${contentHash}.html`;
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
   * A Package's page, from object storage or from this bundle.
   *
   * A first-party artifact-backed member (ADR 0022 decision 8) is built at
   * build time and its pages travel here, so the anonymous serving origin can
   * answer for them with nothing seeded into the bucket. The digest decides in
   * both cases; object storage wins when it holds the object.
   */
  async loadPackageUiArtifact(
    contentHash: string,
  ): Promise<string | undefined> {
    const key = packageUiArtifactKey(contentHash);
    const object = await this.bucket.get(key);
    const html = object
      ? await object.text()
      : FIRST_PARTY_PACKAGE_ARTIFACTS_V1.get(key);
    if (html === undefined) return undefined;
    if ((await sha256Hex(html)) !== contentHash) {
      throw new Error(
        `package UI artifact "${contentHash}" failed hash verification`,
      );
    }
    return html;
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
    const key = packageArtifactKey(contentHash);
    const object = await this.bucket.get(key);
    const bundled = object
      ? undefined
      : FIRST_PARTY_PACKAGE_ARTIFACTS_V1.get(key);
    if (!object && bundled === undefined) {
      throw new Error(`package artifact "${contentHash}" was not found`);
    }
    const module = object ? await object.text() : bundled!;
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
    ...(profile.label === undefined ? {} : { label: profile.label }),
    ...(profile.title === undefined ? {} : { title: profile.title }),
    ...(profile.pinnedAt === undefined ? {} : { pinnedAt: profile.pinnedAt }),
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
    rpcJsonSnapshot(
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
 * The composer's dictation socket, handed to this User's `VoiceSession`.
 *
 * The identity travels as a header rather than in the URL for the same reason
 * the Bot-state channel's does: the object trusts what the gateway
 * authenticated and nothing a caller could have written for itself.
 */
function openVoiceDictation(
  env: Env,
  userId: string,
  request: Request,
): Promise<Response> {
  const incoming = new URL(request.url);
  const internal = new URL(
    `${VOICE_DICTATION_INTERNAL_PATH}${incoming.search}`,
    "https://voice-session.internal",
  );
  const headers = new Headers(request.headers);
  headers.delete("x-frockbot-user-id");
  headers.set("x-frockbot-user-id", userId);
  const namespace = env.VOICE_SESSIONS;
  return namespace
    .get(namespace.idFromName(userId))
    .fetch(new Request(internal, { method: "GET", headers }));
}

function openVoiceAssistant(
  env: Env,
  userId: string,
  request: Request,
): Promise<Response> {
  const incoming = new URL(request.url);
  const internal = new URL(
    `${VOICE_ASSISTANT_INTERNAL_PATH}${incoming.search}`,
    "https://voice-session.internal",
  );
  const headers = new Headers(request.headers);
  headers.delete("x-frockbot-user-id");
  headers.set("x-frockbot-user-id", userId);
  const namespace = env.VOICE_SESSIONS;
  return namespace
    .get(namespace.idFromName(userId))
    .fetch(new Request(internal, { method: "GET", headers }));
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
      readDeploymentPolicy: async (): Promise<DeploymentPolicyV1> =>
        decodeDeploymentPolicyV1(
          rpcJsonSnapshot(
            await deploymentPolicyStub(env).readPolicy({ schemaVersion: 1 }),
          ),
        ),
      setDeploymentSignups: async (
        command: SetSignupsCommandV1,
        updatedBy: string,
      ): Promise<DeploymentPolicyV1> =>
        decodeDeploymentPolicyV1(
          rpcJsonSnapshot(
            await deploymentPolicyStub(env).setSignups({
              schemaVersion: 1,
              command,
              updatedBy,
            }),
          ),
        ),
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
      readComputer: async (userId: string, botId: string) =>
        decodeComputerProjectionV1(
          rpcJsonSnapshot(
            await (
              await ownedComputerBotState(env, userId, botId)
            ).readComputerPresence(),
          ),
        ),
      executeComputerCommand: async (
        userId: string,
        botId: string,
        command: ComputerCommandV1,
      ) =>
        decodeComputerCommandResponse(
          rpcJsonSnapshot(
            await (
              await ownedComputerBotState(env, userId, botId)
            ).executeComputerPresenceCommand(command),
          ),
        ),
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
      readAudit: async (userId: string, query: AuditQueryV1) =>
        decodeClientAuditPageV1(
          rpcJsonSnapshot(
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
      readUsage: async (userId: string): Promise<UsageReportV1> =>
        decodeUsageReportV1(
          rpcJsonSnapshot(
            await userUsageStub(env, userId).readUsage({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      rebuildAuditIndex: async (userId: string) =>
        decodeAuditRebuildReceiptV1(
          rpcJsonSnapshot(
            await userAuditStub(env, userId).rebuildAuditIndex({
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
      readVoiceAssistant: (userId) =>
        userConfigurationStub(env, userId).readVoiceAssistant({
          schemaVersion: 1,
          userId,
        }),
      openVoiceAssistant: (userId, request) =>
        openVoiceAssistant(env, userId, request),
      // The `mcp-oauth` gateway seams. The Contribution reads the signing
      // secret through `readSecret` and refuses to serve its routes at all
      // when this deployment has none, so a Worker without the secret has no
      // callback door rather than an unsigned one.
      readSecret: (name: string) =>
        name === "FROCKBOT_AUTHORIZATION_STATE_SECRET"
          ? env.FROCKBOT_AUTHORIZATION_STATE_SECRET
          : name === "BETTER_AUTH_SECRET"
            ? env.BETTER_AUTH_SECRET
            : undefined,
      ...(env.BETTER_AUTH_URL ? { callbackBaseUrl: env.BETTER_AUTH_URL } : {}),
      startMcpAuthorization: async (userId, start) =>
        decodeStartConnectionResultV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).startMcpAuthorization({
              schemaVersion: 1,
              userId,
              start,
            }),
          ),
        ),
      completeMcpAuthorization: async (userId, completion) =>
        rpcJsonSnapshot(
          await userConfigurationStub(env, userId).completeMcpAuthorization({
            schemaVersion: 1,
            userId,
            completion,
          }),
        ),
      revokeMcpAuthorization: async (userId, connectionId) =>
        decodeRevokeConnectionResultV1(
          rpcJsonSnapshot(
            await userConfigurationStub(env, userId).revokeMcpAuthorization({
              schemaVersion: 1,
              userId,
              connectionId,
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
          rpcJsonSnapshot(
            await userMachineStub(env, userId).createMachinePairing({
              schemaVersion: 1,
              userId,
              ...(request.label === undefined ? {} : { label: request.label }),
            }),
          ),
        ),
      enrollMachine: async (userId, input) =>
        decodeMachineEnrollmentReceiptV1(
          rpcJsonSnapshot(
            await userMachineStub(env, userId).enrollMachine({
              schemaVersion: 1,
              userId,
              machineId: input.machineId,
              enrollment: input.enrollment,
            }),
          ),
        ),
      pollMachine: async (userId, call) =>
        decodeMachinePollResultV1(
          rpcJsonSnapshot(
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
          rpcJsonSnapshot(
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
          rpcJsonSnapshot(
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
          rpcJsonSnapshot(
            await userMachineStub(env, userId).listMachines({
              schemaVersion: 1,
              userId,
            }),
          ),
        ),
      revokeMachine: async (userId, machineId) =>
        decodeMachineListViewV1(
          rpcJsonSnapshot(
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
  addEventListener("unhandledrejection", (event) => {
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
    try {
      // SAFETY: exported WorkerEntrypoints are materialized on ctx.exports;
      // workers-types cannot infer the generated local RPC stubs.
      const runtimeExports = ctx.exports as unknown as RuntimeExports;
      mountedBackend = await createGatewayBackendContributions(env);
      const gateway = createGateway({
        loader: env.USER_APPLICATIONS,
        artifacts: new R2ApplicationArtifacts(env.APPLICATION_ARTIFACTS),
        uiArtifactHosts: (env.UI_ARTIFACT_HOSTS ?? "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
        auth: gatewayAuth(env),
        saveNativeForm: (userId, command) => {
          const stub = env.USER_CONFIGURATIONS.get(
            env.USER_CONFIGURATIONS.idFromName(userId),
          );
          // SAFETY: USER_CONFIGURATIONS is bound to the reviewed UserConfiguration class.
          const rpc = stub as unknown as Pick<
            UserConfiguration,
            "saveNativeForm"
          >;
          return rpc.saveNativeForm({ schemaVersion: 1, userId, command });
        },
        ...(nativeReturnUris(env.NATIVE_SLICE_2_AUTH).length > 0 &&
        env.BETTER_AUTH_SECRET
          ? {
              nativeAuth: createNativeAuth({
                secret: env.BETTER_AUTH_SECRET,
                auth: gatewayAuth(env),
                returnUris: nativeReturnUris(env.NATIVE_SLICE_2_AUTH),
                canIssueSession: async (userId) => {
                  const identity = await env.AUTH_DB.prepare(
                    'select "id", "email" from "user" where "id" = ? limit 1',
                  )
                    .bind(userId)
                    .first<{ id: string; email: string }>();
                  if (!identity) return false;
                  return accountIsAdmitted(
                    userId,
                    isDeploymentAdminV1(
                      { ...identity, mode: "better-auth" },
                      env.FROCKBOT_ADMIN_EMAILS,
                    ),
                    {
                      userExists: (id) =>
                        userConfigurationStub(env, id).isProvisioned({
                          schemaVersion: 1,
                          userId: id,
                        }),
                      readDeploymentPolicy: async () =>
                        decodeDeploymentPolicyV1(
                          rpcJsonSnapshot(
                            await deploymentPolicyStub(env).readPolicy({
                              schemaVersion: 1,
                            }),
                          ),
                        ),
                    },
                  );
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
        userExists: (userId) =>
          userConfigurationStub(env, userId).isProvisioned({
            schemaVersion: 1,
            userId,
          }),
        readDeploymentPolicy: async () =>
          decodeDeploymentPolicyV1(
            rpcJsonSnapshot(
              await deploymentPolicyStub(env).readPolicy({ schemaVersion: 1 }),
            ),
          ),
        ...(env.FROCKBOT_ADMIN_EMAILS
          ? { adminEmails: env.FROCKBOT_ADMIN_EMAILS }
          : {}),
        applicationHashFor: async (userId) =>
          (await userConfigurationStub(env, userId).activeApplicationHash({
            schemaVersion: 1,
            userId,
          })) ?? env.DEFAULT_APPLICATION_HASH,
        nativeAppletBootstrap: (userId, appletId, navigationEpoch) =>
          runtimeExports
            .UserBotState({ props: { userId } })
            .nativeAppletBootstrap({
              schemaVersion: 1,
              userId,
              appletId,
              navigationEpoch,
            }),
        botStateFor: (userId) =>
          runtimeExports.UserBotState({ props: { userId } }),
        userConfigurationFor: (userId): UserConfigurationBinding =>
          userConfigurationStub(env, userId),
        botConfigurationFor: (userId, botId): BotConfigurationBinding =>
          botStateStub(env, userId, botId),
        ...(env.APPLET_VIEWER_SECRET
          ? { appletViewerSecret: env.APPLET_VIEWER_SECRET }
          : {}),
        appletStateFor: (userId, appletId) =>
          env.APPLET_STATES.get(
            env.APPLET_STATES.idFromName(appletStateNameV1(userId, appletId)),
          ),
        openVoiceDictation: (userId, request) =>
          openVoiceDictation(env, userId, request),
        openBotStateChannel: (userId, botId, request, context) =>
          openOwnedBotStateChannel(env, userId, botId, request, context),
        ...(env.PACKAGE_CATALOG
          ? { catalog: new R2PackageCatalog(env.PACKAGE_CATALOG) }
          : {}),
        backendContributions: [...mountedBackend.contributions],
        debug: debugSurface(env),
        ...(env.WORKSPACE_SEED_TOKEN
          ? {
              workspaceSeed: {
                token: env.WORKSPACE_SEED_TOKEN,
                write: (userId, botId, request) =>
                  botStateStub(env, userId, botId).writeUserWorkspaceFileV1({
                    schemaVersion: 1,
                    userId,
                    botId,
                    ...request,
                  }),
              },
            }
          : {}),
        allowedClientOrigins: allowedClientOrigins(env),
        allowDevelopmentIdentity: env.ALLOW_DEVELOPMENT_AUTH === "true",
      });
      return await gateway(request);
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

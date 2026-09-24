import { prepaidComputerHost } from "./billing-computer.js";
import { decodeModelRates } from "@frockbot/app/billing/model";
import type { BillingAccountRpc } from "./billing.js";
import {
  hostedBillingEnabledV1,
  type BillingSwitchEnv,
} from "./billing-readiness.js";
import { cleanNotificationTestState } from "./notification-state-cleanup.js";
import { cleanHiddenBotNotifications } from "./hidden-bot-notifications-cleanup.js";
import { cleanRetiredRoutineStateV1 } from "./routine-state-cleanup.js";
import { cleanUnpreparedRunsV1 } from "./prepared-input-cleanup.js";
import { cleanSupersedeStateV1 } from "./supersede-cleanup.js";
import { cleanProjectEventsV1 } from "./project-events-cleanup.js";
import { cleanUndecodableSkillIndexesV1 } from "./skill-index-cleanup.js";
import {
  messageIdV1,
  visibleMessageRecordsV1,
  type MessageNotice,
} from "@frockbot/app/notifications/messages";
import {
  PUSH_OUTBOX_DRAIN_LIMIT,
  PUSH_OUTBOX_PREFIX,
  PUSH_READ_KEY,
} from "@frockbot/app/notifications/storage-keys";
import {
  UNREAD_STATE_KEY,
  optionalUnreadStateV1,
} from "@frockbot/app/shell/unread";
import type { PushUpdate } from "./push.js";
import { cleanIncidentTestChatsV1 } from "./test-chat-cleanup.js";
import { cleanBotAvatarTestState } from "./avatar-state-cleanup.js";
import { cleanBotProfileMirrorTestState } from "./directory-profile-cleanup.js";
import { cleanRetiredPublicationStateV1 } from "./publication-state-cleanup.js";
import { projectUnprojectedSessionsV1 } from "./working-context-cleanup.js";
import { cleanRetiredComputerScreenshotsV1 } from "./computer-screenshot-cleanup.js";
import { computerBotPathKeyV1 } from "@frockbot/computer/core/bot-path";
import {
  decodeStoredComputerFrameV1,
  type StoredComputerFrameV1,
} from "@frockbot/computer/frame";
import {
  deliverProfileMirrorV1,
  PROFILE_MIRROR_KEY_V1,
} from "@frockbot/app/flock/profile-mirror";
import { DurableObject } from "cloudflare:workers";
import {
  BotStateChannel,
  BOT_STATE_CHANNEL_INTERNAL_PATH,
} from "./bot-state-channel.js";
import { foundationShellApplicationV1 } from "@frockbot/app/runtime";
import {
  computerBotContribution,
  createFoundationBackendContributions,
  createFoundationMountedContributionsV1,
  flockBotContribution,
  backendDescriptorsV1,
  shellBotContribution,
} from "@frockbot/app/contributions";
import { ComputerRegistry } from "@frockbot/computer/core/host";
import { mountRuntimeFeaturesV1 } from "@frockbot/core/contracts";
import {
  computerHostBindingV1,
  createComputerHostV1,
} from "./computer-host.js";
import type { ShellComputerHostOptionsV1 } from "@frockbot/app/shell/backend-runtime";
import {
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeUserSettingsViewV1,
  decodeCompositionGenerationIdV1,
  decodeRevertCompositionCommandV1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
  userTimezoneV1,
  type BotSettingsViewV1,
  type RevertCompositionCommandV1,
} from "@frockbot/core/configuration";
import {
  BotDurableAuthority,
  IDENTITY_KEY,
  type BotIdentity,
} from "@frockbot/core/durable";
import type {
  OwnedBotTurnCommand,
  ShellBotBackendContribution,
} from "@frockbot/app/shell/backend";
import type { BotStateEnv } from "@frockbot/app/shell/backend-state";
import type { BotStateRpcTargetV1 } from "@frockbot/app/shell/durable-rpc-targets";
import { createBindingEmailSenderV1 } from "@frockbot/app/email/sender";
import {
  acceptSubagentTask,
  claimTaskMessages,
  listTasks,
  readSubagentTaskContext,
  readTask,
  settleTask,
  stopSubagentTask,
  stopTaskForUser,
} from "@frockbot/app/subagents/bot";
import {
  isolateConnection,
  isolateModelTransport,
  isolateAuthority,
  isolateInvokeModel,
  isolateSettings,
  isolateStorageDelete,
  isolateStorageGet,
  isolateStorageList,
  isolateStoragePut,
  type IsolateCallScopeV1,
  isolateMemoryForget,
  isolateMemoryRead,
  isolateMemoryWrite,
  isolateEmail,
  isolateSchedule,
  isolateWorkspaceDelete,
  isolateWorkspaceList,
  isolateWorkspaceRead,
  isolateWorkspaceStat,
  isolateWorkspaceWrite,
} from "@frockbot/app/isolates/bot";
import { deliverMachineResult } from "@frockbot/app/machine/bot";
import {
  listOwnSkillDocuments,
  listSkills,
  writeUserSkill,
} from "@frockbot/app/skills/bot";
import {
  archiveEligible,
  refreshScheduledWork,
} from "@frockbot/app/shell/identity";
import { stopRun } from "@frockbot/app/shell/turn";
import {
  isVoiceReplyOutboxEntryV1,
  VOICE_REPLY_OUTBOX_PREFIX_V1,
} from "@frockbot/app/shell/voice-reply";
import {
  acknowledgeNotification,
  listNotifications,
} from "@frockbot/app/notifications/bot";
import {
  connectionTriggersFromUserV1,
  deliverConnectEvent,
  deliverRoutineHook,
  executeRoutineCommand,
  executeRoutineInboxCommand,
  listRoutineInbox,
  listRoutineRuns,
  listRoutines,
  projectRoutineAccountTimezoneV1,
  readRoutinesFrame,
  readRoutineRun,
} from "@frockbot/app/routines/bot";
import {
  BOT_CONFIGURATION_KEY,
  executeConfiguration,
  readBotSettingsV1,
  readConfiguration,
  resolveConfiguration,
  userConfigurationV1,
} from "@frockbot/app/settings/bot";
import { decideApproval, listApprovals } from "@frockbot/app/approvals/bot";
import { cardAction, listCards, readCardView } from "@frockbot/app/cards/bot";
import {
  getCompositionGeneration,
  listCompositionGenerations,
  revertComposition,
} from "@frockbot/app/shell/composition-views";
import { executeUnreadCommand, readUnread } from "@frockbot/app/shell/unread";
import { appendAnnouncement } from "@frockbot/app/shell/reads";
import type { FlockBotBackendContribution } from "@frockbot/app/flock/bot";
import type { ComputerBotBackendContribution } from "@frockbot/computer/bot";
import { decodeComputerCommandV1 } from "@frockbot/computer/protocol";
import {
  decodeBotLifecycleCommandV1,
  decodeBotRegistrationV1,
  decodeUpdateAvatarCommandV1,
  decodeUpdateVoiceCommandV1,
  decodeUpdateLookCommandV1,
  decodeLookIdentityViewV1,
  type BotLifecycleCommandV1,
  type BotRegistrationV1,
} from "@frockbot/app/flock/shared";
import { decodeBotDebugQueryV1 } from "@frockbot/app/shell/debug-protocol";
import {
  decodeClientRunListQueryV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunStopCommandV1,
  type ClientRunListQueryV1,
  type ClientRunLookupQueryV1,
  type ClientRunStopCommandV1,
} from "@frockbot/app/shell/run-protocol";
import {
  decodeBotUnreadCommandV1,
  type BotUnreadCommandV1,
} from "@frockbot/app/shell/unread";
import {
  decodeApprovalDecisionCommandV1,
  type ApprovalDecisionCommandV1,
} from "@frockbot/app/shell/approvals";
import {
  decodeCardActionCommandV1,
  decodeCardSurfaceIdV1,
  type CardActionCommandV1,
} from "@frockbot/app/shell/cards";
import {
  decodeIsolateMemoryReadRequestV1,
  decodeIsolateStorageDeleteRequestV1,
  decodeIsolateStorageGetRequestV1,
  decodeIsolateStorageListRequestV1,
  decodeIsolateStoragePutRequestV1,
  decodeIsolateMemoryWriteRequestV1,
  decodeIsolateEmailRequestV1,
  decodeIsolateScheduleRequestV1,
  decodeIsolateWorkspaceDeleteRequestV1,
  decodeIsolateWorkspaceListRequestV1,
  decodeIsolateWorkspacePathV1,
  decodeIsolateWorkspaceWriteRequestV1,
  decodeNormalizedModelRequestV1,
} from "@frockbot/core/contracts";
import type {
  NormalizedModelRequest,
  WorkspaceFilesV1,
  WorkspaceGenerationsV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceSyncEffectsV1,
} from "@frockbot/core/contracts";
import { decodeWorkspacePathV1 } from "@frockbot/core/contracts";

function hostedModelLimits(raw?: string) {
  return Object.fromEntries(
    Object.entries(decodeModelRates(raw)).map(([model, rate]) => [
      model,
      {
        inputTokens: rate.maximumInputTokens,
        outputTokens: rate.maximumOutputTokens,
      },
    ]),
  );
}

/** Base64 without a Node Buffer: this object runs in workerd. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
import {
  decodeRoutineCommandV1,
  decodeRoutineInboxCommandV1,
  type RoutineCommandV1,
  type RoutineInboxCommandV1,
} from "@frockbot/app/routines/shared";
import {
  decodeRoutineHookDeliveryV1,
  type RoutineHookDeliveryV1,
} from "@frockbot/app/routines/hook";
import {
  decodeSubagentRunTaskRequestV1,
  type SubagentRunTaskRequestV1,
} from "@frockbot/app/subagents/durable-binding";
import {
  decodeTaskOutcomeV1,
  type TaskOutcomeV1,
} from "@frockbot/app/subagents/records";
import {
  decodeMachineResultDeliveryV1,
  type MachineResultDeliveryV1,
} from "@frockbot/app/machine/delivery";
import {
  createDurableWorkspaceFilesV1,
  createR2ObjectBucketV1,
  deleteBotWorkspaceRootsV1,
} from "./workspace.js";
import {
  publishWorkspaceSkillGenerationV1,
  readDurableSkillIndexV1,
} from "@frockbot/app/skills/index-store";
import { decodeSkillMetadataIndexV1 } from "@frockbot/app/skills/metadata-index";
import { reseedInstructionRootV1 } from "@frockbot/app/skills/reseed";
import {
  workspaceObjectPrefixV1,
  type WorkspaceGenerationPublicationV1,
} from "@frockbot/core/workspace-store";
import { cleanRetiredMemoryFactObjectsV1 } from "@frockbot/app/memory/cleanup";
import type { ClientWorkspaceFileV1 } from "./contracts.js";
import {
  DurableWorkspaceGenerations,
  DurableWorkspaceSyncEffects,
} from "@frockbot/core/durable";
import type { MemoryGroupsV1 } from "@frockbot/app/memory/groups";
import { memoryMembershipRevisionV1 } from "@frockbot/app/memory/engine-tools";
import {
  decodeMemoryChunkIndexEntryV1,
  memoryChunkIndexEntriesV1,
  MEMORY_CHUNK_INDEX_PREFIX_V1,
  type MemoryChunkIndexWriterV1,
} from "@frockbot/app/memory/chunk-index";
import {
  searchRowsFromClientRunV1,
  type SearchSinkV1,
} from "@frockbot/app/search";
import {
  createBotSearchRowPageV1,
  createUserSearchSinkV1,
  type UserSearchRpc,
} from "./search.js";
import {
  AuditOutboxV1,
  auditEntriesFromStoredRunV1,
  auditEntryForDeviceUseV1,
  decodeDeviceUseV1,
  DEVICE_USE_PAGE_DONE_V1,
  DeviceUseLogV1,
  type AuditSinkV1,
  type DeviceUseV1,
} from "@frockbot/app/audit";
import {
  createBotAuditEntryPageV1,
  createUserAuditSinkV1,
  type UserAuditRpc,
} from "./audit.js";
import {
  createRoutedWorkspaceGenerationsV1,
  createUserMemoryGroupsV1,
  createUserWorkspaceGenerationsV1,
  type UserMemoryRpc,
} from "./memory.js";
import { createMemoryEmbedder } from "@frockbot/app/memory/embeddings";
import { MemoryRecordsV1 } from "@frockbot/app/memory/owner";
import { createVectorMemorySearchV1 } from "@frockbot/app/memory/semantic";
import {
  createBotMemoryEngineV1,
  createUserMemoryRecordsRemoteV1,
  drainDurableMemoryV1,
  durableObjectHasSqlV1,
} from "./memory-records.js";
import type { MemoryEngineV1 } from "@frockbot/app/memory/engine";
import type {
  MemoryAiBinding,
  MemoryVectorIndex,
} from "@frockbot/app/memory/types";
import {
  createFrockAiGatewayHostV1,
  type FrockAiGatewayHostV1,
} from "./frock-ai.js";
import {
  decodeBotAgentRunRpcV1,
  decodeBotRunRpcV1,
  decodeBotVoiceRunRpcV1,
  decodeVoiceChatResultRpcV1,
  decodeVoiceCallTranscriptRpcV1,
  decodeBotGroupTurnRpcV1,
  decodeRpcEnvelopeV1,
  rpcBoolean,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcJsonSnapshotV1,
  rpcObject,
  rpcOrigin,
  rpcPattern,
  rpcPluginIdOrNull,
  rpcString,
} from "./durable-rpc.js";
import { answeredEntryV1, loggedEntryV1 } from "./entry-boundary.js";
import {
  PLUGIN_ID_MAX_LENGTH_V1,
  PLUGIN_ID_V1,
  PluginEnablementConflictError,
  readPluginEnablementV1,
  setPluginEnabledV1,
} from "@frockbot/app/plugins/enablement";
import {
  readBotPluginsFrameV1,
  setBotPluginEnabledV1,
} from "@frockbot/app/plugins/bot";
import {
  decodePluginToolCommandV1,
  decodeSetBotPluginEnabledCommandV1,
} from "@frockbot/app/plugins/page";
import { executeBotPluginToolV1 } from "@frockbot/app/plugins/views-bot";
import {
  applyPanelFocusV1,
  openFocusedPanelV1,
  panelDeviceUserV1,
  readFocusedPanelV1,
} from "@frockbot/app/plugins/panels-bot";
import { cleanBotAppletsV1 } from "./plugin-panels-cleanup.js";
import { cleanPackagePageShapesV1 } from "./package-page-shapes-cleanup.js";
import {
  groupOriginOfRunV1,
  groupTurnStateOfRunV1,
  groupWaitingKeyV1,
} from "@frockbot/app/groups/bot";
import { groupChatObjectNameV1 } from "@frockbot/app/groups/shared";
import {
  assembleBotThemeV1,
  themeAssembleDeadlineV1,
} from "@frockbot/app/theme/assemble";
import { decodeThemeDocumentV1, decodeBotLookV1 } from "@frockbot/core/theme";

function isFrockAiGatewayBindingV1(
  value: BotStateEnv["AI"],
): value is NonNullable<BotStateEnv["AI"]> & Pick<Ai, "gateway"> {
  return (
    value !== undefined && typeof Reflect.get(value, "gateway") === "function"
  );
}

function optionalWorkerVarV1(env: object, name: string): string | undefined {
  const value = Reflect.get(env, name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A Frock AI setting, read under its current name and then under the
 * pre-rename `FLOCK_AI_*` one. The vars are deployment configuration and the
 * secrets are set outside this repo, so the fallback is what lets the rename
 * land before they are re-added under the new names. Remove it once every
 * environment names them `FROCK_AI_*`.
 */
export function frockAiWorkerVarV1(
  env: object,
  name: `FROCK_AI_${string}`,
): string | undefined {
  return (
    optionalWorkerVarV1(env, name) ??
    optionalWorkerVarV1(env, `FLOCK_AI_${name.slice("FROCK_AI_".length)}`)
  );
}

/** One Vectorize mutation per alarm firing, at the Workers binding limit. */
export const MEMORY_VECTOR_DELETE_BATCH_SIZE_V1 = 1_000;

/**
 * Voice answers handed over per drain pass. A call is one person speaking, so
 * a queue this long already means something upstream is stuck; the bound is
 * there to keep one pass from being unbounded, not because it is ever reached.
 */
export const VOICE_REPLY_DRAIN_LIMIT_V1 = 32;
const MEMORY_VECTOR_PURGE_JOURNAL_KEY_V1 = "memory:vector-purge:v1";
const MEMORY_VECTOR_PURGE_RETRY_DELAY_MS_V1 = 1_000;

interface MemoryVectorPurgeJournalV1 {
  schemaVersion: 1;
  userId: string;
  botId: string;
  status: "pending" | "complete" | "skipped";
  deleted: number;
  note?: string;
}

function decodeMemoryVectorPurgeJournalV1(
  input: unknown,
): MemoryVectorPurgeJournalV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Stored Memory vector purge journal is invalid");
  }
  const allowed = new Set([
    "schemaVersion",
    "userId",
    "botId",
    "status",
    "deleted",
    "note",
  ]);
  const status = Reflect.get(input, "status");
  const note = Reflect.get(input, "note");
  if (
    Object.keys(input).some((field) => !allowed.has(field)) ||
    Reflect.get(input, "schemaVersion") !== 1 ||
    typeof Reflect.get(input, "userId") !== "string" ||
    typeof Reflect.get(input, "botId") !== "string" ||
    (status !== "pending" && status !== "complete" && status !== "skipped") ||
    !Number.isSafeInteger(Reflect.get(input, "deleted")) ||
    (Reflect.get(input, "deleted") as number) < 0 ||
    (note !== undefined && typeof note !== "string")
  ) {
    throw new Error("Stored Memory vector purge journal is invalid");
  }
  return {
    schemaVersion: 1,
    userId: Reflect.get(input, "userId") as string,
    botId: Reflect.get(input, "botId") as string,
    status,
    deleted: Reflect.get(input, "deleted") as number,
    ...(typeof note === "string" ? { note } : {}),
  };
}

export type { BotStateEnv, OwnedBotTurnCommand };

export interface BotStateDependencies {
  outboundFetch?: typeof fetch;
}

function decodeBotIdentityRpcV1(input: unknown): {
  userId: string;
  botId: string;
} {
  const request = decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
  });
  if (typeof request.userId !== "string" || typeof request.botId !== "string") {
    throw new Error("Computer identity RPC was not decoded");
  }
  return {
    userId: request.userId,
    botId: request.botId,
  };
}

function decodeIsolateCallRpcV1(
  input: unknown,
  decodeRequest: (value: unknown) => unknown,
) {
  return decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    runId: rpcIdentifier,
    sessionId: rpcString(257),
    turnId: rpcIdentifier,
    packageId: rpcIdentifier,
    generationId: rpcIdentifier,
    request: rpcDecoded(decodeRequest),
  });
}

export class BotState
  extends DurableObject<BotStateEnv>
  implements BotStateRpcTargetV1
{
  private readonly outboundFetch?: typeof fetch;
  /**
   * The environment the Shell Package runs under: the Durable Object's
   * bindings plus the Workspace file surface built over them. `WORKSPACE_FILES`
   * is not a Worker binding — it is `WorkspaceFilesV1` over the durable-root
   * object store, with its generations recorded in this object — so it is
   * constructed here and never reaches the deployed bindings map.
   */
  protected readonly backendEnv: BotStateEnv & {
    FROCK_AI?: FrockAiGatewayHostV1;
    WORKSPACE_FILES?: WorkspaceFilesV1;
    MEMORY_WORKSPACE_FILES?: WorkspaceFilesV1;
    MEMORY_GROUPS?: MemoryGroupsV1;
    MEMORY_RECORDS?: MemoryRecordsV1;
    MEMORY_CHUNK_INDEX?: MemoryChunkIndexWriterV1;
    WORKSPACE_SYNC_FILES?: WorkspaceFilesV1;
    WORKSPACE_SYNC_EFFECTS?: WorkspaceSyncEffectsV1;
    WORKSPACE_SYNC_GENERATIONS?: WorkspaceGenerationsV1;
    /** The User-scoped transcript index a settled Turn projects into. */
    SEARCH_SINK?: SearchSinkV1;
    /** The User-scoped audit table this object's outbox drains into. */
    AUDIT_SINK?: AuditSinkV1;
  };
  /** The identity the Workspace and Memory surfaces above were built for. */
  private surfacesFor: string | undefined;
  /**
   * This object's generation ledger — one instance, for every root it owns.
   *
   * "The Bot's Durable Object is the authority for everything Bot-scoped", and
   * an authority that exists twice is not one: each instance caches the
   * minting cursor while resident, so two of them can mint the same id for two
   * different files.
   */
  protected readonly workspaceGenerations: DurableWorkspaceGenerations =
    new DurableWorkspaceGenerations({ state: this.ctx });
  /** Durable invalidation log plus hibernatable observer transport. */
  private readonly stateChannel = new BotStateChannel(this.ctx);
  private mounted:
    | Promise<{
        shell: ShellBotBackendContribution;
        flock: FlockBotBackendContribution;
        computer: ComputerBotBackendContribution;
        dispose(): Promise<void>;
      }>
    | undefined;

  /**
   * Adopt the User's Profile timezone before a Routine is listed or written.
   *
   * Best effort: the projection already holds a zone, and a User object that
   * cannot be read is a "next run" column computed under the zone last
   * projected — never a Routines list that refuses to open.
   */
  private async syncRoutineTimezone(
    identity: BotIdentity,
    shell: ShellBotBackendContribution,
  ): Promise<void> {
    try {
      const rpc = this.env.USER_CONFIGURATIONS.get(
        this.env.USER_CONFIGURATIONS.idFromName(identity.userId),
      ) as unknown as { readConfiguration(input: unknown): Promise<unknown> };
      const user = decodeUserSettingsViewV1(
        rpcJsonSnapshotV1(
          await rpc.readConfiguration({
            schemaVersion: 1,
            userId: identity.userId,
            view: 2,
          }),
        ),
      );
      await projectRoutineAccountTimezoneV1(
        shell.state,
        userTimezoneV1(user.profile),
        user.revision,
      );
    } catch {
      // Left at the zone last projected, which the next Turn refreshes.
    }
  }

  constructor(
    ctx: DurableObjectState,
    env: BotStateEnv,
    dependencies: BotStateDependencies = {},
  ) {
    super(ctx, env);
    // Runs before any request or alarm can mount the old conversation.
    this.ctx.blockConcurrencyWhile(async () => {
      await cleanIncidentTestChatsV1(this.ctx.storage);
      await cleanNotificationTestState(this.ctx.storage);
      await cleanHiddenBotNotifications(this.ctx.storage);
      await cleanBotAvatarTestState(this.ctx.storage);
      await cleanBotProfileMirrorTestState(this.ctx.storage);
      await cleanRetiredRoutineStateV1(this.ctx.storage);
      await cleanBotAppletsV1(this.ctx.storage);
      // Before anything decodes a run: a `superseded` record no longer parses.
      await cleanSupersedeStateV1(this.ctx.storage);
      // Before anything decodes a run or an event: a `directTool` run and a
      // `publish` sync no longer parse.
      await cleanPackagePageShapesV1(this.ctx.storage);
      await cleanProjectEventsV1(this.ctx.storage);
      await cleanUnpreparedRunsV1(this.ctx.storage);
      await cleanUndecodableSkillIndexesV1(this.ctx.storage);
      await cleanRetiredPublicationStateV1(this.ctx.storage);
      await projectUnprojectedSessionsV1(this.ctx.storage);
      const identity = await this.ctx.storage.get<{
        userId: string;
        botId: string;
      }>(IDENTITY_KEY);
      if (identity && this.env.MEMORY_FILES) {
        await reseedInstructionRootV1({
          storage: this.ctx.storage,
          bucket: createR2ObjectBucketV1(this.env.MEMORY_FILES),
          root: {
            kind: "bot-instructions",
            userId: identity.userId,
            botId: identity.botId,
          },
          receiptKey: "maintenance:skill-index:bot:2026-09-22",
        });
        const bucket = createR2ObjectBucketV1(this.env.MEMORY_FILES);
        const listing = {
          list: async (options: {
            prefix: string;
            limit: number;
            cursor?: string;
          }) => {
            const page = await bucket.list(options);
            return {
              keys: page.objects.map((object) => object.key),
              ...(page.cursor ? { cursor: page.cursor } : {}),
              truncated: page.truncated,
            };
          },
          delete: (key: string) => bucket.delete(key),
        };
        await cleanRetiredMemoryFactObjectsV1(
          this.ctx.storage,
          listing,
          workspaceObjectPrefixV1({
            kind: "bot-memory",
            userId: identity.userId,
            botId: identity.botId,
          }),
        );
        await cleanRetiredComputerScreenshotsV1(
          this.ctx.storage,
          listing,
          `${workspaceObjectPrefixV1({
            kind: "package-declared",
            userId: identity.userId,
            packageId: "computer",
            rootId: "screenshots",
          })}${computerBotPathKeyV1(identity.botId)}/`,
        );
      }
      if (durableObjectHasSqlV1(this.ctx.storage)) {
        const memoryDue = createBotMemoryEngineV1(
          this.ctx.storage,
        ).nextWakeupAt();
        if (
          memoryDue !== undefined &&
          (await this.ctx.storage.getAlarm()) === null
        ) {
          await this.ctx.storage.setAlarm(memoryDue);
        }
      }
    });
    this.outboundFetch = dependencies.outboundFetch;
    const emailSender = createBindingEmailSenderV1(
      env as Parameters<typeof createBindingEmailSenderV1>[0],
    );
    // The surfaces are built per identity in `bindSurfaces`, not here: they
    // carry the `owner` guard, and a Durable Object learns which User it
    // serves from the RPC that addresses it, never from its constructor.
    this.backendEnv = {
      ...env,
      ...(hostedBillingEnabledV1(env as BillingSwitchEnv) && env.COMPUTER_HOST
        ? {
            COMPUTER_HOST: prepaidComputerHost(
              env.COMPUTER_HOST,
              (userId) =>
                env.USER_CONFIGURATIONS.get(
                  env.USER_CONFIGURATIONS.idFromName(userId),
                ) as unknown as BillingAccountRpc,
            ),
          }
        : {}),
      ...(hostedBillingEnabledV1(env as BillingSwitchEnv)
        ? {
            BILLING: (userId: string, botId: string, sessionId: string) => {
              const account = env.USER_CONFIGURATIONS.get(
                env.USER_CONFIGURATIONS.idFromName(userId),
              ) as unknown as BillingAccountRpc;
              return {
                botId,
                sessionId,
                rates: decodeModelRates(
                  (env as BotStateEnv & { BILLING_MODEL_RATES?: string })
                    .BILLING_MODEL_RATES,
                ),
                account: {
                  reserve: (
                    reservation: import("@frockbot/app/billing/ledger").UsageReservation,
                  ) => account.reserveUsage({ userId, reservation }),
                  settle: (
                    settlement: import("@frockbot/app/billing/ledger").UsageSettlement,
                  ) => account.settleUsage({ userId, settlement }),
                },
              };
            },
          }
        : {}),
      // The deployment's own sender, when this one bound both halves of it.
      // Nothing is constructed without them, so a Worker with no email
      // binding carries no sender rather than one that fails on use.
      ...(emailSender === undefined ? {} : { EMAIL_SENDER: emailSender }),
      MEMORY_CHUNK_INDEX: {
        record: async (vectorIds) => {
          const entries = memoryChunkIndexEntriesV1(vectorIds);
          if (Object.keys(entries).length > 0) {
            await this.ctx.storage.put(entries);
          }
        },
      },
      ...(isFrockAiGatewayBindingV1(env.AI)
        ? {
            FROCK_AI: createFrockAiGatewayHostV1(env.AI, {
              gatewayId: frockAiWorkerVarV1(env, "FROCK_AI_GATEWAY_ID"),
              autoRoute: frockAiWorkerVarV1(env, "FROCK_AI_AUTO_ROUTE"),
              accountId: frockAiWorkerVarV1(env, "FROCK_AI_ACCOUNT_ID"),
              token: frockAiWorkerVarV1(env, "FROCK_AI_GATEWAY_TOKEN"),
              ...(hostedBillingEnabledV1(env as BillingSwitchEnv)
                ? {
                    billingLimits: hostedModelLimits(
                      (env as BotStateEnv & { BILLING_MODEL_RATES?: string })
                        .BILLING_MODEL_RATES,
                    ),
                  }
                : {}),
            }),
          }
        : {}),
    };
  }

  private contributions(): Promise<{
    shell: ShellBotBackendContribution;
    flock: FlockBotBackendContribution;
    computer: ComputerBotBackendContribution;
    dispose(): Promise<void>;
  }> {
    if (!this.mounted) {
      const pending = (async () => {
        const computers = new ComputerRegistry();
        // The Contribution's own registry, over the same host the Turn's
        // runtime mounts. `./computer-host.ts` is where this deployment
        // chooses which host that is.
        const binding = computerHostBindingV1(this.backendEnv);
        const computerConfigured = Boolean(binding);
        const disposeComputers = await mountRuntimeFeaturesV1({ computers }, [
          ({ computers: registry }) =>
            binding
              ? registry.register(createComputerHostV1(binding))
              : undefined,
        ]);
        // Where each descriptor's mounted value lands as the mount runs. The
        // Shell and Flock Contributions need each other, and each reaches the
        // other by naming the table entry it imported.
        const mountedContributions = createFoundationMountedContributionsV1();
        const requireShell = (): ShellBotBackendContribution => {
          const shell = mountedContributions.get(shellBotContribution);
          if (!shell) throw new Error("Shell Bot Contribution is unavailable");
          return shell;
        };
        const mounted = await createFoundationBackendContributions<
          | ShellBotBackendContribution
          | FlockBotBackendContribution
          | ComputerBotBackendContribution
        >({
          backendHost: "bot",
          mountedContributions,
          shell: {
            ...foundationShellApplicationV1,
            state: this.ctx,
            env: this.backendEnv,
            outboundFetch: this.outboundFetch,
            messagesCommitted: () => {
              this.ctx.waitUntil(this.drainPush());
              this.ctx.waitUntil(
                (async () => {
                  const shell = this.mounted
                    ? (await this.mounted).shell
                    : undefined;
                  this.nudgeGroup(
                    await shell?.state.authority.readActiveRunId(),
                  );
                })().catch(() => undefined),
              );
            },
            deliverPublication: (updates) => {
              this.stateChannel.broadcastCommitted(updates);
              return Promise.resolve();
            },
            runSettled: (runId) => {
              this.nudgeGroup(runId);
              return this.projectSettled(requireShell(), runId);
            },
            // The Durable Object owns the kernel authority; the Shell
            // Package supplies only its configuration and Composition
            // hooks. Chat delivery is a commit contribution, not a
            // storage interceptor: an observed write is not proof it
            // committed.
            createAuthority: (options) => new BotDurableAuthority(options),
            // The Computer Contribution's projection cache and its share of
            // the authority's one durable alarm, reached through the table
            // once it has mounted.
            // The same host, for the Turn's runtime. The app is handed a
            // factory because two of its seams belong to one Turn.
            ...(binding
              ? {
                  computerHost: (options: ShellComputerHostOptionsV1) =>
                    createComputerHostV1(binding, options),
                }
              : {}),
            invalidateComputerProjectionFile: (userId, botId, kind) => {
              mountedContributions
                .get(computerBotContribution)
                ?.invalidateProjectionFile(userId, botId, kind);
              // Dropping the resident cache only makes the next read
              // honest. The notice is what makes an attached client take
              // that read, so a new frame reaches the card in about a
              // second instead of at the next projection poll.
              this.stateChannel.noticeComputer();
            },
            scheduledDeadlines: async (transaction) => [
              ...((await mountedContributions
                .get(computerBotContribution)
                ?.scheduledDeadlines(transaction)) ?? []),
              ...((
                await transaction.list({ prefix: PUSH_OUTBOX_PREFIX, limit: 1 })
              ).size || (await transaction.get(PUSH_READ_KEY))
                ? [Date.now() + 30_000]
                : []),
              ...(await themeAssembleDeadlineV1(transaction)),
              ...(durableObjectHasSqlV1(this.ctx.storage)
                ? (() => {
                    const due = this.memoryEngine().nextWakeupAt();
                    return due === undefined ? [] : [due];
                  })()
                : []),
            ],
            scheduledWorkInFlight: () =>
              mountedContributions
                .get(computerBotContribution)
                ?.scheduledWorkInFlight() ?? false,
            deferScheduledWork: (transaction) =>
              mountedContributions
                .get(computerBotContribution)
                ?.deferScheduledWork(transaction) ?? Promise.resolve(),
            settleScheduledWork: async () => {
              await (mountedContributions
                .get(computerBotContribution)
                ?.settleScheduledWork() ?? Promise.resolve());
              await this.assembleThemeIfDue();
              await this.deliverProfileMirror();
              await this.drainMemoryProcessing();
            },
            // An archived Bot admits no configuration command; the Flock
            // Contribution owns that durable lifecycle state.
            assertLifecycleActive: (storage, botId) => {
              const flock = mountedContributions.get(flockBotContribution);
              if (!flock) {
                throw new Error("Flock Bot Contribution is unavailable");
              }
              return flock.assertActive(storage, botId);
            },
          },
          flock: {
            storage: this.ctx.storage,
            materializeSettings: async (registration, userId) => {
              await requireShell().materializeSettings(
                { userId, botId: registration.botId },
                {
                  name: registration.initialName,
                  ...(registration.initialDescription === undefined
                    ? {}
                    : { description: registration.initialDescription }),
                },
              );
            },
            archiveEligible: (storage) => archiveEligible(storage),
            tearDown: (identity) => this.tearDown(identity),
          },
          computer: {
            storage: this.stateChannel.computerStorage,
            workspace: this.backendEnv.WORKSPACE_FILES,
            providerLabel: "Computer",
            configured: computerConfigured,
            openComputer: (userId, botId, effectId) => {
              const identity = { userId };
              if (!computers.assignment(identity)) {
                computers.assign(identity, "computer-host");
              }
              return computers.open(identity, { botId }, { effectId });
            },
          },
        });
        // Every Bot-host Contribution the application lists must have
        // mounted, and each of the three the Bot Durable Object depends on
        // must be one of them.
        const shell = mounted.get(shellBotContribution);
        const flock = mounted.get(flockBotContribution);
        const computer = mounted.get(computerBotContribution);
        if (
          !shell ||
          !flock ||
          !computer ||
          mounted.contributions.length !==
            backendDescriptorsV1.filter(
              (descriptor) => descriptor.host === "bot",
            ).length
        ) {
          await mounted.dispose();
          await disposeComputers();
          throw new Error(
            "Foundation requires Shell, Flock and Computer Bot backend Contributions",
          );
        }
        const alarmOwner = shell;
        this.stateChannel.setAlarmRefresher((transaction) =>
          refreshScheduledWork(alarmOwner.state, transaction),
        );
        return {
          shell,
          flock,
          computer,
          async dispose() {
            await mounted.dispose();
            await disposeComputers();
          },
        };
      })();
      this.mounted = pending;
      // A mount that failed is not a durable verdict. Memoizing the rejection
      // made one transient failure — an artifact read, a User RPC, a member
      // that would not resolve — final for the life of the object: every
      // later call awaited the same rejected promise, the recovery alarm
      // included, so nothing could heal it short of eviction. The next call
      // retries instead, exactly as `immutable-application.ts` already does.
      void pending.catch(() => {
        if (this.mounted === pending) this.mounted = undefined;
      });
    }
    return this.mounted;
  }

  private async registration(identity: {
    userId: string;
    botId: string;
  }): Promise<BotRegistrationV1> {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: USER_CONFIGURATIONS binds UserConfiguration; workers-types cannot infer its generated Flock RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      getBotRegistration(input: unknown): Promise<BotRegistrationV1>;
    };
    return decodeBotRegistrationV1(
      structuredClone(
        await rpc.getBotRegistration({ schemaVersion: 1, ...identity }),
      ),
    );
  }

  /** The User Durable Object, as this object's Memory authority. */
  private userMemoryRpc(userId: string): UserMemoryRpc {
    const id = this.env.USER_CONFIGURATIONS.idFromName(userId);
    // SAFETY: USER_CONFIGURATIONS binds UserConfiguration; workers-types cannot
    // infer its generated Memory RPC surface.
    return this.env.USER_CONFIGURATIONS.get(id) as unknown as UserMemoryRpc;
  }

  #memoryEngine: MemoryEngineV1 | undefined;

  private memoryEngine(): MemoryEngineV1 {
    this.#memoryEngine ??= createBotMemoryEngineV1(this.ctx.storage);
    return this.#memoryEngine;
  }

  private async drainMemoryProcessing(): Promise<void> {
    if (!durableObjectHasSqlV1(this.ctx.storage)) return;
    await drainDurableMemoryV1(this.memoryEngine(), {
      ...(this.env.MEMORY_INDEX
        ? { vectors: this.env.MEMORY_INDEX as MemoryVectorIndex }
        : {}),
      ...(this.env.AI ? { ai: this.env.AI as MemoryAiBinding } : {}),
    });
  }

  /**
   * Builds the Workspace and Memory file surfaces for one identity.
   *
   * Three surfaces, deliberately, because the store refuses to be two things
   * at once: `WORKSPACE_FILES` is the kernel surface and refuses every Memory
   * root; `MEMORY_WORKSPACE_FILES` is the Memory Package's and serves Memory
   * roots and nothing else; `WORKSPACE_SYNC_FILES` is the durable-root sync's,
   * the only surface that reads every root and the only one that accepts an
   * `unattributed` writer — a shell wrote the file and nothing recorded who.
   * The Memory surface routes a shared root's generations to the User Durable
   * Object, which is the authority for the generation records of the User
   * Memory root, while the Bot's own Memory root stays in this object.
   *
   * The sync's effect records stay here too: a push records its intent in the
   * Bot's Durable Object before it runs (§ Computer and Workspace), so an
   * interrupted push is read back rather than repeated.
   */
  protected async skillIndexLoad(identity: { userId: string; botId: string }) {
    const storage = this.ctx.storage;
    const bot = await readDurableSkillIndexV1(storage, {
      kind: "bot-instructions",
      userId: identity.userId,
      botId: identity.botId,
    });
    const userStub = this.env.USER_CONFIGURATIONS.get(
      this.env.USER_CONFIGURATIONS.idFromName(identity.userId),
    );
    const user = decodeSkillMetadataIndexV1(
      await userStub.readSkillIndex({
        schemaVersion: 1,
        userId: identity.userId,
        root: { kind: "user-instructions", userId: identity.userId },
      }),
    );
    return { bot, user, liveBot: bot, liveUser: user };
  }

  protected instructionPublication(
    userId: string,
  ): (event: WorkspaceGenerationPublicationV1) => Promise<void> {
    const storage = this.ctx.storage;
    const bucket = this.env.MEMORY_FILES;
    const objects = createR2ObjectBucketV1(bucket);
    const user = this.env.USER_CONFIGURATIONS.get(
      this.env.USER_CONFIGURATIONS.idFromName(userId),
    );
    return (event) =>
      publishWorkspaceSkillGenerationV1({
        event,
        userId,
        storage,
        bodies: {
          put: async (key, bytes) => {
            await objects.put(key, bytes);
          },
          get: async (key) => {
            const object = await objects.get(key);
            return object ? object.bytes() : undefined;
          },
          delete: (key) => objects.delete(key),
        },
        user,
      });
  }

  protected bindSurfaces(identity: { userId: string; botId: string }): void {
    const key = `${identity.userId}\u0000${identity.botId}`;
    if (this.surfacesFor === key) return;
    const owner = { userId: identity.userId };
    // One ledger per Durable Object, shared by every surface it builds. A
    // ledger caches its minting cursor while resident, so two instances on one
    // object can read one cursor and mint one generation id twice — two files
    // claiming one generation, which is the single thing the id exists to
    // prevent. The routed ledger is one instance too: the same Bot half serves
    // the Memory and sync surfaces, and only a shared Memory root is routed to
    // the User object.
    const bot = this.workspaceGenerations;
    const onInstructionPublication = this.instructionPublication(
      identity.userId,
    );
    const workspace = createDurableWorkspaceFilesV1(this.env, {
      owner,
      generations: bot,
      onInstructionPublication,
    });
    const rpc = this.userMemoryRpc(identity.userId);
    const routed = createRoutedWorkspaceGenerationsV1({
      bot,
      user: createUserWorkspaceGenerationsV1(rpc, identity.userId),
    });
    const memory = createDurableWorkspaceFilesV1(this.env, {
      owner,
      surface: "memory",
      generations: routed,
    });
    const sync = createDurableWorkspaceFilesV1(this.env, {
      owner,
      surface: "sync",
      generations: routed,
      onInstructionPublication,
    });
    if (workspace) this.backendEnv.WORKSPACE_FILES = workspace;
    if (sync) {
      this.backendEnv.WORKSPACE_SYNC_FILES = sync;
      this.backendEnv.WORKSPACE_SYNC_EFFECTS = new DurableWorkspaceSyncEffects({
        state: this.ctx,
      });
      this.backendEnv.WORKSPACE_SYNC_GENERATIONS = routed;
    }
    if (memory) {
      this.backendEnv.MEMORY_WORKSPACE_FILES = memory;
      this.backendEnv.MEMORY_GROUPS = createUserMemoryGroupsV1(rpc, identity);
    }
    if (durableObjectHasSqlV1(this.ctx.storage)) {
      const vectors = this.env.MEMORY_INDEX as MemoryVectorIndex | undefined;
      const ai = this.env.AI as MemoryAiBinding | undefined;
      this.backendEnv.MEMORY_RECORDS = new MemoryRecordsV1({
        owner: "bot",
        engine: this.memoryEngine(),
        remote: createUserMemoryRecordsRemoteV1(rpc, identity),
        ...(vectors && ai
          ? {
              semantic: createVectorMemorySearchV1(
                vectors,
                createMemoryEmbedder(ai),
              ),
            }
          : {}),
      });
    }
    // The transcript index is User-scoped state, so its authority is the User
    // Durable Object and this object reaches it through a narrow binding —
    // the same shape as `MEMORY_GROUPS` above. It is a projection, never an
    // authority, so nothing here waits on it and nothing here reads from it.
    this.backendEnv.SEARCH_SINK = createUserSearchSinkV1(
      rpc as unknown as UserSearchRpc,
      identity,
    );
    // The audit table is User-scoped too, and reached the same way — but
    // through a durable outbox rather than fire-and-forget, because
    // completeness is the parity item (register row 30b).
    this.backendEnv.AUDIT_SINK = createUserAuditSinkV1(
      rpc as unknown as UserAuditRpc,
      identity,
    );
    this.surfacesFor = key;
  }

  /**
   * Everything this Bot owns, destroyed. The Flock Contribution calls this on
   * `bot/delete` and writes its tombstone afterwards.
   *
   * Order matters. The object's existing alarm is cancelled first, then its
   * Bot-Memory vector ids are deleted from Vectorize in bounded alarm pages.
   * Only once the durable chunk index is empty do the durable keys go in one
   * `deleteAll()`:
   * the session event log and its runs, the transcript and conversations, the
   * Bot's Memory and Skills generation ledger, Routines and their schedules,
   * Subagent tasks, approvals, notifications, unread and sidebar preview, the
   * Package composition generations, and the state-channel log. Then the two
   * object-store roots the Bot owns, which are the only Bot-scoped state that
   * does not live in this object.
   *
   * If Vectorize is not bound (local development and workerd by default), the
   * journal records that the derived cleanup was skipped before teardown.
   *
   * The mount memo is dropped last so the next call to this object rebuilds
   * from empty storage, reads the tombstone the caller is about to write, and
   * refuses rather than materializing the Bot again. Dropping it also
   * guarantees no surviving Contribution re-arms the alarm from a stale
   * transaction.
   *
   * Idempotent, because the delete saga replays: an empty object has nothing
   * to delete and an empty prefix has nothing to list.
   */
  private async finishTearDown(identity: {
    userId: string;
    botId: string;
  }): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await deleteBotWorkspaceRootsV1(this.env, identity);
    this.mounted = undefined;
    this.surfacesFor = undefined;
  }

  /**
   * Delete one bounded page of this Bot's own Memory vectors.
   *
   * The index keys are the cursor. They leave storage only after the external
   * delete succeeds, so an eviction in either side of that boundary repeats a
   * harmless delete or resumes at the first id not yet acknowledged. The next
   * alarm is armed before the remote call: even a long Vectorize outage cannot
   * exhaust the platform's finite automatic alarm retries and strand data.
   */
  private async purgeMemoryVectorBatch(
    journal: MemoryVectorPurgeJournalV1,
  ): Promise<"complete" | "pending"> {
    const vectorize = this.env.MEMORY_INDEX;
    if (!vectorize) {
      await this.ctx.storage.put(MEMORY_VECTOR_PURGE_JOURNAL_KEY_V1, {
        ...journal,
        status: "skipped",
        note: "MEMORY_INDEX binding is absent; no Vectorize purge was available",
      } satisfies MemoryVectorPurgeJournalV1);
      return "complete";
    }

    const page = await this.ctx.storage.list<unknown>({
      prefix: MEMORY_CHUNK_INDEX_PREFIX_V1,
      limit: MEMORY_VECTOR_DELETE_BATCH_SIZE_V1,
    });
    if (page.size === 0) {
      await this.ctx.storage.put(MEMORY_VECTOR_PURGE_JOURNAL_KEY_V1, {
        ...journal,
        status: "complete",
      } satisfies MemoryVectorPurgeJournalV1);
      return "complete";
    }

    const entries = [...page].map(([key, value]) =>
      decodeMemoryChunkIndexEntryV1(key, value),
    );
    await this.ctx.storage.setAlarm(
      Date.now() + MEMORY_VECTOR_PURGE_RETRY_DELAY_MS_V1,
    );
    await vectorize.deleteByIds(entries.map((entry) => entry.vectorId));
    const keys = [...page.keys()];
    const deleted = journal.deleted + entries.length;
    const hasAnotherPage = page.size === MEMORY_VECTOR_DELETE_BATCH_SIZE_V1;
    await this.ctx.storage.transaction(async (storage) => {
      await storage.delete(keys);
      await storage.put(MEMORY_VECTOR_PURGE_JOURNAL_KEY_V1, {
        ...journal,
        status: hasAnotherPage ? "pending" : "complete",
        deleted,
      } satisfies MemoryVectorPurgeJournalV1);
      if (hasAnotherPage) {
        await storage.setAlarm(
          Date.now() + MEMORY_VECTOR_PURGE_RETRY_DELAY_MS_V1,
        );
      } else {
        await storage.deleteAlarm();
      }
    });
    return hasAnotherPage ? "pending" : "complete";
  }

  private async tearDown(identity: {
    userId: string;
    botId: string;
  }): Promise<"complete" | "pending"> {
    // A throttled channel notice and every pre-delete scheduled deadline must
    // stop before the alarm is repurposed for the purge journal.
    this.stateChannel.silence();
    const stored = await this.ctx.storage.get<unknown>(
      MEMORY_VECTOR_PURGE_JOURNAL_KEY_V1,
    );
    let journal: MemoryVectorPurgeJournalV1;
    if (stored === undefined) {
      await this.ctx.storage.deleteAlarm();
      journal = {
        schemaVersion: 1,
        ...identity,
        status: "pending",
        deleted: 0,
      };
      await this.ctx.storage.put(MEMORY_VECTOR_PURGE_JOURNAL_KEY_V1, journal);
    } else {
      journal = decodeMemoryVectorPurgeJournalV1(stored);
      if (
        journal.userId !== identity.userId ||
        journal.botId !== identity.botId
      ) {
        throw new Error("Memory vector purge journal identity does not match");
      }
    }
    const outcome =
      journal.status === "pending"
        ? await this.purgeMemoryVectorBatch(journal)
        : "complete";
    if (outcome === "pending") return outcome;
    await this.finishTearDown(identity);
    return "complete";
  }

  private async materialized(identity: { userId: string; botId: string }) {
    this.bindSurfaces(identity);
    const contributions = await this.contributions();
    const registration = await this.registration(identity);
    await contributions.flock.materialize(registration, identity.userId);
    return { ...contributions, registration };
  }

  private async contribution(): Promise<ShellBotBackendContribution> {
    return (await this.contributions()).shell;
  }

  async readConfiguration(input: unknown) {
    const request = decodeBotConfigurationReadRpcV1(input);
    const { shell } = await this.materialized({
      userId: request.userId,
      botId: request.botId,
    });
    return readConfiguration(shell.state, request);
  }

  async executeConfiguration(input: unknown) {
    const request = decodeBotConfigurationExecuteRpcV1(input);
    const { shell } = await this.materialized({
      userId: request.userId,
      botId: request.botId,
    });
    const receipt = await executeConfiguration(shell.state, request);
    if (
      receipt.status === "applied" &&
      (request.command.type === "bot/update-profile" ||
        request.command.type === "bot/set-profile")
    ) {
      this.ctx.waitUntil(this.deliverProfileMirror().catch(() => undefined));
    }
    if (request.command.type === "bot/set-package-settings") {
      this.ctx.waitUntil(
        this.assembleTheme({
          schemaVersion: 1,
          userId: request.userId,
          botId: request.botId,
        }).catch(() => undefined),
      );
    }
    return receipt;
  }

  /** Which of the User's installed Plugins this Bot runs (ADR 0026). */
  async readPluginEnablement(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return readPluginEnablementV1(shell.state.ctx.storage);
  }

  /**
   * Switches one Plugin for this Bot, fenced on the revision the caller read.
   * A stale revision is a receipt, not a thrown error: the caller re-reads and
   * decides again, the way every other revision-fenced command answers.
   */
  async setPluginEnabled(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      pluginId: rpcPattern(PLUGIN_ID_V1, PLUGIN_ID_MAX_LENGTH_V1),
      enabled: rpcBoolean,
      expectedRevision: rpcInteger({ minimum: 0, maximum: 1_000_000 }),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    try {
      const enablement = await setPluginEnabledV1(shell.state.ctx.storage, {
        pluginId: request.pluginId as string,
        enabled: request.enabled as boolean,
        expectedRevision: request.expectedRevision as number,
      });
      return { status: "applied" as const, enablement };
    } catch (error) {
      if (error instanceof PluginEnablementConflictError) {
        return {
          status: "conflict" as const,
          currentRevision: error.currentRevision,
        };
      }
      throw error;
    }
  }

  /** This Bot's Plugins page: one row per Plugin it could run, and whether it does. */
  async readBotPluginsFrame(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    // The page's read draws every section; a switch re-reads without them.
    return readBotPluginsFrameV1(shell.state, identity, undefined, {
      sections: true,
    });
  }

  /**
   * Runs the tool a section's control names, outside any Turn. A Plugin
   * that is off, has no section or no such tool is a rejection with the
   * reason, never a thrown error.
   */
  async executeBotPluginTool(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodePluginToolCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return executeBotPluginToolV1(
      shell.state,
      identity,
      request.command as ReturnType<typeof decodePluginToolCommandV1>,
    );
  }

  /** The canvas's one read: this Bot's panel bag, doors, and focused page. */
  async openFocusedPanel(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      appOrigin: rpcOrigin,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return openFocusedPanelV1(
      shell.state,
      identity,
      request.appOrigin as string,
    );
  }

  async readFocusedPanel(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const focus = await readFocusedPanelV1(shell.state.ctx.storage);
    return (
      focus ?? {
        schemaVersion: 1,
        pluginId: null,
        changedAt: new Date(0).toISOString(),
      }
    );
  }

  /**
   * Records a Plugin page's use of a device ability once the client that
   * opened it says it has ended. Kept here first, so a rebuild reproduces the
   * row, then queued like any other; a retry of the same use is one row.
   */
  async recordPanelDeviceUse(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      use: rpcDecoded(decodeDeviceUseV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const use = request.use as DeviceUseV1;
    const user = await panelDeviceUserV1(shell.state, identity, use);
    if ("refused" in user) {
      return { status: "refused" as const, reason: user.refused };
    }
    const entry = await auditEntryForDeviceUseV1(
      identity.botId,
      use,
      user.displayName,
    );
    await new DeviceUseLogV1(this.ctx.storage).record(entry);
    if (this.backendEnv.AUDIT_SINK) {
      // Appended even for a retry: the outbox and the table are both keyed
      // by the use, so a second append is one row, and a first append lost
      // between the two writes is not.
      await this.auditOutbox().append([entry]);
      await this.drainAuditOutbox();
    }
    return { status: "recorded" as const };
  }

  async setFocusedPanel(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
        pluginId: rpcPluginIdOrNull,
      },
      {
        surfaceId: rpcPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/, 128),
      },
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return applyPanelFocusV1(shell.state, identity, {
      pluginId: request.pluginId as string | null,
      ...(typeof request.surfaceId === "string"
        ? { surfaceId: request.surfaceId }
        : {}),
    });
  }

  /**
   * Flips one switch for this Bot, fenced on the revision the page read. A
   * stale revision, a locked Plugin or an unavailable feature is a receipt,
   * not a thrown error: the page re-reads and says why.
   */
  async setBotPluginEnabled(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeSetBotPluginEnabledCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const receipt = await setBotPluginEnabledV1(
      shell.state,
      identity,
      request.command as ReturnType<typeof decodeSetBotPluginEnabledCommandV1>,
    );
    if (receipt.status === "applied") {
      this.ctx.waitUntil(
        this.assembleTheme({
          schemaVersion: 1,
          userId: identity.userId,
          botId: identity.botId,
        }).catch(() => undefined),
      );
    }
    return receipt;
  }

  /** A non-waking projection of this Bot's durable Computer presence. */
  async readComputerPresence(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell, computer } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return computer.read(identity.userId, identity.botId);
  }

  /**
   * Keeps the frame a subagent's Turn left on the Bot's desktop as the card's.
   * The subagent runs in its task's own object; the card reads this one.
   */
  async putComputerFrame(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      frame: rpcDecoded(decodeStoredComputerFrameV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell, computer } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    await computer.putFrame(request.frame as StoredComputerFrameV1);
  }

  /**
   * The Bot's Computer frame, when `contentHash` still names it. Read from
   * this object's own storage; no Computer wakes to serve it.
   */
  async readComputerFrame(
    input: unknown,
  ): Promise<{ bytesBase64: string } | null> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      contentHash: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell, computer } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const frame = await computer.readFrame(request.contentHash as string);
    return frame ? { bytesBase64: bytesToBase64(frame.bytes) } : null;
  }

  /** One durably admitted User command against this Bot's Computer. */
  async executeComputerPresenceCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeComputerCommandV1),
    });
    if (
      typeof request.userId !== "string" ||
      typeof request.botId !== "string"
    ) {
      throw new Error("Computer command RPC identity was not decoded");
    }
    const command = decodeComputerCommandV1(request.command);
    const identity = {
      userId: request.userId,
      botId: request.botId,
    };
    const { shell, computer } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return computer.execute(identity.userId, identity.botId, command);
  }

  async readAvatar(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.read(registration, identity.userId);
  }

  async updateAvatar(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeUpdateAvatarCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { flock, registration } = await this.materialized(identity);
    return flock.update(
      registration,
      identity.userId,
      request.command as ReturnType<typeof decodeUpdateAvatarCommandV1>,
    );
  }

  async readVoice(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.readVoice(registration, identity.userId);
  }

  async updateVoice(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeUpdateVoiceCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { flock, registration } = await this.materialized(identity);
    return flock.updateVoice(
      registration,
      identity.userId,
      request.command as ReturnType<typeof decodeUpdateVoiceCommandV1>,
    );
  }

  async readLook(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.readLook(registration, identity.userId);
  }

  async updateLook(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeUpdateLookCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { flock, registration } = await this.materialized(identity);
    const receipt = await flock.updateLook(
      registration,
      identity.userId,
      request.command as ReturnType<typeof decodeUpdateLookCommandV1>,
    );
    if (receipt.status === "applied") {
      this.ctx.waitUntil(
        this.assembleTheme({
          schemaVersion: 1,
          userId: identity.userId,
          botId: identity.botId,
        }).catch(() => undefined),
      );
    }
    return receipt;
  }

  async persistAssembledDocument(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
      },
      { document: rpcDecoded(decodeThemeDocumentV1) },
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { flock, registration } = await this.materialized(identity);
    return flock.persistAssembledDocument(
      registration,
      identity.userId,
      request.document === undefined
        ? undefined
        : (request.document as ReturnType<typeof decodeThemeDocumentV1>),
    );
  }

  async assembleTheme(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration, shell } = await this.materialized(identity);
    const user = decodeUserSettingsViewV1(
      rpcJsonSnapshotV1(
        await userConfigurationV1(shell.state, identity).readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
      ),
    );
    return assembleBotThemeV1(shell.state, identity, {
      flock,
      registration,
      appearance: user.appearance?.look ?? "ink",
      timezone: userTimezoneV1(user.profile),
      mirror: async (look, document) => {
        await userConfigurationV1(shell.state, identity).mirrorBotLook(
          identity.userId,
          identity.botId,
          look,
          document,
        );
      },
    });
  }

  /**
   * Sends the queued profile mirror, if one is due. The alarm path and the
   * post-commit attempt share this. A miss keeps the record for the alarm.
   */
  private async deliverProfileMirror(): Promise<void> {
    const pending = await this.ctx.storage.get(PROFILE_MIRROR_KEY_V1);
    if (pending === undefined) return;
    const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (!identity) return;
    const shell = await this.contribution();
    await deliverProfileMirrorV1({
      storage: this.ctx.storage,
      now: Date.now(),
      botId: identity.botId,
      mirror: (profile) =>
        userConfigurationV1(shell.state, identity).mirrorBotProfile(
          identity.userId,
          identity.botId,
          profile,
        ),
      refreshAlarm: (transaction) =>
        shell.state.authority.refreshRecoveryAlarm(
          transaction as unknown as Parameters<
            typeof shell.state.authority.refreshRecoveryAlarm
          >[0],
        ),
    });
  }

  private async assembleThemeIfDue(): Promise<void> {
    const due = await themeAssembleDeadlineV1(this.ctx.storage);
    if (due.length === 0 || due[0]! > Date.now()) return;
    const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (!identity) return;
    await this.assembleTheme({
      schemaVersion: 1,
      userId: identity.userId,
      botId: identity.botId,
    });
  }

  async readLifecycle(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { flock, registration } = await this.materialized(identity);
    return flock.readLifecycle(registration, identity.userId);
  }

  async executeLifecycle(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeBotLifecycleCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const command = request.command as BotLifecycleCommandV1;
    if (command.botId !== identity.botId)
      throw new Error("lifecycle command does not match Bot authority");
    const { flock, registration } = await this.materialized(identity);
    return flock.executeLifecycle(registration, identity.userId, command);
  }

  /**
   * D6: model invocation as a User-enabled binding. Without the resolved
   * model binding the answer is unavailable; with one, the
   * request is recorded and the credential lease taken through the existing
   * provider path before any event is streamed back.
   */
  async isolateInvokeModel(input: unknown) {
    const request = decodeIsolateCallRpcV1(
      input,
      decodeNormalizedModelRequestV1,
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const shell = await this.contribution();
    return isolateInvokeModel(shell.state, identity, {
      runId: request.runId as string,
      sessionId: request.sessionId as string,
      turnId: request.turnId as string,
      packageId: request.packageId as string,
      generationId: request.generationId as string,
      request: request.request as NormalizedModelRequest,
    });
  }

  async isolateAuthority(input: unknown) {
    const request = decodeIsolateCallRpcV1(input, (value) => value ?? null);
    return isolateAuthority(
      (await this.contribution()).state,
      { userId: request.userId as string, botId: request.botId as string },
      request as unknown as IsolateCallScopeV1,
    );
  }

  async isolateStorageGet(input: unknown) {
    return isolateStorageGet(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateStorageGetRequestV1,
      ) as unknown as IsolateCallScopeV1,
    );
  }

  async isolateStoragePut(input: unknown) {
    return isolateStoragePut(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateStoragePutRequestV1,
      ) as unknown as IsolateCallScopeV1,
    );
  }

  async isolateStorageDelete(input: unknown) {
    return isolateStorageDelete(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateStorageDeleteRequestV1,
      ) as unknown as IsolateCallScopeV1,
    );
  }

  async isolateStorageList(input: unknown) {
    return isolateStorageList(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, (value) =>
        decodeIsolateStorageListRequestV1(value ?? {}),
      ) as unknown as IsolateCallScopeV1,
    );
  }

  async isolateSettings(input: unknown) {
    return isolateSettings(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(
        input,
        (value) => value ?? null,
      ) as unknown as IsolateCallScopeV1,
    );
  }

  async isolateMemoryRead(input: unknown) {
    return isolateMemoryRead(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, decodeIsolateMemoryReadRequestV1) as never,
    );
  }

  async isolateMemoryWrite(input: unknown) {
    return isolateMemoryWrite(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, decodeIsolateMemoryWriteRequestV1) as never,
    );
  }

  async isolateMemoryForget(input: unknown) {
    return isolateMemoryForget(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, decodeIsolateMemoryWriteRequestV1) as never,
    );
  }

  async isolateWorkspaceRead(input: unknown) {
    return isolateWorkspaceRead(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, decodeIsolateWorkspacePathV1) as never,
    );
  }

  async isolateWorkspaceList(input: unknown) {
    return isolateWorkspaceList(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateWorkspaceListRequestV1,
      ) as never,
    );
  }

  async isolateWorkspaceStat(input: unknown) {
    return isolateWorkspaceStat(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, decodeIsolateWorkspacePathV1) as never,
    );
  }

  async isolateWorkspaceWrite(input: unknown) {
    return isolateWorkspaceWrite(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateWorkspaceWriteRequestV1,
      ) as never,
    );
  }

  async isolateWorkspaceDelete(input: unknown) {
    return isolateWorkspaceDelete(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(
        input,
        decodeIsolateWorkspaceDeleteRequestV1,
      ) as never,
    );
  }

  async isolateConnection(input: unknown) {
    return isolateConnection(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, (value) => {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 256
        ) {
          throw new Error("Connection id is invalid");
        }
        return value;
      }) as never,
    );
  }

  async isolateModelTransport(input: unknown) {
    return isolateModelTransport(
      (await this.contribution()).state,
      // The transport request is decoded where the ticket is spent, so a
      // malformed call is refused without costing the dispatch its attempt.
      decodeIsolateCallRpcV1(input, (value) => value) as never,
    );
  }

  async isolateEmail(input: unknown) {
    return isolateEmail(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, decodeIsolateEmailRequestV1) as never,
    );
  }

  async isolateSchedule(input: unknown) {
    return isolateSchedule(
      (await this.contribution()).state,
      decodeIsolateCallRpcV1(input, decodeIsolateScheduleRequestV1) as never,
    );
  }

  async resolveConfiguration(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return resolveConfiguration(shell.state, identity);
  }

  async run(input: unknown) {
    const request = decodeBotRunRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    return shell.run({ ...identity, ...request.command });
  }

  /**
   * Durably accepts a composer command and returns its receipt.
   *
   * Execution continues on this object's drive. `waitUntil` keeps the
   * isolate awake for that drive; the recovery alarm is what resumes it
   * after eviction.
   */
  async admitRun(input: unknown) {
    const request = decodeBotRunRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    const receipt = await shell.admit({ ...identity, ...request.command });
    const work = shell.pendingWork();
    if (work) this.ctx.waitUntil(work);
    return receipt;
  }

  /**
   * Finishes the resident drive, including the settled-run projections.
   *
   * The composer returns at admission. A caller that needs search and audit
   * rows waits here. Eviction drops this promise; the recovery alarm resumes
   * the run.
   */
  async joinAdmittedDrive(): Promise<void> {
    const mounted = this.mounted;
    if (!mounted) return;
    const { shell } = await mounted;
    await shell.pendingWork();
  }

  async runAgent(input: unknown) {
    const request = decodeBotAgentRunRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    const turn = await shell.run({
      ...identity,
      runId: request.command.runId,
      sessionId: request.command.sessionId,
      acceptedAt: request.command.acceptedAt,
      text: request.command.text,
      turnType: "agent",
      lane: "agent",
      origin: request.command.source,
    });
    return turn;
  }

  /**
   * The account's voice session asking this Bot for something.
   *
   * The same agent lane a Bot-to-Bot question uses, for the same reason: it
   * queues behind whatever the person or a Routine already has running and
   * never takes its place. What differs is the return address — a call and a
   * spoken Turn rather than a Bot — and that the answer goes back through the
   * voice reply outbox instead of this call's return value.
   */
  async runVoice(input: unknown) {
    const request = decodeBotVoiceRunRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    const turn = await shell.run({
      ...identity,
      runId: request.command.runId,
      sessionId: request.command.sessionId,
      acceptedAt: request.command.acceptedAt,
      text: request.command.text,
      turnType: "agent",
      lane: "agent",
      origin: request.command.source,
    });
    await this.drainVoiceReplyOutbox(identity.userId);
    return turn;
  }

  /**
   * A Group Chat asking this member for a Turn.
   *
   * The agent lane, like a Bot's question: it waits behind the person's own
   * chat and never makes it yield. The admission returns at once; the group
   * reads the Turn back by id as it runs.
   */
  async admitGroupTurn(input: unknown) {
    const request = decodeBotGroupTurnRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    const receipt = await shell.admit({
      ...identity,
      runId: request.command.runId,
      sessionId: request.command.sessionId,
      acceptedAt: request.command.acceptedAt,
      text: request.command.text,
      turnType: "agent",
      lane: "agent",
      origin: request.command.origin,
    });
    const work = shell.pendingWork();
    if (work) this.ctx.waitUntil(work);
    return receipt;
  }

  /** One of this member's group Turns, as its group reads it back. */
  async readGroupTurn(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      runId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    const run = await shell.state.authority.readRun(request.runId as string);
    if (!run || !groupOriginOfRunV1(run)) {
      return { schemaVersion: 1, found: false } as const;
    }
    return {
      schemaVersion: 1,
      found: true,
      state: groupTurnStateOfRunV1(run),
    } as const;
  }

  /**
   * A newer message in a group this member has a Turn open in. Kept as the
   * highest position heard of, so the Turn yields at its next step boundary.
   */
  async signalGroupMessage(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      groupId: rpcPattern(/^g-[0-9a-f]{20}$/, 22),
      seq: rpcInteger({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    });
    await this.materialized({
      userId: request.userId as string,
      botId: request.botId as string,
    });
    const key = groupWaitingKeyV1(request.groupId as string);
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<number>(key);
      if (typeof current !== "number" || current < (request.seq as number)) {
        await transaction.put(key, request.seq as number);
      }
    });
    return { schemaVersion: 1 } as const;
  }

  /**
   * Tells a group one of its member Turns here changed: it started, sent
   * something, or settled. Best effort: the group reads the Turn itself, and
   * its alarm reads it again if this is lost.
   */
  private nudgeGroup(runId: string | undefined): void {
    const namespace = this.backendEnv.GROUP_CHATS;
    if (!namespace || !runId) return;
    this.ctx.waitUntil(
      (async () => {
        const stored = await this.ctx.storage.get<{
          admission?: { origin?: { kind: string; groupId?: string } };
        }>(`run:${runId}`);
        const groupId =
          stored?.admission?.origin?.kind === "group"
            ? stored.admission.origin.groupId
            : undefined;
        if (!groupId) return;
        const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
        if (!identity) return;
        // SAFETY: the binding names GroupChat; this is its reviewed RPC door.
        const group = namespace.get(
          namespace.idFromName(groupChatObjectNameV1(identity.userId, groupId)),
        ) as unknown as { turnChanged(input: unknown): Promise<unknown> };
        await group.turnChanged({
          schemaVersion: 1,
          userId: identity.userId,
          groupId,
          botId: identity.botId,
          runId,
        });
      })().catch(() => undefined),
    );
  }

  /**
   * A settled voice request written into this Bot's thread after hang-up.
   *
   * The voice object is the only caller. The receipt is the run id, so a
   * retried announce is one message. The send is projected onto the voice
   * request's own run, the way a Routine that broke after it had already
   * ended still lands a readable line.
   */
  async deliverVoiceChatResult(input: unknown) {
    const request = decodeVoiceChatResultRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const settings = await readBotSettingsV1(shell.state, identity);
    const receiptKey = `voice:chat-result:${request.command.runId}`;
    const createdAt = new Date().toISOString();
    let committed = false;
    await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(receiptKey)) return;
      const records = await visibleMessageRecordsV1({
        settings,
        read: (key) => transaction.get(key),
        messages: [
          {
            messageId: messageIdV1(
              request.command.runId,
              request.command.ordinal,
            ),
            runId: request.command.runId,
            createdAt,
            body: request.command.body.slice(0, 2_000),
            automation: true,
            projectedSendOrdinal: request.command.ordinal,
          },
        ],
      });
      for (const [key, value] of Object.entries(records)) {
        await transaction.put(key, value);
      }
      await transaction.put(receiptKey, { schemaVersion: 1, at: createdAt });
      committed = true;
    });
    if (committed) this.ctx.waitUntil(this.drainPush());
    return { status: "accepted" as const };
  }

  /**
   * Spoken turns of one ended call, written as a collapsible thread section.
   *
   * The voice object is the only caller. The receipt is the call id, so a
   * hang-up and the abandoned-call alarm that follows a dropped socket write
   * one section. The observer is told so the thread redraws without a poll.
   */
  async deliverVoiceCallTranscript(input: unknown) {
    const request = decodeVoiceCallTranscriptRpcV1(input);
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const receiptKey = `voice:call-transcript:${request.command.callId}`;
    let committed = false;
    await this.ctx.storage.transaction(async (transaction) => {
      if (await transaction.get(receiptKey)) return;
      await appendAnnouncement(transaction, (seq) => ({
        type: "voice/call",
        seq,
        timestamp: request.command.endedAt,
        callId: request.command.callId,
        startedAt: request.command.startedAt,
        endedAt: request.command.endedAt,
        turns: request.command.turns,
      }));
      await transaction.put({
        [receiptKey]: {
          schemaVersion: 1,
          at: request.command.endedAt,
        },
      });
      await shell.state.authority.refreshRecoveryAlarm(transaction);
      committed = true;
    });
    if (committed) await shell.state.authority.drainCommittedPublication();
    return { status: "accepted" as const };
  }

  /** This object's bounded, durable audit outbox. */
  private auditOutbox(): AuditOutboxV1 {
    return new AuditOutboxV1(this.ctx.storage);
  }

  /**
   * Queues one settled run's audit entries and drains what is pending.
   *
   * Queue first, deliver second, and never the other way round: the entries
   * are durable in this object before the User object is asked for anything,
   * so a User object that is away, slow, or mid-eviction costs a retry rather
   * than a gap. Whatever a drain leaves behind is picked up by the next
   * settlement or by the alarm this object already has.
   */
  private async projectSettledAudit(
    shell: ShellBotBackendContribution,
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<void> {
    const sink = this.backendEnv.AUDIT_SINK;
    if (!sink) return;
    const outbox = this.auditOutbox();
    try {
      const lookup = await shell.lookupRun({ schemaVersion: 1, runId });
      if (lookup.state === "terminal") {
        const stored = await shell.listRunEventPage();
        const run = stored.runs.find((candidate) => candidate.runId === runId);
        if (run) {
          await outbox.append(
            await auditEntriesFromStoredRunV1(identity.botId, run),
          );
        }
      }
    } catch {
      // A projection this object could not build is a gap a rebuild closes;
      // it is never a reason for an admitted Turn to look as if it failed.
    }
    await this.drainAuditOutbox();
  }

  /**
   * Hands whatever is pending to the User Durable Object.
   *
   * The failure is swallowed *here* and not inside the outbox: the outbox
   * throws so that nothing is cleared that was not delivered, and this call
   * site swallows so that a derived projection never decides whether a Turn
   * settled.
   */
  private async drainAuditOutbox(): Promise<void> {
    const sink = this.backendEnv.AUDIT_SINK;
    if (!sink) return;
    try {
      await this.auditOutbox().drain(sink);
    } catch {
      // Still pending, still durable, still visible as `pending` in the
      // outbox state the Activity surface reads.
    }
  }

  /**
   * One page of this Bot's audit entries, projected from its own stored runs.
   *
   * The durable session events rather than the client projection: the client
   * projection drops `call.input`, and the argument digest needs the exact
   * arguments.
   */
  async projectAuditEntries(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier, botId: rpcBotId },
      { cursor: rpcString(512) },
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const cursor = request.cursor as string | undefined;
    // Device uses come from no run, so this object's own record of them is
    // the first page; the runs follow from their start.
    if (cursor === undefined) {
      const devices = await new DeviceUseLogV1(this.ctx.storage).entries();
      if (devices.length > 0) {
        return {
          schemaVersion: 1 as const,
          botId: identity.botId,
          entries: devices,
          nextCursor: DEVICE_USE_PAGE_DONE_V1,
        };
      }
    }
    return createBotAuditEntryPageV1(
      identity.botId,
      await shell.listRunEventPage(
        cursor === DEVICE_USE_PAGE_DONE_V1 ? undefined : cursor,
      ),
    );
  }

  /**
   * Search and audit for one settled run. Called from the authority once the
   * run is terminal, including when the composer did not wait for it.
   */
  private async projectSettled(
    shell: ShellBotBackendContribution,
    runId: string,
  ): Promise<void> {
    const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (!identity) return;
    await this.projectSettledRun(shell, identity, runId);
    await this.projectSettledAudit(shell, identity, runId);
  }

  /**
   * Projects one settled run into the User's transcript index.
   *
   * After settlement, and never before it: the run is already durable in this
   * object, so an index write that fails costs a rebuild rather than a Turn.
   * The failure is swallowed for the same reason — a derived projection must
   * not decide whether the thing it derives from succeeded.
   */
  private async projectSettledRun(
    shell: ShellBotBackendContribution,
    identity: { userId: string; botId: string },
    runId: string,
  ): Promise<void> {
    const sink = this.backendEnv.SEARCH_SINK;
    if (!sink) return;
    try {
      const lookup = await shell.lookupRun({ schemaVersion: 1, runId });
      if (lookup.state !== "terminal") return;
      await sink.indexRows(
        searchRowsFromClientRunV1(identity.botId, lookup.run),
      );
    } catch {
      // Visible as a gap the index state and a rebuild both report; never a
      // reason for an admitted Turn to look as if it failed.
    }
  }

  /**
   * One page of this Bot's rows, projected from its own stored runs.
   *
   * This is what makes the User's index disposable: every row it holds can be
   * read back out of the authority that owns the conversation.
   */
  async projectSearchRows(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier, botId: rpcBotId },
      { cursor: rpcString(512) },
    );
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const cursor = request.cursor as string | undefined;
    return createBotSearchRowPageV1(
      identity.botId,
      await shell.listRuns({
        schemaVersion: 1,
        ...(cursor === undefined ? {} : { before: cursor }),
      }),
    );
  }

  /**
   * The Bot's invocable Skills, for the composer's `/` and `@` popover. A
   * read: it binds the Workspace surfaces the Turn path binds, and writes
   * nothing.
   */
  /**
   * One durable-root file, read from object storage.
   *
   * The Workspace read path the hosted client needs: a screenshot the Bot
   * filed under a Package-declared root is durable content, and a card that
   * renders it has to be able to fetch it without reaching a Computer. It
   * wakes none — this is R2 and this object's own generation ledger — which is
   * exactly why the durable-root sync exists.
   */
  async readWorkspaceFileV1(input: unknown): Promise<ClientWorkspaceFileV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      path: rpcDecoded(decodeWorkspacePathV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const files = this.backendEnv.WORKSPACE_FILES;
    if (!files) {
      return {
        schemaVersion: 1 as const,
        status: "unavailable" as const,
        reason: "This deployment binds no Workspace object store",
      };
    }
    const outcome = await files.read(request.path as WorkspacePathV1);
    if (outcome.status !== "ok") {
      return {
        schemaVersion: 1 as const,
        status: outcome.status,
        reason: outcome.reason,
      };
    }
    return {
      schemaVersion: 1 as const,
      status: "ok" as const,
      contentHash: outcome.file.generation.contentHash,
      size: outcome.file.generation.size,
      bytesBase64: bytesToBase64(outcome.file.bytes),
    };
  }

  async listSkills(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return listSkills(shell.state, identity);
  }

  /**
   * Write one Skill into this Bot's instruction root as its **User**.
   *
   * The import path's only Bot-scoped write. It is the User's own authority —
   * `isLoadableSkillSourceV1` admits a `user` writer under the Bot's own
   * instruction root — so an imported Skill is loadable on the Bot's first
   * Turn and its provenance records who put it there.
   */

  async writeUserSkill(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      slug: rpcString(128),
      name: rpcString(100),
      description: rpcString(1_024),
      body: rpcString(64 * 1024),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return writeUserSkill(shell.state, identity, {
      slug: request.slug as string,
      name: request.name as string,
      description: request.description as string,
      body: request.body as string,
    });
  }

  /**
   * This Bot's own instruction root, bodies included, for a template export.
   *
   * Read-only, and no wider than what the Turn loader already loads: the
   * managed set and the plugin-borne index are never walked, and a candidate
   * the authority predicate refuses is absent here too.
   */
  async listOwnSkillDocuments(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return listOwnSkillDocuments(shell.state, identity);
  }

  async stopRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeClientRunStopCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return stopRun(
      shell.state,
      identity,
      request.command as ClientRunStopCommandV1,
    );
  }

  /**
   * Hands every answer a voice call is owed to that account's voice object.
   *
   * The entry is written in the transaction that recorded the answer, so this
   * can lose a wake-up without losing the answer: an entry that was not
   * delivered is still there for the next settlement or this object's own
   * alarm, and the voice object's scheduled look-up settles it anyway. Delivery
   * is by request id, and the voice ledger refuses a request that is no longer
   * `admitted`, so a redelivery is a no-op rather than a second answer.
   *
   * An entry is deleted only after the voice object has acknowledged it. One
   * that names a call the account no longer has is acknowledged all the same:
   * the answer is in the Bot's thread, and the outbox is not where it lives.
   */
  private async drainVoiceReplyOutbox(userId: string): Promise<void> {
    const namespace = (
      this.env as BotStateEnv & { VOICE_ASSISTANTS?: DurableObjectNamespace }
    ).VOICE_ASSISTANTS;
    if (!namespace) return;
    const entries = await this.ctx.storage.list<unknown>({
      prefix: VOICE_REPLY_OUTBOX_PREFIX_V1,
      limit: VOICE_REPLY_DRAIN_LIMIT_V1,
    });
    if (entries.size === 0) return;
    // SAFETY: the binding names VoiceAssistant; this is its reviewed RPC door.
    const voice = namespace.get(namespace.idFromName(userId)) as unknown as {
      deliverVoiceReply(input: unknown): Promise<unknown>;
    };
    for (const [key, value] of entries) {
      const entry = isVoiceReplyOutboxEntryV1(value) ? value : undefined;
      if (!entry) {
        // Not a record this build wrote. It cannot be delivered and will never
        // become deliverable, so it goes rather than blocking the queue.
        await this.ctx.storage.delete(key);
        continue;
      }
      try {
        await voice.deliverVoiceReply({
          schemaVersion: 1,
          userId,
          requestId: entry.runId,
        });
      } catch {
        // Still durable, still owed, retried by the next settlement or alarm.
        return;
      }
      await this.ctx.storage.delete(key);
    }
  }

  private pushDrain?: Promise<void>;
  /**
   * A commit landed while a drain was already in flight.
   *
   * The drain lists the outbox once and then awaits a delivery per entry, so an
   * entry written after that listing — the second `send_to_user` of one Turn is
   * the ordinary case — is invisible to it. Without this the second
   * notification waits for the next alarm. A pass that delivered anything is
   * followed by another, and this flag closes the last gap: a commit that
   * lands after the final, empty listing. Neither can spin, because a pass
   * that delivers nothing ends the drain and every delivered entry is deleted.
   */
  private pushDrainAgain = false;
  private drainPush(): Promise<void> {
    if (this.pushDrain) {
      this.pushDrainAgain = true;
      return this.pushDrain;
    }
    this.pushDrain = (async () => {
      let delivered = 0;
      do {
        this.pushDrainAgain = false;
        delivered = await this.flushPush();
      } while (this.pushDrainAgain || delivered > 0);
    })()
      .catch(() => {
        console.error(JSON.stringify({ event: "push-outbox-pending" }));
      })
      .finally(() => {
        this.pushDrain = undefined;
        this.pushDrainAgain = false;
      });
    return this.pushDrain;
  }

  /** How many outbox entries this pass delivered. Zero ends the drain. */
  private async flushPush(): Promise<number> {
    const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (!identity) return 0;
    const rpc = this.env.USER_CONFIGURATIONS.get(
      this.env.USER_CONFIGURATIONS.idFromName(identity.userId),
    ) as unknown as {
      deliverPush(input: { userId: string; update: PushUpdate }): Promise<void>;
    };
    const entries = await this.ctx.storage.list<MessageNotice>({
      prefix: PUSH_OUTBOX_PREFIX,
      limit: PUSH_OUTBOX_DRAIN_LIMIT,
    });
    // Both are read per entry rather than once for the pass. Every delivery is
    // an await on another object, and a Bot muted or a conversation read during
    // one of them must decide the next entry: a hoisted snapshot would alert
    // for a Bot that is already silenced.
    for (const [key, notice] of entries) {
      const settings = await this.ctx.storage.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      const unread = optionalUnreadStateV1(
        await this.ctx.storage.get(UNREAD_STATE_KEY),
      );
      await rpc.deliverPush({
        userId: identity.userId,
        update: {
          botId: identity.botId,
          kind: "message",
          cursor: notice.notificationId,
          title: notice.title,
          body: notice.body,
          notify:
            notice.notify &&
            settings?.notifications.enabled !== false &&
            (unread.lastSeenCursor === undefined ||
              notice.notificationId > unread.lastSeenCursor),
        },
      });
      await this.ctx.storage.delete(key);
    }
    const read = await this.ctx.storage.get<{ cursor: string }>(PUSH_READ_KEY);
    if (read) {
      await rpc.deliverPush({
        userId: identity.userId,
        update: { botId: identity.botId, kind: "read", cursor: read.cursor },
      });
      await this.ctx.storage.transaction(async (tx) => {
        if (
          (await tx.get<{ cursor: string }>(PUSH_READ_KEY))?.cursor ===
          read.cursor
        )
          await tx.delete(PUSH_READ_KEY);
      });
    }
    return entries.size;
  }

  /** The Bot's unread projection; the Bot Durable Object derives the count. */
  async readUnread(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return readUnread(shell.state, identity);
  }

  /** `bot/mark-read` / `bot/mark-unread`, idempotent on the command id. */
  async executeUnreadCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeBotUnreadCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    const receipt = await executeUnreadCommand(
      shell.state,
      identity,
      request.command as BotUnreadCommandV1,
    );
    this.ctx.waitUntil(this.drainPush());
    return receipt;
  }

  /** The Bot's approvals, newest first, pending and decided alike. */
  async listApprovals(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return listApprovals(shell.state, identity);
  }

  /**
   * One decision on one approval. First write wins: a replay answers with the
   * decision already recorded rather than overwriting it.
   */
  async decideApproval(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      approvalId: rpcIdentifier,
      command: rpcDecoded(decodeApprovalDecisionCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return decideApproval(
      shell.state,
      identity,
      request.approvalId as string,
      request.command as ApprovalDecisionCommandV1,
    );
  }

  /** The Bot's Cards, newest first, tombstoned ones included (ADR 0030). */
  async listCards(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    return listCards(shell.state, identity);
  }

  /**
   * One Card by its surface id. The listing is bounded by bytes, so this is
   * how a client reads a surface that fell past the budget.
   */
  async readCard(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      surfaceId: rpcDecoded(decodeCardSurfaceIdV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return readCardView(shell.state, identity, request.surfaceId as string);
  }

  /**
   * One action on one Card. The kernel decides what the action's name means;
   * a stale revision is refused rather than applied to a surface the person
   * was not looking at.
   */
  async cardAction(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeCardActionCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    const receipt = await cardAction(
      shell.state,
      identity,
      request.command as CardActionCommandV1,
    );
    return receipt;
  }

  async listNotifications(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return listNotifications(shell.state);
  }

  async acknowledgeNotification(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      notificationId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return acknowledgeNotification(
      shell.state,
      request.notificationId as string,
    );
  }

  /**
   * The Bot's subagent tasks. Bot-scoped, so it proves directory membership the
   * same way the other Bot RPCs do: a Bot that is not this User's is not found.
   *
   * This is the *parent* object's answer. A Subagent Durable Object has no
   * route of its own and holds no task list: it holds one Session, and every
   * authority stays here.
   */
  async listTasks(input: unknown) {
    const identity = decodeBotIdentityRpcV1(input);
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return listTasks(shell.state, identity);
  }

  /** One task, by id. The parent object's answer; a child holds no list. */
  async readTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return readTask(shell.state, identity, request.taskId as string);
  }

  /**
   * The User's own cancellation of one task.
   *
   * The same durable act `task_stop` performs, through a second authenticated
   * door: explicit, authenticated, and terminal — never a second mechanism.
   */
  async stopTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return stopTaskForUser(shell.state, identity, request.taskId as string);
  }

  /** The Subagent Durable Object's cancellation door. */
  async stopSubagentTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return stopSubagentTask(shell.state, identity, request.taskId as string);
  }

  /**
   * The Subagent Durable Object's door.
   *
   * It records the task and arms its own alarm; the Turn runs on that alarm.
   * The parent is still inside the Turn that dispatched when this returns, so
   * anything longer than a write here would block it.
   */
  async runTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      request: rpcDecoded(decodeSubagentRunTaskRequestV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return acceptSubagentTask(
      shell.state,
      identity,
      request.request as SubagentRunTaskRequestV1,
    );
  }

  /** What a Subagent Durable Object holds for one task, for reconciliation. */
  async readSubagentTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return readSubagentTaskContext(shell.state, request.taskId as string);
  }

  /**
   * The messages a parent has queued for one of its tasks, claimed by the
   * child that is running it.
   *
   * The claim marks what it hands over in the parent's own transaction, so a
   * child that retries a step reads the marks back rather than the message.
   */
  async claimTaskMessages(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return claimTaskMessages(shell.state, identity, request.taskId as string);
  }

  /** One terminal task outcome, recorded on the parent. Idempotent per task. */
  async settleTask(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
      outcome: rpcDecoded(decodeTaskOutcomeV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return settleTask(
      shell.state,
      identity,
      request.taskId as string,
      request.outcome as TaskOutcomeV1,
    );
  }

  /**
   * The Bot's Routines. Bot-scoped, so it proves directory membership the same
   * way the other Bot RPCs do: a Bot that is not this User's is not found.
   */
  async listRoutines(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    await this.syncRoutineTimezone(identity, shell);
    return listRoutines(shell.state, identity);
  }

  /**
   * The Routines list and the inbox as one RPC. The document read is this,
   * so the Worker is not addressing the object twice for one panel.
   */
  async readRoutinesFrame(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    await this.syncRoutineTimezone(identity, shell);
    return readRoutinesFrame(shell.state, identity);
  }

  /** One Routine command, applied durably with the User recorded as writer. */
  async executeRoutineCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeRoutineCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    await this.syncRoutineTimezone(identity, shell);
    return executeRoutineCommand(
      shell.state,
      identity,
      request.command as RoutineCommandV1,
      { kind: "user" },
      connectionTriggersFromUserV1(userConfigurationV1(shell.state, identity)),
    );
  }

  /**
   * One connected-app event, after the User object resolved the instance to
   * this Bot and this Routine. Directory membership is not proved here: the
   * caller is the provider door, and the instance mapping is the credential.
   */
  async deliverConnectEvent(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      routineId: rpcIdentifier,
      eventId: rpcIdentifier,
      payload: (value) => value,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return deliverConnectEvent(shell.state, {
      routineId: request.routineId as string,
      eventId: request.eventId as string,
      payload: request.payload,
    });
  }

  /** Adopt a Profile timezone pushed by this User's authoritative object. */
  async refreshRoutineTimezone(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      timezone: rpcString(64),
      revision: rpcInteger({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    await projectRoutineAccountTimezoneV1(
      shell.state,
      request.timezone as string,
      request.revision as number,
    );
    return { schemaVersion: 1 as const, status: "applied" as const };
  }

  /**
   * One webhook delivery, forwarded by the gateway after it verified the key's
   * signature. The Bot re-checks the key against its own durable record: the
   * edge proved the token was minted by this deployment, not that it is still
   * this Routine's key.
   *
   * Directory membership is deliberately *not* proved here. The caller is an
   * external system with no session; the key is the whole credential, and it
   * names the User the token was minted for.
   */
  async deliverRoutineHook(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      delivery: rpcDecoded(decodeRoutineHookDeliveryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return deliverRoutineHook(
      shell.state,
      request.delivery as RoutineHookDeliveryV1,
    );
  }

  /**
   * One finished machine command, handed over by the Worker that answered the
   * machine.
   *
   * It names the Bot the command record named — a Bot cannot be told about a
   * command it never asked for, because it is the command that carries the
   * `botId`.
   */
  async deliverMachineResult(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      delivery: rpcDecoded(decodeMachineResultDeliveryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return deliverMachineResult(
      shell.state,
      request.delivery as MachineResultDeliveryV1,
    );
  }

  /** One Routine's bounded run log, newest first. */
  async listRoutineRuns(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      routineId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return listRoutineRuns(shell.state, identity, request.routineId as string);
  }

  /**
   * One automation run, read-only. It is not in the visible transcript and
   * never will be; the Routine's run log is the only door to it.
   */
  async readRoutineRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      routineId: rpcIdentifier,
      runId: rpcIdentifier,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return readRoutineRun(
      shell.state,
      identity,
      request.routineId as string,
      request.runId as string,
    );
  }

  /** The completion inbox: what the Bot's firings left for its User. */
  async listRoutineInbox(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return listRoutineInbox(shell.state, identity);
  }

  /** Acknowledging inbox entries; an explicit command, never a read. */
  async executeRoutineInboxCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeRoutineInboxCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return executeRoutineInboxCommand(
      shell.state,
      identity,
      request.command as RoutineInboxCommandV1,
    );
  }

  /**
   * The Bot's durable Composition generations, newest first. Bot-scoped, so it
   * proves directory membership the same way the other Bot RPCs do.
   */
  async listCompositionGenerations(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcObject(
        {
          limit: rpcInteger({
            minimum: 1,
            maximum: MAX_COMPOSITION_GENERATION_PAGE_V1,
          }),
        },
        { cursor: rpcString(512) },
      ),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return listCompositionGenerations(
      shell.state,
      identity,
      request.query as { limit: number; cursor?: string },
    );
  }

  /**
   * One generation, including the recorded source of each isolate member once
   * authoring records exist (plan Step 5); the member list until then.
   */
  async getCompositionGeneration(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      generationId: rpcDecoded(decodeCompositionGenerationIdV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return getCompositionGeneration(
      shell.state,
      identity,
      request.generationId as string,
    );
  }

  /** Reverting records a new pending generation; it never mutates a record. */
  async revertComposition(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeRevertCompositionCommandV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const command = request.command as RevertCompositionCommandV1;
    if (command.botId !== identity.botId) {
      throw new Error("Composition revert command does not match its Bot");
    }
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return revertComposition(shell.state, identity, command);
  }

  /**
   * Canonical Memory for the selected Bot. Voice uses this for prepared core,
   * blocking tools and standing preferences. Membership is filled here.
   */
  async operateMemory(input: unknown): Promise<unknown> {
    if (!input || typeof input !== "object") {
      throw new Error("memory request is invalid");
    }
    const request = input as {
      schemaVersion?: number;
      userId?: string;
      botId?: string;
      action?: string;
      request?: unknown;
    };
    if (
      request.schemaVersion !== 1 ||
      typeof request.userId !== "string" ||
      typeof request.botId !== "string" ||
      typeof request.action !== "string"
    ) {
      throw new Error("memory request is invalid");
    }
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    const records = this.backendEnv.MEMORY_RECORDS;
    if (!records) throw new Error("Memory is unavailable");
    const body = { ...((request.request ?? {}) as Record<string, unknown>) };
    const groups = this.backendEnv.MEMORY_GROUPS;
    const joined = groups ? await groups.memberOf() : [];
    const claimed = body.authority;
    if (claimed && typeof claimed === "object" && !Array.isArray(claimed)) {
      body.authority = {
        ...(claimed as Record<string, unknown>),
        userId: identity.userId,
        botId: identity.botId,
        actor:
          (claimed as { actor?: unknown }).actor === "user" ? "user" : "bot",
        joinedGroupChatIds: joined,
        membershipRevision: memoryMembershipRevisionV1(joined),
      };
    }
    switch (request.action) {
      case "write":
        return records.write(body as never);
      case "forget":
        return records.forget(body as never);
      case "recall":
        return records.recall(body as never);
      case "expand":
        return records.expand(body as never);
      case "browse":
        return records.browse(body as never);
      case "preparedCore":
        return records.preparedCore(body as never);
      case "capture":
        return records.captureExtraction(body as never);
      default:
        throw new Error(`unknown Memory action ${request.action}`);
    }
  }

  async readVoiceContext(input: unknown) {
    if (!input || typeof input !== "object") {
      throw new Error("voice context request is invalid");
    }
    const request = input as {
      schemaVersion?: number;
      userId?: string;
      botId?: string;
      limit?: number;
    };
    if (
      request.schemaVersion !== 1 ||
      typeof request.userId !== "string" ||
      typeof request.botId !== "string"
    ) {
      throw new Error("voice context request is invalid");
    }
    const identity = { userId: request.userId, botId: request.botId };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.readVoiceContext(
      typeof request.limit === "number" ? request.limit : 6,
    );
  }

  async listRuns(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunListQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.listRuns(request.query as ClientRunListQueryV1);
  }

  /**
   * The operator snapshot behind `/api/debug`. Bot-scoped like every other
   * Bot RPC — the debug token authorizes the *caller*, it does not widen what
   * a Bot will answer about itself.
   */
  async debugSnapshot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeBotDebugQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.debugSnapshot(identity, request.query);
  }

  async runQuestions(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunLookupQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.runQuestions(
      identity,
      request.query as ClientRunLookupQueryV1,
    );
  }

  async lookupRun(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunLookupQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return shell.lookupRun(request.query as ClientRunLookupQueryV1);
  }

  async fenceRunAdmission(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      query: rpcDecoded(decodeClientRunLookupQueryV1),
    });
    const identity = {
      userId: request.userId as string,
      botId: request.botId as string,
    };
    const { shell } = await this.materialized(identity);
    return shell.fenceRunAdmission(
      identity,
      request.query as ClientRunLookupQueryV1,
    );
  }

  async alarm(): Promise<void> {
    await this.drainPush();
    const purgeValue = await this.ctx.storage.get<unknown>(
      MEMORY_VECTOR_PURGE_JOURNAL_KEY_V1,
    );
    if (purgeValue !== undefined) {
      await loggedEntryV1("Bot Memory vector purge", async () => {
        const journal = decodeMemoryVectorPurgeJournalV1(purgeValue);
        const outcome =
          journal.status === "pending"
            ? await this.purgeMemoryVectorBatch(journal)
            : "complete";
        if (outcome === "complete") {
          await this.finishTearDown({
            userId: journal.userId,
            botId: journal.botId,
          });
        }
      });
      return;
    }
    // The outbox drain is in a `finally` for the same reason the kernel's
    // re-arm is: it is the audit trail's second chance, and a throw anywhere in
    // the Bot's own settlement must not be what stops entries leaving.
    //
    // Both halves are then wrapped: an alarm has no caller, so anything that
    // escapes here is an uncaught exception in the object — which is one of the
    // ways the dev Worker died. The alarm is rescheduled by whatever owns it,
    // so recording the failure and letting the next firing try again is the
    // whole of the recovery.
    await loggedEntryV1("Bot alarm", async () => {
      try {
        await (await this.contribution()).alarm();
      } finally {
        // The alarm the Bot already has is also the audit outbox's second
        // chance: entries a settlement could not deliver leave on the next
        // firing rather than waiting for the Bot to be spoken to again.
        const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
        await Promise.all([
          loggedEntryV1("Bot audit outbox drain", () =>
            this.drainAuditOutbox(),
          ),
          // And the voice reply outbox's: an answer whose hand-off could not
          // reach the voice object leaves here rather than waiting for the
          // next thing anyone asks this Bot.
          loggedEntryV1("Bot voice reply outbox drain", () =>
            identity
              ? this.drainVoiceReplyOutbox(identity.userId)
              : Promise.resolve(),
          ),
        ]);
      }
    });
  }

  /**
   * Internal fetch surface reached only after the gateway authenticates
   * ownership.
   *
   * This is the state-channel upgrade, and it is where a `BotNotFoundError`
   * escaped and took the dev Worker down twice: a Durable Object's own `fetch`
   * is an entry point, so a throw here has no caller inside the object to catch
   * it. A Bot that is not there is a 404, and every other failure is a 500 that
   * still carries a reason.
   */
  fetch(request: Request): Promise<Response> {
    return answeredEntryV1("Bot-state channel failed", () =>
      this.#openChannel(request),
    );
  }

  async #openChannel(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== BOT_STATE_CHANNEL_INTERNAL_PATH) {
      return new Response("Not found", { status: 404 });
    }
    const userId = request.headers.get("x-frockbot-user-id");
    const botId = request.headers.get("x-frockbot-bot-id");
    if (!userId || !botId) {
      return Response.json(
        { error: "authenticated Bot identity required" },
        { status: 401 },
      );
    }
    const identity = { userId, botId };
    const { shell } = await this.materialized(identity);
    await shell.validateIdentity(identity);
    return this.stateChannel.upgrade(request, identity);
  }

  // Three more entry points with no caller. A throw in any of them is an
  // uncaught exception in the object, and none of them has anybody to answer.
  webSocketMessage(
    socket: WebSocket,
    _message: string | ArrayBuffer,
  ): Promise<void> {
    return loggedEntryV1("Bot-state channel message", () =>
      this.stateChannel.message(socket),
    );
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    return loggedEntryV1("Bot-state channel close", () =>
      this.stateChannel.close(socket, code, reason),
    );
  }

  webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    return loggedEntryV1("Bot-state channel error", () =>
      this.stateChannel.error(socket),
    );
  }
}

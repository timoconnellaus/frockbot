import {
  BillingError,
  BillingLedger,
  type BillingBalance,
  type ComplimentaryGrant,
  type PaidAccessState,
  type UsageReservation,
  type UsageSettlement,
} from "@frockbot/app/billing/ledger";
import {
  dailySpendV1,
  isSpendLimitScopeV1,
  localDayStartV1,
  readSpendLimitsV1,
  readSpendingRowsV1,
  setSpendLimitV1,
  SPEND_LIMIT_MAX_MICROS_V1,
  spendScopePausedV1,
  spendSpikeV1,
  spentOnScopeSinceV1,
  spendingCreditV1,
  spendingReportV1,
  type SpendingCreditV1,
  spendWindowV1,
  type SpendDimensionV1,
  type SpendingReportV1,
  type SpendPeriodV1,
} from "@frockbot/app/billing/spending";
import { accountPayments, type BillingEnv } from "./billing.js";
import {
  hostedBillingEnabledV1,
  type BillingSwitchEnv,
} from "./billing-readiness.js";
import { isPublicIdentifier } from "@frockbot/core/configuration";
import {
  accessEmailV1,
  decodeSetUserFeaturesRequestV1,
  decodeUserFeaturesReadRequestV1,
  decodeUserFeaturesV1,
  defaultUserFeaturesV1,
  type UserFeaturesV1,
} from "@frockbot/app/admin/shared";
import {
  decodePushRegistration,
  registerPushDevice,
  deliverPush,
  type PushUpdate,
} from "./push.js";
import { decodeThemeDocumentV1, decodeBotLookV1 } from "@frockbot/core/theme";
import { decodeProtocol } from "@frockbot/core/protocol-schemas";
import { DurableObject } from "cloudflare:workers";
import { cleanUserAvatarTestState } from "./avatar-state-cleanup.js";
import { cleanDirectoryProfileTestState } from "./directory-profile-cleanup.js";
import { cleanGroupChatLabelsV1 } from "./sidebar-label-cleanup.js";
import {
  decodeNativeSessionOperation,
  nativeSessionOperation,
} from "./native-sessions.js";
import {
  createFoundationUserBackendContributions,
  type FoundationConnectionUserBackendContribution,
  type MountedFoundationUserBackend,
} from "@frockbot/app/user";
import {
  decodeConnectionCommandIdV1,
  decodeConnectionCommandV1,
} from "@frockbot/core/connection";
import type { ConnectUserBackendContribution } from "@frockbot/app/connect/user";
import type { ConnectEventV1 } from "@frockbot/app/connect/events";
import type { ConnectTriggerOfferV1 } from "@frockbot/app/connect/triggers";
import { decodeRoutineCommandV1 } from "@frockbot/app/routines/shared";
import {
  decodeBotSettingsViewV1,
  userTimezoneV1,
  type UserSettingsViewV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
} from "@frockbot/core/configuration";
import {
  decodeRoutineCommandReceiptV1,
  decodeRoutineListViewV1,
} from "@frockbot/app/routines/shared";
import {
  decodeBotDirectoryProfileV1,
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotLifecycleViewV1,
  decodeCreateBotCommandV1,
  decodeAvatarIdentityViewV1,
  decodeFlockReceiptV1,
  decodeUpdateAvatarCommandV1,
  decodeUpdateVoiceCommandV1,
  decodeUpdateLookCommandV1,
  decodeBotVoiceForFlockV1,
  decodeVoiceIdentityViewV1,
  decodeLookIdentityViewV1,
  BotNotFoundError,
} from "@frockbot/app/flock/shared";
import {
  releaseSubagentSlotV1,
  reserveSubagentSlotV1,
  type SubagentSlotReceiptV1,
} from "@frockbot/app/subagents/quota";
import {
  releaseAgentTurnSlotV1,
  reserveAgentTurnSlotV1,
  type AgentTurnSlotReceiptV1,
} from "@frockbot/app/flock/quota";
import {
  DEVICE_CALL_WAIT_MS,
  decodeMachineModuleCallResultV1,
  decodeMachineModuleEventsV1,
  decodeMachineModuleReportsV1,
  machineTokenClaimsV1,
  type MachineModuleEventReceiptV1,
  type MachineModuleEventsReceiptV1,
  type MachineModuleReportsReceiptV1,
  type MachinePlatformV1,
  type MachineSocketFrameV1,
} from "@frockbot/core/machine-protocol";
import {
  generationCarriesModuleV1,
  machineModulesV1,
} from "@frockbot/app/machine/modules";
import {
  MachineModuleCallsV1,
  type DeviceCallOutcomeV1,
} from "@frockbot/app/machine/module-calls";
import {
  readPluginModuleReportsV1,
  recordPluginModuleReportsV1,
} from "@frockbot/app/plugins/module-reports";
import {
  listeningEventsV1,
  moduleEventDeliveryV1,
  moduleEventSeenV1,
  moduleEventTargetsV1,
  pluginTriggerIndexBuiltV1,
  readModuleRoutingV1,
  readPluginTriggerRoutinesV1,
  rebuildPluginTriggerIndexV1,
  recordModuleEventV1,
  refuseModuleEventV1,
  syncPluginTriggerRoutineV1,
  trimModuleEventsSeenV1,
  type PluginTriggerRoutineEntryV1,
} from "@frockbot/app/plugins/module-events";
import { DurableWorkspaceGenerations } from "@frockbot/core/durable";
import {
  COMPOSITION_CURRENT_KEY,
  decodeCompositionGenerationV1,
  decodeCompositionPinV1,
  type CompositionFailureInputV1,
  type CompositionOriginV1,
} from "@frockbot/core/durable";
import {
  readUserCompositionV1,
  reconcileInstalledProviderPluginsV1,
  userCompositionFailuresV1,
  userCompositionStoreV1,
} from "@frockbot/app/composition/user";
import {
  DEPLOYMENT_PLUGIN_CATALOG_V1,
  marketplacePluginPackageIdsV1,
} from "@frockbot/app/plugins/catalog";
import {
  CONNECTIONS_CATALOG_QUERY_MAX_V1,
  CONNECTIONS_FRAME_PROVIDERS_MAX_V1,
  type ConnectionsCatalogQueryV1,
} from "@frockbot/app/settings/frame";
import { cleanUndecodableSkillIndexesV1 } from "./skill-index-cleanup.js";
import { cleanUndecodableConnectCatalogsV1 } from "@frockbot/app/connect/account-catalog";
import { reseedInstructionRootV1 } from "@frockbot/app/skills/reseed";
import {
  base64ToBytes,
  beginDurableSkillPublicationV1,
  commitDurableSkillPublicationV1,
  heldSkillRevisionsV1,
  holdSkillIndexRevisionsV1,
  readDurableSkillIndexV1,
  readDurableSkillSnapshotV1,
  releaseSkillIndexHoldV1,
  releaseUnreferencedSkillSnapshotsV1,
} from "@frockbot/app/skills/index-store";
import { decodeWorkspaceGenerationV1 } from "@frockbot/core/contracts";
import { workspaceObjectPrefixV1 } from "@frockbot/core/workspace-store";
import { cleanRetiredMemoryFactObjectsV1 } from "@frockbot/app/memory/cleanup";
import { createR2ObjectBucketV1 } from "./workspace.js";
import { cleanUserAppletsV1 } from "./plugin-panels-cleanup.js";
import { cleanDefaultPackagesMarkerV1 } from "./default-packages-marker-cleanup.js";
import { cleanRetiredOllamaWebSearchV1 } from "./ollama-web-search-cleanup.js";
import { cleanUserMachineMessagesV1 } from "./machine-messages-cleanup.js";
import { ComputerLoginsLedgerV1 } from "@frockbot/app/shell/computer-logins";
import {
  MACHINE_SOCKET_INTERNAL_PATH_V1,
  broadcastMachineFrameV1,
  connectedMachinePlatformsV1,
  durableObjectMachineSocketsV1,
  machineSocketTagV1,
  readMachineSocketCallV1,
  type MachineSocketAttachmentV1,
} from "./machine-socket.js";
import type { FlockUserTransaction } from "@frockbot/app/flock/user";
import {
  decodeWorkspaceGenerationRecordV1,
  decodeWorkspaceRootV1,
  isWorkspaceSharedMemoryRootV1,
  normalizeWorkspaceRelativePathV1,
  type WorkspaceGenerationRecordV1,
  type WorkspaceRootV1,
} from "@frockbot/core/contracts";
import { memoryMembershipRevisionV1 } from "@frockbot/app/memory/engine-tools";
import { cleanRetiredProjectsV1 } from "./project-cleanup.js";
import { cleanRetiredBotTemplatesV1 } from "./bot-template-cleanup.js";
import {
  groupChatScopeV1,
  memoryScopeKeyV1,
} from "@frockbot/app/memory/records";
import {
  createUserMemoryEngineV1,
  dispatchMemoryOperateV1,
  drainDurableMemoryV1,
  durableObjectHasSqlV1,
  type MemoryOperateActionV1,
} from "./memory-records.js";
import type { MemoryEngineV1 } from "@frockbot/app/memory/engine";
import type {
  MemoryAiBinding,
  MemoryVectorIndex,
} from "@frockbot/app/memory/types";
import {
  SEARCH_MAX_ROW_PAGE_V1,
  decodeSearchQueryV1,
  type ClientSearchRebuildReceiptV1,
  type SearchIndexResultsV1,
} from "@frockbot/app/search";
import type { BotSearchRpc } from "./search.js";
import {
  AUDIT_ACTIVITY_FILTER_NAMES_V1,
  AUDIT_ACTIVITY_MAX_ROWS_V1,
  AUDIT_KINDS_V1,
  AUDIT_MAX_CURSOR_LENGTH_V1,
  AUDIT_MAX_ENTRY_PAGE_V1,
  AUDIT_MAX_RESULTS_V1,
  type AuditActivityFilterV1,
  type AuditActivityPageV1,
  type AuditRebuildReceiptV1,
  type ClientAuditPageV1,
} from "@frockbot/app/audit";
import type { BotAuditRpc } from "./audit.js";
import type { WorkerLoader } from "./contracts.js";
import {
  decodeRpcEnvelopeV1,
  rpcArray,
  rpcBotId,
  rpcBoolean,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcPattern,
  rpcString,
  rpcText,
  rpcEnum,
  rpcDecodedValue,
  rpcJsonRecord,
  rpcJsonSnapshotV1,
  rpcObject,
} from "./durable-rpc.js";
import { answeredEntryV1, loggedEntryV1 } from "./entry-boundary.js";
import {
  releaseBotUploadQuotaV1,
  releaseUploadQuotaV1,
  reserveUploadQuotaV1,
  type UploadQuotaAnswerV1,
} from "@frockbot/app/uploads/quota";
import { isUploadIdV1, UPLOAD_MAX_BYTES_V1 } from "@frockbot/core/contracts";
import {
  createSecretVaultV1,
  type SecretVaultV1,
} from "@frockbot/app/secrets/user";
import {
  isSecretIdV1,
  isSecretRequestIdV1,
  SECRET_LIMITS_V1,
  secretOriginV1,
} from "@frockbot/app/secrets/shared";
import {
  GroupChatUserStoreV1,
  type GroupChatChangeV1,
  type GroupChatUserStorageV1,
} from "@frockbot/app/groups/user";
import {
  GroupChatNotFoundError,
  answerGroupRpcV1,
  decodeGroupChatCommandV1,
  groupChatObjectNameV1,
  type GroupActorV1,
  type GroupChatCommandV1,
} from "@frockbot/app/groups/shared";
import type { BotUserConfigurationRpcTargetV1 } from "@frockbot/app/shell/durable-rpc-targets";
import {
  ACCOUNT_DELETED_KEY_V1,
  ACCOUNT_DELETION_KEY_V1,
  AccountDeletedError,
  accountDeletionRetryDelayMsV1,
  advanceAccountDeletionV1,
  beginAccountDeletionV1,
  readAccountDeletionV1,
  type AccountDeletionRecordV1,
  type AccountDeletionTombstoneV1,
} from "@frockbot/app/account/deletion";
import { sha256HexV1 } from "@frockbot/core/crypto";
import {
  runAccountDeletionStepV1,
  type AccountDeletionEnvV1,
  type AccountDeletionUserSeamsV1,
} from "./account-deletion.js";
import {
  computerHostBindingV1,
  createComputerHostV1,
} from "./computer-host.js";
import type { AuthPackageEnvironmentV1 } from "#auth-package";
import type { VoiceAssistant } from "./voice-assistant.js";
import {
  InboundEmailUserStoreV1,
  type InboundEmailUserHostV1,
} from "@frockbot/app/email/user";
import {
  emailDomainV1,
  normalizeSenderAddressV1,
  type BotEmailSenderV1,
  type InboundEmailRouteDecisionV1,
  type InboundEmailStateV1,
} from "@frockbot/app/email/shared";
import { DEPLOYMENT_POLICY_SINGLETON_NAME } from "./deployment-policy.js";

/** The durable key pinning the User this object was provisioned for. */
const USER_IDENTITY_KEY = "user:identity";
/** The durable key holding what an administrator turned on for this User. */
const USER_FEATURES_KEY = "user:features:v1";
/** One receipt per "Delete my Computer" press that destroyed a Computer. */
const COMPUTER_TEARDOWN_RECEIPT_PREFIX = "computer:teardown:";

interface UserConfigurationEnv
  extends BillingEnv, AccountDeletionEnvV1, AuthPackageEnvironmentV1 {
  FCM_SERVICE_ACCOUNT?: string;
  ALLOW_DEVELOPMENT_AUTH?: string;
  /** Where every Bot's email address is, and what it sends from. */
  EMAIL_DOMAIN?: string;
  BETTER_AUTH_URL?: string;
  CREDENTIAL_KEYRING?: string;
  /** The Connected apps provider key. Absent, nothing can be connected. */
  COMPOSIO_API_KEY?: string;
  /**
   * Signs every machine token and pairing code. Absent closes the door: a
   * pairing is refused rather than offered under a signature nothing could
   * verify.
   */
  MACHINE_TOKEN_SECRET?: string;
  /** Bot authority: archive and restore are carried to the Bot Durable Object. */
  BOT_STATES: DurableObjectNamespace;
  /** Each Group Chat's own object, told about every change to its group. */
  GROUP_CHATS?: DurableObjectNamespace;
  /**
   * This object's own namespace. Every caller reaches a User Durable Object
   * through `idFromName(userId)`, so the namespace is how the object checks
   * that the `userId` an RPC carries is the one it *is*.
   */
  USER_CONFIGURATIONS: DurableObjectNamespace;
  /** Immutable published application source and artifact bytes. */
  APPLICATION_ARTIFACTS: R2Bucket;
  /** The loader that health-checks a candidate artifact before activation. */
  USER_APPLICATIONS: WorkerLoader;
  MEMORY_FILES?: R2Bucket;
  /** Derived Memory vectors for User and shared scopes. Same Worker binding as Bot. */
  MEMORY_INDEX?: MemoryVectorIndex;
  /** Workers AI embeddings for User and shared Memory. */
  AI?: MemoryAiBinding;
  /**
   * The Plugin worker loader. The User object never loads anything with it;
   * it reads it to know whether this deployment can run a Plugin at all,
   * which is what decides whether the seeded catalog is reconciled in.
   */
  BOT_PACKAGES?: WorkerLoader;
}

/** A mailbox exactly as normalized, or a refusal of the whole request. */
function requiredSenderAddress(value: unknown): string {
  const address = normalizeSenderAddressV1(value);
  if (address === undefined || address !== value) {
    throw new Error("RPC request address is invalid");
  }
  return address;
}

/** The page of a Bot's projected rows a rebuild pulls, one Bot at a time. */
const SEARCH_REBUILD_BOT_LIMIT = 200;

export class UserConfiguration
  extends DurableObject<UserConfigurationEnv>
  implements BotUserConfigurationRpcTargetV1
{
  constructor(ctx: DurableObjectState, env: UserConfigurationEnv) {
    super(ctx, env);
    // Before any request or alarm can read retired stored shapes.
    this.ctx.blockConcurrencyWhile(async () => {
      // A deleted account is its tombstone and nothing else: no cleanup may
      // write a receipt back into it.
      if (
        (await this.ctx.storage.get<unknown>(ACCOUNT_DELETED_KEY_V1)) !==
        undefined
      )
        return;
      // A deleting one still reads its shapes, but reseeds no Skills into
      // the bucket it is emptying and arms no alarm but the deletion's.
      const deleting =
        (await readAccountDeletionV1(this.ctx.storage)) !== undefined;
      await cleanUserAppletsV1(this.ctx.storage);
      await cleanUserAvatarTestState(this.ctx.storage);
      await cleanDirectoryProfileTestState(this.ctx.storage);
      await cleanGroupChatLabelsV1(this.ctx.storage);
      await cleanDefaultPackagesMarkerV1(this.ctx.storage);
      await cleanUndecodableSkillIndexesV1(this.ctx.storage);
      await cleanUndecodableConnectCatalogsV1(this.ctx.storage);
      await cleanRetiredOllamaWebSearchV1(this.ctx.storage);
      // Before anything decodes a machine record or a queued command.
      await cleanUserMachineMessagesV1(this.ctx.storage);
      await cleanRetiredBotTemplatesV1(
        this.ctx.storage,
        this.env.APPLICATION_ARTIFACTS,
      );
      const userId = await this.ctx.storage.get<string>(USER_IDENTITY_KEY);
      const objects = this.env.MEMORY_FILES
        ? createR2ObjectBucketV1(this.env.MEMORY_FILES)
        : undefined;
      await cleanRetiredProjectsV1(this.ctx.storage, {
        ...(typeof userId === "string" ? { userId } : {}),
        ...(objects
          ? {
              bucket: {
                list: async (options) => {
                  const page = await objects.list(options);
                  return {
                    keys: page.objects.map((object) => object.key),
                    ...(page.cursor ? { cursor: page.cursor } : {}),
                    truncated: page.truncated,
                  };
                },
                delete: (key) => objects.delete(key),
              },
            }
          : {}),
        ...(durableObjectHasSqlV1(this.ctx.storage)
          ? { engine: createUserMemoryEngineV1(this.ctx.storage) }
          : {}),
      });
      if (typeof userId === "string" && this.env.MEMORY_FILES && !deleting) {
        await reseedInstructionRootV1({
          storage: this.ctx.storage,
          bucket: createR2ObjectBucketV1(this.env.MEMORY_FILES),
          root: { kind: "user-instructions", userId },
          receiptKey: "maintenance:skill-index:user:2026-09-22",
        });
        const bucket = createR2ObjectBucketV1(this.env.MEMORY_FILES);
        await cleanRetiredMemoryFactObjectsV1(
          this.ctx.storage,
          {
            list: async (options) => {
              const page = await bucket.list(options);
              return {
                keys: page.objects.map((object) => object.key),
                ...(page.cursor ? { cursor: page.cursor } : {}),
                truncated: page.truncated,
              };
            },
            delete: (key) => bucket.delete(key),
          },
          workspaceObjectPrefixV1({ kind: "user-memory", userId }),
        );
      }
      if (!deleting && durableObjectHasSqlV1(this.ctx.storage)) {
        const memoryDue = createUserMemoryEngineV1(
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
    // A desktop's keep-alive is answered without waking this object, so an
    // idle machine socket costs nothing while it hibernates.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  /** This User's Profile timezone, for deciding whether a save moved it. */
  private async routineTimezone(userId: string): Promise<string> {
    return userTimezoneV1(
      (await (await this.settingsContribution()).read(userId)).profile,
    );
  }

  /**
   * Push a moved Profile timezone to every Bot, so an alarm that fires without
   * a Turn already holds it.
   *
   * A Bot that cannot be reached is left behind rather than failing the save
   * that already committed: the mount re-projects the zone on the next Turn,
   * and reporting a conflict for a change that succeeded is the worse answer.
   */
  private async propagateRoutineTimezone(
    userId: string,
    before: string,
  ): Promise<void> {
    const settings = await (await this.settingsContribution()).read(userId);
    const timezone = userTimezoneV1(settings.profile);
    if (timezone === before) return;
    const directory = await (await this.flockContribution()).listBots();
    await Promise.all(
      directory.bots.map(async (bot) => {
        const id = this.env.BOT_STATES.idFromName(`${userId}:${bot.botId}`);
        const rpc = this.env.BOT_STATES.get(id) as unknown as {
          refreshRoutineTimezone(input: unknown): Promise<unknown>;
        };
        try {
          await rpc.refreshRoutineTimezone({
            schemaVersion: 1,
            userId,
            botId: bot.botId,
            timezone,
            revision: settings.revision,
          });
        } catch {
          // Left to the next mount, which projects the zone on every Turn.
        }
      }),
    );
  }

  async reconcileBilling(input: {
    userId: string;
    command: Parameters<BillingLedger["reconcile"]>[0];
  }) {
    await this.assertUserIdentity(input.userId);
    this.billing().reconcile(input.command);
  }
  private billing() {
    return new BillingLedger(this.ctx.storage);
  }
  async readBilling(input: { userId: string; before?: number }) {
    await this.assertUserIdentity(input.userId);
    return this.billing().snapshot(input.before);
  }
  /** Where the account's credit went, from the ledger's rollups. */
  async readSpending(input: {
    userId: string;
    period: SpendPeriodV1;
    groupBy: SpendDimensionV1;
    filters: Partial<Record<SpendDimensionV1, string>>;
  }): Promise<SpendingReportV1> {
    await this.assertUserIdentity(input.userId);
    const ledger = this.billing();
    const [timezone, directory] = await Promise.all([
      this.routineTimezone(input.userId),
      (await this.flockContribution()).listBots(),
    ]);
    const query = {
      ...spendWindowV1(
        input.period,
        Date.now(),
        ledger.get<PaidAccessState>("paidAccess")?.periodStart,
      ),
      groupBy: input.groupBy,
      filters: input.filters,
    };
    return spendingReportV1(
      query,
      readSpendingRowsV1(this.ctx.storage.sql, query),
      {
        userId: input.userId,
        bots: Object.fromEntries(
          directory.bots.map((bot) => [
            bot.botId,
            bot.currentProfile?.name ?? bot.initialName,
          ]),
        ),
      },
      timezone,
      this.spendingCredit(ledger),
      this.spendingLimits(localDayStartV1(Date.now(), timezone)),
    );
  }
  /** Every daily limit the account set, and what each has spent today. */
  private spendingLimits(dayStart: number) {
    const sql = this.ctx.storage.sql;
    return new Map(
      [...readSpendLimitsV1(sql)].map(([scope, dailyMicros]) => [
        scope,
        {
          dailyMicros,
          todayMicros: spentOnScopeSinceV1(sql, scope, dayStart),
        },
      ]),
    );
  }
  /** The person's last midnight, cached briefly: every paid call asks. */
  private async dayStart(userId: string): Promise<number> {
    const now = Date.now();
    if (!this.cachedTimezone || this.cachedTimezone.until < now)
      this.cachedTimezone = {
        timezone: await this.routineTimezone(userId),
        until: now + 60_000,
      };
    return localDayStartV1(now, this.cachedTimezone.timezone);
  }
  private cachedTimezone: { timezone: string; until: number } | undefined;

  /** Set or clear one Bot's or Routine's daily limit. */
  async setSpendingLimit(input: {
    userId: string;
    scope: string;
    dailyMicros: number | null;
  }): Promise<void> {
    await this.assertUserIdentity(input.userId);
    if (
      !isSpendLimitScopeV1(input.scope) ||
      (input.dailyMicros !== null &&
        (!Number.isSafeInteger(input.dailyMicros) ||
          input.dailyMicros <= 0 ||
          input.dailyMicros > SPEND_LIMIT_MAX_MICROS_V1))
    )
      throw new BillingError("Invalid daily limit", 400);
    this.billing();
    setSpendLimitV1(this.ctx.storage.sql, input.scope, input.dailyMicros);
  }

  /**
   * Whether any of these Routine or Bot limits has paused them today. An
   * account with no limits answers without reading anything else.
   */
  async readSpendingPaused(input: {
    userId: string;
    scopes: string[];
  }): Promise<boolean> {
    await this.assertUserIdentity(input.userId);
    this.billing();
    const sql = this.ctx.storage.sql;
    if (readSpendLimitsV1(sql).size === 0) return false;
    const dayStart = await this.dayStart(input.userId);
    return input.scopes
      .filter(isSpendLimitScopeV1)
      .some((scope) => spendScopePausedV1(sql, scope, dayStart));
  }

  /**
   * A day well above a Routine's usual, told once a day: the first ask that
   * finds one gets it, and every later ask that day gets nothing.
   */
  async claimSpendingSpike(input: {
    userId: string;
    scope: string;
  }): Promise<{ todayMicros: number; usualMicros: number } | null> {
    await this.assertUserIdentity(input.userId);
    if (!isSpendLimitScopeV1(input.scope)) return null;
    const ledger = this.billing();
    const dayStart = await this.dayStart(input.userId);
    const spike = spendSpikeV1(this.ctx.storage.sql, input.scope, dayStart);
    if (!spike) return null;
    // One key per scope, holding the day it was last told.
    const told = `spike:${input.scope}`;
    if (ledger.get<number>(told) === dayStart) return null;
    ledger.set(told, dayStart);
    return spike;
  }
  /**
   * How long the account's credit lasts at its recent pace. None where the
   * deployment does not bill: there is no credit to run out.
   */
  private spendingCredit(ledger: BillingLedger): SpendingCreditV1 | null {
    if (!hostedBillingEnabledV1(this.env as BillingSwitchEnv)) return null;
    const now = Date.now();
    const balance = ledger.balance();
    return spendingCreditV1(
      // Without a subscription only complimentary credit is spendable.
      balance.subscribed
        ? balance.includedMicros +
            balance.complimentaryMicros +
            balance.purchasedMicros
        : balance.complimentaryMicros,
      dailySpendV1(this.ctx.storage.sql, now),
      balance.subscribed
        ? (ledger.get<PaidAccessState>("paidAccess")?.periodEnd ?? null)
        : null,
      now,
    );
  }
  async readBillingBalance(input: { userId: string }): Promise<BillingBalance> {
    await this.assertUserIdentity(input.userId);
    return this.billing().balance();
  }
  /** An administrator's hand-granted credit. Returns the balance it left. */
  async grantComplimentaryCredit(input: {
    userId: string;
    command: ComplimentaryGrant;
  }): Promise<BillingBalance> {
    await this.assertUserIdentity(input.userId);
    const ledger = this.billing();
    ledger.grantComplimentary(input.command);
    return ledger.balance();
  }
  async billingCheckout(input: {
    userId: string;
    command: { id: string; kind: "subscription" | "topup"; cents?: number };
  }) {
    await this.assertUserIdentity(input.userId);
    await this.assertAccountOpen();
    return accountPayments(this.billing(), this.env, input.userId).checkout(
      input.command,
    );
  }
  async billingPortal(input: { userId: string; commandId: string }) {
    await this.assertUserIdentity(input.userId);
    await this.assertAccountOpen();
    return accountPayments(this.billing(), this.env, input.userId).portal(
      input.commandId,
    );
  }
  async billingWebhook(input: {
    userId: string;
    event: Record<string, unknown>;
  }) {
    await this.assertUserIdentity(input.userId);
    await accountPayments(this.billing(), this.env, input.userId).webhook(
      input.event,
    );
  }
  async reserveUsage(input: { userId: string; reservation: UsageReservation }) {
    await this.assertUserIdentity(input.userId);
    await this.assertAccountOpen();
    const ledger = this.billing();
    // Only an account with a limit pays for reading its timezone.
    const limited = readSpendLimitsV1(this.ctx.storage.sql).size > 0;
    return ledger.reserve(
      input.reservation,
      limited ? await this.dayStart(input.userId) : undefined,
    );
  }
  async settleUsage(input: { userId: string; settlement: UsageSettlement }) {
    await this.assertUserIdentity(input.userId);
    this.billing().settle(input.settlement);
  }
  async requirePaidAccount(input: { userId: string }) {
    await this.assertUserIdentity(input.userId);
    this.billing().requireSubscription();
  }

  /**
   * Counts one upload against the account's upload space, once for each Bot
   * and file, in one transaction so two uploads cannot both take the last of
   * it (`app/uploads/quota.ts`).
   */
  async reserveUploadQuota(input: unknown): Promise<UploadQuotaAnswerV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      uploadId: rpcPattern(/^[0-9a-f]{64}$/, 64),
      bytes: rpcInteger({ minimum: 1, maximum: UPLOAD_MAX_BYTES_V1 }),
    });
    await this.assertUserIdentity(request.userId as string);
    // A deleting account takes no new file: its Bots' uploads are being
    // removed, and one counted now could land after its Bot's were.
    await this.assertAccountOpen();
    return this.ctx.storage.transaction((transaction) =>
      reserveUploadQuotaV1(transaction, {
        botId: request.botId as string,
        uploadId: request.uploadId as string,
        bytes: request.bytes as number,
      }),
    );
  }

  /**
   * Gives back the space of uploads one Bot deleted while it lives on — a
   * demonstration the person sent it, once its Skill is decided. Idempotent.
   * It works on a deleting account too: giving space back starts nothing.
   */
  async releaseUploadQuota(input: unknown): Promise<{ released: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      uploadIds: rpcDecoded((value) => {
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.length > 16 ||
          !value.every((entry) => isUploadIdV1(entry))
        ) {
          throw new Error("uploadIds must name one to sixteen uploads");
        }
        return value as string[];
      }),
    });
    await this.assertUserIdentity(request.userId as string);
    return this.ctx.storage.transaction((transaction) =>
      releaseUploadQuotaV1(transaction, {
        botId: request.botId as string,
        uploadIds: request.uploadIds as string[],
      }),
    );
  }

  /** Gives back the upload space of a Bot that has been deleted. Idempotent. */
  async releaseBotUploadQuota(input: unknown): Promise<{ released: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertUserIdentity(request.userId as string);
    let released = 0;
    for (;;) {
      const page = await this.ctx.storage.transaction((transaction) =>
        releaseBotUploadQuotaV1(transaction, request.botId as string),
      );
      released += page.released;
      if (!page.more) return { released };
    }
  }

  async registerPush(input: { userId: string; registration: unknown }) {
    await this.assertUserIdentity(input.userId);
    await this.assertAccountOpen();
    await registerPushDevice(
      this.ctx.storage,
      decodePushRegistration(input.registration),
    );
    return { ok: true };
  }

  async deliverPush(input: { userId: string; update: PushUpdate }) {
    await this.assertUserIdentity(input.userId);
    await this.assertAccountOpen();
    if (
      !isPublicIdentifier(input.update.botId) ||
      !/^message-[0-9]{20}$/.test(input.update.cursor) ||
      !["message", "read"].includes(input.update.kind)
    )
      throw new Error("Invalid push update");
    await deliverPush(
      this.ctx.storage,
      input.userId,
      input.update,
      this.env.FCM_SERVICE_ACCOUNT,
    );
  }

  /**
   * A member of a Group Chat called the person's attention with `@User`.
   * The group is what the alert opens; its cursor is the group's own.
   */
  async deliverGroupPush(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      groupId: rpcPattern(/^g-[0-9a-f]{20}$/, 22),
      botId: rpcBotId,
      seq: rpcInteger({ minimum: 1, maximum: 99_999_999_999 }),
      title: rpcText(200),
      body: rpcText(240),
    });
    const userId = request.userId as string;
    await this.assertUserIdentity(userId);
    await this.assertAccountOpen();
    await deliverPush(
      this.ctx.storage,
      userId,
      {
        botId: request.botId as string,
        groupId: request.groupId as string,
        cursor: `message-${String(request.seq).padStart(20, "0")}`,
        kind: "message",
        title: request.title as string,
        body: request.body as string,
        notify: true,
      },
      this.env.FCM_SERVICE_ACCOUNT,
    );
    return { schemaVersion: 1 } as const;
  }

  async nativeSession(input: unknown) {
    try {
      const operation = decodeNativeSessionOperation(input);
      if (operation.action === "issue") {
        await this.assertUserIdentity(operation.userId);
        await this.assertAccountOpen();
      } else if (
        // Deleting the account signs every device out at once: a session
        // that still read back could be admitted afresh once the access
        // record is forgotten.
        (await this.accountClosing()) ||
        (await this.addressedUser(operation.userId)) === undefined
      ) {
        return {
          schemaVersion: 1 as const,
          status: "ok" as const,
          record: null,
        };
      }
      const record = this.ctx.storage.transactionSync(() =>
        nativeSessionOperation(this.ctx.storage.kv, operation, Date.now()),
      );
      return { schemaVersion: 1 as const, status: "ok" as const, record };
    } catch {
      // RPC refusals are data. Expected failures must not escape a DO entry
      // as unhandled promise rejections in workerd.
      return { schemaVersion: 1 as const, status: "refused" as const };
    }
  }

  private mounted: Promise<MountedFoundationUserBackend> | undefined;

  private contributions(): Promise<MountedFoundationUserBackend> {
    if (!this.mounted) {
      this.mounted = createFoundationUserBackendContributions({
        storage: this.ctx.storage,
        machineSockets: durableObjectMachineSocketsV1(this.ctx),
        readSecret: (name) =>
          name === "MACHINE_TOKEN_SECRET"
            ? this.env.MACHINE_TOKEN_SECRET
            : name === "BETTER_AUTH_URL"
              ? this.env.BETTER_AUTH_URL
              : name === "COMPOSIO_API_KEY"
                ? this.env.COMPOSIO_API_KEY
                : this.env.CREDENTIAL_KEYRING,
        // The transcript index (parity register row 52). It lives on this
        // object's own SQL storage because "The User's Durable Object is the
        // authority for everything User-scoped", and it is a *projection*:
        // its rows are read back out of the Bots' own stored runs by
        // `rebuildSearchIndex`, so it holds no authority of its own.
        search: {
          sql: this.ctx.storage.sql,
          projectBotRows: (botId, cursor) => {
            // Every caller of a rebuild has already passed
            // `assertFlockIdentity`, so this object knows which User it is;
            // a rebuild that reached here without one would address an
            // arbitrary Bot object, so it refuses instead.
            const userId = this.identity;
            if (!userId) {
              throw new Error(
                "this User Durable Object has no proven identity to rebuild for",
              );
            }
            const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
            // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
            const rpc = this.env.BOT_STATES.get(id) as unknown as BotSearchRpc;
            return rpc
              .projectSearchRows({
                schemaVersion: 1,
                userId,
                botId,
                ...(cursor === undefined ? {} : { cursor }),
              })
              .then(rpcJsonSnapshotV1);
          },
        },
        // The audit table (parity register rows 30 and 30b). Same object,
        // same SQL storage, same discipline as the transcript index: every
        // row is a projection of the Bots' own durable session events, and
        // `rebuildAuditIndex` reads them back from that authority.
        audit: {
          sql: this.ctx.storage.sql,
          projectBotEntries: (botId, cursor) => {
            const userId = this.identity;
            if (!userId) {
              throw new Error(
                "this User Durable Object has no proven identity to rebuild for",
              );
            }
            const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
            // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
            const rpc = this.env.BOT_STATES.get(id) as unknown as BotAuditRpc;
            return rpc
              .projectAuditEntries({
                schemaVersion: 1,
                userId,
                botId,
                ...(cursor === undefined ? {} : { cursor }),
              })
              .then(rpcJsonSnapshotV1);
          },
        },
        commandBotLifecycle: async (userId, command) => {
          const id = this.env.BOT_STATES.idFromName(
            `${userId}:${command.botId}`,
          );
          // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
          const rpc = this.env.BOT_STATES.get(id) as unknown as {
            executeLifecycle(input: unknown): Promise<unknown>;
          };
          return decodeBotLifecycleReceiptV1(
            await rpc.executeLifecycle({
              schemaVersion: 1,
              userId,
              botId: command.botId,
              command,
            }),
          );
        },
        readBotLifecycle: async (userId, botId) => {
          const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
          // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
          const rpc = this.env.BOT_STATES.get(id) as unknown as {
            readLifecycle(input: unknown): Promise<unknown>;
          };
          return decodeBotLifecycleViewV1(
            await rpc.readLifecycle({ schemaVersion: 1, userId, botId }),
          );
        },
      });
    }
    return this.mounted;
  }

  /**
   * The User this Durable Object is.
   *
   * Comparing an RPC's `userId` with a root's `userId` proves only that the
   * request agrees with itself; both come from the caller. A User Durable
   * Object is addressed by `idFromName(userId)`, so its identity is the name
   * it was constructed for: the id derived from the claimed `userId` must be
   * this object's own id. That identity is also pinned in durable storage the
   * first time it is asserted — provisioning is the first RPC a new User
   * object ever receives — so the check survives eviction.
   *
   * A missing namespace binding is a refusal, not a fallback. Without it the
   * only remaining check is the pin, and the pin trusts whoever called first:
   * an object that has never been addressed would take its identity from the
   * caller and then defend it for ever. The binding is present in production
   * and every test binds it, so its absence is a broken deployment rather than
   * a state to serve requests in.
   */
  private identity: string | undefined;

  /**
   * Whether this instance has already given the account General, or found it
   * given. Separate from `identity`, which an alarm restores with no request
   * behind it.
   */
  private bootstrapped = false;

  private async assertUserIdentity(userId: string): Promise<string> {
    if (this.identity !== userId) await this.proveUserIdentity(userId);
    if (!this.bootstrapped) {
      // Every admitted request reaches its User through here, so this is where
      // an account is given General: before the first thing it reads, and not
      // only when a client happens to read the directory. The memo makes it
      // once per instance, and the Flock's marker makes it once ever.
      await (await this.flockContribution()).provisionGeneral();
      this.bootstrapped = true;
    }
    return userId;
  }

  private async proveUserIdentity(userId: string): Promise<void> {
    const namespace = this.env.USER_CONFIGURATIONS;
    if (!namespace) {
      throw new Error(
        "the User Durable Object namespace is unbound, so this object cannot prove which User it is",
      );
    }
    if (!namespace.idFromName(userId).equals(this.ctx.id)) {
      throw new Error(
        "this User Durable Object is the authority for a different User",
      );
    }
    // A deleted account is never provisioned again, whoever asks: a late
    // webhook or a stray Bot call would otherwise pin a fresh identity and
    // give it a General.
    await this.assertNotDeleted();
    const pinned = await this.ctx.storage.get<string>(USER_IDENTITY_KEY);
    if (pinned !== undefined && pinned !== userId) {
      throw new Error(
        "this User Durable Object is the authority for a different User",
      );
    }
    if (pinned === undefined) {
      await this.ctx.storage.put(USER_IDENTITY_KEY, userId);
    }
    this.identity = userId;
  }

  private async assertNotDeleted(): Promise<void> {
    if (
      (await this.ctx.storage.get<unknown>(ACCOUNT_DELETED_KEY_V1)) !==
      undefined
    )
      throw new AccountDeletedError();
  }

  /**
   * Refuses work that would start something while the account is being
   * deleted: a Turn, a spend, a Bot, a group, a connection, a payment, a push,
   * a saved secret or a fill of one.
   * Each would either reach something the deletion already removed or leave
   * something behind it. The saga's own calls — a Bot reading its
   * registration to tear itself down — do not come through here.
   */
  private async assertAccountOpen(): Promise<void> {
    if (await this.accountClosing()) throw new AccountDeletedError();
  }

  /** Whether this account is being deleted, or has been. */
  private async accountClosing(): Promise<boolean> {
    return (
      (await this.ctx.storage.get<unknown>(ACCOUNT_DELETION_KEY_V1)) !==
        undefined ||
      (await this.ctx.storage.get<unknown>(ACCOUNT_DELETED_KEY_V1)) !==
        undefined
    );
  }

  /**
   * The identity this object can prove with no caller present.
   *
   * `assertUserIdentity` checks a `userId` a caller claimed, and an alarm has
   * no caller: a fresh instance woken by its own alarm after an eviction is
   * the normal case, not the exception, so the work an alarm exists to do
   * cannot depend on an RPC having populated the in-memory field first.
   *
   * The pin is that claim made durable, so it is re-derived here and put
   * through the same namespace check before it is trusted — a pin alone would
   * be whatever the first caller said. An object that cannot prove an identity
   * this way has no User-scoped recovery to run.
   */
  private async provenIdentity(): Promise<string | undefined> {
    if (this.identity) return this.identity;
    const pinned = await this.ctx.storage.get<string>(USER_IDENTITY_KEY);
    if (pinned === undefined) return undefined;
    const namespace = this.env.USER_CONFIGURATIONS;
    if (!namespace || !namespace.idFromName(pinned).equals(this.ctx.id)) {
      return undefined;
    }
    this.identity = pinned;
    return pinned;
  }

  private async settingsContribution(): Promise<
    MountedFoundationUserBackend["settings"]
  > {
    return (await this.contributions()).settings;
  }

  private async connectionContribution(
    packageId: string,
  ): Promise<FoundationConnectionUserBackendContribution> {
    const contribution = (await this.contributions()).connections.get(
      packageId,
    );
    if (!contribution) {
      throw new Error(`Connection Package "${packageId}" is unavailable`);
    }
    return contribution;
  }

  private async connectContribution(): Promise<ConnectUserBackendContribution> {
    return (await this.contributions()).connect;
  }

  private botRoutinesStub(userId: string, botId: string) {
    const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
    return this.env.BOT_STATES.get(id) as unknown as {
      deliverConnectEvent(input: unknown): Promise<unknown>;
      executeRoutineCommand(input: unknown): Promise<unknown>;
      deliverPluginModuleEvent(
        input: unknown,
      ): Promise<{ status: string; reason?: string }>;
      listPluginTriggerRoutines(
        input: unknown,
      ): Promise<
        Array<{ routineId: string; pluginId: string; trigger: string }>
      >;
    };
  }

  private async flockContribution(): Promise<
    MountedFoundationUserBackend["flock"]
  > {
    return (await this.contributions()).flock;
  }

  /**
   * Checks that this object is the one `userId` names, without provisioning
   * it: the durable pin is read and compared, never written. What comes back
   * is the pin, so a caller can tell an unprovisioned User from a provisioned
   * one.
   */
  private async addressedUser(userId: string): Promise<string | undefined> {
    const namespace = this.env.USER_CONFIGURATIONS;
    if (!namespace || !namespace.idFromName(userId).equals(this.ctx.id)) {
      throw new Error(
        "this User Durable Object is the authority for a different User",
      );
    }
    await this.assertNotDeleted();
    const pinned = await this.ctx.storage.get<string>(USER_IDENTITY_KEY);
    if (pinned !== undefined && pinned !== userId) {
      throw new Error(
        "this User Durable Object is the authority for a different User",
      );
    }
    return pinned;
  }

  // --- Deleting the account ---------------------------------------------------
  //
  // The person confirmed, so everything they own goes now. The saga is
  // `@frockbot/app/account/deletion`; its steps are `./account-deletion.ts`.

  /**
   * Starts deleting this account, or joins the deletion already under way.
   *
   * The record is written first, which closes this object to new work at
   * once, and access is ended before the answer so the person's other devices
   * are refused from their next request rather than from the alarm's. The
   * rest runs on the alarm, which is set before anything else can fail.
   */
  async beginAccountDeletion(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier, commandId: rpcIdentifier },
      { email: rpcString(320) },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    // Only an address the access authority would itself accept, or its last
    // step could never forget the invitation kept under it.
    const email = accessEmailV1(request.email);
    const { record } = await beginAccountDeletionV1(this.ctx.storage, {
      userId,
      commandId: request.commandId as string,
      ...(email === undefined ? {} : { email }),
    });
    await this.ctx.storage.setAlarm(Date.now());
    try {
      await runAccountDeletionStepV1(
        this.env,
        this.accountDeletionSeams(userId),
        "access",
        record,
      );
    } catch {
      // The saga's own first step repeats it.
    }
    return {
      schemaVersion: 1 as const,
      status: "deleting" as const,
      requestedAt: record.requestedAt,
    };
  }

  /**
   * "Delete my Computer": its files and browser logins go, and the next Bot
   * that needs a Computer gets a new, empty one.
   *
   * Receipted by the command, so a retried press after a success never
   * destroys the fresh Computer a Bot may have opened since. A press that
   * failed wrote no receipt and can simply be pressed again: tearing down a
   * Computer that is already gone is a teardown.
   */
  async deleteComputer(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      commandId: rpcIdentifier,
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    await this.assertAccountOpen();
    const receiptKey = `${COMPUTER_TEARDOWN_RECEIPT_PREFIX}${request.commandId as string}`;
    if ((await this.ctx.storage.get<unknown>(receiptKey)) !== undefined)
      return { schemaVersion: 1 as const, status: "deleted" as const };
    const binding = computerHostBindingV1(this.env);
    const host = binding ? createComputerHostV1(binding) : undefined;
    if (!host?.teardown)
      return { schemaVersion: 1 as const, status: "unavailable" as const };
    // The kept sign-ins go with the Computer, on both sides of the teardown:
    // before it, so an Update under way stops before it opens a new machine;
    // after it, so a capture a Turn's end kept in between is dropped too.
    const logins = this.computerLogins();
    await logins.forget(new Date().toISOString());
    await host.teardown({ userId });
    await logins.forget(new Date().toISOString());
    await this.ctx.storage.put(receiptKey, {
      schemaVersion: 1,
      deletedAt: new Date().toISOString(),
    });
    return { schemaVersion: 1 as const, status: "deleted" as const };
  }

  #deletionPass: Promise<void> | undefined;

  /**
   * One pass of the deletion saga, and never two at once: a pass that finds
   * another running waits for it rather than repeating its steps beside it.
   */
  private advanceAccountDeletion(): Promise<void> {
    this.#deletionPass ??= this.#advanceAccountDeletion().finally(() => {
      this.#deletionPass = undefined;
    });
    return this.#deletionPass;
  }

  /**
   * The next alarm is armed before the pass, so a pass that dies half way —
   * an eviction, a thrown step the entry boundary swallowed — is picked up
   * again rather than stranding the account half deleted.
   */
  async #advanceAccountDeletion(): Promise<void> {
    if (
      (await this.ctx.storage.get<unknown>(ACCOUNT_DELETED_KEY_V1)) !==
      undefined
    ) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const progress = await advanceAccountDeletionV1({
      storage: this.ctx.storage,
      run: (step, record: AccountDeletionRecordV1) =>
        runAccountDeletionStepV1(
          this.env,
          this.accountDeletionSeams(record.userId),
          step,
          record,
        ),
      erase: (tombstone) => this.eraseAccount(tombstone),
    });
    const delay = accountDeletionRetryDelayMsV1(progress);
    if (delay !== undefined)
      await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  /**
   * The object's own storage, last: every key and every table, the alarm,
   * then the tombstone. Nothing else runs in between, so no request can read
   * or write the half-wiped object. What is in memory goes too, so nothing
   * cached from before can write the account back.
   *
   * The tombstone cannot be written before the wipe, which would take it
   * too. An object that died between the two would be empty with nothing
   * saying why — by then with no identity anyone could sign in as, no access
   * record, and nothing external left to reach.
   */
  private async eraseAccount(
    tombstone: AccountDeletionTombstoneV1,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(ACCOUNT_DELETED_KEY_V1, tombstone);
    });
    this.mounted = undefined;
    this.identity = undefined;
    this.bootstrapped = false;
    this.#memoryEngine = undefined;
  }

  private accountDeletionSeams(userId: string): AccountDeletionUserSeamsV1 {
    const sql = durableObjectHasSqlV1(this.ctx.storage);
    return {
      deleteGroupChats: async (cursor) => {
        const store = this.groupChats();
        // The groups are named in the saga's cursor before any is deleted:
        // a delete commits here before its group's own object is destroyed,
        // and a retry that re-listed would no longer see the group whose
        // object it still owes a destroy. Replaying the same command carries
        // that destroy again.
        if (cursor === undefined) {
          const groupIds = (await store.list()).groups.map(
            (group) => group.groupId,
          );
          return groupIds.length === 0
            ? { status: "complete" }
            : { status: "pending", cursor: groupIds.join(",") };
        }
        for (const groupId of cursor.split(",")) {
          let result;
          try {
            result = await store.execute(
              userId,
              {
                type: "group/delete",
                commandId: `account-deletion-${groupId}`,
                groupId,
              },
              { kind: "user" },
            );
          } catch (error) {
            // Deleted meanwhile by a command of its own, which carried it.
            if (error instanceof GroupChatNotFoundError) continue;
            throw error;
          }
          if (result.change) await this.carryGroupChange(userId, result.change);
        }
        return { status: "complete" };
      },
      deleteBots: async () => {
        const flock = await this.flockContribution();
        // A lifecycle saga already retrying — an archive, a delete the person
        // started — settles first; this Bot's delete joins on the next pass.
        await flock.alarm();
        for (const bot of (await flock.listBots()).bots) {
          try {
            await flock.executeLifecycle(userId, {
              schemaVersion: 1,
              type: "bot/delete",
              commandId: `account-deletion-${(await sha256HexV1(bot.botId)).slice(0, 32)}`,
              botId: bot.botId,
            });
          } catch {
            // Another operation holds the Bot, or it left meanwhile. Either
            // way the directory decides, on the next pass.
          }
        }
        return (await flock.listBots()).bots.length === 0
          ? { status: "complete" }
          : { status: "pending" };
      },
      recordedPaymentCustomer: () =>
        sql ? this.billing().get<string>("customer") : undefined,
      vectorIdsAfter: (cursor, limit) =>
        sql ? this.memoryEngine().vectorIdsAfter(cursor, limit) : [],
      deleteIdentity: async () => {
        const { AUTH_PACKAGE_V1 } = await import("#auth-package");
        await AUTH_PACKAGE_V1.create(this.env).deleteStoredIdentity?.(userId);
      },
      eraseVoice: async () => {
        const { getAgentByName } = await import("agents");
        const voice = await getAgentByName(
          this.env.VOICE_ASSISTANTS as DurableObjectNamespace<VoiceAssistant>,
          userId,
        );
        await voice.eraseAccount({ schemaVersion: 1, userId });
      },
      revokeMcpGrants: async (giveUp) =>
        (await this.contributions()).mcp.revokeGrantsForDeletion({
          userId,
          giveUp,
        }),
    };
  }

  // --- Account features ------------------------------------------------------
  //
  // What an administrator turned on for this User. Neither RPC pins the
  // identity: an admin reads and sets features for accounts that have signed
  // up but never been admitted, and doing so must not provision them.

  async readFeatures(input: unknown): Promise<UserFeaturesV1> {
    const request = decodeUserFeaturesReadRequestV1(input);
    await this.addressedUser(request.userId);
    const stored = await this.ctx.storage.get<unknown>(USER_FEATURES_KEY);
    return stored === undefined
      ? defaultUserFeaturesV1()
      : decodeUserFeaturesV1(stored);
  }

  async setFeatures(input: unknown): Promise<UserFeaturesV1> {
    const request = decodeSetUserFeaturesRequestV1(input);
    await this.addressedUser(request.userId);
    const current = decodeUserFeaturesV1(
      (await this.ctx.storage.get<unknown>(USER_FEATURES_KEY)) ??
        defaultUserFeaturesV1(),
    );
    const next: UserFeaturesV1 = {
      schemaVersion: 1,
      pluginAuthoring:
        request.command.pluginAuthoring ?? current.pluginAuthoring,
      plugins: request.command.plugins ?? current.plugins,
      updatedAt: new Date().toISOString(),
      updatedBy: request.updatedBy,
    };
    await this.ctx.storage.put(USER_FEATURES_KEY, next);
    return next;
  }

  async readConfiguration(input: unknown): Promise<UserSettingsViewV1> {
    const request = decodeUserConfigurationReadRpcV1(input);
    await this.assertUserIdentity(request.userId);
    const settings = await (
      await this.settingsContribution()
    ).readConfiguration(request);
    if (request.view === 2) return settings;
    return (await this.settingsContribution()).previousSettingsView(settings);
  }

  async readConnectionsFrame(input: unknown) {
    const count = (minimum: number) =>
      rpcInteger({ minimum, maximum: CONNECTIONS_FRAME_PROVIDERS_MAX_V1 });
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier },
      {
        catalog: rpcObject({
          query: rpcText(CONNECTIONS_CATALOG_QUERY_MAX_V1),
          kinds: rpcArray(rpcEnum(["model", "connector"]), 2),
          installed: rpcBoolean,
          cursor: count(0),
          limit: count(1),
        }),
      },
    );
    await this.assertUserIdentity(request.userId as string);
    return (await this.settingsContribution()).readConnectionsFrame(
      request.userId as string,
      request.catalog as ConnectionsCatalogQueryV1 | undefined,
      // A provider served by a Plugin is not an offer on a deployment with no
      // worker loader to mount it: adding it would choose a model no Turn can
      // run.
      this.env.BOT_PACKAGES ? [] : marketplacePluginPackageIdsV1(),
    );
  }

  // The User's Composition (ADR 0026): the installed Plugin set, its
  // generations, last known good and quarantine. A Bot mirrors the pin
  // before every admission and records activation outcomes here.

  async readComposition(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    const userId = await this.assertUserIdentity(request.userId as string);
    const features = decodeUserFeaturesV1(
      (await this.ctx.storage.get<unknown>(USER_FEATURES_KEY)) ??
        defaultUserFeaturesV1(),
    );
    const settings = await (await this.settingsContribution()).read(userId);
    return readUserCompositionV1(
      { ctx: this.ctx },
      {
        userId,
        // A deployment with no Worker Loader cannot mount a Plugin at all, so
        // it seeds none: a member nothing can mount would fail every Turn of
        // every Bot on the account rather than the one Plugin.
        catalog: this.env.BOT_PACKAGES
          ? DEPLOYMENT_PLUGIN_CATALOG_V1
          : ([] as typeof DEPLOYMENT_PLUGIN_CATALOG_V1),
        adminOpened: features.plugins,
        installedPackageIds: settings.packages
          .filter((pkg) => pkg.state === "installed")
          .map((pkg) => pkg.packageId),
      },
    );
  }

  /**
   * Configuration, features and Composition in one call. Secrets and
   * credential leases stay on their own RPCs. Composition reconciliation can
   * fail without dropping the settings the Turn still needs.
   */
  async prepareAccount(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    const userId = await this.assertUserIdentity(request.userId as string);
    // Every Turn of every Bot prepares here first, so this is where a
    // deleting account stops starting Turns.
    await this.assertAccountOpen();
    const features = decodeUserFeaturesV1(
      (await this.ctx.storage.get<unknown>(USER_FEATURES_KEY)) ??
        defaultUserFeaturesV1(),
    );
    const settings = await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId });
    let composition:
      Awaited<ReturnType<typeof readUserCompositionV1>> | undefined;
    try {
      composition = await readUserCompositionV1(
        { ctx: this.ctx },
        {
          userId,
          catalog: this.env.BOT_PACKAGES
            ? DEPLOYMENT_PLUGIN_CATALOG_V1
            : ([] as typeof DEPLOYMENT_PLUGIN_CATALOG_V1),
          adminOpened: features.plugins,
          installedPackageIds: settings.packages
            .filter((pkg) => pkg.state === "installed")
            .map((pkg) => pkg.packageId),
        },
      );
    } catch {
      composition = undefined;
    }
    const skillIndex = await readDurableSkillIndexV1(this.skillIndexStorage(), {
      kind: "user-instructions",
      userId,
    });
    return {
      schemaVersion: 1 as const,
      features,
      settings,
      skillIndexRevision: skillIndex.deleted ? "" : skillIndex.revision,
      ...(composition ? { composition } : {}),
    };
  }

  /** Revision stamps only. Does not reconcile Composition or bootstrap packages. */
  async readAccountPreparationStamp(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    const features = decodeUserFeaturesV1(
      (await this.ctx.storage.get<unknown>(USER_FEATURES_KEY)) ??
        defaultUserFeaturesV1(),
    );
    const settings = await (await this.settingsContribution()).readSnapshot();
    const pin = await this.ctx.storage.get<unknown>(COMPOSITION_CURRENT_KEY);
    return {
      schemaVersion: 1 as const,
      revision: settings.revision,
      features: {
        pluginAuthoring: features.pluginAuthoring,
        plugins: [...features.plugins],
      },
      compositionGenerationId:
        pin === undefined ? "" : decodeCompositionPinV1(pin).generationId,
      skillIndexRevision: await this.userSkillIndexRevision(
        request.userId as string,
      ),
    };
  }

  async readCompositionGeneration(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      generationId: rpcString(256),
    });
    await this.assertUserIdentity(request.userId as string);
    return userCompositionStoreV1({ ctx: this.ctx }).read(
      request.generationId as string,
    );
  }

  async proposeComposition(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        generation: rpcDecoded(decodeCompositionGenerationV1),
      },
      {
        pin: rpcBoolean,
        expectedCurrentGenerationId: rpcString(256),
      },
    );
    await this.assertUserIdentity(request.userId as string);
    await userCompositionStoreV1({ ctx: this.ctx }).propose(
      request.generation as ReturnType<typeof decodeCompositionGenerationV1>,
      {
        ...(request.pin === undefined ? {} : { pin: request.pin as boolean }),
        ...(request.expectedCurrentGenerationId === undefined
          ? {}
          : {
              expectedCurrentGenerationId:
                request.expectedCurrentGenerationId as string,
            }),
      },
    );
  }

  async commitComposition(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      generationId: rpcString(256),
    });
    await this.assertUserIdentity(request.userId as string);
    await this.changingActiveGeneration(() =>
      userCompositionStoreV1({ ctx: this.ctx }).commit(
        request.generationId as string,
      ),
    );
  }

  async failComposition(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      generationId: rpcString(256),
      quarantined: rpcBoolean,
    });
    await this.assertUserIdentity(request.userId as string);
    await this.changingActiveGeneration(() =>
      userCompositionStoreV1({ ctx: this.ctx }).fail(
        request.generationId as string,
        { quarantined: request.quarantined as boolean },
      ),
    );
  }

  /**
   * The generation the account runs: the last one a Turn mounted and
   * committed. The pointer can name a pending proposal no Turn has mounted
   * yet, and a desktop should not start code that may never activate.
   */
  private activeGeneration() {
    return userCompositionStoreV1({ ctx: this.ctx }).lastKnownGood();
  }

  /**
   * Runs a commit or a failure, and sends every open machine socket the new
   * module list when the active generation moved. A commit of the generation
   * already active, which every Turn after the first makes, sends nothing.
   * The sockets are told best-effort: the change itself is what the caller
   * asked for, and a desktop that missed it is sent the list on reconnect.
   */
  private async changingActiveGeneration(change: () => Promise<void>) {
    const store = userCompositionStoreV1({ ctx: this.ctx });
    // Only the pointer is compared, so the commit every Turn makes decodes
    // nothing it did not already.
    const before = await store.lastKnownGoodId();
    await change();
    if ((await store.lastKnownGoodId()) === before) return;
    await this.pushMachineModules();
  }

  /**
   * Sends every open machine socket its module list again: the active
   * generation moved, a Routine started or stopped listening, or an event
   * moved a last key. Best-effort: a desktop that missed it is sent the list
   * on reconnect.
   */
  private async pushMachineModules(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    await loggedEntryV1("Machine modules push", async () => {
      const active = await this.activeGeneration();
      const routing = await readModuleRoutingV1(
        this.ctx.storage,
        await this.pluginTriggerRoutines(),
      );
      const serverTime = new Date().toISOString();
      broadcastMachineFrameV1(this.ctx, (platform) => ({
        type: "modules",
        modules: machineModulesV1(active, platform, routing),
        serverTime,
      }));
    });
  }

  /**
   * Every Routine, on any of the User's Bots, whose trigger names a Plugin's
   * trigger. Routines written before this index existed never registered, so
   * the first read asks each Bot once; after that each Routine keeps it
   * current itself.
   */
  private async pluginTriggerRoutines(): Promise<
    PluginTriggerRoutineEntryV1[]
  > {
    if (!(await pluginTriggerIndexBuiltV1(this.ctx.storage))) {
      const userId = await this.provenIdentity();
      if (userId === undefined) return [];
      const directory = await (await this.flockContribution()).listBots();
      const bots = await Promise.all(
        directory.bots.map(async (bot) => {
          try {
            return {
              botId: bot.botId,
              routines: await this.botRoutinesStub(
                userId,
                bot.botId,
              ).listPluginTriggerRoutines({
                schemaVersion: 1,
                userId,
                botId: bot.botId,
              }),
            };
          } catch (error) {
            // One Bot that cannot answer must not hold every other Bot's
            // Routines out of the index; its own next change registers it.
            console.error(
              `Plugin trigger index rebuild failed for a Bot: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return { botId: bot.botId, routines: [] };
          }
        }),
      );
      await rebuildPluginTriggerIndexV1(this.ctx.storage, bots);
    }
    return readPluginTriggerRoutinesV1(this.ctx.storage);
  }

  /**
   * One Routine saying whether it listens to a Plugin's trigger, each time it
   * is created, changed, paused, resumed or deleted.
   */
  async syncPluginTriggerRoutine(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
        routineId: rpcIdentifier,
      },
      {
        listening: rpcObject({
          pluginId: rpcPattern(/^[a-z][a-z0-9-]{0,63}$/, 64),
          trigger: rpcPattern(/^[a-z][a-z0-9_-]{0,63}$/, 64),
        }),
      },
    );
    await this.assertUserIdentity(request.userId as string);
    // An unbuilt index is rebuilt from every Bot on its first read, this
    // Routine included; nothing listens to it before then.
    const built = await pluginTriggerIndexBuiltV1(this.ctx.storage);
    const before = listeningEventsV1(
      await readPluginTriggerRoutinesV1(this.ctx.storage),
    );
    await syncPluginTriggerRoutineV1(this.ctx.storage, {
      botId: request.botId as string,
      routineId: request.routineId as string,
      ...(request.listening === undefined
        ? {}
        : {
            listening: request.listening as {
              pluginId: string;
              trigger: string;
            },
          }),
    });
    if (!built) return;
    const after = listeningEventsV1(
      await readPluginTriggerRoutinesV1(this.ctx.storage),
    );
    if (
      before.size !== after.size ||
      [...after].some((event) => !before.has(event))
    ) {
      await this.pushMachineModules();
    }
  }

  async revertComposition(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      toGenerationId: rpcString(256),
      origin: rpcJsonRecord,
    });
    await this.assertUserIdentity(request.userId as string);
    const origin = request.origin as Record<string, unknown>;
    if (
      origin.kind !== "revert" ||
      origin.revertsTo !== request.toGenerationId ||
      origin.userId !== request.userId
    ) {
      throw new Error("Composition revert origin does not match its request");
    }
    return userCompositionStoreV1({ ctx: this.ctx }).revert(
      request.toGenerationId as string,
      origin as Extract<CompositionOriginV1, { kind: "revert" }>,
    );
  }

  async listCompositionGenerations(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        limit: rpcInteger({ minimum: 1, maximum: 100 }),
      },
      { cursor: rpcString(512) },
    );
    await this.assertUserIdentity(request.userId as string);
    return userCompositionStoreV1({ ctx: this.ctx }).list({
      limit: request.limit as number,
      ...(request.cursor === undefined
        ? {}
        : { cursor: request.cursor as string }),
    });
  }

  async recordCompositionFailure(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      failure: rpcJsonRecord,
    });
    await this.assertUserIdentity(request.userId as string);
    return userCompositionFailuresV1({ ctx: this.ctx }).record(
      request.failure as unknown as CompositionFailureInputV1,
    );
  }

  async listCompositionFailures(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      generationId: rpcString(256),
    });
    await this.assertUserIdentity(request.userId as string);
    return userCompositionFailuresV1({ ctx: this.ctx }).list(
      request.generationId as string,
    );
  }

  async readCompositionQuarantine(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      generationId: rpcString(256),
    });
    await this.assertUserIdentity(request.userId as string);
    return userCompositionFailuresV1({ ctx: this.ctx }).quarantine(
      request.generationId as string,
    );
  }

  async clearCompositionFailures(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      generationId: rpcString(256),
    });
    await this.assertUserIdentity(request.userId as string);
    await userCompositionFailuresV1({ ctx: this.ctx }).clear(
      request.generationId as string,
    );
  }

  async readSettingsFrame(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        home: rpcEnum(["application", "models"]),
      },
      {
        identityName: rpcString(100),
        identityEmail: rpcString(320),
        identityImage: rpcString(2048),
      },
    );
    await this.assertUserIdentity(request.userId as string);
    return (await this.settingsContribution()).readSettingsFrame(
      request.userId as string,
      request.home as "application" | "models",
      {
        ...(request.identityName
          ? { name: request.identityName as string }
          : {}),
        ...(request.identityEmail
          ? { email: request.identityEmail as string }
          : {}),
        ...(request.identityImage
          ? { image: request.identityImage as string }
          : {}),
      },
    );
  }

  async readSettingsOptions(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      query: rpcDecoded((value) =>
        decodeProtocol("SettingsOptionsQuery", value),
      ),
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.settingsContribution()).readSettingsOptions(
      request.userId as string,
      request.query,
    );
  }

  async changeSettings(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      home: rpcEnum(["application", "models"]),
      command: rpcDecoded((value) =>
        decodeProtocol("SettingsChangeCommand", value),
      ),
    });
    await this.assertUserIdentity(request.userId as string);
    const command = request.command as { sectionId?: string };
    const profileSave =
      request.home === "application" && command.sectionId === "profile";
    const before = profileSave
      ? await this.routineTimezone(request.userId as string)
      : undefined;
    const receipt = await (
      await this.settingsContribution()
    ).changeSettings(
      request.userId as string,
      request.home as "application" | "models",
      request.command,
    );
    if (receipt.status === "applied" && before !== undefined) {
      await this.propagateRoutineTimezone(request.userId as string, before);
    }
    return receipt;
  }

  async executeConfiguration(input: unknown) {
    const request = decodeUserConfigurationExecuteRpcV1(input);
    await this.assertUserIdentity(request.userId);
    const before =
      request.command.type === "user/update-profile"
        ? await this.routineTimezone(request.userId)
        : undefined;
    const receipt = await (
      await this.settingsContribution()
    ).executeConfiguration(request);
    if (receipt.status === "applied" && before !== undefined) {
      await this.propagateRoutineTimezone(request.userId, before);
    }
    if (
      receipt.status === "applied" &&
      (request.command.type === "user/install-package" ||
        request.command.type === "user/choose-model-provider" ||
        request.command.type === "user/uninstall-package" ||
        request.command.type === "user/set-package-enabled")
    ) {
      // A Package an account installs or uninstalls can be one this
      // deployment serves through a Plugin (ADR 0032): the artifact follows
      // the Package into this User's Composition, by the account's own
      // command and by no default. The Marketplace's Add is
      // `choose-model-provider`, so it is one of these too. A failed reconciliation is not a failed
      // command — the settings write already landed — so it is swallowed
      // here and repaired by the next install, uninstall or read.
      await this.reconcileInstalledPlugins(request.userId).catch(
        () => undefined,
      );
    }
    return receipt;
  }

  /**
   * The provider Plugins this account's installed Packages carry, reconciled
   * into its Composition. Idempotent: a generation is proposed only when the
   * set of `installed` members differs from what the Packages say.
   */
  private async reconcileInstalledPlugins(userId: string): Promise<void> {
    const settings = await (await this.settingsContribution()).read(userId);
    await reconcileInstalledProviderPluginsV1({
      store: userCompositionStoreV1({ ctx: this.ctx }),
      userId,
      // A deployment with no Worker Loader mounts no Plugin, so it installs
      // none: a member nothing can mount would fail every Turn of every Bot.
      catalog: this.env.BOT_PACKAGES ? DEPLOYMENT_PLUGIN_CATALOG_V1 : [],
      installedPackageIds: settings.packages
        .filter((pkg) => pkg.state === "installed")
        .map((pkg) => pkg.packageId),
    });
  }

  async executeConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeConnectionCommandV1),
    });
    const command = request.command as ReturnType<
      typeof decodeConnectionCommandV1
    >;
    const accountId = request.userId as string;
    await this.assertAccountOpen();
    const packageId = await (
      await this.settingsContribution()
    ).resolveConnectionCommandOwner(accountId, command);
    return (await this.connectionContribution(packageId)).executeConnection(
      accountId,
      command,
    );
  }

  async listConnectTriggers(input: unknown): Promise<ConnectTriggerOfferV1[]> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    const userId = await this.assertUserIdentity(request.userId as string);
    return (await this.connectContribution()).listTriggers(userId);
  }

  async upsertConnectTrigger(
    input: unknown,
  ): Promise<{ instanceId: string; routineId: string }> {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        commandId: rpcIdentifier,
        botId: rpcBotId,
        routineId: rpcIdentifier,
        connectionId: rpcIdentifier,
        triggerType: rpcString(128),
      },
      {
        config: rpcJsonRecord,
      },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    await this.assertAccountOpen();
    return (await this.connectContribution()).upsertTrigger({
      userId,
      commandId: request.commandId as string,
      botId: request.botId as string,
      routineId: request.routineId as string,
      connectionId: request.connectionId as string,
      triggerType: request.triggerType as string,
      ...(request.config === undefined
        ? {}
        : {
            config: request.config as Record<string, string | number | boolean>,
          }),
    });
  }

  async deleteConnectTrigger(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      commandId: rpcIdentifier,
      botId: rpcBotId,
      routineId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    await (
      await this.connectContribution()
    ).deleteTrigger({
      commandId: request.commandId as string,
      botId: request.botId as string,
      routineId: request.routineId as string,
    });
  }

  /**
   * One verified provider event. The door already checked the HMAC; this
   * object maps the instance and either fires or pauses the Routine.
   *
   * It does not provision the User: an event for nobody is ignored, not a
   * reason to create an account.
   */
  async handleConnectEvent(input: unknown): Promise<{
    status: "accepted" | "ignored";
    fireId?: string;
  }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      event: rpcDecodedValue,
    });
    const userId = request.userId as string;
    if (await this.accountClosing()) return { status: "ignored" };
    const pinned = await this.addressedUser(userId);
    if (!pinned) return { status: "ignored" };
    const event = request.event as ConnectEventV1;
    if (event.userId !== userId) return { status: "ignored" };
    const connect = await this.connectContribution();
    if (event.kind === "connected_account.expired") {
      if (!event.connectedAccountId) return { status: "ignored" };
      const failed = await connect.failExpiredAccount(
        userId,
        event.connectedAccountId,
      );
      if (!failed) return { status: "ignored" };
      for (const routine of failed.routines) {
        await this.pauseConnectRoutine(
          userId,
          routine.botId,
          routine.routineId,
          `connect-expired-${event.eventId}-${routine.routineId}`,
        );
      }
      return { status: "accepted" };
    }
    if (!event.triggerInstanceId) return { status: "ignored" };
    const instance = await connect.resolveTrigger(event.triggerInstanceId);
    if (!instance) return { status: "ignored" };
    if (event.kind === "trigger.disabled") {
      await this.pauseConnectRoutine(
        userId,
        instance.botId,
        instance.routineId,
        `connect-disabled-${event.eventId}`,
      );
      return { status: "accepted" };
    }
    const receipt = (await this.botRoutinesStub(
      userId,
      instance.botId,
    ).deliverConnectEvent({
      schemaVersion: 1,
      userId,
      botId: instance.botId,
      routineId: instance.routineId,
      eventId: event.eventId,
      payload: event.payload,
    })) as { status?: string; fireId?: string };
    return receipt.status === "accepted" || receipt.status === "duplicate"
      ? {
          status: "accepted",
          ...(receipt.fireId ? { fireId: receipt.fireId } : {}),
        }
      : { status: "ignored" };
  }

  private async pauseConnectRoutine(
    userId: string,
    botId: string,
    routineId: string,
    commandId: string,
  ): Promise<void> {
    await this.botRoutinesStub(userId, botId)
      .executeRoutineCommand({
        schemaVersion: 1,
        userId,
        botId,
        command: decodeRoutineCommandV1({
          schemaVersion: 1,
          type: "routine/pause",
          commandId,
          botId,
          routineId,
        }),
      })
      .catch(() => undefined);
  }

  async lookupConnectionCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      packageId: rpcIdentifier,
      commandId: rpcIdentifier,
    });
    return (
      await this.connectionContribution(request.packageId as string)
    ).lookupConnectionCommand(
      request.userId as string,
      decodeConnectionCommandIdV1(request.commandId),
    );
  }

  async getConnection(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
    });
    return (await this.settingsContribution()).getConnection(
      request.userId as string,
      request.connectionId as string,
    );
  }

  async leaseModelCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      providerModelId: rpcString(256),
      effectId: rpcIdentifier,
      connectionGeneration: rpcIdentifier,
    });
    const connection = await (
      await this.settingsContribution()
    ).getConnection(request.userId as string, request.connectionId as string);
    if (!connection) throw new Error("Connection is unavailable");
    return (
      await this.connectionContribution(connection.packageId)
    ).leaseModelCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      providerModelId: request.providerModelId as string,
      effectId: request.effectId as string,
      connectionGeneration: request.connectionGeneration as string,
    });
  }

  /**
   * An expiring lease over a Connection's credential for a tool
   * Contribution's mount. The Package that owns the Connection is resolved
   * from the durable projection, so a caller cannot name a Package the
   * Connection does not belong to, and a Package whose Connections carry no
   * credential refuses by not implementing the seam at all.
   */
  async leaseToolCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      effectId: rpcIdentifier,
      connectionGeneration: rpcIdentifier,
    });
    const connection = await (
      await this.settingsContribution()
    ).getConnection(request.userId as string, request.connectionId as string);
    if (!connection) throw new Error("Connection is unavailable");
    const contribution = await this.connectionContribution(
      connection.packageId,
    );
    if (!contribution.leaseToolCredential) {
      throw new Error("Connection Package offers no tool credential");
    }
    return contribution.leaseToolCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      effectId: request.effectId as string,
      connectionGeneration: request.connectionGeneration as string,
    });
  }

  async settleToolCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      effectId: rpcIdentifier,
    });
    const connection = await (
      await this.settingsContribution()
    ).getConnection(request.userId as string, request.connectionId as string);
    if (!connection) return;
    const contribution = await this.connectionContribution(
      connection.packageId,
    );
    await contribution.settleToolCredential?.({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      effectId: request.effectId as string,
    });
  }

  private async secretVault(): Promise<SecretVaultV1> {
    return createSecretVaultV1({
      storage: this.ctx.storage,
      credentials: (await this.contributions()).credentials,
    });
  }

  /**
   * Seals one value a person typed on a Bot's secret-request card.
   *
   * The Bot Durable Object is the caller, having checked the request it
   * recorded; this object is the one that holds the value, sealed, and
   * answers only what the secret is called and where it may be used. A
   * refusal names the field, never what was in it.
   */
  async storeSecret(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
        requestId: rpcPattern(/^secret-request-[0-9a-f]{32}$/, 128),
        label: rpcString(SECRET_LIMITS_V1.label),
        payment: rpcBoolean,
        value: rpcString(SECRET_LIMITS_V1.value),
      },
      {
        origin: (value, label) => secretOriginV1(value, label),
      },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    await this.assertAccountOpen();
    if (!isSecretRequestIdV1(request.requestId)) {
      throw new Error("RPC request.requestId is invalid");
    }
    const { status: _, ...secret } = await (
      await this.secretVault()
    ).store({
      accountId: userId,
      botId: request.botId as string,
      requestId: request.requestId,
      label: request.label as string,
      ...(request.origin === undefined
        ? {}
        : { origin: request.origin as string }),
      payment: request.payment as boolean,
      value: request.value as string,
    });
    return secret;
  }

  /** What a saved secret is called and where it may be filled; never its value. */
  async describeSecret(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      secretId: rpcPattern(/^secret-[0-9a-f]{32}$/, 64),
    });
    await this.assertUserIdentity(request.userId as string);
    const secret = isSecretIdV1(request.secretId)
      ? await (await this.secretVault()).describe(request.secretId)
      : undefined;
    return { schemaVersion: 1 as const, secret: secret ?? null };
  }

  /** An expiring lease over one secret's sealed value, for one fill. */
  async leaseSecret(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      secretId: rpcPattern(/^secret-[0-9a-f]{32}$/, 64),
      effectId: rpcString(256),
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    await this.assertAccountOpen();
    return (await this.secretVault()).lease({
      accountId: userId,
      secretId: request.secretId as string,
      effectId: request.effectId as string,
    });
  }

  async settleSecret(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      secretId: rpcPattern(/^secret-[0-9a-f]{32}$/, 64),
      effectId: rpcString(256),
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    await (
      await this.secretVault()
    ).settle({
      accountId: userId,
      secretId: request.secretId as string,
      effectId: request.effectId as string,
    });
  }

  /** The User's saved secrets, for Settings. */
  async listSecrets(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return (await this.secretVault()).list();
  }

  async deleteSecret(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      secretId: rpcPattern(/^secret-[0-9a-f]{32}$/, 64),
    });
    await this.assertUserIdentity(request.userId as string);
    return {
      schemaVersion: 1 as const,
      ...(await (await this.secretVault()).remove(request.secretId as string)),
    };
  }

  async settleModelCredential(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      connectionId: rpcIdentifier,
      packageId: rpcIdentifier,
      effectId: rpcIdentifier,
    });
    await (await this.settingsContribution()).read(request.userId as string);
    const contribution = (await this.contributions()).connections.get(
      request.packageId as string,
    );
    if (!contribution) {
      throw new Error("Connection Package Contribution is unavailable");
    }
    await contribution.settleModelCredential({
      accountId: request.userId as string,
      connectionId: request.connectionId as string,
      effectId: request.effectId as string,
    });
  }

  /**
   * The per-User concurrent-subagent bound.
   *
   * A Bot's own bound is countable in its Durable Object; a User's is not,
   * because a User's Bots are separate objects. So the slot is held here, and
   * the Bot's Durable Object reserves one before it dispatches and releases it
   * when the task settles. Both halves are idempotent on `(botId, taskId)`.
   */
  async reserveSubagentSlot(input: unknown): Promise<SubagentSlotReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
      reservedAt: rpcString(64),
    });
    return reserveSubagentSlotV1(this.ctx.storage, {
      schemaVersion: 1,
      userId: request.userId as string,
      botId: request.botId as string,
      taskId: request.taskId as string,
      reservedAt: request.reservedAt as string,
    });
  }

  async releaseSubagentSlot(
    input: unknown,
  ): Promise<{ schemaVersion: 1; status: "released"; held: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      taskId: rpcString(128),
    });
    return releaseSubagentSlotV1(this.ctx.storage, {
      botId: request.botId as string,
      taskId: request.taskId as string,
    });
  }

  /** User-wide agent-lane budget shared by every Bot. */
  async reserveAgentTurnSlot(input: unknown): Promise<AgentTurnSlotReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      requesterId: rpcString(256),
      runId: rpcString(256),
      reservedAt: rpcString(64),
    });
    await this.assertUserIdentity(request.userId as string);
    return reserveAgentTurnSlotV1(this.ctx.storage, {
      schemaVersion: 1,
      userId: request.userId as string,
      requesterId: request.requesterId as string,
      runId: request.runId as string,
      reservedAt: request.reservedAt as string,
    });
  }

  async releaseAgentTurnSlot(
    input: unknown,
  ): Promise<{ schemaVersion: 1; status: "released"; held: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      requesterId: rpcString(256),
      runId: rpcString(256),
    });
    await this.assertUserIdentity(request.userId as string);
    return releaseAgentTurnSlotV1(this.ctx.storage, {
      requesterId: request.requesterId as string,
      runId: request.runId as string,
    });
  }

  // ---------------------------------------------------------------------
  // Shared Memory roots.
  //
  // The User's Durable Object is the authority for everything User-scoped,
  // the User Memory root's generation records among it. The Bot's Durable
  // Object does the writing — it is the Memory Package's host — but a shared
  // root's generations are recorded here, so two Bots writing one root record
  // into one ledger and their ids order against each other.
  //
  // Every one of these refuses a root that is not a shared Memory root of
  // *this* User. The Bot object is a caller like any other; authority follows
  // the root, not the caller.
  // ---------------------------------------------------------------------

  private readonly workspaceGenerations = new DurableWorkspaceGenerations({
    state: this.ctx,
  });

  /** `userId` must already have passed `assertUserIdentity`. */
  private sharedMemoryRoot(userId: string, value: unknown): WorkspaceRootV1 {
    const root = decodeWorkspaceRootV1(value);
    if (!isWorkspaceSharedMemoryRootV1(root) || root.userId !== userId) {
      throw new Error(
        "the User Durable Object records generations for its own shared Memory roots only",
      );
    }
    return root;
  }

  private sharedMemoryRecord(
    userId: string,
    value: unknown,
  ): WorkspaceGenerationRecordV1 {
    const entry = decodeWorkspaceGenerationRecordV1(value);
    this.sharedMemoryRoot(userId, entry.root);
    return entry;
  }

  async mintWorkspaceGeneration(input: unknown): Promise<string> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      at: rpcString(64),
      root: rpcDecodedValue,
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    this.sharedMemoryRoot(userId, request.root);
    const at = new Date(request.at as string);
    if (!Number.isFinite(at.getTime())) {
      throw new Error("RPC request.at is invalid");
    }
    return this.workspaceGenerations.mint(at);
  }

  async currentWorkspaceGeneration(
    input: unknown,
  ): Promise<WorkspaceGenerationRecordV1 | undefined> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      root: rpcDecodedValue,
      path: rpcString(1_024),
    });
    const root = this.sharedMemoryRoot(
      await this.assertUserIdentity(request.userId as string),
      request.root,
    );
    return this.workspaceGenerations.current(
      root,
      normalizeWorkspaceRelativePathV1(request.path),
    );
  }

  async recordWorkspaceGeneration(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      entry: rpcDecodedValue,
    });
    await this.workspaceGenerations.record(
      this.sharedMemoryRecord(
        await this.assertUserIdentity(request.userId as string),
        request.entry,
      ),
    );
  }

  async tombstoneWorkspaceGeneration(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      entry: rpcDecodedValue,
    });
    await this.workspaceGenerations.tombstone(
      this.sharedMemoryRecord(
        await this.assertUserIdentity(request.userId as string),
        request.entry,
      ),
    );
  }

  async conflictWorkspaceGeneration(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      entry: rpcDecodedValue,
    });
    await this.workspaceGenerations.conflict(
      this.sharedMemoryRecord(
        await this.assertUserIdentity(request.userId as string),
        request.entry,
      ),
    );
  }

  async listWorkspaceConflicts(
    input: unknown,
  ): Promise<WorkspaceGenerationRecordV1[]> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      root: rpcDecodedValue,
      path: rpcString(1_024),
    });
    const root = this.sharedMemoryRoot(
      await this.assertUserIdentity(request.userId as string),
      request.root,
    );
    return this.workspaceGenerations.conflicts(
      root,
      normalizeWorkspaceRelativePathV1(request.path),
    );
  }

  private skillIndexStorage() {
    const storage = this.ctx.storage;
    return {
      get: (key: string) => storage.get(key),
      put: (key: string, value: unknown) => storage.put(key, value),
      delete: (key: string) => storage.delete(key),
      list: (options: { prefix?: string; limit?: number; start?: string }) =>
        storage.list(options),
    };
  }

  private skillBodies() {
    const bucket = this.env.MEMORY_FILES;
    if (!bucket) throw new Error("no Workspace bucket is bound");
    const objects = createR2ObjectBucketV1(bucket);
    return {
      put: async (key: string, bytes: Uint8Array) => {
        await objects.put(key, bytes);
      },
      get: async (key: string) => {
        const object = await objects.get(key);
        return object ? object.bytes() : undefined;
      },
      delete: (key: string) => objects.delete(key),
    };
  }

  private async userSkillIndexRevision(userId: string): Promise<string> {
    const index = await readDurableSkillIndexV1(this.skillIndexStorage(), {
      kind: "user-instructions",
      userId,
    });
    return index.deleted ? "" : index.revision;
  }

  private userInstructionRoot(userId: string, value: unknown) {
    const root = decodeWorkspaceRootV1(value);
    if (root.kind !== "user-instructions" || root.userId !== userId) {
      throw new Error("skill index root is not this User's instruction root");
    }
    return root;
  }

  async beginSkillIndex(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      root: rpcDecodedValue,
      path: rpcString(1_024),
      generationId: rpcString(128),
      ledgerPending: (value, label) => {
        if (typeof value !== "boolean") {
          throw new Error(`${label} must be a boolean`);
        }
        return value;
      },
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    const root = this.userInstructionRoot(userId, request.root);
    await beginDurableSkillPublicationV1(
      this.skillIndexStorage(),
      root,
      normalizeWorkspaceRelativePathV1(request.path as string),
      request.generationId as string,
      request.ledgerPending === true,
    );
  }

  async commitSkillIndex(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        root: rpcDecodedValue,
        path: rpcString(1_024),
        generation: rpcDecodedValue,
        deleted: (value, label) => {
          if (typeof value !== "boolean") {
            throw new Error(`${label} must be a boolean`);
          }
          return value;
        },
      },
      { bytesBase64: rpcString(200_000) },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    const root = this.userInstructionRoot(userId, request.root);
    const generation = decodeWorkspaceGenerationV1(request.generation);
    const bytes =
      typeof request.bytesBase64 === "string"
        ? base64ToBytes(request.bytesBase64)
        : undefined;
    const storage = this.skillIndexStorage();
    await commitDurableSkillPublicationV1(
      storage,
      this.skillBodies(),
      root,
      normalizeWorkspaceRelativePathV1(request.path as string),
      generation,
      bytes,
      request.deleted === true,
    );
    const held = await heldSkillRevisionsV1(storage);
    if (!held.truncated) {
      await releaseUnreferencedSkillSnapshotsV1(
        storage,
        this.skillBodies(),
        root,
        held.revisions,
      );
    }
  }

  async readSkillIndex(input: unknown): Promise<object> {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        root: rpcDecodedValue,
      },
      {
        revision: (value, label) => {
          if (typeof value !== "string" || value.length > 64) {
            throw new Error(`${label} is invalid`);
          }
          return value;
        },
      },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    const root = this.userInstructionRoot(userId, request.root);
    if (typeof request.revision === "string") {
      return readDurableSkillSnapshotV1(
        this.skillIndexStorage(),
        root,
        request.revision,
      );
    }
    return readDurableSkillIndexV1(this.skillIndexStorage(), root);
  }

  async readConnectToolCatalog(input: unknown): Promise<object> {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        connectionId: rpcIdentifier,
        generation: rpcString(128),
      },
      { toolName: rpcString(256) },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    // A connected app and an MCP server each keep their own directory; the
    // Package that owns the Connection is the one that answers for it.
    const connection = await (
      await this.settingsContribution()
    ).getConnection(userId, request.connectionId as string);
    const owner = connection
      ? (await this.contributions()).connections.get(connection.packageId)
      : undefined;
    if (!owner?.readToolCatalog) {
      return {
        kind: "stale-contract",
        message:
          "stale-contract: This connection was removed. Its tools are gone for this Turn.",
      };
    }
    return (await owner.readToolCatalog({
      userId,
      connectionId: request.connectionId as string,
      generation: request.generation as string,
      ...(typeof request.toolName === "string"
        ? { toolName: request.toolName }
        : {}),
    })) as object;
  }

  async holdSkillIndex(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      runId: rpcString(128),
      revision: (value, label) => {
        if (typeof value !== "string" || value.length > 64) {
          throw new Error(`${label} is invalid`);
        }
        return value;
      },
    });
    await this.assertUserIdentity(request.userId as string);
    await holdSkillIndexRevisionsV1(
      this.skillIndexStorage(),
      request.runId as string,
      { botRevision: "", userRevision: request.revision as string },
    );
  }

  async releaseSkillIndexHold(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      runId: rpcString(128),
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    const storage = this.skillIndexStorage();
    await releaseSkillIndexHoldV1(storage, request.runId as string);
    if (!this.env.MEMORY_FILES) return;
    const held = await heldSkillRevisionsV1(storage);
    if (held.truncated) return;
    await releaseUnreferencedSkillSnapshotsV1(
      storage,
      this.skillBodies(),
      { kind: "user-instructions", userId },
      held.revisions,
    );
  }

  /**
   * The User's sealed browser sign-ins and the debt an Update or a Reset
   * leaves. This object never holds the key: a Bot's object seals before it
   * calls and opens after it reads (`@frockbot/app/shell/computer-logins`).
   */
  async readComputerLogins(input: unknown): Promise<object> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      capture: rpcBoolean,
    });
    await this.assertUserIdentity(request.userId as string);
    return this.computerLogins().answer(request.capture as boolean);
  }

  async keepComputerLogins(input: unknown): Promise<object> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      kept: rpcDecodedValue,
    });
    await this.assertUserIdentity(request.userId as string);
    // A closing account keeps nothing new: its deletion wipes this object.
    await this.assertAccountOpen();
    return { outcome: await this.computerLogins().keep(request.kept) };
  }

  async oweComputerLogins(input: unknown): Promise<object> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      at: rpcString(64),
    });
    await this.assertUserIdentity(request.userId as string);
    await this.assertAccountOpen();
    return { outcome: await this.computerLogins().owe(request.at as string) };
  }

  async settleComputerLogins(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      owedSince: rpcString(64),
    });
    await this.assertUserIdentity(request.userId as string);
    await this.computerLogins().settle(request.owedSince as string);
  }

  private computerLogins(): ComputerLoginsLedgerV1 {
    return new ComputerLoginsLedgerV1(this.ctx.storage);
  }

  /** The Group Chats a Bot is in: the group Memory scopes it may use. */
  async listMemoryGroups(input: unknown): Promise<{ groupIds: string[] }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return {
      groupIds: await this.groupChats().groupsOf(request.botId as string),
    };
  }

  #memoryEngine: MemoryEngineV1 | undefined;

  private memoryEngine(): MemoryEngineV1 {
    this.#memoryEngine ??= createUserMemoryEngineV1(this.ctx.storage);
    return this.#memoryEngine;
  }

  private async drainMemoryProcessing(): Promise<void> {
    await drainDurableMemoryV1(this.memoryEngine(), {
      ...(this.env.MEMORY_INDEX ? { vectors: this.env.MEMORY_INDEX } : {}),
      ...(this.env.AI ? { ai: this.env.AI } : {}),
    });
  }

  /**
   * User and shared Group Chat Memory. Membership is loaded here and overwrites
   * anything the Bot RPC claimed, so a caller-supplied scope id is never enough.
   */
  async operateMemory(input: unknown): Promise<object> {
    const envelope = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      action: rpcEnum([
        "write",
        "forget",
        "recall",
        "expand",
        "browse",
        "preparedCore",
      ]),
      request: rpcDecodedValue,
    });
    const userId = envelope.userId as string;
    const botId = envelope.botId as string;
    await this.assertFlockIdentity(userId);
    const joined = await this.groupChats().groupsOf(botId);
    const inner = (envelope.request ?? {}) as Record<string, unknown>;
    const claimed = inner.authority;
    if (claimed && typeof claimed === "object" && !Array.isArray(claimed)) {
      inner.authority = {
        ...(claimed as Record<string, unknown>),
        userId,
        botId,
        actor:
          (claimed as { actor?: unknown }).actor === "user" ? "user" : "bot",
        joinedGroupChatIds: joined,
        membershipRevision: memoryMembershipRevisionV1(joined),
      };
    }
    const result = dispatchMemoryOperateV1(
      this.memoryEngine(),
      envelope.action as MemoryOperateActionV1,
      inner,
    );
    const due = this.memoryEngine().nextWakeupAt();
    if (due !== undefined) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > due) {
        await this.ctx.storage.setAlarm(due);
      }
    }
    return result as object;
  }

  /**
   * One durable alarm serves every User-scoped owner of one. Cloudflare gives
   * a Durable Object a single alarm, so credential lease expiry, Connection
   * recovery, and publication recovery all run on every firing rather than
   * one of them silently displacing the others' schedule.
   */
  async alarm() {
    // An alarm has no caller: a throw here is an uncaught exception in the
    // object, and the next firing is the recovery.
    await loggedEntryV1("User configuration alarm", () => this.#alarm());
  }

  async #alarm() {
    if (await this.accountClosing()) {
      // A deleting account's alarm is the deletion's alone: a credential
      // lease or a Memory drain run now would write to
      // what the saga is removing — a vector upserted behind the purge.
      await this.advanceAccountDeletion();
      return;
    }
    const contributions = await this.contributions();
    await contributions.credentials.expireLeases();
    for (const contribution of contributions.connections.values()) {
      await contribution.alarm?.();
    }
    // The Bot lifecycle sagas (archive and restore) resume on the same firing.
    await contributions.flock.alarm();
    // An archive that settled on a retry rather than on its command purges the
    // transcript index here. Purge is a delete of a projection, so sweeping
    // every archived Bot on every firing is idempotent and cheap, and it means
    // no archived Bot keeps rows because its saga finished out of band. Its
    // audit entries stay: an archived Bot's history is preserved.
    const lifecycles = await contributions.flock.listBotLifecycles();
    for (const lifecycle of lifecycles.lifecycles) {
      if (lifecycle.status === "archived") {
        contributions.search.purge(lifecycle.botId);
      }
    }
    // A delete that settled on a retry rather than on its own command left its
    // User-scoped projections behind, and the deleted Bot is no longer in any
    // lifecycle list to sweep from. The Flock Contribution keeps the to-do
    // list instead, and it is cleared only once the projections are gone.
    for (const botId of await contributions.flock.listDeletedBotIds()) {
      await this.forgetDeletedBot(botId);
    }
    if (durableObjectHasSqlV1(this.ctx.storage)) {
      await this.drainMemoryProcessing();
      const memoryDue = this.memoryEngine().nextWakeupAt();
      if (memoryDue !== undefined) {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > memoryDue) {
          await this.ctx.storage.setAlarm(memoryDue);
        }
      }
    }
  }

  /**
   * The User-scoped state one deleted Bot leaves behind: its transcript rows,
   * its audit entries and its Group Chat membership.
   *
   * Every step is a delete, so repeating it is free, and the to-do entry is
   * dropped last — a crash before that simply replays the sweep.
   */
  private async forgetDeletedBot(botId: string): Promise<void> {
    const contributions = await this.contributions();
    contributions.search.purge(botId);
    contributions.audit.purgeAuditForBot(botId);
    // Before the to-do entry goes, so a sweep interrupted here runs again.
    await this.inboundEmail().forgetBot(botId);
    await contributions.flock.forgetDeletedBot(botId);
    const userId = await this.provenIdentity();
    if (userId) {
      for (const change of await this.groupChats().forgetBot(botId)) {
        await this.carryGroupChange(userId, change);
      }
    }
  }

  /** Group Chat membership and the User's list of groups. */
  private groupChats(): GroupChatUserStoreV1 {
    return new GroupChatUserStoreV1(
      this.ctx.storage as unknown as GroupChatUserStorageV1,
      async () =>
        (await (await this.flockContribution()).listBots()).bots.map((bot) => {
          const description =
            bot.currentProfile?.description ?? bot.initialDescription;
          return {
            botId: bot.botId,
            name: bot.currentProfile?.name ?? bot.initialName,
            ...(description ? { description } : {}),
          };
        }),
    );
  }

  /** Tells a group's own object about a change committed here. */
  private async carryGroupChange(
    userId: string,
    change: GroupChatChangeV1,
  ): Promise<void> {
    if (change.kind === "delete" && durableObjectHasSqlV1(this.ctx.storage)) {
      // Deleting a group deletes what its members remembered in it.
      this.memoryEngine().purgeScope(
        memoryScopeKeyV1(groupChatScopeV1(userId, change.groupId)),
      );
    }
    const namespace = this.env.GROUP_CHATS;
    if (!namespace) return;
    const groupId =
      change.kind === "delete" ? change.groupId : change.context.group.groupId;
    // SAFETY: the binding names GroupChat; these are its reviewed RPC doors.
    const group = namespace.get(
      namespace.idFromName(groupChatObjectNameV1(userId, groupId)),
    ) as unknown as {
      recordEvent(input: unknown): Promise<unknown>;
      destroy(input: unknown): Promise<unknown>;
    };
    if (change.kind === "delete") {
      await group.destroy({ schemaVersion: 1, userId, groupId });
      return;
    }
    await group.recordEvent({
      schemaVersion: 1,
      userId,
      groupId,
      commandId: change.commandId,
      actor: change.actor,
      event: change.event,
      context: change.context,
      ...(change.initialize ? { initialize: true } : {}),
    });
  }

  async listGroupChats(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return answerGroupRpcV1(() => this.groupChats().list());
  }

  /**
   * A command about the User's groups. The line it adds to the group's
   * thread is carried after the commit; a replay of the same command carries
   * it again, and the group writes it once.
   */
  async executeGroupChatCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        command: rpcDecoded(decodeGroupChatCommandV1),
      },
      { actorBotId: rpcBotId },
    );
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    await this.assertAccountOpen();
    const actor: GroupActorV1 =
      typeof request.actorBotId === "string"
        ? { kind: "bot", botId: request.actorBotId }
        : { kind: "user" };
    return answerGroupRpcV1(async () => {
      const result = await this.groupChats().execute(
        userId,
        request.command as GroupChatCommandV1,
        actor,
      );
      if (result.change) await this.carryGroupChange(userId, result.change);
      return result.receipt;
    });
  }

  /** What a group's own object needs before it acts: the group and names. */
  async readGroupChatContext(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      groupId: rpcPattern(/^g-[0-9a-f]{20}$/, 22),
    });
    await this.assertFlockIdentity(request.userId as string);
    return answerGroupRpcV1(() =>
      this.groupChats().context(request.groupId as string),
    );
  }

  async listBots(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).listBots();
  }

  async readFlockBootstrap(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).readBootstrap();
  }

  async createBot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeCreateBotCommandV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    await this.assertAccountOpen();
    return (await this.flockContribution()).createBot(
      request.userId as string,
      request.command as ReturnType<typeof decodeCreateBotCommandV1>,
    );
  }

  async listBotLifecycles(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).listBotLifecycles();
  }

  async executeBotLifecycle(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecoded(decodeBotLifecycleCommandV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    // The deletion deletes every Bot itself; a restore racing it would not.
    await this.assertAccountOpen();
    const command = request.command as ReturnType<
      typeof decodeBotLifecycleCommandV1
    >;
    const receipt = await (
      await this.flockContribution()
    ).executeLifecycle(request.userId as string, command);
    // Archiving a Bot removes its transcript from the index. The rows are a
    // projection, so this destroys nothing: restoring the Bot and rebuilding
    // brings every one of them back from the Bot's own stored runs. Its audit
    // entries stay, because archiving promises the history is preserved.
    if (command.type === "bot/archive" && receipt.status === "applied") {
      (await this.searchContribution()).purge(command.botId);
    }
    // Deleting a Bot destroys them rather than dropping a projection: nothing
    // is left to rebuild from. The sweep runs here on the common path and from
    // the alarm on every other one.
    if (command.type === "bot/delete" && receipt.status === "applied") {
      await this.forgetDeletedBot(command.botId);
    }
    return receipt;
  }

  /**
   * The Bot's object is the authority on its avatar and checks the command's
   * revision; the directory here is what every Bot list draws from, and it
   * only ever held the appearance the Bot was created with. The mirror is
   * written once the Bot has applied the change, and what it writes is the
   * avatar the Bot reports wearing rather than the one the command asked
   * for: a replayed command — the Bot answers a stored receipt without
   * touching its identity — then mirrors what the Bot wears now, so a write
   * lost between the two heals on the retry without an older command
   * dragging the directory back.
   */
  async updateBotAvatar(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeUpdateAvatarCommandV1),
    });
    const userId = request.userId as string;
    const botId = request.botId as string;
    const command = request.command as ReturnType<
      typeof decodeUpdateAvatarCommandV1
    >;
    await this.assertFlockIdentity(userId);
    const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
    // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
    const bot = this.env.BOT_STATES.get(id) as unknown as {
      updateAvatar(input: unknown): Promise<unknown>;
      readAvatar(input: unknown): Promise<unknown>;
    };
    const receipt = decodeFlockReceiptV1(
      rpcJsonSnapshotV1(
        await bot.updateAvatar({ schemaVersion: 1, userId, botId, command }),
      ),
    );
    if (receipt.status === "applied") {
      const identity = decodeAvatarIdentityViewV1(
        rpcJsonSnapshotV1(
          await bot.readAvatar({ schemaVersion: 1, userId, botId }),
        ),
      );
      await (
        await this.flockContribution()
      ).mirrorAvatar(botId, identity.avatar);
    }
    return receipt;
  }

  /** The Bot's own voice record, read through unchanged. */
  async readBotVoice(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const userId = request.userId as string;
    const botId = request.botId as string;
    await this.assertFlockIdentity(userId);
    return decodeVoiceIdentityViewV1(
      rpcJsonSnapshotV1(
        await this.botVoiceStub(userId, botId).readVoice({
          schemaVersion: 1,
          userId,
          botId,
        }),
      ),
    );
  }

  /**
   * The voice half of the avatar mirror, and for the same reason: the Bot
   * object holds the revision and decides, and the User's directory — which is
   * what the voice session reads when it opens a call — is told afterwards.
   * What is mirrored is the voice the Bot reports, read back from it, so a
   * replayed command cannot drag the directory back to an older voice.
   */
  async updateBotVoice(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeUpdateVoiceCommandV1),
    });
    const userId = request.userId as string;
    const botId = request.botId as string;
    const command = request.command as ReturnType<
      typeof decodeUpdateVoiceCommandV1
    >;
    await this.assertFlockIdentity(userId);
    const bot = this.botVoiceStub(userId, botId);
    const receipt = decodeFlockReceiptV1(
      rpcJsonSnapshotV1(
        await bot.updateVoice({ schemaVersion: 1, userId, botId, command }),
      ),
    );
    if (receipt.status === "applied") {
      const identity = decodeVoiceIdentityViewV1(
        rpcJsonSnapshotV1(
          await bot.readVoice({ schemaVersion: 1, userId, botId }),
        ),
      );
      if (identity.voice) {
        await (
          await this.flockContribution()
        ).mirrorVoice(botId, identity.voice);
      }
    }
    return receipt;
  }

  async readBotLook(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const userId = request.userId as string;
    const botId = request.botId as string;
    await this.assertFlockIdentity(userId);
    return decodeLookIdentityViewV1(
      rpcJsonSnapshotV1(
        await this.botLookStub(userId, botId).readLook({
          schemaVersion: 1,
          userId,
          botId,
        }),
      ),
    );
  }

  async updateBotLook(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      command: rpcDecoded(decodeUpdateLookCommandV1),
    });
    const userId = request.userId as string;
    const botId = request.botId as string;
    const command = request.command as ReturnType<
      typeof decodeUpdateLookCommandV1
    >;
    await this.assertFlockIdentity(userId);
    const bot = this.botLookStub(userId, botId);
    const receipt = decodeFlockReceiptV1(
      rpcJsonSnapshotV1(
        await bot.updateLook({ schemaVersion: 1, userId, botId, command }),
      ),
    );
    if (receipt.status === "applied") {
      const identity = decodeLookIdentityViewV1(
        rpcJsonSnapshotV1(
          await bot.readLook({ schemaVersion: 1, userId, botId }),
        ),
      );
      await (
        await this.flockContribution()
      ).mirrorLook(botId, identity.look, identity.document);
    }
    return receipt;
  }

  async mirrorBotProfile(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      profile: rpcDecoded(decodeBotDirectoryProfileV1),
    });
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    return (await this.flockContribution()).mirrorProfile(
      request.botId as string,
      request.profile as ReturnType<typeof decodeBotDirectoryProfileV1>,
    );
  }

  async mirrorBotLook(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
        look: rpcDecoded(decodeBotLookV1),
      },
      { document: rpcDecoded(decodeThemeDocumentV1) },
    );
    const userId = request.userId as string;
    await this.assertFlockIdentity(userId);
    return (await this.flockContribution()).mirrorLook(
      request.botId as string,
      request.look as ReturnType<typeof decodeBotLookV1>,
      request.document === undefined
        ? undefined
        : (request.document as ReturnType<typeof decodeThemeDocumentV1>),
    );
  }

  /** The Bot object's look surface. */
  private botLookStub(userId: string, botId: string) {
    const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
    // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
    return this.env.BOT_STATES.get(id) as unknown as {
      readLook(input: unknown): Promise<unknown>;
      updateLook(input: unknown): Promise<unknown>;
    };
  }

  /** The Bot object's voice surface. */
  private botVoiceStub(userId: string, botId: string) {
    const id = this.env.BOT_STATES.idFromName(`${userId}:${botId}`);
    // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not represented by workers-types.
    return this.env.BOT_STATES.get(id) as unknown as {
      readVoice(input: unknown): Promise<unknown>;
      updateVoice(input: unknown): Promise<unknown>;
    };
  }

  async getBotRegistration(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.flockContribution()).registration(
      request.botId as string,
    );
  }

  async hasBot(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    const botId = request.botId as string;
    return {
      schemaVersion: 1,
      botId,
      registered: await (await this.flockContribution()).hasBot(botId),
    } as const;
  }

  async isPackageInstalled(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      packageId: rpcIdentifier,
    });
    return (await this.settingsContribution()).isPackageInstalled(
      request.userId as string,
      request.packageId as string,
    );
  }

  private async searchContribution(): Promise<
    MountedFoundationUserBackend["search"]
  > {
    return (await this.contributions()).search;
  }

  /**
   * Rows for one settled Turn, from the Bot Durable Object that owns it.
   *
   * Idempotent on `(botId, runId, seq)`: a resumed Turn, a retried RPC, and a
   * rebuild all converge on the same rows, so the Bot may treat the call as
   * fire-and-forget without risking a duplicated transcript.
   */
  async indexSearchRows(input: unknown): Promise<{ indexed: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      rows: rpcDecodedValue,
    });
    await this.assertFlockIdentity(request.userId as string);
    const botId = request.botId as string;
    if (!(await (await this.flockContribution()).hasBot(botId))) {
      throw new Error(`Bot "${botId}" is not registered to this User`);
    }
    if (!Array.isArray(request.rows)) {
      throw new Error("RPC request.rows must be an array");
    }
    if (request.rows.length > SEARCH_MAX_ROW_PAGE_V1) {
      throw new Error("RPC request.rows exceeds its bound");
    }
    // A Bot indexes its own transcript and no other's. The `botId` was proved
    // registered to this User above; a row naming a different Bot is refused
    // rather than quietly dropped.
    const foreign = request.rows.find(
      (row) =>
        !row ||
        typeof row !== "object" ||
        (row as { botId?: unknown }).botId !== botId,
    );
    if (foreign) {
      throw new Error("search rows name another Bot");
    }
    return (await this.searchContribution()).indexRows(request.rows);
  }

  /** One page of hits across every Bot this User has. */
  async searchTranscripts(input: unknown): Promise<SearchIndexResultsV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      query: rpcDecoded(decodeSearchQueryV1),
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.searchContribution()).search(request.query);
  }

  /**
   * Throws the index away and re-projects it from the Bots' own stored runs.
   *
   * The index is disposable because this exists. It is also the backfill path
   * for a Bot whose turns predate the index, so one code path produces every
   * row the index has ever held.
   */
  async rebuildSearchIndex(
    input: unknown,
  ): Promise<ClientSearchRebuildReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    const outcome = await (await this.searchContribution()).rebuild();
    return {
      schemaVersion: 1,
      status: "rebuilt",
      indexedRows: outcome.indexedRows,
      bots: Math.min(outcome.bots, SEARCH_REBUILD_BOT_LIMIT),
      indexState: outcome.indexState,
    };
  }

  /** Every row of one Bot leaves the index. Archiving a Bot calls this. */
  async purgeSearchIndex(input: unknown): Promise<{ removed: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.searchContribution()).purge(request.botId as string);
  }

  private async auditContribution(): Promise<
    MountedFoundationUserBackend["audit"]
  > {
    return (await this.contributions()).audit;
  }

  /**
   * Audit entries for one settled Turn, from the Bot Durable Object that owns
   * it.
   *
   * Idempotent on `(botId, runId, occurrenceId)`, which is what makes the Bot
   * object's outbox safe: it delivers at least once, and a redelivery inserts
   * nothing.
   */
  async indexAuditEntries(input: unknown): Promise<{ indexed: number }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      entries: rpcDecodedValue,
    });
    await this.assertFlockIdentity(request.userId as string);
    const botId = request.botId as string;
    if (!(await (await this.flockContribution()).hasBot(botId))) {
      throw new Error(`Bot "${botId}" is not registered to this User`);
    }
    if (!Array.isArray(request.entries)) {
      throw new Error("RPC request.entries must be an array");
    }
    if (request.entries.length > AUDIT_MAX_ENTRY_PAGE_V1) {
      throw new Error("RPC request.entries exceeds its bound");
    }
    // A Bot audits its own effects and no other's.
    const foreign = request.entries.find(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        (entry as { botId?: unknown }).botId !== botId,
    );
    if (foreign) {
      throw new Error("audit entries name another Bot");
    }
    return (await this.auditContribution()).indexAuditEntries(request.entries);
  }

  /**
   * Throws the audit table away and re-projects it from the Bots' own stored
   * runs. The receipt counts the outcomes the logs do not know, never a
   * silent gap.
   */
  async rebuildAuditIndex(input: unknown): Promise<AuditRebuildReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertFlockIdentity(request.userId as string);
    return (await this.auditContribution()).rebuildAuditIndex();
  }

  /**
   * One filtered, paged answer out of this User's audit table.
   *
   * User-scoped by construction: there is no cross-User store to reach into,
   * and the object refuses any RPC naming a User it is not.
   */
  async readAuditEntries(input: unknown): Promise<ClientAuditPageV1> {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier },
      {
        botId: rpcBotId,
        kind: rpcEnum(AUDIT_KINDS_V1),
        target: rpcString(160),
        before: rpcString(AUDIT_MAX_CURSOR_LENGTH_V1),
        limit: rpcInteger({ minimum: 1, maximum: AUDIT_MAX_RESULTS_V1 }),
      },
    );
    await this.assertFlockIdentity(request.userId as string);
    const contribution = await this.auditContribution();
    const page = contribution.query({
      ...(request.botId === undefined
        ? {}
        : { botId: request.botId as string }),
      ...(request.kind === undefined ? {} : { kind: request.kind as string }),
      ...(request.target === undefined
        ? {}
        : { target: request.target as string }),
      ...(request.before === undefined
        ? {}
        : { before: request.before as string }),
      ...(request.limit === undefined
        ? {}
        : { limit: request.limit as number }),
    });
    return {
      schemaVersion: 1,
      entries: page.entries,
      page: {
        truncated: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      },
      total: page.total,
      indexState: contribution.state(),
    };
  }

  /** One page of Activity out of this User's audit table, a Turn to a row. */
  async readAuditActivity(input: unknown): Promise<AuditActivityPageV1> {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier },
      {
        botId: rpcBotId,
        filter: rpcEnum(AUDIT_ACTIVITY_FILTER_NAMES_V1),
        before: rpcString(AUDIT_MAX_CURSOR_LENGTH_V1),
        limit: rpcInteger({ minimum: 1, maximum: AUDIT_ACTIVITY_MAX_ROWS_V1 }),
      },
    );
    await this.assertFlockIdentity(request.userId as string);
    return (await this.auditContribution()).activity({
      ...(request.botId === undefined
        ? {}
        : { botId: request.botId as string }),
      ...(request.filter === undefined
        ? {}
        : { filter: request.filter as AuditActivityFilterV1 }),
      ...(request.before === undefined
        ? {}
        : { before: request.before as string }),
      ...(request.limit === undefined
        ? {}
        : { limit: request.limit as number }),
    });
  }

  private async machineContribution(): Promise<
    MountedFoundationUserBackend["machines"]
  > {
    return (await this.contributions()).machines;
  }

  /**
   * The registered-machine RPCs (parity register rows 48, 49, 57g).
   *
   * The four a machine reaches — its socket, claim, result, and the
   * enrollment that precedes them — arrive from the gateway's pre-session
   * `publicRoute`, so this object is the first place a *session* was never
   * involved. That is exactly why each carries the token's own claims and its
   * digest rather than a caller's assertion: the claims were verified against
   * the deployment secret at the edge, and the digest is checked here against
   * the machine record, which is the authority. `assertUserIdentity` still
   * runs, so a token naming another User cannot reach this object's state even
   * if the gateway addressed it wrongly.
   */
  async createMachinePairing(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      { userId: rpcIdentifier },
      { label: rpcString(200) },
    );
    const userId = await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).createPairing(
      userId,
      request.label === undefined ? {} : { label: request.label as string },
    );
  }

  async enrollMachine(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      enrollment: rpcDecodedValue,
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).enroll(
      {
        userId,
        machineId: request.machineId as string,
        nonce: "",
      },
      request.enrollment,
    );
  }

  /**
   * A registered machine's socket: the only request this object answers over
   * `fetch`, because RPC cannot hand over a WebSocket.
   *
   * The gateway verified the token against the deployment secret; this is the
   * authoritative check against the machine record, then the socket is
   * accepted to hibernate and sent every command still waiting.
   */
  fetch(request: Request): Promise<Response> {
    return answeredEntryV1("Machine socket failed", () =>
      this.openMachineSocket(request),
    );
  }

  private async openMachineSocket(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== MACHINE_SOCKET_INTERNAL_PATH_V1) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "WebSocket upgrade required" },
        { status: 426 },
      );
    }
    const machines = await this.machineContribution();
    let opened: Awaited<ReturnType<typeof machines.connect>>;
    let modules: MachineSocketFrameV1 | undefined;
    let machineId: string;
    let tokenDigest: string;
    try {
      const { userId, call } = readMachineSocketCallV1(request);
      await this.assertUserIdentity(userId);
      machineId = call.machineId;
      tokenDigest = call.tokenDigest;
      opened = await machines.connect(call.claims, tokenDigest, machineId);
    } catch (error) {
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 401;
      return Response.json({ error: "machine token is invalid" }, { status });
    }
    const platform = opened.record.platform;
    // Commands still flow while the Composition cannot be read; the list
    // arrives with the next generation change or reconnect.
    await loggedEntryV1("Machine modules frame", async () => {
      modules = await this.machineModulesFrame(platform);
    });
    // Nothing is awaited from here to the send, so a dispatch cannot land
    // between the pending read above and the socket being registered.
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, [machineSocketTagV1(machineId)]);
    server!.serializeAttachment({
      machineId,
      tokenDigest,
      keyVersion: opened.record.keyVersion,
      platform,
    } satisfies MachineSocketAttachmentV1);
    server!.send(JSON.stringify(opened.frame));
    if (modules) server!.send(JSON.stringify(modules));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async machineModulesFrame(
    platform: MachinePlatformV1,
  ): Promise<MachineSocketFrameV1> {
    return {
      type: "modules",
      modules: machineModulesV1(
        await this.activeGeneration(),
        platform,
        await readModuleRoutingV1(
          this.ctx.storage,
          await this.pluginTriggerRoutines(),
        ),
      ),
      serverTime: new Date().toISOString(),
    };
  }

  // The machine socket is server-push only: anything but the auto-answered
  // keep-alive is a client that does not speak this protocol.
  webSocketMessage(socket: WebSocket): Promise<void> {
    return loggedEntryV1("Machine socket message", () =>
      socket.close(1003, "server-push channel"),
    );
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    return loggedEntryV1("Machine socket close", async () => {
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
      await this.machineSocketClosed(socket);
    });
  }

  webSocketError(socket: WebSocket): Promise<void> {
    return loggedEntryV1("Machine socket error", async () => {
      try {
        socket.close(1011, "socket error");
      } catch {
        // Already closed.
      }
      await this.machineSocketClosed(socket);
    });
  }

  private async machineSocketClosed(socket: WebSocket): Promise<void> {
    const attachment =
      socket.deserializeAttachment() as MachineSocketAttachmentV1 | null;
    if (!attachment) return;
    await (await this.machineContribution()).disconnected(attachment.machineId);
  }

  async claimMachineCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      commandId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).claim(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
      request.commandId as string,
    );
  }

  async recordMachineResult(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      commandId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
      result: rpcDecodedValue,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).recordResult(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
      request.commandId as string,
      request.result,
    );
  }

  /**
   * Whether a machine may fetch the module artifact `contentHash`: only one
   * the active generation carries. The Worker serves the bytes; this object
   * is the authority on which bytes are the account's to hand out.
   */
  async readMachineModule(input: unknown): Promise<{ found: boolean }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      contentHash: rpcPattern(/^[0-9a-f]{64}$/, 64),
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
    });
    await this.assertUserIdentity(request.userId as string);
    await (
      await this.machineContribution()
    ).authorize(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
    );
    return {
      found: generationCarriesModuleV1(
        await this.activeGeneration(),
        request.contentHash as string,
      ),
    };
  }

  /** What a machine's module host said about the modules it runs. */
  async recordMachineModuleReports(
    input: unknown,
  ): Promise<MachineModuleReportsReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
      reports: rpcDecoded(decodeMachineModuleReportsV1),
    });
    await this.assertUserIdentity(request.userId as string);
    const record = await (
      await this.machineContribution()
    ).authorize(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
    );
    const receipt = await recordPluginModuleReportsV1(this.ctx.storage, {
      generation: await this.activeGeneration(),
      machineId: record.machineId,
      machineLabel: record.label,
      reports: (
        request.reports as ReturnType<typeof decodeMachineModuleReportsV1>
      ).reports,
      now: new Date(),
    });
    return { schemaVersion: 1, ...receipt };
  }

  /** How long a device call waits for its module; a test may shorten it. */
  deviceCallWaitMs = DEVICE_CALL_WAIT_MS;
  private deviceCalls: MachineModuleCallsV1 | undefined;

  /** Plugins' calls to their device modules (ADR 0037). */
  private moduleCalls(): MachineModuleCallsV1 {
    this.deviceCalls ??= new MachineModuleCallsV1({
      storage: this.ctx.storage,
      waitMs: this.deviceCallWaitMs,
      // A machine runs the module if it is connected and was sent it: the
      // active generation carries it for the machine's platform, with the call.
      candidates: async (request) => {
        const connected = connectedMachinePlatformsV1(this.ctx);
        if (connected.size === 0) return [];
        const active = await this.activeGeneration();
        return [...connected]
          .filter(([, platform]) =>
            machineModulesV1(active, platform).some(
              (module) =>
                module.pluginId === request.pluginId &&
                module.moduleId === request.moduleId &&
                module.calls.includes(request.call),
            ),
          )
          .map(([machineId]) => machineId)
          .sort();
      },
      push: (machineId, frame) =>
        durableObjectMachineSocketsV1(this.ctx).push(machineId, frame),
    });
    return this.deviceCalls;
  }

  /**
   * One Plugin tool's call to its device module, from the Bot's object,
   * which already checked the Plugin declares the module and the call. The
   * answer waits for the desktop at most until the call's deadline.
   */
  async callDeviceModule(input: unknown): Promise<DeviceCallOutcomeV1> {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        botId: rpcBotId,
        callId: rpcPattern(/^mc-[0-9a-f]{40}$/, 43),
        pluginId: rpcPattern(/^[a-z][a-z0-9-]{0,63}$/, 64),
        moduleId: rpcPattern(/^[a-z][a-z0-9-]{0,31}$/, 32),
        call: rpcString(64),
        // Bounded by the Bot's object, which refused an oversized one before
        // anything was recorded.
        input: rpcDecoded((value) => value),
      },
      { deviceId: rpcIdentifier },
    );
    await this.assertUserIdentity(request.userId as string);
    return this.moduleCalls().call({
      callId: request.callId as string,
      botId: request.botId as string,
      pluginId: request.pluginId as string,
      moduleId: request.moduleId as string,
      call: request.call as string,
      input: request.input,
      ...(request.deviceId === undefined
        ? {}
        : { deviceId: request.deviceId as string }),
    });
  }

  async claimMachineModuleCall(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      callId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
    });
    await this.assertUserIdentity(request.userId as string);
    const record = await (
      await this.machineContribution()
    ).authorize(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
    );
    return this.moduleCalls().claim(record.machineId, request.callId as string);
  }

  /**
   * A module call's answer. One after its deadline reached nobody, so it is
   * put in the Plugin's module reports, where the Bot and the Work view can
   * see what happened after the Turn moved on.
   */
  async recordMachineModuleCallResult(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      callId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
      result: rpcDecoded(decodeMachineModuleCallResultV1),
    });
    await this.assertUserIdentity(request.userId as string);
    const record = await (
      await this.machineContribution()
    ).authorize(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
    );
    const calls = this.moduleCalls();
    const callId = request.callId as string;
    const result = request.result as ReturnType<
      typeof decodeMachineModuleCallResultV1
    >;
    const receipt = await calls.result(record.machineId, callId, result);
    if (receipt.status === "late") {
      await loggedEntryV1("Late module call report", async () => {
        const call = await calls.describe(callId);
        if (!call) return;
        const answer = result.ok
          ? `answered ${JSON.stringify(result.value)}`
          : `failed: ${result.error}`;
        await recordPluginModuleReportsV1(this.ctx.storage, {
          generation: await this.activeGeneration(),
          machineId: record.machineId,
          machineLabel: record.label,
          reports: [
            {
              pluginId: call.pluginId,
              moduleId: call.moduleId,
              kind: "log",
              level: "error",
              text: `call "${call.call}" ${answer} after its deadline; the Turn that asked was not told`.slice(
                0,
                2_000,
              ),
            },
          ],
          now: new Date(),
        });
      });
    }
    return receipt;
  }

  /**
   * Events a machine's device modules emitted (ADR 0037), each routed to
   * every Routine that listens and answered only once that is durable. A
   * Bot that cannot be reached fails the post rather than the event: the
   * desktop sends it again, and each Routine's own replay guard, keyed by the
   * event's key, lets a retry fire only what the first attempt did not.
   */
  async recordMachineModuleEvents(
    input: unknown,
  ): Promise<MachineModuleEventsReceiptV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
      claims: rpcDecodedValue,
      tokenDigest: rpcPattern(/^[0-9a-f]{64}$/, 64),
      events: rpcDecoded(decodeMachineModuleEventsV1),
    });
    const userId = await this.assertUserIdentity(request.userId as string);
    const record = await (
      await this.machineContribution()
    ).authorize(
      machineTokenClaimsV1(request.claims),
      request.tokenDigest as string,
      request.machineId as string,
    );
    const { events } = request.events as ReturnType<
      typeof decodeMachineModuleEventsV1
    >;
    const generation = await this.activeGeneration();
    const routines = await this.pluginTriggerRoutines();
    const liveBots = new Set(
      (await (await this.flockContribution()).listBots()).bots.map(
        (bot) => bot.botId,
      ),
    );
    const receipts: MachineModuleEventReceiptV1[] = [];
    let moved = false;
    for (const event of events) {
      const now = new Date();
      const refused = refuseModuleEventV1(generation, event);
      if (refused !== undefined) {
        receipts.push({ status: "dropped", reason: refused });
        continue;
      }
      const origin = {
        machineId: record.machineId,
        pluginId: event.pluginId,
        key: event.key,
        now,
      };
      if (await moduleEventSeenV1(this.ctx.storage, origin)) {
        receipts.push({ status: "duplicate" });
        continue;
      }
      await Promise.all(
        moduleEventTargetsV1(routines, event, liveBots).map(async (routine) =>
          this.botRoutinesStub(userId, routine.botId).deliverPluginModuleEvent({
            schemaVersion: 1,
            userId,
            botId: routine.botId,
            ...(await moduleEventDeliveryV1({
              machineId: record.machineId,
              event,
              routine,
            })),
          }),
        ),
      );
      moved =
        (await recordModuleEventV1(this.ctx.storage, {
          machineId: record.machineId,
          event,
          now,
        })) || moved;
      receipts.push({ status: "admitted" });
    }
    await trimModuleEventsSeenV1(this.ctx.storage, new Date());
    if (moved) await this.pushMachineModules();
    return { schemaVersion: 1, receipts };
  }

  /** One Plugin's module reports, for its Bot's `plugin_module_reports`. */
  async readPluginModuleReports(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      pluginId: rpcPattern(/^[a-z][a-z0-9-]{0,63}$/, 64),
    });
    await this.assertUserIdentity(request.userId as string);
    return readPluginModuleReportsV1(
      this.ctx.storage,
      request.pluginId as string,
    );
  }

  /**
   * One machine and the two counters a control tool checks its quota against.
   *
   * The tool refuses before it asks a person anything, so a card the User
   * approves and the queue then refuses is not a question that wasted their
   * attention.
   */
  async describeMachineTarget(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).describeTarget(
      request.machineId as string,
    );
  }

  /**
   * Take every finished machine command waiting to be told to a Bot.
   *
   * Drained by the Worker that just answered the machine. It is not this
   * object's job to call another Durable Object: a live reference from one to
   * another keeps the caller resident, and presence and eviction are the two
   * things this registry is built not to depend on.
   */
  async takeMachineDeliveries(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).takeDeliveries();
  }

  async listMachines(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, { userId: rpcIdentifier });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).list();
  }

  async revokeMachine(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      machineId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).revoke(
      request.machineId as string,
    );
  }

  /**
   * Put one approved command on a machine's queue.
   *
   * The caller that matters is R3's approval settlement — a command reaches a
   * User's laptop only after a human decided — and it is here in R2 so the
   * queue's own rules have a door.
   */
  async dispatchMachineCommand(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      command: rpcDecodedValue,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).dispatch(request.command);
  }

  /** One command's full result, read on demand rather than pushed. */
  async readMachineResult(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      commandId: rpcIdentifier,
    });
    await this.assertUserIdentity(request.userId as string);
    return (await this.machineContribution()).readResult(
      request.commandId as string,
    );
  }

  private async assertFlockIdentity(userId: string): Promise<void> {
    await this.assertUserIdentity(userId);
    await (
      await this.settingsContribution()
    ).readConfiguration({ schemaVersion: 1, userId });
  }

  // --- Inbound email -----------------------------------------------------------
  //
  // Which Bots receive email, and the account's confirmed senders. The
  // `email()` handler asks `routeInboundEmail` about every message that got
  // past its own checks; the settings routes read and change the rest. The
  // username is the deployment directory's, not this object's.

  /** The User's inbound email, over this object's storage and Bot directory. */
  private inboundEmail(): InboundEmailUserStoreV1 {
    return new InboundEmailUserStoreV1({
      storage: this.ctx.storage as unknown as InboundEmailUserHostV1["storage"],
      bots: async () => {
        const flock = await this.flockContribution();
        const [directory, lifecycles] = await Promise.all([
          flock.listBots(),
          flock.listBotLifecycles(),
        ]);
        const status = new Map(
          lifecycles.lifecycles.map((lifecycle) => [
            lifecycle.botId,
            lifecycle.status,
          ]),
        );
        return directory.bots
          .filter((bot) => status.get(bot.botId) !== "deleted")
          .map((bot) => ({
            botId: bot.botId,
            name: bot.currentProfile?.name ?? bot.initialName,
            registeredAt: bot.registeredAt,
            active: status.get(bot.botId) === "active",
          }));
      },
    });
  }

  /** One of the User's Bots, or `BotNotFoundError`. */
  private async requireInboundEmailBot(botId: string): Promise<void> {
    if (!(await (await this.flockContribution()).hasBot(botId))) {
      throw new BotNotFoundError(botId);
    }
  }

  async readInboundEmail(input: unknown): Promise<InboundEmailStateV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    await this.assertUserIdentity(request.userId as string);
    await this.requireInboundEmailBot(request.botId as string);
    return this.inboundEmail().state(request.botId as string);
  }

  /** Whether a Bot receives email. */
  async setBotEmailEnabled(input: unknown) {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
      enabled: rpcBoolean,
    });
    await this.assertUserIdentity(request.userId as string);
    const botId = request.botId as string;
    await this.requireInboundEmailBot(botId);
    try {
      await this.inboundEmail().setEnabled(botId, request.enabled as boolean);
    } catch (error) {
      if (error instanceof Error && error.name === "InboundEmailCommandError") {
        return {
          schemaVersion: 1 as const,
          status: "rejected" as const,
          reason: error.message,
        };
      }
      throw error;
    }
    return { schemaVersion: 1 as const, status: "applied" as const };
  }

  /**
   * What one of the User's Bots sends email as, for that Bot's kernel: its
   * address, which needs the account's username and the Bot's switch, and the
   * owner's own addresses it may write to without a draft card.
   */
  async readBotEmailSender(input: unknown): Promise<BotEmailSenderV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      botId: rpcBotId,
    });
    const userId = request.userId as string;
    await this.assertUserIdentity(userId);
    const domain = emailDomainV1(this.env);
    if (!domain) {
      return this.inboundEmail().sender(request.botId as string, {});
    }
    const [username, signInEmail] = await Promise.all([
      this.emailUsername(userId),
      this.emailSignIn(userId),
    ]);
    return this.inboundEmail().sender(request.botId as string, {
      domain,
      ...(username ? { username } : {}),
      ...(signInEmail ? { signInEmail } : {}),
    });
  }

  /** The account's email username, which the deployment's directory holds. */
  private async emailUsername(userId: string): Promise<string | undefined> {
    const policy = this.env.DEPLOYMENT_POLICY;
    if (!policy) return undefined;
    // SAFETY: the binding names DeploymentPolicy; this is its username read.
    const directory = policy.get(
      policy.idFromName(DEPLOYMENT_POLICY_SINGLETON_NAME),
    ) as unknown as { readEmailUsername(input: unknown): Promise<unknown> };
    const { username } = (await directory.readEmailUsername({
      schemaVersion: 1,
      userId,
    })) as { username?: unknown };
    return typeof username === "string" ? username : undefined;
  }

  /**
   * The address the identity provider verified, read from the stored identity
   * and never from a session: the one owner address that needs no code.
   */
  private async emailSignIn(userId: string): Promise<string | undefined> {
    const { AUTH_PACKAGE_V1 } = await import("#auth-package");
    const identity = await AUTH_PACKAGE_V1.create(this.env).storedIdentity?.(
      userId,
    );
    return identity?.emailVerified
      ? normalizeSenderAddressV1(identity.email)
      : undefined;
  }

  /** Add an address that may email the User's Bots, or take one away. */
  async commandInboundEmailSender(input: unknown) {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        action: rpcEnum(["add", "remove"] as const),
        address: rpcDecoded(requiredSenderAddress),
      },
      { signInEmail: rpcDecoded(requiredSenderAddress) },
    );
    await this.assertUserIdentity(request.userId as string);
    const store = this.inboundEmail();
    const address = request.address as string;
    try {
      if (request.action === "remove") {
        await store.removeSender(address);
      } else {
        await store.addSender(address, {
          ...(request.signInEmail
            ? { signInEmail: request.signInEmail as string }
            : {}),
          now: Date.now(),
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === "InboundEmailCommandError") {
        return {
          schemaVersion: 1 as const,
          status: "rejected" as const,
          reason: error.message,
        };
      }
      throw error;
    }
    return { schemaVersion: 1 as const, status: "applied" as const };
  }

  /**
   * Whether one authenticated message may reach one of this User's Bots, and
   * which. The `email()` handler asks only after the receiving server's DMARC
   * verdict passed for `sender`, and after the directory said the username
   * the message names is this User's.
   */
  async routeInboundEmail(
    input: unknown,
  ): Promise<InboundEmailRouteDecisionV1> {
    const request = decodeRpcEnvelopeV1(
      input,
      {
        userId: rpcIdentifier,
        slug: rpcPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 32),
        sender: rpcDecoded(requiredSenderAddress),
        codes: rpcArray(rpcPattern(/^[0-9A-HJKMNP-TV-Z]{8}$/, 8), 3),
      },
      { signInEmail: rpcDecoded(requiredSenderAddress) },
    );
    await this.assertUserIdentity(request.userId as string);
    return this.inboundEmail().route({
      slug: request.slug as string,
      sender: request.sender as string,
      ...(request.signInEmail
        ? { signInEmail: request.signInEmail as string }
        : {}),
      codes: request.codes as string[],
      now: Date.now(),
    });
  }
}

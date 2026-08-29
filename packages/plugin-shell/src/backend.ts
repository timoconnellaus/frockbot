import type { SessionEvent } from "@frockbot/agent-core";
import type { FoundationAgentPackage } from "@frockbot/agent-runtime/runtime";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import {
  capabilityAssignmentFailureV1,
  configurationCommandFingerprintV1,
  ConfigurationConflictError,
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  type ConnectionDependencyRequirementV1,
  type BotExecutionPlanV1,
  type BotSettingsViewV1,
  type ConnectionView,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
  initializeBotSettingsV1,
  resolveBotExecutionPlanV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";
import { createFoundationAssignedRuntimePackages } from "@frockbot/application-foundation/runtime";
import { createFoundationHostedRuntimePackages } from "@frockbot/application-foundation/runtime";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import {
  settleAssignmentSaga,
  type StoredAssignmentSaga,
} from "./backend-assignment.js";
import {
  completeStoredRun,
  failStoredRun,
  requireStoredRunReconciliation,
} from "./backend-completion.js";
import {
  BotTurnReconciliationRequiredError,
  executeBotTurn,
} from "./backend-runner.js";
import {
  eventsForFailedRun,
  latestModelRequestJournalState,
  planBotRunRecovery,
} from "./backend-recovery.js";
import {
  CLIENT_RUN_LIST_MAX_BYTES,
  CLIENT_RUN_PAGE_LIMIT,
  clientRunListWireBytes,
  createClientRunListV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunListQueryV1,
  projectClientRunLookupV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientRunLookupV1,
  type ClientRunListV1,
  type ClientRunV1,
  type ClientTurnV1,
} from "./run-protocol.js";
import type {
  BotNotificationIntent,
  BotTurnCommand,
  BotTurnCompletion,
  StoredRun,
} from "./backend-contracts.js";
import { botTurnCommandFingerprintV1 } from "./backend-contracts.js";

const RUN_PREFIX = "run:";
const RUN_INDEX_PREFIX = "run-index:";
const RUN_ADMISSION_FENCE_PREFIX = "run-admission-fence:";
const ACTIVE_RUN_KEY = "active-run";
const LATEST_EVENTS_KEY = "latest-events";
const IDENTITY_KEY = "identity";
const BOT_CONFIGURATION_KEY = "bot-configuration";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
const ASSIGNMENT_GENERATION_PREFIX = "assignment-generation:";
const ASSIGNMENT_COMPENSATION_PREFIX = "assignment-compensation:";
const ASSIGNMENT_TOMBSTONE_PREFIX = "assignment-tombstone:";
const ASSIGNMENT_SAGA_PREFIX = "assignment-saga:";
const NOTIFICATION_PREFIX = "notification:";
const RECOVERY_ALARM_DELAY_MS = 60_000;
const ASSIGNMENT_SAGA_DEADLINE_MS = 60_000;

function runIndexKey(acceptedAt: string, runId: string): string {
  return `${RUN_INDEX_PREFIX}${acceptedAt}:${runId}`;
}

interface BotIdentity {
  userId: string;
  botId: string;
}

interface StoredConfigurationReceipt {
  commandFingerprint: string;
  receipt: OperationReceiptV1;
}

interface AssignmentActivity {
  commandFingerprint: string;
  promise: Promise<OperationReceiptV1>;
}

function requireMatchingConfigurationReceipt(
  stored: StoredConfigurationReceipt,
  commandFingerprint: string,
  commandId: string,
): OperationReceiptV1 {
  if (stored.commandFingerprint !== commandFingerprint) {
    throw new Error(
      `Configuration command idempotency key "${commandId}" was reused for a different command`,
    );
  }
  return stored.receipt;
}

export interface OwnedBotTurnCommand extends BotTurnCommand, BotIdentity {}

export interface BotStateEnv {
  MEMORY_FILES: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  USER_CONFIGURATIONS: DurableObjectNamespace;
  COMPOSIO_API_KEY?: string;
  SPRITES_TOKEN?: string;
}

export interface ShellBotBackendHost {
  state: DurableObjectState;
  env: BotStateEnv;
}

function parseStoredJson<T>(body: string): Promise<T> {
  try {
    return Promise.resolve(JSON.parse(body) as T);
  } catch (error) {
    return Promise.reject(error);
  }
}

function memoryPluginConfig(
  env: BotStateEnv,
  identity: BotIdentity,
): MemoryPluginConfig {
  return {
    ownerId: identity.userId,
    agentId: identity.botId,
    bucket: {
      get: async (key) => {
        const object = await env.MEMORY_FILES.get(key);
        if (!object) return null;
        const body = await object.text();
        return {
          text: () => Promise.resolve(body),
          json: <T>() => parseStoredJson<T>(body),
        };
      },
      put: (key, value, options) =>
        env.MEMORY_FILES.put(key, value, {
          httpMetadata: options?.httpMetadata?.contentType
            ? { contentType: options.httpMetadata.contentType }
            : undefined,
        }),
      delete: (key) => env.MEMORY_FILES.delete(key),
      list: async ({ prefix, cursor }) => {
        const page = await env.MEMORY_FILES.list({ prefix, cursor });
        return {
          objects: page.objects.map((object) => ({ key: object.key })),
          truncated: page.truncated,
          cursor: page.truncated ? page.cursor : undefined,
        };
      },
    },
    vectorize: {
      upsert: (vectors) => env.MEMORY_INDEX.upsert(vectors),
      query: async (vector, options) => {
        const result = await env.MEMORY_INDEX.query(vector, options);
        return {
          matches: result.matches.map((match) => ({
            id: match.id,
            score: match.score,
            metadata: match.metadata,
          })),
        };
      },
      deleteByIds: (ids) => env.MEMORY_INDEX.deleteByIds(ids),
    },
    ai: {
      run: (model, input) =>
        env.AI.run(model as keyof AiModels, {
          text: input.text,
        }) as Promise<{ data: number[][] }>,
    },
  };
}

export class ShellBotBackendContribution {
  readonly ctx: DurableObjectState;
  readonly env: BotStateEnv;
  private executingRunId: string | undefined;
  private readonly assignmentActivities = new Map<string, AssignmentActivity>();

  constructor(host: ShellBotBackendHost) {
    this.ctx = host.state;
    this.env = host.env;
  }

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    return this.ensureBotSettings(identity);
  }

  async readConfiguration(input: unknown): Promise<BotSettingsViewV1> {
    const request = decodeBotConfigurationReadRpcV1(input);
    return this.getSettings({ userId: request.userId, botId: request.botId });
  }

  async executeConfiguration(input: unknown): Promise<OperationReceiptV1> {
    const request = decodeBotConfigurationExecuteRpcV1(input);
    return this.executeConfigurationCommand(
      { userId: request.userId, botId: request.botId },
      request.command,
    );
  }

  private async executeConfigurationCommand(
    identity: BotIdentity,
    command: Extract<ConfigurationCommandV1, { botId: string }>,
  ): Promise<OperationReceiptV1> {
    const commandFingerprint = configurationCommandFingerprintV1(command);
    const active = this.assignmentActivities.get(command.commandId);
    if (active) {
      if (active.commandFingerprint !== commandFingerprint) {
        throw new Error(
          `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
        );
      }
      return active.promise;
    }
    const activity: Promise<OperationReceiptV1> =
      this.executeConfigurationDurably(
        identity,
        command,
        commandFingerprint,
      ).finally(() => {
        if (
          this.assignmentActivities.get(command.commandId)?.promise === activity
        ) {
          this.assignmentActivities.delete(command.commandId);
        }
      });
    this.assignmentActivities.set(command.commandId, {
      commandFingerprint,
      promise: activity,
    });
    return activity;
  }

  private async executeConfigurationDurably(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/update-profile"
          | "bot/update-notifications"
          | "bot/select-model"
          | "bot/assign-capability";
      }
    >,
    commandFingerprint: string,
  ): Promise<OperationReceiptV1> {
    const settings = await this.ensureBotSettings(identity);
    const existing = await this.ctx.storage.get<StoredConfigurationReceipt>(
      `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`,
    );
    if (existing) {
      const receipt = requireMatchingConfigurationReceipt(
        existing,
        commandFingerprint,
        command.commandId,
      );
      if (receipt.status === "applied") {
        await this.reconcileStoredAssignmentSaga(
          identity,
          command.commandId,
          commandFingerprint,
        );
      }
      return receipt;
    }
    if (command.expectedRevision !== settings.revision) {
      throw new ConfigurationConflictError(settings.revision);
    }
    let dependencyRequirement: ConnectionDependencyRequirementV1 | undefined;
    if (command.type === "bot/assign-capability") {
      const [user, application] = await Promise.all([
        this.userConfiguration(identity).readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
        compileFoundationApplication(),
      ]);
      const failure = capabilityAssignmentFailureV1({
        assignment: command.assignment,
        user,
        packages: application.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          capabilities: pkg.manifest.configuration?.capabilities ?? [],
          connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
        })),
      });
      if (failure) {
        return this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          failure,
        );
      }
      if (command.assignment.connectionId) {
        const installation = user.packages.find(
          (pkg) =>
            pkg.packageId === command.assignment.packageId &&
            pkg.state === "installed",
        );
        const pkg = application.packages.find(
          (candidate) =>
            candidate.id === command.assignment.packageId &&
            candidate.version === installation?.version,
        );
        const capability = pkg?.manifest.configuration?.capabilities.find(
          (candidate) => candidate.id === command.assignment.capabilityId,
        );
        if (!installation || !pkg || !capability) {
          return this.rejectConfigurationCommand(
            identity,
            command,
            commandFingerprint,
            "Capability assignment policy changed during validation",
          );
        }
        dependencyRequirement = {
          schemaVersion: 1,
          packageId: pkg.id,
          packageVersion: pkg.version,
          capabilityId: capability.id,
          connectionTypeIds: [...capability.connectionTypes],
        };
      }
    }
    if (
      command.type !== "bot/assign-capability" ||
      !command.assignment.connectionId ||
      !dependencyRequirement
    ) {
      return this.applyConfigurationCommand(
        identity,
        command,
        commandFingerprint,
      );
    }
    const connectionAssignment = {
      connectionId: command.assignment.connectionId,
      generation: command.commandId,
      requirement: dependencyRequirement,
    };
    const userConfiguration = this.userConfiguration(identity);

    await this.reconcileStoredAssignmentSaga(
      identity,
      command.commandId,
      commandFingerprint,
    );
    const admission = await this.ctx.storage.transaction(
      async (transaction) => {
        const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
        const existing =
          await transaction.get<StoredConfigurationReceipt>(receiptKey);
        if (existing) {
          return {
            receipt: requireMatchingConfigurationReceipt(
              existing,
              commandFingerprint,
              command.commandId,
            ),
          };
        }
        const current =
          (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
          this.initialBotSettings(identity.botId);
        if (command.expectedRevision !== current.revision) {
          throw new ConfigurationConflictError(current.revision);
        }
        if (
          await transaction.get(
            `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionAssignment.connectionId}:${connectionAssignment.generation}`,
          )
        ) {
          throw new Error("Connection assignment was revoked before admission");
        }
        const saga: StoredAssignmentSaga = {
          schemaVersion: 1,
          commandId: command.commandId,
          commandFingerprint,
          userId: identity.userId,
          botId: identity.botId,
          connectionId: connectionAssignment.connectionId,
          generation: connectionAssignment.generation,
          phase: "claiming",
          deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
        };
        await transaction.put(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
          saga,
        );
        await this.refreshRecoveryAlarm(transaction);
        return { saga };
      },
    );
    if (admission.receipt) return admission.receipt;
    const saga = admission.saga;
    try {
      if (
        !(await userConfiguration.claimConnectionDependency(
          identity.userId,
          saga.connectionId,
          identity.botId,
          saga.generation,
          connectionAssignment.requirement,
        ))
      ) {
        return await this.rejectConfigurationCommand(
          identity,
          command,
          commandFingerprint,
          "Connection assignment is no longer authorized",
          saga,
        );
      }
      const receipt = await this.applyConfigurationCommand(
        identity,
        command,
        commandFingerprint,
        saga,
      );
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
      return receipt;
    } catch (error) {
      try {
        await this.reconcileStoredAssignmentSaga(
          identity,
          command.commandId,
          commandFingerprint,
        );
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          "Connection assignment admission and reconciliation failed",
        );
      }
      throw error;
    }
  }

  private async rejectConfigurationCommand(
    identity: BotIdentity,
    command: Extract<ConfigurationCommandV1, { type: "bot/assign-capability" }>,
    commandFingerprint: string,
    failure: string,
    saga?: StoredAssignmentSaga,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
      const existing =
        await transaction.get<StoredConfigurationReceipt>(receiptKey);
      if (existing) {
        return requireMatchingConfigurationReceipt(
          existing,
          commandFingerprint,
          command.commandId,
        );
      }
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: current.revision,
        status: "rejected",
        failure,
      };
      await transaction.put(receiptKey, { commandFingerprint, receipt });
      if (saga) {
        await transaction.delete(`${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`);
        await this.refreshRecoveryAlarm(transaction);
      }
      return receipt;
    });
  }

  private async applyConfigurationCommand(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/update-profile"
          | "bot/update-notifications"
          | "bot/select-model"
          | "bot/assign-capability";
      }
    >,
    commandFingerprint: string,
    saga?: StoredAssignmentSaga,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
      const existing =
        await transaction.get<StoredConfigurationReceipt>(receiptKey);
      if (existing) {
        return requireMatchingConfigurationReceipt(
          existing,
          commandFingerprint,
          command.commandId,
        );
      }
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
      }
      if (
        saga &&
        (await transaction.get(
          `${ASSIGNMENT_TOMBSTONE_PREFIX}${saga.connectionId}:${saga.generation}`,
        ))
      ) {
        throw new Error("Connection assignment was revoked before admission");
      }
      const revision = current.revision + 1;
      const next: BotSettingsViewV1 =
        command.type === "bot/update-profile"
          ? { ...current, revision, profile: command.profile }
          : command.type === "bot/update-notifications"
            ? { ...current, revision, notifications: command.notifications }
            : command.type === "bot/select-model"
              ? { ...current, revision, model: command.model }
              : {
                  ...current,
                  revision,
                  assignments: [
                    ...current.assignments
                      .filter(
                        (assignment) =>
                          assignment.assignmentId !==
                          command.assignment.assignmentId,
                      )
                      .map((assignment) =>
                        assignment.packageId === command.assignment.packageId &&
                        assignment.capabilityId ===
                          command.assignment.capabilityId
                          ? { ...assignment, state: "unavailable" as const }
                          : assignment,
                      ),
                    { ...command.assignment, state: "enabled" },
                  ],
                };
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision,
        status: "applied",
      };
      await transaction.put({
        [BOT_CONFIGURATION_KEY]: next,
        [receiptKey]: { commandFingerprint, receipt },
      });
      if (
        command.type === "bot/assign-capability" &&
        command.assignment.connectionId
      ) {
        await transaction.put(
          `${ASSIGNMENT_GENERATION_PREFIX}${command.assignment.connectionId}`,
          command.commandId,
        );
      }
      if (saga) {
        await transaction.put(`${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`, {
          ...saga,
          phase: "committed",
          deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
          receipt,
        } satisfies StoredAssignmentSaga);
        await this.refreshRecoveryAlarm(transaction);
      }
      return receipt;
    });
  }

  private async reconcileStoredAssignmentSaga(
    identity: BotIdentity,
    commandId: string,
    commandFingerprint?: string,
  ): Promise<void> {
    const key = `${ASSIGNMENT_SAGA_PREFIX}${commandId}`;
    const saga = await this.ctx.storage.get<StoredAssignmentSaga>(key);
    if (!saga) return;
    if (saga.userId !== identity.userId || saga.botId !== identity.botId) {
      throw new Error("Assignment saga does not match its durable identity");
    }
    if (
      commandFingerprint !== undefined &&
      saga.commandFingerprint !== commandFingerprint
    ) {
      throw new Error(
        `Configuration command idempotency key "${commandId}" was reused for a different command`,
      );
    }
    const userConfiguration = this.userConfiguration(identity);
    try {
      await settleAssignmentSaga(saga, {
        acknowledge: (stored) =>
          userConfiguration.acknowledgeConnectionDependency(
            stored.userId,
            stored.connectionId,
            stored.botId,
            stored.generation,
          ),
        compensate: async (stored) => {
          await userConfiguration.compensateConnectionDependency(
            stored.userId,
            stored.connectionId,
            stored.botId,
            stored.generation,
          );
        },
        rejectCommitted: async (stored) => {
          await this.markConnectionUnavailable(
            { userId: stored.userId, botId: stored.botId },
            stored.connectionId,
            {
              id: `assignment-rejected:${stored.generation}`,
              expectedGeneration: stored.generation,
            },
          );
        },
      });
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredAssignmentSaga>(key);
        if (
          current?.generation === saga.generation &&
          current.phase === saga.phase
        ) {
          await transaction.delete(key);
        }
        await this.refreshRecoveryAlarm(transaction);
      });
    } catch (error) {
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredAssignmentSaga>(key);
        if (current?.generation === saga.generation) {
          await transaction.put(key, {
            ...current,
            deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
          } satisfies StoredAssignmentSaga);
        }
        await this.refreshRecoveryAlarm(transaction);
      });
      throw error;
    }
  }

  private async refreshRecoveryAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    const [activeRunId, sagas] = await Promise.all([
      transaction.get<string>(ACTIVE_RUN_KEY),
      transaction.list<StoredAssignmentSaga>({
        prefix: ASSIGNMENT_SAGA_PREFIX,
      }),
    ]);
    const deadlines = [...sagas.values()].map((saga) => saga.deadlineAt);
    if (activeRunId) deadlines.push(Date.now() + RECOVERY_ALARM_DELAY_MS);
    if (deadlines.length === 0) await transaction.deleteAlarm();
    else await transaction.setAlarm(Math.min(...deadlines));
  }

  async markConnectionUnavailable(
    identity: BotIdentity,
    connectionId: string,
    compensation?: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale"> {
    await this.ensureBotSettings(identity);
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = compensation
        ? `${ASSIGNMENT_COMPENSATION_PREFIX}${compensation.id}`
        : undefined;
      if (receiptKey) {
        const existing = await transaction.get<"applied" | "stale">(receiptKey);
        if (existing) return existing;
      }
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      const enabled = current.assignments.some(
        (assignment) =>
          assignment.connectionId === connectionId &&
          assignment.state === "enabled",
      );
      if (compensation) {
        await transaction.put(
          `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionId}:${compensation.expectedGeneration}`,
          compensation.id,
        );
      }
      if (compensation && enabled) {
        const generation = await transaction.get<string>(
          `${ASSIGNMENT_GENERATION_PREFIX}${connectionId}`,
        );
        if (generation !== compensation.expectedGeneration) {
          if (receiptKey) await transaction.put(receiptKey, "stale");
          return "stale";
        }
      }
      if (enabled) {
        await transaction.put(BOT_CONFIGURATION_KEY, {
          ...current,
          revision: current.revision + 1,
          assignments: current.assignments.map((assignment) =>
            assignment.connectionId === connectionId
              ? { ...assignment, state: "unavailable" }
              : assignment,
          ),
        } satisfies BotSettingsViewV1);
      }
      if (receiptKey) await transaction.put(receiptKey, "applied");
      return "applied";
    });
  }

  async resolveConfiguration(
    identity: BotIdentity,
  ): Promise<BotExecutionPlanV1> {
    return (await this.resolveExecutionContext(identity)).plan;
  }

  async run(command: OwnedBotTurnCommand): Promise<ClientTurnV1> {
    await this.assertMatchingRunCommand(command);
    await this.recoverActiveRun();
    const replay = await this.completedRunResult(command);
    if (replay) return projectClientTurnV1(replay);
    const admission = await this.acceptRun(command);
    return projectClientTurnV1(
      await this.executeAcceptedRun(
        command,
        admission.previous,
        admission.settings,
      ),
    );
  }

  async reconcileRun(
    identity: BotIdentity,
    runId: string,
  ): Promise<ClientTurnV1> {
    await this.assertIdentity(identity);
    const key = `${RUN_PREFIX}${runId}`;
    const recovery = await this.ctx.storage.transaction(async (transaction) => {
      const run = await transaction.get<StoredRun>(key);
      const activeRunId = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (
        !run ||
        run.status !== "reconciliation-required" ||
        activeRunId !== runId
      ) {
        throw new Error(`run "${runId}" does not require reconciliation`);
      }
      const latest =
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? [];
      const settings =
        run.configurationSnapshot ?? this.initialBotSettings(identity.botId);
      await transaction.put(key, {
        ...run,
        status: "running",
        phase: "executing",
        failure: undefined,
      } satisfies StoredRun);
      await this.refreshRecoveryAlarm(transaction);
      return { run, latest, settings };
    });
    return projectClientTurnV1(
      await this.executeResumedRun(
        identity,
        recovery.run,
        recovery.latest,
        recovery.settings,
      ),
    );
  }

  private async executeAcceptedRun(
    command: OwnedBotTurnCommand,
    previous: SessionEvent[],
    settings: BotSettingsViewV1,
  ): Promise<BotTurnCompletion> {
    this.executingRunId = command.runId;
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        const key = `${RUN_PREFIX}${command.runId}`;
        const run = await transaction.get<StoredRun>(key);
        if (!run || run.status !== "running") {
          throw new Error(`run "${command.runId}" is not resumable`);
        }
        await transaction.put(key, {
          ...run,
          phase: "executing",
        } satisfies StoredRun);
        await this.refreshRecoveryAlarm(transaction);
      });
      const agentPackages = await this.assignedAgentPackages(command, settings);
      const promptParts = [
        `You are ${settings.profile.name}.`,
        settings.profile.label,
        settings.profile.description,
      ].filter((part): part is string => Boolean(part?.trim()));
      const result = await executeBotTurn({
        botId: command.botId,
        command,
        previousEvents: previous,
        memory: memoryPluginConfig(this.env, command),
        persistSessionEvents: (_sessionId, events) =>
          this.persistRunEvents(command.runId, events),
        agentPackages,
        systemPromptSection: promptParts.join("\n\n"),
      });
      const completed = settings.notifications.enabled
        ? {
            ...result,
            notification: this.createNotification(settings, result),
          }
        : result;
      await this.completeRun(command.runId, previous, completed);
      return completed;
    } catch (error) {
      const durableRun = await this.ctx.storage.get<StoredRun>(
        `${RUN_PREFIX}${command.runId}`,
      );
      const events = eventsForFailedRun(durableRun, error);
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      const modelState = latestModelRequestJournalState(events);
      if (
        error instanceof BotTurnReconciliationRequiredError ||
        modelState.status === "unresolved"
      ) {
        await this.requireRunReconciliation(
          command.runId,
          previous,
          events,
          modelState.status === "unresolved"
            ? `Model request "${modelState.request.request.requestId}" has no durable provider outcome`
            : message,
        );
        throw new Error(message);
      }
      await this.failRun(command.runId, previous, events, message);
      throw new Error(message);
    } finally {
      if (this.executingRunId === command.runId) {
        this.executingRunId = undefined;
      }
    }
  }

  private async executeResumedRun(
    identity: BotIdentity,
    run: StoredRun,
    latest: SessionEvent[],
    settings: BotSettingsViewV1,
  ): Promise<BotTurnCompletion> {
    this.executingRunId = run.runId;
    const previous = latest.slice(0, run.previousEventCount ?? 0);
    try {
      const agentPackages = await this.assignedAgentPackages(
        identity,
        settings,
      );
      const promptParts = [
        `You are ${settings.profile.name}.`,
        settings.profile.label,
        settings.profile.description,
      ].filter((part): part is string => Boolean(part?.trim()));
      const result = await executeBotTurn({
        botId: identity.botId,
        command: {
          runId: run.runId,
          sessionId: run.sessionId,
          acceptedAt: run.acceptedAt,
          text: run.input,
        },
        previousEvents: latest,
        memory: memoryPluginConfig(this.env, identity),
        persistSessionEvents: (_sessionId, events) =>
          this.persistRunEvents(run.runId, events),
        agentPackages,
        systemPromptSection: promptParts.join("\n\n"),
        resume: true,
      });
      const durableRun = await this.ctx.storage.get<StoredRun>(
        `${RUN_PREFIX}${run.runId}`,
      );
      if (!durableRun) throw new Error(`run "${run.runId}" was not accepted`);
      const fullResult = {
        ...result,
        events: durableRun.events,
      } satisfies BotTurnCompletion;
      const completed = settings.notifications.enabled
        ? {
            ...fullResult,
            notification: this.createNotification(settings, fullResult),
          }
        : fullResult;
      await this.completeRun(run.runId, previous, completed);
      return completed;
    } catch (error) {
      const durableRun = await this.ctx.storage.get<StoredRun>(
        `${RUN_PREFIX}${run.runId}`,
      );
      const events = durableRun?.events ?? run.events;
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      const modelState = latestModelRequestJournalState(events);
      if (
        error instanceof BotTurnReconciliationRequiredError ||
        modelState.status === "unresolved"
      ) {
        await this.requireRunReconciliation(
          run.runId,
          previous,
          events,
          modelState.status === "unresolved"
            ? `Model request "${modelState.request.request.requestId}" has no durable provider outcome`
            : message,
        );
        throw new Error(message);
      }
      await this.failRun(run.runId, previous, events, message);
      throw new Error(message);
    } finally {
      if (this.executingRunId === run.runId) this.executingRunId = undefined;
    }
  }

  private async assignedAgentPackages(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
  ): Promise<FoundationAgentPackage[]> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await compileFoundationApplication();
    const plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    const readSecret = (name: string) => {
      // SAFETY: Worker secrets are dynamic string bindings not enumerable in Env.
      const value = (this.env as unknown as Record<string, unknown>)[name];
      return typeof value === "string" ? value : undefined;
    };
    return [
      ...createFoundationHostedRuntimePackages(application, {
        userId: identity.userId,
        readSecret,
      }),
      ...(await createFoundationAssignedRuntimePackages(
        application,
        settings,
        plan,
        {
          userId: identity.userId,
          readSecret,
          authorizeConnection: (assignment) =>
            this.authorizeAssignedEffect(identity, assignment),
        },
      )),
    ];
  }

  private async authorizeAssignedEffect(
    identity: BotIdentity,
    admittedAssignment: BotSettingsViewV1["assignments"][number],
  ): Promise<ConnectionView> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await compileFoundationApplication();
    const admittedBot = {
      ...this.initialBotSettings(identity.botId),
      assignments: [admittedAssignment],
    } satisfies BotSettingsViewV1;
    const plan = resolveBotExecutionPlanV1({
      bot: admittedBot,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    const assignment = plan.assignments.find(
      (candidate) =>
        candidate.assignmentId === admittedAssignment.assignmentId &&
        candidate.packageId === admittedAssignment.packageId &&
        candidate.capabilityId === admittedAssignment.capabilityId &&
        candidate.connectionId === admittedAssignment.connectionId &&
        candidate.state === "enabled",
    );
    const connection = user.connections.find(
      (candidate) =>
        candidate.connectionId === assignment?.connectionId &&
        candidate.packageId === admittedAssignment.packageId &&
        candidate.state === "ready",
    );
    if (!connection) throw new Error("Assigned effect is no longer authorized");
    return connection;
  }

  private async completedRunResult(
    command: OwnedBotTurnCommand,
  ): Promise<BotTurnCompletion | undefined> {
    const { runId } = command;
    const run = await this.ctx.storage.get<StoredRun>(`${RUN_PREFIX}${runId}`);
    if (!run) return undefined;
    if (run.commandFingerprint !== botTurnCommandFingerprintV1(command)) {
      throw new Error(
        `Turn idempotency key "${runId}" was reused for a different command`,
      );
    }
    if (run.status !== "completed") {
      throw new Error(
        `run "${runId}" already exists with status ${run.status}`,
      );
    }
    const notification = await this.ctx.storage.get<BotNotificationIntent>(
      `${NOTIFICATION_PREFIX}notification-${runId}`,
    );
    return {
      runId,
      text: run.responseText ?? "",
      events: structuredClone(run.events),
      notification,
    };
  }

  private async assertMatchingRunCommand(
    command: OwnedBotTurnCommand,
  ): Promise<void> {
    const run = await this.ctx.storage.get<StoredRun>(
      `${RUN_PREFIX}${command.runId}`,
    );
    if (
      run &&
      run.commandFingerprint !== botTurnCommandFingerprintV1(command)
    ) {
      throw new Error(
        `Turn idempotency key "${command.runId}" was reused for a different command`,
      );
    }
  }

  async listNotifications(): Promise<BotNotificationIntent[]> {
    const entries = await this.ctx.storage.list<BotNotificationIntent>({
      prefix: NOTIFICATION_PREFIX,
    });
    return [...entries.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async acknowledgeNotification(notificationId: string): Promise<void> {
    await this.ctx.storage.delete(`${NOTIFICATION_PREFIX}${notificationId}`);
  }

  private createNotification(
    settings: BotSettingsViewV1,
    result: BotTurnCompletion,
  ): BotNotificationIntent {
    return {
      notificationId: `notification-${result.runId}`,
      runId: result.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} replied`,
      body: result.text.slice(0, 240),
    };
  }

  async alarm(): Promise<void> {
    if (this.executingRunId || this.assignmentActivities.size > 0) {
      await this.ctx.storage.transaction(async (transaction) => {
        const sagas = await transaction.list<StoredAssignmentSaga>({
          prefix: ASSIGNMENT_SAGA_PREFIX,
        });
        for (const [key, saga] of sagas) {
          await transaction.put(key, {
            ...saga,
            deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
          } satisfies StoredAssignmentSaga);
        }
        await this.refreshRecoveryAlarm(transaction);
      });
      return;
    }
    const sagas = await this.ctx.storage.list<StoredAssignmentSaga>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    for (const saga of sagas.values()) {
      try {
        await this.reconcileStoredAssignmentSaga(
          { userId: saga.userId, botId: saga.botId },
          saga.commandId,
        );
      } catch {
        continue;
      }
    }
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (activeRunId) {
      const [run, identity] = await Promise.all([
        this.ctx.storage.get<StoredRun>(`${RUN_PREFIX}${activeRunId}`),
        this.ctx.storage.get<BotIdentity>(IDENTITY_KEY),
      ]);
      if (run?.status === "reconciliation-required" && identity) {
        await this.reconcileRun(identity, activeRunId);
        return;
      }
    }
    await this.recoverActiveRun();
  }

  async listRuns(
    input: unknown = { schemaVersion: 1 },
  ): Promise<ClientRunListV1> {
    const query = decodeClientRunListQueryV1(input);
    await this.recoverActiveRun();
    const activeRunId = query.before
      ? undefined
      : await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    const indexEntries = await this.ctx.storage.list<string>({
      prefix: RUN_INDEX_PREFIX,
      reverse: true,
      limit: CLIENT_RUN_PAGE_LIMIT + 1,
      ...(query.before?.startsWith(RUN_INDEX_PREFIX)
        ? { end: query.before }
        : {}),
    });
    const candidates = [...indexEntries].map(([cursor, runId]) => ({
      cursor,
      runId,
    }));

    const selected = new Map<string, { cursor?: string; run: ClientRunV1 }>();
    if (activeRunId) {
      const active = await this.ctx.storage.get<StoredRun>(
        `${RUN_PREFIX}${activeRunId}`,
      );
      if (active)
        selected.set(active.runId, { run: projectClientRunV1(active) });
    }
    const available = candidates.slice(0, CLIENT_RUN_PAGE_LIMIT);
    let stoppedEarly = false;
    for (const candidate of available) {
      if (selected.has(candidate.runId)) {
        const current = selected.get(candidate.runId)!;
        selected.set(candidate.runId, { ...current, cursor: candidate.cursor });
        continue;
      }
      const stored = await this.ctx.storage.get<StoredRun>(
        `${RUN_PREFIX}${candidate.runId}`,
      );
      if (!stored) continue;
      const projected = projectClientRunV1(stored);
      const tentative = [
        ...selected.values(),
        { cursor: candidate.cursor, run: projected },
      ];
      const ordered = tentative
        .map((entry) => entry.run)
        .sort(
          (left, right) =>
            left.admittedAt.localeCompare(right.admittedAt) ||
            left.runId.localeCompare(right.runId),
        );
      const tentativePage = createClientRunListV1(ordered, {
        truncated: true,
        nextCursor: candidate.cursor,
      });
      const isNewestTerminal =
        ![...selected.values()].some(
          (entry) =>
            entry.run.status === "completed" || entry.run.status === "failed",
        ) &&
        (projected.status === "completed" || projected.status === "failed");
      if (
        selected.size >= CLIENT_RUN_PAGE_LIMIT ||
        (!isNewestTerminal &&
          clientRunListWireBytes(tentativePage) > CLIENT_RUN_LIST_MAX_BYTES)
      ) {
        stoppedEarly = true;
        break;
      }
      selected.set(stored.runId, { cursor: candidate.cursor, run: projected });
    }
    const orderedEntries = [...selected.values()].sort(
      (left, right) =>
        left.run.admittedAt.localeCompare(right.run.admittedAt) ||
        left.run.runId.localeCompare(right.run.runId),
    );
    const oldestCursor = orderedEntries.find((entry) => entry.cursor)?.cursor;
    const truncated = stoppedEarly || candidates.length > CLIENT_RUN_PAGE_LIMIT;
    const page = createClientRunListV1(
      orderedEntries.map((entry) => entry.run),
      truncated && oldestCursor
        ? { truncated: true, nextCursor: oldestCursor }
        : { truncated: false },
    );
    if (clientRunListWireBytes(page) > CLIENT_RUN_LIST_MAX_BYTES) {
      throw new Error("required run projections exceed the wire byte limit");
    }
    return page;
  }

  async lookupRun(input: unknown): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    const run = await this.ctx.storage.get<StoredRun>(
      `${RUN_PREFIX}${query.runId}`,
    );
    if (run && run.runId !== query.runId) {
      throw new Error("stored run does not match its lookup key");
    }
    return projectClientRunLookupV1(run);
  }

  async fenceRunAdmission(input: unknown): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return this.ctx.storage.transaction(async (transaction) => {
      const run = await transaction.get<StoredRun>(
        `${RUN_PREFIX}${query.runId}`,
      );
      if (run && run.runId !== query.runId) {
        throw new Error("stored run does not match its lookup key");
      }
      if (!run) {
        await transaction.put(
          `${RUN_ADMISSION_FENCE_PREFIX}${query.runId}`,
          true,
        );
      }
      return projectClientRunLookupV1(run);
    });
  }

  private initialBotSettings(
    botId: string,
    model?: BotSettingsViewV1["model"],
  ): BotSettingsViewV1 {
    return initializeBotSettingsV1(botId, model);
  }

  private userConfiguration(identity: BotIdentity): {
    readConfiguration(input: {
      schemaVersion: 1;
      userId: string;
    }): Promise<UserSettingsViewV1>;
    getConnection(
      userId: string,
      connectionId: string,
    ): Promise<ConnectionView | undefined>;
    claimConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
      requirement: ConnectionDependencyRequirementV1,
    ): Promise<boolean>;
    acknowledgeConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
    compensateConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
    ): Promise<boolean>;
  } {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
      getConnection(input: unknown): Promise<ConnectionView | undefined>;
      claimConnectionDependency(input: unknown): Promise<boolean>;
      acknowledgeConnectionDependency(input: unknown): Promise<boolean>;
      compensateConnectionDependency(input: unknown): Promise<boolean>;
    };
    return {
      readConfiguration: (input) => rpc.readConfiguration(input),
      getConnection: (userId, connectionId) =>
        rpc.getConnection({ schemaVersion: 1, userId, connectionId }),
      claimConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
        requirement,
      ) =>
        rpc.claimConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
          requirement,
        }),
      acknowledgeConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
      ) =>
        rpc.acknowledgeConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
      compensateConnectionDependency: (
        userId,
        connectionId,
        botId,
        generation,
      ) =>
        rpc.compensateConnectionDependency({
          schemaVersion: 1,
          userId,
          connectionId,
          botId,
          generation,
        }),
    };
  }

  private async ensureBotSettings(
    identity: BotIdentity,
  ): Promise<BotSettingsViewV1> {
    const existing = await this.ctx.storage.get<BotSettingsViewV1>(
      BOT_CONFIGURATION_KEY,
    );
    if (existing) return existing;
    const [durableIdentity, latestEvents, activeRun, legacyRuns] =
      await Promise.all([
        this.ctx.storage.get<BotIdentity>(IDENTITY_KEY),
        this.ctx.storage.get<SessionEvent[]>(LATEST_EVENTS_KEY),
        this.ctx.storage.get<string>(ACTIVE_RUN_KEY),
        this.ctx.storage.list<StoredRun>({ prefix: RUN_PREFIX, limit: 1 }),
      ]);
    const existedBeforeConfiguration = Boolean(
      durableIdentity || latestEvents?.length || activeRun || legacyRuns.size,
    );
    await this.assertIdentity(identity);
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const initial = this.initialBotSettings(
      identity.botId,
      existedBeforeConfiguration ? undefined : user.newBotModelTemplate,
    );
    return this.ctx.storage.transaction(async (transaction) => {
      const concurrent = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (concurrent) return concurrent;
      await transaction.put(BOT_CONFIGURATION_KEY, initial);
      return initial;
    });
  }

  private async resolveExecutionContext(identity: BotIdentity): Promise<{
    settings: BotSettingsViewV1;
    user: UserSettingsViewV1;
    plan: BotExecutionPlanV1;
  }> {
    let settings = await this.ensureBotSettings(identity);
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await compileFoundationApplication();
    let plan = resolveBotExecutionPlanV1({
      bot: settings,
      user,
      packages: application.packages.map((pkg) => ({
        packageId: pkg.id,
        version: pkg.version,
        capabilities: pkg.manifest.configuration?.capabilities ?? [],
        connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
      })),
    });
    const changed = settings.assignments.some(
      (assignment, index) =>
        assignment.state !== plan.assignments[index]?.state,
    );
    if (changed) {
      settings = await this.ctx.storage.transaction(async (transaction) => {
        const current =
          (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
          settings;
        if (current.revision !== settings.revision) return current;
        const next = {
          ...current,
          revision: current.revision + 1,
          assignments: plan.assignments,
        } satisfies BotSettingsViewV1;
        await transaction.put(BOT_CONFIGURATION_KEY, next);
        return next;
      });
      plan = {
        ...plan,
        revision: settings.revision,
        assignments: settings.assignments,
      };
    }
    return { settings, user, plan };
  }

  private async assertIdentity(identity: BotIdentity): Promise<void> {
    const existing = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (
      existing &&
      (existing.userId !== identity.userId || existing.botId !== identity.botId)
    ) {
      throw new Error("Bot authority does not match its durable identity");
    }
    if (!existing) await this.ctx.storage.put(IDENTITY_KEY, identity);
  }

  private async acceptRun(
    command: OwnedBotTurnCommand,
  ): Promise<{ previous: SessionEvent[]; settings: BotSettingsViewV1 }> {
    const fenceKey = `${RUN_ADMISSION_FENCE_PREFIX}${command.runId}`;
    if (await this.ctx.storage.get(fenceKey)) {
      throw new Error(`run "${command.runId}" admission was fenced`);
    }
    const context = await this.resolveExecutionContext(command);
    const settings = {
      ...context.settings,
      assignments: context.plan.assignments,
    } satisfies BotSettingsViewV1;
    const key = `${RUN_PREFIX}${command.runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredRun>(key);
      if (existing) {
        if (
          existing.commandFingerprint !== botTurnCommandFingerprintV1(command)
        ) {
          throw new Error(
            `Turn idempotency key "${command.runId}" was reused for a different command`,
          );
        }
        if (existing.status === "completed") {
          throw new Error(`run "${command.runId}" already completed`);
        }
        throw new Error(`run "${command.runId}" already exists`);
      }
      if (await transaction.get(fenceKey)) {
        throw new Error(`run "${command.runId}" admission was fenced`);
      }
      const identity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        identity &&
        (identity.userId !== command.userId || identity.botId !== command.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      if (await transaction.get(ACTIVE_RUN_KEY)) {
        throw new Error("bot already has an active run");
      }
      const latestEvents =
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? [];
      const admittedSettings =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        settings;
      await transaction.put({
        [key]: {
          runId: command.runId,
          commandFingerprint: botTurnCommandFingerprintV1(command),
          sessionId: command.sessionId,
          acceptedAt: command.acceptedAt,
          input: command.text,
          events: [],
          status: "running",
          phase: "admitted",
          configurationSnapshot: structuredClone(admittedSettings),
          previousEventCount: latestEvents.length,
        } satisfies StoredRun,
        [runIndexKey(command.acceptedAt, command.runId)]: command.runId,
        [ACTIVE_RUN_KEY]: command.runId,
        [IDENTITY_KEY]: identity ?? {
          userId: command.userId,
          botId: command.botId,
        },
      });
      await this.refreshRecoveryAlarm(transaction);
      return { previous: latestEvents, settings: admittedSettings };
    });
  }

  private async persistRunEvents(
    runId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const durableEvents = events.filter(
      (event) => event.type !== "session/disposed",
    );
    if (durableEvents.length === 0) return;
    const key = `${RUN_PREFIX}${runId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const run = await transaction.get<StoredRun>(key);
      if (!run) throw new Error(`run "${runId}" was not accepted`);
      const latest =
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? [];
      for (const [index, event] of durableEvents.entries()) {
        if (event.seq !== latest.length + index) {
          throw new Error(
            "Bot session persistence received non-contiguous events",
          );
        }
      }
      await transaction.put({
        [key]: {
          ...run,
          events: [...run.events, ...structuredClone(durableEvents)],
        } satisfies StoredRun,
        [LATEST_EVENTS_KEY]: [...latest, ...structuredClone(durableEvents)],
      });
    });
  }

  private async completeRun(
    runId: string,
    previous: SessionEvent[],
    result: BotTurnCompletion,
  ): Promise<void> {
    const key = `${RUN_PREFIX}${runId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      await completeStoredRun(
        transaction,
        {
          run: key,
          activeRun: ACTIVE_RUN_KEY,
          latestEvents: LATEST_EVENTS_KEY,
          notificationPrefix: NOTIFICATION_PREFIX,
        },
        runId,
        previous,
        result,
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async failRun(
    runId: string,
    previous: SessionEvent[],
    events: SessionEvent[],
    failure: string,
  ): Promise<void> {
    const key = `${RUN_PREFIX}${runId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      await failStoredRun(
        transaction,
        {
          run: key,
          activeRun: ACTIVE_RUN_KEY,
          latestEvents: LATEST_EVENTS_KEY,
          notificationPrefix: NOTIFICATION_PREFIX,
        },
        runId,
        previous,
        events,
        failure,
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async requireRunReconciliation(
    runId: string,
    previous: SessionEvent[],
    events: SessionEvent[],
    failure: string,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await requireStoredRunReconciliation(
        transaction,
        {
          run: `${RUN_PREFIX}${runId}`,
          activeRun: ACTIVE_RUN_KEY,
          latestEvents: LATEST_EVENTS_KEY,
          notificationPrefix: NOTIFICATION_PREFIX,
        },
        runId,
        previous,
        events,
        failure,
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async recoverActiveRun(): Promise<void> {
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (!activeRunId || activeRunId === this.executingRunId) return;
    const durableIdentity =
      await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    const key = `${RUN_PREFIX}${activeRunId}`;
    const recovery = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (!current || current === this.executingRunId) return undefined;
      const run = await transaction.get<StoredRun>(key);
      if (run?.status === "reconciliation-required") {
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (!run || run.status !== "running") {
        await transaction.delete(ACTIVE_RUN_KEY);
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      const latest =
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? [];
      const plan = planBotRunRecovery(run, latest);
      if (plan.kind === "complete") {
        if (!run.configurationSnapshot) {
          throw new Error(`run "${run.runId}" has no configuration snapshot`);
        }
        if (run.previousEventCount === undefined) {
          throw new Error(`run "${run.runId}" has no previous event count`);
        }
        const result = {
          runId: run.runId,
          text: plan.responseText,
          events: run.events,
        } satisfies BotTurnCompletion;
        const completed = run.configurationSnapshot.notifications.enabled
          ? {
              ...result,
              notification: this.createNotification(
                run.configurationSnapshot,
                result,
              ),
            }
          : result;
        await completeStoredRun(
          transaction,
          {
            run: key,
            activeRun: ACTIVE_RUN_KEY,
            latestEvents: LATEST_EVENTS_KEY,
            notificationPrefix: NOTIFICATION_PREFIX,
          },
          run.runId,
          latest.slice(0, run.previousEventCount),
          completed,
        );
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "fail") {
        await transaction.put({
          [key]: {
            ...run,
            status: "failed",
            failure: plan.failure,
          } satisfies StoredRun,
        });
        await transaction.delete(ACTIVE_RUN_KEY);
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "restart") {
        const settings =
          run.configurationSnapshot ??
          this.initialBotSettings(durableIdentity?.botId ?? "default");
        await transaction.put({
          [key]: {
            ...run,
            events: [],
            phase: "admitted",
          } satisfies StoredRun,
          [LATEST_EVENTS_KEY]: plan.previous,
        });
        await this.refreshRecoveryAlarm(transaction);
        return {
          kind: "restart" as const,
          run,
          previous: plan.previous,
          settings,
        };
      }
      if (plan.kind === "resume") {
        const settings =
          run.configurationSnapshot ??
          this.initialBotSettings(durableIdentity?.botId ?? "default");
        await transaction.put(key, {
          ...run,
          phase: "executing",
        } satisfies StoredRun);
        await this.refreshRecoveryAlarm(transaction);
        return { kind: "resume" as const, run, latest, settings };
      }
      await transaction.put({
        [key]: {
          ...run,
          events: [...run.events, ...plan.repairs],
          status: "reconciliation-required",
          phase: "reconciliation-required",
          failure:
            "Execution outcome requires reconciliation before it can resume",
        } satisfies StoredRun,
        [LATEST_EVENTS_KEY]: [...latest, ...plan.repairs],
      });
      await this.refreshRecoveryAlarm(transaction);
      return undefined;
    });
    if (!recovery) return;
    if (!durableIdentity) throw new Error("Bot identity is unavailable");
    if (recovery.kind === "resume") {
      await this.executeResumedRun(
        durableIdentity,
        recovery.run,
        recovery.latest,
        recovery.settings,
      );
      return;
    }
    await this.executeAcceptedRun(
      {
        userId: durableIdentity.userId,
        botId: durableIdentity.botId,
        runId: recovery.run.runId,
        sessionId: recovery.run.sessionId,
        acceptedAt: recovery.run.acceptedAt,
        text: recovery.run.input,
      },
      recovery.previous,
      recovery.settings,
    );
  }
}

export function createShellBotBackendContribution(
  host: ShellBotBackendHost,
): ShellBotBackendContribution {
  return new ShellBotBackendContribution(host);
}

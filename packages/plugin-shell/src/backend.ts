import {
  type AgentEffectAdmission,
  decodeSessionEvent,
  type PersistSessionEvents,
  type SessionEvent,
  validateToolOccurrenceJournal,
} from "@frockbot/agent-core";
import type { Plugin } from "cordis";
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
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import type { BotResidentExecution } from "./backend-execution.js";
import {
  requireStoredAssignmentSaga,
  type StoredAssignmentSaga,
} from "./backend-assignment.js";
import {
  cancelStoredRun,
  completeStoredRun,
  failStoredRun,
  requireStoredRunReconciliation,
} from "./backend-completion.js";
import { BotTurnReconciliationRequiredError } from "./backend-runner.js";
import {
  eventsForFailedRun,
  latestModelRequestJournalState,
  planBotRunRecovery,
  planStoppedRunRecovery,
} from "./backend-recovery.js";
import {
  CLIENT_RUN_LIST_MAX_BYTES,
  CLIENT_RUN_PAGE_LIMIT,
  clientRunListWireBytes,
  createClientRunListV1,
  createClientRunStopReceiptV1,
  decodeClientRunLookupQueryV1,
  decodeClientRunListQueryV1,
  decodeClientRunStopCommandV1,
  projectClientRunLookupV1,
  projectClientRunV1,
  projectClientTurnV1,
  type ClientRunLookupV1,
  type ClientRunListV1,
  type ClientRunStopReceiptV1,
  type ClientRunV1,
  type ClientTurnV1,
} from "./run-protocol.js";
import {
  botStopCommandFingerprintV1,
  botTurnCommandFingerprintV1,
  requireStoredRunV1,
  type BotNotificationIntent,
  type BotTurnCommand,
  type BotTurnCompletion,
  type StoredRun,
  type StoredRunStatus,
} from "./backend-contracts.js";

const RUN_PREFIX = "run:";
const RUN_INDEX_PREFIX = "run-index:";
const RUN_ADMISSION_FENCE_PREFIX = "run-admission-fence:";
const ACTIVE_RUN_KEY = "active-run";
const LATEST_EVENTS_KEY = "latest-events";
const IDENTITY_KEY = "identity";
const BOT_CONFIGURATION_KEY = "bot-configuration";
const RUNTIME_PROJECTION_KEY = "runtime-projection";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
const ASSIGNMENT_GENERATION_PREFIX = "assignment-generation:";
const ASSIGNMENT_COMPENSATION_PREFIX = "assignment-compensation:";
const ASSIGNMENT_TOMBSTONE_PREFIX = "assignment-tombstone:";
const ASSIGNMENT_SAGA_PREFIX = "assignment-saga:";
const NOTIFICATION_PREFIX = "notification:";
const STOP_RECEIPT_PREFIX = "stop-receipt:";
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

/** Durable idempotency receipt for one exact Stop command. */
interface StoredStopReceipt {
  schemaVersion: 1;
  commandFingerprint: string;
  commandId: string;
  runId: string;
  stopRequestedAt: string;
}

function isTerminalStoredRunStatus(status: StoredRunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export interface StoredRuntimeProjection {
  schemaVersion: 1;
  desiredGeneration: number;
  status: "pending" | "applied" | "failed";
  appliedGeneration?: number;
  failedGeneration?: number;
  failure?: string;
}

class BotRuntimeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotRuntimeProjectionError";
  }
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
  SPRITES_TOKEN?: string;
}

export interface ShellBotBackendHost {
  state: DurableObjectState;
  env: BotStateEnv;
  execution: BotResidentExecution;
  compileApplication?: typeof compileFoundationApplication;
}

function optionalStoredRun(input: unknown): StoredRun | undefined {
  return input === undefined ? undefined : requireStoredRunV1(input);
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
  private readonly compileApplication: typeof compileFoundationApplication;
  private readonly execution: BotResidentExecution;
  private executingRunId: string | undefined;
  private readonly assignmentActivities = new Map<string, AssignmentActivity>();

  constructor(host: ShellBotBackendHost) {
    this.ctx = host.state;
    this.env = host.env;
    this.compileApplication =
      host.compileApplication ?? compileFoundationApplication;
    this.execution = host.execution;
  }

  async materializeSettings(
    identity: BotIdentity,
    initial: { name: string; model?: BotSettingsViewV1["model"] },
  ): Promise<BotSettingsViewV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        durableIdentity &&
        (durableIdentity.userId !== identity.userId ||
          durableIdentity.botId !== identity.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      const existing = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (existing) return existing;
      const settings = {
        ...this.initialBotSettings(identity.botId, initial.model),
        profile: { name: initial.name },
      } satisfies BotSettingsViewV1;
      await transaction.put({
        [IDENTITY_KEY]: durableIdentity ?? identity,
        [BOT_CONFIGURATION_KEY]: settings,
        [RUNTIME_PROJECTION_KEY]: {
          schemaVersion: 1,
          desiredGeneration: settings.revision,
          status: "pending",
        } satisfies StoredRuntimeProjection,
      });
      await this.refreshRecoveryAlarm(transaction);
      return settings;
    });
  }

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    const settings = await this.ensureBotSettings(identity);
    if (settings.assignments.length === 0) return settings;
    const [user, application] = await Promise.all([
      this.userConfiguration(identity).readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      }),
      this.compileApplication(),
    ]);
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
    return { ...settings, assignments: plan.assignments };
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
    command: Extract<ConfigurationCommandV1, { botId: string }>,
    commandFingerprint: string,
  ): Promise<OperationReceiptV1> {
    const settings = await this.ensureBotSettings(identity);
    const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
    const existing =
      await this.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
    if (existing) {
      const receipt = requireMatchingConfigurationReceipt(
        existing,
        commandFingerprint,
        command.commandId,
      );
      if (
        command.type === "bot/assign-capability" ||
        command.type === "bot/replace-capability" ||
        command.type === "bot/unassign-capability"
      ) {
        try {
          await this.reconcileStoredAssignmentSaga(
            identity,
            command.commandId,
            commandFingerprint,
          );
        } catch {
          // The durable accepted receipt remains replayable while recovery is
          // retrying; alarm reconciliation owns eventual settlement.
        }
        const pending = await this.ctx.storage.get<unknown>(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
        );
        if (pending !== undefined) {
          const saga = requireStoredAssignmentSaga(pending);
          if (saga.commandFingerprint !== commandFingerprint) {
            throw new Error(
              `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
            );
          }
          return saga.acceptedReceipt;
        }
      }
      return receipt;
    }
    if (command.expectedRevision !== settings.revision) {
      throw new ConfigurationConflictError(settings.revision);
    }
    if (
      command.type !== "bot/assign-capability" &&
      command.type !== "bot/replace-capability" &&
      command.type !== "bot/unassign-capability"
    ) {
      return this.applySimpleConfigurationCommand(
        identity,
        command,
        commandFingerprint,
      );
    }
    return this.executeAssignmentCommand(identity, command, commandFingerprint);
  }

  private async applySimpleConfigurationCommand(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/update-profile"
          | "bot/update-notifications"
          | "bot/select-model";
      }
    >,
    commandFingerprint: string,
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
      if (current.assignmentOperations.length > 0) {
        throw new Error("An Assignment operation is still retrying");
      }
      const revision = current.revision + 1;
      const next: BotSettingsViewV1 =
        command.type === "bot/update-profile"
          ? { ...current, revision, profile: command.profile }
          : command.type === "bot/update-notifications"
            ? { ...current, revision, notifications: command.notifications }
            : { ...current, revision, model: command.model };
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision,
        status: "applied",
      };
      await transaction.put({
        [BOT_CONFIGURATION_KEY]: next,
        [receiptKey]: { commandFingerprint, receipt },
        [RUNTIME_PROJECTION_KEY]: {
          schemaVersion: 1,
          desiredGeneration: revision,
          status: "pending",
        } satisfies StoredRuntimeProjection,
      });
      await this.refreshRecoveryAlarm(transaction);
      return receipt;
    });
  }

  private async assignmentRequirement(
    identity: BotIdentity,
    assignment: Omit<BotSettingsViewV1["assignments"][number], "state">,
  ): Promise<
    | {
        user: UserSettingsViewV1;
        requirement?: ConnectionDependencyRequirementV1;
      }
    | { failure: string }
  > {
    const [user, application] = await Promise.all([
      this.userConfiguration(identity).readConfiguration({
        schemaVersion: 1,
        userId: identity.userId,
      }),
      this.compileApplication(),
    ]);
    const packages = application.packages.map((pkg) => ({
      packageId: pkg.id,
      version: pkg.version,
      capabilities: pkg.manifest.configuration?.capabilities ?? [],
      connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
    }));
    const failure = capabilityAssignmentFailureV1({
      assignment,
      user,
      packages,
    });
    if (failure) return { failure };
    if (!assignment.connectionId) return { user };
    const installation = user.packages.find(
      (pkg) =>
        pkg.packageId === assignment.packageId && pkg.state === "installed",
    );
    const pkg = application.packages.find(
      (candidate) =>
        candidate.id === assignment.packageId &&
        candidate.version === installation?.version,
    );
    const capability = pkg?.manifest.configuration?.capabilities.find(
      (candidate) => candidate.id === assignment.capabilityId,
    );
    if (!installation || !pkg || !capability) {
      return {
        failure: "Capability assignment policy changed during validation",
      };
    }
    return {
      user,
      requirement: {
        schemaVersion: 1,
        packageId: pkg.id,
        packageVersion: pkg.version,
        capabilityId: capability.id,
        connectionTypeIds: [...capability.connectionTypes],
      },
    };
  }

  private async executeAssignmentCommand(
    identity: BotIdentity,
    command: Extract<
      ConfigurationCommandV1,
      {
        type:
          | "bot/assign-capability"
          | "bot/replace-capability"
          | "bot/unassign-capability";
      }
    >,
    commandFingerprint: string,
  ): Promise<OperationReceiptV1> {
    try {
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
    } catch (error) {
      const pending = await this.ctx.storage.get<unknown>(
        `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
      );
      if (pending === undefined) throw error;
      const saga = requireStoredAssignmentSaga(pending);
      if (saga.commandFingerprint !== commandFingerprint) throw error;
      return saga.acceptedReceipt;
    }
    const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
    const receipt =
      await this.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
    if (receipt) {
      return requireMatchingConfigurationReceipt(
        receipt,
        commandFingerprint,
        command.commandId,
      );
    }
    const pending = await this.ctx.storage.get<unknown>(
      `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
    );
    if (pending !== undefined) {
      const saga = requireStoredAssignmentSaga(pending);
      if (saga.commandFingerprint !== commandFingerprint) {
        throw new Error(
          `Configuration command idempotency key "${command.commandId}" was reused for a different command`,
        );
      }
      return saga.acceptedReceipt;
    }
    const current = await this.ensureBotSettings(identity);
    const assignmentId =
      command.type === "bot/unassign-capability"
        ? command.assignmentId
        : command.assignment.assignmentId;
    const previous = current.assignments.find(
      (assignment) => assignment.assignmentId === assignmentId,
    );
    if (command.type === "bot/assign-capability" && previous) {
      return this.rejectAssignmentCommand(
        identity,
        command.commandId,
        commandFingerprint,
        `Assignment "${assignmentId}" already exists; use Replace`,
      );
    }
    if (command.type !== "bot/assign-capability" && !previous) {
      return this.rejectAssignmentCommand(
        identity,
        command.commandId,
        commandFingerprint,
        `Assignment "${assignmentId}" does not exist`,
      );
    }
    let targetRequirement: ConnectionDependencyRequirementV1 | undefined;
    if (command.type !== "bot/unassign-capability") {
      const validation = await this.assignmentRequirement(
        identity,
        command.assignment,
      );
      if ("failure" in validation) {
        return this.rejectAssignmentCommand(
          identity,
          command.commandId,
          commandFingerprint,
          validation.failure,
        );
      }
      targetRequirement = validation.requirement;
    }
    const previousGeneration = previous?.connectionId
      ? await this.ctx.storage.get<string>(
          `${ASSIGNMENT_GENERATION_PREFIX}${previous.assignmentId}`,
        )
      : undefined;
    const operation =
      command.type === "bot/assign-capability"
        ? "assigning"
        : command.type === "bot/replace-capability"
          ? "replacing"
          : "unassigning";
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredAssignmentSaga>(
        `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
      );
      if (existing) return;
      const durable =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (durable.revision !== command.expectedRevision) {
        throw new ConfigurationConflictError(durable.revision);
      }
      if (durable.assignmentOperations.length > 0) {
        throw new Error("Another Assignment operation is already pending");
      }
      const target =
        command.type === "bot/unassign-capability"
          ? undefined
          : structuredClone(command.assignment);
      const phase =
        operation === "unassigning"
          ? "releasing"
          : target?.connectionId
            ? "claiming"
            : "committing";
      const acceptedReceipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: command.commandId,
        revision: durable.revision,
        status: "pending",
      };
      const saga: StoredAssignmentSaga = {
        schemaVersion: 1,
        commandId: command.commandId,
        commandFingerprint,
        userId: identity.userId,
        botId: identity.botId,
        operation,
        assignmentId,
        generation: command.commandId,
        phase,
        target,
        targetRequirement,
        previous: previous ? structuredClone(previous) : undefined,
        previousGeneration,
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
        acceptedReceipt,
      };
      await transaction.put({
        [`${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`]: saga,
        [BOT_CONFIGURATION_KEY]: {
          ...durable,
          assignmentOperations: [
            {
              commandId: command.commandId,
              kind: operation,
              assignmentId,
              state: "pending",
              target,
            },
          ],
        } satisfies BotSettingsViewV1,
      });
      await this.refreshRecoveryAlarm(transaction);
    });
    try {
      await this.reconcileStoredAssignmentSaga(
        identity,
        command.commandId,
        commandFingerprint,
      );
    } catch {
      const pending = requireStoredAssignmentSaga(
        await this.ctx.storage.get<unknown>(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
        ),
      );
      return pending.acceptedReceipt;
    }
    const completed =
      await this.ctx.storage.get<StoredConfigurationReceipt>(receiptKey);
    if (!completed) {
      const pending = requireStoredAssignmentSaga(
        await this.ctx.storage.get<unknown>(
          `${ASSIGNMENT_SAGA_PREFIX}${command.commandId}`,
        ),
      );
      return pending.acceptedReceipt;
    }
    return requireMatchingConfigurationReceipt(
      completed,
      commandFingerprint,
      command.commandId,
    );
  }

  private async rejectAssignmentCommand(
    identity: BotIdentity,
    commandId: string,
    commandFingerprint: string,
    failure: string,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId,
        revision: current.revision,
        status: "rejected",
        failure,
      };
      await transaction.put(`${CONFIGURATION_RECEIPT_PREFIX}${commandId}`, {
        commandFingerprint,
        receipt,
      } satisfies StoredConfigurationReceipt);
      return receipt;
    });
  }

  private async dependencyResult(
    identity: BotIdentity,
    saga: StoredAssignmentSaga,
    action: "claim" | "read" | "acknowledge" | "release" | "reconcile",
    target: "new" | "old",
  ): Promise<import("@frockbot/connection-core").ConnectionDependencyResultV1> {
    const connectionId =
      target === "new"
        ? saga.target?.connectionId
        : saga.previous?.connectionId;
    const generation =
      target === "new" ? saga.generation : saga.previousGeneration;
    if (!connectionId) {
      return { schemaVersion: 1, status: "released" };
    }
    if (!generation) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        failure: `Assignment "${saga.assignmentId}" dependency generation is unavailable`,
      };
    }
    const packageId =
      target === "new" ? saga.target?.packageId : saga.previous?.packageId;
    if (!packageId) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        failure: `Assignment "${saga.assignmentId}" Package identity is unavailable`,
      };
    }
    const base = {
      schemaVersion: 1 as const,
      operationId: `${saga.commandId}:${target}`,
      userId: identity.userId,
      packageId,
      connectionId,
      botId: identity.botId,
      generation,
    };
    return this.userConfiguration(identity).executeConnectionDependency(
      action === "claim"
        ? { ...base, action, requirement: saga.targetRequirement! }
        : { ...base, action },
    );
  }

  private async rejectPendingAssignmentSaga(
    saga: StoredAssignmentSaga,
    failure: string,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const settings = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (!settings) throw new Error("Bot settings are unavailable");
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: saga.commandId,
        revision: settings.revision,
        status: "rejected",
        failure,
      };
      await transaction.put({
        [BOT_CONFIGURATION_KEY]: {
          ...settings,
          assignmentOperations: settings.assignmentOperations.filter(
            (operation) => operation.commandId !== saga.commandId,
          ),
        } satisfies BotSettingsViewV1,
        [`${CONFIGURATION_RECEIPT_PREFIX}${saga.commandId}`]: {
          commandFingerprint: saga.commandFingerprint,
          receipt,
        } satisfies StoredConfigurationReceipt,
      });
      await transaction.delete(`${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`);
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async persistSaga(
    saga: StoredAssignmentSaga,
    patch: Partial<StoredAssignmentSaga>,
    retrying = false,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`;
      const current = await transaction.get<StoredAssignmentSaga>(key);
      if (!current || current.generation !== saga.generation) return;
      await transaction.put(key, {
        ...current,
        ...patch,
        deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
      } satisfies StoredAssignmentSaga);
      if (retrying) {
        const settings = await transaction.get<BotSettingsViewV1>(
          BOT_CONFIGURATION_KEY,
        );
        if (settings) {
          await transaction.put(BOT_CONFIGURATION_KEY, {
            ...settings,
            assignmentOperations: settings.assignmentOperations.map(
              (operation) =>
                operation.commandId === saga.commandId
                  ? { ...operation, state: "retrying" as const }
                  : operation,
            ),
          } satisfies BotSettingsViewV1);
        }
      }
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async commitAssignmentSaga(
    saga: StoredAssignmentSaga,
  ): Promise<OperationReceiptV1> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = (await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      ))!;
      const existing = await transaction.get<StoredConfigurationReceipt>(
        `${CONFIGURATION_RECEIPT_PREFIX}${saga.commandId}`,
      );
      if (existing) return existing.receipt;
      const revision = current.revision + 1;
      const assignments =
        saga.operation === "unassigning"
          ? current.assignments.filter(
              (assignment) => assignment.assignmentId !== saga.assignmentId,
            )
          : [
              ...current.assignments.filter(
                (assignment) => assignment.assignmentId !== saga.assignmentId,
              ),
              { ...saga.target!, state: "enabled" as const },
            ];
      const receipt: OperationReceiptV1 = {
        schemaVersion: 1,
        commandId: saga.commandId,
        revision,
        status: "applied",
      };
      await transaction.put({
        [BOT_CONFIGURATION_KEY]: {
          ...current,
          revision,
          assignments,
        } satisfies BotSettingsViewV1,
        [`${CONFIGURATION_RECEIPT_PREFIX}${saga.commandId}`]: {
          commandFingerprint: saga.commandFingerprint,
          receipt,
        } satisfies StoredConfigurationReceipt,
        [RUNTIME_PROJECTION_KEY]: {
          schemaVersion: 1,
          desiredGeneration: revision,
          status: "pending",
        } satisfies StoredRuntimeProjection,
      });
      if (saga.target?.connectionId) {
        await transaction.put(
          `${ASSIGNMENT_GENERATION_PREFIX}${saga.assignmentId}`,
          saga.generation,
        );
      }
      return receipt;
    });
  }

  private async markSagaAssignmentUnavailable(
    saga: StoredAssignmentSaga,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const settings = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (!settings) return;
      await transaction.put(BOT_CONFIGURATION_KEY, {
        ...settings,
        assignments: settings.assignments.map((assignment) =>
          assignment.assignmentId === saga.assignmentId
            ? { ...assignment, state: "unavailable" as const }
            : assignment,
        ),
      } satisfies BotSettingsViewV1);
    });
  }

  private async finishAssignmentSaga(
    saga: StoredAssignmentSaga,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `${ASSIGNMENT_SAGA_PREFIX}${saga.commandId}`;
      const current = await transaction.get<StoredAssignmentSaga>(key);
      if (current?.generation !== saga.generation) return;
      const settings = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      if (settings) {
        await transaction.put(BOT_CONFIGURATION_KEY, {
          ...settings,
          assignmentOperations: settings.assignmentOperations.filter(
            (operation) => operation.commandId !== saga.commandId,
          ),
        } satisfies BotSettingsViewV1);
      }
      await transaction.delete(key);
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async reconcileStoredAssignmentSaga(
    identity: BotIdentity,
    commandId: string,
    commandFingerprint?: string,
  ): Promise<void> {
    const key = `${ASSIGNMENT_SAGA_PREFIX}${commandId}`;
    const storedSaga = await this.ctx.storage.get<unknown>(key);
    let saga =
      storedSaga === undefined
        ? undefined
        : requireStoredAssignmentSaga(storedSaga);
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
    try {
      for (let step = 0; step < 8 && saga; step += 1) {
        if (saga.phase === "claiming") {
          if (!saga.claimDispatched) {
            await this.persistSaga(saga, { claimDispatched: true });
            saga = { ...saga, claimDispatched: true };
          }
          let result = await this.dependencyResult(
            identity,
            saga,
            saga.claimDispatched ? "read" : "claim",
            "new",
          );
          if (result.status === "absent") {
            result = await this.dependencyResult(
              identity,
              saga,
              "claim",
              "new",
            );
          }
          if (result.status === "pending" || result.status === "unavailable") {
            if (result.status === "pending") {
              await this.dependencyResult(identity, saga, "reconcile", "new");
            }
            await this.persistSaga(saga, {}, true);
            return;
          }
          if (result.status !== "claimed" && result.status !== "acknowledged") {
            await this.rejectPendingAssignmentSaga(
              saga,
              ("failure" in result ? result.failure : undefined) ??
                "Connection dependency claim rejected",
            );
            return;
          }
          await this.persistSaga(saga, { phase: "committing" });
          saga = { ...saga, phase: "committing" };
          continue;
        }
        if (saga.phase === "committing") {
          const receipt = await this.commitAssignmentSaga(saga);
          const phase: StoredAssignmentSaga["phase"] | undefined = saga.target
            ?.connectionId
            ? "acknowledging"
            : saga.previous?.connectionId
              ? "releasing"
              : undefined;
          if (!phase) {
            await this.finishAssignmentSaga({ ...saga, receipt });
            return;
          }
          await this.persistSaga(saga, { phase, receipt });
          saga = { ...saga, phase, receipt };
          continue;
        }
        if (saga.phase === "acknowledging") {
          if (!saga.acknowledgeDispatched) {
            await this.persistSaga(saga, { acknowledgeDispatched: true });
            saga = { ...saga, acknowledgeDispatched: true };
          }
          let result = await this.dependencyResult(
            identity,
            saga,
            "read",
            "new",
          );
          if (result.status === "claimed") {
            result = await this.dependencyResult(
              identity,
              saga,
              "acknowledge",
              "new",
            );
          }
          if (result.status === "pending" || result.status === "unavailable") {
            if (result.status === "pending") {
              await this.dependencyResult(identity, saga, "reconcile", "new");
            }
            await this.persistSaga(saga, {}, true);
            return;
          }
          if (result.status !== "acknowledged") {
            if (result.status === "rejected" || result.status === "absent") {
              await this.markSagaAssignmentUnavailable(saga);
              if (!saga.previous?.connectionId) {
                await this.finishAssignmentSaga(saga);
                return;
              }
              await this.persistSaga(saga, { phase: "releasing" });
              saga = { ...saga, phase: "releasing" };
              continue;
            }
            throw new Error(
              ("failure" in result ? result.failure : undefined) ??
                "Connection dependency acknowledgement rejected",
            );
          }
          if (!saga.previous?.connectionId) {
            await this.finishAssignmentSaga(saga);
            return;
          }
          await this.persistSaga(saga, { phase: "releasing" });
          saga = { ...saga, phase: "releasing" };
          continue;
        }
        if (!saga.previous?.connectionId) {
          if (saga.operation === "unassigning")
            await this.commitAssignmentSaga(saga);
          await this.finishAssignmentSaga(saga);
          return;
        }
        if (!saga.releaseDispatched) {
          await this.persistSaga(saga, { releaseDispatched: true });
          saga = { ...saga, releaseDispatched: true };
        }
        let result = await this.dependencyResult(identity, saga, "read", "old");
        if (result.status === "claimed" || result.status === "acknowledged") {
          result = await this.dependencyResult(
            identity,
            saga,
            "release",
            "old",
          );
        }
        if (result.status === "pending" || result.status === "unavailable") {
          if (result.status === "pending") {
            await this.dependencyResult(identity, saga, "reconcile", "old");
          }
          await this.persistSaga(saga, {}, true);
          return;
        }
        if (result.status !== "released" && result.status !== "absent") {
          throw new Error(
            ("failure" in result ? result.failure : undefined) ??
              "Connection dependency release rejected",
          );
        }
        if (saga.operation === "unassigning")
          await this.commitAssignmentSaga(saga);
        await this.finishAssignmentSaga(saga);
        return;
      }
    } catch (error) {
      await this.persistSaga(saga, {}, true);
      throw error;
    }
  }

  private async refreshRecoveryAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    const [activeRunId, sagas, projection] = await Promise.all([
      transaction.get<string>(ACTIVE_RUN_KEY),
      transaction.list<unknown>({
        prefix: ASSIGNMENT_SAGA_PREFIX,
      }),
      transaction.get<StoredRuntimeProjection>(RUNTIME_PROJECTION_KEY),
    ]);
    const deadlines = [...sagas.values()].map(
      (stored) => requireStoredAssignmentSaga(stored).deadlineAt,
    );
    if (
      activeRunId ||
      projection?.status === "pending" ||
      projection?.status === "failed"
    ) {
      deadlines.push(Date.now() + RECOVERY_ALARM_DELAY_MS);
    }
    if (deadlines.length === 0) await transaction.deleteAlarm();
    else await transaction.setAlarm(Math.min(...deadlines));
  }

  async markConnectionUnavailable(
    identity: BotIdentity,
    connectionId: string,
    compensation: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale"> {
    await this.ensureBotSettings(identity);
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${ASSIGNMENT_COMPENSATION_PREFIX}${compensation.id}`;
      const existing = await transaction.get<"applied" | "stale">(receiptKey);
      if (existing) return existing;
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      let matchingAssignmentId: string | undefined;
      for (const assignment of current.assignments) {
        if (
          assignment.connectionId !== connectionId ||
          assignment.state !== "enabled"
        ) {
          continue;
        }
        const generation = await transaction.get<string>(
          `${ASSIGNMENT_GENERATION_PREFIX}${assignment.assignmentId}`,
        );
        if (generation === compensation.expectedGeneration) {
          matchingAssignmentId = assignment.assignmentId;
          break;
        }
      }
      await transaction.put(
        `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionId}:${compensation.expectedGeneration}`,
        compensation.id,
      );
      if (!matchingAssignmentId) {
        await transaction.put(receiptKey, "stale");
        return "stale";
      }
      if (matchingAssignmentId) {
        const revision = current.revision + 1;
        await transaction.put({
          [BOT_CONFIGURATION_KEY]: {
            ...current,
            revision,
            assignments: current.assignments.map((assignment) =>
              assignment.assignmentId === matchingAssignmentId
                ? { ...assignment, state: "unavailable" }
                : assignment,
            ),
          } satisfies BotSettingsViewV1,
          [RUNTIME_PROJECTION_KEY]: {
            schemaVersion: 1,
            desiredGeneration: revision,
            status: "pending",
          } satisfies StoredRuntimeProjection,
        });
        await this.refreshRecoveryAlarm(transaction);
      }
      await transaction.put(receiptKey, "applied");
      return "applied";
    });
  }

  async resolveConfiguration(
    identity: BotIdentity,
  ): Promise<BotExecutionPlanV1> {
    return (await this.resolveExecutionContext(identity)).plan;
  }

  async readRuntimeProjection(): Promise<StoredRuntimeProjection> {
    const projection = await this.ctx.storage.get<StoredRuntimeProjection>(
      RUNTIME_PROJECTION_KEY,
    );
    if (!projection) throw new Error("Bot runtime projection is unavailable");
    return structuredClone(projection);
  }

  private async reconcileRuntimeProjection(
    identity: BotIdentity,
  ): Promise<void> {
    if (await this.ctx.storage.get<string>(ACTIVE_RUN_KEY)) return;
    const settings = await this.ensureBotSettings(identity);
    await this.projectRuntime(identity, settings, true);
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

  /**
   * Durably records Stop intent and an idempotency receipt before signalling
   * the resident Agent. The acknowledged projection reports the run's current
   * durable state and never claims terminal cancellation.
   */
  async stopRun(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunStopReceiptV1> {
    const command = decodeClientRunStopCommandV1(input);
    await this.validateIdentity(identity);
    const commandFingerprint = botStopCommandFingerprintV1({
      userId: identity.userId,
      botId: identity.botId,
      commandId: command.commandId,
      runId: command.runId,
    });
    const key = `${RUN_PREFIX}${command.runId}`;
    const receiptKey = `${STOP_RECEIPT_PREFIX}${command.commandId}`;
    const admitted = await this.ctx.storage.transaction(async (transaction) => {
      const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        durableIdentity &&
        (durableIdentity.userId !== identity.userId ||
          durableIdentity.botId !== identity.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      const existing = await transaction.get<StoredStopReceipt>(receiptKey);
      if (existing && existing.commandFingerprint !== commandFingerprint) {
        throw new Error(
          `Stop idempotency key "${command.commandId}" was reused for a different command`,
        );
      }
      const run = optionalStoredRun(await transaction.get<unknown>(key));
      if (!run) throw new Error(`run "${command.runId}" was not admitted`);
      if (existing) return run;
      if (
        isTerminalStoredRunStatus(run.status) ||
        run.events.some((event) => event.type === "turn/end")
      ) {
        throw new Error(`run "${command.runId}" is already terminal`);
      }
      const stopRequestedAt = run.stopRequestedAt ?? new Date().toISOString();
      const stopped = requireStoredRunV1({
        ...run,
        stopRequestedAt,
      } satisfies StoredRun);
      await transaction.put({
        [key]: structuredClone(stopped),
        [receiptKey]: {
          schemaVersion: 1,
          commandFingerprint,
          commandId: command.commandId,
          runId: command.runId,
          stopRequestedAt,
        } satisfies StoredStopReceipt,
      });
      await this.refreshRecoveryAlarm(transaction);
      return stopped;
    });
    // The Agent signal is advisory and always follows the durable intent.
    await this.execution.cancel({
      botId: identity.botId,
      sessionId: admitted.sessionId,
      runId: command.runId,
      reason: "user",
    });
    const current =
      optionalStoredRun(await this.ctx.storage.get<unknown>(key)) ?? admitted;
    return createClientRunStopReceiptV1(command, projectClientRunV1(current));
  }

  async reconcileRun(
    identity: BotIdentity,
    runId: string,
  ): Promise<ClientTurnV1> {
    await this.assertIdentity(identity);
    const key = `${RUN_PREFIX}${runId}`;
    const recovery = await this.ctx.storage.transaction(async (transaction) => {
      const run = optionalStoredRun(await transaction.get<unknown>(key));
      const activeRunId = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (
        !run ||
        run.status !== "reconciliation-required" ||
        activeRunId !== runId
      ) {
        throw new Error(`run "${runId}" does not require reconciliation`);
      }
      const latest = (
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? []
      ).map(decodeSessionEvent);
      const settings = run.configurationSnapshot;
      // Retrieval is itself reconciliation. Keep that durable state visible
      // until the original effect is settled or remains explicitly unresolved.
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
        const run = optionalStoredRun(await transaction.get<unknown>(key));
        if (!run || run.status !== "running") {
          throw new Error(`run "${command.runId}" is not resumable`);
        }
        await transaction.put(key, {
          ...run,
          phase: "executing",
        } satisfies StoredRun);
        await this.refreshRecoveryAlarm(transaction);
      });
      await this.projectRuntime(command, settings, false);
      const result = await this.execution.execute({
        botId: command.botId,
        command,
        previousEvents: previous,
        persistSessionEvents: async (_sessionId, events) => {
          await this.persistRunEvents(command.runId, events);
        },
        beforeStart: () => this.activateAdmittedRun(command.runId, previous),
        admitEffect: (effect) =>
          this.admitRunEffect(
            { userId: command.userId, botId: command.botId },
            command.runId,
            command.sessionId,
            effect,
          ),
      });
      const completed = settings.notifications.enabled
        ? {
            ...result,
            notification: this.createNotification(settings, result),
          }
        : result;
      const settlement = await this.completeRun(
        command.runId,
        previous,
        completed,
      );
      if (settlement === "cancelled") throw new Error("Bot turn was cancelled");
      return completed;
    } catch (error) {
      if (error instanceof BotRuntimeProjectionError) throw error;
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      const stoppedSettlement = await this.settleStoppedRunFailure(
        command.runId,
        message,
      );
      if (stoppedSettlement !== "not-stopped") throw new Error(message);
      const durableRun = optionalStoredRun(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${command.runId}`),
      );
      const events = eventsForFailedRun(durableRun, error);
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
    requireStoredRunV1(run);
    const previous = latest.slice(0, run.previousEventCount);
    try {
      await this.projectRuntime(identity, settings, false);
      const result = await this.execution.execute({
        botId: identity.botId,
        command: {
          runId: run.runId,
          sessionId: run.sessionId,
          acceptedAt: run.acceptedAt,
          text: run.input,
        },
        previousEvents: latest,
        persistSessionEvents: this.runPersistence(run, identity),
        beforeStart: () => this.activateReconciliationRun(run.runId),
        admitEffect: (effect) =>
          this.admitRunEffect(identity, run.runId, run.sessionId, effect),
        resume: true,
      });
      const durableRun = optionalStoredRun(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${run.runId}`),
      );
      if (!durableRun) throw new Error(`run "${run.runId}" was not accepted`);
      const fullResult = {
        ...result,
        events: durableRun.events,
      } satisfies BotTurnCompletion;
      if (durableRun.stopRequestedAt) {
        // The reconciled outcome is journaled; a stopped run never completes.
        await this.cancelRun(run.runId, previous, durableRun.events);
        return { ...fullResult, text: "" };
      }
      const completed = settings.notifications.enabled
        ? {
            ...fullResult,
            notification: this.createNotification(settings, fullResult),
          }
        : fullResult;
      const settlement = await this.completeRun(run.runId, previous, completed);
      if (settlement === "cancelled") throw new Error("Bot turn was cancelled");
      return completed;
    } catch (error) {
      if (error instanceof BotRuntimeProjectionError) throw error;
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      const stoppedSettlement = await this.settleStoppedRunFailure(
        run.runId,
        message,
      );
      if (stoppedSettlement !== "not-stopped") throw new Error(message);
      const durableRun = optionalStoredRun(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${run.runId}`),
      );
      const events = durableRun?.events ?? run.events;
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

  private async projectRuntime(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
    commitDesired: boolean,
  ): Promise<void> {
    try {
      const [user, application] = await Promise.all([
        this.userConfiguration(identity).readConfiguration({
          schemaVersion: 1,
          userId: identity.userId,
        }),
        this.compileApplication(),
      ]);
      const executionPlan = resolveBotExecutionPlanV1({
        bot: settings,
        user,
        packages: application.packages.map((pkg) => ({
          packageId: pkg.id,
          version: pkg.version,
          capabilities: pkg.manifest.configuration?.capabilities ?? [],
          connectionTypes: pkg.manifest.configuration?.connectionTypes ?? [],
        })),
      });
      const prompt = [
        `You are ${settings.profile.name}.`,
        settings.profile.label,
        settings.profile.description,
      ]
        .filter((part): part is string => Boolean(part?.trim()))
        .join("\n\n");
      await this.execution.project({
        generation: settings.revision,
        userId: identity.userId,
        botId: identity.botId,
        settings,
        executionPlan,
        memory: memoryPluginConfig(this.env, identity),
        systemPromptSection: prompt,
        authorizeConnection: (assignment) =>
          this.authorizeAssignedEffect(identity, assignment),
      });
    } catch (error) {
      const failure = (
        error instanceof Error ? error.message : "Runtime projection failed"
      ).slice(0, 1_000);
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredRuntimeProjection>(
          RUNTIME_PROJECTION_KEY,
        );
        if (
          current &&
          (!commitDesired || current.desiredGeneration === settings.revision)
        ) {
          await transaction.put(RUNTIME_PROJECTION_KEY, {
            schemaVersion: 1,
            desiredGeneration: current.desiredGeneration,
            status: "failed",
            failedGeneration: commitDesired ? undefined : settings.revision,
            failure,
          } satisfies StoredRuntimeProjection);
        }
        await this.refreshRecoveryAlarm(transaction);
      });
      throw commitDesired ? error : new BotRuntimeProjectionError(failure);
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredRuntimeProjection>(
        RUNTIME_PROJECTION_KEY,
      );
      if (!current) return;
      if (current.desiredGeneration === settings.revision) {
        await transaction.put(RUNTIME_PROJECTION_KEY, {
          schemaVersion: 1,
          desiredGeneration: settings.revision,
          status: "applied",
          appliedGeneration: settings.revision,
        } satisfies StoredRuntimeProjection);
      } else if (!commitDesired) {
        await transaction.put(RUNTIME_PROJECTION_KEY, {
          schemaVersion: 1,
          desiredGeneration: current.desiredGeneration,
          status: "pending",
        } satisfies StoredRuntimeProjection);
      }
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async authorizeAssignedEffect(
    identity: BotIdentity,
    admittedAssignment: BotSettingsViewV1["assignments"][number],
  ): Promise<ConnectionView> {
    const user = await this.userConfiguration(identity).readConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
    });
    const application = await this.compileApplication();
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
    const run = optionalStoredRun(
      await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${runId}`),
    );
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
    if (run.responseText === undefined) {
      throw new Error(`run "${runId}" has no response text`);
    }
    const notification = await this.ctx.storage.get<BotNotificationIntent>(
      `${NOTIFICATION_PREFIX}${runId}`,
    );
    return {
      runId,
      text: run.responseText,
      events: structuredClone(run.events),
      notification,
    };
  }

  private async assertMatchingRunCommand(
    command: OwnedBotTurnCommand,
  ): Promise<void> {
    const run = optionalStoredRun(
      await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${command.runId}`),
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

  async readDurableIdentity(): Promise<BotIdentity | undefined> {
    return this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
  }

  async validateIdentity(identity: BotIdentity): Promise<void> {
    const existing = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (
      existing &&
      (existing.userId !== identity.userId || existing.botId !== identity.botId)
    ) {
      throw new Error("Bot authority does not match its durable identity");
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
      notificationId: result.runId,
      runId: result.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} replied`,
      body: result.text.slice(0, 240),
    };
  }

  async alarm(): Promise<void> {
    if (this.executingRunId || this.assignmentActivities.size > 0) {
      await this.ctx.storage.transaction(async (transaction) => {
        const sagas = await transaction.list<unknown>({
          prefix: ASSIGNMENT_SAGA_PREFIX,
        });
        for (const [key, stored] of sagas) {
          const saga = requireStoredAssignmentSaga(stored);
          await transaction.put(key, {
            ...saga,
            deadlineAt: Date.now() + ASSIGNMENT_SAGA_DEADLINE_MS,
          } satisfies StoredAssignmentSaga);
        }
        await this.refreshRecoveryAlarm(transaction);
      });
      return;
    }
    const sagas = await this.ctx.storage.list<unknown>({
      prefix: ASSIGNMENT_SAGA_PREFIX,
    });
    for (const stored of sagas.values()) {
      try {
        const saga = requireStoredAssignmentSaga(stored);
        await this.reconcileStoredAssignmentSaga(
          { userId: saga.userId, botId: saga.botId },
          saga.commandId,
        );
      } catch (error) {
        console.error(
          "Assignment saga remains durably scheduled after reconciliation failure",
          error instanceof Error ? error.message : "unknown failure",
        );
      }
    }
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (activeRunId) {
      const [storedRun, identity] = await Promise.all([
        this.ctx.storage.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
        this.ctx.storage.get<BotIdentity>(IDENTITY_KEY),
      ]);
      const run = optionalStoredRun(storedRun);
      if (run?.status === "reconciliation-required" && identity) {
        await this.reconcileRun(identity, activeRunId);
        return;
      }
    }
    await this.recoverActiveRun();
    const [remainingActive, identity] = await Promise.all([
      this.ctx.storage.get<string>(ACTIVE_RUN_KEY),
      this.ctx.storage.get<BotIdentity>(IDENTITY_KEY),
    ]);
    if (!remainingActive && identity) {
      try {
        await this.reconcileRuntimeProjection(identity);
      } catch (error) {
        console.error(
          "Bot runtime projection remains durably scheduled after reconciliation failure",
          error instanceof Error ? error.message : "unknown failure",
        );
      }
    }
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
      const active = optionalStoredRun(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
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
      const stored = optionalStoredRun(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${candidate.runId}`),
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
    const run = optionalStoredRun(
      await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${query.runId}`),
    );
    if (run && run.runId !== query.runId) {
      throw new Error("stored run does not match its lookup key");
    }
    return projectClientRunLookupV1(run);
  }

  async fenceRunAdmission(
    identity: BotIdentity,
    input: unknown,
  ): Promise<ClientRunLookupV1> {
    const query = decodeClientRunLookupQueryV1(input);
    return this.ctx.storage.transaction(async (transaction) => {
      const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        durableIdentity &&
        (durableIdentity.userId !== identity.userId ||
          durableIdentity.botId !== identity.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      const run = optionalStoredRun(
        await transaction.get<unknown>(`${RUN_PREFIX}${query.runId}`),
      );
      if (run && run.runId !== query.runId) {
        throw new Error("stored run does not match its lookup key");
      }
      if (!run) {
        await transaction.put({
          [`${RUN_ADMISSION_FENCE_PREFIX}${query.runId}`]: true,
          [IDENTITY_KEY]: durableIdentity ?? identity,
        });
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
    executeConnectionDependency(
      input: import("@frockbot/connection-core").ConnectionDependencyCommandV1,
    ): Promise<
      import("@frockbot/connection-core").ConnectionDependencyResultV1
    >;
  } {
    const id = this.env.USER_CONFIGURATIONS.idFromName(identity.userId);
    // SAFETY: this namespace is bound to UserConfiguration; generated Worker types do not expose its RPC surface.
    const rpc = this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
      getConnection(input: unknown): Promise<ConnectionView | undefined>;
      executeConnectionDependency(
        input: unknown,
      ): Promise<
        import("@frockbot/connection-core").ConnectionDependencyResultV1
      >;
    };
    return {
      readConfiguration: (input) => rpc.readConfiguration(input),
      getConnection: (userId, connectionId) =>
        rpc.getConnection({ schemaVersion: 1, userId, connectionId }),
      executeConnectionDependency: (input) =>
        rpc.executeConnectionDependency(input),
    };
  }

  private async ensureBotSettings(
    identity: BotIdentity,
  ): Promise<BotSettingsViewV1> {
    await this.validateIdentity(identity);
    const existing = await this.ctx.storage.get<BotSettingsViewV1>(
      BOT_CONFIGURATION_KEY,
    );
    if (!existing)
      throw new Error(`Bot "${identity.botId}" is not materialized`);
    return existing;
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
    const application = await this.compileApplication();
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
        await transaction.put({
          [BOT_CONFIGURATION_KEY]: next,
          [RUNTIME_PROJECTION_KEY]: {
            schemaVersion: 1,
            desiredGeneration: next.revision,
            status: "pending",
          } satisfies StoredRuntimeProjection,
        });
        await this.refreshRecoveryAlarm(transaction);
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
    await this.projectRuntime(command, settings, true);
    const key = `${RUN_PREFIX}${command.runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = optionalStoredRun(await transaction.get<unknown>(key));
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
      const currentSettings = await transaction.get<BotSettingsViewV1>(
        BOT_CONFIGURATION_KEY,
      );
      const projection = await transaction.get<StoredRuntimeProjection>(
        RUNTIME_PROJECTION_KEY,
      );
      if (
        currentSettings?.revision !== settings.revision ||
        projection?.desiredGeneration !== settings.revision ||
        projection.status !== "applied" ||
        projection.appliedGeneration !== settings.revision
      ) {
        throw new Error("Bot runtime projection is not ready for admission");
      }
      const latestEvents = (
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? []
      ).map(decodeSessionEvent);
      const admittedSettings =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        settings;
      const admittedRun = requireStoredRunV1({
        runId: command.runId,
        commandFingerprint: botTurnCommandFingerprintV1(command),
        sessionId: command.sessionId,
        acceptedAt: command.acceptedAt,
        input: command.text,
        events: [],
        effectAdmissions: [],
        status: "running",
        phase: "admitted",
        configurationSnapshot: structuredClone(admittedSettings),
        previousEventCount: latestEvents.length,
      } satisfies StoredRun);
      await transaction.put({
        [key]: admittedRun,
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

  /**
   * Fences initial Agent activation after the exact resident run is
   * addressable. This closes the projection/activation window where Stop can
   * be durable before an Agent exists to receive its advisory signal.
   */
  private async activateAdmittedRun(
    runId: string,
    previous: SessionEvent[],
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = `${RUN_PREFIX}${runId}`;
      const run = optionalStoredRun(await transaction.get<unknown>(key));
      const activeRunId = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (!run || activeRunId !== runId || run.status !== "running") {
        return false;
      }
      if (!run.stopRequestedAt) {
        await transaction.put(key, {
          ...run,
          phase: "executing",
        } satisfies StoredRun);
        return true;
      }
      await cancelStoredRun(
        transaction,
        {
          run: key,
          activeRun: ACTIVE_RUN_KEY,
          latestEvents: LATEST_EVENTS_KEY,
          notificationPrefix: NOTIFICATION_PREFIX,
        },
        runId,
        previous,
        run.events,
      );
      await this.refreshRecoveryAlarm(transaction);
      return false;
    });
  }

  private async activateReconciliationRun(runId: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const [activeRunId, run] = await Promise.all([
        transaction.get<string>(ACTIVE_RUN_KEY),
        transaction.get<unknown>(`${RUN_PREFIX}${runId}`),
      ]);
      const stored = optionalStoredRun(run);
      return (
        activeRunId === runId &&
        stored?.status === "reconciliation-required" &&
        stored.phase === "reconciling"
      );
    });
  }

  /**
   * Linearizes one new external effect against durable Stop. The Agent has
   * already journaled intent; this transaction atomically persists the exact
   * admitted/fenced outcome used before the provider/tool invocation.
   */
  private async admitRunEffect(
    identity: BotIdentity,
    runId: string,
    sessionId: string,
    effect: AgentEffectAdmission,
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const [activeRunId, durableIdentity, candidate] = await Promise.all([
        transaction.get<string>(ACTIVE_RUN_KEY),
        transaction.get<BotIdentity>(IDENTITY_KEY),
        transaction.get<unknown>(`${RUN_PREFIX}${runId}`),
      ]);
      const run = optionalStoredRun(candidate);
      if (
        activeRunId !== runId ||
        !run ||
        run.sessionId !== sessionId ||
        durableIdentity?.userId !== identity.userId ||
        durableIdentity.botId !== identity.botId ||
        !(
          (run.status === "running" && run.phase === "executing") ||
          (run.status === "reconciliation-required" &&
            run.phase === "reconciling")
        )
      ) {
        return false;
      }
      const prior = run.effectAdmissions.find(
        (admission) => admission.effectId === effect.effectId,
      );
      if (prior) {
        if (prior.kind !== effect.kind) {
          throw new Error(
            `effect admission "${effect.effectId}" collides with ${prior.kind}`,
          );
        }
        return prior.outcome === "admitted";
      }
      let matchesIntent = false;
      if (effect.kind === "model") {
        const model = latestModelRequestJournalState(run.events);
        matchesIntent =
          model.status === "unresolved" &&
          model.request.request.requestId === effect.effectId;
      } else {
        try {
          const tool = validateToolOccurrenceJournal(run.events).get(
            effect.effectId,
          );
          matchesIntent = Boolean(tool?.intent && !tool.result);
        } catch {
          matchesIntent = false;
        }
      }
      if (!matchesIntent) {
        throw new Error(
          `effect admission "${effect.effectId}" does not match durable intent`,
        );
      }
      const outcome = run.stopRequestedAt ? "fenced" : "admitted";
      const next = requireStoredRunV1({
        ...run,
        effectAdmissions: [
          ...run.effectAdmissions,
          { kind: effect.kind, effectId: effect.effectId, outcome },
        ],
      } satisfies StoredRun);
      await transaction.put(`${RUN_PREFIX}${runId}`, structuredClone(next));
      return outcome === "admitted";
    });
  }

  /**
   * Persists a run's journal. A run carrying Stop intent is cancelled as soon
   * as its uncertain model effect is durably resolved, so reconciliation
   * journals the original outcome and no further effect is started.
   */
  private runPersistence(
    run: StoredRun,
    identity: BotIdentity,
  ): PersistSessionEvents {
    if (!run.stopRequestedAt) {
      return async (_sessionId, events) => {
        await this.persistRunEvents(run.runId, events);
      };
    }
    let signalled = false;
    return async (_sessionId, events) => {
      const journal = await this.persistRunEvents(run.runId, events);
      if (
        signalled ||
        !journal ||
        latestModelRequestJournalState(journal).status === "unresolved"
      ) {
        return;
      }
      signalled = true;
      await this.execution.cancel({
        botId: identity.botId,
        sessionId: run.sessionId,
        runId: run.runId,
        reason: "user",
      });
    };
  }

  private async persistRunEvents(
    runId: string,
    events: readonly SessionEvent[],
  ): Promise<SessionEvent[] | undefined> {
    const durableEvents = events
      .filter((event) => event.type !== "session/disposed")
      .map(decodeSessionEvent);
    if (durableEvents.length === 0) return undefined;
    const key = `${RUN_PREFIX}${runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const run = optionalStoredRun(await transaction.get<unknown>(key));
      if (!run) throw new Error(`run "${runId}" was not accepted`);
      const latest = (
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? []
      ).map(decodeSessionEvent);
      for (const [index, event] of durableEvents.entries()) {
        if (event.seq !== latest.length + index) {
          throw new Error(
            "Bot session persistence received non-contiguous events",
          );
        }
      }
      const next = requireStoredRunV1({
        ...run,
        events: [...run.events, ...durableEvents],
      } satisfies StoredRun);
      await transaction.put({
        [key]: structuredClone(next),
        [LATEST_EVENTS_KEY]: structuredClone([...latest, ...durableEvents]),
      });
      return next.events;
    });
  }

  private async completeRun(
    runId: string,
    previous: SessionEvent[],
    result: BotTurnCompletion,
  ): Promise<"completed" | "cancelled"> {
    const key = `${RUN_PREFIX}${runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const settlement = await completeStoredRun(
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
      return settlement;
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

  /**
   * Settles a failed stopped run from one exact durable snapshot. This keeps
   * pre-admission journal repair, terminal cancellation, and conservative
   * reconciliation in the same transaction as the Stop classification.
   */
  private async settleStoppedRunFailure(
    runId: string,
    failure: string,
  ): Promise<"not-stopped" | "cancelled" | "reconciliation-required"> {
    const key = `${RUN_PREFIX}${runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const run = optionalStoredRun(await transaction.get<unknown>(key));
      if (!run?.stopRequestedAt) return "not-stopped";
      const latest = (
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? []
      ).map(decodeSessionEvent);
      const stopRecovery = planStoppedRunRecovery(run, latest);
      const keys = {
        run: key,
        activeRun: ACTIVE_RUN_KEY,
        latestEvents: LATEST_EVENTS_KEY,
        notificationPrefix: NOTIFICATION_PREFIX,
      };
      if (stopRecovery.kind === "cancel") {
        await cancelStoredRun(
          transaction,
          keys,
          runId,
          latest.slice(0, run.previousEventCount),
          stopRecovery.events,
        );
        await this.refreshRecoveryAlarm(transaction);
        return "cancelled";
      }
      const modelState = latestModelRequestJournalState(run.events);
      await requireStoredRunReconciliation(
        transaction,
        keys,
        runId,
        latest.slice(0, run.previousEventCount),
        run.events,
        modelState.status === "unresolved"
          ? `Model request "${modelState.request.request.requestId}" has no durable provider outcome`
          : failure,
      );
      await this.refreshRecoveryAlarm(transaction);
      return "reconciliation-required";
    });
  }

  private async cancelRun(
    runId: string,
    previous: SessionEvent[],
    events: SessionEvent[],
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await cancelStoredRun(
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
      const run = optionalStoredRun(await transaction.get<unknown>(key));
      if (run?.status === "reconciliation-required") {
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (!run || run.status !== "running") {
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      const latest = (
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? []
      ).map(decodeSessionEvent);
      const plan = planBotRunRecovery(run, latest);
      if (run.stopRequestedAt) {
        const stopRecovery = planStoppedRunRecovery(run, latest);
        if (stopRecovery.kind === "cancel") {
          await cancelStoredRun(
            transaction,
            {
              run: key,
              activeRun: ACTIVE_RUN_KEY,
              latestEvents: LATEST_EVENTS_KEY,
              notificationPrefix: NOTIFICATION_PREFIX,
            },
            run.runId,
            latest.slice(0, run.previousEventCount),
            stopRecovery.events,
          );
          await this.refreshRecoveryAlarm(transaction);
          return undefined;
        }
      }
      if (plan.kind === "complete") {
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
        await failStoredRun(
          transaction,
          {
            run: key,
            activeRun: ACTIVE_RUN_KEY,
            latestEvents: LATEST_EVENTS_KEY,
            notificationPrefix: NOTIFICATION_PREFIX,
          },
          run.runId,
          latest.slice(0, run.previousEventCount),
          run.events,
          plan.failure,
        );
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "restart") {
        const settings = run.configurationSnapshot;
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
        const settings = run.configurationSnapshot;
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
          phase: "reconciling",
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

export function createShellBotBackendPlugin(
  host: ShellBotBackendHost,
  lifecycle: { mount(value: ShellBotBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createShellBotBackendContribution(host));
}

import { DurableObject } from "cloudflare:workers";
import type { SessionEvent } from "@frockbot/agent-core";
import type { FoundationAgentPackage } from "@frockbot/agent-runtime/runtime";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import {
  ConfigurationConflictError,
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
import type { UserConfiguration } from "@frockbot/plugin-composio/user-configuration";
import { BotTurnExecutionError, executeBotTurn } from "./backend-runner.js";
import { planBotRunRecovery } from "./backend-recovery.js";
import type {
  BotNotificationIntent,
  BotTurnCommand,
  BotTurnResult,
  StoredRun,
} from "./backend-contracts.js";

const RUN_PREFIX = "run:";
const ACTIVE_RUN_KEY = "active-run";
const LATEST_EVENTS_KEY = "latest-events";
const IDENTITY_KEY = "identity";
const BOT_CONFIGURATION_KEY = "bot-configuration";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
const ASSIGNMENT_GENERATION_PREFIX = "assignment-generation:";
const ASSIGNMENT_COMPENSATION_PREFIX = "assignment-compensation:";
const ASSIGNMENT_TOMBSTONE_PREFIX = "assignment-tombstone:";
const LEGACY_ASSIGNMENT_GENERATION = "legacy:any";
const NOTIFICATION_PREFIX = "notification:";
const RECOVERY_ALARM_DELAY_MS = 60_000;

interface BotIdentity {
  userId: string;
  botId: string;
}

export interface OwnedBotTurnCommand extends BotTurnCommand, BotIdentity {}

export interface BotStateEnv {
  MEMORY_FILES: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  USER_CONFIGURATIONS: DurableObjectNamespace<UserConfiguration>;
  COMPOSIO_API_KEY?: string;
  SPRITES_TOKEN?: string;
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

export class BotState extends DurableObject<BotStateEnv> {
  private executingRunId: string | undefined;

  async getSettings(identity: BotIdentity): Promise<BotSettingsViewV1> {
    return this.ensureBotSettings(identity);
  }

  async executeConfiguration(
    identity: BotIdentity,
    command: ConfigurationCommandV1,
  ): Promise<OperationReceiptV1> {
    if (
      command.type !== "bot/update-profile" &&
      command.type !== "bot/update-notifications" &&
      command.type !== "bot/select-model" &&
      command.type !== "bot/assign-capability"
    ) {
      throw new Error("Bot configuration cannot execute a User command");
    }
    if (command.botId !== identity.botId) {
      throw new Error("Bot command does not match its durable identity");
    }
    await this.ensureBotSettings(identity);
    const connectionAssignment =
      command.type === "bot/assign-capability" &&
      command.assignment.connectionId
        ? {
            connectionId: command.assignment.connectionId,
            generation: command.commandId,
          }
        : undefined;
    const userConfiguration = connectionAssignment
      ? this.userConfiguration(identity)
      : undefined;
    if (connectionAssignment) {
      const replay = await this.ctx.storage.transaction(async (transaction) => {
        const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
        const existing = await transaction.get<OperationReceiptV1>(receiptKey);
        if (existing) return existing;
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
        return undefined;
      });
      if (replay) return replay;
    }
    let claimAttempted = false;
    let connectionCommitted = false;
    const receipt = await (async () => {
      try {
        if (connectionAssignment) {
          claimAttempted = true;
          if (
            !(await userConfiguration!.claimConnectionDependency(
              identity.userId,
              connectionAssignment.connectionId,
              identity.botId,
              connectionAssignment.generation,
            ))
          ) {
            throw new Error("Connection assignment is no longer authorized");
          }
        }
        const committed = await this.ctx.storage.transaction(
          async (transaction) => {
            const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
            const existing =
              await transaction.get<OperationReceiptV1>(receiptKey);
            if (existing) return existing;
            const current =
              (await transaction.get<BotSettingsViewV1>(
                BOT_CONFIGURATION_KEY,
              )) ?? this.initialBotSettings(identity.botId);
            if (command.expectedRevision !== current.revision) {
              throw new ConfigurationConflictError(current.revision);
            }
            if (
              connectionAssignment &&
              (await transaction.get(
                `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionAssignment.connectionId}:${connectionAssignment.generation}`,
              ))
            ) {
              throw new Error(
                "Connection assignment was revoked before admission",
              );
            }
            const revision = current.revision + 1;
            const next: BotSettingsViewV1 =
              command.type === "bot/update-profile"
                ? { ...current, revision, profile: command.profile }
                : command.type === "bot/update-notifications"
                  ? {
                      ...current,
                      revision,
                      notifications: command.notifications,
                    }
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
                              assignment.packageId ===
                                command.assignment.packageId &&
                              assignment.capabilityId ===
                                command.assignment.capabilityId
                                ? {
                                    ...assignment,
                                    state: "unavailable" as const,
                                  }
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
              [receiptKey]: receipt,
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
            return receipt;
          },
        );
        connectionCommitted = true;
        return committed;
      } catch (error) {
        if (connectionAssignment && claimAttempted && !connectionCommitted) {
          try {
            await userConfiguration!.compensateConnectionDependency(
              identity.userId,
              connectionAssignment.connectionId,
              identity.botId,
              connectionAssignment.generation,
            );
          } catch (compensationError) {
            throw new AggregateError(
              [error, compensationError],
              "Connection assignment admission and compensation failed",
            );
          }
        }
        throw error;
      }
    })();
    if (connectionAssignment) {
      const acknowledged =
        await userConfiguration!.acknowledgeConnectionDependency(
          identity.userId,
          connectionAssignment.connectionId,
          identity.botId,
          connectionAssignment.generation,
        );
      if (!acknowledged) {
        await this.markConnectionUnavailable(
          identity,
          connectionAssignment.connectionId,
          {
            id: `assignment-rejected:${connectionAssignment.generation}`,
            expectedGeneration: connectionAssignment.generation,
          },
        );
        throw new Error("Connection assignment was revoked during admission");
      }
    }
    return receipt;
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
      if (
        compensation &&
        compensation.expectedGeneration !== LEGACY_ASSIGNMENT_GENERATION
      ) {
        await transaction.put(
          `${ASSIGNMENT_TOMBSTONE_PREFIX}${connectionId}:${compensation.expectedGeneration}`,
          compensation.id,
        );
      }
      if (compensation && enabled) {
        const generation = await transaction.get<string>(
          `${ASSIGNMENT_GENERATION_PREFIX}${connectionId}`,
        );
        if (
          compensation.expectedGeneration !== LEGACY_ASSIGNMENT_GENERATION &&
          generation !== compensation.expectedGeneration
        ) {
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

  async run(command: OwnedBotTurnCommand): Promise<BotTurnResult> {
    await this.recoverActiveRun();
    const replay = await this.completedRunResult(command.runId);
    if (replay) return replay;
    const admission = await this.acceptRun(command);
    return this.executeAcceptedRun(
      command,
      admission.previous,
      admission.settings,
    );
  }

  async reconcileRun(
    identity: BotIdentity,
    runId: string,
  ): Promise<BotTurnResult> {
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
      await transaction.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
      return { run, latest, settings };
    });
    return this.executeResumedRun(
      identity,
      recovery.run,
      recovery.latest,
      recovery.settings,
    );
  }

  private async executeAcceptedRun(
    command: OwnedBotTurnCommand,
    previous: SessionEvent[],
    settings: BotSettingsViewV1,
  ): Promise<BotTurnResult> {
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
        await transaction.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
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
            notification: await this.recordNotification(settings, result),
          }
        : result;
      await this.completeRun(command.runId, previous, completed);
      return completed;
    } catch (error) {
      const events = error instanceof BotTurnExecutionError ? error.events : [];
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
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
  ): Promise<BotTurnResult> {
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
      } satisfies BotTurnResult;
      const completed = settings.notifications.enabled
        ? {
            ...fullResult,
            notification: await this.recordNotification(settings, fullResult),
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
    const user = await this.userConfiguration(identity).read(identity.userId);
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
    const user = await this.userConfiguration(identity).read(identity.userId);
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
    runId: string,
  ): Promise<BotTurnResult | undefined> {
    const run = await this.ctx.storage.get<StoredRun>(`${RUN_PREFIX}${runId}`);
    if (!run) return undefined;
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

  private async recordNotification(
    settings: BotSettingsViewV1,
    result: BotTurnResult,
  ): Promise<BotNotificationIntent> {
    const notification: BotNotificationIntent = {
      notificationId: `notification-${result.runId}`,
      runId: result.runId,
      createdAt: new Date().toISOString(),
      title: `${settings.profile.name} replied`,
      body: result.text.slice(0, 240),
    };
    await this.ctx.storage.put(
      `${NOTIFICATION_PREFIX}${notification.notificationId}`,
      notification,
    );
    return notification;
  }

  async alarm(): Promise<void> {
    if (this.executingRunId) {
      await this.ctx.storage.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
      return;
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

  async listRuns(): Promise<StoredRun[]> {
    await this.recoverActiveRun();
    const entries = await this.ctx.storage.list<StoredRun>({
      prefix: RUN_PREFIX,
    });
    return [...entries.values()].sort(
      (left, right) =>
        left.acceptedAt.localeCompare(right.acceptedAt) ||
        left.runId.localeCompare(right.runId),
    );
  }

  private initialBotSettings(
    botId: string,
    model?: BotSettingsViewV1["model"],
  ): BotSettingsViewV1 {
    return initializeBotSettingsV1(botId, model);
  }

  private userConfiguration(identity: BotIdentity): {
    read(userId: string): Promise<UserSettingsViewV1>;
    getConnection(
      userId: string,
      connectionId: string,
    ): Promise<ConnectionView | undefined>;
    claimConnectionDependency(
      userId: string,
      connectionId: string,
      botId: string,
      generation: string,
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
    return this.env.USER_CONFIGURATIONS.get(id) as unknown as {
      read(userId: string): Promise<UserSettingsViewV1>;
      getConnection(
        userId: string,
        connectionId: string,
      ): Promise<ConnectionView | undefined>;
      claimConnectionDependency(
        userId: string,
        connectionId: string,
        botId: string,
        generation: string,
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
    const user = await this.userConfiguration(identity).read(identity.userId);
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
    const user = await this.userConfiguration(identity).read(identity.userId);
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
    const context = await this.resolveExecutionContext(command);
    const settings = {
      ...context.settings,
      assignments: context.plan.assignments,
    } satisfies BotSettingsViewV1;
    const key = `${RUN_PREFIX}${command.runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredRun>(key);
      if (existing) {
        if (existing.status === "completed") {
          throw new Error(`run "${command.runId}" already completed`);
        }
        throw new Error(`run "${command.runId}" already exists`);
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
          sessionId: command.sessionId,
          acceptedAt: command.acceptedAt,
          input: command.text,
          events: [],
          status: "running",
          phase: "admitted",
          configurationSnapshot: structuredClone(admittedSettings),
          previousEventCount: latestEvents.length,
        } satisfies StoredRun,
        [ACTIVE_RUN_KEY]: command.runId,
        [IDENTITY_KEY]: identity ?? {
          userId: command.userId,
          botId: command.botId,
        },
      });
      await transaction.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
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
    result: BotTurnResult,
  ): Promise<void> {
    const key = `${RUN_PREFIX}${runId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const activeRunId = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (activeRunId !== runId)
        throw new Error(`run "${runId}" is not active`);
      const run = await transaction.get<StoredRun>(key);
      if (!run) throw new Error(`run "${runId}" was not accepted`);
      await transaction.put({
        [key]: {
          ...run,
          events: structuredClone(result.events),
          status: "completed",
          responseText: result.text,
        } satisfies StoredRun,
        [LATEST_EVENTS_KEY]: structuredClone([...previous, ...result.events]),
      });
      await transaction.delete(ACTIVE_RUN_KEY);
      await transaction.deleteAlarm();
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
      const run = await transaction.get<StoredRun>(key);
      if (!run) return;
      await transaction.put({
        [key]: {
          ...run,
          events: structuredClone(events),
          status: "failed",
          failure,
        } satisfies StoredRun,
        [LATEST_EVENTS_KEY]: structuredClone([...previous, ...events]),
      });
      if ((await transaction.get<string>(ACTIVE_RUN_KEY)) === runId) {
        await transaction.delete(ACTIVE_RUN_KEY);
      }
      await transaction.deleteAlarm();
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
        await transaction.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
        return undefined;
      }
      if (!run || run.status !== "running") {
        await transaction.delete(ACTIVE_RUN_KEY);
        await transaction.deleteAlarm();
        return undefined;
      }
      const latest =
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? [];
      const plan = planBotRunRecovery(run, latest);
      if (plan.kind === "complete") {
        await transaction.put({
          [key]: {
            ...run,
            status: "completed",
            responseText: plan.responseText,
          } satisfies StoredRun,
        });
        await transaction.delete(ACTIVE_RUN_KEY);
        await transaction.deleteAlarm();
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
        await transaction.deleteAlarm();
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
        await transaction.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
        return { run, previous: plan.previous, settings };
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
      await transaction.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
      return undefined;
    });
    if (!recovery) return;
    if (!durableIdentity) throw new Error("Bot identity is unavailable");
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

import { DurableObject } from "cloudflare:workers";
import { Session, type SessionEvent } from "@frockbot/agent-core";
import type { FoundationAgentPackage } from "@frockbot/agent-runtime/runtime";
import {
  ConfigurationConflictError,
  type BotExecutionPlanV1,
  type BotSettingsViewV1,
  type ConnectionView,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
} from "@frockbot/configuration-core";
import {
  createComposioRouterPlugin,
  ComposioClient,
} from "@frockbot/plugin-composio";
import composioManifest from "@frockbot/plugin-composio/manifest";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import type { UserConfiguration } from "./user-configuration.js";
import { BotTurnExecutionError, executeBotTurn } from "./bot-runner.js";
import type {
  BotNotificationIntent,
  BotTurnCommand,
  BotTurnResult,
  StoredRun,
} from "./contracts.js";

const RUN_PREFIX = "run:";
const ACTIVE_RUN_KEY = "active-run";
const LATEST_EVENTS_KEY = "latest-events";
const IDENTITY_KEY = "identity";
const BOT_CONFIGURATION_KEY = "bot-configuration";
const CONFIGURATION_RECEIPT_PREFIX = "configuration-receipt:";
const ASSIGNMENT_GENERATION_PREFIX = "assignment-generation:";
const ASSIGNMENT_COMPENSATION_PREFIX = "assignment-compensation:";
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
    await this.assertIdentity(identity);
    return (
      (await this.ctx.storage.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
      this.initialBotSettings(identity.botId)
    );
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
    await this.assertIdentity(identity);
    return this.ctx.storage.transaction(async (transaction) => {
      const receiptKey = `${CONFIGURATION_RECEIPT_PREFIX}${command.commandId}`;
      const existing = await transaction.get<OperationReceiptV1>(receiptKey);
      if (existing) return existing;
      const current =
        (await transaction.get<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
        this.initialBotSettings(identity.botId);
      if (command.expectedRevision !== current.revision) {
        throw new ConfigurationConflictError(current.revision);
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
    });
  }

  async markConnectionUnavailable(
    identity: BotIdentity,
    connectionId: string,
    compensation?: { id: string; expectedGeneration: string },
  ): Promise<"applied" | "stale"> {
    await this.assertIdentity(identity);
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
    const settings = await this.getSettings(identity);
    return {
      schemaVersion: 1,
      botId: identity.botId,
      revision: settings.revision,
      model: settings.model,
      assignments: settings.assignments,
    };
  }

  async run(command: OwnedBotTurnCommand): Promise<BotTurnResult> {
    await this.reconcileInterruptedRun();
    const replay = await this.completedRunResult(command.runId);
    if (replay) return replay;
    const previous = await this.acceptRun(command);
    this.executingRunId = command.runId;
    try {
      const settings = await this.getSettings(command);
      const agentPackages = await this.composioAgentPackages(command, settings);
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

  private async composioAgentPackages(
    identity: BotIdentity,
    settings: BotSettingsViewV1,
  ): Promise<FoundationAgentPackage[]> {
    const assignment = settings.assignments.find(
      (candidate) =>
        candidate.packageId === "composio" &&
        candidate.state === "enabled" &&
        candidate.connectionId,
    );
    if (!assignment?.connectionId) return [];
    const userConfigurationId = this.env.USER_CONFIGURATIONS.idFromName(
      identity.userId,
    );
    // SAFETY: USER_CONFIGURATIONS is bound to UserConfiguration and this is a
    // backend-only RPC projection of its public getConnection method.
    const userConfiguration = this.env.USER_CONFIGURATIONS.get(
      userConfigurationId,
    ) as unknown as {
      getConnection(
        userId: string,
        connectionId: string,
      ): Promise<ConnectionView | undefined>;
    };
    const connection = await userConfiguration.getConnection(
      identity.userId,
      assignment.connectionId,
    );
    if (!connection || connection.state !== "ready") {
      await this.markConnectionUnavailable(identity, assignment.connectionId);
      throw new Error("Assigned Composio Connection is unavailable");
    }
    const connectedAccountId = connection.safeMetadata.connectedAccountId;
    const toolkitSlug = connection.safeMetadata.toolkitSlug;
    if (
      typeof connectedAccountId !== "string" ||
      typeof toolkitSlug !== "string" ||
      !this.env.COMPOSIO_API_KEY
    ) {
      throw new Error("Assigned Composio Connection is misconfigured");
    }
    return [
      {
        specifier: "@frockbot/plugin-composio",
        contributionSpecifier: "@frockbot/plugin-composio/agent",
        manifest: composioManifest,
        plugin: createComposioRouterPlugin({
          client: new ComposioClient({ apiKey: this.env.COMPOSIO_API_KEY }),
          userId: identity.userId,
          connectedAccountId,
          toolkitSlug,
        }),
      },
    ];
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
    await this.reconcileInterruptedRun();
  }

  async listRuns(): Promise<StoredRun[]> {
    await this.reconcileInterruptedRun();
    const entries = await this.ctx.storage.list<StoredRun>({
      prefix: RUN_PREFIX,
    });
    return [...entries.values()].sort(
      (left, right) =>
        left.acceptedAt.localeCompare(right.acceptedAt) ||
        left.runId.localeCompare(right.runId),
    );
  }

  private initialBotSettings(botId: string): BotSettingsViewV1 {
    return {
      schemaVersion: 1,
      botId,
      revision: 0,
      profile: { name: botId === "default" ? "Barebones" : botId },
      notifications: { enabled: false },
      assignments: [],
    };
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
  ): Promise<SessionEvent[]> {
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
      await transaction.put({
        [key]: {
          runId: command.runId,
          sessionId: command.sessionId,
          acceptedAt: command.acceptedAt,
          input: command.text,
          events: [],
          status: "running",
        } satisfies StoredRun,
        [ACTIVE_RUN_KEY]: command.runId,
        [IDENTITY_KEY]: identity ?? {
          userId: command.userId,
          botId: command.botId,
        },
      });
      await transaction.setAlarm(Date.now() + RECOVERY_ALARM_DELAY_MS);
      return latestEvents;
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

  private async reconcileInterruptedRun(): Promise<void> {
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (!activeRunId || activeRunId === this.executingRunId) return;
    const key = `${RUN_PREFIX}${activeRunId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (!current || current === this.executingRunId) return;
      const run = await transaction.get<StoredRun>(key);
      if (run) {
        const latest =
          (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? [];
        const repairs =
          latest.length === 0
            ? []
            : new Session(
                run.sessionId,
                () => {},
                latest,
              ).reconcileInterrupted();
        await transaction.put({
          [key]: {
            ...run,
            events: [...run.events, ...repairs],
            status: "interrupted",
            failure: "Bot execution was interrupted and was not retried",
          } satisfies StoredRun,
          [LATEST_EVENTS_KEY]: [...latest, ...repairs],
        });
      }
      await transaction.delete(ACTIVE_RUN_KEY);
      await transaction.deleteAlarm();
    });
  }
}

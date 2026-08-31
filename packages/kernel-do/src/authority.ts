/// <reference types="@cloudflare/workers-types" />
// Durable Object authority for one Bot: command admission, the append-only
// event log, the resumable execution cursor, idempotency records, cancellation,
// serialization, and durable scheduling. Cloudflare types are the only host
// detail here; everything above them is Package policy behind narrow hooks.
import {
  decodeSessionEvent,
  type NormalizedModelRequest,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import type { CompositionGenerationV1 } from "@frockbot/kernel-composition/generation";
import { DurableCompositionStore } from "./composition-store.js";
import { DurableCompositionFailureLog } from "./composition-failures.js";
import {
  botTurnCommandFingerprintV1,
  storedRunAdmissionV1,
  storedRunTurnTypeV1,
  type BotNotificationIntent,
  type BotTurnCommand,
  type BotTurnCompletion,
  type StoredRunCodecV1,
  type StoredRunV1,
} from "./run-records.js";
import {
  completeStoredRun,
  failStoredRun,
  requireStoredRunReconciliation,
} from "./run-terminal.js";
import {
  eventsForFailedRun,
  latestModelRequestJournalState,
  planBotRunRecovery,
} from "./run-recovery.js";
import {
  BotTurnReconciliationRequiredError,
  BotTurnRecoveryRequiredError,
} from "./turn-errors.js";
import {
  ACTIVE_RUN_KEY,
  IDENTITY_KEY,
  LATEST_EVENTS_KEY,
  MAX_RUN_ADMISSION_FENCES,
  NOTIFICATION_PREFIX,
  RECOVERY_ALARM_DELAY_MS,
  RUN_ADMISSION_FENCE_INDEX_KEY,
  RUN_ADMISSION_FENCE_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  runIndexKey,
  storedRunAdmissionFences,
} from "./storage-keys.js";

export interface BotIdentity {
  userId: string;
  botId: string;
}

export interface OwnedBotTurnCommand extends BotTurnCommand, BotIdentity {}

/** One admitted Turn, handed to the Package that owns the Composition. */
export interface BotTurnExecutionInput<Snapshot> {
  identity: BotIdentity;
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  configurationSnapshot: Snapshot;
  /** The Composition generation pinned to this Turn at admission. */
  compositionGenerationId: string;
  persistSessionEvents(
    sessionId: string,
    events: readonly SessionEvent[],
  ): Promise<void>;
  resume: boolean;
  /** Present when a resumed Turn already has a durable model request. */
  admittedRequest?: NormalizedModelRequest;
}

/**
 * The narrow surface the Bot Durable Object authority consumes from the Package
 * that owns configuration policy, Composition, and notification content. The
 * kernel owns admission, the log, the cursor, idempotency, cancellation, and
 * durable scheduling, and holds no implementation of any of these.
 */
export interface BotDurableAuthorityHooks<Snapshot> {
  /** Configuration snapshot a Turn is admitted under, resolved before admission. */
  resolveAdmissionSnapshot(command: OwnedBotTurnCommand): Promise<Snapshot>;
  /** The first-party generation a Bot with no Composition records starts on. */
  bootstrapComposition(): Promise<CompositionGenerationV1>;
  /** Durable snapshot read inside the admission transaction. */
  admittedSnapshot(
    transaction: DurableObjectTransaction,
    resolved: Snapshot,
  ): Promise<Snapshot>;
  /** Run the admitted Turn on the Package Composition pinned to it. */
  executeTurn(
    input: BotTurnExecutionInput<Snapshot>,
  ): Promise<BotTurnCompletion>;
  /** Notification policy; `undefined` records no notification. */
  notification(
    snapshot: Snapshot,
    result: BotTurnCompletion,
  ): BotNotificationIntent | undefined;
  /** Package deadlines that share this object's single durable alarm. */
  scheduledDeadlines(transaction: DurableObjectTransaction): Promise<number[]>;
  /** True while Package work is in flight and recovery must be deferred. */
  scheduledWorkInFlight(): boolean;
  /** Push Package deadlines out when the alarm fires while work is in flight. */
  deferScheduledWork(transaction: DurableObjectTransaction): Promise<void>;
  /** Settle Package deadlines when the alarm fires idle. */
  settleScheduledWork(): Promise<void>;
}

export interface BotDurableAuthorityOptions<Snapshot> {
  state: DurableObjectState;
  codec: StoredRunCodecV1<Snapshot>;
  hooks: BotDurableAuthorityHooks<Snapshot>;
}

export class BotDurableAuthority<Snapshot> {
  readonly ctx: DurableObjectState;
  private readonly codec: StoredRunCodecV1<Snapshot>;
  private readonly hooks: BotDurableAuthorityHooks<Snapshot>;
  /** Durable Composition generations; every admitted Turn pins the current one. */
  readonly composition: DurableCompositionStore;
  /** Why a generation failed to activate, and whether it is quarantined. */
  readonly compositionFailures: DurableCompositionFailureLog;
  private executingRunId: string | undefined;

  constructor(options: BotDurableAuthorityOptions<Snapshot>) {
    this.ctx = options.state;
    this.codec = options.codec;
    this.hooks = options.hooks;
    this.composition = new DurableCompositionStore({
      state: options.state,
      bootstrap: () => options.hooks.bootstrapComposition(),
    });
    this.compositionFailures = new DurableCompositionFailureLog({
      state: options.state,
    });
  }

  async run(command: OwnedBotTurnCommand): Promise<BotTurnCompletion> {
    await this.assertMatchingRunCommand(command);
    await this.recoverActiveRun();
    const replay = await this.completedRunResult(command);
    if (replay) return replay;
    const admission = await this.acceptRun(command);
    return this.executeAcceptedRun(
      command,
      admission.previous,
      admission.settings,
      admission.compositionGenerationId,
    );
  }

  async reconcileRun(
    identity: BotIdentity,
    runId: string,
  ): Promise<BotTurnCompletion> {
    await this.assertIdentity(identity);
    const key = `${RUN_PREFIX}${runId}`;
    const recovery = await this.ctx.storage.transaction(async (transaction) => {
      const run = this.codec.optional(await transaction.get<unknown>(key));
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
      await transaction.put(key, {
        ...run,
        status: "running",
        phase: "executing",
        failure: undefined,
      } satisfies StoredRunV1<Snapshot>);
      await this.refreshRecoveryAlarm(transaction);
      return { run, latest, settings };
    });
    try {
      return await this.executeResumedRun(
        identity,
        recovery.run,
        recovery.latest,
        recovery.settings,
      );
    } catch (error) {
      const current = this.codec.optional(
        await this.ctx.storage.get<unknown>(key),
      );
      if (current?.status === "reconciliation-required") {
        const previous = recovery.latest.slice(0, current.previousEventCount);
        const failure =
          error instanceof Error ? error.message : "Reconciliation failed";
        await this.failRun(
          runId,
          previous,
          current.events,
          `Reconciliation was explicitly abandoned: ${failure}`,
        );
      }
      throw error;
    }
  }

  private withNotification(
    snapshot: Snapshot,
    result: BotTurnCompletion,
  ): BotTurnCompletion {
    const notification = this.hooks.notification(snapshot, result);
    return notification ? { ...result, notification } : result;
  }

  private async executeAcceptedRun(
    command: OwnedBotTurnCommand,
    previous: SessionEvent[],
    settings: Snapshot,
    compositionGenerationId: string,
  ): Promise<BotTurnCompletion> {
    this.executingRunId = command.runId;
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        const key = `${RUN_PREFIX}${command.runId}`;
        const run = this.codec.optional(await transaction.get<unknown>(key));
        if (!run || run.status !== "running") {
          throw new Error(`run "${command.runId}" is not resumable`);
        }
        await transaction.put(key, {
          ...run,
          phase: "executing",
        } satisfies StoredRunV1<Snapshot>);
        await this.refreshRecoveryAlarm(transaction);
      });
      const result = await this.hooks.executeTurn({
        identity: command,
        command,
        previousEvents: previous,
        configurationSnapshot: settings,
        compositionGenerationId,
        persistSessionEvents: (_sessionId, events) =>
          this.persistRunEvents(command.runId, events),
        resume: false,
      });
      const completed = this.withNotification(settings, result);
      await this.completeRun(command.runId, previous, completed);
      return completed;
    } catch (error) {
      const durableRun = this.codec.optional(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${command.runId}`),
      );
      const events = eventsForFailedRun(durableRun, error);
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      if (error instanceof BotTurnRecoveryRequiredError) {
        await this.deferRunRecovery(command.runId);
        throw new Error(message);
      }
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
    run: StoredRunV1<Snapshot>,
    latest: SessionEvent[],
    settings: Snapshot,
  ): Promise<BotTurnCompletion> {
    this.executingRunId = run.runId;
    this.codec.require(run);
    const previous = latest.slice(0, run.previousEventCount);
    try {
      const modelState = latestModelRequestJournalState(latest);
      const result = await this.hooks.executeTurn({
        identity,
        command: {
          runId: run.runId,
          sessionId: run.sessionId,
          acceptedAt: run.acceptedAt,
          text: run.input,
          // Recovery re-mounts on the recorded turn type, so the resumed Turn
          // sees the same trimmed catalog the evicted one did.
          turnType: storedRunTurnTypeV1(run),
          ...(run.admission?.origin ? { origin: run.admission.origin } : {}),
        },
        previousEvents: latest,
        configurationSnapshot: settings,
        compositionGenerationId: run.compositionGenerationId,
        persistSessionEvents: (_sessionId, events) =>
          this.persistRunEvents(run.runId, events),
        resume: true,
        ...(modelState.status === "completed"
          ? { admittedRequest: modelState.request.request }
          : {}),
      });
      const durableRun = this.codec.optional(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${run.runId}`),
      );
      if (!durableRun) throw new Error(`run "${run.runId}" was not accepted`);
      const fullResult = {
        ...result,
        events: durableRun.events,
      } satisfies BotTurnCompletion;
      const completed = this.withNotification(settings, fullResult);
      await this.completeRun(run.runId, previous, completed);
      return completed;
    } catch (error) {
      const durableRun = this.codec.optional(
        await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${run.runId}`),
      );
      const events = durableRun?.events ?? run.events;
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      if (error instanceof BotTurnRecoveryRequiredError) {
        await this.deferRunRecovery(run.runId);
        throw new Error(message);
      }
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

  private async deferRunRecovery(runId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const run = this.codec.optional(
        await transaction.get<unknown>(`${RUN_PREFIX}${runId}`),
      );
      if (!run || run.status !== "running") {
        throw new Error(`run "${runId}" is not resumable`);
      }
      await transaction.put(`${RUN_PREFIX}${runId}`, {
        ...run,
        phase: "executing",
      } satisfies StoredRunV1<Snapshot>);
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async completedRunResult(
    command: OwnedBotTurnCommand,
  ): Promise<BotTurnCompletion | undefined> {
    const { runId } = command;
    const run = this.codec.optional(
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
    const run = this.codec.optional(
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

  /**
   * Raises a visible failure through the notification channel. Used when a
   * failure has no Turn completion to ride along with — a Composition that
   * failed closed, for instance, whose Turn still succeeds on the last known
   * good and would otherwise report nothing wrong.
   */
  async recordNotification(intent: BotNotificationIntent): Promise<void> {
    await this.ctx.storage.put(
      `${NOTIFICATION_PREFIX}${intent.notificationId}`,
      structuredClone(intent),
    );
  }

  /**
   * Re-pins an admitted, still-running Turn onto the generation it actually
   * ran under. Only fail-closed activation calls this: the Turn was admitted on
   * a generation that would not mount, and the durable record must name the
   * last known good it fell back to rather than the generation that failed.
   */
  async repinRun(
    runId: string,
    compositionGenerationId: string,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = `${RUN_PREFIX}${runId}`;
      const run = this.codec.optional(await transaction.get<unknown>(key));
      if (!run || run.status !== "running") {
        throw new Error(`run "${runId}" is not resumable`);
      }
      if (run.compositionGenerationId === compositionGenerationId) return;
      await transaction.put(key, {
        ...run,
        compositionGenerationId,
      } satisfies StoredRunV1<Snapshot>);
    });
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

  async alarm(): Promise<void> {
    if (this.executingRunId || this.hooks.scheduledWorkInFlight()) {
      await this.ctx.storage.transaction(async (transaction) => {
        await this.hooks.deferScheduledWork(transaction);
        await this.refreshRecoveryAlarm(transaction);
      });
      return;
    }
    await this.hooks.settleScheduledWork();
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (activeRunId) {
      const [storedRun, identity] = await Promise.all([
        this.ctx.storage.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
        this.ctx.storage.get<BotIdentity>(IDENTITY_KEY),
      ]);
      const run = this.codec.optional(storedRun);
      if (run?.status === "reconciliation-required" && identity) return;
    }
    await this.recoverActiveRun();
  }

  /** Active run id, for Package projections of durable run state. */
  async readActiveRunId(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
  }

  /** Durable run record, unchecked against its lookup key. */
  async readStoredRun(
    runId: string,
  ): Promise<StoredRunV1<Snapshot> | undefined> {
    return this.codec.optional(
      await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${runId}`),
    );
  }

  /** Durable run record, checked against the key it was looked up by. */
  async readRun(runId: string): Promise<StoredRunV1<Snapshot> | undefined> {
    const run = await this.readStoredRun(runId);
    if (run && run.runId !== runId) {
      throw new Error("stored run does not match its lookup key");
    }
    return run;
  }

  /** Reverse-ordered admission index page: `[cursor, runId]` entries. */
  async listRunIndex(query: {
    limit: number;
    before?: string;
  }): Promise<Array<{ cursor: string; runId: string }>> {
    const entries = await this.ctx.storage.list<string>({
      prefix: RUN_INDEX_PREFIX,
      reverse: true,
      limit: query.limit,
      ...(query.before?.startsWith(RUN_INDEX_PREFIX)
        ? { end: query.before }
        : {}),
    });
    return [...entries].map(([cursor, runId]) => ({ cursor, runId }));
  }

  async fenceRunAdmission(
    identity: BotIdentity,
    runId: string,
  ): Promise<StoredRunV1<Snapshot> | undefined> {
    return this.ctx.storage.transaction(async (transaction) => {
      const durableIdentity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        durableIdentity &&
        (durableIdentity.userId !== identity.userId ||
          durableIdentity.botId !== identity.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      const run = this.codec.optional(
        await transaction.get<unknown>(`${RUN_PREFIX}${runId}`),
      );
      if (run && run.runId !== runId) {
        throw new Error("stored run does not match its lookup key");
      }
      if (!run) {
        const storedFences = storedRunAdmissionFences(
          await transaction.get<unknown>(RUN_ADMISSION_FENCE_INDEX_KEY),
        );
        if (
          !storedFences.includes(runId) &&
          storedFences.length >= MAX_RUN_ADMISSION_FENCES
        ) {
          throw new Error("Run admission fence capacity reached");
        }
        await transaction.put({
          [RUN_ADMISSION_FENCE_INDEX_KEY]: [
            ...storedFences.filter((fenced) => fenced !== runId),
            runId,
          ],
          [IDENTITY_KEY]: durableIdentity ?? identity,
        });
        await transaction.delete(`${RUN_ADMISSION_FENCE_PREFIX}${runId}`);
      }
      return run;
    });
  }

  async refreshRecoveryAlarm(
    transaction: DurableObjectTransaction,
  ): Promise<void> {
    const [activeRunId, scheduled] = await Promise.all([
      transaction.get<string>(ACTIVE_RUN_KEY),
      this.hooks.scheduledDeadlines(transaction),
    ]);
    const activeRun = activeRunId
      ? this.codec.optional(
          await transaction.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
        )
      : undefined;
    const deadlines = [...scheduled];
    if (
      activeRunId &&
      (!activeRun || activeRun.status !== "reconciliation-required")
    ) {
      deadlines.push(Date.now() + RECOVERY_ALARM_DELAY_MS);
    }
    if (deadlines.length === 0) await transaction.deleteAlarm();
    else await transaction.setAlarm(Math.min(...deadlines));
  }

  async assertIdentity(identity: BotIdentity): Promise<void> {
    const existing = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (
      existing &&
      (existing.userId !== identity.userId || existing.botId !== identity.botId)
    ) {
      throw new Error("Bot authority does not match its durable identity");
    }
    if (!existing) await this.ctx.storage.put(IDENTITY_KEY, identity);
  }

  private async acceptRun(command: OwnedBotTurnCommand): Promise<{
    previous: SessionEvent[];
    settings: Snapshot;
    compositionGenerationId: string;
  }> {
    const fenceKey = `${RUN_ADMISSION_FENCE_PREFIX}${command.runId}`;
    const fences = storedRunAdmissionFences(
      await this.ctx.storage.get<unknown>(RUN_ADMISSION_FENCE_INDEX_KEY),
    );
    if (
      fences.includes(command.runId) ||
      (await this.ctx.storage.get(fenceKey))
    ) {
      throw new Error(`run "${command.runId}" admission was fenced`);
    }
    const settings = await this.hooks.resolveAdmissionSnapshot(command);
    // Materialized before the transaction; the pin itself is read inside it.
    await this.composition.materialize();
    const key = `${RUN_PREFIX}${command.runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const existing = this.codec.optional(await transaction.get<unknown>(key));
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
      const fences = storedRunAdmissionFences(
        await transaction.get<unknown>(RUN_ADMISSION_FENCE_INDEX_KEY),
      );
      if (fences.includes(command.runId) || (await transaction.get(fenceKey))) {
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
      const latestEvents = (
        (await transaction.get<SessionEvent[]>(LATEST_EVENTS_KEY)) ?? []
      ).map(decodeSessionEvent);
      const admittedSettings = await this.hooks.admittedSnapshot(
        transaction,
        settings,
      );
      const pin = await this.composition.pin(transaction);
      const admittedRun = this.codec.require({
        runId: command.runId,
        commandFingerprint: botTurnCommandFingerprintV1(command),
        sessionId: command.sessionId,
        acceptedAt: command.acceptedAt,
        input: command.text,
        events: [],
        effectAdmissions: [],
        status: "running",
        phase: "admitted",
        compositionGenerationId: pin.generationId,
        configurationSnapshot: structuredClone(admittedSettings),
        previousEventCount: latestEvents.length,
        ...storedRunAdmissionV1(command.turnType, command.origin),
      } satisfies StoredRunV1<Snapshot>);
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
      return {
        previous: latestEvents,
        settings: admittedSettings,
        compositionGenerationId: pin.generationId,
      };
    });
  }

  private async persistRunEvents(
    runId: string,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const durableEvents = events
      .filter((event) => event.type !== "session/disposed")
      .map(decodeSessionEvent);
    if (durableEvents.length === 0) return;
    const key = `${RUN_PREFIX}${runId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const run = this.codec.optional(await transaction.get<unknown>(key));
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
      const next = this.codec.require({
        ...run,
        events: [...run.events, ...durableEvents],
      } satisfies StoredRunV1<Snapshot>);
      await transaction.put({
        [key]: structuredClone(next),
        [LATEST_EVENTS_KEY]: structuredClone([...latest, ...durableEvents]),
      });
    });
  }

  private terminalKeys(runId: string) {
    return {
      run: `${RUN_PREFIX}${runId}`,
      activeRun: ACTIVE_RUN_KEY,
      latestEvents: LATEST_EVENTS_KEY,
      notificationPrefix: NOTIFICATION_PREFIX,
    };
  }

  private async completeRun(
    runId: string,
    previous: SessionEvent[],
    result: BotTurnCompletion,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await completeStoredRun(
        this.codec,
        transaction,
        this.terminalKeys(runId),
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
    await this.ctx.storage.transaction(async (transaction) => {
      await failStoredRun(
        this.codec,
        transaction,
        this.terminalKeys(runId),
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
        this.codec,
        transaction,
        this.terminalKeys(runId),
        runId,
        previous,
        events,
        failure,
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  async recoverActiveRun(): Promise<void> {
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (!activeRunId || activeRunId === this.executingRunId) return;
    const durableIdentity =
      await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    const key = `${RUN_PREFIX}${activeRunId}`;
    const recovery = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (!current || current === this.executingRunId) return undefined;
      const run = this.codec.optional(await transaction.get<unknown>(key));
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
      const plan = planBotRunRecovery(run, latest, this.codec);
      if (plan.kind === "complete") {
        const result = {
          runId: run.runId,
          text: plan.responseText,
          events: run.events,
        } satisfies BotTurnCompletion;
        const completed = this.withNotification(
          run.configurationSnapshot,
          result,
        );
        await completeStoredRun(
          this.codec,
          transaction,
          this.terminalKeys(run.runId),
          run.runId,
          latest.slice(0, run.previousEventCount),
          completed,
        );
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "fail") {
        await failStoredRun(
          this.codec,
          transaction,
          this.terminalKeys(run.runId),
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
          } satisfies StoredRunV1<Snapshot>,
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
        } satisfies StoredRunV1<Snapshot>);
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
        } satisfies StoredRunV1<Snapshot>,
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
        turnType: storedRunTurnTypeV1(recovery.run),
        ...(recovery.run.admission?.origin
          ? { origin: recovery.run.admission.origin }
          : {}),
      },
      recovery.previous,
      recovery.settings,
      recovery.run.compositionGenerationId,
    );
  }
}

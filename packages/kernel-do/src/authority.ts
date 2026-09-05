/// <reference types="@cloudflare/workers-types" />
// Durable Object authority for one Bot: command admission, the append-only
// event log, the resumable execution cursor, idempotency records, cancellation,
// serialization, and durable scheduling. Cloudflare types are the only host
// detail here; everything above them is Package policy behind narrow hooks.
import {
  decodeSessionEvent,
  validateToolOccurrenceJournal,
  type NormalizedModelRequest,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import type { CompositionGenerationV1 } from "@frockbot/kernel-composition/generation";
import { DurableCompositionStore } from "./composition-store.js";
import { DurableCompositionFailureLog } from "./composition-failures.js";
import {
  boundedRunFailureV1,
  botTurnCommandFingerprintV1,
  defaultRunLaneV1,
  storedRunAdmissionV1,
  storedRunLaneV1,
  storedRunEventFieldsV2,
  storedRunRecordV2,
  storedRunSubagentRoleV1,
  storedRunTurnTypeV1,
  type BotNotificationIntent,
  type BotTurnCommand,
  type BotTurnCompletion,
  type StoredRunCodecV1,
  type StoredRunV1,
} from "./run-records.js";
import {
  completeStoredRun,
  type TerminalPackageRecords,
  type SupersededPackageRecords,
  type FailedRunNotification,
  failStoredRun,
  requireStoredRunReconciliation,
} from "./run-terminal.js";
import {
  eventsForFailedRun,
  latestModelRequestJournalState,
  latestModelRequestProviderV1,
  planBotRunRecovery,
  type ProviderReconcilesV1,
  repairedSessionLogV1,
  unresolvedModelRequestFailure,
} from "./run-recovery.js";
import { runLivenessV1, STALE_RUNNING_RUN_FAILURE_V1 } from "./run-liveness.js";
import {
  SessionEventLog,
  type SessionEventLogStorage,
} from "./session-event-log.js";
import {
  BotTurnReconciliationRequiredError,
  BotTurnRecoveryRequiredError,
  BotTurnRefusedError,
} from "./turn-errors.js";
import {
  botConversationBaseSessionIdV1,
  ConversationBusyError,
  conversationSessionIdV1,
  decodeConversationRecordV1,
  decodeStoredConversationV1,
  firstConversationV1,
  type ConversationRecordV1,
  type StoredConversationV1,
} from "./conversations.js";
import {
  ACTIVE_RUN_KEY,
  CONVERSATION_INDEX_KEY,
  CONVERSATION_KEY,
  MAX_LISTED_CONVERSATIONS,
  MAX_PENDING_AGENT_RUNS_V1,
  PENDING_AGENT_RUN_PREFIX,
  PENDING_RUN_KEY,
  IDENTITY_KEY,
  LATEST_EVENTS_KEY,
  MAX_RUN_ADMISSION_FENCES,
  NOTIFICATION_PREFIX,
  RECOVERY_ALARM_DELAY_MS,
  RUN_ADMISSION_FENCE_INDEX_KEY,
  RUN_ADMISSION_FENCE_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  pendingAgentRunKey,
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
  /**
   * Notification policy for a Turn that ended `failed`, given the settings the
   * Turn was admitted under and its settled record. `undefined` records none.
   *
   * The snapshot comes off the run itself rather than from a fresh read: a
   * failure settles on paths — recovery after a restart, the stale-run repair —
   * where nothing else has the settings to hand, and `configurationSnapshot` is
   * the durable copy of exactly the ones this Turn ran under.
   */
  failureNotification?(
    snapshot: Snapshot,
    failed: {
      runId: string;
      /** The stored diagnostic. Never shown to a person as it stands. */
      failure: string;
      events: readonly SessionEvent[];
    },
  ): BotNotificationIntent | undefined;
  /**
   * Package records written in the same transaction that settles a Turn, given
   * the settled run and the admission-index cursor it was admitted under. The
   * kernel writes the returned keys without reading them, so the policy that
   * produced them stays entirely in the Package.
   */
  terminalRecords?(input: {
    snapshot: Snapshot;
    run: StoredRunV1<Snapshot>;
    cursor: string;
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>>;
  /** Package deadlines that share this object's single durable alarm. */
  scheduledDeadlines(transaction: DurableObjectTransaction): Promise<number[]>;
  /** True while Package work is in flight and recovery must be deferred. */
  scheduledWorkInFlight(): boolean;
  /** Push Package deadlines out when the alarm fires while work is in flight. */
  deferScheduledWork(transaction: DurableObjectTransaction): Promise<void>;
  /** Settle Package deadlines when the alarm fires idle. */
  settleScheduledWork(): Promise<void>;
  /**
   * Advisory interrupt of the exact Turn named, after the durable intent that
   * justifies it is already written. The reason is an opaque bounded string
   * the kernel records and never reads; a Package that holds no resident Agent
   * needs no implementation, because the durable effect fence stops the Turn
   * either way.
   */
  interruptTurn?(runId: string, reason: string): void;
  /**
   * Package records written in the same transaction that settles a Turn as
   * `superseded`. Same contract as `terminalRecords`: the kernel writes the
   * returned keys without reading them.
   */
  supersededRecords?(input: {
    run: StoredRunV1<Snapshot>;
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>>;
  /**
   * Whether the named provider can be asked what happened to a model request
   * it never answered (ADR 0028).
   *
   * Synchronous and pure, because it is consulted inside the recovery
   * transaction: it answers from what the deployment knows about a provider
   * Package, never by reaching one. Absent means every provider reconciles,
   * which is the behaviour that predates the ADR.
   */
  providerReconciles?: ProviderReconcilesV1;
}

/** What a `turn/end` records when a later user message took a Turn's place. */
export const SUPERSEDED_TURN_REASON_V1 = "superseded by a new user message";

/** How many times a queued Turn retries the object before giving up. */
const MAX_QUEUED_RUN_START_ATTEMPTS = 8;

/**
 * The failure a discarded Turn is settled with when recovery finds it.
 *
 * It is never read by anybody: `failStoredRun` routes a run carrying a Stop or
 * supersede intent to `cancelStoredRun`/`supersedeStoredRun`, and both drop the
 * failure — the User's own intent is the outcome, not an error.
 */
const DISCARDED_RUN_RECOVERY_FAILURE_V1 =
  "Turn was discarded before recovery could resume it";

/**
 * True when this object has already durably decided to throw the Turn away.
 *
 * Reconciliation exists to retrieve an external outcome the Turn still needs.
 * A Turn a Stop or a supersede has already discarded needs nothing: its
 * provider outcome cannot change what it settles as, and parking it would keep
 * the active-run marker — and so refuse every later message — over an answer
 * nobody is waiting for. The intent the User expressed wins, and the run
 * settles `cancelled` or `superseded` with everything it had already said.
 */
function runWasDiscardedV1(
  run: { stopRequestedAt?: string; supersededAt?: string } | undefined,
): boolean {
  return Boolean(run?.stopRequestedAt || run?.supersededAt);
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
  /**
   * The in-process settlement of the executing run. A supersede has to wait
   * for the Turn it interrupted to reach its durable terminal state before the
   * Turn that replaced it can start, and while this object is resident that
   * settlement is a promise rather than an alarm.
   */
  private executingActivity: Promise<unknown> | undefined;
  /**
   * Queued runs a caller in this object is already waiting to start. Recovery
   * leaves them alone, so a queued Turn is promoted by exactly one path.
   */
  private readonly queuedWaiters = new Set<string>();

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

  async run(input: OwnedBotTurnCommand): Promise<BotTurnCompletion> {
    const command = await this.conversationScopedCommand(input);
    await this.assertMatchingRunCommand(command);
    // Recovering whatever this object was left holding must never decide the
    // fate of a new command. `recoverActiveRun` executes the *previous* Turn
    // inline and rethrows, so a recovery that failed — an uncertain effect, a
    // mount failure, a provider that was down — threw before the new message
    // was ever admitted, and the person's message was simply lost. The old
    // Turn is durable either way and the alarm retries it; admission now
    // refuses or supersedes on its own terms.
    await this.recoverActiveRun().catch(() => undefined);
    const replay = await this.settledReplayResult(command);
    if (replay) return replay;
    const admission = await this.acceptRun(command);
    if (admission.kind === "queued") {
      // Durably admitted, waiting for the object. The interrupt is advisory
      // and always follows the intent that is already written.
      if (admission.interrupt) {
        this.hooks.interruptTurn?.(
          admission.interrupt.runId,
          SUPERSEDED_TURN_REASON_V1,
        );
      }
      return this.runQueuedRun(command);
    }
    return this.executeAcceptedRun(
      command,
      admission.previous,
      admission.settings,
      admission.compositionGenerationId,
    );
  }

  /**
   * Drives one durably queued Turn to its own terminal state.
   *
   * The Turn ahead of it settles first — it is either finishing on its own or
   * has just been fenced by the supersede intent — and only then does this one
   * become the active run. Eviction anywhere in here is safe: the queued run is
   * durable, and the recovery alarm promotes it exactly as this does.
   */
  private async runQueuedRun(
    command: OwnedBotTurnCommand,
  ): Promise<BotTurnCompletion> {
    this.queuedWaiters.add(command.runId);
    try {
      for (
        let attempt = 0;
        attempt < MAX_QUEUED_RUN_START_ATTEMPTS;
        attempt++
      ) {
        await this.settleExecutingActivity();
        const settled = await this.terminalRunResult(command.runId);
        if (settled) return settled;
        const promoted = await this.promoteQueuedRun(command.runId);
        if (promoted === "blocked") {
          // Another Turn holds the object. Recovery drives it to its own
          // durable terminal or resumable state, and this one tries again —
          // including when that recovery fails, which is the other Turn's
          // problem and not this one's.
          await this.recoverActiveRun().catch(() => undefined);
          // Unless what holds the object is an uncertain effect. That is
          // settled by an explicit reconciliation the User asks for, on their
          // own clock, and retrying against it would only burn this caller's
          // attempts and end by failing a Turn the User is owed. The queued
          // run is durable: it stays queued, and the reconciliation's own
          // settlement — or the recovery alarm — starts it.
          if (await this.activeRunAwaitsReconciliation()) {
            // A Turn that has not run is not a completed Turn. Answering with
            // an empty completion made the browser render the person's new
            // message as answered with silence; the durable queue entry stays,
            // and the refusal says why nothing has happened yet.
            throw new BotTurnRefusedError(
              "reconciliation-required",
              `run "${command.runId}" is queued: the active run requires reconciliation before another Turn can be admitted`,
            );
          }
          continue;
        }
        if (promoted === "not-queued") {
          const terminal = await this.terminalRunResult(command.runId);
          if (terminal) return terminal;
          const current = await this.readRun(command.runId);
          throw new Error(
            `run "${command.runId}" left the queue with status ${
              current?.status ?? "missing"
            }`,
          );
        }
        return this.executeAcceptedRun(
          command,
          promoted.previous,
          promoted.settings,
          promoted.compositionGenerationId,
        );
      }
      throw new Error(`run "${command.runId}" could not start`);
    } finally {
      this.queuedWaiters.delete(command.runId);
    }
  }

  /** True while the active run is holding an effect only a User can settle. */
  private async activeRunAwaitsReconciliation(): Promise<boolean> {
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (!activeRunId) return false;
    const run = await this.readRun(activeRunId);
    return run?.status === "reconciliation-required";
  }

  /** Waits out whatever this object is currently running, failures included. */
  private async settleExecutingActivity(): Promise<void> {
    for (let guard = 0; guard < 64; guard += 1) {
      const activity = this.executingActivity;
      if (!activity) return;
      await activity.catch(() => undefined);
      if (this.executingActivity === activity) return;
    }
  }

  /**
   * Makes the durably queued run the active one, recomputing the history it
   * starts from: the Turn it waited behind appended events, and the queued
   * Turn's model request derives from everything that is durable now.
   */
  private async promoteQueuedRun(runId: string): Promise<
    | "not-queued"
    | "blocked"
    | {
        previous: SessionEvent[];
        settings: Snapshot;
        compositionGenerationId: string;
      }
  > {
    const key = `${RUN_PREFIX}${runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const pendingRunId = await transaction.get<string>(PENDING_RUN_KEY);
      const run = this.codec.optional(await transaction.get<unknown>(key));
      const lane = run ? storedRunLaneV1(run) : undefined;
      const firstPendingAgent = await transaction.list<string>({
        prefix: PENDING_AGENT_RUN_PREFIX,
        limit: 1,
      });
      const firstPendingAgentEntry = firstPendingAgent.entries().next()
        .value as [string, string] | undefined;
      if (!run || run.status !== "running" || run.phase !== "queued") {
        return "not-queued" as const;
      }
      if (lane === "agent") {
        // A User Turn always has first claim on an idle Bot, and agent Turns
        // retain FIFO order behind it. The run is still queued in either case;
        // reporting `not-queued` here would strand its blocking caller even
        // though the durable queue entry remains.
        if (pendingRunId !== undefined) return "blocked" as const;
        if (firstPendingAgentEntry?.[1] !== runId) {
          return firstPendingAgentEntry
            ? ("blocked" as const)
            : ("not-queued" as const);
        }
      } else if (pendingRunId !== runId) {
        return "not-queued" as const;
      }
      if (await transaction.get<string>(ACTIVE_RUN_KEY)) {
        return "blocked" as const;
      }
      const eventLog = new SessionEventLog(transaction);
      const storedEvents = await eventLog.migrate(run.sessionId);
      // A queued Turn was admitted while another was executing, so admission
      // could not repair the log: something was still entitled to close that
      // Turn. Here the active-run marker is gone and nothing is, so the same
      // repair applies before this Turn starts on it.
      const repaired = repairedSessionLogV1(run.sessionId, storedEvents);
      const latestEvents = repaired ?? storedEvents;
      const promoted = this.codec.require({
        ...run,
        phase: "admitted",
        previousEventCount: latestEvents.length,
        ...storedRunEventFieldsV2(latestEvents.length, []),
      } satisfies StoredRunV1<Snapshot>);
      if (repaired) await eventLog.rewrite(run.sessionId, latestEvents);
      await transaction.put({
        [key]: structuredClone(storedRunRecordV2(promoted)),
        [ACTIVE_RUN_KEY]: runId,
      });
      if (lane === "agent" && firstPendingAgentEntry) {
        await transaction.delete(firstPendingAgentEntry[0]);
      } else {
        await transaction.delete(PENDING_RUN_KEY);
      }
      await this.refreshRecoveryAlarm(transaction);
      return {
        previous: latestEvents,
        settings: promoted.configurationSnapshot,
        compositionGenerationId: promoted.compositionGenerationId,
      };
    });
  }

  async reconcileRun(
    identity: BotIdentity,
    runId: string,
  ): Promise<BotTurnCompletion> {
    await this.assertIdentity(identity);
    const key = `${RUN_PREFIX}${runId}`;
    const recovery = await this.ctx.storage.transaction(async (transaction) => {
      const run = await this.readRunFrom(transaction, runId);
      const activeRunId = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (
        !run ||
        run.status !== "reconciliation-required" ||
        activeRunId !== runId
      ) {
        throw new Error(`run "${runId}" does not require reconciliation`);
      }
      const latest = await new SessionEventLog(transaction).read(run.sessionId);
      const settings = run.configurationSnapshot;
      // The failure is *removed*, not set to `undefined`: a running run that
      // carries a `failure` key is a shape the run record does not allow, and
      // writing one turned "resolve this Turn" into a record nothing could
      // read afterwards. `require` checks it here, where the write is, rather
      // than leaving the projector to fail on every later read.
      const { failure: _failure, ...resumed } = run;
      const resumedRun = this.codec.require({
        ...resumed,
        status: "running",
        phase: "executing",
      } satisfies StoredRunV1<Snapshot>);
      await transaction.put(
        key,
        structuredClone(storedRunRecordV2(resumedRun)),
      );
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
      const current = await this.readRun(runId);
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
      // "Try again" that ends in a settled run is a *successful* abandon, not a
      // failed request. Rethrowing here made the button answer 409 and left the
      // browser reading a run it thought had not moved — and the read that
      // followed 500'd on the half-repaired record. The run is durable and
      // terminal by this point, and its own record says why it ended, so the
      // caller is handed that record and reads the reason from the transcript.
      const settled = await this.settledTerminalRunResult(runId);
      if (settled) return settled;
      throw error;
    }
  }

  /**
   * The completion an abandoned reconciliation reports once the run it was
   * resolving has reached a terminal state — whatever that state turned out to
   * be. Anything still open is not this method's to answer for.
   */
  private async settledTerminalRunResult(
    runId: string,
  ): Promise<BotTurnCompletion | undefined> {
    const run = await this.readRun(runId);
    if (
      run?.status !== "failed" &&
      run?.status !== "cancelled" &&
      run?.status !== "superseded"
    ) {
      return undefined;
    }
    return {
      runId,
      text: run.responseText ?? "",
      events: structuredClone(run.events),
    };
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
    const activity = this.executeAdmittedRun(
      command,
      previous,
      settings,
      compositionGenerationId,
    );
    this.executingActivity = activity;
    try {
      return await activity;
    } finally {
      if (this.executingActivity === activity) {
        this.executingActivity = undefined;
      }
    }
  }

  private async executeAdmittedRun(
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
        await transaction.put(
          key,
          storedRunRecordV2({
            ...run,
            phase: "executing",
          } satisfies StoredRunV1<Snapshot>),
        );
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
      await this.completeRun(command.runId, previous, completed, settings);
      return completed;
    } catch (error) {
      const durableRun = await this.readRun(command.runId);
      const events = eventsForFailedRun(durableRun, error);
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      if (error instanceof BotTurnRecoveryRequiredError) {
        await this.deferRunRecovery(command.runId);
        throw new Error(message);
      }
      const modelState = latestModelRequestJournalState(events);
      if (
        (error instanceof BotTurnReconciliationRequiredError ||
          modelState.status === "unresolved") &&
        !runWasDiscardedV1(durableRun)
      ) {
        const settled = await this.parkOrSettleUnresolvedRun(
          command.runId,
          previous,
          events,
          modelState.status === "unresolved"
            ? unresolvedModelRequestFailure(events, modelState.request)
            : message,
        );
        if (settled) return settled;
        throw new Error(message);
      }
      await this.failRun(command.runId, previous, events, message);
      // `settledTerminalRunResult`, not `discardedRunResult`: a Turn the Package failed
      // outright — a provider 401, a step limit — reaches a `turn/end` and a
      // durable `failed` record just as surely as a stopped one does, and
      // rethrowing over the top of that settlement is what made the Worker log
      // `Uncaught Error: Bot turn ended with outcome model-error: Model request
      // failed (401)` and answer 500. The run is terminal by this point and its
      // record says why; the caller is handed that record and the client reads
      // the sentence for the outcome off it.
      const settled = await this.settledTerminalRunResult(command.runId);
      if (settled) return settled;
      throw new Error(message);
    } finally {
      if (this.executingRunId === command.runId) {
        this.executingRunId = undefined;
      }
    }
  }

  /**
   * The completion a discarded Turn reports — one the User stopped, or one a
   * later message replaced. Neither is a failure: the Turn settled durably,
   * keeping everything it had already sent, and its caller reads the rest of
   * the conversation from durable state.
   *
   * Stop used to be missing from here, so the long-lived `POST /turns` the
   * composer was still holding open answered 500 the instant Stop was pressed:
   * the UI said "You stopped this." and the console said the send had failed.
   * A Turn the person stopped on purpose is the most ordinary outcome there is.
   */
  private async discardedRunResult(
    runId: string,
  ): Promise<BotTurnCompletion | undefined> {
    const run = await this.readRun(runId);
    if (run?.status !== "superseded" && run?.status !== "cancelled") {
      return undefined;
    }
    return { runId, text: "", events: structuredClone(run.events) };
  }

  /**
   * The completion a run that has already settled reports, or `undefined`
   * while it is still going. Unlike the replay check this asks no questions
   * about the command that produced it: the caller is the run's own waiter.
   */
  private async terminalRunResult(
    runId: string,
  ): Promise<BotTurnCompletion | undefined> {
    const run = await this.readRun(runId);
    if (run?.status === "superseded" || run?.status === "cancelled") {
      return { runId, text: "", events: structuredClone(run.events) };
    }
    if (run?.status !== "completed") return undefined;
    return {
      runId,
      text: run.responseText ?? "",
      events: structuredClone(run.events),
      ...(await this.storedNotification(runId)),
    };
  }

  private async storedNotification(
    runId: string,
  ): Promise<{ notification?: BotNotificationIntent }> {
    const notification = await this.ctx.storage.get<BotNotificationIntent>(
      `${NOTIFICATION_PREFIX}${runId}`,
    );
    return notification ? { notification } : {};
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
          lane: storedRunLaneV1(run),
          ...(storedRunSubagentRoleV1(run)
            ? { subagentRole: storedRunSubagentRoleV1(run) }
            : {}),
          ...(run.admission?.origin ? { origin: run.admission.origin } : {}),
          ...(run.directTool ? { directTool: run.directTool } : {}),
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
      const durableRun = await this.readRun(run.runId);
      if (!durableRun) throw new Error(`run "${run.runId}" was not accepted`);
      const fullResult = {
        ...result,
        events: durableRun.events,
      } satisfies BotTurnCompletion;
      const completed = this.withNotification(settings, fullResult);
      await this.completeRun(run.runId, previous, completed, settings);
      return completed;
    } catch (error) {
      const durableRun = await this.readRun(run.runId);
      const events = durableRun?.events ?? run.events;
      const message =
        error instanceof Error ? error.message : "Bot turn failed";
      if (error instanceof BotTurnRecoveryRequiredError) {
        await this.deferRunRecovery(run.runId);
        throw new Error(message);
      }
      const modelState = latestModelRequestJournalState(events);
      if (
        (error instanceof BotTurnReconciliationRequiredError ||
          modelState.status === "unresolved") &&
        !runWasDiscardedV1(durableRun)
      ) {
        const parked = await this.parkOrSettleUnresolvedRun(
          run.runId,
          previous,
          events,
          modelState.status === "unresolved"
            ? unresolvedModelRequestFailure(events, modelState.request)
            : message,
        );
        if (parked) return parked;
        throw new Error(message);
      }
      await this.failRun(run.runId, previous, events, message);
      const settled = await this.settledTerminalRunResult(run.runId);
      if (settled) return settled;
      throw new Error(message);
    } finally {
      if (this.executingRunId === run.runId) this.executingRunId = undefined;
    }
  }

  private async deferRunRecovery(runId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const run = await this.readRunFrom(transaction, runId);
      if (!run || run.status !== "running") {
        throw new Error(`run "${runId}" is not resumable`);
      }
      await transaction.put(
        `${RUN_PREFIX}${runId}`,
        storedRunRecordV2({
          ...run,
          phase: "executing",
        } satisfies StoredRunV1<Snapshot>),
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async settledReplayResult(
    command: OwnedBotTurnCommand,
  ): Promise<BotTurnCompletion | undefined> {
    const { runId } = command;
    const run = await this.readRun(runId);
    if (!run) return undefined;
    if (run.commandFingerprint !== botTurnCommandFingerprintV1(command)) {
      throw new BotTurnRefusedError(
        "duplicate",
        `Turn idempotency key "${runId}" was reused for a different command`,
      );
    }
    // A Turn the User stopped, or one another user message took the place of,
    // is an ordinary outcome and not a failure: it settled durably, said
    // whatever it had already said, and the caller reads the rest from durable
    // state. A retry of either replays that settlement rather than refusing.
    if (run.status === "superseded" || run.status === "cancelled") {
      return {
        runId,
        text: "",
        events: structuredClone(run.events),
      };
    }
    if (run.status !== "completed") {
      throw new BotTurnRefusedError(
        "duplicate",
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
      throw new BotTurnRefusedError(
        "duplicate",
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
   * Raises a visible failure through notifications. Used when a
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
      await transaction.put(
        key,
        storedRunRecordV2({
          ...run,
          compositionGenerationId,
        } satisfies StoredRunV1<Snapshot>),
      );
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
    const [activeBeforeAlarm, pendingUser, pendingAgents] = await Promise.all([
      this.ctx.storage.get<string>(ACTIVE_RUN_KEY),
      this.ctx.storage.get<string>(PENDING_RUN_KEY),
      this.ctx.storage.list<string>({
        prefix: PENDING_AGENT_RUN_PREFIX,
        limit: 1,
      }),
    ]);
    // An admitted Turn is work already owed. It runs before a due Routine;
    // otherwise a busy schedule can starve a Bot-to-Bot question indefinitely.
    if (!activeBeforeAlarm && (pendingUser || pendingAgents.size > 0)) {
      try {
        await this.recoverQueuedRun();
      } finally {
        await this.ctx.storage.transaction((transaction) =>
          this.refreshRecoveryAlarm(transaction),
        );
      }
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
      if (run?.status === "reconciliation-required" && identity) {
        // A parked run is not this alarm's to settle — only an explicit
        // reconciliation settles it — but returning without rescheduling
        // dropped the object's *other* deadlines with it: a Routine due while
        // a Bot sat parked never fired, and nothing set the alarm again.
        await this.ctx.storage.transaction((transaction) =>
          this.refreshRecoveryAlarm(transaction),
        );
        return;
      }
    }
    // An alarm has no caller. A rejection here is an uncaught exception in the
    // object, and in the dev Worker it took the whole process down: a Stop left
    // a run whose model outcome was uncertain, recovery re-entered it,
    // `executeAdmittedRun` rethrew after recording the failure durably, and
    // wrangler exited mid-run for every agent sharing the stack.
    //
    // Nothing about that throw is actionable here. Recovery has already written
    // whatever it decided to durable storage before it rethrew, so the only
    // thing left to do is record the reason and make sure the object still has
    // a deadline — the re-arm is deliberately in a `finally`, because a failed
    // recovery is exactly the case where the *next* firing matters most.
    try {
      await this.recoverActiveRun();
    } catch (error) {
      console.error(
        `Bot run recovery alarm failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      await this.ctx.storage
        .transaction((transaction) => this.refreshRecoveryAlarm(transaction))
        .catch(() => undefined);
    }
  }

  /** Active run id, for Package projections of durable run state. */
  async readActiveRunId(): Promise<string | undefined> {
    return this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
  }

  /** The conversation this Bot's chat Session is on. */
  async readConversation(): Promise<StoredConversationV1> {
    return (
      decodeStoredConversationV1(
        await this.ctx.storage.get<unknown>(CONVERSATION_KEY),
      ) ?? firstConversationV1(new Date().toISOString())
    );
  }

  /**
   * The conversations this Bot has had, newest first, the current one included.
   *
   * Ended conversations are listed from a bounded index rather than
   * reconstructed from the run log: the run index is paged and a conversation
   * with no surviving runs is still a conversation the User had.
   */
  async listConversations(
    identity?: BotIdentity,
  ): Promise<ConversationRecordV1[]> {
    const known =
      identity ?? (await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY));
    if (!known) return [];
    const base = botConversationBaseSessionIdV1(known);
    const current = await this.readConversation();
    const ended = (
      (await this.ctx.storage.get<unknown[]>(CONVERSATION_INDEX_KEY)) ?? []
    ).flatMap((entry) => {
      try {
        return [decodeConversationRecordV1(entry)];
      } catch {
        // One unreadable record is skipped, never a list that throws: a
        // conversation you cannot name must not hide the ones you can.
        return [];
      }
    });
    return [
      {
        schemaVersion: 1 as const,
        sessionId: conversationSessionIdV1(base, current.ordinal),
        ordinal: current.ordinal,
        startedAt: current.startedAt,
      },
      ...ended,
    ].sort((left, right) => right.ordinal - left.ordinal);
  }

  /**
   * The Session id this Bot's chat Turns are recording right now, or
   * `undefined` before the object has admitted anything and learned its
   * identity. A reader that has to say which Turns are "this conversation"
   * asks here rather than reconstructing the id.
   */
  async readConversationSessionId(): Promise<string | undefined> {
    const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    if (!identity) return undefined;
    const conversation = await this.readConversation();
    return conversationSessionIdV1(
      botConversationBaseSessionIdV1(identity),
      conversation.ordinal,
    );
  }

  /**
   * Ends the current conversation and starts the next one.
   *
   * The durable event log the next Turn derives its request from is emptied,
   * so history stops growing without bound; the runs of the conversation just
   * ended keep their events and their Session id and stay readable. Refused
   * while a Turn is admitted: the log a running Turn is appending to is not
   * something a click may pull out from under it.
   */
  async startConversation(
    identity: BotIdentity,
  ): Promise<ConversationRecordV1> {
    await this.assertIdentity(identity);
    await this.recoverActiveRun();
    const base = botConversationBaseSessionIdV1(identity);
    return this.ctx.storage.transaction(async (transaction) => {
      const active = await transaction.get<string>(ACTIVE_RUN_KEY);
      const pending = await transaction.get<string>(PENDING_RUN_KEY);
      const pendingAgent = await transaction.list<string>({
        prefix: PENDING_AGENT_RUN_PREFIX,
        limit: 1,
      });
      if (active || pending || pendingAgent.size > 0) {
        // A typed refusal, not a bare Error: the Durable Object boundary turns
        // this one case into a 409 value rather than letting it escape the
        // object's entry frame as an uncaught exception.
        throw new ConversationBusyError();
      }
      const current =
        decodeStoredConversationV1(
          await transaction.get<unknown>(CONVERSATION_KEY),
        ) ?? firstConversationV1(new Date().toISOString());
      const endedAt = new Date().toISOString();
      const ended = (
        (await transaction.get<unknown[]>(CONVERSATION_INDEX_KEY)) ?? []
      ).flatMap((entry) => {
        try {
          return [decodeConversationRecordV1(entry)];
        } catch {
          return [];
        }
      });
      const next: StoredConversationV1 = {
        schemaVersion: 1,
        ordinal: current.ordinal + 1,
        startedAt: endedAt,
      };
      const currentSessionId = conversationSessionIdV1(base, current.ordinal);
      const nextSessionId = conversationSessionIdV1(base, next.ordinal);
      const eventLog = new SessionEventLog(transaction);
      await eventLog.migrate(currentSessionId);
      await eventLog.clearCurrent(nextSessionId);
      await transaction.put({
        [CONVERSATION_KEY]: next,
        [CONVERSATION_INDEX_KEY]: [
          {
            schemaVersion: 1 as const,
            sessionId: currentSessionId,
            ordinal: current.ordinal,
            startedAt: current.startedAt,
            endedAt,
          },
          ...ended,
        ]
          .sort((left, right) => right.ordinal - left.ordinal)
          .slice(0, MAX_LISTED_CONVERSATIONS),
      });
      return {
        schemaVersion: 1 as const,
        sessionId: nextSessionId,
        ordinal: next.ordinal,
        startedAt: next.startedAt,
      };
    });
  }

  /**
   * The command as this object's durable conversation state addresses it.
   *
   * A client names the Bot's conversational Session by its base id and knows
   * nothing about conversations; which conversation that is, is durable state
   * here. Every other Session id — a Routine's `routine:<id>`, a subagent's —
   * is left exactly as its producer wrote it.
   */
  private async conversationScopedCommand(
    command: OwnedBotTurnCommand,
  ): Promise<OwnedBotTurnCommand> {
    const base = botConversationBaseSessionIdV1(command);
    if (command.sessionId !== base) return command;
    const conversation = await this.readConversation();
    if (conversation.ordinal <= 1) return command;
    return {
      ...command,
      sessionId: conversationSessionIdV1(base, conversation.ordinal),
    };
  }

  /** Durable run record, unchecked against its lookup key. */
  async readStoredRun(
    runId: string,
  ): Promise<StoredRunV1<Snapshot> | undefined> {
    return this.readRunFrom(this.ctx.storage, runId);
  }

  /**
   * The run record alone, with no journal behind it.
   *
   * Deciding whether a Turn belongs to the conversation being read, and
   * whether a person is meant to see it, needs the record and nothing else. A
   * transcript page scans many more candidates than it keeps, and hydrating
   * every candidate's events to discard it was the whole cost of that scan.
   * The returned record carries an empty `events` array and its `eventRange`;
   * anything that reads the journal calls {@link readStoredRun} or
   * {@link readStoredRunForDisplay}.
   */
  async readRunHeader(
    runId: string,
  ): Promise<StoredRunV1<Snapshot> | undefined> {
    return this.codec.optional(
      await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${runId}`),
    );
  }

  /**
   * A run hydrated for the conversation surface: exact for everything the
   * transcript renders, and each normalized model request left as its durable
   * projection. See `SessionEventLog.readDisplayRange`.
   */
  async readStoredRunForDisplay(
    runId: string,
  ): Promise<StoredRunV1<Snapshot> | undefined> {
    return this.readRunFrom(this.ctx.storage, runId, "display");
  }

  private async readRunFrom(
    storage: SessionEventLogStorage,
    runId: string,
    fidelity: "exact" | "display" = "exact",
  ): Promise<StoredRunV1<Snapshot> | undefined> {
    const run = this.codec.optional(
      await storage.get<unknown>(`${RUN_PREFIX}${runId}`),
    );
    if (!run?.eventRange) return run;
    const log = new SessionEventLog(storage);
    const events =
      fidelity === "display"
        ? await log.readDisplayRange(
            run.sessionId,
            run.eventRange.startSeq,
            run.eventRange.endSeq,
          )
        : await log.readRange(
            run.sessionId,
            run.eventRange.startSeq,
            run.eventRange.endSeq,
          );
    if (events.length !== run.eventRange.endSeq - run.eventRange.startSeq) {
      throw new Error(`run "${run.runId}" has an incomplete event range`);
    }
    return this.codec.require({ ...run, events });
  }

  /** Exact Session history, reconstructed through the paged durable log. */
  async readSessionEvents(sessionId: string): Promise<SessionEvent[]> {
    return new SessionEventLog(this.ctx.storage).read(sessionId);
  }

  /**
   * The bounded durable event projections for a run. This is the inspection
   * path: recovery, compaction and audit use `readStoredRun` and therefore
   * receive exact events, the transcript uses `readStoredRunForDisplay`, and a
   * debug snapshot never hydrates a multi-megabyte prompt merely to cut it
   * again (ADR 0038).
   */
  async readRunEventProjections(runId: string): Promise<
    | {
        run: StoredRunV1<Snapshot>;
        events: unknown[];
        eventCount: number;
      }
    | undefined
  > {
    const run = this.codec.optional(
      await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${runId}`),
    );
    if (!run) return undefined;
    if (!run.eventRange) {
      return { run, events: run.events, eventCount: run.events.length };
    }
    const events = await new SessionEventLog(this.ctx.storage).readProjections(
      run.sessionId,
      run.eventRange.startSeq,
      run.eventRange.endSeq,
    );
    const eventCount = run.eventRange.endSeq - run.eventRange.startSeq;
    if (events.length !== eventCount) {
      throw new Error(`run "${run.runId}" has an incomplete event range`);
    }
    return { run, events, eventCount };
  }

  /** Durable run record, checked against the key it was looked up by. */
  async readRun(runId: string): Promise<StoredRunV1<Snapshot> | undefined> {
    const run = await this.readStoredRun(runId);
    if (run && run.runId !== runId) {
      throw new Error("stored run does not match its lookup key");
    }
    return run;
  }

  /**
   * Whether a run is still working, settling its record when it is not.
   *
   * This is the only honest answer to "is this Bot busy", and both readers that
   * ask — the sidebar's activity ring and the transcript's running Turn — go
   * through here. `status === "running"` alone is a claim the record makes and
   * nothing renews: a Turn that died mid-answer never wrote its own
   * settlement, so idle Bots wore a pulsing ring for hours.
   * {@link runLivenessV1} holds the rule; this adds the two things a pure rule
   * cannot have.
   *
   * The first is the fence. A run this object is executing right now is alive
   * by direct observation, whatever the durable record and the log look like
   * mid-flush, and it is never judged or touched. The object is
   * single-threaded, so `executingRunId` is exact for the run in this isolate,
   * and a run executing in some *other* isolate cannot be at issue: the durable
   * `active-run` marker admits one Turn at a time, and a record older than the
   * Turn deadline is past the point where any isolate is still holding it.
   *
   * The second is the repair. A read that finds a dead record settles it rather
   * than merely hiding it, so the ring goes out for every other reader too and
   * the next message inherits a closed Turn instead of repairing one. The
   * settlement is `failStoredRun`, exactly as recovery's is, which closes the
   * open Turn in the log on the way and routes a run carrying a durable Stop or
   * supersede intent to the outcome that intent already decided. It is
   * idempotent — a second caller finds a terminal record and settles nothing —
   * and the run-record write it commits is what publishes the `runs`
   * invalidation the watching clients re-read on.
   */
  async resolveRunWorking(runId: string | undefined): Promise<boolean> {
    if (runId === undefined) return false;
    if (runId === this.executingRunId) return true;
    const run = await this.readRun(runId);
    if (!run || run.status !== "running") return false;
    const sessionEvents = await new SessionEventLog(this.ctx.storage).read(
      run.sessionId,
    );
    if (runLivenessV1({ run, sessionEvents }).working) return true;
    await this.settleStaleRun(runId);
    return false;
  }

  /**
   * Settles one run whose record says `running` and whose Turn is over.
   *
   * The verdict is taken again inside the transaction, against the record and
   * the log as they are committed there, so a Turn that settled itself between
   * the read above and this write is left exactly as it settled — and so is one
   * that started executing in this object in the meantime.
   */
  private async settleStaleRun(runId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      if (runId === this.executingRunId) return;
      const run = await this.readRunFrom(transaction, runId);
      if (!run || run.runId !== runId || run.status !== "running") return;
      const latest = await new SessionEventLog(transaction).read(run.sessionId);
      if (runLivenessV1({ run, sessionEvents: latest }).working) return;
      await failStoredRun(
        this.codec,
        transaction,
        this.terminalKeys(runId),
        runId,
        latest.slice(0, run.previousEventCount),
        run.events,
        STALE_RUNNING_RUN_FAILURE_V1,
        this.supersededPackageRecords(),
        this.failedRunNotification(),
      );
      await this.refreshRecoveryAlarm(transaction);
    });
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
        // A bounded FIFO, not a cliff. Nothing ever evicted an entry, so a Bot
        // that had refused 256 sends over its life answered every later fence
        // with a 500 and left the client retrying "Turn admission lookup
        // failed" forever. A run id old enough to age out here can no longer
        // be admitted by any live caller.
        const kept = storedFences.filter((fenced) => fenced !== runId);
        while (kept.length >= MAX_RUN_ADMISSION_FENCES) kept.shift();
        await transaction.put({
          [RUN_ADMISSION_FENCE_INDEX_KEY]: [...kept, runId],
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
    const [activeRunId, scheduled, pendingAgents] = await Promise.all([
      transaction.get<string>(ACTIVE_RUN_KEY),
      this.hooks.scheduledDeadlines(transaction),
      transaction.list<string>({
        prefix: PENDING_AGENT_RUN_PREFIX,
        limit: 1,
      }),
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
    } else if (
      !activeRunId &&
      ((await transaction.get<string>(PENDING_RUN_KEY)) ||
        pendingAgents.size > 0)
    ) {
      // A Turn admitted and waiting is work this object owes, so it keeps the
      // recovery alarm even with nothing running.
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

  private async acceptRun(command: OwnedBotTurnCommand): Promise<
    | {
        kind: "active";
        previous: SessionEvent[];
        settings: Snapshot;
        compositionGenerationId: string;
      }
    | { kind: "queued"; interrupt?: { runId: string } }
  > {
    const fenceKey = `${RUN_ADMISSION_FENCE_PREFIX}${command.runId}`;
    const fences = storedRunAdmissionFences(
      await this.ctx.storage.get<unknown>(RUN_ADMISSION_FENCE_INDEX_KEY),
    );
    if (
      fences.includes(command.runId) ||
      (await this.ctx.storage.get(fenceKey))
    ) {
      throw new BotTurnRefusedError(
        "fenced",
        `run "${command.runId}" admission was fenced`,
      );
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
          throw new BotTurnRefusedError(
            "duplicate",
            `Turn idempotency key "${command.runId}" was reused for a different command`,
          );
        }
        if (existing.status === "completed") {
          throw new BotTurnRefusedError(
            "duplicate",
            `run "${command.runId}" already completed`,
          );
        }
        throw new BotTurnRefusedError(
          "duplicate",
          `run "${command.runId}" already exists`,
        );
      }
      const fences = storedRunAdmissionFences(
        await transaction.get<unknown>(RUN_ADMISSION_FENCE_INDEX_KEY),
      );
      if (fences.includes(command.runId) || (await transaction.get(fenceKey))) {
        throw new BotTurnRefusedError(
          "fenced",
          `run "${command.runId}" admission was fenced`,
        );
      }
      const identity = await transaction.get<BotIdentity>(IDENTITY_KEY);
      if (
        identity &&
        (identity.userId !== command.userId || identity.botId !== command.botId)
      ) {
        throw new Error("Bot authority does not match its durable identity");
      }
      const activeRunId = await transaction.get<string>(ACTIVE_RUN_KEY);
      const pendingUserRunId = await transaction.get<string>(PENDING_RUN_KEY);
      const lane = command.lane ?? defaultRunLaneV1(command.turnType ?? "chat");
      const activeRun = activeRunId
        ? this.codec.optional(
            await transaction.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
          )
        : undefined;
      const pendingAgents = await transaction.list<string>({
        prefix: PENDING_AGENT_RUN_PREFIX,
      });
      const hasPendingAgent = pendingAgents.size > 0;
      let supersede: ((supersededBy: string) => Promise<boolean>) | undefined;
      if (activeRunId) {
        if (
          lane === "agent" &&
          activeRun?.status === "reconciliation-required"
        ) {
          throw new BotTurnRefusedError(
            "reconciliation-required",
            "bot cannot admit agent work while its active run requires reconciliation",
          );
        }
        if (lane === "user") {
          supersede = await this.planSupersede(
            transaction,
            command,
            activeRunId,
          );
        } else if (lane === "background") {
          throw new BotTurnRefusedError(
            "busy",
            "bot already has an active run",
          );
        }
      } else if (
        lane === "background" &&
        (pendingUserRunId || hasPendingAgent)
      ) {
        throw new BotTurnRefusedError(
          "busy",
          "bot has queued conversational work",
        );
      }
      const queued =
        Boolean(activeRunId) ||
        (lane === "agent" && (Boolean(pendingUserRunId) || hasPendingAgent));
      if (
        lane === "agent" &&
        queued &&
        pendingAgents.size >= MAX_PENDING_AGENT_RUNS_V1
      ) {
        throw new BotTurnRefusedError(
          "busy",
          `bot agent queue is full (${MAX_PENDING_AGENT_RUNS_V1} Turns)`,
        );
      }
      const eventLog = new SessionEventLog(transaction);
      const storedEvents = await eventLog.migrate(command.sessionId);
      // A Turn that died between `turn/start` and `turn/end` — an event the
      // encoder refused, a durable write that failed — left the log open, and
      // every later Turn failed validation with "turn N started while turn
      // N-1 is open". Nothing owned that repair, because the run that would
      // have closed it is already terminal, so admission does: with nothing
      // executing, an open Turn is one nobody is going to finish.
      //
      // The pointer alone is not the test. A Bot can hold an `active-run` id
      // whose record is already terminal — a settlement that landed while the
      // pointer clear did not, a supersede whose Turn ended between the two
      // writes — and gating the repair on the pointer left exactly those Bots
      // wedged. What matters is whether anything is still entitled to write
      // that Turn's end: a `running` record is, and so is a
      // `reconciliation-required` one, whose Turn is held open on purpose
      // until its outcome is retrieved. Nothing else is.
      const stillOwned =
        activeRun?.status === "running" ||
        activeRun?.status === "reconciliation-required";
      //
      // The repair rewrites the whole log rather than appending to it: by the
      // time anyone notices, the abandoned Turn is usually no longer the last
      // thing in the log. Each refused message journals its own `turn/start`
      // before it assembles the request that discovers the breakage, and its
      // `finally` writes the matching `turn/end`, so the log ends closed with
      // the abandoned Turn still open behind it. Appending cannot close that.
      const repaired = stillOwned
        ? undefined
        : repairedSessionLogV1(command.sessionId, storedEvents);
      const latestEvents = repaired ?? storedEvents;
      if (repaired) await eventLog.rewrite(command.sessionId, latestEvents);
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
        // A queued Turn is admitted — durable, ordered, and owed a terminal
        // state — but has not started. Its `previousEventCount` is recomputed
        // when it is promoted, because the Turn ahead of it is still writing.
        phase: queued ? "queued" : "admitted",
        compositionGenerationId: pin.generationId,
        configurationSnapshot: structuredClone(admittedSettings),
        previousEventCount: latestEvents.length,
        ...storedRunAdmissionV1(
          command.turnType,
          command.origin,
          command.subagentRole,
          command.lane,
        ),
        ...(command.directTool
          ? { directTool: structuredClone(command.directTool) }
          : {}),
      } satisfies StoredRunV1<Snapshot>);
      await transaction.put({
        [key]: storedRunRecordV2(admittedRun),
        [runIndexKey(command.acceptedAt, command.runId)]: command.runId,
        ...(queued
          ? lane === "agent"
            ? {
                [pendingAgentRunKey(command.acceptedAt, command.runId)]:
                  command.runId,
              }
            : { [PENDING_RUN_KEY]: command.runId }
          : { [ACTIVE_RUN_KEY]: command.runId }),
        [IDENTITY_KEY]: identity ?? {
          userId: command.userId,
          botId: command.botId,
        },
      });
      const interrupted = supersede ? await supersede(command.runId) : false;
      await this.refreshRecoveryAlarm(transaction);
      if (queued) {
        return {
          kind: "queued" as const,
          // Only a Turn whose supersede intent was actually recorded is
          // interrupted. One that had not dispatched a model request is left
          // to finish, and the new message simply waits behind it.
          ...(interrupted && activeRunId
            ? { interrupt: { runId: activeRunId } }
            : {}),
        };
      }
      return {
        kind: "active" as const,
        previous: latestEvents,
        settings: admittedSettings,
        compositionGenerationId: pin.generationId,
      };
    });
  }

  /**
   * Decides whether one new command may take the place of what is running.
   *
   * The rule is the lane's: a user-lane admission carrying explicit supersede
   * intent replaces the active run and any run already waiting behind it; a
   * background admission never supersedes and is refused exactly as a second
   * command always was, so a Routine firing waits for its own next schedule
   * rather than interrupting a person mid-sentence.
   *
   * Returns the writes the admission performs, which report whether the active
   * Turn was actually interrupted. A Turn that has not dispatched a model
   * request is left alone — there is nothing durable to lose — and the new
   * message simply queues behind it.
   */
  private async planSupersede(
    transaction: DurableObjectTransaction,
    command: OwnedBotTurnCommand,
    activeRunId: string,
  ): Promise<((supersededBy: string) => Promise<boolean>) | undefined> {
    const lane = command.lane ?? defaultRunLaneV1(command.turnType ?? "chat");
    // The intent is the whole of the decision, and it is the *presence* of the
    // field that carries it. `supersedes: {}` — a composer that had observed
    // no run when the person pressed send — supersedes exactly as a named one
    // does; only an absent field is "no intent", and that is still refused.
    if (lane !== "user" || !command.supersedes) {
      throw new BotTurnRefusedError("busy", "bot already has an active run");
    }
    const active = await this.readRunFrom(transaction, activeRunId);
    if (!active)
      throw new BotTurnRefusedError("busy", "bot already has an active run");
    if (active.status === "reconciliation-required") {
      // An uncertain external effect is never abandoned to admit something
      // else: the outcome has to be retrieved before this object runs again.
      throw new BotTurnRefusedError(
        "reconciliation-required",
        `run "${activeRunId}" requires reconciliation before another Turn can be admitted`,
      );
    }
    if (active.status !== "running") {
      throw new BotTurnRefusedError("busy", "bot already has an active run");
    }
    const pendingRunId = await transaction.get<string>(PENDING_RUN_KEY);
    // A Turn that has not dispatched a model request has no durable work to
    // lose, so it is left to finish and the new message queues behind it.
    // GrokBot draws the same line, and for the same reason: nothing may be
    // stranded before its first durable checkpoint.
    const dispatched = active.events.some(
      (event) => event.type === "model/request",
    );
    return async (supersededBy: string) => {
      if (pendingRunId && pendingRunId !== supersededBy) {
        await this.supersedeQueuedRun(transaction, pendingRunId, supersededBy);
      }
      if (!dispatched) return false;
      if (active.supersededAt) return true;
      const superseded = this.codec.require({
        ...active,
        supersededAt: new Date().toISOString(),
        supersededBy,
      } satisfies StoredRunV1<Snapshot>);
      await transaction.put(
        `${RUN_PREFIX}${activeRunId}`,
        structuredClone(storedRunRecordV2(superseded)),
      );
      return true;
    };
  }

  /**
   * Settles a Turn that was superseded before it ever started. It appended no
   * event and spoke to nobody, so it settles as a record on its own.
   */
  private async supersedeQueuedRun(
    transaction: DurableObjectTransaction,
    runId: string,
    supersededBy: string,
  ): Promise<void> {
    const key = `${RUN_PREFIX}${runId}`;
    const queued = this.codec.optional(await transaction.get<unknown>(key));
    if (!queued || queued.status !== "running" || queued.phase !== "queued") {
      return;
    }
    const { responseText: _text, failure: _failure, ...settled } = queued;
    const superseded = this.codec.require({
      ...settled,
      status: "superseded",
      phase: "admitted",
      supersededAt: new Date().toISOString(),
      supersededBy,
    } satisfies StoredRunV1<Snapshot>);
    await transaction.put(key, structuredClone(storedRunRecordV2(superseded)));
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
      const run = await this.readRunFrom(transaction, runId);
      if (!run) throw new Error(`run "${runId}" was not accepted`);
      const eventLog = new SessionEventLog(transaction);
      const latest = await eventLog.read(run.sessionId);
      for (const [index, event] of durableEvents.entries()) {
        if (event.seq !== latest.length + index) {
          throw new Error(
            "Bot session persistence received non-contiguous events",
          );
        }
      }
      const next = this.codec.require({
        ...run,
        ...storedRunEventFieldsV2(run.previousEventCount, [
          ...run.events,
          ...durableEvents,
        ]),
      } satisfies StoredRunV1<Snapshot>);
      await eventLog.append(run.sessionId, durableEvents);
      await transaction.put(key, structuredClone(storedRunRecordV2(next)));
    });
  }

  /**
   * The Package's terminal-record hook, bound to the snapshot the Turn ran
   * under. Absent when the Package contributes none.
   */
  private terminalPackageRecords(
    snapshot: Snapshot,
  ): TerminalPackageRecords<Snapshot> | undefined {
    const hook = this.hooks.terminalRecords;
    if (!hook) return undefined;
    return ({ run, read }) =>
      hook.call(this.hooks, {
        snapshot,
        run,
        cursor: runIndexKey(run.acceptedAt, run.runId),
        read,
      });
  }

  /** The Package's superseded-record hook, or `undefined` when it has none. */
  /**
   * The Package's failed-Turn notification hook, bound to the run's own
   * durable snapshot. Absent when the Package contributes none.
   */
  private failedRunNotification(): FailedRunNotification<Snapshot> | undefined {
    const hook = this.hooks.failureNotification;
    if (!hook) return undefined;
    return (run) =>
      hook.call(this.hooks, run.configurationSnapshot, {
        runId: run.runId,
        failure: run.failure ?? "",
        events: run.events,
      });
  }

  private supersededPackageRecords():
    SupersededPackageRecords<Snapshot> | undefined {
    const hook = this.hooks.supersededRecords;
    if (!hook) return undefined;
    return (input) => hook.call(this.hooks, input);
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
    snapshot: Snapshot,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await completeStoredRun(
        this.codec,
        transaction,
        this.terminalKeys(runId),
        runId,
        previous,
        result,
        this.terminalPackageRecords(snapshot),
        this.supersededPackageRecords(),
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  /**
   * Settles a run `failed` on a reason the authority composed from an error.
   *
   * The reason is bounded on the way in because nothing upstream bounds an
   * error's `message`: a provider that echoes the request back produced one far
   * past what the record allows, the settlement wrote it anyway, and every
   * later read of that run threw — so a Turn that failed once went on to 500
   * the transcript endpoint for ever. A reason a person reads loses nothing by
   * being cut; a transcript nobody can read loses everything.
   *
   * Recovery's own `failStoredRun` is deliberately not routed through here: a
   * failure derived from a malformed durable history is the one case where
   * refusing to settle, and keeping the work active, is the right answer.
   */
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
        boundedRunFailureV1(failure),
        this.supersededPackageRecords(),
        this.failedRunNotification(),
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  /** Parks a run on a reason the authority composed, bounded as `failRun`'s is. */
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
        boundedRunFailureV1(failure),
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  /**
   * Settles a Turn whose model outcome is unknown, or parks it when somebody
   * can still be asked — and never lets the uncertainty escape as a throw.
   *
   * This is ADR 0028 applied to the live path. Recovery already refuses to park
   * a run whose provider offers no retrieval, because parking there is not
   * caution but a dead end; the executing path did not, and the asymmetry is
   * what produced the blocker. A model request that ran past its budget threw
   * out of the Agent as an uncertain outcome, this method's predecessor parked
   * the run and rethrew, and the `POST /turns` the composer was holding open
   * answered 500 — so the person read "Couldn't reach the Bot. Check your
   * connection", which blamed their network for a model that took too long,
   * and the Bot stayed wedged behind a banner whose only possible resolution
   * was the settlement we could have written here.
   *
   * When the provider does reconcile, nothing changes: the run parks, the
   * caller still rethrows, and a later attempt can genuinely retrieve the
   * effect. Uncertainty is never assumed away in either branch — the request is
   * not re-sent, and every streamed word stays in the journal.
   *
   * Returns the settled completion when it settled, `undefined` when it parked.
   */
  private async parkOrSettleUnresolvedRun(
    runId: string,
    previous: SessionEvent[],
    events: SessionEvent[],
    reason: string,
  ): Promise<BotTurnCompletion | undefined> {
    const provider = latestModelRequestProviderV1(events);
    const reconciles = this.hooks.providerReconciles ?? (() => true);
    // A model's retrieval policy says nothing about an unresolved tool effect.
    // Preserve its intent for the tool reconciliation path (ADR 0028).
    const unresolvedTool =
      events.some((event) => event.type === "tool/call") &&
      [...validateToolOccurrenceJournal(events).values()].some(
        (entry) => entry.intent && !entry.result,
      );
    if (unresolvedTool || provider === undefined || reconciles(provider)) {
      await this.requireRunReconciliation(runId, previous, events, reason);
      return undefined;
    }
    // `failRun` runs the ordinary terminal settlement: the open Turn is closed
    // with a `turn/end`, the partial text is kept, and the record carries the
    // reason. The reason is a diagnostic for the debug surface — what the
    // person reads is the client's own copy for the outcome.
    await this.failRun(runId, previous, events, reason);
    return this.settledTerminalRunResult(runId);
  }

  /**
   * Starts the Turn that was waiting when the object last stopped.
   *
   * "Every admitted Turn reaches a durable terminal or resumable state" covers
   * a Turn that was admitted and never started too: the object can be evicted
   * between the Turn it superseded terminalizing and its own first step, and
   * this is what picks it up. It runs exactly once — the promotion is a
   * transaction, and a caller in this object already waiting for it is left to
   * do the promoting itself.
   */
  private async recoverQueuedRun(): Promise<void> {
    const pendingUserRunId =
      await this.ctx.storage.get<string>(PENDING_RUN_KEY);
    const pendingAgents = pendingUserRunId
      ? new Map<string, string>()
      : await this.ctx.storage.list<string>({
          prefix: PENDING_AGENT_RUN_PREFIX,
          limit: 1,
        });
    const pendingRunId =
      pendingUserRunId ?? pendingAgents.values().next().value;
    if (!pendingRunId || this.queuedWaiters.has(pendingRunId)) return;
    if (pendingRunId === this.executingRunId) return;
    const durableIdentity =
      await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    const promoted = await this.promoteQueuedRun(pendingRunId);
    if (typeof promoted === "string") return;
    if (!durableIdentity) throw new Error("Bot identity is unavailable");
    const run = await this.readRun(pendingRunId);
    if (!run) throw new Error(`run "${pendingRunId}" was not accepted`);
    await this.executeAcceptedRun(
      this.recoveredCommand(durableIdentity, run),
      promoted.previous,
      promoted.settings,
      promoted.compositionGenerationId,
    );
  }

  /** The command a durable run record replays as after eviction. */
  private recoveredCommand(
    identity: BotIdentity,
    run: StoredRunV1<Snapshot>,
  ): OwnedBotTurnCommand {
    return {
      userId: identity.userId,
      botId: identity.botId,
      runId: run.runId,
      sessionId: run.sessionId,
      acceptedAt: run.acceptedAt,
      text: run.input,
      turnType: storedRunTurnTypeV1(run),
      lane: storedRunLaneV1(run),
      ...(storedRunSubagentRoleV1(run)
        ? { subagentRole: storedRunSubagentRoleV1(run) }
        : {}),
      ...(run.admission?.origin ? { origin: run.admission.origin } : {}),
      ...(run.directTool ? { directTool: run.directTool } : {}),
    };
  }

  async recoverActiveRun(): Promise<void> {
    const activeRunId = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    if (!activeRunId) return this.recoverQueuedRun();
    if (activeRunId === this.executingRunId) return;
    const durableIdentity =
      await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    const key = `${RUN_PREFIX}${activeRunId}`;
    const recovery = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<string>(ACTIVE_RUN_KEY);
      if (!current || current === this.executingRunId) return undefined;
      const run = await this.readRunFrom(transaction, activeRunId);
      if (run?.status === "reconciliation-required") {
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (!run || run.status !== "running") {
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      const eventLog = new SessionEventLog(transaction);
      const latest = await eventLog.read(run.sessionId);
      // A Turn the User stopped, or one a later message replaced, is terminal
      // in intent before recovery ever looks at it. There is nothing to
      // recover: no answer is owed, and the provider outcome cannot change what
      // it settles as. Re-entering it is how the Worker died — the run resumed,
      // reached "Model response outcome is uncertain after cancellation", and
      // the alarm had nothing to hand the rejection to.
      //
      // `failStoredRun` routes a discarded run to `cancelStoredRun` or
      // `supersedeStoredRun` on the intent that is already durable, and closes
      // the open turn on the way, so the settled log is a complete account.
      if (runWasDiscardedV1(run)) {
        await failStoredRun(
          this.codec,
          transaction,
          this.terminalKeys(run.runId),
          run.runId,
          latest.slice(0, run.previousEventCount),
          run.events,
          DISCARDED_RUN_RECOVERY_FAILURE_V1,
          this.supersededPackageRecords(),
        );
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      const plan = planBotRunRecovery(
        run,
        latest,
        this.codec,
        this.hooks.providerReconciles ?? (() => true),
      );
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
          this.terminalPackageRecords(run.configurationSnapshot),
          this.supersededPackageRecords(),
        );
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "fail") {
        // The repairs matter when the failure is ADR 0028's: they close the
        // tool occurrences the restart left open, so the settled run's journal
        // is a complete account rather than one that stops mid-sentence twice.
        const events = plan.repairs
          ? [...run.events, ...plan.repairs]
          : run.events;
        await failStoredRun(
          this.codec,
          transaction,
          this.terminalKeys(run.runId),
          run.runId,
          latest.slice(0, run.previousEventCount),
          events,
          plan.failure,
          this.supersededPackageRecords(),
          this.failedRunNotification(),
        );
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "restart") {
        const settings = run.configurationSnapshot;
        await eventLog.rewrite(run.sessionId, plan.previous);
        await transaction.put(
          key,
          storedRunRecordV2({
            ...run,
            events: [],
            eventRange: {
              startSeq: plan.previous.length,
              endSeq: plan.previous.length,
            },
            previousEventCount: plan.previous.length,
            phase: "admitted",
          } satisfies StoredRunV1<Snapshot>),
        );
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
        await transaction.put(
          key,
          storedRunRecordV2({
            ...run,
            phase: "executing",
          } satisfies StoredRunV1<Snapshot>),
        );
        await this.refreshRecoveryAlarm(transaction);
        return { kind: "resume" as const, run, latest, settings };
      }
      await eventLog.append(run.sessionId, plan.repairs);
      await transaction.put(
        key,
        storedRunRecordV2({
          ...run,
          ...storedRunEventFieldsV2(run.previousEventCount, [
            ...run.events,
            ...plan.repairs,
          ]),
          status: "reconciliation-required",
          phase: "reconciliation-required",
          failure:
            "Execution outcome requires reconciliation before it can resume",
        } satisfies StoredRunV1<Snapshot>),
      );
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
        lane: storedRunLaneV1(recovery.run),
        ...(storedRunSubagentRoleV1(recovery.run)
          ? { subagentRole: storedRunSubagentRoleV1(recovery.run) }
          : {}),
        ...(recovery.run.admission?.origin
          ? { origin: recovery.run.admission.origin }
          : {}),
        ...(recovery.run.directTool
          ? { directTool: recovery.run.directTool }
          : {}),
      },
      recovery.previous,
      recovery.settings,
      recovery.run.compositionGenerationId,
    );
  }
}

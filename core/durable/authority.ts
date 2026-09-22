/// <reference types="@cloudflare/workers-types" />
// Durable Object authority for one Bot: command admission, the append-only
// event log, the resumable execution cursor, idempotency records, cancellation,
// serialization, and durable scheduling. Cloudflare types are the only host
// detail here; everything above them is Package policy behind narrow hooks.
import {
  decodeSessionEvent,
  emptyCommittedContextV1,
  TURN_DEADLINE_MS_V1,
  validateToolOccurrenceJournal,
  type CommittedContextV1,
  type NormalizedModelRequest,
  type SessionCursorV1,
  type SessionEvent,
} from "@frockbot/core/contracts";
import type { CompositionGenerationV1 } from "./composition/generation.js";
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
  type StoredRunAdmissionV1,
  unreadableStoredRunV1,
  type BotNotificationIntent,
  type BotTurnCommand,
  type BotTurnCompletion,
  type StoredRunCodecV1,
  type StoredRunV1,
  type UnreadableStoredRunV1,
} from "./run-records.js";
import {
  completeStoredRun,
  type TerminalPackageRecords,
  type SupersededPackageRecords,
  type FailedRunRecords,
  failStoredRun,
} from "./run-terminal.js";
import {
  eventsForFailedRun,
  latestModelRequestJournalState,
  planBotRunRecovery,
} from "./run-recovery.js";
import { readSessionCursorV1 } from "./working-context.js";
import {
  runLivenessV1,
  STALE_RUNNING_RUN_FAILURE_V1,
  STALE_RUNNING_RUN_GRACE_MS_V1,
} from "./run-liveness.js";

/** Liveness only asks whether a `turn/end` already closed the opened Turn. */
const SESSION_TURN_END_TYPES = new Set<string>(["turn/end"]);
import {
  SessionEventLog,
  type SessionEventLogStorage,
} from "./session-event-log.js";
import {
  BotTurnRecoveryRequiredError,
  BotTurnRefusedError,
} from "./turn-errors.js";
import { botConversationBaseSessionIdV1 } from "./conversations.js";
import {
  ACTIVE_RUN_KEY,
  MAINTENANCE_BATCH_V1,
  MAX_PENDING_AGENT_RUNS_V1,
  PENDING_AGENT_RUN_PREFIX,
  PENDING_RUN_KEY,
  IDENTITY_KEY,
  LATEST_EVENTS_KEY,
  MAX_RUN_ADMISSION_FENCES,
  NOTIFICATION_PREFIX,
  PUBLICATION_CURSOR_KEY,
  PUBLICATION_PENDING_PREFIX,
  RECOVERY_ALARM_DELAY_MS,
  REPAIR_DUE_PREFIX,
  RUN_ADMISSION_FENCE_INDEX_KEY,
  RUN_ADMISSION_FENCE_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  pendingAgentRunKey,
  publicationPendingKey,
  repairDueKey,
  repairRunKey,
  runIndexKey,
  storedRunAdmissionFences,
} from "./storage-keys.js";

function turnContextSeedV1(
  read: Awaited<ReturnType<typeof readSessionCursorV1>>,
  journal: readonly SessionEvent[],
): {
  cursor: SessionCursorV1;
  contextAvailability: "ready" | "empty" | "unavailable";
  contextReason?: string;
  context: CommittedContextV1;
  journal: readonly SessionEvent[];
} {
  if (read.availability === "unavailable") {
    return {
      cursor: read.cursor,
      contextAvailability: "unavailable",
      contextReason: read.reason,
      context: emptyCommittedContextV1(),
      journal,
    };
  }
  return {
    cursor: read.cursor,
    contextAvailability: read.availability,
    context: emptyCommittedContextV1(),
    journal,
  };
}

export interface BotIdentity {
  userId: string;
  botId: string;
}

export interface OwnedBotTurnCommand extends BotTurnCommand, BotIdentity {}

/** One admitted Turn, handed to the Package that owns the Composition. */
export interface BotTurnExecutionInput<Snapshot> {
  identity: BotIdentity;
  command: BotTurnCommand;
  /** Absolute allocation cursor. Not derived from an event array's length. */
  cursor: SessionCursorV1;
  /**
   * `empty` is a new log. `ready` has a projection. `unavailable` admits the
   * command and refuses to assemble a model request from a partial history.
   */
  contextAvailability: "ready" | "empty" | "unavailable";
  contextReason?: string;
  context: CommittedContextV1;
  /** Exact events already durable for this run. Empty when it has not appended. */
  journal: readonly SessionEvent[];
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
  /** Versions recorded at admission. The shell decodes them. */
  preparedInputs?: unknown;
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
  /**
   * Preparation resolved with the snapshot. Recorded on the run in the same
   * admission transaction. Opaque to the kernel.
   */
  preparedInputs?(snapshot: Snapshot): unknown;
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
  eventRecords?(input: {
    run: StoredRunV1<Snapshot>;
    events: readonly SessionEvent[];
    read<T>(key: string): Promise<T | undefined>;
  }): Promise<Record<string, unknown>>;
  eventsCommitted?(): void;
  /** Notification policy; `undefined` records no notification. */
  notification(
    snapshot: Snapshot,
    result: BotTurnCompletion,
  ): BotNotificationIntent | undefined;
  /**
   * What a Turn that ended `failed` leaves for the person, given the settings
   * the Turn was admitted under, its settled record, and a reader bound to
   * the settling transaction. The kernel writes the returned keys without
   * reading them; `{}` records nothing.
   *
   * The snapshot comes off the run itself rather than from a fresh read: a
   * failure settles on paths — recovery after a restart, the stale-run repair —
   * where nothing else has the settings to hand, and `configurationSnapshot` is
   * the durable copy of exactly the ones this Turn ran under.
   */
  failureRecords?(
    snapshot: Snapshot,
    failed: {
      runId: string;
      /** The stored diagnostic. Never shown to a person as it stands. */
      failure: string;
      events: readonly SessionEvent[];
      /**
       * The admission the failed Turn was accepted under. Carried because what
       * a failure owes depends on who asked for the Turn: only a delivery Turn
       * the alarm opened gives back what it drained and never delivered.
       */
      admission?: StoredRunAdmissionV1;
    },
    read: <T>(key: string) => Promise<T | undefined>,
  ): Promise<Record<string, unknown>>;
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
   * Deliver one bounded batch of committed publication outside a storage
   * transaction. Absent means there is no subscriber; the attempt still
   * completes so an idle object is not kept awake.
   */
  deliverPublication?(
    pending: readonly Record<string, unknown>[],
  ): Promise<void>;
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
}

/** What a `turn/end` records when a later user message took a Turn's place. */
export const SUPERSEDED_TURN_REASON_V1 = "superseded by a new user message";

/**
 * The Composition generation a run that was never admitted names. Admission is
 * what pins a generation, so a record written in its place pinned none, and it
 * says so rather than naming one it did not run on.
 */
const UNADMITTED_RUN_GENERATION_V1 = "unadmitted";

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
 * The intent the User expressed wins over anything recovery would otherwise do
 * with the run: it settles `cancelled` or `superseded` with everything it had
 * already said.
 */
function runWasDiscardedV1(
  run: { stopRequestedAt?: string; supersededAt?: string } | undefined,
): boolean {
  return Boolean(run?.stopRequestedAt || run?.supersededAt);
}

/**
 * One run as the display-only read boundary sees it: either the decoded
 * record, or the bounded identity of a record that could not be decoded.
 */
export type DisplayRunReadV1<Snapshot> =
  | { readonly readable: true; readonly run: StoredRunV1<Snapshot> }
  | { readonly readable: false; readonly run: UnreadableStoredRunV1 };

export interface BotDurableAuthorityOptions<Snapshot> {
  state: DurableObjectState;
  codec: StoredRunCodecV1<Snapshot>;
  hooks: BotDurableAuthorityHooks<Snapshot>;
  /**
   * When false, admission does not start the in-memory driver. The durable
   * alarm is still armed. Tests use this to model eviction in the gap between
   * the commit and the kick.
   */
  kickDriver?: boolean;
}

/** What admission returns once the command is durable. Not a completed Turn. */
export interface RunAdmissionReceiptV1 {
  schemaVersion: 1;
  runId: string;
  commandFingerprint: string;
  disposition: "admitted" | "queued" | "settled";
  completion?: BotTurnCompletion;
}

export class BotDurableAuthority<Snapshot> {
  readonly ctx: DurableObjectState;
  private readonly codec: StoredRunCodecV1<Snapshot>;
  private readonly hooks: BotDurableAuthorityHooks<Snapshot>;
  /**
   * The Composition records this object holds — on a Bot, the mirror of the
   * User's that the admission adopted; every admitted Turn pins the current
   * one (ADR 0026).
   */
  readonly composition: DurableCompositionStore;
  /**
   * Why a generation failed to activate, and whether it is quarantined —
   * against this object's own storage. Since the Composition moved to the
   * User (ADR 0026) no production path on a Bot reads this one: activation,
   * the settings views and `debugSnapshot` all go through
   * `compositionFailureLogV1` (`app/composition/bot.ts`) against the User's
   * log, which is the authority. This field survives for the test harnesses
   * that drive the authority directly.
   */
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
  /** The in-memory driver. The alarm is the wakeup if this never runs. */
  private driver: Promise<void> = Promise.resolve();
  private driving = false;
  private kickAgain = false;
  private readonly kickDriverEnabled: boolean;
  private resolveSettlement: (() => void) | undefined;
  private settlement: Promise<void> = Promise.resolve();
  /** Commands admitted in this isolate, so a fresh run keeps the caller's shape. */
  private readonly admittedCommands = new Map<string, OwnedBotTurnCommand>();
  private driverError: unknown;

  constructor(options: BotDurableAuthorityOptions<Snapshot>) {
    this.ctx = options.state;
    this.codec = options.codec;
    this.hooks = options.hooks;
    this.kickDriverEnabled = options.kickDriver !== false;
    this.composition = new DurableCompositionStore({
      state: options.state,
      bootstrap: () => options.hooks.bootstrapComposition(),
    });
    this.compositionFailures = new DurableCompositionFailureLog({
      state: options.state,
    });
  }

  /**
   * Admits the command and waits until that run is terminal.
   *
   * Completion-waiting callers — a Routine firing, a Bot asking another Bot —
   * use this. A person submitting a message uses {@link admit}, which returns
   * the receipt without waiting for the previous Turn's inference.
   */
  async run(input: OwnedBotTurnCommand): Promise<BotTurnCompletion> {
    const admitted = await this.admit(input);
    if (admitted.completion) return admitted.completion;
    return this.waitForRun(input.runId);
  }

  /**
   * Durably admits one command and kicks the single driver.
   *
   * The receipt is the acknowledgement. Execution of the previous Turn is not
   * on this path: the driver reconciles it, and the alarm does if the kick
   * never runs.
   */
  async admit(input: OwnedBotTurnCommand): Promise<RunAdmissionReceiptV1> {
    const command = input;
    await this.assertMatchingRunCommand(command);
    const replay = await this.settledReplayResult(command);
    const fingerprint = botTurnCommandFingerprintV1(command);
    if (replay) {
      return {
        schemaVersion: 1,
        runId: command.runId,
        commandFingerprint: fingerprint,
        disposition: "settled",
        completion: replay,
      };
    }
    const admission = await this.acceptRun(command);
    this.admittedCommands.set(command.runId, command);
    if (admission.kind === "queued" && admission.interrupt) {
      this.hooks.interruptTurn?.(
        admission.interrupt.runId,
        SUPERSEDED_TURN_REASON_V1,
      );
    }
    this.kickDriver();
    return {
      schemaVersion: 1,
      runId: command.runId,
      commandFingerprint: fingerprint,
      disposition: admission.kind === "queued" ? "queued" : "admitted",
    };
  }

  /** The in-memory driver, so a host can keep it alive after the receipt. */
  whenDriverSettled(): Promise<void> {
    return this.driver;
  }

  /**
   * Starts the single driver unless one is already running.
   *
   * The kick is an optimization. Admission has already armed the alarm, so a
   * crash before this runs still continues the recorded work.
   */
  private kickDriver(): void {
    if (!this.kickDriverEnabled) return;
    if (this.driving) {
      this.kickAgain = true;
      return;
    }
    this.driving = true;
    const work = this.driveLoop().finally(() => {
      this.driving = false;
      if (this.kickAgain) {
        this.kickAgain = false;
        this.kickDriver();
      }
    });
    this.driver = work;
  }

  private async driveLoop(): Promise<void> {
    this.driverError = undefined;
    try {
      for (let pass = 0; pass < MAINTENANCE_BATCH_V1; pass += 1) {
        this.kickAgain = false;
        if (this.executingRunId) {
          await this.settleExecutingActivity();
          continue;
        }
        await this.recoverActiveRun();
        if (!this.kickAgain && !(await this.hasOwedRun())) return;
      }
    } catch (error) {
      this.driverError = error;
      console.error(
        `Bot run driver failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.notifySettlement();
    }
  }

  private async hasOwedRun(): Promise<boolean> {
    const [active, pending, agents] = await Promise.all([
      this.ctx.storage.get<string>(ACTIVE_RUN_KEY),
      this.ctx.storage.get<string>(PENDING_RUN_KEY),
      this.ctx.storage.list<string>({
        prefix: PENDING_AGENT_RUN_PREFIX,
        limit: 1,
      }),
    ]);
    return Boolean(active || pending || agents.size > 0);
  }

  private armSettlement(): Promise<void> {
    if (!this.resolveSettlement) {
      this.settlement = new Promise((resolve) => {
        this.resolveSettlement = () => {
          this.resolveSettlement = undefined;
          resolve();
        };
      });
    }
    return this.settlement;
  }

  private notifySettlement(): void {
    this.resolveSettlement?.();
  }

  /** Waits until the named run is terminal. The driver performs the work. */
  private async waitForRun(runId: string): Promise<BotTurnCompletion> {
    for (let guard = 0; guard < 64; guard += 1) {
      const pending = this.armSettlement();
      const settled = await this.settledRunResult(runId);
      if (settled) return settled;
      if (!this.driving) {
        if (this.driverError) {
          const error = this.driverError;
          this.driverError = undefined;
          throw error;
        }
        this.kickDriver();
      }
      await pending;
    }
    throw new Error(`run "${runId}" did not settle`);
  }

  private async settledRunResult(
    runId: string,
  ): Promise<BotTurnCompletion | undefined> {
    const discarded = await this.settledTerminalRunResult(runId);
    if (discarded) return discarded;
    return this.terminalRunResult(runId);
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
   *
   * The Composition pin is recomputed here for the same reason. A queued Turn
   * is admitted but has not started, and "an in-flight Turn keeps its pinned
   * implementation" is about a Turn that is running, not one that is waiting.
   * The Turn ahead of it can author a Package or follow a deployment while it
   * waits, and pinning what the pointer said at admission ran the queued Turn
   * without the member that was just added — the tool the Bot had told the
   * person it had built.
   */
  private async promoteQueuedRun(runId: string): Promise<
    | "not-queued"
    | "blocked"
    | {
        seed: ReturnType<typeof turnContextSeedV1>;
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
      // The Turn starts from the projection cursor, so it sees conversation
      // that finished while it waited. The Composition, settings and catalogs
      // it was admitted under stay pinned; a later commit does not retarget a
      // Turn that was already accepted. Current revocations are enforced when
      // the effect is used, not by swapping the pin here.
      const seeded = await readSessionCursorV1(transaction, run.sessionId);
      const compositionGenerationId = run.compositionGenerationId;
      const promoted = this.codec.require({
        ...run,
        phase: "admitted",
        compositionGenerationId,
        previousEventCount: seeded.cursor.nextSeq,
        ...storedRunEventFieldsV2(seeded.cursor.nextSeq, []),
      } satisfies StoredRunV1<Snapshot>);
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
        seed: turnContextSeedV1(seeded, []),
        settings: promoted.configurationSnapshot,
        compositionGenerationId: promoted.compositionGenerationId,
      };
    });
  }

  /**
   * The completion a settled run reports once it has reached a terminal state
   * — whatever that state turned out to be. Anything still open is not this
   * method's to answer for.
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
    seed: ReturnType<typeof turnContextSeedV1>,
    settings: Snapshot,
    compositionGenerationId: string,
  ): Promise<BotTurnCompletion> {
    const activity = this.executeAdmittedRun(
      command,
      seed,
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
    seed: ReturnType<typeof turnContextSeedV1>,
    settings: Snapshot,
    compositionGenerationId: string,
  ): Promise<BotTurnCompletion> {
    this.executingRunId = command.runId;
    try {
      let preparedInputs: unknown;
      await this.ctx.storage.transaction(async (transaction) => {
        const key = `${RUN_PREFIX}${command.runId}`;
        const run = this.codec.optional(await transaction.get<unknown>(key));
        if (!run || run.status !== "running") {
          throw new Error(`run "${command.runId}" is not resumable`);
        }
        preparedInputs = run.preparedInputs;
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
        cursor: seed.cursor,
        contextAvailability: seed.contextAvailability,
        ...(seed.contextReason ? { contextReason: seed.contextReason } : {}),
        context: seed.context,
        journal: seed.journal,
        configurationSnapshot: settings,
        compositionGenerationId,
        ...(preparedInputs === undefined ? {} : { preparedInputs }),
        persistSessionEvents: (_sessionId, events) =>
          this.persistRunEvents(command.runId, events),
        resume: false,
      });
      const completed = this.withNotification(settings, result);
      await this.completeRun(command.runId, [], completed, settings);
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
      await this.failRun(command.runId, [], events, message);
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
    settings: Snapshot,
  ): Promise<BotTurnCompletion> {
    this.executingRunId = run.runId;
    this.codec.require(run);
    const seed = turnContextSeedV1(
      await readSessionCursorV1(this.ctx.storage, run.sessionId),
      run.events,
    );
    try {
      // The recorded request, not one rebuilt from today's context.
      const modelState = latestModelRequestJournalState(run.events);
      const result = await this.hooks.executeTurn({
        identity,
        command: {
          runId: run.runId,
          sessionId: run.sessionId,
          acceptedAt: run.acceptedAt,
          text: run.input,
          ...(run.retryOf ? { retryOf: run.retryOf } : {}),
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
        cursor: seed.cursor,
        contextAvailability: seed.contextAvailability,
        ...(seed.contextReason ? { contextReason: seed.contextReason } : {}),
        context: seed.context,
        journal: run.events,
        configurationSnapshot: settings,
        compositionGenerationId:
          run.mountedCompositionGenerationId ?? run.compositionGenerationId,
        ...(run.preparedInputs === undefined
          ? {}
          : { preparedInputs: run.preparedInputs }),
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
      await this.completeRun(run.runId, [], completed, settings);
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
      await this.failRun(run.runId, [], events, message);
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
    // Delivery of an already settled command replays its durable result. A
    // failed attempt was admitted too; another execution requires a fresh id
    // and explicit retryOf, never replaying its old command.
    if (
      run.status === "superseded" ||
      run.status === "cancelled" ||
      run.status === "failed"
    ) {
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
   * The terminal record of a Turn that was refused before it was ever
   * admitted.
   *
   * Admission is where a Turn becomes durable, so a command refused *by* it —
   * a fenced run, a Composition that would not resolve — left nothing behind
   * at all. For a person's message that is right: they are told the send
   * failed and can send it again. For a Routine firing there is nobody to tell
   * and nothing to retry, and the firing's own failure message needs a run to
   * belong to, because a run is what the conversation is made of.
   *
   * It is an honest record, not a simulated Turn: no session events, no
   * journal, no Composition pin, `failed` from the moment it is written. An
   * existing record for the same id is left exactly as it is — this only ever
   * fills the gap where admission wrote none.
   */
  async recordUnadmittedFailure(input: {
    command: OwnedBotTurnCommand;
    failure: string;
    snapshot: Snapshot;
  }): Promise<StoredRunV1<Snapshot> | undefined> {
    const { command } = input;
    const key = `${RUN_PREFIX}${command.runId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<unknown>(key)) !== undefined) {
        return this.codec.optional(await transaction.get<unknown>(key));
      }
      const run = this.codec.require({
        runId: command.runId,
        commandFingerprint: botTurnCommandFingerprintV1(command),
        sessionId: command.sessionId,
        acceptedAt: command.acceptedAt,
        input: command.text,
        events: [],
        eventRange: { startSeq: 0, endSeq: 0 },
        effectAdmissions: [],
        status: "failed",
        phase: "admitted",
        failure: input.failure,
        compositionGenerationId: UNADMITTED_RUN_GENERATION_V1,
        configurationSnapshot: structuredClone(input.snapshot),
        previousEventCount: 0,
        ...storedRunAdmissionV1(
          command.turnType,
          command.origin,
          command.subagentRole,
          command.lane,
        ),
      } satisfies StoredRunV1<Snapshot>);
      await transaction.put({
        [key]: structuredClone(storedRunRecordV2(run)),
        [runIndexKey(command.acceptedAt, command.runId)]: command.runId,
      });
      return run;
    });
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
      if (
        run.compositionGenerationId === compositionGenerationId ||
        run.mountedCompositionGenerationId === compositionGenerationId
      ) {
        return;
      }
      // The pin taken at admission stays the requested generation. Fallback
      // is a separate fact so recovery can mount what actually ran.
      await transaction.put(
        key,
        storedRunRecordV2({
          ...run,
          mountedCompositionGenerationId: compositionGenerationId,
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
    // Publication does not start a Turn. It has to move while a long Turn is
    // still executing, or a committed visible update waits out the inference.
    await this.drainPublication();
    await this.drainDueRepairs();
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

  /** The one conversational Session owned by this Bot. */
  async readConversationSessionId(): Promise<string | undefined> {
    const identity = await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
    return identity ? botConversationBaseSessionIdV1(identity) : undefined;
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

  /**
   * The record alone, for display, never throwing on a record it cannot read.
   *
   * The transcript is the one reader that must survive a bad row. Execution
   * and recovery stay strict — they act on the record, and acting on a record
   * nobody can decode is how a Turn gets settled twice — but a read that only
   * draws the conversation owes the person the other forty Turns. An
   * undecodable record comes back as {@link UnreadableStoredRunV1}: the run id
   * from the lookup key plus whatever scraped strings are safe, which is
   * enough to render exactly one degraded row.
   */
  async readRunHeaderForDisplay(
    runId: string,
  ): Promise<DisplayRunReadV1<Snapshot> | undefined> {
    const raw = await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${runId}`);
    if (raw === undefined) return undefined;
    try {
      return { readable: true, run: this.codec.require(raw) };
    } catch {
      return { readable: false, run: unreadableStoredRunV1(runId, raw) };
    }
  }

  /**
   * The journal behind a display header, degrading rather than throwing.
   *
   * Takes the header the caller already read rather than the run id: a
   * transcript page reads one record per candidate and hydrates only the ones
   * it keeps, and re-reading the record here would put that read back.
   */
  async hydrateRunForDisplay(
    header: DisplayRunReadV1<Snapshot>,
  ): Promise<DisplayRunReadV1<Snapshot>> {
    if (!header.readable) return header;
    try {
      return {
        readable: true,
        run: await this.hydrateRun(this.ctx.storage, header.run, "display"),
      };
    } catch {
      return {
        readable: false,
        run: unreadableStoredRunV1(header.run.runId, header.run),
      };
    }
  }

  /** {@link readRunHeaderForDisplay} with its journal hydrated. */
  async readStoredRunForDisplayOrDegraded(
    runId: string,
  ): Promise<DisplayRunReadV1<Snapshot> | undefined> {
    const header = await this.readRunHeaderForDisplay(runId);
    return header ? this.hydrateRunForDisplay(header) : undefined;
  }

  private async readRunFrom(
    storage: SessionEventLogStorage,
    runId: string,
    fidelity: "exact" | "display" = "exact",
  ): Promise<StoredRunV1<Snapshot> | undefined> {
    const run = this.codec.optional(
      await storage.get<unknown>(`${RUN_PREFIX}${runId}`),
    );
    if (!run) return undefined;
    return this.hydrateRun(storage, run, fidelity);
  }

  private async hydrateRun(
    storage: SessionEventLogStorage,
    run: StoredRunV1<Snapshot>,
    fidelity: "exact" | "display",
  ): Promise<StoredRunV1<Snapshot>> {
    if (!run.eventRange) return run;
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
   * Inline Session events of the given types, without hydrating cut payloads.
   *
   * Announcements and liveness only need a type, a seq, and a timestamp.
   * The exact model-request bytes stay on the audit path.
   */
  async readSessionInlineEventsOfTypes(
    sessionId: string,
    types: ReadonlySet<string>,
    startSeq = 0,
  ): Promise<SessionEvent[]> {
    return new SessionEventLog(this.ctx.storage).readInlineEventsOfTypes(
      sessionId,
      types,
      startSeq,
    );
  }

  /**
   * The bounded durable event projections for a run. This is the inspection
   * path: recovery, compaction and audit use `readStoredRun` and therefore
   * receive exact events, the transcript uses `readStoredRunForDisplay`, and a
   * debug snapshot never hydrates a multi-megabyte prompt merely to cut it
   * again.
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
    const sessionEvents = await new SessionEventLog(
      this.ctx.storage,
    ).readInlineEventsOfTypes(run.sessionId, SESSION_TURN_END_TYPES);
    // A read reports the committed record. Settling a stale Turn is the
    // alarm's repair index, not a side effect of drawing the activity ring.
    return runLivenessV1({ run, sessionEvents }).working;
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
      const eventLog = new SessionEventLog(transaction);
      const sessionEvents = await eventLog.readInlineEventsOfTypes(
        run.sessionId,
        SESSION_TURN_END_TYPES,
      );
      if (runLivenessV1({ run, sessionEvents }).working) return;
      await failStoredRun(
        this.codec,
        transaction,
        this.terminalKeys(runId),
        runId,
        [],
        run.events,
        STALE_RUNNING_RUN_FAILURE_V1,
        this.supersededPackageRecords(),
        this.failedRunRecords(),
      );
      await this.refreshRecoveryAlarm(transaction);
    });
  }

  private async clearRunRepair(
    transaction: DurableObjectTransaction,
    runId: string,
  ): Promise<void> {
    const due = await transaction.get<number>(repairRunKey(runId));
    await transaction.delete(repairRunKey(runId));
    if (typeof due === "number" && Number.isFinite(due)) {
      await transaction.delete(repairDueKey(due, runId));
    }
  }

  /**
   * Delivers a bounded batch of committed publication, then drops those
   * obligations. External delivery stays outside the storage transaction.
   * Returns whether further publication is still pending.
   */
  private async drainPublication(): Promise<boolean> {
    const pending = await this.ctx.storage.list<Record<string, unknown>>({
      prefix: PUBLICATION_PENDING_PREFIX,
      limit: MAINTENANCE_BATCH_V1,
    });
    if (pending.size === 0) return false;
    const keys = [...pending.keys()];
    try {
      await this.hooks.deliverPublication?.([...pending.values()]);
    } catch (error) {
      console.error(
        `Bot publication drain failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return true;
    }
    await this.ctx.storage.delete(keys);
    const more = await this.ctx.storage.list({
      prefix: PUBLICATION_PENDING_PREFIX,
      limit: 1,
    });
    return more.size > 0;
  }

  /**
   * Settles running records whose repair deadline has passed and that are not
   * the active Turn. The active Turn belongs to recovery, which still has to
   * reconcile it before any later Turn runs.
   */
  private async drainDueRepairs(): Promise<void> {
    const now = Date.now();
    const due = await this.ctx.storage.list<string>({
      prefix: REPAIR_DUE_PREFIX,
      limit: MAINTENANCE_BATCH_V1,
    });
    const active = await this.ctx.storage.get<string>(ACTIVE_RUN_KEY);
    for (const [key, runId] of due) {
      const dueAt = Number(
        key.slice(REPAIR_DUE_PREFIX.length, REPAIR_DUE_PREFIX.length + 16),
      );
      if (!Number.isFinite(dueAt) || dueAt > now) break;
      if (runId === this.executingRunId || runId === active) continue;
      const before = await this.readRunHeader(runId);
      if (!before || before.status !== "running") {
        await this.ctx.storage.delete([key, repairRunKey(runId)]);
        continue;
      }
      await this.settleStaleRun(runId);
      const after = await this.readRunHeader(runId);
      if (!after || after.status !== "running") {
        await this.ctx.storage.delete([key, repairRunKey(runId)]);
        this.notifySettlement();
      }
    }
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
    if (activeRunId) {
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
    const [repair, publication] = await Promise.all([
      transaction.list<string>({ prefix: REPAIR_DUE_PREFIX, limit: 1 }),
      transaction.list<unknown>({
        prefix: PUBLICATION_PENDING_PREFIX,
        limit: 1,
      }),
    ]);
    const repairKey = repair.keys().next().value as string | undefined;
    if (repairKey) {
      const due = Number(
        repairKey.slice(
          REPAIR_DUE_PREFIX.length,
          REPAIR_DUE_PREFIX.length + 16,
        ),
      );
      if (Number.isFinite(due)) deadlines.push(due);
    }
    // Committed publication is owed even while a Turn is executing. A past
    // or current cursor is due immediately; the drain bounds each pass.
    if (publication.size > 0) deadlines.push(Date.now());
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
        seed: ReturnType<typeof turnContextSeedV1>;
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
      let retryTarget: StoredRunV1<Snapshot> | undefined;
      if (command.retryOf !== undefined) {
        retryTarget = this.codec.optional(
          await transaction.get<unknown>(`${RUN_PREFIX}${command.retryOf}`),
        );
        if (
          command.retryOf === command.runId ||
          !retryTarget ||
          retryTarget.runId !== command.retryOf ||
          retryTarget.sessionId !== command.sessionId ||
          retryTarget.status !== "failed" ||
          retryTarget.retriedBy !== undefined ||
          storedRunTurnTypeV1(retryTarget) !== "chat" ||
          storedRunLaneV1(retryTarget) !== "user" ||
          retryTarget.admission?.origin !== undefined ||
          retryTarget.directTool !== undefined ||
          retryTarget.input !== command.text ||
          (command.turnType ?? "chat") !== "chat" ||
          (command.lane ?? "user") !== "user" ||
          command.origin !== undefined ||
          command.directTool !== undefined ||
          (command.skills?.length ?? 0) !== 0
        ) {
          throw new BotTurnRefusedError(
            "fenced",
            "This message is no longer available to retry. Refresh the conversation and try again.",
          );
        }
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
      // Sequence comes from the projection head. Loading the archive here
      // made every admission pay for every retained model request, and a
      // truncated copy of that archive is not a Session seed.
      const seeded = await readSessionCursorV1(transaction, command.sessionId);
      const admittedSettings = await this.hooks.admittedSnapshot(
        transaction,
        settings,
      );
      const preparedInputs = this.hooks.preparedInputs?.(settings);
      const pin = await this.composition.pin(transaction);
      const repairAt =
        Date.parse(command.acceptedAt) +
        TURN_DEADLINE_MS_V1 +
        STALE_RUNNING_RUN_GRACE_MS_V1;
      const publicationCursor =
        ((await transaction.get<number>(PUBLICATION_CURSOR_KEY)) ?? 0) + 1;
      const admittedRun = this.codec.require({
        runId: command.runId,
        commandFingerprint: botTurnCommandFingerprintV1(command),
        sessionId: command.sessionId,
        acceptedAt: command.acceptedAt,
        input: command.text,
        ...(retryTarget
          ? {
              retryOf: retryTarget.runId,
              messageRunId: retryTarget.messageRunId ?? retryTarget.runId,
              messageAdmittedAt:
                retryTarget.messageAdmittedAt ?? retryTarget.acceptedAt,
            }
          : {}),
        events: [],
        effectAdmissions: [],
        status: "running",
        // A queued Turn is admitted — durable, ordered, and owed a terminal
        // state — but has not started. Its `previousEventCount` is recomputed
        // when it is promoted, because the Turn ahead of it is still writing.
        phase: queued ? "queued" : "admitted",
        compositionGenerationId: pin.generationId,
        ...(preparedInputs === undefined ? {} : { preparedInputs }),
        configurationSnapshot: structuredClone(admittedSettings),
        previousEventCount: seeded.cursor.nextSeq,
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
        ...(retryTarget
          ? {
              [`${RUN_PREFIX}${retryTarget.runId}`]: storedRunRecordV2(
                this.codec.require({
                  ...retryTarget,
                  retriedBy: command.runId,
                }),
              ),
            }
          : {}),
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
        [PUBLICATION_CURSOR_KEY]: publicationCursor,
        [publicationPendingKey(publicationCursor)]: {
          schemaVersion: 1,
          cursor: publicationCursor,
          runId: command.runId,
          phase: queued ? "queued" : "admitted",
          status: "running",
        },
        [repairRunKey(command.runId)]: repairAt,
        [repairDueKey(repairAt, command.runId)]: command.runId,
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
        seed: turnContextSeedV1(seeded, []),
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
    const active = this.codec.optional(
      await transaction.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
    );
    if (!active)
      throw new BotTurnRefusedError("busy", "bot already has an active run");
    if (active.status !== "running") {
      throw new BotTurnRefusedError("busy", "bot already has an active run");
    }
    const pendingRunId = await transaction.get<string>(PENDING_RUN_KEY);
    // A Turn that has not dispatched a model request has no durable work to
    // lose, so it is left to finish and the new message queues behind it.
    // The header is enough: admission does not hydrate the journal to decide.
    const dispatched = active.hasModelIntent === true;
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
    await this.clearRunRepair(transaction, runId);
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
      // `append` owns the contiguity guard: it checks the same thing this
      // method used to pre-check, against the same index, before it writes
      // anything, and the whole body runs in one transaction. It goes first
      // so that a batch which does not continue the log is still refused for
      // that reason rather than by the run record's own range check.
      await eventLog.append(run.sessionId, durableEvents, { runId });
      const hasModelIntent =
        run.hasModelIntent === true ||
        durableEvents.some((event) => event.type === "model/request");
      const next = this.codec.require({
        ...run,
        ...storedRunEventFieldsV2(run.previousEventCount, [
          ...run.events,
          ...durableEvents,
        ]),
        ...(hasModelIntent ? { hasModelIntent: true as const } : {}),
      } satisfies StoredRunV1<Snapshot>);
      const records = await this.hooks.eventRecords?.({
        run: next,
        events: durableEvents,
        read: <T>(key: string) => transaction.get<T>(key),
      });
      if (records && Object.keys(records).length)
        await transaction.put(records);
      await transaction.put(key, structuredClone(storedRunRecordV2(next)));
      await this.refreshRecoveryAlarm(transaction);
    });
    this.hooks.eventsCommitted?.();
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

  /**
   * The Package's failed-Turn records hook, bound to the run's own durable
   * snapshot. Absent when the Package contributes none.
   */
  private failedRunRecords(): FailedRunRecords<Snapshot> | undefined {
    const hook = this.hooks.failureRecords;
    if (!hook) return undefined;
    return ({ run, read }) =>
      hook.call(
        this.hooks,
        run.configurationSnapshot,
        {
          runId: run.runId,
          failure: run.failure ?? "",
          events: run.events,
          admission: run.admission,
        },
        read,
      );
  }

  /** The Package's superseded-record hook, or `undefined` when it has none. */
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
      await this.clearRunRepair(transaction, runId);
    });
    this.notifySettlement();
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
        this.failedRunRecords(),
      );
      await this.refreshRecoveryAlarm(transaction);
      await this.clearRunRepair(transaction, runId);
    });
    this.notifySettlement();
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
      this.admittedCommands.get(pendingRunId) ??
        this.recoveredCommand(durableIdentity, run),
      promoted.seed,
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
      ...(run.retryOf ? { retryOf: run.retryOf } : {}),
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
      if (!run || run.status !== "running") {
        if (run) await this.clearRunRepair(transaction, run.runId);
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      const eventLog = new SessionEventLog(transaction);
      // Malformed legacy history must throw before any run rewrite. A paged
      // log is left unread: it was decoded when its pages were written.
      await eventLog.ensureLegacyLogDecodable(run.sessionId);
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
          [],
          run.events,
          DISCARDED_RUN_RECOVERY_FAILURE_V1,
          this.supersededPackageRecords(),
        );
        await this.clearRunRepair(transaction, run.runId);
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      const plan = planBotRunRecovery(run, run.events, this.codec);
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
          [],
          completed,
          this.terminalPackageRecords(run.configurationSnapshot),
          this.supersededPackageRecords(),
        );
        await this.clearRunRepair(transaction, run.runId);
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "fail") {
        await failStoredRun(
          this.codec,
          transaction,
          this.terminalKeys(run.runId),
          run.runId,
          [],
          run.events,
          plan.failure,
          this.supersededPackageRecords(),
          this.failedRunRecords(),
        );
        await this.clearRunRepair(transaction, run.runId);
        await this.refreshRecoveryAlarm(transaction);
        return undefined;
      }
      if (plan.kind === "restart") {
        const settings = run.configurationSnapshot;
        // Drop the run's suffix. Earlier events keep their sequence numbers.
        await eventLog.truncateSuffix(run.sessionId, run.previousEventCount);
        const seeded = await readSessionCursorV1(transaction, run.sessionId);
        await transaction.put(
          key,
          storedRunRecordV2({
            ...run,
            events: [],
            eventRange: {
              startSeq: run.previousEventCount,
              endSeq: run.previousEventCount,
            },
            previousEventCount: run.previousEventCount,
            phase: "admitted",
          } satisfies StoredRunV1<Snapshot>),
        );
        await this.refreshRecoveryAlarm(transaction);
        return {
          kind: "restart" as const,
          run,
          seed: turnContextSeedV1(seeded, []),
          settings,
        };
      }
      const settings = run.configurationSnapshot;
      await transaction.put(
        key,
        storedRunRecordV2({
          ...run,
          phase: "executing",
        } satisfies StoredRunV1<Snapshot>),
      );
      await this.refreshRecoveryAlarm(transaction);
      return {
        kind: "resume" as const,
        run,
        settings,
      };
    });
    if (!recovery) {
      this.notifySettlement();
      return;
    }
    if (!durableIdentity) throw new Error("Bot identity is unavailable");
    if (recovery.kind === "resume") {
      await this.executeResumedRun(
        durableIdentity,
        recovery.run,
        recovery.settings,
      );
      return;
    }
    await this.executeAcceptedRun(
      this.admittedCommands.get(recovery.run.runId) ?? {
        userId: durableIdentity.userId,
        botId: durableIdentity.botId,
        runId: recovery.run.runId,
        sessionId: recovery.run.sessionId,
        acceptedAt: recovery.run.acceptedAt,
        text: recovery.run.input,
        ...(recovery.run.retryOf ? { retryOf: recovery.run.retryOf } : {}),
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
      recovery.seed,
      recovery.settings,
      recovery.run.mountedCompositionGenerationId ??
        recovery.run.compositionGenerationId,
    );
  }
}

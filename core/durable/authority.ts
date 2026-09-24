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
  type BotTurnAdmission,
  type BotTurnCompletion,
  type StoredRunCodecV1,
  type StoredRunV1,
  type UnreadableStoredRunV1,
} from "./run-records.js";
import {
  completeStoredRun,
  type TerminalPackageRecords,
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
  PENDING_USER_RUN_PREFIX,
  MAX_PENDING_USER_RUNS_V1,
  IDENTITY_KEY,
  LATEST_EVENTS_KEY,
  MAX_RUN_ADMISSION_FENCES,
  NOTIFICATION_PREFIX,
  PUBLICATION_PENDING_PREFIX,
  RECOVERY_ALARM_DELAY_MS,
  REPAIR_DUE_PREFIX,
  RUN_ADMISSION_FENCE_INDEX_KEY,
  RUN_ADMISSION_FENCE_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  pendingAgentRunKey,
  pendingUserRunKey,
  repairDueKey,
  repairRunKey,
  runIndexKey,
  storedRunAdmissionFences,
} from "./storage-keys.js";
import {
  commitPublicationsV1,
  drainPendingPublicationV1,
  runEntityIdV1,
  type ConversationUpdateV1,
  type PublicationContributionV1,
} from "./publication.js";

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
  /**
   * Visible conversation updates for one committed change. Returned
   * contributions are written in the same transaction as the source record.
   */
  visiblePublications?(input: {
    cause: "admission" | "promotion" | "events" | "terminal";
    run: StoredRunV1<Snapshot>;
    events?: readonly SessionEvent[];
  }): Promise<PublicationContributionV1[]> | PublicationContributionV1[];
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
  deliverPublication?(pending: readonly ConversationUpdateV1[]): Promise<void>;
  /**
   * A run has reached a durable terminal state. Projections that used to ride
   * the composer's waiting POST — search, audit — happen here, because that
   * POST now returns at admission.
   */
  runSettled?(runId: string): Promise<void>;
}

/**
 * The Composition generation a run that was never admitted names. Admission is
 * what pins a generation, so a record written in its place pinned none, and it
 * says so rather than naming one it did not run on.
 */
const UNADMITTED_RUN_GENERATION_V1 = "unadmitted";

/** How many times a queued Turn tries to start before the caller gives up. */
const MAX_QUEUED_RUN_START_ATTEMPTS = 8;

/**
 * The failure a discarded Turn is settled with when recovery finds it.
 *
 * It is never read by anybody: `failStoredRun` routes a run carrying a Stop
 * intent to `cancelStoredRun`, which drops the failure — the User's own intent
 * is the outcome, not an error.
 */
const DISCARDED_RUN_RECOVERY_FAILURE_V1 =
  "Turn was discarded before recovery could resume it";

/**
 * True when this object has already durably decided to throw the Turn away.
 *
 * The Stop the User asked for wins over anything recovery would otherwise do
 * with the run: it settles `cancelled` with everything it had already said.
 */
function runWasDiscardedV1(
  run: { stopRequestedAt?: string } | undefined,
): boolean {
  return Boolean(run?.stopRequestedAt);
}

/**
 * The repair-index entries for a Turn that has just started.
 *
 * Its clock runs from its start, as the loop's own deadline does: a Turn
 * admitted straight into the active slot starts at its acceptance, and one that
 * waited in the queue starts at its promotion. A queued Turn has none: the
 * queue owes it its terminal state, and a deadline counted from admission would
 * fail a message for waiting behind a long Turn.
 */
function runRepairRecordsV1(
  runId: string,
  startedAt: number,
): Record<string, unknown> {
  const dueAt = startedAt + TURN_DEADLINE_MS_V1 + STALE_RUNNING_RUN_GRACE_MS_V1;
  return { [repairRunKey(runId)]: dueAt, [repairDueKey(dueAt, runId)]: runId };
}

/** The oldest entry of one pending queue, as `[key, runId]`. */
async function firstPendingRunV1(
  storage: {
    list<T>(options: {
      prefix: string;
      limit: number;
    }): Promise<Map<string, T>>;
  },
  prefix: string,
): Promise<[string, string] | undefined> {
  const listed = await storage.list<string>({ prefix, limit: 1 });
  return listed.entries().next().value;
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
   * The in-process settlement of the executing run. A queued Turn has to wait
   * for the one ahead of it to reach its durable terminal state before it can
   * start, and while this object is resident that settlement is a promise
   * rather than an alarm.
   */
  private executingActivity: Promise<unknown> | undefined;
  /**
   * Queued runs a caller in this object is already waiting to start. Recovery
   * leaves them alone, so a queued Turn is promoted by exactly one path.
   */
  private readonly queuedWaiters = new Set<string>();
  /** Tests set this false to model eviction between the commit and the kick. */
  private readonly kickDriverEnabled: boolean;
  /**
   * In-process execution of admitted work. The alarm is what survives
   * eviction; this promise is what starts the Turn without waiting for that
   * alarm, and what a completion-waiting caller awaits.
   */
  private drive: Promise<void> | undefined;
  /**
   * The recovery deferral the drive just recorded, so a completion-waiting
   * caller still hears it. The alarm owns the resume; the drive does not
   * retry that Turn in this isolate.
   */
  private driveError: Error | undefined;
  /**
   * Completion-waiting callers blocked on one run. Waking them is not the
   * same as the drive finishing: a later Turn may still be on that promise.
   */
  private readonly settledWaiters = new Map<string, Array<() => void>>();
  /**
   * The command this isolate admitted, so the first execution runs that
   * command. A reconstructed object has only the stored record, and recovery
   * mounts from that instead.
   */
  private readonly liveCommands = new Map<string, OwnedBotTurnCommand>();

  /** The drive currently settling admitted work, if this object is resident. */
  pendingWork(): Promise<void> | undefined {
    return this.drive;
  }

  /** The in-memory driver, so a host can keep it alive after the receipt. */
  whenDriverSettled(): Promise<void> {
    return this.drive ?? Promise.resolve();
  }

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
    const command = input;
    await this.admit(command);
    // Wait for this run only. The drive may already be executing a later
    // Turn, and a replay of a finished command must not wait for that.
    for (;;) {
      const settled = await this.completionOf(command.runId);
      if (settled) return settled;
      const run = await this.readRun(command.runId);
      if (
        this.driveError &&
        run?.status === "running" &&
        run.phase === "executing"
      ) {
        const deferred = this.driveError;
        this.driveError = undefined;
        throw deferred;
      }
      if (!run || run.status !== "running") break;
      if (run.phase === "queued" && !this.drive && !this.executingActivity) {
        return this.runQueuedRun(command);
      }
      const watch = this.waitSettled(command.runId);
      const becameSettled = await this.completionOf(command.runId);
      if (becameSettled) return becameSettled;
      await watch;
    }
    const again = await this.completionOf(command.runId);
    if (again) return again;
    throw new Error(`run "${command.runId}" did not settle`);
  }

  /**
   * Durably accepts a command and returns before execution finishes.
   *
   * The receipt means this object has the run, its queue position, and a
   * recovery alarm. An identical command returns that receipt again and does
   * not execute a second time. A different command on the same
   * id is refused, as is one whose admission was already fenced.
   */
  async admit(input: OwnedBotTurnCommand): Promise<RunAdmissionReceiptV1> {
    const command = input;
    await this.assertMatchingRunCommand(command);
    const existing = await this.readRun(command.runId);
    if (existing) {
      const receipt = await this.admissionReceipt(
        command,
        this.replayAdmission(command, existing),
      );
      await this.drainPublication();
      return receipt;
    }
    let accepted: Awaited<
      ReturnType<BotDurableAuthority<Snapshot>["acceptRun"]>
    >;
    try {
      accepted = await this.acceptRun(command);
    } catch (error) {
      const raced = await this.readRun(command.runId);
      if (
        raced &&
        raced.commandFingerprint === botTurnCommandFingerprintV1(command)
      ) {
        const receipt = await this.admissionReceipt(
          command,
          this.replayAdmission(command, raced),
        );
        await this.drainPublication();
        return receipt;
      }
      throw error;
    }
    this.liveCommands.set(command.runId, command);
    this.scheduleDrive(command.runId);
    await this.drainPublication();
    return this.admissionReceipt(command, {
      runId: command.runId,
      state: accepted.kind === "queued" ? "queued" : "running",
    });
  }

  private async admissionReceipt(
    command: OwnedBotTurnCommand,
    admission: BotTurnAdmission,
  ): Promise<RunAdmissionReceiptV1> {
    const completion =
      admission.state === "terminal"
        ? await this.completionOf(command.runId)
        : undefined;
    return {
      schemaVersion: 1,
      runId: admission.runId,
      commandFingerprint: botTurnCommandFingerprintV1(command),
      disposition:
        admission.state === "terminal"
          ? "settled"
          : admission.state === "queued"
            ? "queued"
            : "admitted",
      ...(completion ? { completion } : {}),
    };
  }

  private replayAdmission(
    command: OwnedBotTurnCommand,
    existing: StoredRunV1<Snapshot>,
  ): BotTurnAdmission {
    if (existing.commandFingerprint !== botTurnCommandFingerprintV1(command)) {
      throw new BotTurnRefusedError(
        "duplicate",
        `Turn idempotency key "${command.runId}" was reused for a different command`,
      );
    }
    const state: BotTurnAdmission["state"] =
      existing.status !== "running"
        ? "terminal"
        : existing.phase === "queued"
          ? "queued"
          : "running";
    // A replay must not execute again. Scheduling only reattaches work this
    // object is not already driving.
    if (state !== "terminal") {
      this.liveCommands.set(command.runId, command);
      this.scheduleDrive(command.runId);
    }
    return { runId: command.runId, state };
  }

  /**
   * Starts admitted work in this isolate and arms nothing the alarm does not
   * already cover. `waitUntil` keeps the isolate awake after the admission
   * response; eviction still resumes from the recovery alarm.
   */
  private scheduleDrive(runId: string): void {
    if (!this.kickDriverEnabled) return;
    const next = (this.drive ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.pumpUntil(runId))
      // The admission caller does not await this promise. A rejection after
      // the run has already settled would be unhandled.
      .catch(() => undefined);
    this.drive = next;
    void next.finally(() => {
      if (this.drive === next) this.drive = undefined;
      this.wakeSettledWaiters();
    });
    const waitUntil = (
      this.ctx as { waitUntil?: (promise: Promise<unknown>) => void }
    ).waitUntil;
    if (typeof waitUntil === "function") waitUntil.call(this.ctx, next);
  }

  /** Drives one admitted run to a terminal state, or leaves it for the alarm. */
  private async pumpUntil(runId: string): Promise<void> {
    for (let guard = 0; guard < 32; guard += 1) {
      if (await this.completionOf(runId)) return;
      const run = await this.readRun(runId);
      if (!run || run.status !== "running") return;
      if (this.executingRunId && this.executingActivity) {
        await this.executingActivity.catch(() => undefined);
        continue;
      }
      try {
        await this.recoverActiveRun();
      } catch (error) {
        const stalled = await this.readRun(runId);
        // Recovery already wrote the deferral and armed the alarm. Retrying
        // here would run the same Turn again in the isolate that just gave
        // it up.
        if (stalled?.status === "running" && stalled.phase === "executing") {
          this.driveError =
            error instanceof Error ? error : new Error(String(error));
          this.notifySettled(runId);
          return;
        }
      }
      if (await this.completionOf(runId)) return;
      if (this.executingActivity) {
        await this.executingActivity.catch(() => undefined);
        continue;
      }
      const stalled = await this.readRun(runId);
      if (stalled?.status === "running" && stalled.phase === "executing") {
        this.notifySettled(runId);
        return;
      }
    }
  }

  private waitSettled(runId: string): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.settledWaiters.get(runId) ?? [];
      waiters.push(resolve);
      this.settledWaiters.set(runId, waiters);
    });
  }

  private notifySettled(runId: string): void {
    const waiters = this.settledWaiters.get(runId);
    if (!waiters) return;
    this.settledWaiters.delete(runId);
    for (const wake of waiters) wake();
  }

  private wakeSettledWaiters(): void {
    const pending = [...this.settledWaiters.values()];
    this.settledWaiters.clear();
    for (const waiters of pending) {
      for (const wake of waiters) wake();
    }
  }

  private async completionOf(
    runId: string,
  ): Promise<BotTurnCompletion | undefined> {
    return (
      (await this.terminalRunResult(runId)) ??
      (await this.settledTerminalRunResult(runId))
    );
  }

  private async noteSettled(runId: string): Promise<void> {
    this.liveCommands.delete(runId);
    const hook = this.hooks.runSettled;
    if (hook) await hook.call(this.hooks, runId).catch(() => undefined);
    // After the projection. A completion caller that returned first would
    // read search and audit before this run's rows were written.
    this.notifySettled(runId);
  }

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
          // durable terminal or resumable state, and this one tries again.
          await this.recoverActiveRun().catch(() => undefined);
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
          promoted.seed,
          promoted.settings,
          promoted.compositionGenerationId,
        );
      }
      throw new Error(`run "${command.runId}" could not start`);
    } finally {
      this.queuedWaiters.delete(command.runId);
    }
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
      const users = await this.livePendingHead(
        transaction,
        PENDING_USER_RUN_PREFIX,
      );
      const agents = await this.livePendingHead(
        transaction,
        PENDING_AGENT_RUN_PREFIX,
      );
      if (users.pruned || agents.pruned) {
        await this.refreshRecoveryAlarm(transaction);
      }
      const firstPendingUser = users.head;
      const firstPendingAgentEntry = agents.head;
      const run = this.codec.optional(await transaction.get<unknown>(key));
      const lane = run ? storedRunLaneV1(run) : undefined;
      if (!run || run.status !== "running" || run.phase !== "queued") {
        return "not-queued" as const;
      }
      if (lane === "agent") {
        // A User Turn always has first claim on an idle Bot, and agent Turns
        // retain FIFO order behind it. The run is still queued in either case;
        // reporting `not-queued` here would strand its blocking caller even
        // though the durable queue entry remains.
        if (firstPendingUser !== undefined) return "blocked" as const;
        if (firstPendingAgentEntry?.[1] !== runId) {
          return firstPendingAgentEntry
            ? ("blocked" as const)
            : ("not-queued" as const);
        }
      } else if (firstPendingUser?.[1] !== runId) {
        // Users' messages keep their order: a later one waits for the one
        // ahead of it rather than starting first.
        return firstPendingUser
          ? ("blocked" as const)
          : ("not-queued" as const);
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
      await this.clearRunRepair(transaction, runId);
      await transaction.put({
        [key]: structuredClone(storedRunRecordV2(promoted)),
        [ACTIVE_RUN_KEY]: runId,
        ...runRepairRecordsV1(runId, Date.now()),
      });
      // A watching chat drew this Turn queued from its admission, and the
      // status it patches is the one publication carries: without this it
      // stays queued, with no working mark and no Stop, until it settles.
      await this.commitVisible(transaction, {
        cause: "promotion",
        run: promoted,
      });
      if (lane === "agent" && firstPendingAgentEntry) {
        await transaction.delete(firstPendingAgentEntry[0]);
      } else if (firstPendingUser) {
        await transaction.delete(firstPendingUser[0]);
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
   * The oldest entry of one pending queue whose run is still waiting to start.
   *
   * An entry ahead of it naming a run that will never start — settled, already
   * promoted, or gone — is deleted on the way. The head of the queue is what
   * every later Turn waits behind, and a dead head would hold them there for
   * good.
   */
  private async livePendingHead(
    transaction: DurableObjectTransaction,
    prefix: string,
  ): Promise<{ head?: [string, string]; pruned: boolean }> {
    let pruned = false;
    for (;;) {
      const head = await firstPendingRunV1(transaction, prefix);
      if (!head) return { pruned };
      const run = this.codec.optional(
        await transaction.get<unknown>(`${RUN_PREFIX}${head[1]}`),
      );
      if (run?.status === "running" && run.phase === "queued") {
        return { head, pruned };
      }
      await transaction.delete(head[0]);
      pruned = true;
    }
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
    if (run?.status !== "failed" && run?.status !== "cancelled") {
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
   * The completion a Turn the User stopped reports. It is not a failure: the
   * Turn settled durably, keeping everything it had already sent, and its
   * caller reads the rest of the conversation from durable state.
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
    if (run?.status !== "cancelled") return undefined;
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
    if (run?.status === "cancelled") {
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
          ...(run.attachments ? { attachments: run.attachments } : {}),
          ...(run.retryOf ? { retryOf: run.retryOf } : {}),
          // Recovery re-mounts on the recorded turn type, so the resumed Turn
          // sees the same trimmed catalog the evicted one did.
          turnType: storedRunTurnTypeV1(run),
          lane: storedRunLaneV1(run),
          ...(storedRunSubagentRoleV1(run)
            ? { subagentRole: storedRunSubagentRoleV1(run) }
            : {}),
          ...(run.admission?.origin ? { origin: run.admission.origin } : {}),
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
    if (run.status === "cancelled" || run.status === "failed") {
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
        ...(command.attachments && command.attachments.length > 0
          ? { attachments: structuredClone(command.attachments) }
          : {}),
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
    const [activeBeforeAlarm, pendingUser, pendingAgent] = await Promise.all([
      this.ctx.storage.get<string>(ACTIVE_RUN_KEY),
      firstPendingRunV1(this.ctx.storage, PENDING_USER_RUN_PREFIX),
      firstPendingRunV1(this.ctx.storage, PENDING_AGENT_RUN_PREFIX),
    ]);
    // An admitted Turn is work already owed. It runs before a due Routine;
    // otherwise a busy schedule can starve a Bot-to-Bot question indefinitely.
    if (!activeBeforeAlarm && (pendingUser || pendingAgent)) {
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

  /**
   * Whether the running Turn should end at this step boundary because a
   * person's message is waiting for it.
   *
   * Only a Turn on the user lane yields: one answering another Bot, the voice
   * session or a Routine finishes its own job, and the message runs next. The
   * Turn that yields ends completed, and the waiting message becomes the next
   * Turn with everything the Bot did so far in its context — so nothing in
   * flight is abandoned or sent twice.
   */
  async userMessageWaiting(runId: string): Promise<boolean> {
    if ((await this.ctx.storage.get<string>(ACTIVE_RUN_KEY)) !== runId) {
      return false;
    }
    const run = this.codec.optional(
      await this.ctx.storage.get<unknown>(`${RUN_PREFIX}${runId}`),
    );
    if (!run || run.status !== "running" || storedRunLaneV1(run) !== "user") {
      return false;
    }
    return (
      (await firstPendingRunV1(this.ctx.storage, PENDING_USER_RUN_PREFIX)) !==
      undefined
    );
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
   * Announcements and the stale-run repair only need a type, a seq, and a
   * timestamp.
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
   * Settles one run whose record says `running` and whose Turn is over.
   *
   * The verdict is taken inside the transaction, against the record and the
   * log as they are committed there, so a Turn that settled itself since the
   * repair came due is left exactly as it settled — and so is one that started
   * executing in this object, or was promoted into the active slot, in the
   * meantime. The active Turn is recovery's, and a promoted one that waited in
   * the queue already looks past its deadline to liveness, which counts from
   * admission. The settlement is `failStoredRun`, exactly as recovery's is,
   * which closes the open Turn in the log on the way, and its run-record write
   * is what publishes the `runs` invalidation watching clients re-read on.
   */
  private async settleStaleRun(runId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      if (runId === this.executingRunId) return;
      if ((await transaction.get<string>(ACTIVE_RUN_KEY)) === runId) return;
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
        this.failedRunRecords(),
      );
      const settled = await this.readRunFrom(transaction, runId);
      if (settled) {
        await this.commitVisible(transaction, {
          cause: "terminal",
          run: settled,
        });
      }
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
   * Delivers a bounded batch of committed publication, then advances
   * `broadcastThrough`. External delivery stays outside the storage
   * transaction. Returns whether further publication is still pending.
   */
  async drainCommittedPublication(): Promise<boolean> {
    return this.drainPublication();
  }

  private async drainPublication(): Promise<boolean> {
    return drainPendingPublicationV1(
      this.ctx.storage,
      async (updates) => {
        await this.hooks.deliverPublication?.(updates);
      },
      {
        refreshAlarm: (transaction) =>
          this.refreshRecoveryAlarm(
            transaction as unknown as DurableObjectTransaction,
          ),
      },
    );
  }

  private async commitVisible(
    transaction: DurableObjectTransaction,
    input: {
      cause: "admission" | "promotion" | "events" | "terminal";
      run: StoredRunV1<Snapshot>;
      events?: readonly SessionEvent[];
    },
  ): Promise<void> {
    const contributed = await this.hooks.visiblePublications?.(input);
    const contributions =
      contributed ??
      (input.cause === "events"
        ? []
        : [
            {
              kind: "run-status" as const,
              entityId: runEntityIdV1(input.run.runId),
              payload: {
                runId: input.run.runId,
                status: input.run.status,
                phase: input.run.phase,
              },
            },
          ]);
    await commitPublicationsV1(transaction, contributions);
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
      // A Turn still in the queue has not started, so it has no deadline to
      // miss; its promotion arms the repair.
      if (!before || before.status !== "running" || before.phase === "queued") {
        await this.ctx.storage.delete([key, repairRunKey(runId)]);
        continue;
      }
      await this.settleStaleRun(runId);
      await this.drainPublication();
      const after = await this.readRunHeader(runId);
      if (!after || after.status !== "running") {
        await this.ctx.storage.delete([key, repairRunKey(runId)]);
        await this.noteSettled(runId);
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
    const [activeRunId, scheduled, pendingUser, pendingAgent] =
      await Promise.all([
        transaction.get<string>(ACTIVE_RUN_KEY),
        this.hooks.scheduledDeadlines(transaction),
        firstPendingRunV1(transaction, PENDING_USER_RUN_PREFIX),
        firstPendingRunV1(transaction, PENDING_AGENT_RUN_PREFIX),
      ]);
    const activeRun = activeRunId
      ? this.codec.optional(
          await transaction.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
        )
      : undefined;
    const deadlines = [...scheduled];
    if (activeRunId) {
      deadlines.push(Date.now() + RECOVERY_ALARM_DELAY_MS);
    } else if (!activeRunId && (pendingUser || pendingAgent)) {
      // A Turn admitted and waiting is work this object owes, so it keeps the
      // recovery alarm even with nothing running.
      deadlines.push(Date.now() + RECOVERY_ALARM_DELAY_MS);
    }
    const [repairs, publication] = await Promise.all([
      // Past the active and the executing run, which differ only inside a
      // settlement, the next due is within three.
      transaction.list<string>({ prefix: REPAIR_DUE_PREFIX, limit: 3 }),
      transaction.list<unknown>({
        prefix: PUBLICATION_PENDING_PREFIX,
        limit: 1,
      }),
    ]);
    // The active Turn's repair is recovery's, which the deadline above already
    // keeps. `drainDueRepairs` skips it, so arming on its due time once passed
    // would fire the alarm back to back until the Turn settled.
    for (const [repairKey, runId] of repairs) {
      if (runId === activeRunId || runId === this.executingRunId) continue;
      const due = Number(
        repairKey.slice(
          REPAIR_DUE_PREFIX.length,
          REPAIR_DUE_PREFIX.length + 16,
        ),
      );
      if (Number.isFinite(due)) deadlines.push(due);
      break;
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
    | { kind: "queued" }
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
    // The cursor below is the paged head. A legacy blob has to become that
    // head first, or the Turn numbers from zero and the blob never moves.
    await this.ctx.storage.transaction(async (transaction) => {
      await new SessionEventLog(transaction).migrateLegacyBlobIfPresent(
        command.sessionId,
      );
    });
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
          retryTarget.input !== command.text ||
          // A retry is the same message, and the files are part of it.
          (retryTarget.attachments ?? [])
            .map((item) => item.uploadId)
            .join(",") !==
            (command.attachments ?? [])
              .map((item) => item.uploadId)
              .join(",") ||
          (command.turnType ?? "chat") !== "chat" ||
          (command.lane ?? "user") !== "user" ||
          command.origin !== undefined ||
          (command.skills?.length ?? 0) !== 0
        ) {
          throw new BotTurnRefusedError(
            "fenced",
            "This message is no longer available to retry. Refresh the conversation and try again.",
          );
        }
      }
      const activeRunId = await transaction.get<string>(ACTIVE_RUN_KEY);
      const lane = command.lane ?? defaultRunLaneV1(command.turnType ?? "chat");
      const [pendingUsers, pendingAgents] = await Promise.all([
        transaction.list<string>({ prefix: PENDING_USER_RUN_PREFIX }),
        transaction.list<string>({ prefix: PENDING_AGENT_RUN_PREFIX }),
      ]);
      const hasPendingUser = pendingUsers.size > 0;
      const hasPendingAgent = pendingAgents.size > 0;
      if (
        lane === "background" &&
        (activeRunId || hasPendingUser || hasPendingAgent)
      ) {
        throw new BotTurnRefusedError(
          "busy",
          activeRunId
            ? "bot already has an active run"
            : "bot has queued conversational work",
        );
      }
      // A person's message never replaces what is running. It waits, in
      // order, and a chat Turn ends at its next step boundary to read it.
      const queued =
        Boolean(activeRunId) ||
        hasPendingUser ||
        (lane === "agent" && hasPendingAgent);
      if (
        lane === "user" &&
        queued &&
        pendingUsers.size >= MAX_PENDING_USER_RUNS_V1
      ) {
        throw new BotTurnRefusedError(
          "busy",
          `bot message queue is full (${MAX_PENDING_USER_RUNS_V1} messages)`,
        );
      }
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
      // Where a message sent while a Turn runs landed, in that Turn's own
      // Session: a Routine firing keeps a log of its own. Every event the Turn
      // has committed sits below the cursor, everything it says from here on
      // at or above it, and a send is committed the moment it is made.
      const running = activeRunId
        ? this.codec.optional(
            await transaction.get<unknown>(`${RUN_PREFIX}${activeRunId}`),
          )
        : undefined;
      const landedAt = running
        ? {
            runId: running.runId,
            seq:
              running.sessionId === command.sessionId
                ? seeded.cursor.nextSeq
                : (await readSessionCursorV1(transaction, running.sessionId))
                    .cursor.nextSeq,
          }
        : undefined;
      const admittedSettings = await this.hooks.admittedSnapshot(
        transaction,
        settings,
      );
      const preparedInputs = this.hooks.preparedInputs?.(settings);
      const pin = await this.composition.pin(transaction);
      const admittedRun = this.codec.require({
        runId: command.runId,
        commandFingerprint: botTurnCommandFingerprintV1(command),
        sessionId: command.sessionId,
        acceptedAt: command.acceptedAt,
        input: command.text,
        ...(command.attachments && command.attachments.length > 0
          ? { attachments: structuredClone(command.attachments) }
          : {}),
        ...(retryTarget
          ? {
              retryOf: retryTarget.runId,
              messageRunId: retryTarget.messageRunId ?? retryTarget.runId,
              messageAdmittedAt:
                retryTarget.messageAdmittedAt ?? retryTarget.acceptedAt,
            }
          : {}),
        ...(retryTarget
          ? retryTarget.landedAt
            ? { landedAt: structuredClone(retryTarget.landedAt) }
            : {}
          : landedAt
            ? { landedAt }
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
            : {
                [pendingUserRunKey(command.acceptedAt, command.runId)]:
                  command.runId,
              }
          : {
              [ACTIVE_RUN_KEY]: command.runId,
              ...runRepairRecordsV1(
                command.runId,
                Date.parse(command.acceptedAt),
              ),
            }),
        [IDENTITY_KEY]: identity ?? {
          userId: command.userId,
          botId: command.botId,
        },
      });
      await this.commitVisible(transaction, {
        cause: "admission",
        run: admittedRun,
      });
      await this.refreshRecoveryAlarm(transaction);
      if (queued) return { kind: "queued" as const };
      return {
        kind: "active" as const,
        seed: turnContextSeedV1(seeded, []),
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
      const run = await this.readRunFrom(transaction, runId);
      if (!run) throw new Error(`run "${runId}" was not accepted`);
      const eventLog = new SessionEventLog(transaction);
      // `append` owns the contiguity guard: it checks the same thing this
      // method used to pre-check, against the same index, before it writes
      // anything, and the whole body runs in one transaction. It goes first
      // so that a batch which does not continue the log is still refused for
      // that reason rather than by the run record's own range check.
      await eventLog.append(run.sessionId, durableEvents, { runId });
      const next = this.codec.require({
        ...run,
        ...storedRunEventFieldsV2(run.previousEventCount, [
          ...run.events,
          ...durableEvents,
        ]),
      } satisfies StoredRunV1<Snapshot>);
      const records = await this.hooks.eventRecords?.({
        run: next,
        events: durableEvents,
        read: <T>(key: string) => transaction.get<T>(key),
      });
      if (records && Object.keys(records).length)
        await transaction.put(records);
      await transaction.put(key, structuredClone(storedRunRecordV2(next)));
      await this.commitVisible(transaction, {
        cause: "events",
        run: next,
        events: durableEvents,
      });
      await this.refreshRecoveryAlarm(transaction);
    });
    this.hooks.eventsCommitted?.();
    await this.drainPublication();
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
      );
      const settled = await this.readRunFrom(transaction, runId);
      if (settled) {
        await this.commitVisible(transaction, {
          cause: "terminal",
          run: settled,
        });
      }
      await this.refreshRecoveryAlarm(transaction);
      await this.clearRunRepair(transaction, runId);
    });
    await this.drainPublication();
    await this.noteSettled(runId);
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
        this.failedRunRecords(),
      );
      const settled = await this.readRunFrom(transaction, runId);
      if (settled) {
        await this.commitVisible(transaction, {
          cause: "terminal",
          run: settled,
        });
      }
      await this.refreshRecoveryAlarm(transaction);
      await this.clearRunRepair(transaction, runId);
    });
    await this.drainPublication();
    await this.noteSettled(runId);
  }

  /**
   * Starts the Turn that was waiting when the object last stopped.
   *
   * "Every admitted Turn reaches a durable terminal or resumable state" covers
   * a Turn that was admitted and never started too: the object can be evicted
   * between the Turn ahead of it terminalizing and its own first step, and
   * this is what picks it up. It runs exactly once — the promotion is a
   * transaction, and a caller in this object already waiting for it is left to
   * do the promoting itself.
   */
  private async recoverQueuedRun(): Promise<void> {
    // A head naming a run that will never start is pruned by the promotion
    // that finds it, and the Turn behind it starts in the same pass.
    for (
      let attempt = 0;
      attempt <= MAX_PENDING_USER_RUNS_V1 + MAX_PENDING_AGENT_RUNS_V1;
      attempt += 1
    ) {
      const pendingRunId = ((await firstPendingRunV1(
        this.ctx.storage,
        PENDING_USER_RUN_PREFIX,
      )) ??
        (await firstPendingRunV1(
          this.ctx.storage,
          PENDING_AGENT_RUN_PREFIX,
        )))?.[1];
      if (!pendingRunId || this.queuedWaiters.has(pendingRunId)) return;
      if (pendingRunId === this.executingRunId) return;
      const durableIdentity =
        await this.ctx.storage.get<BotIdentity>(IDENTITY_KEY);
      const promoted = await this.promoteQueuedRun(pendingRunId);
      if (promoted === "not-queued") continue;
      if (promoted === "blocked") return;
      if (!durableIdentity) throw new Error("Bot identity is unavailable");
      const run = await this.readRun(pendingRunId);
      if (!run) throw new Error(`run "${pendingRunId}" was not accepted`);
      await this.executeAcceptedRun(
        this.executionCommand(durableIdentity, run),
        promoted.seed,
        promoted.settings,
        promoted.compositionGenerationId,
      );
      return;
    }
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
      ...(run.attachments ? { attachments: run.attachments } : {}),
      ...(run.retryOf ? { retryOf: run.retryOf } : {}),
      turnType: storedRunTurnTypeV1(run),
      lane: storedRunLaneV1(run),
      ...(storedRunSubagentRoleV1(run)
        ? { subagentRole: storedRunSubagentRoleV1(run) }
        : {}),
      ...(run.admission?.origin ? { origin: run.admission.origin } : {}),
    };
  }

  /**
   * Prefers the command this isolate admitted. Recovery after eviction has
   * only the stored record, which names chat explicitly.
   */
  private executionCommand(
    identity: BotIdentity,
    run: StoredRunV1<Snapshot>,
  ): OwnedBotTurnCommand {
    return (
      this.liveCommands.get(run.runId) ?? this.recoveredCommand(identity, run)
    );
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
      // A Turn the User stopped is terminal in intent before recovery ever
      // looks at it. There is nothing to recover: no answer is owed, and the
      // provider outcome cannot change what it settles as. Re-entering it is how the Worker died — the run resumed,
      // reached "Model response outcome is uncertain after cancellation", and
      // the alarm had nothing to hand the rejection to.
      //
      // `failStoredRun` routes a discarded run to `cancelStoredRun` on the
      // intent that is already durable, and closes the open turn on the way,
      // so the settled log is a complete account.
      if (runWasDiscardedV1(run)) {
        await failStoredRun(
          this.codec,
          transaction,
          this.terminalKeys(run.runId),
          run.runId,
          [],
          run.events,
          DISCARDED_RUN_RECOVERY_FAILURE_V1,
        );
        const settled = await this.readRunFrom(transaction, run.runId);
        if (settled) {
          await this.commitVisible(transaction, {
            cause: "terminal",
            run: settled,
          });
        }
        await this.clearRunRepair(transaction, run.runId);
        await this.refreshRecoveryAlarm(transaction);
        return { kind: "settled" as const, runId: run.runId };
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
        );
        const settled = await this.readRunFrom(transaction, run.runId);
        if (settled) {
          await this.commitVisible(transaction, {
            cause: "terminal",
            run: settled,
          });
        }
        await this.clearRunRepair(transaction, run.runId);
        await this.refreshRecoveryAlarm(transaction);
        return { kind: "settled" as const, runId: run.runId };
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
          this.failedRunRecords(),
        );
        const settled = await this.readRunFrom(transaction, run.runId);
        if (settled) {
          await this.commitVisible(transaction, {
            cause: "terminal",
            run: settled,
          });
        }
        await this.clearRunRepair(transaction, run.runId);
        await this.refreshRecoveryAlarm(transaction);
        return { kind: "settled" as const, runId: run.runId };
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
      await this.drainPublication();
      return;
    }
    if (recovery.kind === "settled") {
      await this.drainPublication();
      await this.noteSettled(recovery.runId);
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
      this.executionCommand(durableIdentity, recovery.run),
      recovery.seed,
      recovery.settings,
      recovery.run.mountedCompositionGenerationId ??
        recovery.run.compositionGenerationId,
    );
  }
}

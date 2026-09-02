// The Subagents authority: the parent Bot Durable Object's durable task records.
//
// ADR 0017 puts the whole of a task's authority here — admission, the bounds,
// the pinned Composition generation and model binding, the lifecycle, and the
// terminal outcome — and leaves the Subagent Durable Object holding only its
// own Session. This class is that authority's implementation; the Durable
// Object hands it a storage seam and calls it.
//
// Two rules it enforces and nothing else does:
//
//  * Intent before effect. `admit` writes the task record, the active key, the
//    index row and (for `computerUse`) the lease intent in one transaction,
//    *before* any Subagent Durable Object is addressed. A dispatch that dies
//    between the two is a task the parent can see and reconcile, never a child
//    running with nothing to answer for it.
//  * Settling is idempotent on `taskId`. A child that calls back twice, or a
//    reconciliation that races the child's own callback, records one outcome.

import {
  decodeTaskDesktopLeaseIntentV1,
  decodeTaskMessageRecordV1,
  decodeTaskRecordV1,
  isTaskIdV1,
  isTerminalTaskStatusV1,
  migrateStoredTaskRecordV1,
  SubagentDecodeError,
  TASK_CONCURRENCY_PER_BOT_V1,
  TASK_DEADLINE_MS_V1,
  TASK_MAX_DEPTH_V1,
  TASK_MESSAGE_QUEUE_LIMIT_V1,
  taskDesktopLeaseOwnerV1,
  type TaskDesktopLeaseIntentV1,
  type TaskMessageRecordV1,
  type TaskModelV1,
  type TaskOutcomeV1,
  type TaskRecordV1,
  type TaskTypeV1,
} from "./records.js";
import {
  nextTaskIndexSequenceV1,
  TASK_ACTIVE_PREFIX,
  TASK_DESKTOP_LEASE_KEY,
  TASK_INDEX_LIMIT,
  TASK_INDEX_PREFIX,
  TASK_PREFIX,
  taskActiveKeyV1,
  taskAnchorIdV1,
  taskIndexKeyV1,
  taskKeyV1,
  taskMessageKeyV1,
  taskMessagePrefixV1,
  taskSessionIdV1,
  taskStopKeyV1,
} from "./storage-keys.js";
import {
  taskViewV1,
  TASK_LIST_LIMIT_V1,
  type TaskListViewV1,
} from "./shared.js";

/** The reads a task listing needs. */
export interface TaskStorageReadsV1 {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}

/** The writes one transaction performs. */
export interface TaskStorageWritesV1 extends TaskStorageReadsV1 {
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** The Durable Object storage seam. `DurableObjectStorage` satisfies it. */
export interface TaskStorageV1 extends TaskStorageWritesV1 {
  transaction<T>(
    closure: (transaction: TaskStorageWritesV1) => Promise<T>,
  ): Promise<T>;
}

/** A task this Bot does not hold. */
export class TaskNotFoundError extends Error {
  override readonly name = "TaskNotFoundError";
  constructor(taskId: string) {
    super(`task "${taskId}" is unknown`);
  }
}

/** What one dispatch asks the authority to admit. */
export interface TaskAdmissionRequestV1 {
  taskId: string;
  type: TaskTypeV1;
  description: string;
  promptDigest: string;
  model: TaskModelV1;
  compositionGenerationId: string;
  background: boolean;
  attachments: string[];
  dispatch: { runId: string; turnId: string; sessionId: string };
  resumedFrom?: string;
  /**
   * The task whose Subagent Durable Object and Session this run executes in.
   * Absent on a first dispatch, where it is the task itself; present on a
   * resume, because "a new run in the same child" is what resuming means.
   */
  anchorTaskId?: string;
  now: Date;
}

export type TaskAdmissionV1 =
  | { status: "admitted"; record: TaskRecordV1 }
  | { status: "replayed"; record: TaskRecordV1 }
  | { status: "refused"; reason: string };

interface StoredTaskIndexRowV1 {
  schemaVersion: 1;
  taskId: string;
}

export class TaskStore {
  readonly #storage: TaskStorageV1;

  constructor(storage: TaskStorageV1) {
    this.#storage = storage;
  }

  /**
   * Admits one task, or refuses it.
   *
   * The per-Bot bound is counted from `task-active:*` rather than from the task
   * records, because that set is exactly the tasks that are holding something:
   * a settled task's record stays for the list and its active key is gone.
   */
  async admit(request: TaskAdmissionRequestV1): Promise<TaskAdmissionV1> {
    if (!isTaskIdV1(request.taskId)) {
      return { status: "refused", reason: "task id is invalid" };
    }
    return this.#storage.transaction(async (transaction) => {
      const key = taskKeyV1(request.taskId);
      const existing = await transaction.get<unknown>(key);
      if (existing !== undefined) {
        // A resumed Turn re-executing the same tool call reads its own task
        // back rather than dispatching a second child.
        return {
          status: "replayed",
          record: decodeStoredTaskRecordV1(existing),
        };
      }
      const active = await transaction.list<unknown>({
        prefix: TASK_ACTIVE_PREFIX,
      });
      if (active.size >= TASK_CONCURRENCY_PER_BOT_V1) {
        return {
          status: "refused",
          reason: `this Bot already has ${active.size} subagents running; the bound is ${TASK_CONCURRENCY_PER_BOT_V1}. Wait for one to finish.`,
        };
      }
      // One `computerUse` task at a time, because the screen is shared. The
      // durable check is here, before anything is written; the User-wide
      // serializer is the Computer host's own lease, acquired next.
      if (request.type === "computerUse") {
        const held = await this.#heldDesktopLease(transaction, request.now);
        if (held && held.taskId !== request.taskId) {
          return {
            status: "refused",
            reason: desktopHeldReasonV1(held),
          };
        }
      }
      const createdAt = request.now.toISOString();
      const record: TaskRecordV1 = decodeTaskRecordV1({
        schemaVersion: 1,
        taskId: request.taskId,
        type: request.type,
        description: request.description,
        promptDigest: request.promptDigest,
        model: request.model,
        compositionGenerationId: request.compositionGenerationId,
        background: request.background,
        // Depth is one by construction: `Task` is admitted on chat and
        // automation turns only, so a `subagent` Turn is never offered it.
        depth: TASK_MAX_DEPTH_V1,
        status: "queued",
        dispatch: request.dispatch,
        childSessionId: taskSessionIdV1(request.anchorTaskId ?? request.taskId),
        attachments: request.attachments,
        ...(request.resumedFrom === undefined
          ? {}
          : { resumedFrom: request.resumedFrom }),
        createdAt,
        deadlineAt: new Date(
          request.now.getTime() + TASK_DEADLINE_MS_V1,
        ).toISOString(),
      });
      await transaction.put(key, record);
      await transaction.put(taskActiveKeyV1(record.taskId), {
        schemaVersion: 1,
        taskId: record.taskId,
      });
      await this.#appendIndex(transaction, record.taskId);
      if (record.type === "computerUse") {
        // Intent before effect: this task is durably the one that asked for the
        // desktop *before* the Computer host is asked for the lease, so an
        // acquire that lands and is then lost is read back rather than
        // repeated, and a settle knows what to release.
        await transaction.put(TASK_DESKTOP_LEASE_KEY, {
          schemaVersion: 1,
          taskId: record.taskId,
          scope: "desktop-gui",
          recordedAt: createdAt,
        } satisfies TaskDesktopLeaseIntentV1);
      }
      return { status: "admitted", record };
    });
  }

  async #appendIndex(
    transaction: TaskStorageWritesV1,
    taskId: string,
  ): Promise<void> {
    const rows = await transaction.list<StoredTaskIndexRowV1>({
      prefix: TASK_INDEX_PREFIX,
    });
    const seq = nextTaskIndexSequenceV1([...rows.keys()]);
    await transaction.put(taskIndexKeyV1(seq), {
      schemaVersion: 1,
      taskId,
    } satisfies StoredTaskIndexRowV1);
    // Trimming loses an index row, never a task record: the record is the fact
    // and the row is a convenience over it.
    const keys = [...rows.keys()].sort();
    for (const stale of keys.slice(TASK_INDEX_LIMIT - 1)) {
      await transaction.delete(stale);
    }
  }

  /** Moves an admitted task to `running`. A task already settled is left alone. */
  async markRunning(taskId: string): Promise<TaskRecordV1> {
    return this.#storage.transaction(async (transaction) => {
      const record = await this.#require(transaction, taskId);
      if (record.status !== "queued") return record;
      const running: TaskRecordV1 = { ...record, status: "running" };
      await transaction.put(taskKeyV1(taskId), running);
      return running;
    });
  }

  /**
   * The desktop lease as it stands, or `undefined` when nothing holds it.
   *
   * A lease is *held* while the task that recorded it is still live and its
   * host expiry has not passed. An intent whose task has settled, or a lease
   * the host has already let lapse, holds nothing: the desktop is free and the
   * next dispatch takes it.
   */
  async #heldDesktopLease(
    transaction: TaskStorageReadsV1,
    now: Date,
  ): Promise<TaskDesktopLeaseIntentV1 | undefined> {
    const stored = await transaction.get<unknown>(TASK_DESKTOP_LEASE_KEY);
    if (stored === undefined) return undefined;
    let lease: TaskDesktopLeaseIntentV1;
    try {
      lease = decodeTaskDesktopLeaseIntentV1(stored);
    } catch {
      return undefined;
    }
    if (lease.expiresAt && Date.parse(lease.expiresAt) <= now.getTime()) {
      return undefined;
    }
    const holder = await transaction.get<unknown>(taskKeyV1(lease.taskId));
    if (holder === undefined) return undefined;
    try {
      if (isTerminalTaskStatusV1(decodeStoredTaskRecordV1(holder).status)) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return lease;
  }

  /** What holds the desktop right now, for a refusal that can name it. */
  async desktopLease(
    now = new Date(),
  ): Promise<TaskDesktopLeaseIntentV1 | undefined> {
    return this.#heldDesktopLease(this.#storage, now);
  }

  /**
   * Records that the host granted the desktop to this task, on the key the
   * intent was written under. A lease the record no longer names is not
   * recorded: the task settled while the acquire was in flight, and the
   * release that settle performs is the truthful next act.
   */
  async recordDesktopLease(
    botId: string,
    taskId: string,
    expiresAt: string | undefined,
  ): Promise<TaskDesktopLeaseIntentV1 | undefined> {
    return this.#storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(TASK_DESKTOP_LEASE_KEY);
      if (stored === undefined) return undefined;
      const intent = decodeTaskDesktopLeaseIntentV1(stored);
      if (intent.taskId !== taskId) return undefined;
      const acquired: TaskDesktopLeaseIntentV1 = {
        ...intent,
        ownerId: taskDesktopLeaseOwnerV1(botId, taskId),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      await transaction.put(TASK_DESKTOP_LEASE_KEY, acquired);
      return acquired;
    });
  }

  /**
   * Drops the lease record this task holds and answers what it held, so the
   * caller can hand the host its release. A lease another task holds is left
   * exactly where it is.
   */
  async releaseDesktopLease(
    taskId: string,
  ): Promise<TaskDesktopLeaseIntentV1 | undefined> {
    return this.#storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(TASK_DESKTOP_LEASE_KEY);
      if (stored === undefined) return undefined;
      let intent: TaskDesktopLeaseIntentV1;
      try {
        intent = decodeTaskDesktopLeaseIntentV1(stored);
      } catch {
        await transaction.delete(TASK_DESKTOP_LEASE_KEY);
        return undefined;
      }
      if (intent.taskId !== taskId) return undefined;
      await transaction.delete(TASK_DESKTOP_LEASE_KEY);
      return intent;
    });
  }

  /**
   * Records one terminal outcome, releases the per-Bot slot, and drops the
   * desktop lease intent when this task is the one holding it.
   *
   * Idempotent on `taskId`: a second settle reads the recorded outcome back.
   */
  async settle(
    taskId: string,
    outcome: TaskOutcomeV1,
  ): Promise<{ status: "settled" | "replayed"; record: TaskRecordV1 }> {
    return this.#storage.transaction(async (transaction) => {
      const record = await this.#require(transaction, taskId);
      if (isTerminalTaskStatusV1(record.status)) {
        return { status: "replayed" as const, record };
      }
      const settled: TaskRecordV1 = decodeTaskRecordV1({
        ...record,
        status: outcome.status,
        outcome,
      });
      await transaction.put(taskKeyV1(taskId), settled);
      await transaction.delete(taskActiveKeyV1(taskId));
      await transaction.delete(taskStopKeyV1(taskId));
      // A queued message a settled task will never read is not history; it is
      // an unbounded queue nobody drains.
      const queued = await transaction.list<unknown>({
        prefix: taskMessagePrefixV1(taskId),
      });
      for (const key of queued.keys()) await transaction.delete(key);
      const lease = await transaction.get<{ taskId?: unknown }>(
        TASK_DESKTOP_LEASE_KEY,
      );
      if (lease && lease.taskId === taskId) {
        await transaction.delete(TASK_DESKTOP_LEASE_KEY);
      }
      return { status: "settled" as const, record: settled };
    });
  }

  /**
   * Appends one message to a running task's bounded queue.
   *
   * Refused unless the task is `running`: a queued task has not opened its
   * Session yet and a settled one will never read again, and in both cases a
   * silent append would be a message the Bot believes it sent.
   */
  async appendMessage(
    taskId: string,
    message: string,
    now: Date,
  ): Promise<
    | { status: "queued"; record: TaskMessageRecordV1; depth: number }
    | { status: "refused"; reason: string }
  > {
    return this.#storage.transaction(async (transaction) => {
      let record: TaskRecordV1;
      try {
        record = await this.#require(transaction, taskId);
      } catch (error) {
        if (error instanceof TaskNotFoundError) {
          return { status: "refused" as const, reason: error.message };
        }
        throw error;
      }
      if (record.status !== "running") {
        return {
          status: "refused" as const,
          reason:
            record.status === "queued"
              ? `task "${taskId}" has not started yet; it cannot be messaged until it is running`
              : `task "${taskId}" is ${record.status} and can no longer be messaged`,
        };
      }
      const prefix = taskMessagePrefixV1(taskId);
      const queued = await transaction.list<unknown>({ prefix });
      // The bound is on what is *waiting*. A message the child has already
      // read is history, not queue depth, so a long-lived subagent can be told
      // more than sixteen things over its life.
      const waiting = [...queued.values()].filter(
        (value) => decodeTaskMessageRecordV1(value).deliveredAt === undefined,
      ).length;
      if (waiting >= TASK_MESSAGE_QUEUE_LIMIT_V1) {
        return {
          status: "refused" as const,
          reason: `task "${taskId}" already has ${waiting} messages waiting; the bound is ${TASK_MESSAGE_QUEUE_LIMIT_V1}`,
        };
      }
      let seq = 0;
      for (const key of queued.keys()) {
        const encoded = Number(key.slice(prefix.length));
        if (Number.isSafeInteger(encoded)) seq = Math.max(seq, encoded + 1);
      }
      const queuedRecord = decodeTaskMessageRecordV1({
        schemaVersion: 1,
        taskId,
        seq,
        message,
        createdAt: now.toISOString(),
      });
      await transaction.put(taskMessageKeyV1(taskId, seq), queuedRecord);
      return {
        status: "queued" as const,
        record: queuedRecord,
        depth: waiting + 1,
      };
    });
  }

  /** The messages on one task, oldest first, delivered ones included. */
  async messages(taskId: string): Promise<TaskMessageRecordV1[]> {
    const stored = await this.#storage.list<unknown>({
      prefix: taskMessagePrefixV1(taskId),
    });
    return [...stored.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => decodeTaskMessageRecordV1(value));
  }

  /** The messages still waiting to reach the child, oldest first. */
  async pendingMessages(taskId: string): Promise<TaskMessageRecordV1[]> {
    return (await this.messages(taskId)).filter(
      (message) => message.deliveredAt === undefined,
    );
  }

  /**
   * Hands the child every message it has not yet read, and marks them read in
   * the same transaction.
   *
   * This is the act that makes the queue a queue. A `task_message` that is
   * appended and never drained is semantically an empty queue — GrokBot's
   * `MessageSubagent` influences the *running* child — so the child claims
   * here on its way into a step and folds what it gets into that step's
   * inputs.
   *
   * Claiming marks rather than deletes, so the delivery is idempotent under
   * retry: a second claim reads the marks back and hands the child nothing.
   * The messages stay until the task settles, which is when the queue is
   * dropped wholesale.
   */
  async claimMessages(
    taskId: string,
    now: Date,
  ): Promise<TaskMessageRecordV1[]> {
    return this.#storage.transaction(async (transaction) => {
      const prefix = taskMessagePrefixV1(taskId);
      const stored = await transaction.list<unknown>({ prefix });
      const claimed: TaskMessageRecordV1[] = [];
      for (const [key, value] of [...stored.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        let message: TaskMessageRecordV1;
        try {
          message = decodeTaskMessageRecordV1(value);
        } catch {
          // A message that cannot be decoded is not handed to a model.
          await transaction.delete(key);
          continue;
        }
        if (message.deliveredAt !== undefined) continue;
        const delivered: TaskMessageRecordV1 = {
          ...message,
          deliveredAt: now.toISOString(),
        };
        await transaction.put(key, delivered);
        claimed.push(delivered);
      }
      return claimed;
    });
  }

  /**
   * Records the durable intent to cancel one task, before the child is asked.
   *
   * Idempotent: a second stop reads the first intent back, so a retried
   * cancellation never becomes two. A task already terminal is refused, because
   * cancelling something that has settled would rewrite an outcome.
   */
  async requestStop(
    taskId: string,
    now: Date,
    requestedBy: "bot" | "user",
  ): Promise<
    | { status: "requested" | "replayed"; record: TaskRecordV1 }
    | { status: "refused"; reason: string }
  > {
    return this.#storage.transaction(async (transaction) => {
      let record: TaskRecordV1;
      try {
        record = await this.#require(transaction, taskId);
      } catch (error) {
        if (error instanceof TaskNotFoundError) {
          return { status: "refused" as const, reason: error.message };
        }
        throw error;
      }
      if (isTerminalTaskStatusV1(record.status)) {
        return {
          status: "refused" as const,
          reason: `task "${taskId}" is already ${record.status}`,
        };
      }
      const key = taskStopKeyV1(taskId);
      if ((await transaction.get<unknown>(key)) !== undefined) {
        return { status: "replayed" as const, record };
      }
      await transaction.put(key, {
        schemaVersion: 1,
        taskId,
        requestedBy,
        requestedAt: now.toISOString(),
      });
      return { status: "requested" as const, record };
    });
  }

  /** Whether a cancellation has been recorded for one task. */
  async stopRequested(taskId: string): Promise<boolean> {
    return (
      (await this.#storage.get<unknown>(taskStopKeyV1(taskId))) !== undefined
    );
  }

  /**
   * The task a resume runs in the child of. Refuses a task that is still
   * running (`docs/research/grokbot-computer.md` l.469–470): `resume` names a
   * *finished* subagent, and resuming a live one would put two Turns in one
   * Session.
   */
  async resumable(
    taskId: string,
  ): Promise<
    | { status: "resumable"; record: TaskRecordV1; anchorTaskId: string }
    | { status: "refused"; reason: string }
  > {
    let record: TaskRecordV1;
    try {
      record = await this.read(taskId);
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        return { status: "refused", reason: error.message };
      }
      throw error;
    }
    if (!isTerminalTaskStatusV1(record.status)) {
      return {
        status: "refused",
        reason: `task "${taskId}" is still ${record.status}; resume names a subagent that has finished`,
      };
    }
    return {
      status: "resumable",
      record,
      anchorTaskId: taskAnchorIdV1(record.childSessionId),
    };
  }

  async #require(
    reads: TaskStorageReadsV1,
    taskId: string,
  ): Promise<TaskRecordV1> {
    if (!isTaskIdV1(taskId)) throw new TaskNotFoundError(String(taskId));
    const stored = await reads.get<unknown>(taskKeyV1(taskId));
    if (stored === undefined) throw new TaskNotFoundError(taskId);
    return decodeStoredTaskRecordV1(stored);
  }

  async read(taskId: string): Promise<TaskRecordV1> {
    return this.#require(this.#storage, taskId);
  }

  /** The tasks still holding a slot, newest last. */
  async active(): Promise<TaskRecordV1[]> {
    const keys = await this.#storage.list<unknown>({
      prefix: TASK_ACTIVE_PREFIX,
    });
    const records: TaskRecordV1[] = [];
    for (const key of keys.keys()) {
      const taskId = key.slice(TASK_ACTIVE_PREFIX.length);
      try {
        records.push(await this.#require(this.#storage, taskId));
      } catch (error) {
        // An active key with no record is a torn write, not a task. It is
        // dropped from the answer and left visible in storage rather than
        // silently repaired here, where there is no transaction to repair in.
        if (
          !(error instanceof TaskNotFoundError) &&
          !(error instanceof SubagentDecodeError)
        ) {
          throw error;
        }
      }
    }
    return records;
  }

  /**
   * The deadlines this Package contributes to the object's one durable alarm.
   * A child that died mid-run is asked by the parent when its deadline comes
   * due; it is never re-dispatched.
   */
  async deadlines(): Promise<number[]> {
    return (await this.active()).map((record) => Date.parse(record.deadlineAt));
  }

  /** The Bot-level task list, newest first. */
  async list(botId: string): Promise<TaskListViewV1> {
    const rows = await this.#storage.list<StoredTaskIndexRowV1>({
      prefix: TASK_INDEX_PREFIX,
      limit: TASK_LIST_LIMIT_V1,
    });
    const tasks = [];
    for (const row of rows.values()) {
      if (!row || typeof row !== "object" || !isTaskIdV1(row.taskId)) continue;
      try {
        tasks.push(taskViewV1(await this.#require(this.#storage, row.taskId)));
      } catch (error) {
        if (
          !(error instanceof TaskNotFoundError) &&
          !(error instanceof SubagentDecodeError)
        ) {
          throw error;
        }
      }
    }
    const active = await this.#storage.list<unknown>({
      prefix: TASK_ACTIVE_PREFIX,
    });
    return { schemaVersion: 1, botId, active: active.size, tasks };
  }

  /** Every stored task record, for a probe or a rebuild. Bounded by the index. */
  async all(): Promise<TaskRecordV1[]> {
    const stored = await this.#storage.list<unknown>({ prefix: TASK_PREFIX });
    const records: TaskRecordV1[] = [];
    for (const [key, value] of stored) {
      // `task:` is a prefix of `task-active:` in neither direction — the
      // separator differs — but list is a byte-range scan, so be exact.
      if (!key.startsWith(TASK_PREFIX)) continue;
      records.push(decodeStoredTaskRecordV1(value));
    }
    return records;
  }
}

function decodeStoredTaskRecordV1(stored: unknown): TaskRecordV1 {
  return decodeTaskRecordV1(migrateStoredTaskRecordV1(stored));
}

/**
 * The typed refusal a second `computerUse` dispatch reads.
 *
 * It names the holder, because "the desktop is busy" is not something a Bot
 * can act on and "task X holds it until T" is: the Bot can check that task,
 * message it, or stop it.
 */
export function desktopHeldReasonV1(lease: {
  taskId: string;
  expiresAt?: string;
}): string {
  const until = lease.expiresAt
    ? ` until ${lease.expiresAt}`
    : " and has not reported an expiry";
  return `the desktop is held by task "${lease.taskId}"${until}; only one computerUse subagent may run at a time because the screen is shared`;
}

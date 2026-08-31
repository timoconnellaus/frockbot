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
  decodeTaskRecordV1,
  isTaskIdV1,
  isTerminalTaskStatusV1,
  SubagentDecodeError,
  TASK_CONCURRENCY_PER_BOT_V1,
  TASK_DEADLINE_MS_V1,
  TASK_MAX_DEPTH_V1,
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
  taskIndexKeyV1,
  taskKeyV1,
  taskSessionIdV1,
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
        return { status: "replayed", record: decodeTaskRecordV1(existing) };
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
        childSessionId: taskSessionIdV1(request.taskId),
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
        // The lease intent is recorded before the dispatch and before any host
        // call. Acquiring the lease itself is G3's; what is durable today is
        // that this task is the one that asked for the desktop.
        await transaction.put(TASK_DESKTOP_LEASE_KEY, {
          schemaVersion: 1,
          taskId: record.taskId,
          scope: "desktop-gui",
          recordedAt: createdAt,
        });
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
      const lease = await transaction.get<{ taskId?: unknown }>(
        TASK_DESKTOP_LEASE_KEY,
      );
      if (lease && lease.taskId === taskId) {
        await transaction.delete(TASK_DESKTOP_LEASE_KEY);
      }
      return { status: "settled" as const, record: settled };
    });
  }

  async #require(
    reads: TaskStorageReadsV1,
    taskId: string,
  ): Promise<TaskRecordV1> {
    if (!isTaskIdV1(taskId)) throw new TaskNotFoundError(String(taskId));
    const stored = await reads.get<unknown>(taskKeyV1(taskId));
    if (stored === undefined) throw new TaskNotFoundError(taskId);
    return decodeTaskRecordV1(stored);
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
      records.push(decodeTaskRecordV1(value));
    }
    return records;
  }
}

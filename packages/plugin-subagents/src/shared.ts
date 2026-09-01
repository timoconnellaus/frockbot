// The DTOs the task surface crosses seams with, and their exact codecs.
//
// A view is projected from a `TaskRecordV1` and carries strictly less: no
// prompt, no binding secrets, no child transcript. A child Session never enters
// the visible transcript at all (ADR 0017 — the child is an execution host, and
// its Session is its own durable state), so this list is the only door onto a
// task and it is deliberately a narrow one.

import {
  isTaskIdV1,
  subagentExactKeys,
  subagentText,
  subagentTimestamp,
  SubagentDecodeError,
  TASK_DESCRIPTION_MAX_V1,
  TASK_STATUSES_V1,
  TASK_SUMMARY_MAX_V1,
  TASK_TYPES_V1,
  type TaskRecordV1,
  type TaskStatusV1,
  type TaskTypeV1,
} from "./records.js";

/** Most rows one task-list answer carries. */
export const TASK_LIST_LIMIT_V1 = 50;

export interface TaskViewV1 {
  schemaVersion: 1;
  taskId: string;
  type: TaskTypeV1;
  description: string;
  status: TaskStatusV1;
  model: string;
  background: boolean;
  createdAt: string;
  deadlineAt: string;
  settledAt?: string;
  summary?: string;
  failure?: string;
}

export interface TaskListViewV1 {
  schemaVersion: 1;
  botId: string;
  active: number;
  tasks: TaskViewV1[];
}

/** The view one durable record projects onto. Never the reverse. */
export function taskViewV1(record: TaskRecordV1): TaskViewV1 {
  return {
    schemaVersion: 1,
    taskId: record.taskId,
    type: record.type,
    description: record.description,
    status: record.status,
    model: record.model.slug,
    background: record.background,
    createdAt: record.createdAt,
    deadlineAt: record.deadlineAt,
    ...(record.outcome === undefined
      ? {}
      : {
          settledAt: record.outcome.settledAt,
          ...(record.outcome.summary === undefined
            ? {}
            : { summary: record.outcome.summary }),
          ...(record.outcome.failure === undefined
            ? {}
            : { failure: record.outcome.failure }),
        }),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubagentDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function decodeTaskViewV1(
  value: unknown,
  label = "task view",
): TaskViewV1 {
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    [
      "schemaVersion",
      "taskId",
      "type",
      "description",
      "status",
      "model",
      "background",
      "createdAt",
      "deadlineAt",
    ],
    ["settledAt", "summary", "failure"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new SubagentDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isTaskIdV1(candidate.taskId)) {
    throw new SubagentDecodeError(`${label} taskId is invalid`);
  }
  const type = TASK_TYPES_V1.find((known) => known === candidate.type);
  if (!type) throw new SubagentDecodeError(`${label} type is invalid`);
  const status = TASK_STATUSES_V1.find((known) => known === candidate.status);
  if (!status) throw new SubagentDecodeError(`${label} status is invalid`);
  if (typeof candidate.background !== "boolean") {
    throw new SubagentDecodeError(`${label} background must be a boolean`);
  }
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    type,
    description: subagentText(
      candidate.description,
      TASK_DESCRIPTION_MAX_V1,
      `${label}.description`,
    ),
    status,
    model: subagentText(candidate.model, 512, `${label}.model`),
    background: candidate.background,
    createdAt: subagentTimestamp(candidate.createdAt, `${label}.createdAt`),
    deadlineAt: subagentTimestamp(candidate.deadlineAt, `${label}.deadlineAt`),
    ...(candidate.settledAt === undefined
      ? {}
      : {
          settledAt: subagentTimestamp(
            candidate.settledAt,
            `${label}.settledAt`,
          ),
        }),
    ...(candidate.summary === undefined
      ? {}
      : {
          summary: subagentText(
            candidate.summary,
            TASK_SUMMARY_MAX_V1,
            `${label}.summary`,
          ),
        }),
    ...(candidate.failure === undefined
      ? {}
      : {
          failure: subagentText(
            candidate.failure,
            TASK_SUMMARY_MAX_V1,
            `${label}.failure`,
          ),
        }),
  };
}

export function decodeTaskListViewV1(value: unknown): TaskListViewV1 {
  const label = "task list";
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    ["schemaVersion", "botId", "active", "tasks"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new SubagentDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    !Number.isSafeInteger(candidate.active) ||
    (candidate.active as number) < 0
  ) {
    throw new SubagentDecodeError(`${label} active is invalid`);
  }
  if (!Array.isArray(candidate.tasks)) {
    throw new SubagentDecodeError(`${label} tasks must be an array`);
  }
  if (candidate.tasks.length > TASK_LIST_LIMIT_V1) {
    throw new SubagentDecodeError(`${label} carries too many tasks`);
  }
  return {
    schemaVersion: 1,
    botId: subagentText(candidate.botId, 128, `${label}.botId`),
    active: candidate.active as number,
    tasks: candidate.tasks.map((entry, index) =>
      decodeTaskViewV1(entry, `${label}.tasks[${index}]`),
    ),
  };
}

/** The dispatch one `Task` call becomes, once the tool input has been decoded. */
export interface TaskDispatchReceiptV1 {
  schemaVersion: 1;
  status: "dispatched";
  taskId: string;
  model: string;
  background: boolean;
}

export function decodeTaskDispatchReceiptV1(
  value: unknown,
): TaskDispatchReceiptV1 {
  const label = "task dispatch receipt";
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    ["schemaVersion", "status", "taskId", "model", "background"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new SubagentDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (candidate.status !== "dispatched") {
    throw new SubagentDecodeError(`${label} status is invalid`);
  }
  if (!isTaskIdV1(candidate.taskId)) {
    throw new SubagentDecodeError(`${label} taskId is invalid`);
  }
  if (typeof candidate.background !== "boolean") {
    throw new SubagentDecodeError(`${label} background must be a boolean`);
  }
  return {
    schemaVersion: 1,
    status: "dispatched",
    taskId: candidate.taskId,
    model: subagentText(candidate.model, 512, `${label}.model`),
    background: candidate.background,
  };
}

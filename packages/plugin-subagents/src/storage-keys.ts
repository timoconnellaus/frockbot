// The Bot Durable Object storage keys the Subagents Package owns.
//
// They live here rather than in `@frockbot/kernel-do` because the kernel
// imports no Package and holds no product policy; the Durable Object hands this
// Package a storage seam and this module decides what it writes under.
//
// Every key below is *parent* state. ADR 0017: the parent Bot Durable Object is
// the authority for a task — admission, bounds, leases, lifecycle, terminal
// outcome — and the Subagent Durable Object holds only its own Session.

import { TASK_ID_MAX_V1 } from "./records.js";

/** One `TaskRecordV1`. */
export const TASK_PREFIX = "task:";
/**
 * The membership set that *is* the per-Bot concurrency counter. Written in the
 * same transaction that writes the record, deleted in the one that settles it,
 * so counting keys and reading records can never disagree.
 */
export const TASK_ACTIVE_PREFIX = "task-active:";
/** One bounded queue of pending `task_message` payloads (G2 drains them). */
export const TASK_MESSAGE_PREFIX = "task-msg:";
/**
 * The durable intent to cancel one task: written before the child is asked to
 * stop, so an interrupted `task_stop` is read back rather than repeated, and
 * deleted by the settle that makes the cancellation terminal.
 */
export const TASK_STOP_PREFIX = "task-stop:";
/** The `computerUse` desktop-lease intent: the effect named before the host call. */
export const TASK_DESKTOP_LEASE_KEY = "task-lease:desktop";
/** The bounded reverse index the Bot-level task list reads, newest first. */
export const TASK_INDEX_PREFIX = "task-index:";
/** The task index's monotonic sequence, addressable by key alone. */
export const TASK_INDEX_CURSOR_KEY = "task-index-cursor";

/**
 * The child Durable Object's own record of what it was handed. It is the only
 * key in this module written in the *child* object, and it is deliberately not
 * authority: it records the parent, the pinned Composition generation, and the
 * pinned binding so a child that is asked what it is doing can answer without
 * the parent telling it again.
 */
export const TASK_CONTEXT_PREFIX = "task-context:";

/** Most index rows retained. Trimming loses an index row, never a task record. */
export const TASK_INDEX_LIMIT = 100;

const SEQUENCE_CEILING = 1_000_000_000;

function requireTaskId(taskId: string): string {
  if (
    typeof taskId !== "string" ||
    taskId.length === 0 ||
    taskId.length > TASK_ID_MAX_V1 ||
    taskId.includes(":")
  ) {
    throw new Error("task id is invalid");
  }
  return taskId;
}

export function taskKeyV1(taskId: string): string {
  return `${TASK_PREFIX}${requireTaskId(taskId)}`;
}

export function taskActiveKeyV1(taskId: string): string {
  return `${TASK_ACTIVE_PREFIX}${requireTaskId(taskId)}`;
}

export function taskContextKeyV1(taskId: string): string {
  return `${TASK_CONTEXT_PREFIX}${requireTaskId(taskId)}`;
}

export function taskStopKeyV1(taskId: string): string {
  return `${TASK_STOP_PREFIX}${requireTaskId(taskId)}`;
}

export function taskMessagePrefixV1(taskId: string): string {
  return `${TASK_MESSAGE_PREFIX}${requireTaskId(taskId)}:`;
}

/** Message keys ascend, so a prefix listing drains oldest first. */
export function taskMessageKeyV1(taskId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= SEQUENCE_CEILING) {
    throw new Error("task message sequence is out of range");
  }
  return `${taskMessagePrefixV1(taskId)}${String(seq).padStart(10, "0")}`;
}

/**
 * Index keys descend, so a prefix listing returns the newest task first without
 * reading every record.
 */
export function taskIndexKeyV1(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= SEQUENCE_CEILING) {
    throw new Error("task index sequence is out of range");
  }
  return `${TASK_INDEX_PREFIX}${String(SEQUENCE_CEILING - seq).padStart(10, "0")}`;
}

/** The sequence the next index row takes, given the keys already stored. */
export function nextTaskIndexSequenceV1(keys: readonly string[]): number {
  let highest = -1;
  for (const key of keys) {
    const encoded = Number(key.slice(key.lastIndexOf(":") + 1));
    if (!Number.isSafeInteger(encoded)) continue;
    highest = Math.max(highest, SEQUENCE_CEILING - encoded);
  }
  return highest + 1;
}

/**
 * The name of the Subagent Durable Object one task runs in.
 *
 * The same `BotState` class in the same `BOT_STATES` namespace, so there is no
 * migration and no second identity: `#` cannot appear in a Bot id (it is
 * outside `PUBLIC_IDENTIFIER_PATTERN`), so the suffix is unforgeable from any
 * caller-supplied path segment and a Subagent object can never collide with a
 * Bot object.
 */
export function subagentDurableObjectNameV1(identity: {
  userId: string;
  botId: string;
  taskId: string;
}): string {
  return `${identity.userId}:${identity.botId}#task:${requireTaskId(identity.taskId)}`;
}

/** The Session a child Turn records its own events on. */
export function taskSessionIdV1(taskId: string): string {
  return `task:${requireTaskId(taskId)}`;
}

/**
 * The task whose Session and Subagent Durable Object a child Turn actually
 * runs in — the *anchor*.
 *
 * For a first dispatch that is the task itself. For a resume it is the task
 * that was resumed, because "the same child Durable Object and Session" is the
 * whole point of resuming: the child picks its prior transcript up from its own
 * cursor rather than starting blank a second time.
 */
export function taskAnchorIdV1(childSessionId: string): string {
  const anchor = childSessionId.startsWith("task:")
    ? childSessionId.slice("task:".length)
    : childSessionId;
  return requireTaskId(anchor);
}

// The durable Subagent records, and their strict codecs.
//
// ADR 0017 splits the powers: the parent Bot Durable Object is the *authority*
// for a task — it mints the record, admits the dispatch, pins the Composition
// generation and the model binding, holds the bounds, and records the terminal
// outcome — and the Subagent Durable Object is only an *execution host* for the
// one `subagent` Turn the parent handed it. Everything in this module is
// therefore parent state.
//
// Every record is versioned and exact-field, decoded at the seam it crosses.
// There are no migrations: a record the current codec refuses is a visible
// failure rather than something to reshape.

/** The five subagent roles GrokBot declares (`docs/research/grokbot-computer.md` l.351–356). */
export const TASK_TYPES_V1 = [
  "executor",
  "browserUse",
  "computerUse",
  "watchVideo",
  "videoReview",
] as const;

export type TaskTypeV1 = (typeof TASK_TYPES_V1)[number];

/** `type` is optional on the tool; an omitted one is a general work subagent. */
export const DEFAULT_TASK_TYPE_V1: TaskTypeV1 = "executor";

/** The lifecycle one task record moves through. Three of the five are terminal. */
export const TASK_STATUSES_V1 = [
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
] as const;

export type TaskStatusV1 = (typeof TASK_STATUSES_V1)[number];

export const TASK_TERMINAL_STATUSES_V1: readonly TaskStatusV1[] = [
  "completed",
  "failed",
  "stopped",
];

export function isTerminalTaskStatusV1(status: TaskStatusV1): boolean {
  return TASK_TERMINAL_STATUSES_V1.includes(status);
}

// ---------------------------------------------------------------------------
// Bounds. The plan's table, in one place, because every one of them is a
// refusal a Bot can read rather than a limit it discovers by being truncated.
// ---------------------------------------------------------------------------

/** Concurrent tasks one Bot may hold, counted from its `task-active:*` keys. */
export const TASK_CONCURRENCY_PER_BOT_V1 = 4;
/** Concurrent tasks one User may hold, reserved in the User Durable Object. */
export const TASK_CONCURRENCY_PER_USER_V1 = 8;
/**
 * How deep a subagent tree may go. It is one, and it is not a counter: `Task`
 * declares `admission: {turnTypes: ["chat", "automation"]}`, so a `subagent`
 * Turn is never offered the tool and a child can never dispatch a grandchild.
 */
export const TASK_MAX_DEPTH_V1 = 1;
/** Longest prompt one task may carry, in UTF-8 bytes. */
export const TASK_PROMPT_MAX_BYTES_V1 = 32_768;
/** Most attachments one task may carry. */
export const TASK_ATTACHMENT_LIMIT_V1 = 4;
/** Most `task_message` payloads that may wait on a running task (G2 drains them). */
export const TASK_MESSAGE_QUEUE_LIMIT_V1 = 16;
/** How long a child Turn may live before its parent reconciles it. */
export const TASK_DEADLINE_MS_V1 = 30 * 60_000;

export const TASK_DESCRIPTION_MAX_V1 = 200;
export const TASK_ID_MAX_V1 = 128;
export const TASK_SUMMARY_MAX_V1 = 8_000;
export const TASK_ATTACHMENT_PATH_MAX_V1 = 512;

export class SubagentDecodeError extends Error {
  override readonly name = "SubagentDecodeError";
}

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isTaskIdV1(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

const UTF8 = new TextEncoder();

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubagentDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Exact keys: an unknown field is refused rather than dropped, and a symbol or
 * non-enumerable own property is a field this record does not have.
 */
export function subagentExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const enumerable = Object.keys(value);
  const own = Reflect.ownKeys(value);
  if (own.length !== enumerable.length) {
    throw new SubagentDecodeError(`${label} has a non-enumerable field`);
  }
  for (const key of enumerable) {
    if (!allowed.has(key)) {
      throw new SubagentDecodeError(`${label} has unknown field "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new SubagentDecodeError(`${label} is missing "${key}"`);
    }
  }
}

export function subagentText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new SubagentDecodeError(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SubagentDecodeError(`${label} must not be empty`);
  }
  if (trimmed.length > maximum) {
    throw new SubagentDecodeError(
      `${label} must be at most ${maximum} characters`,
    );
  }
  return trimmed;
}

export function subagentTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SubagentDecodeError(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function subagentFlag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new SubagentDecodeError(`${label} must be a boolean`);
  }
  return value;
}

/**
 * The model binding pinned into a task record.
 *
 * Structurally `IsolateModelBindingV1` (`plugin-shell/src/backend-isolate.ts`),
 * restated here because a Package imports no other Package: the Shell hands one
 * across the seam and this codec is what accepts it. Pinning it at dispatch is
 * what fixes the child's `NormalizedModelRequest` at admission — the child never
 * resolves a binding of its own.
 */
export interface TaskModelBindingV1 {
  assignmentId: string;
  packageId: string;
  capabilityId: string;
  connectionId: string;
  provider: string;
  providerModelId: string;
  connectionGeneration?: string;
  catalogGeneration?: string;
}

export function decodeTaskModelBindingV1(
  value: unknown,
  label = "task model binding",
): TaskModelBindingV1 {
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    [
      "assignmentId",
      "packageId",
      "capabilityId",
      "connectionId",
      "provider",
      "providerModelId",
    ],
    ["connectionGeneration", "catalogGeneration"],
    label,
  );
  return {
    assignmentId: subagentText(
      candidate.assignmentId,
      128,
      `${label}.assignmentId`,
    ),
    packageId: subagentText(candidate.packageId, 128, `${label}.packageId`),
    capabilityId: subagentText(
      candidate.capabilityId,
      128,
      `${label}.capabilityId`,
    ),
    connectionId: subagentText(
      candidate.connectionId,
      128,
      `${label}.connectionId`,
    ),
    provider: subagentText(candidate.provider, 128, `${label}.provider`),
    providerModelId: subagentText(
      candidate.providerModelId,
      256,
      `${label}.providerModelId`,
    ),
    ...(candidate.connectionGeneration === undefined
      ? {}
      : {
          connectionGeneration: subagentText(
            candidate.connectionGeneration,
            256,
            `${label}.connectionGeneration`,
          ),
        }),
    ...(candidate.catalogGeneration === undefined
      ? {}
      : {
          catalogGeneration: subagentText(
            candidate.catalogGeneration,
            256,
            `${label}.catalogGeneration`,
          ),
        }),
  };
}

/** The model a task runs on: the durable binding, and the slug it was named by. */
export interface TaskModelV1 {
  binding: TaskModelBindingV1;
  slug: string;
}

export function decodeTaskModelV1(
  value: unknown,
  label = "task model",
): TaskModelV1 {
  const candidate = record(value, label);
  subagentExactKeys(candidate, ["binding", "slug"], [], label);
  return {
    binding: decodeTaskModelBindingV1(candidate.binding, `${label}.binding`),
    slug: subagentText(candidate.slug, 512, `${label}.slug`),
  };
}

/** The parent Turn that dispatched a task, so the record is attributable. */
export interface TaskDispatchV1 {
  runId: string;
  turnId: string;
  sessionId: string;
}

export function decodeTaskDispatchV1(
  value: unknown,
  label = "task dispatch",
): TaskDispatchV1 {
  const candidate = record(value, label);
  subagentExactKeys(candidate, ["runId", "turnId", "sessionId"], [], label);
  return {
    runId: subagentText(candidate.runId, 128, `${label}.runId`),
    turnId: subagentText(candidate.turnId, 256, `${label}.turnId`),
    sessionId: subagentText(candidate.sessionId, 256, `${label}.sessionId`),
  };
}

/** What a settled task hands back to its parent. */
export interface TaskOutcomeV1 {
  status: Exclude<TaskStatusV1, "queued" | "running">;
  settledAt: string;
  summary?: string;
  failure?: string;
}

export function decodeTaskOutcomeV1(
  value: unknown,
  label = "task outcome",
): TaskOutcomeV1 {
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    ["status", "settledAt"],
    ["summary", "failure"],
    label,
  );
  const status = TASK_TERMINAL_STATUSES_V1.find(
    (known) => known === candidate.status,
  );
  if (!status) {
    throw new SubagentDecodeError(`${label}.status is invalid`);
  }
  if (status === "completed" && candidate.failure !== undefined) {
    throw new SubagentDecodeError(
      `${label} completed and carries a failure at once`,
    );
  }
  return {
    status: status as TaskOutcomeV1["status"],
    settledAt: subagentTimestamp(candidate.settledAt, `${label}.settledAt`),
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

/**
 * One task, as the parent Bot Durable Object holds it.
 *
 * The prompt itself is *not* here: the record carries `promptDigest`, because
 * the prompt is the child's input and the child's Session is where it lives.
 * The parent keeps what it is the authority for — identity, admission, the
 * pinned Composition and model, the bounds, the lifecycle, the outcome.
 */
export interface TaskRecordV1 {
  schemaVersion: 1;
  taskId: string;
  type: TaskTypeV1;
  description: string;
  promptDigest: string;
  model: TaskModelV1;
  compositionGenerationId: string;
  background: boolean;
  depth: number;
  status: TaskStatusV1;
  dispatch: TaskDispatchV1;
  childSessionId: string;
  attachments: string[];
  resumedFrom?: string;
  createdAt: string;
  deadlineAt: string;
  outcome?: TaskOutcomeV1;
}

function decodeTaskAttachmentsV1(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new SubagentDecodeError(`${label} must be an array`);
  }
  if (value.length > TASK_ATTACHMENT_LIMIT_V1) {
    throw new SubagentDecodeError(
      `${label} must hold at most ${TASK_ATTACHMENT_LIMIT_V1} entries`,
    );
  }
  return value.map((entry, index) =>
    subagentText(entry, TASK_ATTACHMENT_PATH_MAX_V1, `${label}[${index}]`),
  );
}

export function decodeTaskRecordV1(value: unknown): TaskRecordV1 {
  const label = "task record";
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    [
      "schemaVersion",
      "taskId",
      "type",
      "description",
      "promptDigest",
      "model",
      "compositionGenerationId",
      "background",
      "depth",
      "status",
      "dispatch",
      "childSessionId",
      "attachments",
      "createdAt",
      "deadlineAt",
    ],
    ["resumedFrom", "outcome"],
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
  if (
    !Number.isSafeInteger(candidate.depth) ||
    (candidate.depth as number) < 1 ||
    (candidate.depth as number) > TASK_MAX_DEPTH_V1
  ) {
    throw new SubagentDecodeError(`${label} depth is invalid`);
  }
  const outcome =
    candidate.outcome === undefined
      ? undefined
      : decodeTaskOutcomeV1(candidate.outcome, `${label}.outcome`);
  // The lifecycle and the outcome are one fact recorded twice; a record that
  // disagrees with itself is refused rather than read.
  if (isTerminalTaskStatusV1(status) !== (outcome !== undefined)) {
    throw new SubagentDecodeError(`${label} has inconsistent terminal state`);
  }
  if (outcome && outcome.status !== status) {
    throw new SubagentDecodeError(`${label} outcome disagrees with its status`);
  }
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    type,
    description: subagentText(
      candidate.description,
      TASK_DESCRIPTION_MAX_V1,
      `${label} description`,
    ),
    promptDigest: subagentText(
      candidate.promptDigest,
      128,
      `${label} promptDigest`,
    ),
    model: decodeTaskModelV1(candidate.model, `${label}.model`),
    compositionGenerationId: subagentText(
      candidate.compositionGenerationId,
      256,
      `${label} compositionGenerationId`,
    ),
    background: subagentFlag(candidate.background, `${label} background`),
    depth: candidate.depth as number,
    status,
    dispatch: decodeTaskDispatchV1(candidate.dispatch, `${label}.dispatch`),
    childSessionId: subagentText(
      candidate.childSessionId,
      256,
      `${label} childSessionId`,
    ),
    attachments: decodeTaskAttachmentsV1(
      candidate.attachments,
      `${label} attachments`,
    ),
    ...(candidate.resumedFrom === undefined
      ? {}
      : {
          resumedFrom: subagentText(
            candidate.resumedFrom,
            TASK_ID_MAX_V1,
            `${label} resumedFrom`,
          ),
        }),
    createdAt: subagentTimestamp(candidate.createdAt, `${label} createdAt`),
    deadlineAt: subagentTimestamp(candidate.deadlineAt, `${label} deadlineAt`),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/** One waiting `task_message`, bounded by {@link TASK_MESSAGE_QUEUE_LIMIT_V1}. */
export interface TaskMessageRecordV1 {
  schemaVersion: 1;
  taskId: string;
  seq: number;
  message: string;
  createdAt: string;
}

export function decodeTaskMessageRecordV1(value: unknown): TaskMessageRecordV1 {
  const label = "task message";
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    ["schemaVersion", "taskId", "seq", "message", "createdAt"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new SubagentDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isTaskIdV1(candidate.taskId)) {
    throw new SubagentDecodeError(`${label} taskId is invalid`);
  }
  if (!Number.isSafeInteger(candidate.seq) || (candidate.seq as number) < 0) {
    throw new SubagentDecodeError(`${label} seq is invalid`);
  }
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    seq: candidate.seq as number,
    message: subagentText(candidate.message, 8_000, `${label} message`),
    createdAt: subagentTimestamp(candidate.createdAt, `${label} createdAt`),
  };
}

/**
 * The intent record written before the desktop lease is acquired: the effect is
 * named durably before the host call, so an interrupted dispatch is read back
 * rather than repeated. Acquiring the lease itself is G3 — this Package records
 * the intent and nothing else today.
 */
export interface TaskDesktopLeaseIntentV1 {
  schemaVersion: 1;
  taskId: string;
  scope: "desktop-gui";
  recordedAt: string;
}

export function decodeTaskDesktopLeaseIntentV1(
  value: unknown,
): TaskDesktopLeaseIntentV1 {
  const label = "task desktop lease intent";
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    ["schemaVersion", "taskId", "scope", "recordedAt"],
    [],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new SubagentDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isTaskIdV1(candidate.taskId)) {
    throw new SubagentDecodeError(`${label} taskId is invalid`);
  }
  if (candidate.scope !== "desktop-gui") {
    throw new SubagentDecodeError(`${label} scope is invalid`);
  }
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    scope: "desktop-gui",
    recordedAt: subagentTimestamp(candidate.recordedAt, `${label} recordedAt`),
  };
}

/** UTF-8 byte length, the unit every prompt bound in this Package is stated in. */
export function utf8ByteLengthV1(value: string): number {
  return UTF8.encode(value).byteLength;
}

/**
 * The digest a task record carries in place of the prompt. It is a content
 * identity, never a secret: the prompt itself is the child's Session input.
 */
export async function taskPromptDigestV1(prompt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", UTF8.encode(prompt));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 64);
}

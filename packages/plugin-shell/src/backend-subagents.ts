/// <reference types="@cloudflare/workers-types" />
// The Shell's half of subagent dispatch: the seams between the parent Bot
// Durable Object, which is the authority, and the Subagent Durable Object,
// which is only an execution host (ADR 0017).
//
// Nothing here decides policy. The bounds and the records are the Subagents
// Package's; the Composition, the model binding and the admitted Turn are the
// Shell's; the Durable Object addressing is a binding this module is handed.
// What this module owns is the *order*: intent before effect, one settle per
// task, and a deadline that belongs to the parent's one alarm.

import {
  decodeTaskOutcomeV1,
  isTaskIdV1,
  subagentExactKeys,
  subagentText,
  subagentTimestamp,
  SubagentDecodeError,
  TASK_PROMPT_MAX_BYTES_V1,
  TASK_TYPES_V1,
  decodeTaskModelV1,
  utf8ByteLengthV1,
  type TaskModelV1,
  type TaskOutcomeV1,
  type TaskTypeV1,
} from "@frockbot/plugin-subagents/records";
import {
  subagentDurableObjectNameV1,
  taskSessionIdV1,
} from "@frockbot/plugin-subagents/storage-keys";
import type { BotIdentity } from "@frockbot/kernel-do";

/** The parent Turn that dispatched a task, as the child records it. */
export interface SubagentParentV1 {
  userId: string;
  botId: string;
  runId: string;
  turnId: string;
  sessionId: string;
}

/**
 * What the parent hands the child, and what the child then holds.
 *
 * It is the child's own durable state and the only thing in the child that
 * outlives its Turn. Child-local by design (plan decision 2): journaling every
 * child event back into the parent would double the write cost and make the
 * parent a bottleneck for no added guarantee, and the parent already holds the
 * record of admission and terminal state that recovery reads.
 */
export interface SubagentTaskContextV1 {
  schemaVersion: 1;
  taskId: string;
  type: TaskTypeV1;
  parent: SubagentParentV1;
  compositionGenerationId: string;
  model: TaskModelV1;
  prompt: string;
  sessionId: string;
  status: "queued" | "running" | "settled";
  acceptedAt: string;
  outcome?: TaskOutcomeV1;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SubagentDecodeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function decodeSubagentParentV1(
  value: unknown,
  label = "subagent parent",
): SubagentParentV1 {
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    ["userId", "botId", "runId", "turnId", "sessionId"],
    [],
    label,
  );
  return {
    userId: subagentText(candidate.userId, 128, `${label}.userId`),
    botId: subagentText(candidate.botId, 128, `${label}.botId`),
    runId: subagentText(candidate.runId, 128, `${label}.runId`),
    turnId: subagentText(candidate.turnId, 256, `${label}.turnId`),
    sessionId: subagentText(candidate.sessionId, 256, `${label}.sessionId`),
  };
}

/** The exact `runTask` payload, decoded at the Subagent object's door. */
export interface SubagentRunTaskRequestV1 {
  taskId: string;
  type: TaskTypeV1;
  parent: SubagentParentV1;
  compositionGenerationId: string;
  model: TaskModelV1;
  prompt: string;
}

export function decodeSubagentRunTaskRequestV1(
  value: unknown,
): SubagentRunTaskRequestV1 {
  const label = "runTask request";
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    ["taskId", "type", "parent", "compositionGenerationId", "model", "prompt"],
    [],
    label,
  );
  if (!isTaskIdV1(candidate.taskId)) {
    throw new SubagentDecodeError(`${label}.taskId is invalid`);
  }
  const type = TASK_TYPES_V1.find((known) => known === candidate.type);
  if (!type) throw new SubagentDecodeError(`${label}.type is invalid`);
  const prompt = subagentText(
    candidate.prompt,
    TASK_PROMPT_MAX_BYTES_V1,
    `${label}.prompt`,
  );
  if (utf8ByteLengthV1(prompt) > TASK_PROMPT_MAX_BYTES_V1) {
    throw new SubagentDecodeError(`${label}.prompt is too large`);
  }
  return {
    taskId: candidate.taskId,
    type,
    parent: decodeSubagentParentV1(candidate.parent, `${label}.parent`),
    compositionGenerationId: subagentText(
      candidate.compositionGenerationId,
      256,
      `${label}.compositionGenerationId`,
    ),
    model: decodeTaskModelV1(candidate.model, `${label}.model`),
    prompt,
  };
}

export function subagentTaskContextV1(
  request: SubagentRunTaskRequestV1,
  acceptedAt: string,
): SubagentTaskContextV1 {
  return {
    schemaVersion: 1,
    taskId: request.taskId,
    type: request.type,
    parent: request.parent,
    compositionGenerationId: request.compositionGenerationId,
    model: request.model,
    prompt: request.prompt,
    sessionId: taskSessionIdV1(request.taskId),
    status: "queued",
    acceptedAt,
  };
}

export function decodeSubagentTaskContextV1(
  value: unknown,
): SubagentTaskContextV1 {
  const label = "subagent task context";
  const candidate = record(value, label);
  subagentExactKeys(
    candidate,
    [
      "schemaVersion",
      "taskId",
      "type",
      "parent",
      "compositionGenerationId",
      "model",
      "prompt",
      "sessionId",
      "status",
      "acceptedAt",
    ],
    ["outcome"],
    label,
  );
  if (candidate.schemaVersion !== 1) {
    throw new SubagentDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (!isTaskIdV1(candidate.taskId)) {
    throw new SubagentDecodeError(`${label}.taskId is invalid`);
  }
  const type = TASK_TYPES_V1.find((known) => known === candidate.type);
  if (!type) throw new SubagentDecodeError(`${label}.type is invalid`);
  if (
    candidate.status !== "queued" &&
    candidate.status !== "running" &&
    candidate.status !== "settled"
  ) {
    throw new SubagentDecodeError(`${label}.status is invalid`);
  }
  return {
    schemaVersion: 1,
    taskId: candidate.taskId,
    type,
    parent: decodeSubagentParentV1(candidate.parent, `${label}.parent`),
    compositionGenerationId: subagentText(
      candidate.compositionGenerationId,
      256,
      `${label}.compositionGenerationId`,
    ),
    model: decodeTaskModelV1(candidate.model, `${label}.model`),
    prompt: subagentText(
      candidate.prompt,
      TASK_PROMPT_MAX_BYTES_V1,
      `${label}.prompt`,
    ),
    sessionId: subagentText(candidate.sessionId, 256, `${label}.sessionId`),
    status: candidate.status,
    acceptedAt: subagentTimestamp(candidate.acceptedAt, `${label}.acceptedAt`),
    ...(candidate.outcome === undefined
      ? {}
      : {
          outcome: decodeTaskOutcomeV1(candidate.outcome, `${label}.outcome`),
        }),
  };
}

/**
 * The Durable Object addressing this Package needs and deliberately does not
 * hold: the Subagent object for one task, and the parent object of a child.
 * The Bot Durable Object supplies it, exactly as it supplies the authority.
 */
export interface SubagentDurableBindingV1 {
  /**
   * Hands one task to its Subagent Durable Object. The call returns as soon as
   * the child has *recorded* the task and armed its own alarm — never after the
   * Turn has run, so a dispatch never blocks the Turn that made it and no
   * promise is left floating in an object that may be evicted.
   */
  accept(
    identity: BotIdentity,
    taskId: string,
    request: SubagentRunTaskRequestV1,
  ): Promise<{ childSessionId: string }>;
  /** Asks a child what became of a task, for deadline reconciliation. */
  probe(
    identity: BotIdentity,
    taskId: string,
  ): Promise<SubagentTaskContextV1 | undefined>;
  /** Records one terminal outcome on the parent, from the child. */
  settleOnParent(
    parent: SubagentParentV1,
    taskId: string,
    outcome: TaskOutcomeV1,
  ): Promise<void>;
}

const TASK_ID_CHARACTER = /[^a-zA-Z0-9._-]/g;

/**
 * The task id one tool call mints.
 *
 * Derived from the Turn's effect identifier, so a reconciled or retried call
 * finds the task it already dispatched instead of dispatching a second child.
 */
export function subagentTaskIdV1(effectId: string): string {
  const sanitized = effectId.replace(TASK_ID_CHARACTER, "-").slice(0, 120);
  return `tk-${sanitized || "call"}`;
}

/** The outcome a settled child run hands its parent. */
export function subagentOutcomeForRunV1(
  run: { status: string; responseText?: string; failure?: string } | undefined,
  settledAt: string,
  thrown?: unknown,
): TaskOutcomeV1 {
  if (thrown !== undefined) {
    return {
      status: "failed",
      settledAt,
      failure: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
  if (!run) {
    return {
      status: "failed",
      settledAt,
      failure: "the subagent Turn recorded no run",
    };
  }
  if (run.status === "cancelled") {
    return {
      status: "stopped",
      settledAt,
      ...(run.failure === undefined ? {} : { failure: run.failure }),
    };
  }
  if (run.status === "completed") {
    const summary = run.responseText?.trim();
    return {
      status: "completed",
      settledAt,
      ...(summary ? { summary } : {}),
    };
  }
  return {
    status: "failed",
    settledAt,
    failure: run.failure ?? `the subagent's run is ${run.status}`,
  };
}

/**
 * The `BOT_STATES` namespace, as this Package's subagent binding.
 *
 * The Subagent Durable Object is the *same class* in the *same namespace* as
 * the Bot's own object, named `<userId>:<botId>#task:<taskId>` (ADR 0017) —
 * so there is no migration, no second identity, and no way for a caller to
 * reach one: `#` is outside `PUBLIC_IDENTIFIER_PATTERN`, so no Bot id can
 * contain it and the suffix can only ever be minted here.
 */
export function createBotSubagentDurableBindingV1(
  namespace: DurableObjectNamespace,
): SubagentDurableBindingV1 {
  const stub = (name: string) =>
    // SAFETY: this namespace is bound to the Bot Durable Object class;
    // generated Worker types do not expose its RPC surface.
    namespace.get(namespace.idFromName(name)) as unknown as {
      runTask(input: unknown): Promise<unknown>;
      readSubagentTask(input: unknown): Promise<unknown>;
      settleTask(input: unknown): Promise<unknown>;
    };
  return {
    accept: async (identity, taskId, request) => {
      const answer = (await stub(
        subagentDurableObjectNameV1({ ...identity, taskId }),
      ).runTask({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        request,
      })) as { childSessionId?: unknown };
      const childSessionId = answer?.childSessionId;
      if (typeof childSessionId !== "string" || childSessionId.length === 0) {
        throw new Error("the Subagent Durable Object accepted no session");
      }
      return { childSessionId };
    },
    probe: async (identity, taskId) => {
      const answer = await stub(
        subagentDurableObjectNameV1({ ...identity, taskId }),
      ).readSubagentTask({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        taskId,
      });
      if (answer === undefined || answer === null) return undefined;
      return decodeSubagentTaskContextV1(JSON.parse(JSON.stringify(answer)));
    },
    settleOnParent: async (parent, taskId, outcome) => {
      await stub(`${parent.userId}:${parent.botId}`).settleTask({
        schemaVersion: 1,
        userId: parent.userId,
        botId: parent.botId,
        taskId,
        outcome,
      });
    },
  };
}

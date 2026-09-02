// The Subagents runtime Contribution: one tool, `Task`, and one prompt section.
//
// GrokBot's `Task` (docs/research/grokbot-computer.md l.468–472) dispatches a
// child agent that shares none of the parent's memory or transcript and hands
// its result back when it is done. Here that child is a *Turn*, not an agent:
// ADR 0017 runs it in a Subagent Durable Object of the same Bot that holds no
// authority, while this Bot's own Durable Object admits it, pins its
// Composition and model, and records its lifecycle and terminal result.
//
// Depth is one, and it is not a counter. `Task` declares
// `admission: {turnTypes: ["chat", "automation"]}`, so a `subagent` Turn is
// never offered the tool and there is no grandchild to bound.
//
// Nothing here is authority. The tool decodes the model's words, resolves a
// slug against the catalog this Turn was offered, and calls the host seam the
// Bot Durable Object supplied; every durable decision — the bounds, the record,
// the dispatch — is made behind that seam, where the storage is.
import type {
  PromptSection,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  TurnTypeV1,
} from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import manifest from "../frockbot.json" with { type: "json" };
import {
  renderAvailableSubagentModelsPromptV1,
  resolveSubagentModelV1,
  type SubagentModelOptionV1,
} from "./models.js";
import {
  DEFAULT_TASK_TYPE_V1,
  isTaskIdV1,
  SubagentDecodeError,
  TASK_ATTACHMENT_LIMIT_V1,
  TASK_ATTACHMENT_PATH_MAX_V1,
  TASK_DESCRIPTION_MAX_V1,
  TASK_ID_MAX_V1,
  TASK_MESSAGE_MAX_V1,
  TASK_PROMPT_MAX_BYTES_V1,
  TASK_TYPES_V1,
  utf8ByteLengthV1,
  type TaskModelV1,
  type TaskStatusV1,
  type TaskTypeV1,
} from "./records.js";

export const TASK_TOOL_V1 = "Task";
export const TASK_CHECK_TOOL_V1 = "task_check";
export const TASK_MESSAGE_TOOL_V1 = "task_message";
export const TASK_STOP_TOOL_V1 = "task_stop";
export const TASK_RESUME_TOOL_V1 = "task_resume";
/** The manifest Capability the tool is contributed under. */
export const TASK_DISPATCH_CAPABILITY_V1 = "task-dispatch";
/** The manifest Capability the four lifecycle tools are contributed under. */
export const TASK_LIFECYCLE_CAPABILITY_V1 = "task-lifecycle";
/** The prompt section id, so a host can find it without knowing its text. */
export const SUBAGENT_MODELS_SECTION_V1 = "subagent-models";

/**
 * The durable ceiling this Package's own manifest puts on the Capability, read
 * back out of the manifest rather than restated here — the
 * `shellAdmissionCeilingV1` pattern. A registration that drifts from the
 * manifest is narrowed to the manifest, so the two cannot disagree.
 */
export function subagentsAdmissionCeilingV1(
  capabilityId: string,
): readonly TurnTypeV1[] | undefined {
  const capabilities = (
    manifest as {
      configuration?: {
        capabilities?: Array<{
          id: string;
          admission?: { turnTypes: string[] };
        }>;
      };
    }
  ).configuration?.capabilities;
  const turnTypes = capabilities?.find(
    (candidate) => candidate.id === capabilityId,
  )?.admission?.turnTypes;
  if (!turnTypes) return undefined;
  return turnTypes as readonly TurnTypeV1[];
}

/** One queued `task_message` on its way into the child's next step. */
export interface PendingTaskMessageV1 {
  seq: number;
  message: string;
}

/**
 * The message id one delivered `task_message` is recorded under.
 *
 * Derived from the task and the queue sequence, so the child's own Session
 * says which message this was and a redelivery would be visible as a repeat
 * rather than passing as a new instruction.
 */
export function taskMessageInputIdV1(taskId: string, seq: number): string {
  return `task-msg:${taskId}:${seq}`;
}

/**
 * How one delivered message reads to the child. It is a message from the
 * parent Bot, not from a user, and it says so: the child has no transcript to
 * place it in and would otherwise read it as the start of a new conversation.
 */
export function taskMessageInputTextV1(message: string): string {
  return `Your dispatcher sent you a message: ${message}`;
}

/**
 * Folds the messages a child claimed into the step it is about to take.
 *
 * Pure, and separate from the middleware that calls it, because this is the
 * whole of the delivery rule: seq order, one input per message, an id derived
 * from the queue so a repeat would be visible as a repeat, and a step that was
 * rejected stays rejected.
 */
export function foldPendingTaskMessagesV1(
  decision:
    | { kind: "enter"; inputs: { messageId: string; text: string }[] }
    | {
        kind: "reject";
        reason: string;
      },
  pending: readonly PendingTaskMessageV1[],
  taskId: string,
):
  | { kind: "enter"; inputs: { messageId: string; text: string }[] }
  | { kind: "reject"; reason: string } {
  if (decision.kind !== "enter" || pending.length === 0) return decision;
  return {
    kind: "enter",
    inputs: [
      ...decision.inputs,
      ...[...pending]
        .sort((left, right) => left.seq - right.seq)
        .map((entry) => ({
          messageId: taskMessageInputIdV1(taskId, entry.seq),
          text: taskMessageInputTextV1(entry.message),
        })),
    ],
  };
}

/** What one decoded `Task` call asks for. */
export interface TaskToolInputV1 {
  description: string;
  prompt: string;
  type: TaskTypeV1;
  background: boolean;
  model?: string;
  attachments: string[];
}

/** What the host does with a resolved dispatch. */
export interface SubagentDispatchRequestV1 {
  description: string;
  prompt: string;
  type: TaskTypeV1;
  background: boolean;
  model: TaskModelV1;
  attachments: string[];
  /** The parent Turn's effect identifier: the task's identity is derived from it. */
  effectId: string;
}

export type SubagentDispatchOutcomeV1 =
  | { status: "dispatched"; taskId: string; model: string }
  /**
   * A blocking dispatch whose child settled inside the window. The summary is
   * the tool result, so a `background:false` Task reads like a call that
   * returned rather than one that has to be checked on.
   */
  | {
      status: "settled";
      taskId: string;
      model: string;
      taskStatus: TaskStatusV1;
      summary?: string;
      failure?: string;
    }
  | { status: "refused"; reason: string };

/** What one `task_check` answers. */
export type SubagentCheckOutcomeV1 =
  | {
      status: "known";
      taskId: string;
      taskType: TaskTypeV1;
      description: string;
      taskStatus: TaskStatusV1;
      model: string;
      summary?: string;
      failure?: string;
      queuedMessages: number;
    }
  | { status: "refused"; reason: string };

export type SubagentMessageOutcomeV1 =
  | { status: "queued"; taskId: string; depth: number }
  | { status: "refused"; reason: string };

export type SubagentStopOutcomeV1 =
  { status: "stopped"; taskId: string } | { status: "refused"; reason: string };

/** What one `task_resume` asks for: a new run in a finished task's child. */
export interface SubagentResumeRequestV1 {
  resume: string;
  prompt: string;
  description?: string;
  background: boolean;
  effectId: string;
}

/**
 * The host seam this Package receives. The Durable Object supplies it for one
 * admitted Turn: without `writer` there is no Turn to attribute a dispatch to,
 * and the tool is then not registered at all.
 */
export interface SubagentsRuntimeHostV1 {
  botId: string;
  writer?: { sessionId: string; turnId: string; runId: string };
  /** The turn type this Turn was admitted as; the catalog is narrowed by it. */
  turnType: TurnTypeV1;
  /**
   * The role a *child* Turn was admitted under, when this host is a Subagent
   * Durable Object's. Absent in a parent Bot, which has no role.
   */
  subagentRole?: TaskTypeV1;
  /** The task this child is running, when this host is a child's. */
  taskId?: string;
  /**
   * Claims the messages the parent has queued for this child, marking them
   * delivered durably, and hands them back in `seq` order.
   *
   * Present only in a child: this is the seam that makes `task_message` mean
   * something. GrokBot's `MessageSubagent` influences the *running* child, so
   * a queue nobody reads is an empty queue — the child drains here on its way
   * into each step of its Turn and folds what it gets into that step's inputs.
   */
  drainMessages?(): Promise<readonly PendingTaskMessageV1[]>;
  /** The models this Turn may dispatch onto, resolved from enabled bindings. */
  models(): readonly SubagentModelOptionV1[];
  dispatch(
    request: SubagentDispatchRequestV1,
  ): Promise<SubagentDispatchOutcomeV1>;
  /** The four lifecycle seams. Every durable decision is behind them. */
  check(taskId: string): Promise<SubagentCheckOutcomeV1>;
  message(taskId: string, message: string): Promise<SubagentMessageOutcomeV1>;
  stop(taskId: string): Promise<SubagentStopOutcomeV1>;
  resume(request: SubagentResumeRequestV1): Promise<SubagentDispatchOutcomeV1>;
}

const TASK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description:
        "A short label for this task, shown to your user in the task list.",
    },
    prompt: {
      type: "string",
      description:
        "The complete instruction the subagent runs. It starts blank: it cannot see this conversation, your memory, or anything you have not written here.",
    },
    type: {
      type: "string",
      enum: [...TASK_TYPES_V1],
      description:
        "The subagent's role, which fixes the tools it is offered. Defaults to executor.",
    },
    model: {
      type: "string",
      description:
        "One slug from <available_subagent_models>. Omit it and the subagent runs on the model you are running on.",
    },
    background: {
      type: "boolean",
      description:
        "Defaults to true. The subagent runs as its own Turn and you are notified when it finishes; do not poll for it.",
    },
    attachments: {
      type: "array",
      items: { type: "string" },
      description:
        "Workspace paths the subagent is given, at most four. Required by watchVideo.",
    },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
} as const;

const TASK_DESCRIPTION = [
  "Dispatch a subagent to do one self-contained piece of work.",
  "It starts blank — it shares none of your memory and none of this transcript —",
  "so `prompt` must be a complete brief, and its result reaches you as a summary and nothing more.",
  "It runs as its own Turn, in the background by default: you are notified when it finishes, so do not poll.",
  "A subagent cannot dispatch a subagent of its own.",
].join(" ");

export function decodeTaskToolInputV1(input: unknown): TaskToolInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SubagentDecodeError(`${TASK_TOOL_V1} input must be an object`);
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "description",
    "prompt",
    "type",
    "model",
    "background",
    "attachments",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SubagentDecodeError(
        `${TASK_TOOL_V1} input has unknown field "${key}"`,
      );
    }
  }
  const text = (name: string, maximum: number): string => {
    const candidate = value[name];
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      throw new SubagentDecodeError(
        `${TASK_TOOL_V1} ${name} must be a non-empty string`,
      );
    }
    const trimmed = candidate.trim();
    if (trimmed.length > maximum) {
      throw new SubagentDecodeError(
        `${TASK_TOOL_V1} ${name} must be at most ${maximum} characters`,
      );
    }
    return trimmed;
  };
  const description = text("description", TASK_DESCRIPTION_MAX_V1);
  const prompt = text("prompt", TASK_PROMPT_MAX_BYTES_V1);
  // The prompt bound is stated in bytes, because that is what the child's Turn
  // input is bounded in and a character count would let a multi-byte prompt
  // through this door and be refused at the next one.
  if (utf8ByteLengthV1(prompt) > TASK_PROMPT_MAX_BYTES_V1) {
    throw new SubagentDecodeError(
      `${TASK_TOOL_V1} prompt must be at most ${TASK_PROMPT_MAX_BYTES_V1} bytes`,
    );
  }
  let type: TaskTypeV1 = DEFAULT_TASK_TYPE_V1;
  if (value.type !== undefined) {
    const named = TASK_TYPES_V1.find((known) => known === value.type);
    if (!named) {
      throw new SubagentDecodeError(
        `${TASK_TOOL_V1} type must be one of ${TASK_TYPES_V1.join(", ")}`,
      );
    }
    type = named;
  }
  if (value.background !== undefined && typeof value.background !== "boolean") {
    throw new SubagentDecodeError(
      `${TASK_TOOL_V1} background must be a boolean`,
    );
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw new SubagentDecodeError(`${TASK_TOOL_V1} model must be a string`);
  }
  const attachments: string[] = [];
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) {
      throw new SubagentDecodeError(
        `${TASK_TOOL_V1} attachments must be an array`,
      );
    }
    if (value.attachments.length > TASK_ATTACHMENT_LIMIT_V1) {
      throw new SubagentDecodeError(
        `${TASK_TOOL_V1} takes at most ${TASK_ATTACHMENT_LIMIT_V1} attachments`,
      );
    }
    for (const entry of value.attachments) {
      if (
        typeof entry !== "string" ||
        entry.trim().length === 0 ||
        entry.trim().length > TASK_ATTACHMENT_PATH_MAX_V1
      ) {
        throw new SubagentDecodeError(
          `${TASK_TOOL_V1} attachment paths must be bounded non-empty strings`,
        );
      }
      attachments.push(entry.trim());
    }
  }
  if (type === "watchVideo" && attachments.length === 0) {
    throw new SubagentDecodeError(
      `${TASK_TOOL_V1} watchVideo needs at least one attachment to watch`,
    );
  }
  return {
    description,
    prompt,
    type,
    // GrokBot's default, and ours: a subagent that blocks its parent is the
    // exception, not the rule.
    background: value.background === undefined ? true : value.background,
    ...(value.model === undefined ? {} : { model: value.model }),
    attachments,
  };
}

function refusal(reason: string): ToolExecutionResult {
  return { content: `${TASK_TOOL_V1} was refused: ${reason}`, isError: true };
}

/**
 * The durable Session line one task lifecycle act leaves on the *parent*.
 *
 * The child's Session never enters the visible transcript (ADR 0017), so these
 * events are the only thing the conversation says about a task, and the client
 * draws the dispatch as a chip. Recording is best effort by construction: a
 * line that could not be written must not turn a dispatch that happened into a
 * tool error that says it did not.
 */
export interface SubagentEventRecorderV1 {
  dispatched(event: {
    occurrenceId: string;
    taskId: string;
    taskType: TaskTypeV1;
    description: string;
    model: string;
    background: boolean;
  }): void;
  messaged(event: {
    occurrenceId: string;
    taskId: string;
    message: string;
  }): void;
}

export function createTaskTool(
  host: Pick<
    SubagentsRuntimeHostV1,
    "botId" | "turnType" | "models" | "dispatch"
  > & {
    writer: NonNullable<SubagentsRuntimeHostV1["writer"]>;
  },
  record?: SubagentEventRecorderV1,
): ToolDefinition {
  return {
    name: TASK_TOOL_V1,
    description: TASK_DESCRIPTION,
    inputSchema: structuredClone(TASK_INPUT_SCHEMA) as unknown as Record<
      string,
      unknown
    >,
    // A dispatch is not idempotent in the loop's sense — but it is idempotent
    // on the effect identifier, which is what the host derives the task id
    // from, so a reconciled call reads its own task back.
    idempotent: false,
    admission: { turnTypes: ["chat", "automation"] },
    validate: (input: unknown) => {
      try {
        decodeTaskToolInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      let decoded: TaskToolInputV1;
      try {
        decoded = decodeTaskToolInputV1(input);
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
      const resolution = resolveSubagentModelV1(host.models(), decoded.model);
      if (resolution.status === "refused") {
        return refusal(resolution.reason);
      }
      let outcome: SubagentDispatchOutcomeV1;
      try {
        outcome = await host.dispatch({
          description: decoded.description,
          prompt: decoded.prompt,
          type: decoded.type,
          background: decoded.background,
          model: resolution.model,
          attachments: decoded.attachments,
          effectId: context.effectId,
        });
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
      if (outcome.status === "refused") return refusal(outcome.reason);
      record?.dispatched({
        occurrenceId: context.effectId,
        taskId: outcome.taskId,
        taskType: decoded.type,
        description: decoded.description,
        model: outcome.model,
        background: decoded.background,
      });
      if (outcome.status === "settled") {
        // A `background:false` dispatch whose child finished inside the
        // blocking window: the summary is the tool result, so the Turn reads
        // it as a call that returned rather than one to check on.
        return {
          content: `${decoded.type} subagent ${outcome.taskId} ${outcome.taskStatus}. ${settledSummaryV1(outcome)}`,
          isError: outcome.taskStatus !== "completed",
        };
      }
      return {
        content: [
          `Dispatched ${decoded.type} subagent ${outcome.taskId} on ${outcome.model}.`,
          "It runs as its own Turn and cannot see this conversation.",
          decoded.background
            ? DO_NOT_POLL
            : `It is still running, id ${outcome.taskId}; it continues in the background and ${DO_NOT_POLL.charAt(0).toLowerCase()}${DO_NOT_POLL.slice(1)}`,
        ].join(" "),
        isError: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The lifecycle tools (`docs/research/grokbot-computer.md` l.415–418).
//
// All four are the same shape: decode the model's words, call the host seam,
// render the answer. None of them holds durable state, and none of them can
// widen what a task was admitted to do — a check reads, a message queues, a
// stop cancels, and a resume dispatches a new run under the *same* admission
// the first one was granted.
// ---------------------------------------------------------------------------

function taskIdArgument(value: unknown, tool: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SubagentDecodeError(`${tool} taskId must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > TASK_ID_MAX_V1 || !isTaskIdV1(trimmed)) {
    throw new SubagentDecodeError(`${tool} taskId is not a task id`);
  }
  return trimmed;
}

function onlyKeys(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  tool: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SubagentDecodeError(`${tool} input must be an object`);
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new SubagentDecodeError(`${tool} input has unknown field "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new SubagentDecodeError(`${tool} input is missing "${key}"`);
    }
  }
  return value;
}

export function decodeTaskCheckInputV1(input: unknown): { taskId: string } {
  const value = onlyKeys(input, ["taskId"], [], TASK_CHECK_TOOL_V1);
  return { taskId: taskIdArgument(value.taskId, TASK_CHECK_TOOL_V1) };
}

export function decodeTaskMessageInputV1(input: unknown): {
  taskId: string;
  message: string;
} {
  const value = onlyKeys(
    input,
    ["taskId", "message"],
    [],
    TASK_MESSAGE_TOOL_V1,
  );
  if (
    typeof value.message !== "string" ||
    value.message.trim().length === 0 ||
    value.message.trim().length > TASK_MESSAGE_MAX_V1
  ) {
    throw new SubagentDecodeError(
      `${TASK_MESSAGE_TOOL_V1} message must be a non-empty string of at most ${TASK_MESSAGE_MAX_V1} characters`,
    );
  }
  return {
    taskId: taskIdArgument(value.taskId, TASK_MESSAGE_TOOL_V1),
    message: value.message.trim(),
  };
}

export function decodeTaskStopInputV1(input: unknown): { taskId: string } {
  const value = onlyKeys(input, ["taskId"], [], TASK_STOP_TOOL_V1);
  return { taskId: taskIdArgument(value.taskId, TASK_STOP_TOOL_V1) };
}

export interface TaskResumeInputV1 {
  resume: string;
  prompt: string;
  description?: string;
  background: boolean;
}

/**
 * `resume` and `model` are mutually exclusive (l.472–474): the resumed run
 * continues a Session that was already pinned to a binding, and naming a second
 * model would silently change what the transcript was produced by. The refusal
 * is here rather than at the host, because it is a statement about the tool's
 * own arguments.
 */
export function decodeTaskResumeInputV1(input: unknown): TaskResumeInputV1 {
  const value = onlyKeys(
    input,
    ["resume", "prompt"],
    ["description", "background", "model"],
    TASK_RESUME_TOOL_V1,
  );
  if (value.model !== undefined) {
    throw new SubagentDecodeError(
      `${TASK_RESUME_TOOL_V1} does not take a model: a resumed subagent continues on the model it was dispatched with`,
    );
  }
  const prompt =
    typeof value.prompt === "string" ? value.prompt.trim() : undefined;
  if (!prompt || prompt.length === 0) {
    throw new SubagentDecodeError(
      `${TASK_RESUME_TOOL_V1} prompt must be a non-empty string`,
    );
  }
  if (utf8ByteLengthV1(prompt) > TASK_PROMPT_MAX_BYTES_V1) {
    throw new SubagentDecodeError(
      `${TASK_RESUME_TOOL_V1} prompt must be at most ${TASK_PROMPT_MAX_BYTES_V1} bytes`,
    );
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" ||
      value.description.trim().length === 0 ||
      value.description.trim().length > TASK_DESCRIPTION_MAX_V1)
  ) {
    throw new SubagentDecodeError(
      `${TASK_RESUME_TOOL_V1} description must be a bounded non-empty string`,
    );
  }
  if (value.background !== undefined && typeof value.background !== "boolean") {
    throw new SubagentDecodeError(
      `${TASK_RESUME_TOOL_V1} background must be a boolean`,
    );
  }
  return {
    resume: taskIdArgument(value.resume, TASK_RESUME_TOOL_V1),
    prompt,
    ...(value.description === undefined
      ? {}
      : { description: (value.description as string).trim() }),
    background: value.background === undefined ? true : value.background,
  };
}

function toolRefusal(tool: string, reason: string): ToolExecutionResult {
  return { content: `${tool} was refused: ${reason}`, isError: true };
}

/** The line every dispatch answer ends on, so no turn learns to poll. */
const DO_NOT_POLL = "You are notified on completion; do not poll for it.";

function settledSummaryV1(outcome: {
  taskStatus: TaskStatusV1;
  summary?: string;
  failure?: string;
}): string {
  if (outcome.taskStatus === "completed") {
    return outcome.summary ?? "It finished without leaving a summary.";
  }
  if (outcome.taskStatus === "stopped") {
    return `It was stopped.${outcome.failure ? ` ${outcome.failure}` : ""}`;
  }
  return `It failed: ${outcome.failure ?? "no reason was recorded"}.`;
}

export function createTaskCheckTool(
  host: Pick<SubagentsRuntimeHostV1, "check">,
): ToolDefinition {
  return {
    name: TASK_CHECK_TOOL_V1,
    description: [
      "Read the current state of one subagent you dispatched.",
      "It answers with the task's status and its last summary.",
      DO_NOT_POLL,
      "Use this only when your user asks what a subagent is doing.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The id Task gave you when it dispatched the subagent.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    idempotent: true,
    admission: { turnTypes: ["chat", "automation"] },
    validate: (input: unknown) => {
      try {
        decodeTaskCheckInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown): Promise<ToolExecutionResult> => {
      let taskId: string;
      try {
        taskId = decodeTaskCheckInputV1(input).taskId;
      } catch (error) {
        return toolRefusal(
          TASK_CHECK_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      const answer = await host.check(taskId);
      if (answer.status === "refused") {
        return toolRefusal(TASK_CHECK_TOOL_V1, answer.reason);
      }
      const lines = [
        `${answer.taskType} subagent ${answer.taskId} ("${answer.description}") on ${answer.model} is ${answer.taskStatus}.`,
      ];
      if (answer.summary) lines.push(`Last summary: ${answer.summary}`);
      if (answer.failure) lines.push(`Failure: ${answer.failure}`);
      if (answer.queuedMessages > 0) {
        lines.push(`${answer.queuedMessages} of your messages are waiting.`);
      }
      if (answer.taskStatus === "queued" || answer.taskStatus === "running") {
        lines.push(DO_NOT_POLL);
      }
      return { content: lines.join(" "), isError: false };
    },
  };
}

export function createTaskMessageTool(
  host: Pick<SubagentsRuntimeHostV1, "message">,
  record?: SubagentEventRecorderV1,
): ToolDefinition {
  return {
    name: TASK_MESSAGE_TOOL_V1,
    description: [
      "Send one message to a subagent that is still running.",
      "It is queued and read by the subagent; it is refused if the subagent is not running.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The subagent's task id." },
        message: {
          type: "string",
          description:
            "What to tell the subagent. It cannot see this conversation, so say everything it needs.",
        },
      },
      required: ["taskId", "message"],
      additionalProperties: false,
    },
    idempotent: false,
    admission: { turnTypes: ["chat", "automation"] },
    validate: (input: unknown) => {
      try {
        decodeTaskMessageInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      let decoded: { taskId: string; message: string };
      try {
        decoded = decodeTaskMessageInputV1(input);
      } catch (error) {
        return toolRefusal(
          TASK_MESSAGE_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      const answer = await host.message(decoded.taskId, decoded.message);
      if (answer.status === "refused") {
        return toolRefusal(TASK_MESSAGE_TOOL_V1, answer.reason);
      }
      record?.messaged({
        occurrenceId: context.effectId,
        taskId: answer.taskId,
        message: decoded.message,
      });
      return {
        content: `Queued your message for subagent ${answer.taskId}; ${answer.depth} are waiting. ${DO_NOT_POLL}`,
        isError: false,
      };
    },
  };
}

export function createTaskStopTool(
  host: Pick<SubagentsRuntimeHostV1, "stop">,
): ToolDefinition {
  return {
    name: TASK_STOP_TOOL_V1,
    description: [
      "Stop a subagent you dispatched. The cancellation is durable and final:",
      "the subagent ends, its slot is released, and it cannot be restarted —",
      "use task_resume to run a fresh instruction in the same subagent instead.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The subagent's task id." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    // Stopping the same task twice is stopping it once: the second call reads
    // the recorded cancellation back.
    idempotent: true,
    admission: { turnTypes: ["chat", "automation"] },
    validate: (input: unknown) => {
      try {
        decodeTaskStopInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown): Promise<ToolExecutionResult> => {
      let taskId: string;
      try {
        taskId = decodeTaskStopInputV1(input).taskId;
      } catch (error) {
        return toolRefusal(
          TASK_STOP_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      const answer = await host.stop(taskId);
      if (answer.status === "refused") {
        return toolRefusal(TASK_STOP_TOOL_V1, answer.reason);
      }
      return {
        content: `Stopped subagent ${answer.taskId}. The cancellation is durable and it will not run again.`,
        isError: false,
      };
    },
  };
}

export function createTaskResumeTool(
  host: Pick<SubagentsRuntimeHostV1, "resume"> & {
    writer: NonNullable<SubagentsRuntimeHostV1["writer"]>;
  },
  record?: SubagentEventRecorderV1,
): ToolDefinition {
  return {
    name: TASK_RESUME_TOOL_V1,
    description: [
      "Give a finished subagent a new instruction, in the same subagent it ran in before,",
      "so it keeps everything it already learned. It is refused while the subagent is still running,",
      "and it takes no model: a resumed subagent runs on the model it was dispatched with.",
      DO_NOT_POLL,
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        resume: {
          type: "string",
          description: "The task id of a subagent that has finished.",
        },
        prompt: {
          type: "string",
          description:
            "The new instruction. The subagent keeps its own prior transcript.",
        },
        description: {
          type: "string",
          description:
            "A short label for this run, shown to your user. Defaults to the earlier one.",
        },
        background: {
          type: "boolean",
          description: "Defaults to true, exactly as it does on Task.",
        },
      },
      required: ["resume", "prompt"],
      additionalProperties: false,
    },
    idempotent: false,
    admission: { turnTypes: ["chat", "automation"] },
    validate: (input: unknown) => {
      try {
        decodeTaskResumeInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      let decoded: TaskResumeInputV1;
      try {
        decoded = decodeTaskResumeInputV1(input);
      } catch (error) {
        return toolRefusal(
          TASK_RESUME_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      let outcome: SubagentDispatchOutcomeV1;
      try {
        outcome = await host.resume({
          resume: decoded.resume,
          prompt: decoded.prompt,
          ...(decoded.description === undefined
            ? {}
            : { description: decoded.description }),
          background: decoded.background,
          effectId: context.effectId,
        });
      } catch (error) {
        return toolRefusal(
          TASK_RESUME_TOOL_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (outcome.status === "refused") {
        return toolRefusal(TASK_RESUME_TOOL_V1, outcome.reason);
      }
      record?.dispatched({
        occurrenceId: context.effectId,
        taskId: outcome.taskId,
        taskType: "executor",
        description: decoded.description ?? `Resumed ${decoded.resume}`,
        model: outcome.model,
        background: decoded.background,
      });
      if (outcome.status === "settled") {
        return {
          content: `Subagent ${outcome.taskId} resumed and ${outcome.taskStatus}. ${settledSummaryV1(outcome)}`,
          isError: outcome.taskStatus !== "completed",
        };
      }
      return {
        content: `Resumed subagent ${decoded.resume} as ${outcome.taskId} on ${outcome.model}. ${DO_NOT_POLL}`,
        isError: false,
      };
    },
  };
}

/**
 * The `<available_subagent_models>` section. It renders on every turn type,
 * because a turn that cannot dispatch also has no slugs to show: the host
 * narrows the catalog to one entry on an automation or subagent turn, and the
 * section renders nothing at all when the catalog is empty.
 */
export function createSubagentModelsPromptSectionV1(
  host: Pick<SubagentsRuntimeHostV1, "models">,
): PromptSection {
  return {
    id: SUBAGENT_MODELS_SECTION_V1,
    order: 95,
    render: () => renderAvailableSubagentModelsPromptV1(host.models()),
  };
}

/**
 * The runtime Contribution. The prompt section is registered whenever the
 * Package is mounted; the tool only when the host supplies Bot provenance,
 * because a dispatch with no Turn to attribute it to is a dispatch with no
 * writer.
 */
export function createSubagentsRuntimePlugin(
  host: SubagentsRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    // The Turn ordinal and step a task event is recorded under. The Agent loop
    // announces them; a tool context does not carry them, so they are caught
    // where the loop already says so — the `plugin-computer` pattern.
    let currentTurn = 1;
    let currentStep = 1;
    const disposers: Array<() => void> = [
      ctx.systemPrompt.register(createSubagentModelsPromptSectionV1(host)),
      ctx.on("agent/pre-step", async (_agent, _inputs, turn, step, next) => {
        currentTurn = turn;
        currentStep = step;
        const decision = await next();
        // Delivery, not merely queueing. The claim is durable and marks what
        // it took, so a step that is retried after the claim reads the marks
        // back and does not hand the model the same instruction twice; the
        // loop records each folded input as a `user/message` on the child's
        // own Session, which is where "exactly once" is finally visible.
        if (decision.kind !== "enter" || !host.drainMessages) return decision;
        let pending: readonly PendingTaskMessageV1[];
        try {
          pending = await host.drainMessages();
        } catch {
          // A parent that cannot be reached has not lost the message: it is
          // still queued, undelivered, and the next step claims it.
          return decision;
        }
        return foldPendingTaskMessagesV1(
          decision,
          pending,
          host.taskId ?? "task",
        );
      }),
    ];
    const writer = host.writer;
    if (writer) {
      const dispatchCeiling = subagentsAdmissionCeilingV1(
        TASK_DISPATCH_CAPABILITY_V1,
      );
      const lifecycleCeiling = subagentsAdmissionCeilingV1(
        TASK_LIFECYCLE_CAPABILITY_V1,
      );
      const append = (event: Record<string, unknown> & { type: string }) => {
        const session = ctx.sessions.get(writer.sessionId);
        if (!session || session.disposed) return;
        session.append({
          turn: Math.max(1, currentTurn),
          step: Math.max(1, currentStep),
          ...event,
        } as never);
      };
      const record: SubagentEventRecorderV1 = {
        dispatched: (event) => append({ type: "task/dispatched", ...event }),
        messaged: (event) => append({ type: "task/message", ...event }),
      };
      disposers.push(
        ctx.tools.register(
          createTaskTool({ ...host, writer }, record),
          dispatchCeiling ? { admissionCeiling: dispatchCeiling } : undefined,
        ),
      );
      const lifecycleOptions = lifecycleCeiling
        ? { admissionCeiling: lifecycleCeiling }
        : undefined;
      for (const tool of [
        createTaskCheckTool(host),
        createTaskMessageTool(host, record),
        createTaskStopTool(host),
        createTaskResumeTool({ ...host, writer }, record),
      ]) {
        disposers.push(ctx.tools.register(tool, lifecycleOptions));
      }
    }
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
  plugin.inject = ["tools", "systemPrompt", "sessions"];
  return plugin;
}

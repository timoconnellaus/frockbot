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
  SubagentDecodeError,
  TASK_ATTACHMENT_LIMIT_V1,
  TASK_ATTACHMENT_PATH_MAX_V1,
  TASK_DESCRIPTION_MAX_V1,
  TASK_PROMPT_MAX_BYTES_V1,
  TASK_TYPES_V1,
  utf8ByteLengthV1,
  type TaskModelV1,
  type TaskTypeV1,
} from "./records.js";

export const TASK_TOOL_V1 = "Task";
/** The manifest Capability the tool is contributed under. */
export const TASK_DISPATCH_CAPABILITY_V1 = "task-dispatch";
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
  | { status: "refused"; reason: string };

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
  /** The models this Turn may dispatch onto, resolved from enabled Assignments. */
  models(): readonly SubagentModelOptionV1[];
  dispatch(
    request: SubagentDispatchRequestV1,
  ): Promise<SubagentDispatchOutcomeV1>;
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

export function createTaskTool(
  host: SubagentsRuntimeHostV1 & {
    writer: NonNullable<SubagentsRuntimeHostV1["writer"]>;
  },
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
      return {
        content: [
          `Dispatched ${decoded.type} subagent ${outcome.taskId} on ${outcome.model}.`,
          "It runs as its own Turn and cannot see this conversation.",
          "You are notified when it finishes; do not poll for it.",
        ].join(" "),
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
    const disposers: Array<() => void> = [
      ctx.systemPrompt.register(createSubagentModelsPromptSectionV1(host)),
    ];
    const writer = host.writer;
    if (writer) {
      const ceiling = subagentsAdmissionCeilingV1(TASK_DISPATCH_CAPABILITY_V1);
      disposers.push(
        ctx.tools.register(
          createTaskTool({ ...host, writer }),
          ceiling ? { admissionCeiling: ceiling } : undefined,
        ),
      );
    }
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
  plugin.inject = ["tools", "systemPrompt"];
  return plugin;
}

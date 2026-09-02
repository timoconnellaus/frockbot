// The Agent loop's public event vocabulary.
//
// This is the single inventory Packages use to discover loop extension
// points. In-process first-party listeners receive the richer Cordis call
// signatures declared beside the services that dispatch them; a Bot isolate
// receives only the structured-clonable payload DTO named here. In
// particular, no payload contains a live Agent, Session, Context, AbortSignal,
// storage handle, credential, or service binding.
//
// Ordering is part of the contract: a Bot-isolate host appends its listeners
// only after the first-party application has mounted. First-party policy
// therefore observes the original dispatch before Bot-authored policy, and a
// first-party listener may short-circuit without entering an isolate. A hook
// is registered only on the mounted Bot's Cordis root and is additionally
// fenced by botId and Composition generation, so it cannot reach another Bot
// or an in-flight Turn pinned to another generation.
import type {
  PromptAssembly,
  PromptAssemblyContext,
} from "./prompt-assembly.js";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation,
} from "./tool-execution.js";
import type {
  LlmMessage,
  LlmStreamEvent,
  NormalizedModelRequest,
  SessionEventEnvelope,
  ToolCall,
  ToolSchema,
  TurnTypeV1,
} from "./types.js";
import { decodeNormalizedModelRequestV1 } from "./types.js";
import type { Session } from "./session.js";
import { decodeSkillRefsV1, type SkillRefV1 } from "./skills.js";

export type LoopEventDispatchModeV1 = "waterfall" | "serial" | "emit";

export type LoopAgentStatusV1 = "idle" | "running" | "disposed";

export interface LoopAgentSnapshotV1 {
  botId: string;
  agentId: string;
  sessionId: string;
  status: LoopAgentStatusV1;
}

/** The live in-process projection used only by first-party Cordis listeners. */
export interface LoopAgentRuntimeV1 {
  readonly id: string;
  readonly botId: string;
  readonly session: Session;
  readonly status: LoopAgentStatusV1;
}

export interface LoopStepSnapshotV1 extends LoopAgentSnapshotV1 {
  compositionGenerationId: string;
  turn: number;
  step: number;
  turnType: TurnTypeV1;
  subagentRole?: string;
}

export interface LoopAgentInputV1 {
  messageId: string;
  text: string;
  skills?: SkillRefV1[];
}

export type LoopPreStepDecisionV1 =
  | { kind: "enter"; inputs: LoopAgentInputV1[] }
  | { kind: "reject"; reason: string };

export type LoopRequestErrorActionV1 = { kind: "retry" } | { kind: "fail" };

export type LoopStepContinuationV1 = { kind: "continue" } | { kind: "stop" };

export interface LoopToolExecutionContextV1 {
  botId: string;
  agentId: string;
  sessionId: string;
  compositionGenerationId: string;
  effectId: string;
  toolCall?: ToolCall;
  turnType: TurnTypeV1;
  subagentRole?: string;
}

export function loopToolExecutionContextSnapshotV1(
  context: ToolExecutionContext,
): LoopToolExecutionContextV1 {
  return structuredClone({
    botId: context.botId,
    agentId: context.agentId,
    sessionId: context.sessionId,
    compositionGenerationId: context.compositionGenerationId,
    effectId: context.effectId,
    ...(context.toolCall === undefined ? {} : { toolCall: context.toolCall }),
    turnType: context.turnType,
    ...(context.subagentRole === undefined
      ? {}
      : { subagentRole: context.subagentRole }),
  });
}

/** The structured-clonable payload carried for each public event. */
export interface LoopEventPayloadMapV1 {
  "agent/created": { agent: LoopAgentSnapshotV1 };
  "agent/disposed": { agent: LoopAgentSnapshotV1 };
  "agent/status": {
    agent: LoopAgentSnapshotV1;
    status: LoopAgentStatusV1;
  };
  "agent/inbox/inserted": {
    agent: LoopAgentSnapshotV1;
    input: LoopAgentInputV1;
  };
  "agent/inbox/claimed": {
    agent: LoopAgentSnapshotV1;
    inputs: LoopAgentInputV1[];
    turn: number;
  };
  "agent/pre-step": {
    step: LoopStepSnapshotV1;
    inputs: LoopAgentInputV1[];
    decision: LoopPreStepDecisionV1;
  };
  "system-prompt/assemble": {
    context: PromptAssemblyContext;
    assembly: PromptAssembly;
  };
  "agent/message-window": {
    step: LoopStepSnapshotV1;
    messages: LlmMessage[];
  };
  "agent/tool-exposure": {
    step: LoopStepSnapshotV1;
    tools: ToolSchema[];
  };
  "agent/request": {
    step: LoopStepSnapshotV1;
    request: NormalizedModelRequest;
  };
  "agent/request-error": {
    step: LoopStepSnapshotV1;
    error: { name: string; message: string };
    action: LoopRequestErrorActionV1;
  };
  "llm/stream": { request: NormalizedModelRequest };
  "tools/pre-execute": {
    call: ToolCall;
    context: LoopToolExecutionContextV1;
    preparation: ToolPreparation;
  };
  "tools/execute": {
    call: ToolCall;
    context: LoopToolExecutionContextV1;
  };
  "tools/post-execute": {
    call: ToolCall;
    context: LoopToolExecutionContextV1;
    result: ToolExecutionResult;
  };
  "tools/result": { call: ToolCall; result: ToolExecutionResult };
  "agent/step-continuation": {
    step: LoopStepSnapshotV1;
    decision: LoopStepContinuationV1;
  };
  "agent/model-outcome-committed": {
    agent: LoopAgentSnapshotV1;
    requestId: string;
    outcome: "completed" | "not-started";
  };
  "agent/turn-stopping": { agent: LoopAgentSnapshotV1; turn: number };
  "agent/cancel-requested": {
    agent: LoopAgentSnapshotV1;
    reason: "user" | "shutdown";
  };
  "agent/error": {
    agent: LoopAgentSnapshotV1;
    error: { name: string; message: string };
  };
  "session/event": SessionEventEnvelope;
}

/** The value a waterfall listener may replace; observations return nothing. */
export interface LoopEventReturnMapV1 {
  "agent/created": void;
  "agent/disposed": void;
  "agent/status": void;
  "agent/inbox/inserted": void;
  "agent/inbox/claimed": void;
  "agent/pre-step": LoopPreStepDecisionV1;
  "system-prompt/assemble": PromptAssembly;
  "agent/message-window": LlmMessage[];
  "agent/tool-exposure": ToolSchema[];
  "agent/request": NormalizedModelRequest;
  "agent/request-error": LoopRequestErrorActionV1;
  "llm/stream": AsyncIterable<LlmStreamEvent>;
  "tools/pre-execute": ToolPreparation;
  "tools/execute": ToolExecutionResult;
  "tools/post-execute": ToolExecutionResult;
  "tools/result": void;
  "agent/step-continuation": LoopStepContinuationV1;
  "agent/model-outcome-committed": void;
  "agent/turn-stopping": void;
  "agent/cancel-requested": void;
  "agent/error": void;
  "session/event": void;
}

export type LoopEventNameV1 = keyof LoopEventPayloadMapV1;

/**
 * Waterfalls safe to bridge into a Bot isolate. Operational wrappers that
 * carry an AbortSignal, an async stream, or an effect body remain first-party:
 * the isolate receives policy DTOs, never control of the durable skeleton.
 */
export const BOT_ISOLATE_HOOK_EVENTS_V1 = [
  "agent/pre-step",
  "system-prompt/assemble",
  "agent/message-window",
  "agent/tool-exposure",
  "tools/pre-execute",
  "tools/post-execute",
  "agent/step-continuation",
] as const satisfies readonly LoopEventNameV1[];

export type BotIsolateHookEventNameV1 =
  (typeof BOT_ISOLATE_HOOK_EVENTS_V1)[number];

export function isBotIsolateHookEventNameV1(
  value: unknown,
): value is BotIsolateHookEventNameV1 {
  return BOT_ISOLATE_HOOK_EVENTS_V1.some((event) => event === value);
}

function hookRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hookExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function hookString(
  value: unknown,
  label: string,
  maximum = 1_000_000,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function decodeHookCall(value: unknown, label: string): ToolCall {
  const call = hookRecord(value, label);
  hookExactKeys(call, ["id", "name", "input"], [], label);
  // Reuse the normalized request decoder's exact ToolCall and JSON checks.
  const decoded = decodeNormalizedModelRequestV1(
    {
      requestId: "hook-decode",
      provider: "hook-decode",
      model: "hook-decode",
      system: "",
      messages: [{ role: "assistant", content: "", toolCalls: [call] }],
      tools: [],
    },
    label,
  );
  return (decoded.messages[0] as { toolCalls: ToolCall[] }).toolCalls[0]!;
}

function decodeHookResult(value: unknown, label: string): ToolExecutionResult {
  const result = hookRecord(value, label);
  hookExactKeys(
    result,
    ["content", "isError"],
    ["endsTurn", "attachments"],
    label,
  );
  if (typeof result.isError !== "boolean") {
    throw new Error(`${label}.isError must be a boolean`);
  }
  if (result.endsTurn !== undefined && typeof result.endsTurn !== "boolean") {
    throw new Error(`${label}.endsTurn must be a boolean`);
  }
  const decoded = decodeNormalizedModelRequestV1(
    {
      requestId: "hook-decode",
      provider: "hook-decode",
      model: "hook-decode",
      system: "",
      messages: [
        {
          role: "tool",
          callId: "hook-decode",
          name: "hook_decode",
          content: result.content,
          isError: result.isError,
          ...(result.attachments === undefined
            ? {}
            : { attachments: result.attachments }),
        },
      ],
      tools: [],
    },
    label,
  );
  const message = decoded.messages[0] as Extract<LlmMessage, { role: "tool" }>;
  return {
    content: hookString(message.content, `${label}.content`, 1_000_000, true),
    isError: message.isError,
    ...(result.endsTurn === undefined
      ? {}
      : { endsTurn: result.endsTurn as boolean }),
    ...(message.attachments === undefined
      ? {}
      : { attachments: message.attachments }),
  };
}

function decodeHookInputs(value: unknown, label: string): LoopAgentInputV1[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((input, index) => {
    const itemLabel = `${label}[${index}]`;
    const item = hookRecord(input, itemLabel);
    hookExactKeys(item, ["messageId", "text"], ["skills"], itemLabel);
    const skills = item.skills;
    if (skills !== undefined && !Array.isArray(skills)) {
      throw new Error(`${itemLabel}.skills must be an array`);
    }
    const decodedSkills =
      skills === undefined
        ? undefined
        : decodeSkillRefsV1(skills, `${itemLabel}.skills`);
    return {
      messageId: hookString(item.messageId, `${itemLabel}.messageId`, 256),
      text: hookString(item.text, `${itemLabel}.text`, 1_000_000, true),
      ...(decodedSkills === undefined ? {} : { skills: decodedSkills }),
    };
  });
}

function sameHookCall(left: ToolCall, right: ToolCall): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Exact, event-specific decoding for an untrusted isolate replacement. */
export function decodeBotIsolateHookReplacementV1<
  Event extends BotIsolateHookEventNameV1,
>(
  event: Event,
  input: unknown,
  original: LoopEventReturnMapV1[Event],
): LoopEventReturnMapV1[Event] {
  const label = `isolate hook ${event} replacement`;
  let decoded: LoopEventReturnMapV1[BotIsolateHookEventNameV1];
  switch (event) {
    case "agent/pre-step": {
      const decision = hookRecord(input, label);
      if (decision.kind === "enter") {
        hookExactKeys(decision, ["kind", "inputs"], [], label);
        decoded = {
          kind: "enter",
          inputs: decodeHookInputs(decision.inputs, `${label}.inputs`),
        };
        break;
      }
      hookExactKeys(decision, ["kind", "reason"], [], label);
      if (decision.kind !== "reject") {
        throw new Error(`${label}.kind is invalid`);
      }
      decoded = {
        kind: "reject",
        reason: hookString(decision.reason, `${label}.reason`, 2_048),
      };
      break;
    }
    case "system-prompt/assemble": {
      const assembly = hookRecord(input, label);
      hookExactKeys(assembly, ["text", "sections"], [], label);
      if (!Array.isArray(assembly.sections) || assembly.sections.length > 256) {
        throw new Error(`${label}.sections must be a bounded array`);
      }
      decoded = {
        text: hookString(assembly.text, `${label}.text`, 1_000_000, true),
        sections: assembly.sections.map((section, index) => {
          const sectionLabel = `${label}.sections[${index}]`;
          const item = hookRecord(section, sectionLabel);
          hookExactKeys(item, ["id", "text"], [], sectionLabel);
          return {
            id: hookString(item.id, `${sectionLabel}.id`, 256),
            text: hookString(
              item.text,
              `${sectionLabel}.text`,
              1_000_000,
              true,
            ),
          };
        }),
      };
      break;
    }
    case "agent/message-window": {
      decoded = decodeNormalizedModelRequestV1(
        {
          requestId: "hook-decode",
          provider: "hook-decode",
          model: "hook-decode",
          system: "",
          messages: input,
          tools: [],
        },
        label,
      ).messages;
      break;
    }
    case "agent/tool-exposure": {
      decoded = decodeNormalizedModelRequestV1(
        {
          requestId: "hook-decode",
          provider: "hook-decode",
          model: "hook-decode",
          system: "",
          messages: [],
          tools: input,
        },
        label,
      ).tools;
      break;
    }
    case "tools/pre-execute": {
      const prior = original as ToolPreparation;
      const preparation = hookRecord(input, label);
      if (preparation.kind === "ready") {
        hookExactKeys(preparation, ["kind", "call", "idempotent"], [], label);
        if (typeof preparation.idempotent !== "boolean") {
          throw new Error(`${label}.idempotent must be a boolean`);
        }
        const ready = {
          kind: "ready" as const,
          call: decodeHookCall(preparation.call, `${label}.call`),
          idempotent: preparation.idempotent,
        };
        if (
          prior.kind === "denied" ||
          !sameHookCall(ready.call, prior.call) ||
          ready.idempotent !== prior.idempotent
        ) {
          throw new Error(`${label} cannot lift or alter prior preparation`);
        }
        decoded = ready;
        break;
      }
      hookExactKeys(preparation, ["kind", "call", "result"], [], label);
      if (preparation.kind !== "denied") {
        throw new Error(`${label}.kind is invalid`);
      }
      const denied = {
        kind: "denied" as const,
        call: decodeHookCall(preparation.call, `${label}.call`),
        result: decodeHookResult(preparation.result, `${label}.result`),
      };
      if (!sameHookCall(denied.call, prior.call)) {
        throw new Error(`${label} cannot alter the tool call`);
      }
      decoded = denied;
      break;
    }
    case "tools/post-execute":
      decoded = decodeHookResult(input, label);
      break;
    case "agent/step-continuation": {
      const decision = hookRecord(input, label);
      hookExactKeys(decision, ["kind"], [], label);
      if (decision.kind !== "continue" && decision.kind !== "stop") {
        throw new Error(`${label}.kind is invalid`);
      }
      decoded = { kind: decision.kind };
      break;
    }
  }
  return decoded as LoopEventReturnMapV1[Event];
}

export interface LoopEventDefinitionV1 {
  mode: LoopEventDispatchModeV1;
  payload: string;
  returns: string;
  isolateHook: boolean;
}

/**
 * The complete public loop-event table. `payload` and `returns` name the DTOs
 * above so generated authoring help and architecture docs use one vocabulary.
 */
export const LOOP_EVENTS_V1 = {
  "agent/created": {
    mode: "emit",
    payload: "{ agent: LoopAgentSnapshotV1 }",
    returns: "void",
    isolateHook: false,
  },
  "agent/disposed": {
    mode: "emit",
    payload: "{ agent: LoopAgentSnapshotV1 }",
    returns: "void",
    isolateHook: false,
  },
  "agent/status": {
    mode: "emit",
    payload: "{ agent, status }",
    returns: "void",
    isolateHook: false,
  },
  "agent/inbox/inserted": {
    mode: "emit",
    payload: "{ agent, input }",
    returns: "void",
    isolateHook: false,
  },
  "agent/inbox/claimed": {
    mode: "emit",
    payload: "{ agent, inputs, turn }",
    returns: "void",
    isolateHook: false,
  },
  "agent/pre-step": {
    mode: "waterfall",
    payload: "{ step, inputs, decision }",
    returns: "LoopPreStepDecisionV1",
    isolateHook: true,
  },
  "system-prompt/assemble": {
    mode: "waterfall",
    payload: "{ context, assembly }",
    returns: "PromptAssembly",
    isolateHook: true,
  },
  "agent/message-window": {
    mode: "waterfall",
    payload: "{ step, messages }",
    returns: "LlmMessage[]",
    isolateHook: true,
  },
  "agent/tool-exposure": {
    mode: "waterfall",
    payload: "{ step, tools }",
    returns: "ToolSchema[]",
    isolateHook: true,
  },
  "agent/request": {
    mode: "waterfall",
    payload: "{ step, request }",
    returns: "NormalizedModelRequest",
    isolateHook: false,
  },
  "agent/request-error": {
    mode: "waterfall",
    payload: "{ step, error, action }",
    returns: "LoopRequestErrorActionV1",
    isolateHook: false,
  },
  "llm/stream": {
    mode: "waterfall",
    payload: "{ request }",
    returns: "AsyncIterable<LlmStreamEvent>",
    isolateHook: false,
  },
  "tools/pre-execute": {
    mode: "waterfall",
    payload: "{ call, context, preparation }",
    returns: "ToolPreparation",
    isolateHook: true,
  },
  "tools/execute": {
    mode: "waterfall",
    payload: "{ call, context }",
    returns: "ToolExecutionResult",
    isolateHook: false,
  },
  "tools/post-execute": {
    mode: "waterfall",
    payload: "{ call, context, result }",
    returns: "ToolExecutionResult",
    isolateHook: true,
  },
  "tools/result": {
    mode: "emit",
    payload: "{ call, result }",
    returns: "void",
    isolateHook: false,
  },
  "agent/step-continuation": {
    mode: "waterfall",
    payload: "{ step, decision }",
    returns: "LoopStepContinuationV1",
    isolateHook: true,
  },
  "agent/model-outcome-committed": {
    mode: "serial",
    payload: "{ agent, requestId, outcome }",
    returns: "void",
    isolateHook: false,
  },
  "agent/turn-stopping": {
    mode: "serial",
    payload: "{ agent, turn }",
    returns: "void",
    isolateHook: false,
  },
  "agent/cancel-requested": {
    mode: "emit",
    payload: "{ agent, reason }",
    returns: "void",
    isolateHook: false,
  },
  "agent/error": {
    mode: "emit",
    payload: "{ agent, error }",
    returns: "void",
    isolateHook: false,
  },
  "session/event": {
    mode: "emit",
    payload: "SessionEventEnvelope",
    returns: "void",
    isolateHook: false,
  },
} as const satisfies Record<LoopEventNameV1, LoopEventDefinitionV1>;

declare module "cordis" {
  interface Events {
    "agent/created": (agent: LoopAgentRuntimeV1) => void;
    "agent/disposed": (agent: LoopAgentRuntimeV1) => void;
    "agent/status": (
      agent: LoopAgentRuntimeV1,
      status: LoopAgentStatusV1,
    ) => void;
    "agent/inbox/inserted": (
      agent: LoopAgentRuntimeV1,
      input: LoopAgentInputV1,
    ) => void;
    "agent/inbox/claimed": (
      agent: LoopAgentRuntimeV1,
      inputs: LoopAgentInputV1[],
      turn: number,
    ) => void;
    "agent/pre-step": (
      agent: LoopAgentRuntimeV1,
      inputs: LoopAgentInputV1[],
      turn: number,
      step: number,
      next: () => Promise<LoopPreStepDecisionV1>,
    ) => Promise<LoopPreStepDecisionV1>;
    "agent/message-window": (
      agent: LoopAgentRuntimeV1,
      messages: LlmMessage[],
      turn: number,
      step: number,
      signal: AbortSignal,
      next: () => Promise<LlmMessage[]>,
    ) => Promise<LlmMessage[]>;
    "agent/tool-exposure": (
      agent: LoopAgentRuntimeV1,
      tools: ToolSchema[],
      turn: number,
      step: number,
      signal: AbortSignal,
      next: () => Promise<ToolSchema[]>,
    ) => Promise<ToolSchema[]>;
    "agent/step-continuation": (
      agent: LoopAgentRuntimeV1,
      decision: LoopStepContinuationV1,
      turn: number,
      step: number,
      signal: AbortSignal,
      next: () => Promise<LoopStepContinuationV1>,
    ) => Promise<LoopStepContinuationV1>;
    "agent/cancel-requested": (
      agent: LoopAgentRuntimeV1,
      reason: "user" | "shutdown",
    ) => void;
    "agent/error": (agent: LoopAgentRuntimeV1, error: unknown) => void;
  }
}

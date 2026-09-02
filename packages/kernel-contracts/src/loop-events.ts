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

export type LoopEventDispatchModeV1 = "waterfall" | "serial" | "emit";

export type LoopAgentStatusV1 = "idle" | "running" | "disposed";

export interface LoopAgentSnapshotV1 {
  botId: string;
  agentId: string;
  sessionId: string;
  status: LoopAgentStatusV1;
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
  skills?: Array<{ owner: "bot" | "user"; name: string }>;
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

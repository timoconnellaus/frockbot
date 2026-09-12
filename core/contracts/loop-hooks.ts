// The seams the app opens around the Agent loop.
//
// A feature that shapes a step, a request or a tool call supplies one of
// these objects, and the app lists them in the order they apply: the first
// listed is the outermost, and sees the original dispatch before anything
// listed after it. There is no bus, no event name and no registry — a typed
// list the runtime composes at each call, and nothing else.
import type {
  LoopAgentInputV1,
  LoopAgentRuntimeV1,
  LoopPreStepDecisionV1,
  LoopStepContinuationV1,
} from "./loop-events.js";
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
  ToolCall,
  ToolSchema,
} from "./types.js";

export type LoopRequestErrorDecisionV1 =
  { kind: "retry" } | { kind: "fallback" } | { kind: "fail" };

/** Where a step's assistant text sits in the journal. */
export interface LoopAssistantTextPositionV1 {
  turn: number;
  step: number;
  requestId: string;
  /**
   * The tools the same step is about to call, by name, so a hook can tell an
   * acknowledgement the model only narrated from one it is also delivering
   * through its own send tool.
   */
  toolNames?: readonly string[];
}

/**
 * Every seam, optional. A hook that takes `next` wraps the value the rest of
 * the list would produce; one that does not is run in order and awaited.
 */
export interface LoopHooksV1 {
  preStep?(
    agent: LoopAgentRuntimeV1,
    inputs: LoopAgentInputV1[],
    turn: number,
    step: number,
    next: () => Promise<LoopPreStepDecisionV1>,
  ): Promise<LoopPreStepDecisionV1>;
  assemblePrompt?(
    context: PromptAssemblyContext,
    next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly>;
  messageWindow?(
    agent: LoopAgentRuntimeV1,
    messages: LlmMessage[],
    turn: number,
    step: number,
    signal: AbortSignal,
    next: () => Promise<LlmMessage[]>,
  ): Promise<LlmMessage[]>;
  toolExposure?(
    agent: LoopAgentRuntimeV1,
    tools: ToolSchema[],
    turn: number,
    step: number,
    signal: AbortSignal,
    next: () => Promise<ToolSchema[]>,
  ): Promise<ToolSchema[]>;
  request?(
    agent: LoopAgentRuntimeV1,
    request: NormalizedModelRequest,
    turn: number,
    step: number,
    signal: AbortSignal,
    next: () => Promise<NormalizedModelRequest>,
  ): Promise<NormalizedModelRequest>;
  /**
   * A hook may refuse a planned retry, or replace a permanent failure with a
   * provider-owned fallback. It cannot turn a permanent failure into another
   * attempt against the same model.
   */
  requestError?(
    agent: LoopAgentRuntimeV1,
    error: unknown,
    signal: AbortSignal,
    next: () => Promise<LoopRequestErrorDecisionV1>,
  ): Promise<LoopRequestErrorDecisionV1>;
  modelStream?(
    request: NormalizedModelRequest,
    signal: AbortSignal,
    next: () => AsyncIterable<LlmStreamEvent>,
  ): AsyncIterable<LlmStreamEvent>;
  prepareTool?(
    call: ToolCall,
    context: ToolExecutionContext,
    next: () => Promise<ToolPreparation>,
  ): Promise<ToolPreparation>;
  toolResult?(
    call: ToolCall,
    result: ToolExecutionResult,
    context: ToolExecutionContext,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult>;
  stepContinuation?(
    agent: LoopAgentRuntimeV1,
    decision: LoopStepContinuationV1,
    turn: number,
    step: number,
    signal: AbortSignal,
    next: () => Promise<LoopStepContinuationV1>,
  ): Promise<LoopStepContinuationV1>;
  /**
   * A step where the model wrote something *and* called tools, raised the
   * moment the assistant message is journaled and before any tool runs, so a
   * feature that owns the Bot's voice can deliver words the model addressed to
   * the person but never sent.
   */
  assistantText?(
    agent: LoopAgentRuntimeV1,
    text: string,
    position: LoopAssistantTextPositionV1,
  ): Promise<void>;
  /**
   * The request id is handed back to whoever holds something for it — a
   * credential lease, a spend record — once the loop is done dispatching it.
   * A hook that cannot commit leaves the Turn without a `turn/end`, so a
   * resume re-announces the same id.
   */
  modelOutcomeCommitted?(
    agent: LoopAgentRuntimeV1,
    requestId: string,
  ): Promise<void>;
  /** Awaited inside the Turn's settlement; nothing here may take long. */
  turnStopping?(agent: LoopAgentRuntimeV1, turn: number): Promise<void>;
}

type Wrapping = {
  [K in keyof LoopHooksV1]-?: NonNullable<LoopHooksV1[K]> extends (
    ...args: [...infer _Args, () => infer _Next]
  ) => unknown
    ? K
    : never;
}[keyof LoopHooksV1];

/** The hooks the runtime composes, in the order they were added. */
export class LoopHookListV1 {
  readonly #hooks: LoopHooksV1[] = [];

  /** Append a hooks object; the returned function removes it again. */
  add(hooks: LoopHooksV1): () => void {
    this.#hooks.push(hooks);
    return () => {
      const index = this.#hooks.indexOf(hooks);
      if (index >= 0) this.#hooks.splice(index, 1);
    };
  }

  #wrap<K extends Wrapping, R>(
    key: K,
    invoke: (hook: Required<Pick<LoopHooksV1, K>>, next: () => R) => R,
    fallback: () => R,
  ): R {
    const applicable = this.#hooks.filter(
      (hook): hook is LoopHooksV1 & Required<Pick<LoopHooksV1, K>> =>
        hook[key] !== undefined,
    );
    const run = (index: number): R => {
      const hook = applicable[index];
      return hook ? invoke(hook, () => run(index + 1)) : fallback();
    };
    return run(0);
  }

  preStep(
    agent: LoopAgentRuntimeV1,
    inputs: LoopAgentInputV1[],
    turn: number,
    step: number,
    fallback: () => Promise<LoopPreStepDecisionV1>,
  ): Promise<LoopPreStepDecisionV1> {
    return this.#wrap(
      "preStep",
      (hook, next) => hook.preStep(agent, inputs, turn, step, next),
      fallback,
    );
  }

  assemblePrompt(
    context: PromptAssemblyContext,
    fallback: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> {
    return this.#wrap(
      "assemblePrompt",
      (hook, next) => hook.assemblePrompt(context, next),
      fallback,
    );
  }

  messageWindow(
    agent: LoopAgentRuntimeV1,
    messages: LlmMessage[],
    turn: number,
    step: number,
    signal: AbortSignal,
    fallback: () => Promise<LlmMessage[]>,
  ): Promise<LlmMessage[]> {
    return this.#wrap(
      "messageWindow",
      (hook, next) =>
        hook.messageWindow(agent, messages, turn, step, signal, next),
      fallback,
    );
  }

  toolExposure(
    agent: LoopAgentRuntimeV1,
    tools: ToolSchema[],
    turn: number,
    step: number,
    signal: AbortSignal,
    fallback: () => Promise<ToolSchema[]>,
  ): Promise<ToolSchema[]> {
    return this.#wrap(
      "toolExposure",
      (hook, next) => hook.toolExposure(agent, tools, turn, step, signal, next),
      fallback,
    );
  }

  request(
    agent: LoopAgentRuntimeV1,
    request: NormalizedModelRequest,
    turn: number,
    step: number,
    signal: AbortSignal,
    fallback: () => Promise<NormalizedModelRequest>,
  ): Promise<NormalizedModelRequest> {
    return this.#wrap(
      "request",
      (hook, next) => hook.request(agent, request, turn, step, signal, next),
      fallback,
    );
  }

  requestError(
    agent: LoopAgentRuntimeV1,
    error: unknown,
    signal: AbortSignal,
    fallback: () => Promise<LoopRequestErrorDecisionV1>,
  ): Promise<LoopRequestErrorDecisionV1> {
    return this.#wrap(
      "requestError",
      (hook, next) => hook.requestError(agent, error, signal, next),
      fallback,
    );
  }

  modelStream(
    request: NormalizedModelRequest,
    signal: AbortSignal,
    fallback: () => AsyncIterable<LlmStreamEvent>,
  ): AsyncIterable<LlmStreamEvent> {
    return this.#wrap(
      "modelStream",
      (hook, next) => hook.modelStream(request, signal, next),
      fallback,
    );
  }

  prepareTool(
    call: ToolCall,
    context: ToolExecutionContext,
    fallback: () => Promise<ToolPreparation>,
  ): Promise<ToolPreparation> {
    return this.#wrap(
      "prepareTool",
      (hook, next) => hook.prepareTool(call, context, next),
      fallback,
    );
  }

  toolResult(
    call: ToolCall,
    result: ToolExecutionResult,
    context: ToolExecutionContext,
    fallback: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    return this.#wrap(
      "toolResult",
      (hook, next) => hook.toolResult(call, result, context, next),
      fallback,
    );
  }

  stepContinuation(
    agent: LoopAgentRuntimeV1,
    decision: LoopStepContinuationV1,
    turn: number,
    step: number,
    signal: AbortSignal,
    fallback: () => Promise<LoopStepContinuationV1>,
  ): Promise<LoopStepContinuationV1> {
    return this.#wrap(
      "stepContinuation",
      (hook, next) =>
        hook.stepContinuation(agent, decision, turn, step, signal, next),
      fallback,
    );
  }

  async assistantText(
    agent: LoopAgentRuntimeV1,
    text: string,
    position: LoopAssistantTextPositionV1,
  ): Promise<void> {
    for (const hook of [...this.#hooks]) {
      await hook.assistantText?.(agent, text, position);
    }
  }

  async modelOutcomeCommitted(
    agent: LoopAgentRuntimeV1,
    requestId: string,
  ): Promise<void> {
    for (const hook of [...this.#hooks]) {
      await hook.modelOutcomeCommitted?.(agent, requestId);
    }
  }

  async turnStopping(agent: LoopAgentRuntimeV1, turn: number): Promise<void> {
    for (const hook of [...this.#hooks]) {
      await hook.turnStopping?.(agent, turn);
    }
  }
}

import type { Agent, AgentOptions } from "./agent.js";
import type {
  CompositionPinV1,
  LoopHookListV1,
  ModelInvocation,
  NormalizedModelRequest,
  PromptAssemblyService,
  Session,
  SessionStore,
  StepOutcome,
  ToolCall,
  ToolExecution,
  TurnTypeV1,
} from "@frockbot/core/contracts";
import type { ModelRetryPolicyRuntimeV1 } from "./retry-policy.js";

/** What the loop is built on: the registries a Turn reads, and its hooks. */
export interface LoopServices {
  readonly sessions: SessionStore;
  readonly systemPrompt: PromptAssemblyService;
  readonly llm: ModelInvocation;
  readonly tools: ToolExecution;
  readonly hooks: LoopHookListV1;
}

export type EffectAdmittingAgentOptions = AgentOptions & {
  admitEffect(effect: {
    kind: "model" | "tool";
    effectId: string;
  }): Promise<boolean>;
};

export interface ModelResponse {
  request: NormalizedModelRequest;
  text: string;
  toolCalls: ToolCall[];
}

/** The step a Turn currently has open, so its settlement can close it. */
export interface TurnCursor {
  openStep: number | undefined;
}

/**
 * How a Turn's body finished.
 *
 * `settlement-pending` writes no `turn/end`: the Turn's own durable commitment
 * of a model outcome has not landed, and a resume re-announces it.
 */
export type TurnSettlement =
  | { kind: "settled"; outcome: StepOutcome; reason?: string }
  | { kind: "settlement-pending" };

/**
 * What one Turn's external work is allowed to reach.
 *
 * The seam exists so provider I/O and tool execution can be written against
 * the durable log and the mounted Packages without also owning the Turn's
 * state machine — the loop keeps the cursor, the deadline and the inbox.
 */
export interface LoopRuntime {
  readonly agent: Agent;
  readonly services: LoopServices;
  readonly session: Session;
  readonly options: EffectAdmittingAgentOptions;
  readonly composition: CompositionPinV1;
  readonly turnType: TurnTypeV1;
  readonly subagentRole: string | undefined;
  readonly maxSteps: number;
  readonly retry: ModelRetryPolicyRuntimeV1;
  /** Wall clock this Turn must finish by, rearmed for each Turn. */
  readonly turnDeadlineAt: number;
  notifyModelOutcome(requestId: string): Promise<void>;
}

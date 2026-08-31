// Importing the augmented module is what merges these declarations into cordis.
import type {} from "cordis";
import {
  TURN_TYPES_V1,
  type ToolCall,
  type ToolSchema,
  type TurnTypeV1,
} from "./types.js";

export interface ToolExecutionContext {
  botId: string;
  agentId: string;
  sessionId: string;
  compositionGenerationId: string;
  /** Stable durable occurrence identity for provider idempotency and recovery. */
  effectId: string;
  /** Exact durable call; reconciliation fails closed when it is absent. */
  toolCall?: ToolCall;
  /** The turn type this Turn was admitted as. */
  turnType: TurnTypeV1;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  /**
   * The Turn ends once this result is recorded: the Agent loop closes the step
   * as `completed` and makes no further model request. Declared per *result*,
   * not per definition, because one tool can end a Turn for one payload and
   * not another. The loop carries the boolean; what earns it is Package
   * policy.
   */
  endsTurn?: boolean;
}

/** The turn types an admission declaration names. */
export interface TurnAdmissionV1 {
  turnTypes: TurnTypeV1[];
}

/**
 * The turn types a registered tool may be offered on: its own declaration,
 * bounded by the durable manifest ceiling of the Capability that contributed
 * it. An absent declaration is every turn type — every tool shipped today is a
 * work tool — and an absent ceiling is a manifest that set no bound. The
 * result keeps {@link TURN_TYPES_V1} order and holds no duplicates.
 */
export function admittedTurnTypesV1(
  declared: readonly TurnTypeV1[] | undefined,
  ceiling: readonly TurnTypeV1[] | undefined,
): TurnTypeV1[] {
  return TURN_TYPES_V1.filter(
    (turnType) =>
      (declared === undefined || declared.includes(turnType)) &&
      (ceiling === undefined || ceiling.includes(turnType)),
  );
}

export type ToolEffectReconciliation =
  | { status: "recovered"; result: ToolExecutionResult }
  | { status: "unavailable"; reason: string };

export interface ToolDefinition extends ToolSchema {
  idempotent?: boolean;
  /** The turn types this tool is offered on. Absent means all of them. */
  admission?: TurnAdmissionV1;
  validate?(input: unknown): boolean;
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  reconcile?(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolEffectReconciliation>;
}

export type ToolPreparation =
  | { kind: "ready"; call: ToolCall; idempotent: boolean }
  | { kind: "denied"; call: ToolCall; result: ToolExecutionResult };

/** The kernel-declared tool execution interface. Implemented by a Package. */
export interface ToolExecution {
  /** The catalog trimmed to what this turn type admits. */
  schemas(admission: { turnType: TurnTypeV1 }): ToolSchema[];
  prepare(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation>;
  executePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  /**
   * Recovers the outcome of an already-admitted tool effect without starting a
   * second one, so an interrupted Turn never duplicates a side effect.
   */
  reconcilePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolEffectReconciliation>;
}

/**
 * What the host that mounts a Contribution knows about the tool and the
 * Package's manifest, which the tool itself cannot be trusted to restate.
 */
export interface ToolRegistrationOptions {
  /**
   * The durable manifest ceiling of the Capability contributing this tool. A
   * tool may not be admitted onto a turn type its manifest does not list.
   */
  admissionCeiling?: readonly TurnTypeV1[];
}

/** Contributing Packages register tool definitions through this surface. */
export interface ToolRegistration {
  register(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions,
  ): () => void;
}

declare module "cordis" {
  interface Context {
    tools: ToolExecution & ToolRegistration;
  }

  interface Events {
    "tools/pre-execute": (
      call: ToolCall,
      context: ToolExecutionContext,
      next: () => Promise<ToolPreparation>,
    ) => Promise<ToolPreparation>;
    "tools/execute": (
      call: ToolCall,
      context: ToolExecutionContext,
      next: () => Promise<ToolExecutionResult>,
    ) => Promise<ToolExecutionResult>;
    "tools/post-execute": (
      call: ToolCall,
      result: ToolExecutionResult,
      context: ToolExecutionContext,
      next: () => Promise<ToolExecutionResult>,
    ) => Promise<ToolExecutionResult>;
    "tools/result": (call: ToolCall, result: ToolExecutionResult) => void;
  }
}

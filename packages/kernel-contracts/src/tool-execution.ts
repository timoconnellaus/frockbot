// Importing the augmented module is what merges these declarations into cordis.
import type {} from "cordis";
import {
  TURN_TYPES_V1,
  type ToolAttachmentV1,
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
  /**
   * The subagent role this Turn was admitted under, on a `subagent` Turn that
   * declared one. An opaque string here for the same reason `turnType` is: the
   * kernel carries it and narrows the catalog by it, and what any role name
   * means is Package policy.
   */
  subagentRole?: string;
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
  /**
   * Binaries this result produced, named by their durable Workspace path.
   *
   * They reach the model only where the model-invocation adapter can show
   * them; an adapter that cannot drops them and says so in the text, so a tool
   * that returns an image is never silently answered with nothing.
   */
  attachments?: ToolAttachmentV1[];
}

/** The turn types — and, optionally, the subagent roles — an admission names. */
export interface TurnAdmissionV1 {
  /**
   * The turn types this tool is offered on. Optional, so a declaration can
   * narrow the *role* dimension alone: a work tool that every turn type may
   * call but only an `executor` subagent may reach says exactly that, and does
   * not have to restate the full turn-type list to do it.
   */
  turnTypes?: TurnTypeV1[];
  /**
   * The subagent roles this tool is offered to on a `subagent` Turn. Absent
   * means every role, exactly as an absent `admission` means every turn type:
   * narrowing is always something a declaration *does*, never something the
   * kernel assumes. The strings are opaque here.
   */
  subagentRoles?: string[];
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

/**
 * The subagent roles a registered tool may be offered to: its own declaration,
 * bounded by the durable manifest ceiling of the Capability that contributed
 * it. `undefined` — both absent — is every role. The result is deduplicated
 * and keeps the declaration's order.
 */
export function admittedSubagentRolesV1(
  declared: readonly string[] | undefined,
  ceiling: readonly string[] | undefined,
): readonly string[] | undefined {
  if (declared === undefined && ceiling === undefined) return undefined;
  const source = declared ?? ceiling ?? [];
  const bound = declared === undefined ? undefined : ceiling;
  const admitted: string[] = [];
  for (const role of source) {
    if (bound !== undefined && !bound.includes(role)) continue;
    if (!admitted.includes(role)) admitted.push(role);
  }
  return admitted;
}

/**
 * Whether a tool with these admitted roles is offered to one Turn's role. A
 * Turn that names no role is not narrowed at all — role is a *second* ceiling
 * dimension, and a Turn outside the subagent world has no coordinate on it.
 */
export function isSubagentRoleAdmittedV1(
  admitted: readonly string[] | undefined,
  role: string | undefined,
): boolean {
  if (role === undefined || admitted === undefined) return true;
  return admitted.includes(role);
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
  /** The catalog trimmed to what this turn type — and role — admits. */
  schemas(admission: {
    turnType: TurnTypeV1;
    subagentRole?: string;
  }): ToolSchema[];
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
  /**
   * The same durable ceiling on the second dimension: the subagent roles the
   * Capability's manifest lists. Absent is a manifest that set no bound.
   */
  subagentRoleCeiling?: readonly string[];
}

/** Contributing Packages register tool definitions through this surface. */
export interface ToolRegistration {
  /** Every registered name, before turn/role admission trims the catalog. */
  registeredNames?(): string[];
  register(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions,
  ): () => void;
  /**
   * First-party, deny-only policy evaluated after `tools/pre-execute` and
   * before `tools/execute`. The isolate contract never exposes this method.
   */
  guard(guard: ToolGuard): () => void;
}

export interface ToolGuardDenial {
  reason: string;
}

export type ToolGuard = (
  call: ToolCall,
  context: ToolExecutionContext,
) => ToolGuardDenial | undefined | Promise<ToolGuardDenial | undefined>;

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

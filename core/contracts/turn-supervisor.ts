/**
 * Turn supervision, as the agent loop speaks to it.
 *
 * This is the seam between durable Turn execution and the build-time Package
 * that judges it. The hosted adapter is Jev. Another product may substitute
 * another adapter without changing the loop. There is no unsupervised
 * fallback: if this Package is unavailable, no Turn, subagent or tool call
 * runs.
 *
 * Jev supplies narrow judgments. Trusted code applies thresholds, vetoes,
 * precedence and arithmetic, then returns these typed decisions.
 */

/** Host-owned classification. A Plugin cannot confer `read` on itself. */
export type ToolEffectV1 = "read" | "mutate";

export const SUPERVISION_REASON_CODES_V1 = [
  "authorized",
  "no_authorization",
  "policy_forbids",
  "policy_requires_confirmation",
  "arguments_changed",
  "off_task",
  "text_depends_on_rejected_effect",
  "supervisor_unavailable",
  "supervisor_timeout",
] as const;

export type SupervisionReasonCode =
  (typeof SUPERVISION_REASON_CODES_V1)[number];

export const FAILURE_SIGNAL_KINDS_V1 = [
  "wrong_objective",
  "unauthorized_mutation",
  "unsupported_effect_claim",
  "ignored_supervisor_feedback",
  "invalid_tool_arguments",
  "required_specialist_unused",
] as const;

export type FailureSignalKindV1 = (typeof FAILURE_SIGNAL_KINDS_V1)[number];

export interface FailureSignal {
  kind: FailureSignalKindV1;
  weight: number;
  refs: string[];
}

export const CONTINUATION_STATUSES_V1 = [
  "open",
  "completed",
  "blocked",
  "obsolete",
] as const;

export type ContinuationStatusV1 = (typeof CONTINUATION_STATUSES_V1)[number];

export interface ContinuationDecision {
  id: string;
  status: ContinuationStatusV1;
  evidenceRefs: string[];
}

export const SPECIALIST_CAPABILITIES_V1 = [
  "planning",
  "research",
  "coding",
  "criticism",
  "mentoring",
] as const;

export type SpecialistCapabilityV1 =
  (typeof SPECIALIST_CAPABILITIES_V1)[number];

export interface SpecialistBudgetV1 {
  maxSteps: number;
  maxCostMicros?: number;
}

/**
 * A deployment-owned specialist. `role` is the subagent role the catalog
 * pins; the loop treats it as an opaque string.
 */
export interface SpecialistProfile {
  id: string;
  capabilities: SpecialistCapabilityV1[];
  model: {
    provider: string;
    model: string;
    connectionId?: string;
    connectionGeneration?: string;
    catalogGeneration?: string;
  };
  role: string;
  instructions: string;
  budget: SpecialistBudgetV1;
}

export type PolicyScopeV1 = "platform" | "user" | "bot";

export interface PolicyRuleV1 {
  id: string;
  scope: PolicyScopeV1;
  rule: string;
  locked: boolean;
  overrides?: string;
}

/** The rules an admitted Turn is reviewed under. Immutable for that Turn. */
export interface PolicySnapshotV1 {
  generation: string;
  rules: readonly PolicyRuleV1[];
}

export interface ConversationEvidenceV1 {
  speaker: "user" | "bot";
  text: string;
}

export interface ContinuationItemV1 {
  id: string;
  status: ContinuationStatusV1;
  evidenceRefs: string[];
}

export interface FailureStateV1 {
  score: number;
  signals: readonly FailureSignal[];
  mentorRequired: boolean;
}

export type TurnInputOriginV1 =
  "user" | "agent" | "schedule" | "subagent" | "voice";

export interface TurnStartEvidence {
  input: {
    messageId: string;
    text: string;
    origin: TurnInputOriginV1;
  };
  policies: PolicySnapshotV1;
  authorizations: readonly ConversationEvidenceV1[];
  continuation: readonly ContinuationItemV1[];
  conversation: readonly ConversationEvidenceV1[];
  specialists: readonly SpecialistProfile[];
  failure: FailureStateV1;
}

export const TURN_COMPLEXITIES_V1 = ["simple", "moderate", "complex"] as const;

export type TurnComplexityV1 = (typeof TURN_COMPLEXITIES_V1)[number];

export const TURN_AMBIGUITIES_V1 = ["clear", "needs_clarification"] as const;

export type TurnAmbiguityV1 = (typeof TURN_AMBIGUITIES_V1)[number];

/**
 * Typed start-of-Turn decisions. Jev does not write the acknowledgement or
 * the specialist assignment; code renders steering from these fields.
 */
export interface TurnDirective {
  acknowledge: boolean;
  complexity: TurnComplexityV1;
  consequence: number;
  ambiguity: TurnAmbiguityV1;
  requiredCapabilities: SpecialistCapabilityV1[];
  steering: SupervisionReasonCode[];
}

export interface ProposedCallV1 {
  callId: string;
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  effect: ToolEffectV1;
}

export interface PriorToolResultV1 {
  callId: string;
  content: string;
}

export interface StepProposalEvidence {
  objective: string;
  startDirective: TurnDirective;
  text: string;
  calls: readonly ProposedCallV1[];
  policies: PolicySnapshotV1;
  authorizations: readonly ConversationEvidenceV1[];
  priorResults: readonly PriorToolResultV1[];
  specialistAdvice: readonly string[];
  failure: FailureStateV1;
  continuationCandidates: readonly ContinuationItemV1[];
  finalStep: boolean;
}

export const RESPONSE_ALIGNMENTS_V1 = [
  "on-task",
  "repair",
  "wrong-objective",
] as const;

export type ResponseAlignmentV1 = (typeof RESPONSE_ALIGNMENTS_V1)[number];

export interface StepCallDecision {
  callId: string;
  decision: "allow" | "reject";
  reasonCode: SupervisionReasonCode;
  policyRefs: string[];
}

export interface StepDecision {
  text: "release" | "withhold";
  calls: StepCallDecision[];
  responseAlignment: ResponseAlignmentV1;
  failureSignals: FailureSignal[];
  continuation: ContinuationDecision[];
}

export interface TurnSupervisor {
  startTurn(
    evidence: TurnStartEvidence,
    signal?: AbortSignal,
  ): Promise<TurnDirective>;

  reviewStep(
    evidence: StepProposalEvidence,
    signal?: AbortSignal,
  ): Promise<StepDecision>;
}

export type SupervisionFailureKindV1 = "unavailable" | "timeout";

/**
 * Supervision did not produce a decision. The loop must not run the
 * conversational model, release text or dispatch a tool.
 */
export class SupervisionUnavailableError extends Error {
  readonly kind: SupervisionFailureKindV1;

  constructor(kind: SupervisionFailureKindV1, message: string) {
    super(message);
    this.name = "SupervisionUnavailableError";
    this.kind = kind;
  }
}

export function emptyPolicySnapshotV1(
  generation = "policy:none",
): PolicySnapshotV1 {
  return { generation, rules: [] };
}

export function emptyFailureStateV1(): FailureStateV1 {
  return { score: 0, signals: [], mentorRequired: false };
}

export function defaultTurnDirectiveV1(): TurnDirective {
  return {
    acknowledge: false,
    complexity: "simple",
    consequence: 0,
    ambiguity: "clear",
    requiredCapabilities: [],
    steering: [],
  };
}

export function allowAllStepDecisionV1(
  calls: readonly ProposedCallV1[],
): StepDecision {
  return {
    text: "release",
    calls: calls.map((call) => ({
      callId: call.callId,
      decision: "allow" as const,
      reasonCode: "authorized" as const,
      policyRefs: [],
    })),
    responseAlignment: "on-task",
    failureSignals: [],
    continuation: [],
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/**
 * The test and development adapter. It always admits work so the loop can be
 * exercised without Jev. Production never mounts this.
 */
export function createFakeTurnSupervisorV1(options?: {
  startTurn?: TurnSupervisor["startTurn"];
  reviewStep?: TurnSupervisor["reviewStep"];
}): TurnSupervisor {
  return {
    async startTurn(evidence, signal) {
      throwIfAborted(signal);
      if (options?.startTurn) return options.startTurn(evidence, signal);
      return defaultTurnDirectiveV1();
    },
    async reviewStep(evidence, signal) {
      throwIfAborted(signal);
      if (options?.reviewStep) return options.reviewStep(evidence, signal);
      return allowAllStepDecisionV1(evidence.calls);
    },
  };
}

/** The adapter mounted when supervision is known to be down. */
export function createUnavailableTurnSupervisorV1(
  reason = "Turn supervision is unavailable.",
  kind: SupervisionFailureKindV1 = "unavailable",
): TurnSupervisor {
  const fail = async (): Promise<never> => {
    throw new SupervisionUnavailableError(kind, reason);
  };
  return { startTurn: fail, reviewStep: fail };
}

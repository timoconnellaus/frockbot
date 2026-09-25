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

/**
 * Host-owned classification. A Plugin cannot confer `read` on itself.
 *
 * `mutate` is a call Turn supervision reviews before it runs: code from
 * outside the deployment — a Plugin a User installed or a Bot wrote, a remote
 * MCP server, a connected app — acting on the world. `read` is everything a
 * review would only slow down: reads, changes the person can see and undo
 * inside FrockBot, work on the Bot's own Computer, and first-party effects
 * that carry their own human gate (an approval card, an approved draft).
 */
export type ToolEffectV1 = "read" | "mutate";

export const SUPERVISION_REASON_CODES_V1 = [
  "authorized",
  "no_authorization",
  "policy_forbids",
  "policy_requires_confirmation",
  "arguments_changed",
  "off_task",
  "redundant_text",
  "paraphrased_work",
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

/**
 * A kind of work a specialist does better than the Bot, by the deployment's
 * own name for it. Which exist is the deployment's; the loop carries a name.
 */
export type SpecialistCapabilityV1 = string;

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
  /** What the work is, in words code wrote from the log; never Jev's. */
  description?: string;
}

export interface FailureStateV1 {
  score: number;
  signals: readonly FailureSignal[];
  mentorRequired: boolean;
}

/**
 * Where an admitted Turn's input came from. `user` is a person in the app;
 * `email` and `group` are a person too, but not one watching this thread.
 */
export type TurnInputOriginV1 =
  "user" | "email" | "group" | "agent" | "schedule" | "subagent" | "voice";

export const TURN_INPUT_ORIGINS_V1: readonly TurnInputOriginV1[] = [
  "user",
  "email",
  "group",
  "agent",
  "schedule",
  "subagent",
  "voice",
];

/**
 * One raw answer a supervisor's judge gave, kept beside the decision code made
 * of it so a person can see why. `answer` is the label a choice picked;
 * `value` is a Noul, a Score, or the picked label's probability.
 */
export interface SupervisionJudgmentV1 {
  question: string;
  answer?: string;
  value: number;
}

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
  /** What the judge answered. Empty for an adapter that asked nobody. */
  judgments: SupervisionJudgmentV1[];
  /** The judge's resolved model version, when one was asked. */
  model?: string;
}

export interface ProposedCallV1 {
  callId: string;
  tool: string;
  arguments: Readonly<Record<string, unknown>>;
  effect: ToolEffectV1;
  /**
   * The call is the Bot speaking to someone rather than acting: a question,
   * a card, an answer to its caller. Such a call is never refused as off-task,
   * because asking is how a Bot finds out what the task is.
   */
  speaks?: boolean;
}

export interface PriorToolResultV1 {
  callId: string;
  content: string;
}

/**
 * One complete model response, as the person would receive it.
 *
 * `text` is the words the person would see: every plain-text message the
 * response sends them, in order. `calls` is everything else it proposes,
 * including a send that asks a question or draws a card; a text send is judged
 * as text, never as a call.
 */
export interface StepProposalEvidence {
  objective: string;
  origin: TurnInputOriginV1;
  startDirective: TurnDirective;
  text: string;
  calls: readonly ProposedCallV1[];
  /** The conversation before this Turn, oldest first. */
  conversation: readonly ConversationEvidenceV1[];
  /** What the person has already been shown this Turn, oldest first. */
  shown: readonly string[];
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
  /** Why the text was withheld; present exactly when it was. */
  textReason?: SupervisionReasonCode;
  calls: StepCallDecision[];
  responseAlignment: ResponseAlignmentV1;
  failureSignals: FailureSignal[];
  continuation: ContinuationDecision[];
  /** What the judge answered. Empty for an adapter that asked nobody. */
  judgments: SupervisionJudgmentV1[];
  /** The judge's resolved model version, when one was asked. */
  model?: string;
}

/**
 * One text send, reviewed right before it runs, with everything the Turn has
 * already shown the person and every result it has already seen. Judged per
 * send rather than with the whole response because what makes a message
 * redundant is often a result that landed earlier in the same step.
 */
export interface SendReviewEvidenceV1 {
  objective: string;
  origin: TurnInputOriginV1;
  /** The conversation before this Turn, oldest first. */
  conversation: readonly ConversationEvidenceV1[];
  /** What the person has already been shown this Turn, oldest first. */
  shown: readonly string[];
  /** This Turn's tool results so far, oldest first. */
  priorResults: readonly PriorToolResultV1[];
  /** The words the send would put in front of the person. */
  message: string;
  /** The send would end the Turn. */
  finish: boolean;
  /** What a subagent produced for this Turn, oldest first. */
  work: readonly string[];
}

export interface SendDecisionV1 {
  send: "release" | "withhold";
  /** Why the send was withheld; present exactly when it was. */
  reason?: SupervisionReasonCode;
  /** What the judge answered. Empty for an adapter that asked nobody. */
  judgments: SupervisionJudgmentV1[];
  /** The judge's resolved model version, when one was asked. */
  model?: string;
}

/**
 * One `mutate` call, reviewed right before it runs: whether the person asked
 * for it, with these particulars. Judged per call, with the Turn's results so
 * far, because a call's arguments are often filled in from them.
 */
export interface CallReviewEvidenceV1 {
  objective: string;
  origin: TurnInputOriginV1;
  /** The tool as the model named it, and exactly what it would be given. */
  call: {
    tool: string;
    arguments: Readonly<Record<string, unknown>>;
  };
  /**
   * What the person and the Bot said, oldest first: the conversation before
   * this Turn, then the Turn's own requests. Only the person's words can
   * authorize anything.
   */
  conversation: readonly ConversationEvidenceV1[];
  /** This Turn's tool results so far, oldest first. */
  priorResults: readonly PriorToolResultV1[];
  policies: PolicySnapshotV1;
}

export interface CallDecisionV1 {
  decision: "allow" | "reject";
  reasonCode: SupervisionReasonCode;
  /** What the judge answered. Empty for an adapter that asked nobody. */
  judgments: SupervisionJudgmentV1[];
  /** The judge's resolved model version, when one was asked. */
  model?: string;
}

/** A question a subagent asked, and what the person said before it came. */
export interface QuestionRouteEvidenceV1 {
  question: string;
  /** The conversation, oldest first; only the person's words answer it. */
  conversation: readonly ConversationEvidenceV1[];
}

/** Whether the conversation already answers it, or only the person can. */
export interface QuestionRouteV1 {
  answerer: "conversation" | "person";
  judgments: SupervisionJudgmentV1[];
  model?: string;
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

  reviewSend(
    evidence: SendReviewEvidenceV1,
    signal?: AbortSignal,
  ): Promise<SendDecisionV1>;

  reviewCall(
    evidence: CallReviewEvidenceV1,
    signal?: AbortSignal,
  ): Promise<CallDecisionV1>;

  routeQuestion(
    evidence: QuestionRouteEvidenceV1,
    signal?: AbortSignal,
  ): Promise<QuestionRouteV1>;
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

/** How a result Turn supervision wrote begins, for the model to read. */
export const SUPERVISION_WITHHELD_SEND_PREFIX_V1 =
  "Not sent: supervision withheld this message";
export const SUPERVISION_NOT_AUTHORIZED_PREFIX_V1 =
  "Not run: supervision found no request from the person for this call.";
export const SUPERVISION_ARGUMENTS_CHANGED_PREFIX_V1 =
  "Not run: supervision found this call differs from what the person asked for.";
export const SUPERVISION_OFF_TASK_PREFIX_V1 =
  "Not run: supervision judged this response to be working on something the person did not ask for.";

// Exact-key decoders for the durable supervision records. They cross the
// session log, the debug surface and recovery, so nothing is trusted unread.

const JUDGMENT_TEXT_MAX_V1 = 64;
const SUPERVISION_LIST_MAX_V1 = 64;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is missing`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`${label}.${key} is not allowed`);
    }
  }
}

function text(value: unknown, label: string, maximum?: number): string {
  if (
    typeof value !== "string" ||
    (maximum !== undefined && value.length > maximum)
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function list<T>(
  value: unknown,
  label: string,
  decode: (entry: unknown, label: string) => T,
  maximum = SUPERVISION_LIST_MAX_V1,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => decode(entry, `${label}[${index}]`));
}

function decodeJudgmentsV1(
  value: unknown,
  label: string,
): SupervisionJudgmentV1[] {
  return list(value, label, (entry, at) => {
    const judgment = record(entry, at);
    exactKeys(judgment, ["question", "value"], ["answer"], at);
    return {
      question: text(judgment.question, `${at}.question`, JUDGMENT_TEXT_MAX_V1),
      ...(judgment.answer === undefined
        ? {}
        : {
            answer: text(judgment.answer, `${at}.answer`, JUDGMENT_TEXT_MAX_V1),
          }),
      value: finite(judgment.value, `${at}.value`),
    };
  });
}

export function decodeTurnDirectiveV1(
  value: unknown,
  label = "turn directive",
): TurnDirective {
  const directive = record(value, label);
  exactKeys(
    directive,
    [
      "acknowledge",
      "complexity",
      "consequence",
      "ambiguity",
      "requiredCapabilities",
      "steering",
      "judgments",
    ],
    ["model"],
    label,
  );
  if (typeof directive.acknowledge !== "boolean") {
    throw new Error(`${label}.acknowledge must be a boolean`);
  }
  return {
    acknowledge: directive.acknowledge,
    complexity: oneOf(
      directive.complexity,
      TURN_COMPLEXITIES_V1,
      `${label}.complexity`,
    ),
    consequence: finite(directive.consequence, `${label}.consequence`),
    ambiguity: oneOf(
      directive.ambiguity,
      TURN_AMBIGUITIES_V1,
      `${label}.ambiguity`,
    ),
    requiredCapabilities: list(
      directive.requiredCapabilities,
      `${label}.requiredCapabilities`,
      (entry, at) => text(entry, at, JUDGMENT_TEXT_MAX_V1),
    ),
    steering: list(directive.steering, `${label}.steering`, (entry, at) =>
      oneOf(entry, SUPERVISION_REASON_CODES_V1, at),
    ),
    judgments: decodeJudgmentsV1(directive.judgments, `${label}.judgments`),
    ...(directive.model === undefined
      ? {}
      : {
          model: text(directive.model, `${label}.model`, JUDGMENT_TEXT_MAX_V1),
        }),
  };
}

export function decodeStepDecisionV1(
  value: unknown,
  label = "step decision",
): StepDecision {
  const decision = record(value, label);
  exactKeys(
    decision,
    [
      "text",
      "calls",
      "responseAlignment",
      "failureSignals",
      "continuation",
      "judgments",
    ],
    ["textReason", "model"],
    label,
  );
  const released = oneOf(
    decision.text,
    ["release", "withhold"] as const,
    `${label}.text`,
  );
  if ((released === "withhold") !== (decision.textReason !== undefined)) {
    throw new Error(`${label}.textReason must name why text was withheld`);
  }
  return {
    text: released,
    ...(decision.textReason === undefined
      ? {}
      : {
          textReason: oneOf(
            decision.textReason,
            SUPERVISION_REASON_CODES_V1,
            `${label}.textReason`,
          ),
        }),
    calls: list(
      decision.calls,
      `${label}.calls`,
      (entry, at) => {
        const call = record(entry, at);
        exactKeys(
          call,
          ["callId", "decision", "reasonCode", "policyRefs"],
          [],
          at,
        );
        return {
          callId: text(call.callId, `${at}.callId`, 128),
          decision: oneOf(
            call.decision,
            ["allow", "reject"] as const,
            `${at}.decision`,
          ),
          reasonCode: oneOf(
            call.reasonCode,
            SUPERVISION_REASON_CODES_V1,
            `${at}.reasonCode`,
          ),
          policyRefs: list(call.policyRefs, `${at}.policyRefs`, (ref, where) =>
            text(ref, where, 128),
          ),
        };
      },
      Number.POSITIVE_INFINITY,
    ),
    responseAlignment: oneOf(
      decision.responseAlignment,
      RESPONSE_ALIGNMENTS_V1,
      `${label}.responseAlignment`,
    ),
    failureSignals: list(
      decision.failureSignals,
      `${label}.failureSignals`,
      (entry, at) => {
        const signal = record(entry, at);
        exactKeys(signal, ["kind", "weight", "refs"], [], at);
        return {
          kind: oneOf(signal.kind, FAILURE_SIGNAL_KINDS_V1, `${at}.kind`),
          weight: finite(signal.weight, `${at}.weight`),
          refs: list(
            signal.refs,
            `${at}.refs`,
            (ref, where) => text(ref, where, 128),
            Number.POSITIVE_INFINITY,
          ),
        };
      },
    ),
    continuation: list(
      decision.continuation,
      `${label}.continuation`,
      (entry, at) => {
        const item = record(entry, at);
        exactKeys(item, ["id", "status", "evidenceRefs"], [], at);
        return {
          id: text(item.id, `${at}.id`, 128),
          status: oneOf(item.status, CONTINUATION_STATUSES_V1, `${at}.status`),
          evidenceRefs: list(
            item.evidenceRefs,
            `${at}.evidenceRefs`,
            (ref, where) => text(ref, where, 128),
          ),
        };
      },
    ),
    judgments: decodeJudgmentsV1(decision.judgments, `${label}.judgments`),
    ...(decision.model === undefined
      ? {}
      : {
          model: text(decision.model, `${label}.model`, JUDGMENT_TEXT_MAX_V1),
        }),
  };
}

export function decodeSendDecisionV1(
  value: unknown,
  label = "send decision",
): SendDecisionV1 {
  const decision = record(value, label);
  exactKeys(decision, ["send", "judgments"], ["reason", "model"], label);
  const send = oneOf(
    decision.send,
    ["release", "withhold"] as const,
    `${label}.send`,
  );
  if ((send === "withhold") !== (decision.reason !== undefined)) {
    throw new Error(`${label}.reason must name why the send was withheld`);
  }
  return {
    send,
    ...(decision.reason === undefined
      ? {}
      : {
          reason: oneOf(
            decision.reason,
            SUPERVISION_REASON_CODES_V1,
            `${label}.reason`,
          ),
        }),
    judgments: decodeJudgmentsV1(decision.judgments, `${label}.judgments`),
    ...(decision.model === undefined
      ? {}
      : {
          model: text(decision.model, `${label}.model`, JUDGMENT_TEXT_MAX_V1),
        }),
  };
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
    judgments: [],
  };
}

export function decodeCallDecisionV1(
  value: unknown,
  label = "call decision",
): CallDecisionV1 {
  const decision = record(value, label);
  exactKeys(
    decision,
    ["decision", "reasonCode", "judgments"],
    ["model"],
    label,
  );
  return {
    decision: oneOf(
      decision.decision,
      ["allow", "reject"] as const,
      `${label}.decision`,
    ),
    reasonCode: oneOf(
      decision.reasonCode,
      SUPERVISION_REASON_CODES_V1,
      `${label}.reasonCode`,
    ),
    judgments: decodeJudgmentsV1(decision.judgments, `${label}.judgments`),
    ...(decision.model === undefined
      ? {}
      : {
          model: text(decision.model, `${label}.model`, JUDGMENT_TEXT_MAX_V1),
        }),
  };
}

export function decodeQuestionRouteV1(
  value: unknown,
  label = "question route",
): QuestionRouteV1 {
  const route = record(value, label);
  exactKeys(route, ["answerer", "judgments"], ["model"], label);
  return {
    answerer: oneOf(
      route.answerer,
      ["conversation", "person"] as const,
      `${label}.answerer`,
    ),
    judgments: decodeJudgmentsV1(route.judgments, `${label}.judgments`),
    ...(route.model === undefined
      ? {}
      : { model: text(route.model, `${label}.model`, JUDGMENT_TEXT_MAX_V1) }),
  };
}

export function allowCallDecisionV1(): CallDecisionV1 {
  return { decision: "allow", reasonCode: "authorized", judgments: [] };
}

export function releaseSendDecisionV1(): SendDecisionV1 {
  return { send: "release", judgments: [] };
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
    judgments: [],
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
  reviewSend?: TurnSupervisor["reviewSend"];
  reviewCall?: TurnSupervisor["reviewCall"];
  routeQuestion?: TurnSupervisor["routeQuestion"];
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
    async reviewSend(evidence, signal) {
      throwIfAborted(signal);
      if (options?.reviewSend) return options.reviewSend(evidence, signal);
      return releaseSendDecisionV1();
    },
    async reviewCall(evidence, signal) {
      throwIfAborted(signal);
      if (options?.reviewCall) return options.reviewCall(evidence, signal);
      return allowCallDecisionV1();
    },
    async routeQuestion(evidence, signal) {
      throwIfAborted(signal);
      if (options?.routeQuestion) {
        return options.routeQuestion(evidence, signal);
      }
      return { answerer: "person", judgments: [] };
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
  return {
    startTurn: fail,
    reviewStep: fail,
    reviewSend: fail,
    reviewCall: fail,
    routeQuestion: fail,
  };
}

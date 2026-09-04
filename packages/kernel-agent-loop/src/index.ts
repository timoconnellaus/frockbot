import {
  type Agent,
  type AgentFactory,
  type AgentHandle,
  type AgentInput,
  type AgentOptions,
  type AgentSendV1,
  type AgentStatus,
  type PreStepDecision,
} from "./agent.js";
import {
  type CompositionPinV1,
  decodeSkillRefsV1,
  LlmEffectNotStartedError,
  type LlmStreamEvent,
  type LoopStepContinuationV1,
  type NormalizedModelRequest,
  ModelProviderFailureError,
  type Session,
  type SessionEvent,
  type StepOutcome,
  type ToolCall,
  type ToolCallOccurrence,
  type ToolExecutionResult,
  type TurnTypeV1,
  TURN_DEADLINE_MS_V1,
  toolCallOccurrences,
  turnEndReason,
  validateSettledToolOccurrenceJournal,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import { type Context, Service } from "cordis";
import {
  defaultModelRetrySleepV1,
  type ModelRetryPolicyRuntimeV1,
  nextModelRetryV1,
} from "./retry-policy.js";

export * from "./retry-policy.js";

declare module "cordis" {
  interface Events {
    "agent/model-outcome-committed": (
      agent: Agent,
      requestId: string,
      outcome: "completed" | "not-started",
    ) => Promise<void>;
  }
}

export interface AgentLoopConfig {
  maxSteps?: number;
  /**
   * The wall clock one Turn is allowed, in milliseconds. Defaults to
   * {@link TURN_DEADLINE_MS_V1}; named by a caller only to test it.
   */
  turnDeadlineMs?: number;
  /** Deterministic retry seams; production uses wall time, Math.random and timers. */
  retry?: Partial<ModelRetryPolicyRuntimeV1>;
  /** The Composition generation this mounted root was pinned to at admission. */
  composition: CompositionPinV1;
}

type EffectAdmittingAgentOptions = AgentOptions & {
  admitEffect(effect: {
    kind: "model" | "tool";
    effectId: string;
  }): Promise<boolean>;
};

declare module "cordis" {
  interface Context {
    agentLoop: AgentLoop;
  }
}

interface ModelResponse {
  request: NormalizedModelRequest;
  text: string;
  toolCalls: ToolCall[];
}

type ModelReconciliation =
  | { status: "recovered"; response: ModelResponse }
  | { status: "unavailable"; reason: string }
  | { status: "not-retrievable"; reason: string };

class ModelEffectReconciliationRequiredError extends Error {
  constructor(
    readonly requestId: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelEffectReconciliationRequiredError";
  }
}

class ToolEffectReconciliationRequiredError extends Error {
  constructor(
    readonly occurrenceId: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolEffectReconciliationRequiredError";
  }
}

/**
 * The Turn used every step it was allowed.
 *
 * Not a model error: nothing failed, and everything the Turn did in those
 * steps is durable. It is reported as what it is — a Turn that stopped after
 * so many steps — so the person is told the Bot ran out of room rather than
 * that their model broke.
 */
class StepLimitReachedError extends Error {
  constructor(readonly steps: number) {
    super(`stopped after ${steps} steps`);
    this.name = "StepLimitReachedError";
  }
}

/**
 * The longest a single Turn may run before the loop stops waiting for it.
 *
 * Defined in the contracts, because the loop is not its only reader: anything
 * deciding whether a run still marked `running` can still be running needs the
 * same number. Re-exported here because this is where every caller looks for
 * it.
 */
export { TURN_DEADLINE_MS_V1 };

/** Legacy ceiling for unknown failures: the first attempt plus one retry. */
export const MODEL_REQUEST_ATTEMPTS_V1 = 2;

/** What a `turn/end` records when the Turn ran out of wall clock. */
export const TURN_DEADLINE_REASON_V1 =
  "This Turn ran for 15 minutes without finishing and was stopped. Try sending it again.";

/** Durable Stop won the final effect-admission transaction. */
class EffectAdmissionFencedError extends Error {
  constructor(readonly effectId: string) {
    super(`Effect "${effectId}" was fenced by durable Stop`);
    this.name = "EffectAdmissionFencedError";
  }
}

function hasUnsettledExternalEffect(events: readonly SessionEvent[]): boolean {
  let unresolvedRequestId: string | undefined;
  for (const event of events) {
    if (event.type === "model/request") {
      unresolvedRequestId = event.request.requestId;
    } else if (
      (event.type === "assistant/message" ||
        event.type === "model/effect-not-started") &&
      event.requestId === unresolvedRequestId
    ) {
      unresolvedRequestId = undefined;
    }
  }
  if (unresolvedRequestId) return true;
  try {
    return [...validateToolOccurrenceJournal(events).values()].some(
      (entry) => entry.intent && !entry.result,
    );
  } catch {
    // Invalid effect history is never safe to close as cancelled.
    return true;
  }
}

class ModelOutcomeSettlementRequiredError extends Error {
  constructor(readonly cause: unknown) {
    super("Durable model outcome settlement is pending");
    this.name = "ModelOutcomeSettlementRequiredError";
  }
}

function modelFailureMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Model provider response was lost";
}

class LoopAgent implements Agent {
  readonly id: string;
  readonly botId: string;
  readonly session: Session;
  #ctx: Context;
  #options: EffectAdmittingAgentOptions;
  #maxSteps: number;
  #composition: CompositionPinV1;
  /** The turn type every Turn of this Agent is admitted as. */
  #turnType: TurnTypeV1;
  /** The subagent role that turn type was admitted under, when it has one. */
  #subagentRole: string | undefined;
  #status: AgentStatus = "idle";
  #inbox: AgentInput[] = [];
  #activity: Promise<void> = Promise.resolve();
  #controller: AbortController | undefined;
  /**
   * Why the current cancellation happened, as an opaque bounded string the
   * caller supplied. The loop never reads it: it records it on the `turn/end`
   * it writes, so the durable log says what interrupted the Turn rather than
   * only that something did.
   */
  #cancelDetail: string | undefined;
  #disposeRequested = false;
  #resumeRequested = false;
  /**
   * The Turn's wall clock, rearmed for each Turn a wake runs.
   *
   * It aborts the same controller Stop uses, so nothing in the step loop has
   * to learn about a second signal; the flag beside it is what tells the
   * settlement that the abort was a deadline rather than a person.
   */
  #turnDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #turnDeadlineReached = false;
  #turnDeadlineMs: number;
  #turnDeadlineAt = 0;
  #retry: ModelRetryPolicyRuntimeV1;

  constructor(
    ctx: Context,
    session: Session,
    options: EffectAdmittingAgentOptions,
    maxSteps: number,
    composition: CompositionPinV1,
    turnDeadlineMs: number,
    retry: ModelRetryPolicyRuntimeV1,
  ) {
    this.#ctx = ctx;
    this.#composition = composition;
    this.session = session;
    this.botId = options.botId;
    const explicitAgentId = (
      options as AgentOptions & { agentId?: string }
    ).agentId?.trim();
    this.id = explicitAgentId || options.sessionId;
    this.#options = options;
    this.#turnType = options.turnType ?? "chat";
    this.#subagentRole = options.subagentRole;
    this.#maxSteps = maxSteps;
    this.#turnDeadlineMs = turnDeadlineMs;
    this.#retry = retry;
  }

  get status(): AgentStatus {
    return this.#status;
  }

  send(request: string | AgentSendV1): string {
    if (this.#disposeRequested)
      throw new Error(`agent "${this.id}" is disposing`);
    const sent = typeof request === "string" ? { text: request } : request;
    const normalized = sent.text.trim();
    if (!normalized) throw new Error("agent input is empty");
    // Decoded here rather than trusted: `send` is the kernel's inbound seam
    // for an input, and an invoked Skill is durable state the moment
    // `input/queued` is appended.
    const skills =
      sent.skills === undefined
        ? undefined
        : decodeSkillRefsV1([...sent.skills], "agent input skills");
    const input: AgentInput = {
      messageId: crypto.randomUUID(),
      text: normalized,
      ...(skills && skills.length > 0 ? { skills } : {}),
    };
    this.session.append({ type: "input/queued", ...input });
    this.#inbox.push(input);
    this.#ctx.emit("agent/inbox/inserted", this, input);
    this.#wake();
    return input.messageId;
  }

  resume(): void {
    if (this.#disposeRequested)
      throw new Error(`agent "${this.id}" is disposing`);
    if (
      this.#status !== "idle" ||
      this.#inbox.length > 0 ||
      this.#resumeRequested
    ) {
      throw new Error(`agent "${this.id}" cannot resume while active`);
    }
    this.#resumeRequested = true;
    this.#wake();
  }

  cancel(reason: "user" | "shutdown" = "user", detail?: string): void {
    if (this.#status === "disposed") return;
    this.#cancelDetail = turnEndReason(detail);
    this.#ctx.emit("agent/cancel-requested", this, reason);
    const queued = this.#inbox.splice(0);
    if (queued.length > 0) {
      this.session.appendBatch(
        queued.map((input) => ({
          type: "input/cancelled" as const,
          messageId: input.messageId,
          reason,
        })),
      );
    }
    this.#controller?.abort(new Error(`agent cancelled by ${reason}`));
  }

  /**
   * Start this Turn's clock. Any previous Turn's is cleared first, so a wake
   * that runs three queued Turns gives each of them the full allowance rather
   * than sharing one.
   */
  #armTurnDeadline(): void {
    this.#disarmTurnDeadline();
    this.#turnDeadlineReached = false;
    this.#turnDeadlineAt = this.#retry.now() + this.#turnDeadlineMs;
    this.#turnDeadlineTimer = setTimeout(() => {
      this.#turnDeadlineReached = true;
      this.#controller?.abort(new Error(TURN_DEADLINE_REASON_V1));
    }, this.#turnDeadlineMs);
  }

  #disarmTurnDeadline(): void {
    if (this.#turnDeadlineTimer !== undefined) {
      clearTimeout(this.#turnDeadlineTimer);
      this.#turnDeadlineTimer = undefined;
    }
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>;
    do {
      activity = this.#activity;
      await activity;
    } while (activity !== this.#activity);
  }

  async dispose(): Promise<void> {
    if (this.#disposeRequested) return this.whenIdle();
    this.#disposeRequested = true;
    this.cancel("shutdown");
    await this.whenIdle();
    this.#setStatus("disposed");
  }

  #setStatus(status: AgentStatus): void {
    if (status === this.#status) return;
    this.#status = status;
    this.#ctx.emit("agent/status", this, status);
  }

  #wake(): void {
    if (
      this.#disposeRequested ||
      this.#status !== "idle" ||
      (this.#inbox.length === 0 && !this.#resumeRequested)
    ) {
      return;
    }
    this.#controller = new AbortController();
    this.#setStatus("running");
    let failed = false;
    const activity = this.#drive(this.#controller.signal)
      .catch((error: unknown) => {
        // A Turn that could not even journal its own start throws out of
        // `#drive`. Re-waking on the inbox it left behind would append another
        // `turn/start`, fail the same way, and spin — so the failure ends the
        // waking and reaches whoever is awaiting this Turn.
        failed = true;
        throw error;
      })
      .finally(() => {
        this.#controller = undefined;
        if (!this.#disposeRequested) this.#setStatus("idle");
        if (!this.#disposeRequested && !failed && this.#inbox.length > 0) {
          this.#wake();
        }
      });
    this.#activity = activity;
  }

  async #drive(signal: AbortSignal): Promise<void> {
    if (this.#resumeRequested) {
      this.#resumeRequested = false;
      await this.#resumeTurn(signal);
    }
    while (!signal.aborted && this.#inbox.length > 0) {
      await this.#runTurn(signal);
    }
  }

  async #resumeTurn(signal: AbortSignal): Promise<void> {
    let openTurn: number | undefined;
    let latestStep = 0;
    let latestStepStatus: "none" | "open" | "ended" = "none";
    let latestStepOutcome: StepOutcome | undefined;
    let unresolvedRequest: NormalizedModelRequest | undefined;
    let definitiveNoEffect:
      Extract<SessionEvent, { type: "model/effect-not-started" }> | undefined;
    for (const event of this.session.events) {
      if (event.type === "turn/start") {
        openTurn = event.turn;
        latestStep = 0;
        latestStepStatus = "none";
        latestStepOutcome = undefined;
        unresolvedRequest = undefined;
        definitiveNoEffect = undefined;
      }
      if (event.type === "turn/end" && event.turn === openTurn)
        openTurn = undefined;
      if (event.type === "step/start" && event.turn === openTurn) {
        latestStep = Math.max(latestStep, event.step);
        latestStepStatus = "open";
        latestStepOutcome = undefined;
      }
      if (
        event.type === "step/end" &&
        event.turn === openTurn &&
        event.step === latestStep
      ) {
        latestStepStatus = "ended";
        latestStepOutcome = event.outcome;
      }
      if (event.type === "model/request" && event.turn === openTurn) {
        unresolvedRequest = event.request;
        definitiveNoEffect = undefined;
      }
      if (
        event.type === "model/effect-not-started" &&
        event.requestId === unresolvedRequest?.requestId
      ) {
        definitiveNoEffect = event;
      }
      if (
        event.type === "assistant/message" &&
        event.requestId === unresolvedRequest?.requestId
      ) {
        unresolvedRequest = undefined;
        definitiveNoEffect = undefined;
      }
    }
    if (openTurn === undefined)
      throw new Error("session has no resumable turn");
    let latestAssistant:
      Extract<SessionEvent, { type: "assistant/message" }> | undefined;
    for (const event of this.session.events) {
      if (
        event.type === "assistant/message" &&
        event.turn === openTurn &&
        event.step === latestStep
      ) {
        latestAssistant = event;
      }
    }
    let openStep: number | undefined;
    let turnOutcome: StepOutcome = "interrupted";
    let turnReason: string | undefined;
    let reconciliationRequired = false;
    this.#armTurnDeadline();
    try {
      if (latestAssistant) {
        await this.#notifyModelOutcome(latestAssistant.requestId, "completed");
      }
      let nextStep = latestStep === 0 ? 1 : latestStep + 1;
      if (unresolvedRequest) {
        openStep = latestStep;
        if (definitiveNoEffect) {
          await this.#notifyModelOutcome(
            definitiveNoEffect.requestId,
            "not-started",
          );
          turnOutcome = "model-error";
          turnReason = turnEndReason(definitiveNoEffect.reason);
          this.#ctx.emit(
            "agent/error",
            this,
            new LlmEffectNotStartedError(definitiveNoEffect.reason),
          );
          return;
        }
        const reconciliation = await this.#reconcileModel(
          unresolvedRequest,
          openTurn,
          latestStep,
          signal,
        );
        if (reconciliation.status === "not-retrievable") {
          // No later attempt can retrieve this effect, so the run settles now.
          // The chunks already journaled stay in the session, so whatever the
          // model produced before the interruption is still shown.
          await this.#notifyModelOutcome(
            unresolvedRequest.requestId,
            "not-started",
          );
          turnOutcome = "model-error";
          turnReason = turnEndReason(reconciliation.reason);
          this.#ctx.emit("agent/error", this, new Error(reconciliation.reason));
          return;
        }
        if (reconciliation.status === "unavailable") {
          const existing = this.session.events.findLast(
            (event) =>
              event.type === "model/reconciliation-required" &&
              event.requestId === unresolvedRequest.requestId,
          );
          if (
            existing?.type !== "model/reconciliation-required" ||
            existing.reason !== reconciliation.reason
          ) {
            this.session.append({
              type: "model/reconciliation-required",
              turn: openTurn,
              step: latestStep,
              requestId: unresolvedRequest.requestId,
              reason: reconciliation.reason,
            });
          }
          reconciliationRequired = true;
          return;
        }
        const { response } = reconciliation;
        this.session.append({
          type: "assistant/message",
          turn: openTurn,
          step: latestStep,
          requestId: response.request.requestId,
          text: response.text,
          toolCalls: response.toolCalls,
        });
        await this.session.flush();
        signal.throwIfAborted();
        await this.#notifyModelOutcome(response.request.requestId, "completed");
        await this.#announceAssistantText(response, openTurn, latestStep);
        if (response.toolCalls.length === 0) {
          const shouldStop = await this.#stepShouldStop(
            openTurn,
            latestStep,
            { kind: "stop" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step: latestStep,
            outcome: "completed",
          });
          openStep = undefined;
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        } else {
          const endsTurn = await this.#executeTools(
            toolCallOccurrences(openTurn, latestStep, response.toolCalls),
            signal,
          );
          signal.throwIfAborted();
          const shouldStop = await this.#stepShouldStop(
            openTurn,
            latestStep,
            { kind: endsTurn ? "stop" : "continue" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step: latestStep,
            outcome: "completed",
          });
          openStep = undefined;
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        }
        nextStep = latestStep + 1;
      } else if (latestStepStatus === "open" && latestAssistant) {
        openStep = latestStep;
        if (latestAssistant.toolCalls.length === 0) {
          const shouldStop = await this.#stepShouldStop(
            openTurn,
            latestStep,
            { kind: "stop" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step: latestStep,
            outcome: "completed",
          });
          openStep = undefined;
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        } else {
          const occurrences = toolCallOccurrences(
            openTurn,
            latestStep,
            latestAssistant.toolCalls,
          );
          const endsTurn = await this.#executeTools(occurrences, signal);
          signal.throwIfAborted();
          const shouldStop = await this.#stepShouldStop(
            openTurn,
            latestStep,
            { kind: endsTurn ? "stop" : "continue" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step: latestStep,
            outcome: "completed",
          });
          openStep = undefined;
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        }
        nextStep = latestStep + 1;
      } else if (latestStepStatus === "ended") {
        turnOutcome = latestStepOutcome ?? "interrupted";
        if (
          turnOutcome !== "completed" ||
          !latestAssistant ||
          latestAssistant.toolCalls.length === 0
        ) {
          return;
        }
      } else if (latestStepStatus === "open") {
        nextStep = latestStep;
      }
      for (let step = nextStep; step <= this.#maxSteps; step += 1) {
        signal.throwIfAborted();
        openStep = step;
        if (!(latestStepStatus === "open" && step === latestStep)) {
          this.session.append({ type: "step/start", turn: openTurn, step });
        }
        const response = await this.#requestModel(openTurn, step, signal);
        this.session.append({
          type: "assistant/message",
          turn: openTurn,
          step,
          requestId: response.request.requestId,
          text: response.text,
          toolCalls: response.toolCalls,
        });
        await this.session.flush();
        signal.throwIfAborted();
        await this.#notifyModelOutcome(response.request.requestId, "completed");
        await this.#announceAssistantText(response, openTurn, step);
        if (response.toolCalls.length === 0) {
          const shouldStop = await this.#stepShouldStop(
            openTurn,
            step,
            { kind: "stop" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step,
            outcome: "completed",
          });
          openStep = undefined;
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        } else {
          const endsTurn = await this.#executeTools(
            toolCallOccurrences(openTurn, step, response.toolCalls),
            signal,
          );
          signal.throwIfAborted();
          const shouldStop = await this.#stepShouldStop(
            openTurn,
            step,
            { kind: endsTurn ? "stop" : "continue" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step,
            outcome: "completed",
          });
          openStep = undefined;
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        }
      }
      throw new StepLimitReachedError(this.#maxSteps);
    } catch (error) {
      if (this.#turnDeadlineReached) {
        turnOutcome = "interrupted";
        turnReason = this.#deadlineTurnReason(error);
      } else if (
        error instanceof ModelEffectReconciliationRequiredError ||
        error instanceof ToolEffectReconciliationRequiredError ||
        error instanceof ModelOutcomeSettlementRequiredError ||
        (signal.aborted && hasUnsettledExternalEffect(this.session.events))
      ) {
        reconciliationRequired = true;
        this.#ctx.emit("agent/error", this, error);
      } else if (
        error instanceof EffectAdmissionFencedError ||
        signal.aborted
      ) {
        turnOutcome = "cancelled";
        turnReason = this.#cancelDetail;
      } else if (error instanceof StepLimitReachedError) {
        // The Turn ran out of room, which is not a failure of the model.
        turnOutcome = "interrupted";
        turnReason = turnEndReason(error.message);
      } else {
        turnOutcome = "model-error";
        turnReason = turnEndReason(modelFailureMessage(error));
        this.#ctx.emit("agent/error", this, error);
      }
    } finally {
      this.#disarmTurnDeadline();
      // A Turn owed a reconciliation writes no `turn/end`: its model request
      // has no durable outcome, and a `turn/end` would claim to know how it
      // ended. That is right for as long as the run might still resume — and
      // the moment it will not, the Turn is closed by whoever settles it, in
      // `kernel-do`'s `settledEventsV1`. Closing it here instead would either
      // lie about an outcome or make the run unresumable (ADR 0028).
      if (!reconciliationRequired) {
        // A deadline settles the same way a Stop does: an open tool
        // occurrence gets an `interrupted` result before the step closes,
        // so the journal never carries a `turn/end` over an open call.
        if (
          openStep !== undefined &&
          (turnOutcome === "cancelled" || this.#turnDeadlineReached)
        ) {
          await this.#settleCancelledStep(openTurn, openStep);
        }
        if (openStep !== undefined) {
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step: openStep,
            outcome: turnOutcome,
          });
        }
        this.session.append({
          type: "turn/end",
          turn: openTurn,
          outcome: turnOutcome,
          ...(turnOutcome !== "completed" && turnReason !== undefined
            ? { reason: turnReason }
            : {}),
        });
      }
      await this.session.flush();
      await this.#ctx.serial("agent/turn-stopping", this, openTurn);
    }
  }

  async #runTurn(signal: AbortSignal): Promise<void> {
    const input = this.#inbox[0];
    if (!input) return;
    const turn = this.session.nextTurn();
    this.session.appendBatch([
      { type: "turn/start", turn },
      {
        type: "composition/pinned",
        turn,
        generationId: this.#composition.generationId,
        artifactSetHash: this.#composition.artifactSetHash,
      },
      { type: "turn/admission", turn, turnType: this.#turnType },
      { type: "input/admitted", messageId: input.messageId, turn },
    ]);
    // Claimed before the flush, not after: the input has been journaled as
    // admitted, and leaving it in the inbox while the write settles meant a
    // failed first flush handed it straight back to `#wake`.
    this.#inbox.shift();
    await this.session.flush();
    this.#ctx.emit("agent/inbox/claimed", this, [input], turn);

    let openStep: number | undefined;
    let turnOutcome: StepOutcome = "interrupted";
    let turnReason: string | undefined;
    let reconciliationRequired = false;
    this.#armTurnDeadline();
    try {
      let inputs = [input];
      for (let step = 1; step <= this.#maxSteps; step += 1) {
        signal.throwIfAborted();
        const decision = await this.#ctx.waterfall(
          "agent/pre-step",
          this,
          inputs,
          turn,
          step,
          () => Promise.resolve<PreStepDecision>({ kind: "enter", inputs }),
        );
        if (decision.kind === "reject") {
          turnOutcome = "blocked";
          turnReason = turnEndReason(decision.reason);
          return;
        }

        openStep = step;
        this.session.append({ type: "step/start", turn, step });
        for (const admitted of decision.inputs) {
          this.session.append({
            type: "user/message",
            turn,
            step,
            messageId: admitted.messageId,
            text: admitted.text,
          });
        }

        const response = await this.#requestModel(turn, step, signal);
        this.session.append({
          type: "assistant/message",
          turn,
          step,
          requestId: response.request.requestId,
          text: response.text,
          toolCalls: response.toolCalls,
        });
        await this.session.flush();
        signal.throwIfAborted();
        await this.#notifyModelOutcome(response.request.requestId, "completed");
        await this.#announceAssistantText(response, turn, step);

        if (response.toolCalls.length === 0) {
          const shouldStop = await this.#stepShouldStop(
            turn,
            step,
            { kind: "stop" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn,
            step,
            outcome: "completed",
          });
          openStep = undefined;
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        } else {
          const endsTurn = await this.#executeTools(
            toolCallOccurrences(turn, step, response.toolCalls),
            signal,
          );
          signal.throwIfAborted();
          const shouldStop = await this.#stepShouldStop(
            turn,
            step,
            { kind: endsTurn ? "stop" : "continue" },
            signal,
          );
          this.session.append({
            type: "step/end",
            turn,
            step,
            outcome: "completed",
          });
          openStep = undefined;
          // A tool result that ends the Turn closes it here unless declared
          // termination policy replaces that default for this step.
          if (shouldStop) {
            turnOutcome = "completed";
            return;
          }
        }
        inputs = [];
      }
      throw new StepLimitReachedError(this.#maxSteps);
    } catch (error) {
      if (this.#turnDeadlineReached) {
        turnOutcome = "interrupted";
        turnReason = this.#deadlineTurnReason(error);
      } else if (
        error instanceof ModelEffectReconciliationRequiredError ||
        error instanceof ToolEffectReconciliationRequiredError ||
        error instanceof ModelOutcomeSettlementRequiredError ||
        (signal.aborted && hasUnsettledExternalEffect(this.session.events))
      ) {
        reconciliationRequired = true;
        this.#ctx.emit("agent/error", this, error);
      } else if (
        error instanceof EffectAdmissionFencedError ||
        signal.aborted
      ) {
        turnOutcome = "cancelled";
        turnReason = this.#cancelDetail;
      } else if (error instanceof StepLimitReachedError) {
        // The Turn ran out of room, which is not a failure of the model.
        turnOutcome = "interrupted";
        turnReason = turnEndReason(error.message);
      } else {
        turnOutcome = "model-error";
        turnReason = turnEndReason(modelFailureMessage(error));
        this.#ctx.emit("agent/error", this, error);
      }
    } finally {
      this.#disarmTurnDeadline();
      // A Turn owed a reconciliation writes no `turn/end`: its model request
      // has no durable outcome, and a `turn/end` would claim to know how it
      // ended. That is right for as long as the run might still resume — and
      // the moment it will not, the Turn is closed by whoever settles it, in
      // `kernel-do`'s `settledEventsV1`. Closing it here instead would either
      // lie about an outcome or make the run unresumable (ADR 0028).
      if (!reconciliationRequired) {
        // A deadline settles the same way a Stop does: an open tool
        // occurrence gets an `interrupted` result before the step closes,
        // so the journal never carries a `turn/end` over an open call.
        if (
          openStep !== undefined &&
          (turnOutcome === "cancelled" || this.#turnDeadlineReached)
        ) {
          await this.#settleCancelledStep(turn, openStep);
        }
        if (openStep !== undefined) {
          this.session.append({
            type: "step/end",
            turn,
            step: openStep,
            outcome: turnOutcome,
          });
        }
        this.session.append({
          type: "turn/end",
          turn,
          outcome: turnOutcome,
          ...(turnOutcome !== "completed" && turnReason !== undefined
            ? { reason: turnReason }
            : {}),
        });
      }
      await this.session.flush();
      await this.#ctx.serial("agent/turn-stopping", this, turn);
    }
  }

  async #notifyModelOutcome(
    requestId: string,
    outcome: "completed" | "not-started",
  ): Promise<void> {
    try {
      await this.#ctx.serial(
        "agent/model-outcome-committed",
        this,
        requestId,
        outcome,
      );
    } catch (error) {
      throw new ModelOutcomeSettlementRequiredError(error);
    }
  }

  async #requestModel(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    validateSettledToolOccurrenceJournal(this.session.events);
    const assembly = await this.#ctx.systemPrompt.assemble({
      sessionId: this.session.id,
      provider: this.#options.provider,
      model: this.#options.model,
      // The same turn type the tool catalog is trimmed to. A section that
      // renders what a Turn may do would otherwise have to guess it.
      turnType: this.#turnType,
    });

    // One automatic retry, and only for a failure the provider itself
    // classified as "the request never started" — a rejected key, an
    // unresolvable binding, a connection refused before any byte was sent.
    // Those are exactly the failures where retrying cannot duplicate anything,
    // and the ones a person watching a blank screen would retry by hand. Every
    // other failure is uncertain and is never retried, which is the whole of
    // ADR 0024's durability contract.
    let attempts = 0;
    while (true) {
      attempts += 1;
      const proposedMessages = this.session.deriveMessages();
      const messages = await this.#ctx.waterfall(
        "agent/message-window",
        this,
        proposedMessages,
        turn,
        step,
        signal,
        () => Promise.resolve(proposedMessages),
      );
      const proposedTools = this.#ctx.tools.schemas({
        turnType: this.#turnType,
        ...(this.#subagentRole === undefined
          ? {}
          : { subagentRole: this.#subagentRole }),
      });
      const tools = await this.#ctx.waterfall(
        "agent/tool-exposure",
        this,
        proposedTools,
        turn,
        step,
        signal,
        () => Promise.resolve(proposedTools),
      );
      const proposed: NormalizedModelRequest = {
        requestId: crypto.randomUUID(),
        provider: this.#options.provider,
        model: this.#options.model,
        system: assembly.text,
        messages,
        tools,
        ...(this.#options.modelBinding
          ? { modelBinding: structuredClone(this.#options.modelBinding) }
          : {}),
      };
      const request = await this.#ctx.waterfall(
        "agent/request",
        this,
        proposed,
        signal,
        () => Promise.resolve(proposed),
      );
      this.session.append({ type: "model/request", turn, step, request });
      await this.session.flush();
      if (
        !(await this.#options.admitEffect({
          kind: "model",
          effectId: request.requestId,
        }))
      ) {
        this.session.append({
          type: "model/effect-not-started",
          turn,
          step,
          requestId: request.requestId,
          reason: "Durable Stop fenced provider execution",
        });
        await this.session.flush();
        throw new EffectAdmissionFencedError(request.requestId);
      }

      try {
        return await this.#consumeStream(request, turn, step, signal);
      } catch (error) {
        if (signal.aborted) {
          const reason = `Model response outcome is uncertain after cancellation: ${modelFailureMessage(error)}`;
          this.session.append({
            type: "model/reconciliation-required",
            turn,
            step,
            requestId: request.requestId,
            reason,
          });
          await this.session.flush();
          throw new ModelEffectReconciliationRequiredError(
            request.requestId,
            reason,
          );
        }
        if (!(error instanceof ModelProviderFailureError)) {
          const reason = `Model response outcome is uncertain: ${modelFailureMessage(error)}`;
          this.session.append({
            type: "model/reconciliation-required",
            turn,
            step,
            requestId: request.requestId,
            reason,
          });
          await this.session.flush();
          throw new ModelEffectReconciliationRequiredError(
            request.requestId,
            reason,
          );
        }
        this.session.append({
          type: "model/effect-not-started",
          turn,
          step,
          requestId: request.requestId,
          reason: modelFailureMessage(error),
        });
        await this.session.flush();
        await this.#notifyModelOutcome(request.requestId, "not-started");
        const retry = nextModelRetryV1({
          failure: error,
          attempt: attempts,
          deadlineAt: this.#turnDeadlineAt,
          runtime: this.#retry,
        });
        // A Package can refuse a planned retry, or replace a permanent failure
        // with a provider-owned fallback. It cannot turn a permanent failure
        // into another attempt against the same model.
        const action = await this.#ctx.waterfall(
          "agent/request-error",
          this,
          error,
          signal,
          () =>
            Promise.resolve(
              retry
                ? ({ kind: "retry" } as const)
                : ({ kind: "fail" } as const),
            ),
        );
        if (action.kind === "fail") throw error;
        if (action.kind === "retry" && !retry) throw error;
        const delayMs = action.kind === "fallback" ? 0 : retry!.delayMs;
        this.session.append({
          type: "model/retry",
          turn,
          step,
          attempt: attempts + 1,
          classification: error.classification,
          delayMs,
        });
        await this.session.flush();
        this.#ctx.emit("agent/error", this, error);
        await this.#retry.sleep(delayMs, signal);
      }
    }
  }

  async #consumeStream(
    request: NormalizedModelRequest,
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    let text = "";
    const toolCalls: ToolCall[] = [];
    let receivedProviderEvent = false;
    try {
      for await (const event of this.#ctx.llm.stream(request, signal)) {
        receivedProviderEvent = true;
        signal.throwIfAborted();
        this.#applyStreamEvent(
          event,
          request.requestId,
          turn,
          step,
          toolCalls,
          (delta) => {
            text += delta;
          },
        );
      }
    } catch (error) {
      if (receivedProviderEvent && error instanceof ModelProviderFailureError) {
        throw new Error(
          error.message ||
            "Model provider reported a retryable failure after returning response data",
        );
      }
      throw error;
    }
    return { request, text, toolCalls };
  }

  async #reconcileModel(
    request: NormalizedModelRequest,
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<ModelReconciliation> {
    const reconciliation = await this.#ctx.llm.reconcile(request, signal);
    if (reconciliation.status !== "recovered") return reconciliation;
    const durablePrefix = this.session.events.flatMap((event) =>
      event.type === "assistant/chunk" &&
      event.turn === turn &&
      event.step === step &&
      event.requestId === request.requestId
        ? [{ type: "text-delta" as const, text: event.text }]
        : [],
    );
    const recoveredTextDeltas = reconciliation.events.flatMap((event) =>
      event.type === "text-delta" ? [event] : [],
    );
    const prefixMatches = durablePrefix.every((event, index) => {
      const recovered = recoveredTextDeltas[index];
      return recovered?.text === event.text;
    });
    if (!prefixMatches || recoveredTextDeltas.length < durablePrefix.length) {
      return {
        status: "unavailable",
        reason: `Provider-bound retrieval diverged from durable response prefix for request "${request.requestId}"`,
      };
    }
    const finishIndexes = reconciliation.events.flatMap((event, index) =>
      event.type === "finish" ? [index] : [],
    );
    if (
      finishIndexes.length !== 1 ||
      finishIndexes[0] !== reconciliation.events.length - 1
    ) {
      return {
        status: "unavailable",
        reason: `Provider-bound retrieval returned an invalid event structure for request "${request.requestId}"`,
      };
    }
    let text = "";
    const toolCalls: ToolCall[] = [];
    let textDeltaIndex = 0;
    for (const event of reconciliation.events) {
      signal.throwIfAborted();
      const journalTextDelta =
        event.type !== "text-delta" || textDeltaIndex >= durablePrefix.length;
      this.#applyStreamEvent(
        event,
        request.requestId,
        turn,
        step,
        toolCalls,
        (delta) => {
          text += delta;
        },
        journalTextDelta,
      );
      if (event.type === "text-delta") textDeltaIndex += 1;
    }
    return {
      status: "recovered",
      response: { request, text, toolCalls },
    };
  }

  #applyStreamEvent(
    event: LlmStreamEvent,
    requestId: string,
    turn: number,
    step: number,
    toolCalls: ToolCall[],
    appendText: (text: string) => void,
    journal = true,
  ): void {
    if (event.type === "text-delta") {
      appendText(event.text);
      if (journal) {
        this.session.append({
          type: "assistant/chunk",
          turn,
          step,
          requestId,
          text: event.text,
        });
      }
    } else if (event.type === "tool-call") {
      toolCalls.push(event.call);
    }
  }

  /**
   * Runs every occurrence and reports whether any result ended the Turn. The
   * boolean is per *result*, not per definition: one tool can end a Turn for
   * one payload and not another, and the kernel never inspects which.
   */
  async #executeTools(
    occurrences: readonly ToolCallOccurrence[],
    signal: AbortSignal,
  ): Promise<boolean> {
    let endsTurn = false;
    for (const occurrence of occurrences) {
      signal.throwIfAborted();
      const { call, occurrenceId, turn, step } = occurrence;
      const journal = validateToolOccurrenceJournal(this.session.events);
      const existing = journal.get(occurrenceId);
      if (existing?.result) continue;
      const context = {
        botId: this.botId,
        agentId: this.id,
        sessionId: this.session.id,
        effectId: occurrenceId,
        toolCall: call,
        compositionGenerationId: this.#composition.generationId,
        turnType: this.#turnType,
        ...(this.#subagentRole === undefined
          ? {}
          : { subagentRole: this.#subagentRole }),
        signal,
      };
      const preparation = await this.#ctx.tools.prepare(call, context);
      signal.throwIfAborted();
      if (existing?.intent && preparation.kind !== "ready") {
        throw new ToolEffectReconciliationRequiredError(
          occurrenceId,
          `Tool effect "${occurrenceId}" cannot be reconciled because its definition is unavailable`,
        );
      }
      if (!existing?.intent) {
        this.session.append({
          type: "tool/call",
          turn,
          step,
          occurrenceId,
          name: call.name,
          input: call.input,
        });
        await this.session.flush();
        if (signal.aborted) {
          this.session.append({
            type: "tool/result",
            turn,
            step,
            occurrenceId,
            name: call.name,
            content: "Cancelled before tool execution started.",
            isError: true,
            status: "interrupted",
          });
          await this.session.flush();
          signal.throwIfAborted();
        }
      }
      let result: ToolExecutionResult;
      if (existing?.intent) {
        if (preparation.kind !== "ready") {
          throw new ToolEffectReconciliationRequiredError(
            occurrenceId,
            `Tool effect "${occurrenceId}" cannot be reconciled because its definition is unavailable`,
          );
        }
        const reconciliation = await this.#ctx.tools.reconcilePrepared(
          preparation,
          context,
        );
        if (reconciliation.status === "unavailable") {
          throw new ToolEffectReconciliationRequiredError(
            occurrenceId,
            reconciliation.reason,
          );
        }
        result = reconciliation.result;
      } else if (preparation.kind === "denied") {
        result = preparation.result;
        this.#ctx.emit("tools/result", call, result);
      } else {
        if (
          !(await this.#options.admitEffect({
            kind: "tool",
            effectId: occurrenceId,
          }))
        ) {
          this.session.append({
            type: "tool/result",
            turn,
            step,
            occurrenceId,
            name: call.name,
            content: "Cancelled before tool execution started.",
            isError: true,
            status: "interrupted",
          });
          await this.session.flush();
          throw new EffectAdmissionFencedError(occurrenceId);
        }
        try {
          result = await this.#ctx.tools.executePrepared(preparation, context);
        } catch (error) {
          if (signal.aborted || !preparation.idempotent) {
            throw new ToolEffectReconciliationRequiredError(
              occurrenceId,
              signal.aborted
                ? `Tool effect "${occurrenceId}" outcome is uncertain after cancellation`
                : `Non-idempotent tool effect "${occurrenceId}" outcome is uncertain`,
            );
          }
          result = {
            content:
              error instanceof Error ? error.message : "Tool execution failed",
            isError: true,
          };
          this.#ctx.emit("tools/result", call, result);
        }
      }
      if (result.endsTurn === true) endsTurn = true;
      this.session.append({
        type: "tool/result",
        turn,
        step,
        occurrenceId,
        name: call.name,
        content: result.content,
        isError: result.isError,
        status: "completed",
        ...(result.attachments && result.attachments.length > 0
          ? { attachments: result.attachments }
          : {}),
      });
      await this.session.flush();
    }
    return endsTurn;
  }

  /**
   * Raises `agent/assistant-text` for a step that wrote something and then
   * called tools, so a Package that owns the Bot's voice can do something with
   * words the model addressed to the person.
   *
   * Only that shape. A step with no tool calls ends the Turn on its assistant
   * message, which every surface already draws; a step with tools and no text
   * has nothing to say. The narrow case is the one that went missing: text and
   * tools together, where the text is an acknowledgement and the tools are the
   * work it was announcing.
   */
  async #announceAssistantText(
    response: ModelResponse,
    turn: number,
    step: number,
  ): Promise<void> {
    if (response.toolCalls.length === 0) return;
    if (response.text.trim().length === 0) return;
    await this.#ctx.serial("agent/assistant-text", this, response.text, {
      turn,
      step,
      requestId: response.request.requestId,
    });
  }

  async #stepShouldStop(
    turn: number,
    step: number,
    proposed: LoopStepContinuationV1,
    signal: AbortSignal,
  ): Promise<boolean> {
    const decision = await this.#ctx.waterfall(
      "agent/step-continuation",
      this,
      proposed,
      turn,
      step,
      signal,
      () => Promise.resolve(proposed),
    );
    return decision.kind === "stop";
  }

  /**
   * The reason a Turn the clock ended carries, and the one place that decides
   * a deadline is not a cancellation and not a reconciliation.
   *
   * Its branch runs ahead of both. Ahead of cancellation, because the deadline
   * aborts the same controller Stop does and a Turn the clock ended must not
   * be reported to the person as one they stopped. Ahead of reconciliation,
   * because that branch writes no `turn/end` on the promise the run may still
   * resume — and a run the deadline stopped never will. Deferring to it left
   * `model/reconciliation-required` as the last event of an open Turn, and
   * every later Turn on that Bot refused with `409` for the life of the Bot.
   *
   * The uncertainty is still recorded: whatever the model request wrote before
   * the clock ran out stays in the journal. What changes is that the Turn is
   * settled — the open step's tool occurrences closed as `interrupted`, then
   * `step/end` and `turn/end` — exactly as `kernel-do`'s `settledEventsV1`
   * settles a Stop or a supersede.
   */
  #deadlineTurnReason(error: unknown): string | undefined {
    this.#ctx.emit("agent/error", this, error);
    return turnEndReason(TURN_DEADLINE_REASON_V1);
  }

  async #settleCancelledStep(turn: number, step: number): Promise<void> {
    const assistant = this.session.events.findLast(
      (event) =>
        event.type === "assistant/message" &&
        event.turn === turn &&
        event.step === step,
    );
    if (
      !assistant ||
      assistant.type !== "assistant/message" ||
      assistant.toolCalls.length === 0
    ) {
      return;
    }

    const journal = validateToolOccurrenceJournal(this.session.events);
    for (const occurrence of toolCallOccurrences(
      turn,
      step,
      assistant.toolCalls,
    )) {
      const entry = journal.get(occurrence.occurrenceId);
      if (!entry?.intent) {
        this.session.append({
          type: "tool/call",
          turn,
          step,
          occurrenceId: occurrence.occurrenceId,
          name: occurrence.call.name,
          input: occurrence.call.input,
        });
      }
      if (!entry?.result) {
        this.session.append({
          type: "tool/result",
          turn,
          step,
          occurrenceId: occurrence.occurrenceId,
          name: occurrence.call.name,
          content: "Cancelled before tool execution started.",
          isError: true,
          status: "interrupted",
        });
      }
    }
    await this.session.flush();
  }
}

export class AgentLoop extends Service implements AgentFactory {
  static inject = ["sessions", "systemPrompt", "llm", "tools", "agents"];
  private maxSteps: number;
  private turnDeadlineMs: number;
  private composition: CompositionPinV1;
  private retry: ModelRetryPolicyRuntimeV1;
  private handles = new Set<AgentHandle>();

  constructor(ctx: Context, config: AgentLoopConfig) {
    super(ctx, "agentLoop");
    this.composition = config.composition;
    this.maxSteps = config.maxSteps ?? 20;
    this.turnDeadlineMs = config.turnDeadlineMs ?? TURN_DEADLINE_MS_V1;
    this.retry = {
      now: config.retry?.now ?? Date.now,
      random: config.retry?.random ?? Math.random,
      sleep: config.retry?.sleep ?? defaultModelRetrySleepV1,
    };
    if (!Number.isInteger(this.maxSteps) || this.maxSteps <= 0) {
      throw new Error("agent-loop maxSteps must be a positive integer");
    }
    if (!this.composition?.generationId || !this.composition.artifactSetHash) {
      throw new Error("agent-loop requires a pinned Composition generation");
    }
  }

  async create(options: AgentOptions): Promise<AgentHandle> {
    const session = this.ctx.sessions.create(options.sessionId);
    const agent = new LoopAgent(
      this.ctx,
      session,
      options as EffectAdmittingAgentOptions,
      this.maxSteps,
      this.composition,
      this.turnDeadlineMs,
      this.retry,
    );
    const unregister = this.ctx.agents.register(agent);
    let disposed = false;
    let handle: AgentHandle;
    handle = {
      agent,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await agent.dispose();
        unregister();
        this.ctx.sessions.disposeSession(options.sessionId);
        this.handles.delete(handle);
      },
    };
    this.handles.add(handle);
    return handle;
  }

  [Service.init](): () => Promise<void> {
    const unsetFactory = this.ctx.agents.setFactory(this);
    return async () => {
      await Promise.all([...this.handles].map((handle) => handle.dispose()));
      unsetFactory();
    };
  }
}

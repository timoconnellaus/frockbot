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
  type LoopStepContinuationV1,
  type Session,
  type SessionEvent,
  type StepOutcome,
  type ToolCall,
  type TurnTypeV1,
  TURN_DEADLINE_MS_V1,
  toolCallOccurrences,
  turnEndReason,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import { type Context, Service } from "cordis";
import {
  EffectAdmissionFencedError,
  modelFailureMessage,
  ModelEffectReconciliationRequiredError,
  ModelOutcomeSettlementRequiredError,
  StepLimitReachedError,
  ToolEffectReconciliationRequiredError,
  TURN_DEADLINE_REASON_V1,
} from "./errors.js";
import { requestModelV1 } from "./model-request.js";
import { planResumptionV1, recoverModelRequestV1 } from "./resume.js";
import type {
  EffectAdmittingAgentOptions,
  LoopRuntime,
  ModelResponse,
  TurnCursor,
  TurnSettlement,
} from "./runtime.js";
import { executeToolsV1 } from "./tool-execution.js";
import {
  defaultModelRetrySleepV1,
  type ModelRetryPolicyRuntimeV1,
} from "./retry-policy.js";

export * from "./retry-policy.js";
export {
  MODEL_REQUEST_ATTEMPTS_V1,
  STEP_LIMIT_REASON_V1,
  TURN_DEADLINE_REASON_V1,
} from "./errors.js";
export { estimateModelUsageV1 } from "./model-request.js";

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

declare module "cordis" {
  interface Context {
    agentLoop: AgentLoop;
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

class LoopAgent implements Agent, LoopRuntime {
  readonly id: string;
  readonly botId: string;
  readonly session: Session;
  readonly ctx: Context;
  readonly options: EffectAdmittingAgentOptions;
  readonly maxSteps: number;
  readonly composition: CompositionPinV1;
  /** The turn type every Turn of this Agent is admitted as. */
  readonly turnType: TurnTypeV1;
  /** The subagent role that turn type was admitted under, when it has one. */
  readonly subagentRole: string | undefined;
  readonly retry: ModelRetryPolicyRuntimeV1;
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

  constructor(
    ctx: Context,
    session: Session,
    options: EffectAdmittingAgentOptions,
    maxSteps: number,
    composition: CompositionPinV1,
    turnDeadlineMs: number,
    retry: ModelRetryPolicyRuntimeV1,
  ) {
    this.ctx = ctx;
    this.composition = composition;
    this.session = session;
    this.botId = options.botId;
    const explicitAgentId = (
      options as AgentOptions & { agentId?: string }
    ).agentId?.trim();
    this.id = explicitAgentId || options.sessionId;
    this.options = options;
    this.turnType = options.turnType ?? "chat";
    this.subagentRole = options.subagentRole;
    this.maxSteps = maxSteps;
    this.#turnDeadlineMs = turnDeadlineMs;
    this.retry = retry;
  }

  get agent(): Agent {
    return this;
  }

  get turnDeadlineAt(): number {
    return this.#turnDeadlineAt;
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
    this.ctx.emit("agent/inbox/inserted", this, input);
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
    this.ctx.emit("agent/cancel-requested", this, reason);
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
    this.#turnDeadlineAt = this.retry.now() + this.#turnDeadlineMs;
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
    this.ctx.emit("agent/status", this, status);
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

  /**
   * The Turn's clock, its failure classification and its settlement, around a
   * body that only has to say how the Turn finished.
   */
  async #driveTurn(
    turn: number,
    body: (cursor: TurnCursor) => Promise<TurnSettlement>,
    signal: AbortSignal,
  ): Promise<void> {
    const cursor: TurnCursor = { openStep: undefined };
    let turnOutcome: StepOutcome = "interrupted";
    let turnReason: string | undefined;
    let reconciliationRequired = false;
    this.#armTurnDeadline();
    try {
      const settlement = await body(cursor);
      if (settlement.kind === "reconciliation-required") {
        reconciliationRequired = true;
      } else {
        turnOutcome = settlement.outcome;
        turnReason = settlement.reason;
      }
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
        this.ctx.emit("agent/error", this, error);
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
        this.ctx.emit("agent/error", this, error);
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
          cursor.openStep !== undefined &&
          (turnOutcome === "cancelled" || this.#turnDeadlineReached)
        ) {
          await this.#settleCancelledStep(turn, cursor.openStep);
        }
        if (cursor.openStep !== undefined) {
          this.session.append({
            type: "step/end",
            turn,
            step: cursor.openStep,
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
      await this.ctx.serial("agent/turn-stopping", this, turn);
    }
  }

  async #resumeTurn(signal: AbortSignal): Promise<void> {
    const plan = planResumptionV1(this.session.events);
    const openTurn = plan.openTurn;
    if (openTurn === undefined)
      throw new Error("session has no resumable turn");
    const { latestStep, latestStepStatus, latestAssistant } = plan;
    await this.#driveTurn(
      openTurn,
      async (cursor) => {
        if (latestAssistant) {
          await this.notifyModelOutcome(latestAssistant.requestId, "completed");
        }
        let nextStep = latestStep === 0 ? 1 : latestStep + 1;
        if (plan.unresolvedRequest) {
          cursor.openStep = latestStep;
          const recovery = await recoverModelRequestV1(
            this,
            { ...plan, openTurn },
            plan.unresolvedRequest,
            signal,
          );
          if (recovery.kind === "settled") return recovery.settlement;
          await this.#journalAssistantMessage(
            recovery.response,
            openTurn,
            latestStep,
            signal,
          );
          if (
            await this.#completeStep(
              openTurn,
              latestStep,
              recovery.response.toolCalls,
              cursor,
              signal,
            )
          ) {
            return { kind: "settled", outcome: "completed" };
          }
          nextStep = latestStep + 1;
        } else if (latestStepStatus === "open" && latestAssistant) {
          cursor.openStep = latestStep;
          if (
            await this.#completeStep(
              openTurn,
              latestStep,
              latestAssistant.toolCalls,
              cursor,
              signal,
            )
          ) {
            return { kind: "settled", outcome: "completed" };
          }
          nextStep = latestStep + 1;
        } else if (latestStepStatus === "ended") {
          const outcome = plan.latestStepOutcome ?? "interrupted";
          if (
            outcome !== "completed" ||
            !latestAssistant ||
            latestAssistant.toolCalls.length === 0
          ) {
            return { kind: "settled", outcome };
          }
        } else if (latestStepStatus === "open") {
          nextStep = latestStep;
        }
        for (let step = nextStep; step <= this.maxSteps; step += 1) {
          signal.throwIfAborted();
          cursor.openStep = step;
          if (!(latestStepStatus === "open" && step === latestStep)) {
            this.session.append({ type: "step/start", turn: openTurn, step });
          }
          const response = await this.#callModel(openTurn, step, signal);
          if (
            await this.#completeStep(
              openTurn,
              step,
              response.toolCalls,
              cursor,
              signal,
            )
          ) {
            return { kind: "settled", outcome: "completed" };
          }
        }
        throw new StepLimitReachedError(this.maxSteps);
      },
      signal,
    );
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
        generationId: this.composition.generationId,
        artifactSetHash: this.composition.artifactSetHash,
      },
      { type: "turn/admission", turn, turnType: this.turnType },
      { type: "input/admitted", messageId: input.messageId, turn },
    ]);
    // Claimed before the flush, not after: the input has been journaled as
    // admitted, and leaving it in the inbox while the write settles meant a
    // failed first flush handed it straight back to `#wake`.
    this.#inbox.shift();
    await this.session.flush();
    this.ctx.emit("agent/inbox/claimed", this, [input], turn);

    await this.#driveTurn(
      turn,
      async (cursor) => {
        let inputs = [input];
        for (let step = 1; step <= this.maxSteps; step += 1) {
          signal.throwIfAborted();
          const decision = await this.ctx.waterfall(
            "agent/pre-step",
            this,
            inputs,
            turn,
            step,
            () => Promise.resolve<PreStepDecision>({ kind: "enter", inputs }),
          );
          if (decision.kind === "reject") {
            return {
              kind: "settled",
              outcome: "blocked",
              reason: turnEndReason(decision.reason),
            };
          }

          cursor.openStep = step;
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

          const response = await this.#callModel(turn, step, signal);
          // A tool result that ends the Turn closes it here unless declared
          // termination policy replaces that default for this step.
          if (
            await this.#completeStep(
              turn,
              step,
              response.toolCalls,
              cursor,
              signal,
            )
          ) {
            return { kind: "settled", outcome: "completed" };
          }
          inputs = [];
        }
        throw new StepLimitReachedError(this.maxSteps);
      },
      signal,
    );
  }

  /** Asks the model and journals what it said. */
  async #callModel(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await requestModelV1(this, turn, step, signal);
    await this.#journalAssistantMessage(response, turn, step, signal);
    return response;
  }

  async #journalAssistantMessage(
    response: ModelResponse,
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<void> {
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
    await this.notifyModelOutcome(response.request.requestId, "completed");
    await this.#announceAssistantText(response, turn, step);
  }

  /**
   * Runs the step's tool calls, closes the step, and reports whether the Turn
   * stops here.
   */
  async #completeStep(
    turn: number,
    step: number,
    toolCalls: readonly ToolCall[],
    cursor: TurnCursor,
    signal: AbortSignal,
  ): Promise<boolean> {
    let proposed: LoopStepContinuationV1;
    if (toolCalls.length === 0) {
      proposed = { kind: "stop" };
    } else {
      const endsTurn = await executeToolsV1(
        this,
        toolCallOccurrences(turn, step, [...toolCalls]),
        signal,
      );
      signal.throwIfAborted();
      proposed = { kind: endsTurn ? "stop" : "continue" };
    }
    const shouldStop = await this.#stepShouldStop(turn, step, proposed, signal);
    this.session.append({
      type: "step/end",
      turn,
      step,
      outcome: "completed",
    });
    cursor.openStep = undefined;
    return shouldStop;
  }

  async notifyModelOutcome(
    requestId: string,
    outcome: "completed" | "not-started",
  ): Promise<void> {
    try {
      await this.ctx.serial(
        "agent/model-outcome-committed",
        this,
        requestId,
        outcome,
      );
    } catch (error) {
      throw new ModelOutcomeSettlementRequiredError(error);
    }
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
    await this.ctx.serial("agent/assistant-text", this, response.text, {
      turn,
      step,
      requestId: response.request.requestId,
      toolNames: response.toolCalls.map((call) => call.name),
    });
  }

  async #stepShouldStop(
    turn: number,
    step: number,
    proposed: LoopStepContinuationV1,
    signal: AbortSignal,
  ): Promise<boolean> {
    const decision = await this.ctx.waterfall(
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
    this.ctx.emit("agent/error", this, error);
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

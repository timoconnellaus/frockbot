import {
  type Agent,
  type AgentFactory,
  type AgentHandle,
  type AgentInput,
  type AgentOptions,
  type AgentStatus,
  type PreStepDecision,
} from "./agent.js";
import {
  type CompositionPinV1,
  LlmEffectNotStartedError,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type Session,
  type SessionEvent,
  type StepOutcome,
  type ToolCall,
  type ToolCallOccurrence,
  type ToolExecutionResult,
  toolCallOccurrences,
  validateSettledToolOccurrenceJournal,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import { type Context, Service } from "cordis";

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
  /** The Composition generation this mounted root was pinned to at admission. */
  composition: CompositionPinV1;
}

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
  | { status: "unavailable"; reason: string };

class ModelEffectReconciliationRequiredError extends Error {
  constructor(
    readonly requestId: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelEffectReconciliationRequiredError";
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
  #options: AgentOptions;
  #maxSteps: number;
  #composition: CompositionPinV1;
  #status: AgentStatus = "idle";
  #inbox: AgentInput[] = [];
  #activity: Promise<void> = Promise.resolve();
  #controller: AbortController | undefined;
  #disposeRequested = false;
  #resumeRequested = false;

  constructor(
    ctx: Context,
    session: Session,
    options: AgentOptions,
    maxSteps: number,
    composition: CompositionPinV1,
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
    this.#maxSteps = maxSteps;
  }

  get status(): AgentStatus {
    return this.#status;
  }

  send(text: string): string {
    if (this.#disposeRequested)
      throw new Error(`agent "${this.id}" is disposing`);
    const normalized = text.trim();
    if (!normalized) throw new Error("agent input is empty");
    const input = { messageId: crypto.randomUUID(), text: normalized };
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

  cancel(reason: "user" | "shutdown" = "user"): void {
    if (this.#status === "disposed") return;
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
    const activity = this.#drive(this.#controller.signal).finally(() => {
      this.#controller = undefined;
      if (!this.#disposeRequested) this.#setStatus("idle");
      if (!this.#disposeRequested && this.#inbox.length > 0) this.#wake();
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
    let reconciliationRequired = false;
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
        await this.#notifyModelOutcome(response.request.requestId, "completed");
        if (response.toolCalls.length === 0) {
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step: latestStep,
            outcome: "completed",
          });
          openStep = undefined;
          turnOutcome = "completed";
          return;
        }
        await this.#executeTools(
          toolCallOccurrences(openTurn, latestStep, response.toolCalls),
          signal,
        );
        this.session.append({
          type: "step/end",
          turn: openTurn,
          step: latestStep,
          outcome: "completed",
        });
        openStep = undefined;
        nextStep = latestStep + 1;
      } else if (latestStepStatus === "open" && latestAssistant) {
        openStep = latestStep;
        if (latestAssistant.toolCalls.length === 0) {
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step: latestStep,
            outcome: "completed",
          });
          openStep = undefined;
          turnOutcome = "completed";
          return;
        }
        const occurrences = toolCallOccurrences(
          openTurn,
          latestStep,
          latestAssistant.toolCalls,
        );
        const journal = validateToolOccurrenceJournal(this.session.events);
        for (const occurrence of occurrences) {
          const entry = journal.get(occurrence.occurrenceId);
          if (entry?.intent && !entry.result) {
            this.session.append({
              type: "tool/result",
              turn: openTurn,
              step: latestStep,
              occurrenceId: occurrence.occurrenceId,
              name: occurrence.call.name,
              content: "Interrupted before a durable result was recorded.",
              isError: true,
              status: "interrupted",
            });
          }
        }
        await this.session.flush();
        await this.#executeTools(
          occurrences.filter(
            (occurrence) => !journal.get(occurrence.occurrenceId)?.intent,
          ),
          signal,
        );
        this.session.append({
          type: "step/end",
          turn: openTurn,
          step: latestStep,
          outcome: "completed",
        });
        openStep = undefined;
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
        await this.#notifyModelOutcome(response.request.requestId, "completed");
        if (response.toolCalls.length === 0) {
          this.session.append({
            type: "step/end",
            turn: openTurn,
            step,
            outcome: "completed",
          });
          openStep = undefined;
          turnOutcome = "completed";
          return;
        }
        await this.#executeTools(
          toolCallOccurrences(openTurn, step, response.toolCalls),
          signal,
        );
        this.session.append({
          type: "step/end",
          turn: openTurn,
          step,
          outcome: "completed",
        });
        openStep = undefined;
      }
      throw new Error(`agent exceeded ${this.#maxSteps} steps`);
    } catch (error) {
      if (signal.aborted) {
        turnOutcome = "cancelled";
      } else if (
        error instanceof ModelEffectReconciliationRequiredError ||
        error instanceof ModelOutcomeSettlementRequiredError
      ) {
        reconciliationRequired = true;
        this.#ctx.emit("agent/error", this, error);
      } else {
        turnOutcome = "model-error";
        this.#ctx.emit("agent/error", this, error);
      }
    } finally {
      if (!reconciliationRequired) {
        if (openStep !== undefined && turnOutcome === "cancelled") {
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
      { type: "input/admitted", messageId: input.messageId, turn },
    ]);
    await this.session.flush();
    this.#inbox.shift();
    this.#ctx.emit("agent/inbox/claimed", this, [input], turn);

    let openStep: number | undefined;
    let turnOutcome: StepOutcome = "interrupted";
    let reconciliationRequired = false;
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
        await this.#notifyModelOutcome(response.request.requestId, "completed");

        if (response.toolCalls.length === 0) {
          this.session.append({
            type: "step/end",
            turn,
            step,
            outcome: "completed",
          });
          openStep = undefined;
          turnOutcome = "completed";
          return;
        }

        await this.#executeTools(
          toolCallOccurrences(turn, step, response.toolCalls),
          signal,
        );
        this.session.append({
          type: "step/end",
          turn,
          step,
          outcome: "completed",
        });
        openStep = undefined;
        inputs = [];
      }
      throw new Error(`agent exceeded ${this.#maxSteps} steps`);
    } catch (error) {
      if (signal.aborted) {
        turnOutcome = "cancelled";
      } else if (
        error instanceof ModelEffectReconciliationRequiredError ||
        error instanceof ModelOutcomeSettlementRequiredError
      ) {
        reconciliationRequired = true;
        this.#ctx.emit("agent/error", this, error);
      } else {
        turnOutcome = "model-error";
        this.#ctx.emit("agent/error", this, error);
      }
    } finally {
      if (!reconciliationRequired) {
        if (openStep !== undefined && turnOutcome === "cancelled") {
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
        this.session.append({ type: "turn/end", turn, outcome: turnOutcome });
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
    });

    while (true) {
      const proposed: NormalizedModelRequest = {
        requestId: crypto.randomUUID(),
        provider: this.#options.provider,
        model: this.#options.model,
        system: assembly.text,
        messages: this.session.deriveMessages(),
        tools: this.#ctx.tools.schemas(),
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

      try {
        return await this.#consumeStream(request, turn, step, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof LlmEffectNotStartedError)) {
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
        const action = await this.#ctx.waterfall(
          "agent/request-error",
          this,
          error,
          signal,
          () => Promise.resolve({ kind: "fail" as const }),
        );
        if (action.kind !== "retry") throw error;
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
      if (receivedProviderEvent && error instanceof LlmEffectNotStartedError) {
        throw new Error(
          "Model provider reported no effect after returning response data",
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
    if (reconciliation.status === "unavailable") return reconciliation;
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

  async #executeTools(
    occurrences: readonly ToolCallOccurrence[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const occurrence of occurrences) {
      signal.throwIfAborted();
      const { call, occurrenceId, turn, step } = occurrence;
      const context = {
        botId: this.botId,
        agentId: this.id,
        sessionId: this.session.id,
        compositionGenerationId: this.#composition.generationId,
        signal,
      };
      const preparation = await this.#ctx.tools.prepare(call, context);
      signal.throwIfAborted();
      this.session.append({
        type: "tool/call",
        turn,
        step,
        occurrenceId,
        name: call.name,
        input: call.input,
      });
      await this.session.flush();
      let result: ToolExecutionResult;
      if (preparation.kind === "denied") {
        result = preparation.result;
        this.#ctx.emit("tools/result", call, result);
      } else {
        signal.throwIfAborted();
        try {
          result = await this.#ctx.tools.executePrepared(preparation, context);
        } catch (error) {
          result = {
            content:
              error instanceof Error ? error.message : "Tool execution failed",
            isError: true,
          };
          this.#ctx.emit("tools/result", call, result);
        }
      }
      this.session.append({
        type: "tool/result",
        turn,
        step,
        occurrenceId,
        name: call.name,
        content: result.content,
        isError: result.isError,
        status: "completed",
      });
    }
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
  private composition: CompositionPinV1;
  private handles = new Set<AgentHandle>();

  constructor(ctx: Context, config: AgentLoopConfig) {
    super(ctx, "agentLoop");
    this.composition = config.composition;
    this.maxSteps = config.maxSteps ?? 20;
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
      options,
      this.maxSteps,
      this.composition,
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

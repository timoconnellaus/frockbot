import {
  type Agent,
  type AgentFactory,
  type AgentHandle,
  type AgentInput,
  type AgentOptions,
  type AgentStatus,
  LlmEffectNotStartedError,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type PreStepDecision,
  type Session,
  type SessionEvent,
  type StepOutcome,
  type ToolCall,
  type ToolExecutionResult,
} from "@frockbot/agent-core";
import { type Context, Service } from "cordis";

export interface AgentLoopConfig {
  maxSteps?: number;
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
  ) {
    this.#ctx = ctx;
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
    let unresolvedRequest: NormalizedModelRequest | undefined;
    let definitiveNoEffect:
      Extract<SessionEvent, { type: "model/effect-not-started" }> | undefined;
    for (const event of this.session.events) {
      if (event.type === "turn/start") {
        openTurn = event.turn;
        latestStep = 0;
        unresolvedRequest = undefined;
        definitiveNoEffect = undefined;
      }
      if (event.type === "turn/end" && event.turn === openTurn)
        openTurn = undefined;
      if (event.type === "step/start" && event.turn === openTurn) {
        latestStep = Math.max(latestStep, event.step);
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
    const journaledCalls = new Map(
      this.session.events.flatMap((event) =>
        event.type === "tool/call" &&
        event.turn === openTurn &&
        event.step === latestStep
          ? [[event.call.id, event] as const]
          : [],
      ),
    );
    const durableResults = new Set(
      this.session.events.flatMap((event) =>
        event.type === "tool/result" &&
        event.turn === openTurn &&
        event.step === latestStep
          ? [event.callId]
          : [],
      ),
    );
    let openStep: number | undefined;
    let turnOutcome: StepOutcome = "interrupted";
    let reconciliationRequired = false;
    try {
      let nextStep = latestStep + 1;
      if (unresolvedRequest) {
        openStep = latestStep;
        if (definitiveNoEffect) {
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
          if (existing?.reason !== reconciliation.reason) {
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
          openTurn,
          latestStep,
          response.toolCalls,
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
      } else if (latestAssistant) {
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
        for (const call of latestAssistant.toolCalls) {
          const journaled = journaledCalls.get(call.id);
          if (journaled && !durableResults.has(call.id)) {
            this.session.append({
              type: "tool/result",
              turn: openTurn,
              step: latestStep,
              callId: call.id,
              name: call.name,
              content: "Interrupted before a durable result was recorded.",
              isError: true,
              status: "interrupted",
            });
          }
        }
        await this.session.flush();
        await this.#executeTools(
          openTurn,
          latestStep,
          latestAssistant.toolCalls.filter(
            (call) =>
              !journaledCalls.has(call.id) && !durableResults.has(call.id),
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
      }
      for (let step = nextStep; step <= this.#maxSteps; step += 1) {
        signal.throwIfAborted();
        openStep = step;
        this.session.append({ type: "step/start", turn: openTurn, step });
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
        await this.#executeTools(openTurn, step, response.toolCalls, signal);
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
      } else if (error instanceof ModelEffectReconciliationRequiredError) {
        reconciliationRequired = true;
        this.#ctx.emit("agent/error", this, error);
      } else {
        turnOutcome = "model-error";
        this.#ctx.emit("agent/error", this, error);
      }
    } finally {
      if (!reconciliationRequired) {
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

        await this.#executeTools(turn, step, response.toolCalls, signal);
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
      } else if (error instanceof ModelEffectReconciliationRequiredError) {
        reconciliationRequired = true;
        this.#ctx.emit("agent/error", this, error);
      } else {
        turnOutcome = "model-error";
        this.#ctx.emit("agent/error", this, error);
      }
    } finally {
      if (!reconciliationRequired) {
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

  async #requestModel(
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<ModelResponse> {
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
    const prefixMatches = durablePrefix.every((event, index) => {
      const recovered = reconciliation.events[index];
      return recovered?.type === "text-delta" && recovered.text === event.text;
    });
    if (!prefixMatches || reconciliation.events.length < durablePrefix.length) {
      return {
        status: "unavailable",
        reason: `Provider-bound retrieval diverged from durable response prefix for request "${request.requestId}"`,
      };
    }
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const [index, event] of reconciliation.events.entries()) {
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
        index >= durablePrefix.length,
      );
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
    turn: number,
    step: number,
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const call of calls) {
      signal.throwIfAborted();
      const context = {
        botId: this.botId,
        agentId: this.id,
        sessionId: this.session.id,
        signal,
      };
      const preparation = await this.#ctx.tools.prepare(call, context);
      this.session.append({ type: "tool/call", turn, step, call });
      await this.session.flush();
      let result: ToolExecutionResult;
      if (preparation.kind === "denied") {
        result = preparation.result;
        this.#ctx.emit("tools/result", call, result);
      } else {
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
        callId: call.id,
        name: call.name,
        content: result.content,
        isError: result.isError,
        status: "completed",
      });
    }
  }
}

export class AgentLoop extends Service implements AgentFactory {
  static inject = ["sessions", "systemPrompt", "llm", "tools", "agents"];
  private maxSteps: number;
  private handles = new Set<AgentHandle>();

  constructor(ctx: Context, config: AgentLoopConfig = {}) {
    super(ctx, "agentLoop");
    this.maxSteps = config.maxSteps ?? 20;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps <= 0) {
      throw new Error("agent-loop maxSteps must be a positive integer");
    }
  }

  async create(options: AgentOptions): Promise<AgentHandle> {
    const session = this.ctx.sessions.create(options.sessionId);
    const agent = new LoopAgent(this.ctx, session, options, this.maxSteps);
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

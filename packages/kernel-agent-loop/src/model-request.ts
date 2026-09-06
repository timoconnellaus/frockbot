import {
  type LlmStreamEvent,
  type LlmUsageV1,
  type NormalizedModelRequest,
  ModelProviderFailureError,
  StructuredOutputValidationError,
  type ToolCall,
  validateSettledToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import {
  EffectAdmissionFencedError,
  ModelEffectReconciliationRequiredError,
  modelFailureMessage,
} from "./errors.js";
import { nextModelRetryV1 } from "./retry-policy.js";
import type { LoopRuntime, ModelResponse } from "./runtime.js";

const TOKEN_ESTIMATE_BYTES_PER_TOKEN_V1 = 4;

function estimatedTokensV1(value: unknown): number {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return Math.ceil(bytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN_V1);
}

/**
 * The provider-neutral fallback for transports that return no token counts.
 * It is intentionally based on the exact normalized request and assembled
 * response that are journaled, and is always marked estimated at the event.
 */
export function estimateModelUsageV1(
  request: NormalizedModelRequest,
  response: Pick<ModelResponse, "text" | "toolCalls">,
): LlmUsageV1 {
  return {
    inputTokens: estimatedTokensV1(request),
    outputTokens: estimatedTokensV1({
      text: response.text,
      toolCalls: response.toolCalls,
    }),
  };
}

export async function requestModelV1(
  runtime: LoopRuntime,
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<ModelResponse> {
  const { ctx, session, options } = runtime;
  validateSettledToolOccurrenceJournal(session.events);
  const assembly = await ctx.systemPrompt.assemble({
    sessionId: session.id,
    provider: options.provider,
    model: options.model,
    // The same turn type the tool catalog is trimmed to. A section that
    // renders what a Turn may do would otherwise have to guess it.
    turnType: runtime.turnType,
    // Where the Turn is in its budget, so a section can warn the model
    // before the loop stops it.
    step: { current: step, max: runtime.maxSteps },
    // The same loop clock that armed the deadline. Prompt policy receives
    // the deadline as data; the kernel retains ownership of the timer.
    deadline: { at: runtime.turnDeadlineAt, now: runtime.retry.now() },
  });

  // One automatic retry, and only for a failure the provider itself
  // classified as "the request never started" — a rejected key, an
  // unresolvable binding, a connection refused before any byte was sent.
  // Those are exactly the failures where retrying cannot duplicate anything,
  // and the ones a person watching a blank screen would retry by hand. Every
  // other failure is uncertain and is never retried, which is the whole of
  // durability contract.
  let attempts = 0;
  while (true) {
    attempts += 1;
    const proposedMessages = session.deriveMessages();
    const messages = await ctx.waterfall(
      "agent/message-window",
      runtime.agent,
      proposedMessages,
      turn,
      step,
      signal,
      () => Promise.resolve(proposedMessages),
    );
    const proposedTools = ctx.tools.schemas({
      turnType: runtime.turnType,
      ...(runtime.subagentRole === undefined
        ? {}
        : { subagentRole: runtime.subagentRole }),
    });
    const tools = await ctx.waterfall(
      "agent/tool-exposure",
      runtime.agent,
      proposedTools,
      turn,
      step,
      signal,
      () => Promise.resolve(proposedTools),
    );
    const proposed: NormalizedModelRequest = {
      requestId: crypto.randomUUID(),
      provider: options.provider,
      model: options.model,
      system: assembly.text,
      messages,
      tools,
      ...(options.modelBinding
        ? { modelBinding: structuredClone(options.modelBinding) }
        : {}),
    };
    const request = await ctx.waterfall(
      "agent/request",
      runtime.agent,
      proposed,
      signal,
      () => Promise.resolve(proposed),
    );
    session.append({ type: "model/request", turn, step, request });
    await session.flush();
    if (
      !(await options.admitEffect({
        kind: "model",
        effectId: request.requestId,
      }))
    ) {
      session.append({
        type: "model/effect-not-started",
        turn,
        step,
        requestId: request.requestId,
        reason: "Durable Stop fenced provider execution",
      });
      await session.flush();
      throw new EffectAdmissionFencedError(request.requestId);
    }

    try {
      return await consumeStreamV1(runtime, request, turn, step, signal);
    } catch (error) {
      if (error instanceof StructuredOutputValidationError) {
        await session.flush();
        await runtime.notifyModelOutcome(request.requestId, "completed");
        throw error;
      }
      if (signal.aborted) {
        const reason = `Model response outcome is uncertain after cancellation: ${modelFailureMessage(error)}`;
        session.append({
          type: "model/reconciliation-required",
          turn,
          step,
          requestId: request.requestId,
          reason,
        });
        await session.flush();
        throw new ModelEffectReconciliationRequiredError(
          request.requestId,
          reason,
        );
      }
      if (!(error instanceof ModelProviderFailureError)) {
        const reason = `Model response outcome is uncertain: ${modelFailureMessage(error)}`;
        session.append({
          type: "model/reconciliation-required",
          turn,
          step,
          requestId: request.requestId,
          reason,
        });
        await session.flush();
        throw new ModelEffectReconciliationRequiredError(
          request.requestId,
          reason,
        );
      }
      session.append({
        type: "model/effect-not-started",
        turn,
        step,
        requestId: request.requestId,
        reason: modelFailureMessage(error),
      });
      await session.flush();
      await runtime.notifyModelOutcome(request.requestId, "not-started");
      const retry = nextModelRetryV1({
        failure: error,
        attempt: attempts,
        deadlineAt: runtime.turnDeadlineAt,
        runtime: runtime.retry,
      });
      // A Package can refuse a planned retry, or replace a permanent failure
      // with a provider-owned fallback. It cannot turn a permanent failure
      // into another attempt against the same model.
      const action = await ctx.waterfall(
        "agent/request-error",
        runtime.agent,
        error,
        signal,
        () =>
          Promise.resolve(
            retry ? ({ kind: "retry" } as const) : ({ kind: "fail" } as const),
          ),
      );
      if (action.kind === "fail") throw error;
      if (action.kind === "retry" && !retry) throw error;
      const delayMs = action.kind === "fallback" ? 0 : retry!.delayMs;
      session.append({
        type: "model/retry",
        turn,
        step,
        attempt: attempts + 1,
        classification: error.classification,
        delayMs,
      });
      await session.flush();
      ctx.emit("agent/error", runtime.agent, error);
      await runtime.retry.sleep(delayMs, signal);
    }
  }
}

export async function consumeStreamV1(
  runtime: LoopRuntime,
  request: NormalizedModelRequest,
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<ModelResponse> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let usage: LlmUsageV1 | undefined;
  let structuredFailure:
    | Extract<LlmStreamEvent, { type: "structured-output-failure" }>["failure"]
    | undefined;
  let receivedProviderEvent = false;
  const startedAt = Date.now();
  try {
    for await (const event of runtime.ctx.llm.stream(request, signal)) {
      if (event.type !== "response-format-note") receivedProviderEvent = true;
      signal.throwIfAborted();
      if (event.type === "usage") usage = structuredClone(event.usage);
      applyStreamEventV1(
        runtime,
        event,
        request.requestId,
        turn,
        step,
        toolCalls,
        (delta) => {
          text += delta;
        },
      );
      if (event.type === "structured-output-failure") {
        structuredFailure = event.failure;
      }
    }
  } catch (error) {
    if (receivedProviderEvent && error instanceof ModelProviderFailureError) {
      const invalidNoEffectClaim = new Error(
        error.message ||
          "Model provider reported a retryable failure after returning response data",
      );
      recordModelUsageV1(
        runtime,
        request,
        turn,
        step,
        usage,
        text,
        toolCalls,
        Math.max(0, Date.now() - startedAt),
      );
      throw invalidNoEffectClaim;
    }
    // Once dispatch may have begun, the call can have incurred spend even
    // when its terminal response is lost. Preserve the provider's partial
    // counts when present and otherwise write the same explicit estimate as
    // a successful unmetered stream. A definitive no-effect result is the
    // sole exception because the provider says no billable call occurred.
    if (!(error instanceof ModelProviderFailureError)) {
      recordModelUsageV1(
        runtime,
        request,
        turn,
        step,
        usage,
        text,
        toolCalls,
        Math.max(0, Date.now() - startedAt),
      );
    }
    throw error;
  }
  recordModelUsageV1(
    runtime,
    request,
    turn,
    step,
    usage,
    text,
    toolCalls,
    Math.max(0, Date.now() - startedAt),
  );
  if (structuredFailure) {
    throw new StructuredOutputValidationError(structuredFailure);
  }
  return { request, text, toolCalls };
}

export function recordModelUsageV1(
  runtime: LoopRuntime,
  request: NormalizedModelRequest,
  turn: number,
  step: number,
  reported: LlmUsageV1 | undefined,
  text: string,
  toolCalls: readonly ToolCall[],
  latencyMs: number,
): void {
  const existing = runtime.session.events.some(
    (event) =>
      event.type === "model/usage" && event.requestId === request.requestId,
  );
  if (existing) return;
  const usage =
    reported ??
    estimateModelUsageV1(request, { text, toolCalls: [...toolCalls] });
  runtime.session.append({
    type: "model/usage",
    turn,
    step,
    requestId: request.requestId,
    provider: request.provider,
    model: request.model,
    ...(request.modelBinding
      ? { modelBinding: structuredClone(request.modelBinding) }
      : {}),
    ...usage,
    latencyMs,
    estimated: reported === undefined,
  });
}

export function applyStreamEventV1(
  runtime: LoopRuntime,
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
      runtime.session.append({
        type: "assistant/chunk",
        turn,
        step,
        requestId,
        text: event.text,
      });
    }
  } else if (event.type === "tool-call") {
    toolCalls.push(event.call);
  } else if (event.type === "response-format-note") {
    runtime.session.append({
      type: "model/response-format-note",
      turn,
      step,
      requestId,
      note: event.note,
    });
  } else if (event.type === "structured-output-failure") {
    runtime.session.append({
      type: "model/response-failed",
      turn,
      step,
      requestId,
      failure: event.failure,
    });
  }
}

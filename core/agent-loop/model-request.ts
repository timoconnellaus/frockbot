import {
  type LlmStreamEvent,
  requireModelReplayStateV1,
  type LlmUsageV1,
  type ModelProviderFailureClassV1,
  type NormalizedModelRequest,
  ModelProviderFailureError,
  StructuredOutputValidationError,
  type ToolCall,
  validateSettledToolOccurrenceJournal,
} from "@frockbot/core/contracts";
import { EffectAdmissionFencedError, modelFailureMessage } from "./errors.js";
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

/**
 * Assembles one model request and lets the mounted Packages shape it.
 *
 * Its `requestId` is the call's idempotency key: every dispatch of this
 * request — a retry, or a re-issue after the object was evicted — carries the
 * same id, so a provider that honours the key answers once.
 */
async function buildModelRequestV1(
  runtime: LoopRuntime,
  system: string,
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<NormalizedModelRequest> {
  const { services, session, options } = runtime;
  const proposedMessages = session.deriveMessages();
  const messages = await services.hooks.messageWindow(
    runtime.agent,
    proposedMessages,
    turn,
    step,
    signal,
    () => Promise.resolve(proposedMessages),
  );
  const proposedTools = services.tools.schemas({
    turnType: runtime.turnType,
    ...(runtime.subagentRole === undefined
      ? {}
      : { subagentRole: runtime.subagentRole }),
  });
  const tools = await services.hooks.toolExposure(
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
    system,
    messages,
    tools,
    ...(options.modelBinding
      ? { modelBinding: structuredClone(options.modelBinding) }
      : {}),
  };
  return services.hooks.request(
    runtime.agent,
    proposed,
    turn,
    step,
    signal,
    () => Promise.resolve(proposed),
  );
}

function failureClassificationV1(error: unknown): ModelProviderFailureClassV1 {
  return error instanceof ModelProviderFailureError
    ? error.classification
    : "unknown";
}

/**
 * Asks the model, retrying the same request under the same idempotency key.
 *
 * `pending` is a request the durable log already carries with no answer — the
 * step was interrupted mid-call. It is dispatched again under its own key
 * rather than investigated: a provider that honours the key returns the one
 * answer, and one that does not may run the call twice. That is the trade,
 * and it is taken openly because reconstructing what a lost call did was the
 * thing that wedged Bots.
 */
export async function requestModelV1(
  runtime: LoopRuntime,
  turn: number,
  step: number,
  signal: AbortSignal,
  pending?: NormalizedModelRequest,
): Promise<ModelResponse> {
  const { services, session, options } = runtime;
  validateSettledToolOccurrenceJournal(session.events);
  const assembly = await services.systemPrompt.assemble({
    sessionId: session.id,
    provider: options.provider,
    model: options.model,
    // The same turn type the tool catalog is trimmed to. A section that
    // renders what a Turn may do would otherwise have to guess it.
    turnType: runtime.turnType,
    // The same role ceiling the tool catalog is trimmed to, so a section
    // never names a tool this subagent would be refused.
    ...(runtime.subagentRole === undefined
      ? {}
      : { subagentRole: runtime.subagentRole }),
    // Where the Turn is in its budget, so a section can warn the model
    // before the loop stops it.
    step: { current: step, max: runtime.maxSteps },
    // The same loop clock that armed the deadline. Prompt policy receives
    // the deadline as data; the kernel retains ownership of the timer.
    deadline: { at: runtime.turnDeadlineAt, now: runtime.retry.now() },
  });

  let request =
    pending ??
    (await buildModelRequestV1(runtime, assembly.text, turn, step, signal));
  let attempts = 0;
  while (true) {
    attempts += 1;
    // One `model/request` per dispatch, all sharing the key: the log says how
    // many times the call was sent, and every reader of the answer so far
    // starts again from the latest send.
    session.append({ type: "model/request", turn, step, request });
    await session.flush();
    if (
      !(await options.admitEffect({
        kind: "model",
        effectId: request.requestId,
      }))
    ) {
      throw new EffectAdmissionFencedError(request.requestId);
    }

    try {
      return await consumeStreamV1(runtime, request, turn, step, signal);
    } catch (error) {
      await session.flush();
      // The dispatch is over either way, so whatever is held against this id
      // — a credential lease above all — is released before the next one asks
      // for it, even though the next one carries the same id.
      await runtime.notifyModelOutcome(request.requestId);
      if (error instanceof StructuredOutputValidationError) throw error;
      signal.throwIfAborted();
      const classification = failureClassificationV1(error);
      const retry = nextModelRetryV1({
        failure: {
          classification,
          ...(error instanceof ModelProviderFailureError &&
          error.retryAfterMs !== undefined
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
        },
        attempt: attempts,
        deadlineAt: runtime.turnDeadlineAt,
        runtime: runtime.retry,
      });
      // A Package can refuse a planned retry, or replace a permanent failure
      // with a provider-owned fallback. It cannot turn a permanent failure
      // into another attempt against the same model.
      const action = await services.hooks.requestError(
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
        classification,
        delayMs,
      });
      await session.flush();
      await runtime.retry.sleep(delayMs, signal);
      // A fallback is a different call — another provider, another binding —
      // so it gets its own key rather than inheriting this one's.
      if (action.kind === "fallback") {
        request = await buildModelRequestV1(
          runtime,
          assembly.text,
          turn,
          step,
          signal,
        );
      }
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
  let providerState: ModelResponse["providerState"];
  const toolCalls: ToolCall[] = [];
  let usage: LlmUsageV1 | undefined;
  let structuredFailure:
    | Extract<LlmStreamEvent, { type: "structured-output-failure" }>["failure"]
    | undefined;
  const startedAt = Date.now();
  try {
    for await (const event of runtime.services.llm.stream(request, signal)) {
      signal.throwIfAborted();
      if (event.type === "provider-state") {
        requireModelReplayStateV1(event.state);
        if (
          event.state.provider !== request.provider ||
          event.state.model !== request.model ||
          event.state.connectionId !== request.modelBinding?.connectionId ||
          event.state.connectionGeneration !==
            request.modelBinding?.connectionGeneration
        )
          throw new Error("Model replay state identity does not match request");
        providerState = structuredClone(event.state);
      }
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
  return {
    request,
    text,
    toolCalls,
    ...(providerState ? { providerState } : {}),
  };
}

/** One `model/usage` per dispatch, because each dispatch may have been billed. */
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
): void {
  if (event.type === "text-delta") {
    appendText(event.text);
    runtime.session.append({
      type: "assistant/chunk",
      turn,
      step,
      requestId,
      text: event.text,
    });
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

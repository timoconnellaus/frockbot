import {
  type LlmStreamEvent,
  type LlmUsageV1,
  type NormalizedModelRequest,
  StructuredOutputValidationError,
  type ToolCall,
} from "@frockbot/kernel-contracts";
import { applyStreamEventV1, recordModelUsageV1 } from "./model-request.js";
import type { LoopRuntime, ModelResponse } from "./runtime.js";

export type ModelReconciliation =
  | { status: "recovered"; response: ModelResponse }
  | { status: "unavailable"; reason: string }
  | { status: "not-retrievable"; reason: string };

export async function reconcileModelV1(
  runtime: LoopRuntime,
  request: NormalizedModelRequest,
  turn: number,
  step: number,
  signal: AbortSignal,
): Promise<ModelReconciliation> {
  const { ctx, session } = runtime;
  const reconciliation = await ctx.llm.reconcile(request, signal);
  if (reconciliation.status !== "recovered") return reconciliation;
  const durablePrefix = session.events.flatMap((event) =>
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
  let usage: LlmUsageV1 | undefined;
  let structuredFailure:
    | Extract<LlmStreamEvent, { type: "structured-output-failure" }>["failure"]
    | undefined;
  let textDeltaIndex = 0;
  const startedAt = Date.now();
  for (const event of reconciliation.events) {
    signal.throwIfAborted();
    if (event.type === "usage") usage = structuredClone(event.usage);
    const journalTextDelta =
      event.type !== "text-delta" || textDeltaIndex >= durablePrefix.length;
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
      journalTextDelta,
    );
    if (event.type === "text-delta") textDeltaIndex += 1;
    if (event.type === "structured-output-failure") {
      structuredFailure = event.failure;
    }
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
    await session.flush();
    await runtime.notifyModelOutcome(request.requestId, "completed");
    throw new StructuredOutputValidationError(structuredFailure);
  }
  return {
    status: "recovered",
    response: { request, text, toolCalls },
  };
}

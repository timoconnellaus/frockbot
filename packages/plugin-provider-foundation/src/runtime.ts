import {
  type LlmProvider,
  type LlmStreamEvent,
  ModelProviderFailureError,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";

export const FOUNDATION_PROVIDER = "foundation";
export const FOUNDATION_MODEL = "deterministic-v1";

function presentedToolName(
  request: Parameters<LlmProvider["stream"]>[0],
  toolCallId: string,
  name: string,
): string {
  if (name !== "call_dynamic_tool") return name;
  const call = request.messages
    .toReversed()
    .find((message) => message.role === "assistant")
    ?.toolCalls.find((candidate) => candidate.id === toolCallId);
  if (
    !call ||
    typeof call.input !== "object" ||
    call.input === null ||
    Array.isArray(call.input)
  ) {
    return name;
  }
  const input = call.input as Record<string, unknown>;
  if (
    typeof input.namespace !== "string" ||
    typeof input.toolName !== "string"
  ) {
    return name;
  }
  return input.namespace === "frockbot"
    ? input.toolName
    : `${input.namespace}/${input.toolName}`;
}

async function* foundationStream(
  request: Parameters<LlmProvider["stream"]>[0],
  signal: AbortSignal,
): AsyncGenerator<LlmStreamEvent> {
  signal.throwIfAborted();
  const latest = request.messages.at(-1);
  if (latest?.role === "tool") {
    const name = presentedToolName(request, latest.callId, latest.name);
    const label = name === "echo" ? "Echo" : name;
    yield { type: "text-delta", text: `${label}: ` };
    await Promise.resolve();
    signal.throwIfAborted();
    yield { type: "text-delta", text: latest.content };
    yield { type: "finish", reason: "completed" };
    return;
  }
  const user = request.messages.findLast((message) => message.role === "user");
  const text = user?.role === "user" ? user.content : "";
  yield { type: "text-delta", text: "Cordis runtime: " };
  await Promise.resolve();
  signal.throwIfAborted();
  yield { type: "text-delta", text };
  yield { type: "finish", reason: "completed" };
}

async function foundationReconciliation(
  request: Parameters<LlmProvider["stream"]>[0],
  signal: AbortSignal,
): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of foundationStream(request, signal)) {
    events.push(event);
  }
  return events;
}

/** Foundation has no remote status surface; an unexpected pre-stream fault is unknown. */
export function classifyFoundationFailureV1(
  error: unknown,
): ModelProviderFailureError {
  return error instanceof ModelProviderFailureError
    ? error
    : new ModelProviderFailureError({
        classification: "unknown",
        reason:
          error instanceof Error
            ? error.message
            : "Foundation model failed before replying",
      });
}

async function* classifiedFoundationStream(
  request: Parameters<LlmProvider["stream"]>[0],
  signal: AbortSignal,
): AsyncGenerator<LlmStreamEvent> {
  let started = false;
  try {
    for await (const event of foundationStream(request, signal)) {
      started = true;
      yield event;
    }
  } catch (error) {
    if (started || signal.aborted) throw error;
    throw classifyFoundationFailureV1(error);
  }
}

export const foundationProvider: LlmProvider = {
  id: FOUNDATION_PROVIDER,
  stream: classifiedFoundationStream,
  reconciliation: {
    retrieve: async (effect, signal) =>
      ({
        status: "recovered",
        events: await foundationReconciliation(effect.request, signal),
      }) as const,
  },
};

export const foundationProviderPlugin: Plugin.Function = (ctx) =>
  ctx.llm.register(foundationProvider);
foundationProviderPlugin.inject = ["llm"];

export default foundationProviderPlugin;

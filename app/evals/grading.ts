import { BATCH_TOOL_NAME } from "@frockbot/core/contracts";
import type { SessionEvent } from "@frockbot/core/contracts";

type ToolCallEvent = Extract<SessionEvent, { type: "tool/call" }>;

/**
 * The calls the model made, not the envelope it grouped them in: a `batch`
 * journals its own row as well as one per call inside it, and only the inner
 * ones deliver anything. Every grader counts calls through here, so a grader
 * added later cannot mistake the envelope for a call the model asked for.
 */
export function modelToolCallsV1(
  events: readonly SessionEvent[],
): ToolCallEvent[] {
  return events.flatMap((event) =>
    event.type === "tool/call" && event.name !== BATCH_TOOL_NAME ? [event] : [],
  );
}

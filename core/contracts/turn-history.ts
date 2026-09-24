// Which of a Session's derived messages belong to the Turn being assembled.
//
// The Bot Durable Object keeps one ordered event log per Bot, and the kernel
// enforces its contiguity: a Turn is always seeded with the whole history so
// its events keep their sequence. "What enters a model request is Package
// policy", so the *narrowing* happens when the request is assembled, and these
// are the two mechanical facts every narrowing policy needs — which Turn each
// derived message belongs to, and which Turn is currently open.
//
import { expandToolCallOccurrencesV1 } from "./batch.js";
import type { LlmMessage, SessionEvent } from "./types.js";

/** The event types `Session.deriveMessages` turns into a message, in order. */
const MESSAGE_EVENT_TYPES = new Set([
  "user/message",
  "assistant/message",
  "tool/result",
]);

/**
 * The occurrences that are calls inside a `batch` rather than calls the model
 * issued itself.
 *
 * Derived from the assistant messages, which is where `batch` sub-occurrences
 * come from in the first place — `validateToolOccurrenceJournal` expands the
 * same events the same way — so this needs no journal and cannot disagree with
 * one.
 */
function nestedToolOccurrenceIdsV1(
  events: readonly SessionEvent[],
): ReadonlySet<string> {
  const nested = new Set<string>();
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    for (const occurrence of expandToolCallOccurrencesV1(
      event.turn,
      event.step,
      event.toolCalls,
    )) {
      if (occurrence.parentOccurrenceId !== undefined) {
        nested.add(occurrence.occurrenceId);
      }
    }
  }
  return nested;
}

/**
 * The events that become one derived message each, in derivation order.
 *
 * The one list, read by `Session.deriveMessages` and by every narrowing policy
 * that has to say which Turn each message belongs to. It is one function
 * because the two used to decide separately and drifted: a `batch` sub-call's
 * result is not replayed to the model, but it was still counted as a message,
 * so `turnScopedMessagesV1` found its two inputs disagreeing about their
 * length and failed the Turn. The events are durable, so that failure was not
 * one Turn's: every later Turn in the session died the same way, before the
 * model was ever called. Anything that changes what becomes a message changes
 * it here, for both readers at once.
 */
export function messageEventsV1(
  events: readonly SessionEvent[],
): SessionEvent[] {
  const nested = nestedToolOccurrenceIdsV1(events);
  return events.filter(
    (event) =>
      MESSAGE_EVENT_TYPES.has(event.type) &&
      !(event.type === "tool/result" && nested.has(event.occurrenceId)),
  );
}

/** The Turn each derived message belongs to, in the order they were derived. */
export function messageTurnsV1(events: readonly SessionEvent[]): number[] {
  return messageEventsV1(events).map((event) =>
    "turn" in event ? event.turn : 0,
  );
}

/** The Turn a request is being assembled inside: the last one started. */
export function currentTurnV1(events: readonly SessionEvent[]): number {
  const started = events.findLast((event) => event.type === "turn/start");
  return started?.type === "turn/start" ? started.turn : 0;
}

export const UNRUN_TOOL_CALL_RESULT_V1 =
  "Not run: the Turn ended before this call started.";

/**
 * The messages with every assistant tool call answered.
 *
 * A Turn interrupted while the first of several parallel calls ran closes only
 * the calls that started, so its later calls stay in the history with no
 * result. Some providers refuse the whole request for that, and the history is
 * durable: every later Turn of the Bot failed the same way. Each unanswered
 * call gets an error result at the end of its tool block. Returns the same
 * array when nothing is missing.
 */
export function answerEveryToolCallV1(
  messages: readonly LlmMessage[],
): readonly LlmMessage[] {
  let answered: LlmMessage[] | undefined;
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    index += 1;
    if (message.role !== "assistant" || message.toolCalls.length === 0) {
      answered?.push(message);
      continue;
    }
    const block: LlmMessage[] = [message];
    const results = new Set<string>();
    while (index < messages.length && messages[index]!.role === "tool") {
      const result = messages[index]! as Extract<LlmMessage, { role: "tool" }>;
      results.add(result.callId);
      block.push(result);
      index += 1;
    }
    const missing = message.toolCalls.filter((call) => !results.has(call.id));
    if (missing.length > 0) {
      answered ??= messages.slice(0, index - block.length);
      for (const call of missing) {
        block.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          content: UNRUN_TOOL_CALL_RESULT_V1,
          isError: true,
        });
      }
    }
    answered?.push(...block);
  }
  return answered ?? messages;
}

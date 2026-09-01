// Which of a Session's derived messages belong to the Turn being assembled.
//
// The Bot Durable Object keeps one ordered event log per Bot, and the kernel
// enforces its contiguity: a Turn is always seeded with the whole history so
// its events keep their sequence. "What enters a model request is Package
// policy", so the *narrowing* happens when the request is assembled, and these
// are the two mechanical facts every narrowing policy needs — which Turn each
// derived message belongs to, and which Turn is currently open.
//
// A non-chat Turn may also be given a history that is not the Bot's transcript
// at all: an automation Turn gets a pointer, and a `channel` Turn gets the
// Channel's own recent messages. `freshTurnMessagesV1` is that mode — the
// caller supplies the prior messages, and the Turn's own messages follow them.
// The supplied messages are never written to the durable log; they exist for
// the duration of one model request.
import type { LlmMessage, SessionEvent } from "./types.js";

/** The event types `Session.deriveMessages` turns into a message, in order. */
const MESSAGE_EVENT_TYPES = new Set([
  "user/message",
  "assistant/message",
  "tool/result",
]);

/** The Turn each derived message belongs to, in the order they were derived. */
export function messageTurnsV1(events: readonly SessionEvent[]): number[] {
  const turns: number[] = [];
  for (const event of events) {
    if (!MESSAGE_EVENT_TYPES.has(event.type)) continue;
    turns.push("turn" in event ? event.turn : 0);
  }
  return turns;
}

/** The Turn a request is being assembled inside: the last one started. */
export function currentTurnV1(events: readonly SessionEvent[]): number {
  const started = events.findLast((event) => event.type === "turn/start");
  return started?.type === "turn/start" ? started.turn : 0;
}

/**
 * The messages of the open Turn alone, in order.
 *
 * `events` and `messages` must be the same log and the messages derived from
 * it; a disagreement about length means the caller paired a request with the
 * wrong session, which is a failure rather than something to guess through.
 */
export function ownTurnMessagesV1(
  events: readonly SessionEvent[],
  messages: readonly LlmMessage[],
): LlmMessage[] {
  const turns = messageTurnsV1(events);
  if (turns.length !== messages.length) {
    throw new Error(
      "session history and derived messages disagree about their length",
    );
  }
  const current = currentTurnV1(events);
  return messages.filter((_, index) => turns[index] === current);
}

/**
 * A Turn's request in fresh-history mode: the history the caller supplied,
 * then this Turn's own messages, and nothing from the Bot's transcript.
 */
export function freshTurnMessagesV1(input: {
  events: readonly SessionEvent[];
  messages: readonly LlmMessage[];
  history: readonly LlmMessage[];
}): LlmMessage[] {
  return [
    ...input.history.map((message) => structuredClone(message)),
    ...ownTurnMessagesV1(input.events, input.messages),
  ];
}

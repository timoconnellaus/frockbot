// Which of a Session's derived messages belong to the Turn being assembled.
//
// The Bot Durable Object keeps one ordered event log per Bot, and the kernel
// enforces its contiguity: a Turn is always seeded with the whole history so
// its events keep their sequence. "What enters a model request is Package
// policy", so the *narrowing* happens when the request is assembled, and these
// are the two mechanical facts every narrowing policy needs — which Turn each
// derived message belongs to, and which Turn is currently open.
//
import type { SessionEvent } from "./types.js";

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

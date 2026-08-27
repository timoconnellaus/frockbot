import type { SessionEvent } from "@frockbot/agent-core";

function sameEvent(
  left: SessionEvent,
  right: SessionEvent | undefined,
): boolean {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export function appendedSessionEvents(
  previous: readonly SessionEvent[],
  candidate: readonly SessionEvent[],
): SessionEvent[] {
  if (
    candidate.length < previous.length ||
    previous.some((event, index) => !sameEvent(event, candidate[index]))
  ) {
    throw new Error("candidate changed durable session history");
  }
  return structuredClone(candidate.slice(previous.length));
}

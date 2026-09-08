import type { LoopHooksV1, SessionEvent } from "@frockbot/core/contracts";
import { turnTypesByTurnV1 } from "./history.js";

export const UNSENT_REPLY_REASON_V1 =
  "The model finished without sending a reply. Try again.";

function isSend(name: string): boolean {
  return name === "send_to_user" || name === "send_message";
}

/** Derived from the journal, so eviction cannot reset the repair budget. */
function delivery(events: readonly SessionEvent[], turn: number) {
  let required = true;
  let attempts = 0;
  for (const event of events) {
    if (!("turn" in event) || event.turn !== turn) continue;
    if (event.type === "send/to-user") {
      // A question or approval hands control to the User. A later call in
      // the same batch must not make delivery repair reopen that Turn.
      if (event.payload.type === "widget" || event.payload.type === "approval")
        return { required: false, attempts };
      required = false;
    }
    // An acknowledgement before doing work does not deliver its result.
    if (event.type === "tool/call" && !isSend(event.name)) required = true;
    if (
      event.type === "assistant/message" &&
      event.toolCalls.length === 0 &&
      required
    )
      attempts++;
  }
  return { required, attempts };
}

function conversational(events: readonly SessionEvent[], turn: number) {
  const type = turnTypesByTurnV1(events).get(turn) ?? "chat";
  return type === "chat" || type === "agent";
}

/** Delivery is application policy; the loop still owns execution and settlement. */
export const conversationDeliveryHooksV1: LoopHooksV1 = {
  async request(agent, _request, _signal, next) {
    const request = await next();
    const start = agent.session.events.findLast((e) => e.type === "turn/start");
    if (
      start?.type !== "turn/start" ||
      !conversational(agent.session.events, start.turn)
    )
      return request;
    const state = delivery(agent.session.events, start.turn);
    if (!state.required || state.attempts === 0) return request;
    return {
      ...request,
      system: `${request.system}\n\nYour previous step ended without delivering a reply. Your assistant text is private. Call \`send_to_user\` now with the answer, result, or blocker. Do not repeat work you have already done.`,
    };
  },
  async stepContinuation(agent, _decision, turn, _step, _signal, next) {
    const decision = await next();
    if (decision.kind !== "stop" || !conversational(agent.session.events, turn))
      return decision;
    const state = delivery(agent.session.events, turn);
    if (!state.required) return decision;
    if (state.attempts >= 2) throw new Error(UNSENT_REPLY_REASON_V1);
    return { kind: "continue" };
  },
};

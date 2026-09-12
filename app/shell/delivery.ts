import type { LoopHooksV1, SessionEvent } from "@frockbot/core/contracts";
import { turnTypesByTurnV1 } from "./history.js";

export const UNSENT_REPLY_REASON_V1 =
  "The model finished without sending a reply. Try again.";

/**
 * Two independent facts about the Turn, deliberately not one.
 *
 * `required` is the final reply still owed to the user: only a finish send
 * (or a widget/approval, which end the Turn themselves) clears it, so an
 * interim update never completes the Turn.
 *
 * `attempts` counts undelivered model steps *since the last successful send*,
 * and `repair` says the most recent step was one of them. A send of either
 * disposition proves the model can reach the user, so it clears both and the
 * next step gets its full toolset back instead of being locked to the reply
 * tool for the rest of the Turn.
 *
 * The disposition is already durable in tool/call; tie it to a successful send.
 */
function delivery(events: readonly SessionEvent[], turn: number) {
  let attempts = 0;
  let repair = false;
  const finalCalls = new Set<string>();
  for (const event of events) {
    if (!("turn" in event) || event.turn !== turn) continue;
    if (event.type === "tool/call" && event.name === "send_to_user") {
      const input = event.input;
      if (
        input &&
        typeof input === "object" &&
        "disposition" in input &&
        input.disposition === "finish"
      )
        finalCalls.add(event.occurrenceId);
    }
    if (event.type === "send/to-user") {
      if (
        finalCalls.has(event.occurrenceId) ||
        event.payload.type === "widget" ||
        event.payload.type === "approval"
      )
        return { required: false, attempts: 0, repair: false };
      attempts = 0;
      repair = false;
    }
    if (event.type === "assistant/message" && event.toolCalls.length === 0) {
      attempts++;
      repair = true;
    } else if (event.type === "assistant/message") repair = false;
  }
  return { required: true, attempts, repair };
}

function conversational(events: readonly SessionEvent[], turn: number) {
  const type = turnTypesByTurnV1(events).get(turn) ?? "chat";
  return type === "chat" || type === "agent";
}

/** Delivery is application policy; the loop still owns execution and settlement. */
export const conversationDeliveryHooksV1: LoopHooksV1 = {
  async request(agent, _request, _turn, _step, _signal, next) {
    const request = await next();
    const start = agent.session.events.findLast((e) => e.type === "turn/start");
    if (
      start?.type !== "turn/start" ||
      !conversational(agent.session.events, start.turn)
    )
      return request;
    const state = delivery(agent.session.events, start.turn);
    // Repair the step that failed to deliver, not the rest of the Turn: a Bot
    // that has already spoken keeps every tool it needs to finish the work.
    if (!state.required || !state.repair) return request;
    return {
      ...request,
      system: `${request.system}\n\nYour previous step ended without delivering a reply. Your assistant text is private. Call \`send_to_user\` now with the answer, result, or blocker. Do not repeat work you have already done.`,
      // Some providers continue the trailing assistant message even when the
      // system prompt changes. A labelled runtime instruction makes this a
      // new model step; it is recorded in the request, never as User input.
      messages: [
        ...request.messages,
        {
          role: "user",
          content:
            '[FrockBot runtime: delivery repair]\nYour previous response was not delivered. Call send_to_user now with the answer, result, or blocker for the original request. For text, use {"disposition":"finish","payload":{"type":"text","text":"your reply"}}. Do not answer in plain text or repeat completed work.',
        },
      ],
      tools: request.tools.filter((tool) => tool.name === "send_to_user"),
    };
  },
  async stepContinuation(agent, _decision, turn, _step, _signal, next) {
    const decision = await next();
    if (!conversational(agent.session.events, turn)) return decision;
    const state = delivery(agent.session.events, turn);
    // This also runs on replay after a send/result or step/end was flushed.
    if (!state.required) return { kind: "stop" };
    if (decision.kind !== "stop") return decision;
    if (state.attempts >= 2) throw new Error(UNSENT_REPLY_REASON_V1);
    return { kind: "continue" };
  },
};

import type { LoopHooksV1, SessionEvent } from "@frockbot/core/contracts";
import { turnTypesByTurnV1 } from "./history.js";
import { REPLY_TO_REQUEST_TOOL_V1 } from "./reply-to-caller.js";

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
/**
 * Whether this Turn owes its answer to a caller rather than to the User.
 *
 * Read off the Turn's own model requests: `reply_to_request` is mounted only
 * on a Turn that has a caller, and every request the Turn dispatched is
 * durable with the tools it offered. So this survives eviction and replay
 * without a second record of the same fact, and a Turn with no caller is
 * byte-for-byte what it always was.
 */
function callerAddressedV1(
  events: readonly SessionEvent[],
  turn: number,
): boolean {
  return events.some(
    (event) =>
      "turn" in event &&
      event.turn === turn &&
      event.type === "model/request" &&
      event.request.tools.some(
        (tool) => tool.name === REPLY_TO_REQUEST_TOOL_V1,
      ),
  );
}

function delivery(events: readonly SessionEvent[], turn: number) {
  let attempts = 0;
  let repair = false;
  const addressed = callerAddressedV1(events, turn);
  const finalCalls = new Set<string>();
  const answerCalls = new Set<string>();
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
    if (event.type === "tool/call" && event.name === REPLY_TO_REQUEST_TOOL_V1) {
      answerCalls.add(event.occurrenceId);
    }
    // The answer a caller asked for is what ends a caller-addressed Turn, and
    // the only thing that does — including the one an email could not carry,
    // which its own call put in the conversation instead.
    if (
      event.type === "reply/to-caller" ||
      (event.type === "send/to-user" && answerCalls.has(event.occurrenceId))
    ) {
      return { required: false, attempts: 0, repair: false };
    }
    if (event.type === "send/to-user") {
      // A send still reaches the User, and still proves the Turn can deliver
      // — but on a Turn somebody is waiting to *hear* from, it is not the
      // answer. A `disposition: "finish"` send would otherwise end the Turn
      // with the caller never answered and the person listening to silence.
      if (
        !addressed &&
        (finalCalls.has(event.occurrenceId) ||
          event.payload.type === "widget" ||
          event.payload.type === "approval" ||
          event.payload.type === "secret-request")
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

/**
 * Whether a completed Turn ended before delivering its final reply.
 *
 * The delivery rule below keeps a conversational Turn going until it has
 * answered, or fails it. The one way such a Turn completes still owing its
 * answer is by yielding at a step boundary to a message the person sent
 * meanwhile — so this is read off the journal alone, and survives eviction.
 */
export function endedOwingReplyV1(events: readonly SessionEvent[]): boolean {
  const start = events.find((event) => event.type === "turn/start");
  if (start?.type !== "turn/start" || typeof start.turn !== "number") {
    return false;
  }
  return (
    conversational(events, start.turn) && delivery(events, start.turn).required
  );
}

/** Delivery is application policy; the loop still owns execution and settlement. */
export const conversationDeliveryHooksV1: LoopHooksV1 = {
  async request(agent, _request, _turn, _step, _signal, next) {
    const request = await next();
    const start = agent.session.activeRunJournal.findLast(
      (e) => e.type === "turn/start",
    );
    if (
      start?.type !== "turn/start" ||
      !conversational(agent.session.activeRunJournal, start.turn)
    )
      return request;
    const state = delivery(agent.session.activeRunJournal, start.turn);
    // Repair the step that failed to deliver, not the rest of the Turn: a Bot
    // that has already spoken keeps every tool it needs to finish the work.
    if (!state.required || !state.repair) return request;
    // A Turn that has a caller to answer repairs with its own reply tool; one
    // that does not repairs with the send. Naming a tool the Turn was never
    // offered is how a repair step turns into a second failed step.
    const replyTools = request.tools.filter(
      (tool) =>
        tool.name === "send_to_user" || tool.name === REPLY_TO_REQUEST_TOOL_V1,
    );
    const answerTool = replyTools.some(
      (tool) => tool.name === REPLY_TO_REQUEST_TOOL_V1,
    )
      ? REPLY_TO_REQUEST_TOOL_V1
      : "send_to_user";
    return {
      ...request,
      system: `${request.system}\n\nYour previous step ended without delivering a reply. Your assistant text is private. Call \`${answerTool}\` now with the answer, result, or blocker. Do not repeat work you have already done.`,
      // Some providers continue the trailing assistant message even when the
      // system prompt changes. A labelled runtime instruction makes this a
      // new model step; it is recorded in the request, never as User input.
      messages: [
        ...request.messages,
        {
          role: "user",
          content:
            answerTool === REPLY_TO_REQUEST_TOOL_V1
              ? `[FrockBot runtime: delivery repair]\nYour previous response was not delivered. Call ${REPLY_TO_REQUEST_TOOL_V1} now with the answer, result, or blocker for the original request, as {"answer":"your reply"}. Do not answer in plain text or repeat completed work.`
              : '[FrockBot runtime: delivery repair]\nYour previous response was not delivered. Call send_to_user now with the answer, result, or blocker for the original request. For text, use {"disposition":"finish","payload":{"type":"text","text":"your reply"}}. Do not answer in plain text or repeat completed work.',
        },
      ],
      tools: replyTools,
    };
  },
  async stepContinuation(agent, _decision, turn, _step, _signal, next) {
    const decision = await next();
    if (!conversational(agent.session.activeRunJournal, turn)) return decision;
    const state = delivery(agent.session.activeRunJournal, turn);
    // This also runs on replay after a send/result or step/end was flushed.
    if (!state.required) return { kind: "stop" };
    if (decision.kind !== "stop") return decision;
    if (state.attempts >= 2) throw new Error(UNSENT_REPLY_REASON_V1);
    return { kind: "continue" };
  },
};

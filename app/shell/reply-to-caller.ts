// Replies to a caller — the voice session, another Bot, or the person's own
// mailbox — are durable caller deliveries, separate from User messages. The
// host fixes the caller from admission; the model cannot change it.
import type {
  SendToUserPayloadV1,
  Session,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@frockbot/core/contracts";
import { openStepPositionV1 } from "./agent.js";

export const REPLY_TO_REQUEST_TOOL_V1 = "reply_to_request";

export type ReplyCallerV1 = "voice" | "bot" | "email";

/**
 * Where a Turn's answer goes, chosen once from what admitted it: to the
 * person in this conversation, or back to the caller that asked. It is the
 * one place a Turn's reply channel is decided — a voice request is answered
 * aloud, a Bot's question as its tool result, an email by email — and every
 * other Turn answers in the conversation with `send_to_user`.
 */
export function replyChannelOfOriginV1(origin?: {
  kind: string;
}): ReplyCallerV1 | "conversation" {
  switch (origin?.kind) {
    case "voice":
    case "bot":
    case "email":
      return origin.kind;
    default:
      return "conversation";
  }
}

/**
 * Each caller's bound on a complete answer. Voice is spoken, so it stays
 * short; a Bot reads its answer as a tool result, so it gets the whole wire
 * event bound; an email is read, and a long one is a document, not a reply.
 */
export const REPLY_TO_REQUEST_MAX_CHARS_V1: Record<ReplyCallerV1, number> = {
  voice: 4_000,
  bot: 32_000,
  email: 16_000,
};

const TOO_LONG: Record<ReplyCallerV1, string> = {
  voice: "Say the short version.",
  bot: "Send the essential answer.",
  email: "Write the shorter email.",
};

const DESCRIPTIONS: Record<ReplyCallerV1, string> = {
  voice:
    "Answer the voice session that asked you the current question. What you write here is read back to the person aloud and ends this Turn, so keep it short and speakable: a few sentences, no markdown, no lists, no code. This is not a message in your conversation with your User — use send_to_user for those, including interim updates while you work.",
  bot: "Answer the Bot that asked you the current question. What you write here is returned to that Bot as its tool result and ends this Turn, so make it the complete answer it can act on. This is not a message in your conversation with your User — use send_to_user for those, only when the person should hear about it directly.",
  email:
    "Reply to the email your person sent you. `answer` is the body of your reply: it is emailed back to them from your address, in the thread they wrote in, and it ends this Turn. Write the email itself, in plain text — never a note about sending one.",
};

const RECORDED: Record<ReplyCallerV1, string> = {
  voice: "Answer recorded for the voice session.",
  bot: "Answer recorded for the asking Bot.",
  email: "Reply recorded.",
};

function inputSchema(caller: ReplyCallerV1): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      answer: {
        type: "string",
        minLength: 1,
        maxLength: REPLY_TO_REQUEST_MAX_CHARS_V1[caller],
        description:
          caller === "email"
            ? "The body of your email reply, in full."
            : "The answer, in full.",
      },
    },
    required: ["answer"],
    additionalProperties: false,
  };
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/**
 * Where one answer went, as its caller's delivery decided: to the caller,
 * with the words it was handed, or — when the caller could not be reached —
 * into the conversation instead, as a message the person reads there. Either
 * way the Turn has answered, and the model is told which.
 */
export type ReplyDeliveryV1 =
  | { channel: "caller"; text: string; told: string }
  | { channel: "conversation"; payload: SendToUserPayloadV1; told: string };

/**
 * Delivers one answer that leaves the platform. Only email has one: voice and
 * a Bot read their answer back off the run, so recording it is delivering it.
 *
 * It runs once the answer is known to be the Turn's and before anything is
 * recorded, under the call's own effect id, and must be at-most-once by it:
 * a Turn replayed after an eviction calls it again with the same id.
 */
export type ReplyDelivererV1 = (
  answer: string,
  context: ToolExecutionContext,
  session: Session,
) => Promise<ReplyDeliveryV1>;

/**
 * The tool, bound to the caller the Turn was admitted under.
 *
 * The `caller` argument comes from the durable admission record, so a model
 * cannot address an answer anywhere the host did not already decide it goes.
 */
export function createReplyToRequestToolV1(
  caller: ReplyCallerV1,
  sessions: { get(sessionId: string): Session | undefined },
  deliver?: ReplyDelivererV1,
): ToolDefinition {
  return {
    name: REPLY_TO_REQUEST_TOOL_V1,
    description: DESCRIPTIONS[caller],
    inputSchema: inputSchema(caller),
    // Only mounted at all when this Turn actually has a caller: an agent-lane
    // request from voice or another Bot, or the person's own email, which is
    // a chat Turn on their lane.
    admission: { turnTypes: caller === "email" ? ["chat"] : ["agent"] },
    // The answer is appended to the session, so it has a position there.
    orderedEffect: true,
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const record = input as Record<string, unknown>;
      const answer =
        typeof record.answer === "string" ? record.answer.trim() : "";
      if (!answer) {
        return refusal(
          `${REPLY_TO_REQUEST_TOOL_V1} requires answer: the complete answer to the question you were asked.`,
        );
      }
      if (answer.length > REPLY_TO_REQUEST_MAX_CHARS_V1[caller]) {
        return refusal(
          `${REPLY_TO_REQUEST_TOOL_V1} was refused: answer is longer than ${REPLY_TO_REQUEST_MAX_CHARS_V1[caller]} characters. ${TOO_LONG[caller]}`,
        );
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return refusal(
          `${REPLY_TO_REQUEST_TOOL_V1} was refused: session "${context.sessionId}" is unavailable, so the answer cannot be recorded.`,
        );
      }
      let position: { turn: number; step: number };
      try {
        position = openStepPositionV1(session, REPLY_TO_REQUEST_TOOL_V1);
      } catch (error) {
        return refusal(
          `${REPLY_TO_REQUEST_TOOL_V1} was refused: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // The occurrence is the fence, exactly as it is for a send: a replayed
      // Turn records one answer, not two, whichever way it went.
      const recorded = session.activeRunJournal.some(
        (event) =>
          (event.type === "reply/to-caller" || event.type === "send/to-user") &&
          event.occurrenceId === context.effectId,
      );
      if (recorded) {
        return { content: RECORDED[caller], isError: false, endsTurn: true };
      }
      // An answer that leaves the platform leaves once: a second one in the
      // same Turn would be a second email about one message.
      if (
        deliver &&
        session.activeRunJournal.some(
          (event) =>
            event.type === "reply/to-caller" && event.turn === position.turn,
        )
      ) {
        return refusal(
          `${REPLY_TO_REQUEST_TOOL_V1} was refused: this Turn has already answered, and one answer is all it sends.`,
        );
      }
      const delivery: ReplyDeliveryV1 = deliver
        ? await deliver(answer, context, session)
        : { channel: "caller", text: answer, told: RECORDED[caller] };
      session.append(
        delivery.channel === "caller"
          ? {
              type: "reply/to-caller",
              ...position,
              occurrenceId: context.effectId,
              caller,
              text: delivery.text,
            }
          : {
              type: "send/to-user",
              ...position,
              occurrenceId: context.effectId,
              payload: delivery.payload,
            },
      );
      await session.flush();
      return { content: delivery.told, isError: false, endsTurn: true };
    },
  };
}

// The Bot's answer to whoever asked, when that was not the person typing.
//
// `send_to_user` is the Bot's voice to its User: it mints a message, advances
// unread, and can wake a device. An agent-lane Turn the account's voice session
// admitted is owed an answer by a different route — the voice object is holding
// a durable request and will read the answer out — and routing one delivery as
// the other is how somebody ends up badged for a sentence being spoken to them.
//
// So this is a second, narrow delivery tool with the same shape as the first:
// it records the answer on the Session log, it ends the Turn, and the exchange
// is still part of the conversation the person can read back. What differs is
// only the addressee, which the *host* fixes from the Turn's durable admission
// — never from an argument the model supplies.
import type {
  Session,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@frockbot/core/contracts";
import { openStepPositionV1 } from "./agent.js";

export const REPLY_TO_REQUEST_TOOL_V1 = "reply_to_request";

/** A spoken answer that runs long stops being an answer and becomes a essay. */
export const REPLY_TO_REQUEST_MAX_CHARS_V1 = 4_000;

const DESCRIPTION =
  "Answer the voice session that asked you the current question. What you write here is read back to the person aloud and ends this Turn, so keep it short and speakable: a few sentences, no markdown, no lists, no code. This is not a message in your conversation with your User — use send_to_user for those, including interim updates while you work.";

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      minLength: 1,
      maxLength: REPLY_TO_REQUEST_MAX_CHARS_V1,
      description: "The answer, in full, as it will be spoken.",
    },
  },
  required: ["answer"],
  additionalProperties: false,
};

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/**
 * The tool, bound to the caller the Turn was admitted under.
 *
 * The `caller` argument comes from the durable admission record, so a model
 * cannot address an answer anywhere the host did not already decide it goes.
 */
export function createReplyToRequestToolV1(
  caller: "voice",
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return {
    name: REPLY_TO_REQUEST_TOOL_V1,
    description: DESCRIPTION,
    inputSchema: structuredClone(INPUT_SCHEMA),
    // Only ever offered on the lane a caller can reach, and only mounted at
    // all when this Turn actually has one.
    admission: { turnTypes: ["agent"] },
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
      if (answer.length > REPLY_TO_REQUEST_MAX_CHARS_V1) {
        return refusal(
          `${REPLY_TO_REQUEST_TOOL_V1} was refused: answer is longer than ${REPLY_TO_REQUEST_MAX_CHARS_V1} characters. It is read aloud; say the short version.`,
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
      // Turn records one answer, not two.
      if (
        !session.events.some(
          (event) =>
            event.type === "reply/to-caller" &&
            event.occurrenceId === context.effectId,
        )
      ) {
        session.append({
          type: "reply/to-caller",
          ...position,
          occurrenceId: context.effectId,
          caller,
          text: answer,
        });
        await session.flush();
      }
      return {
        content: "Answered. It is being read out to the person now.",
        isError: false,
        endsTurn: true,
      };
    },
  };
}

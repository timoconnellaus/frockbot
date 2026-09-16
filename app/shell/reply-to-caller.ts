// Replies to voice are durable caller deliveries, separate from User messages.
// The host fixes the caller from admission; the model cannot change it.
import type {
  Session,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@frockbot/core/contracts";
import { openStepPositionV1 } from "./agent.js";

export const REPLY_TO_REQUEST_TOOL_V1 = "reply_to_request";

/** Keep a complete caller answer bounded; the voice assistant can shorten it. */
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
        content: "Answer recorded for the voice session.",
        isError: false,
        endsTurn: true,
      };
    },
  };
}

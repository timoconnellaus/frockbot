// Replies to a caller — the voice session, or another Bot — are durable
// caller deliveries, separate from User messages. The host fixes the caller
// from admission; the model cannot change it.
import type {
  Session,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@frockbot/core/contracts";
import { openStepPositionV1 } from "./agent.js";

export const REPLY_TO_REQUEST_TOOL_V1 = "reply_to_request";

export type ReplyCallerV1 = "voice" | "bot";

/**
 * Each caller's bound on a complete answer. Voice is spoken, so it stays
 * short; a Bot reads its answer as a tool result, so it gets the whole wire
 * event bound.
 */
export const REPLY_TO_REQUEST_MAX_CHARS_V1: Record<ReplyCallerV1, number> = {
  voice: 4_000,
  bot: 32_000,
};

const TOO_LONG: Record<ReplyCallerV1, string> = {
  voice: "Say the short version.",
  bot: "Send the essential answer.",
};

const DESCRIPTIONS: Record<ReplyCallerV1, string> = {
  voice:
    "Answer the voice session that asked you the current question. What you write here is read back to the person aloud and ends this Turn, so keep it short and speakable: a few sentences, no markdown, no lists, no code. This is not a message in your conversation with your User — use send_to_user for those, including interim updates while you work.",
  bot: "Answer the Bot that asked you the current question. What you write here is returned to that Bot as its tool result and ends this Turn, so make it the complete answer it can act on. This is not a message in your conversation with your User — use send_to_user for those, only when the person should hear about it directly.",
};

const RECORDED: Record<ReplyCallerV1, string> = {
  voice: "Answer recorded for the voice session.",
  bot: "Answer recorded for the asking Bot.",
};

function inputSchema(caller: ReplyCallerV1): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      answer: {
        type: "string",
        minLength: 1,
        maxLength: REPLY_TO_REQUEST_MAX_CHARS_V1[caller],
        description: "The answer, in full.",
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
 * The tool, bound to the caller the Turn was admitted under.
 *
 * The `caller` argument comes from the durable admission record, so a model
 * cannot address an answer anywhere the host did not already decide it goes.
 */
export function createReplyToRequestToolV1(
  caller: ReplyCallerV1,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return {
    name: REPLY_TO_REQUEST_TOOL_V1,
    description: DESCRIPTIONS[caller],
    inputSchema: inputSchema(caller),
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
      // Turn records one answer, not two.
      if (
        !session.activeRunJournal.some(
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
        content: RECORDED[caller],
        isError: false,
        endsTurn: true,
      };
    },
  };
}
